"""Synthetic data generator.

Creates 8 hospitals, 6 medicines, 120 days of daily consumption (+14 hidden
ground-truth days), current stock batches, supplier lead times and a
transport matrix.  The flu outbreak and the judge scenario are built in:
Oseltamivir network stock is exactly 20,000 units and network weekly demand
rises 2,000 -> 2,875 -> 3,750 -> 4,625 -> 5,500 over the last five weeks.

Run:  python -m app.generate
"""
import json
from datetime import timedelta
from pathlib import Path

import numpy as np
import pandas as pd

from .config import (DB_PATH, FUTURE_DAYS, HISTORY_DAYS, OUTBREAK_MEDICINE,
                     OUTBREAK_START, SEED, TODAY)
from .db import SCHEMA, connect

# Real hospitals of Dakshina Kannada (Mangaluru region). See DATA_SOURCES.md for sources.
# lat/lon: OpenStreetMap.  beds: published figures; * = norm-based estimate (no public figure).
# patients/day: published OPD/day where known (A, C, E, H), else beds x 1.4 (median of the
# published OPD-per-bed ratios).  emergency index is an assumption (no public source).
HOSPITALS = [
    # id, name, city, lat, lon, beds, patients/day, emergency index (ER/ICU intensity)
    ("A", "Government Wenlock District Hospital", "Mangaluru", 12.86694, 74.84293, 1000, 1050, 0.95),
    ("B", "A.J. Hospital & Research Centre", "Mangaluru", 12.89850, 74.84645, 512, 717, 0.45),
    ("C", "Father Muller Medical College Hospital", "Mangaluru", 12.86624, 74.85973, 1250, 1710, 0.75),
    ("D", "CHC Moodbidri", "Moodbidri", 13.06623, 74.99564, 30, 42, 0.40),                   # beds*
    ("E", "Government Lady Goschen Hospital", "Mangaluru", 12.86505, 74.83797, 290, 411, 0.90),
    ("F", "Puttur Government Taluk Hospital", "Puttur", 12.75847, 75.20059, 100, 140, 0.50),
    ("G", "Belthangady Taluk Hospital", "Belthangady", 12.98838, 75.27587, 100, 140, 0.50),   # beds*
    ("H", "KVG Medical College Hospital", "Sullia", 12.55323, 75.38444, 682, 1130, 0.70),
]
HOSP_IDS = [h[0] for h in HOSPITALS]
ROUTES_PATH = Path(__file__).resolve().parent / "data" / "routes.json"   # from app.fetch_routes


def load_routes() -> dict:
    return json.loads(ROUTES_PATH.read_text(encoding="utf-8"))


def remoteness(routes: dict) -> dict:
    """Supplier-lead penalty (days) from real road km to the district hub (A, Wenlock)."""
    return {h: 0 if km < 20 else 1 if km < 50 else 2 for h, km in routes["km"]["A"].items()}

# Prices: NPPA ceiling prices effective 1 Apr 2025 (CEFT per vial, AMOX per 500/125 tablet,
# SALB = Rs 1.04/ml x 2.5 ml nebule).  OSEL, INSU, ORS prices and CEFT/AMOX/SALB shelf
# lives are unverified estimates.  Shelf life: OSEL 24 months (Cipla/WHO-PQ label), INSU
# 24 months unopened refrigerated.  See DATA_SOURCES.md.
MEDICINES = [
    # id, name, unit, criticality (3 life-saving, 2 essential, 1 routine), shelf life, alternatives, unit cost (INR)
    ("OSEL", "Oseltamivir 75 mg", "capsules", 3, 730, [], 28.0),
    ("CEFT", "Ceftriaxone 1 g inj.", "vials", 3, 540, ["AMOX"], 63.47),
    ("AMOX", "Amoxicillin-Clavulanate 625 mg", "tablets", 2, 540, ["CEFT"], 18.62),
    ("INSU", "Insulin Glargine 100 IU/ml", "pens", 3, 730, [], 320.0),
    ("SALB", "Salbutamol nebules 2.5 mg", "nebules", 2, 365, [], 2.6),
    ("ORS", "ORS sachets", "sachets", 1, 730, [], 4.0),
]
MED_IDS = [m[0] for m in MEDICINES]

BASE_NETWORK_DAILY = {"OSEL": 2000 / 7, "CEFT": 420, "AMOX": 900, "INSU": 70, "SALB": 500, "ORS": 600}
SUPPLIER_LEAD = {"OSEL": 9, "CEFT": 6, "AMOX": 4, "INSU": 5, "SALB": 4, "ORS": 3}

# Peak outbreak multipliers for medicines indirectly affected by the flu wave.
SURGE = {
    "CEFT": {"A": 1.45, "C": 1.35, "E": 1.5, "H": 1.3},   # secondary bacterial pneumonia
    "SALB": {"A": 1.5, "C": 1.3, "E": 1.6},               # wheeze / bronchospasm
    "AMOX": {h: 1.1 for h in HOSP_IDS},
}
SURGE_DEFAULT = {"CEFT": 1.1, "SALB": 1.1}

