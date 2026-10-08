"""Demand forecasting, outbreak (spike) detection and backtesting.

Model: one global HistGradientBoostingRegressor, direct multi-horizon
(h = 1..14), trained on demand normalised by each series' 28-day mean so a
single model serves large and small series.  Trees cannot extrapolate past
levels they have seen, so when the anomaly detector flags a sustained spike
we blend in a damped log-linear trend fitted to the last 14 days.
"""
from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor

from .config import HISTORY_DAYS, HORIZON, LONG_HORIZON, TODAY

Z_THRESHOLD = 3.0
RATIO_THRESHOLD = 1.25
TREND_WEIGHT = 0.7
DAMPING = 0.85
HOLDOUT = 14
Z80 = 1.2816


@dataclass
class Forecast:
    series: list                 # [(hospital_id, medicine_id)]
    Y: np.ndarray                # (S, T) history
    p50: np.ndarray              # (S, HORIZON)
    p10: np.ndarray
    p90: np.ndarray
    ext: np.ndarray              # (S, LONG_HORIZON) median path for expiry projection
    gbm: np.ndarray              # (S, HORIZON) model-only forecast
    flagged: np.ndarray          # (S,) outbreak/spike detected at forecast origin
    z: np.ndarray
    ratio: np.ndarray
    growth: np.ndarray           # daily growth rate of fitted trend
    detected_day: np.ndarray     # first history day index the spike was flagged (-1 none)
    baseline: np.ndarray         # pre-spike daily level
    anomaly_days: dict           # s -> list of day indices with daily z > 3
    metrics: dict = field(default_factory=dict)
    index: dict = field(default_factory=dict)

    def __post_init__(self):
        self.index = {k: i for i, k in enumerate(self.series)}


def dow_of(day: int) -> int:
    return (TODAY.weekday() + day - HISTORY_DAYS) % 7


def dow_factors(Y: np.ndarray, t: int, med_idx: np.ndarray) -> np.ndarray:
    """Ratio-to-centred-moving-average weekday factors, pooled per medicine. (S, 7)"""
    out = np.ones((Y.shape[0], 7))
    for m in np.unique(med_idx):
        rows = med_idx == m
        y = Y[rows, :t].sum(0)
        ratios = [[] for _ in range(7)]
        for d in range(max(3, t - 63), t - 3):
            cma = y[d - 3:d + 4].mean()
            if cma > 0:
                ratios[dow_of(d)].append(y[d] / cma)
        f = np.array([np.mean(r) if r else 1.0 for r in ratios])
        out[rows] = f / f.mean()
    return out


def origin_features(Y: np.ndarray, t: int) -> dict:
    rm7 = Y[:, t - 7:t].mean(1)
    rm14 = Y[:, t - 14:t].mean(1)
    rm28 = np.maximum(Y[:, t - 28:t].mean(1), 1.0)
    base = np.maximum(Y[:, t - 35:t - 7].mean(1), 1.0)
    x = np.arange(14) - 6.5
    slope = (Y[:, t - 14:t] * x).sum(1) / (x ** 2).sum()
    return dict(rm7=rm7, rm14=rm14, rm28=rm28, base=base, std28=Y[:, t - 28:t].std(1) / rm28,
                r7_28=rm7 / rm28, r7_base=rm7 / base, r14_28=rm14 / rm28, slope=slope / rm28)


def design(Y, t, h, f, hosp_idx, med_idx):
    target = t + h - 1
    lag = target - 7 * int(np.ceil(h / 7))
    X = np.column_stack([
        np.full(Y.shape[0], h), np.full(Y.shape[0], dow_of(target)), hosp_idx, med_idx,
        f["r7_28"], f["r7_base"], f["r14_28"], f["slope"], f["std28"], Y[:, lag] / f["rm28"],
        np.log1p(f["rm28"]),
    ])
    return X