# Oseltamivir: share of network demand once the outbreak is established
# (urban hospitals are hit harder than their size alone suggests).
OSEL_OUTBREAK_SHARE = {"A": .24, "B": .06, "C": .16, "D": .07, "E": .15, "F": .08, "G": .08, "H": .16}
# Exact network weekly totals (judge scenario): (first day, last day) -> units
OSEL_WEEKS = {
    (85, 91): 2000, (92, 98): 2875, (99, 105): 3750, (106, 112): 4625, (113, 119): 5500,
    (120, 126): 6200, (127, 133): 6000,   # hidden ground truth
}
# Judge scenario stock: 20,000 units, unevenly placed. (qty, days until expiry)
OSEL_BATCHES = {
    "A": [(700, 200), (400, 300)],
    "B": [(2500, 26), (2700, 180), (2000, 330)],
    "C": [(1200, 150), (1000, 280)],
    "D": [(1500, 210)],
    "E": [(700, 240)],
    "F": [(900, 35), (1900, 260)],
    "G": [(2400, 200)],
    "H": [(1100, 120), (1000, 300)],
}
# Days of cover for engineered situations; others are random.
COVER_OVERRIDE = {
    ("CEFT", "A"): 5, ("CEFT", "E"): 4, ("CEFT", "H"): 3.5, ("CEFT", "C"): 11,
    ("CEFT", "B"): 26, ("CEFT", "G"): 24, ("CEFT", "D"): 20, ("CEFT", "F"): 21,
    ("INSU", "A"): 6, ("SALB", "E"): 6,
    ("AMOX", "A"): 15, ("AMOX", "E"): 13, ("AMOX", "H"): 60,   # only H has a real substitute buffer
}
EXTRA_BATCHES = [  # near-expiry surplus to show wastage detection
    ("INSU", "D", 400, 18),
    ("ORS", "F", 3000, 30),
]

DOW = np.array([1.10, 1.06, 1.03, 1.00, 0.98, 0.90, 0.93])
DOW = DOW / DOW.mean()
TOTAL_DAYS = HISTORY_DAYS + FUTURE_DAYS


def day_date(d: int):
    return TODAY + timedelta(days=int(d) - HISTORY_DAYS)


def ramp(d: int) -> float:
    return float(np.clip((d - OUTBREAK_START) / (HISTORY_DAYS - 1 - OUTBREAK_START), 0, 1))


def noisy(rng, expected: np.ndarray, cv=0.08) -> np.ndarray:
    lam = expected * rng.gamma(1 / cv**2, cv**2, size=expected.shape)
    return rng.poisson(lam).astype(np.int64)


def force_total(block: np.ndarray, target: int, weights: np.ndarray, rng) -> None:
    """Nudge integer cells (in place) so the block sums exactly to target."""
    flat, p = block.reshape(-1), weights.reshape(-1) / weights.sum()
    diff = int(target - flat.sum())
    if diff > 0:
        np.add.at(flat, rng.choice(flat.size, size=diff, p=p), 1)
    while diff < 0:
        i = rng.choice(flat.size, p=p)
        if flat[i] > 0:
            flat[i] -= 1
            diff += 1


def build_consumption(rng) -> pd.DataFrame:
    days = np.arange(TOTAL_DAYS)
    dow = np.array([DOW[day_date(d).weekday()] for d in days])
    load = np.array([h[6] for h in HOSPITALS], dtype=float)
    size_share = load / load.sum()
    hidx = {h: i for i, h in enumerate(HOSP_IDS)}
    records = []

    for med in MED_IDS:
        if med == OUTBREAK_MEDICINE:
            out_share = np.array([OSEL_OUTBREAK_SHARE[h] for h in HOSP_IDS])
            lam = np.array([ramp(d) if d < HISTORY_DAYS else 1.0 for d in days])
            share = (1 - lam)[:, None] * size_share + lam[:, None] * out_share   # (days, hosp)
            base_e = BASE_NETWORK_DAILY[med] * dow[:, None] * size_share[None, :]
            net = BASE_NETWORK_DAILY[med] * dow
            for (a, b), target in OSEL_WEEKS.items():
                if a >= OUTBREAK_START:
                    curve = np.exp(0.036 * (days[a:b + 1] - OUTBREAK_START)) * dow[a:b + 1]
                    net[a:b + 1] = curve / curve.sum() * target
            out_e = net[:, None] * share
            base = noisy(rng, base_e)
            out = base.copy()
            out[OUTBREAK_START:] = noisy(rng, out_e[OUTBREAK_START:])
            for (a, b), target in OSEL_WEEKS.items():
                force_total(out[a:b + 1], target, out_e[a:b + 1], rng)
                if b < OUTBREAK_START:
                    base[a:b + 1] = out[a:b + 1]
        else:
            base_e = BASE_NETWORK_DAILY[med] * dow[:, None] * size_share[None, :]
            peak = np.array([SURGE.get(med, {}).get(h, SURGE_DEFAULT.get(med, 1.0)) for h in HOSP_IDS])
            r = np.array([ramp(d) if d < HISTORY_DAYS else 1.0 for d in days])
            mult = 1 + (peak[None, :] - 1) * r[:, None]
            base = noisy(rng, base_e)
            out = base.copy()
            if (peak > 1).any():
                out[OUTBREAK_START:] = noisy(rng, (base_e * mult)[OUTBREAK_START:])

        for d in days:
            for h in HOSP_IDS:
                i = hidx[h]
                records.append((int(d), day_date(int(d)).isoformat(), h, med, int(out[d, i]), int(base[d, i]),
                                "history" if d < HISTORY_DAYS else "future"))
    return pd.DataFrame(records, columns=["day", "date", "hospital_id", "medicine_id", "units", "units_base", "split"])


def build_batches(rng, cons: pd.DataFrame) -> pd.DataFrame:
    shelf = {m[0]: m[4] for m in MEDICINES}
    recent = (cons[(cons.split == "history") & (cons.day >= HISTORY_DAYS - 14)]
              .groupby(["medicine_id", "hospital_id"]).units.mean())
    out = []

    def add(med, hosp, qty, days_left, source="supplier"):
        exp = TODAY + timedelta(days=int(days_left))
        rec = exp - timedelta(days=shelf[med])
        n = sum(1 for b in out if b[2] == med and b[1] == hosp) + 1
        out.append((f"{med}-{hosp}-{n:02d}", hosp, med, int(qty), exp.isoformat(), rec.isoformat(), source))

    for med in MED_IDS:
        for hosp in HOSP_IDS:
            if med == OUTBREAK_MEDICINE:
                for qty, left in OSEL_BATCHES[hosp]:
                    add(med, hosp, qty, left)
                continue
            cover = COVER_OVERRIDE.get((med, hosp), rng.uniform(22, 55))
            qty = int(round(cover * recent[(med, hosp)]))
            lo = 45 if shelf[med] > 200 else 35
            if qty > 200 and rng.random() < 0.6:
                first = int(qty * rng.uniform(0.35, 0.6))
                add(med, hosp, first, rng.integers(lo, shelf[med] // 2))
                add(med, hosp, qty - first, rng.integers(shelf[med] // 2, shelf[med]))
            else:
                add(med, hosp, qty, rng.integers(lo, shelf[med]))
    for med, hosp, qty, left in EXTRA_BATCHES:
        add(med, hosp, qty, left)
    return pd.DataFrame(out, columns=["batch_id", "hospital_id", "medicine_id", "qty", "expiry_date",
                                      "received_date", "source"])


def generate(path=DB_PATH) -> None:
    rng = np.random.default_rng(SEED)
    if path.exists():
        path.unlink()
    for suffix in ("-wal", "-shm"):
        p = path.with_name(path.name + suffix)
        if p.exists():
            p.unlink()
    conn = connect()
    conn.executescript(SCHEMA)

    hosp = pd.DataFrame(HOSPITALS, columns=["id", "name", "city", "lat", "lon", "beds", "patient_load", "emergency_index"])
    meds = pd.DataFrame([(m[0], m[1], m[2], m[3], m[4], json.dumps(m[5]), m[6]) for m in MEDICINES],
                        columns=["id", "name", "unit", "criticality", "shelf_life_days", "alternatives", "unit_cost"])
    cons = build_consumption(rng)
    batches = build_batches(rng, cons)
    routes = load_routes()
    remote = remoteness(routes)
    lead = pd.DataFrame([(h, m, SUPPLIER_LEAD[m] + remote[h]) for h in HOSP_IDS for m in MED_IDS],
                        columns=["hospital_id", "medicine_id", "lead_days"])
    trans = []
    for a in HOSP_IDS:
        for b in HOSP_IDS:
            # real OSRM road distance/drive time, plus 0.5 h loading allowance per trip
            km = routes["km"][a][b]
            trans.append((a, b, km, 0.0 if a == b else round(routes["hours"][a][b] + 0.5, 2)))
    trans = pd.DataFrame(trans, columns=["from_id", "to_id", "km", "hours"])

    for name, df in [("hospitals", hosp), ("medicines", meds), ("consumption", cons),
                     ("batches", batches), ("lead_times", lead), ("transport", trans)]:
        df.to_sql(name, conn, if_exists="append", index=False)
    meta = {"today": TODAY.isoformat(), "history_days": HISTORY_DAYS, "future_days": FUTURE_DAYS,
            "outbreak_start": day_date(OUTBREAK_START).isoformat(), "seed": SEED}
    conn.executemany("INSERT INTO meta VALUES (?, ?)", [(k, str(v)) for k, v in meta.items()])
    conn.commit()
    conn.close()


if __name__ == "__main__":
    generate()
    print(f"Generated {DB_PATH}")