def detect(Y: np.ndarray, t: int):
    base, recent = Y[:, t - 35:t - 7], Y[:, t - 7:t]
    mb, sb = base.mean(1), base.std(1)
    mr = recent.mean(1)
    z = (mr - mb) / (sb / np.sqrt(7) + 1e-9)
    ratio = mr / np.maximum(mb, 1e-9)
    return (z > Z_THRESHOLD) & (ratio > RATIO_THRESHOLD), z, ratio


def trend_forecast(Y, t, dowf):
    """Damped log-linear trend on deseasonalised last-14-day demand."""
    days = np.arange(t - 14, t)
    des = Y[:, days] / dowf[:, [dow_of(d) for d in days]]
    x = np.arange(14) - 13.0          # 0 at the last observed day
    ly = np.log1p(des)
    xm = x.mean()
    g = ((x - xm) * (ly - ly.mean(1, keepdims=True))).sum(1) / ((x - xm) ** 2).sum()
    g = np.clip(g, -0.05, 0.08)
    level = np.expm1(ly.mean(1) + g * (0 - xm))
    cum = np.cumsum(DAMPING ** np.arange(1, HORIZON + 1))
    tgt = [dow_of(t + h) for h in range(HORIZON)]
    return level[:, None] * np.exp(g[:, None] * cum[None, :]) * dowf[:, tgt], g, level


class Model:
    def __init__(self):
        self.m = HistGradientBoostingRegressor(max_iter=250, learning_rate=0.06, max_leaf_nodes=31,
                                               l2_regularization=0.5, categorical_features=[2, 3],
                                               random_state=0)

    def fit(self, Y, t_end, hosp_idx, med_idx):
        Xs, ys = [], []
        for t in range(35, t_end):
            f = origin_features(Y, t)
            for h in range(1, HORIZON + 1):
                if t + h - 1 >= t_end:
                    break
                Xs.append(design(Y, t, h, f, hosp_idx, med_idx))
                ys.append(Y[:, t + h - 1] / f["rm28"])
        self.m.fit(np.vstack(Xs), np.concatenate(ys))
        return self

    def predict(self, Y, t, hosp_idx, med_idx):
        f = origin_features(Y, t)
        return np.column_stack([np.maximum(self.m.predict(design(Y, t, h, f, hosp_idx, med_idx)), 0) * f["rm28"]
                                for h in range(1, HORIZON + 1)])


def predict_at(Y, t, model, hosp_idx, med_idx):
    gbm = model.predict(Y, t, hosp_idx, med_idx)
    flagged, z, ratio = detect(Y, t)
    dowf = dow_factors(Y, t, med_idx)
    trend, g, level = trend_forecast(Y, t, dowf)
    final = np.where(flagged[:, None], TREND_WEIGHT * trend + (1 - TREND_WEIGHT) * gbm, gbm)
    return dict(gbm=gbm, final=final, flagged=flagged, z=z, ratio=ratio, g=np.where(flagged, g, 0.0),
                dowf=dowf, level=level)


def errors(actual, pred) -> dict:
    e = np.abs(actual - pred)
    pos = actual > 0
    return {"mae": float(e.mean()), "mape": float((e[pos] / actual[pos]).mean() * 100),
            "wape": float(e.sum() / max(actual.sum(), 1) * 100)}


def backtest(Y, hosp_idx, med_idx, series):
    t0 = Y.shape[1] - HOLDOUT
    model = Model().fit(Y, t0, hosp_idx, med_idx)
    out = predict_at(Y, t0, model, hosp_idx, med_idx)
    actual = Y[:, t0:t0 + HOLDOUT]
    naive = np.column_stack([Y[:, t0 + h - 7 * int(np.ceil((h + 1) / 7))] for h in range(HOLDOUT)])
    methods = {"seasonal_naive": naive, "gbm": out["gbm"], "gbm_outbreak_adjusted": out["final"]}
    flagged = out["flagged"]
    res = {"holdout_days": HOLDOUT, "origin_day": int(t0), "overall": {}, "spike_series": {},
           "network_by_medicine": {}, "spike_series_count": int(flagged.sum())}
    for name, pred in methods.items():
        res["overall"][name] = errors(actual, pred)
        if flagged.any():
            res["spike_series"][name] = errors(actual[flagged], pred[flagged])
    meds = sorted({m for _, m in series})
    for m in meds:
        rows = np.array([s[1] == m for s in series])
        res["network_by_medicine"][m] = {n: errors(actual[rows].sum(0), p[rows].sum(0)) for n, p in methods.items()}
    # relative residual spread for prediction intervals
    rel = (actual - out["final"]) / np.maximum(out["final"], 1.0)
    sigma = {}
    for m in meds:
        rows = np.array([s[1] == m for s in series])
        sigma[m] = float(np.clip(rel[rows & ~flagged].std() if (rows & ~flagged).any() else rel[rows].std(), 0.05, 0.6))
    sigma_spike = float(np.clip(rel[flagged].std(), 0.1, 0.8)) if flagged.any() else 0.25
    return res, sigma, sigma_spike


def run(hist: pd.DataFrame, column: str) -> Forecast:
    """hist: history consumption rows. column: 'units' (outbreak) or 'units_base' (counterfactual)."""
    piv = hist.pivot_table(index=["hospital_id", "medicine_id"], columns="day", values=column).sort_index()
    series = list(piv.index)
    Y = piv.to_numpy(dtype=float)
    hosps = sorted({h for h, _ in series})
    meds = sorted({m for _, m in series})
    hosp_idx = np.array([hosps.index(h) for h, _ in series])
    med_idx = np.array([meds.index(m) for _, m in series])
    T = Y.shape[1]

    metrics, sigma, sigma_spike = backtest(Y, hosp_idx, med_idx, series)
    model = Model().fit(Y, T, hosp_idx, med_idx)
    out = predict_at(Y, T, model, hosp_idx, med_idx)
    p50 = out["final"]

    # spike detection history: day the current (still active) spike was first flagged
    flags = np.column_stack([detect(Y, t)[0] for t in range(40, T + 1)])
    detected = np.full(len(series), -1)
    for s in np.where(out["flagged"])[0]:
        j = flags.shape[1] - 1
        while j > 0 and flags[s, j - 1]:
            j -= 1
        detected[s] = 40 + j - 1

    # daily anomaly markers (trailing 28-day z-score)
    anomaly_days = {}
    for s in range(len(series)):
        days = [d for d in range(28, T)
                if (Y[s, d] - Y[s, d - 28:d].mean()) / (Y[s, d - 28:d].std() + 1e-9) > 3]
        if days:
            anomaly_days[s] = days

    sig = np.array([sigma_spike if out["flagged"][s] else sigma[series[s][1]] for s in range(len(series))])
    p10 = p50 * np.maximum(0, 1 - Z80 * sig)[:, None]
    p90 = p50 * (1 + Z80 * sig)[:, None]

    # long projection: spike decays back to pre-spike baseline with a 14-day half-life
    dowf = out["dowf"]
    level_end = (p50[:, 7:] / dowf[:, [dow_of(T + h) for h in range(7, HORIZON)]]).mean(1)
    baseline = level_end.copy()
    for s in np.where(out["flagged"])[0]:
        onset = max(28, (detected[s] if detected[s] > 0 else T) - 7)
        pre = Y[s, onset - 28:onset] / dowf[s, [dow_of(d) for d in range(onset - 28, onset)]]
        baseline[s] = pre.mean()
    k = np.arange(HORIZON, LONG_HORIZON)
    decay = 0.5 ** ((k - (HORIZON - 1)) / 14.0)
    lvl = baseline[:, None] + (level_end - baseline)[:, None] * decay[None, :]
    ext_tail = lvl * dowf[:, [dow_of(T + d) for d in k]]
    ext = np.hstack([p50, ext_tail])

    return Forecast(series=series, Y=Y, p50=p50, p10=p10, p90=p90, ext=ext, gbm=out["gbm"],
                    flagged=out["flagged"], z=out["z"], ratio=out["ratio"], growth=out["g"],
                    detected_day=detected, baseline=baseline, anomaly_days=anomaly_days, metrics=metrics)
