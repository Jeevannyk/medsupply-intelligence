"""Stock projection: first-expiry-first-out (FEFO) simulation of batches
against a demand path, giving days-until-stock-out and per-batch wastage."""
import math
from dataclasses import dataclass, field

import numpy as np

from .config import SAFETY_DAYS


@dataclass
class Batch:
    id: str
    qty: int
    exp: int            # usable while day index < exp (day 0 = today)
    arrive: int = 0     # day the batch becomes available
    virtual: bool = False


@dataclass
class SimResult:
    unmet: np.ndarray
    stock_end: np.ndarray
    stockout: float | None          # fractional days until first unmet demand
    used: dict = field(default_factory=dict)
    wasted: dict = field(default_factory=dict)


def fefo(batches: list[Batch], demand: np.ndarray) -> SimResult:
    n = len(demand)
    live = [[b.exp, b.id, float(b.qty)] for b in batches if b.arrive <= 0]
    pending = sorted((b for b in batches if b.arrive > 0), key=lambda b: b.arrive)
    used = {b.id: 0.0 for b in batches}
    wasted = {b.id: 0.0 for b in batches}
    unmet = np.zeros(n)
    stock_end = np.zeros(n)
    stockout = None
    for k in range(n):
        while pending and pending[0].arrive <= k:
            b = pending.pop(0)
            live.append([b.exp, b.id, float(b.qty)])
        live.sort()
        for item in live:
            if item[0] <= k and item[2] > 0:
                wasted[item[1]] += item[2]
                item[2] = 0.0
        live = [it for it in live if it[2] > 0]
        avail = sum(it[2] for it in live)
        need = float(demand[k])
        if avail < need - 1e-9 and stockout is None:
            stockout = k + (avail / need if need > 0 else 0.0)
        for it in live:
            take = min(it[2], need)
            it[2] -= take
            used[it[1]] += take
            need -= take
            if need <= 1e-9:
                break
        unmet[k] = max(need, 0.0)
        stock_end[k] = sum(it[2] for it in live)
        if not live and not pending and k > 30:
            unmet[k + 1:] = demand[k + 1:]
            break
    for it in live:     # stock still on hand beyond the horizon whose expiry is inside it
        if it[0] <= n and it[2] > 0:
            wasted[it[1]] += it[2]
    return SimResult(unmet=unmet, stock_end=stock_end, stockout=stockout, used=used, wasted=wasted)


def risk_level(dts: float | None, lead: int) -> str:
    if dts is None:
        return "ok"
    if dts < 0.5:
        return "stockout"
    if dts < lead:
        return "critical"
    if dts < lead + SAFETY_DAYS:
        return "high"
    if dts < lead + 7:
        return "watch"
    return "ok"


RISK_ORDER = {"stockout": 0, "critical": 1, "high": 2, "watch": 3, "ok": 4}


def round_up(x: float, step: int = 50) -> int:
    return int(math.ceil(max(x, 0) / step) * step)


def warning_text(hosp: str, med: str, unit: str, dts: float | None, lead: int, level: str,
                 order_qty: int, incoming: int = 0) -> str:
    inc = f" ({incoming:,} {unit} already in the transfer pipeline)" if incoming else ""
    if level == "stockout":
        return f"{hosp} is out of {med} today{inc}. Lead time {lead} days: transfer immediately and order {order_qty:,} {unit}."
    if dts is None:
        return f"{hosp}: {med} stock covers the planning horizon{inc}."
    d = int(dts)
    if level == "critical":
        return (f"{hosp} runs out of {med} in {d} days (lead time {lead} days): an order placed today arrives too late. "
                f"Transfer stock now and order {order_qty:,} {unit}{inc}.")
    if level == "high":
        return f"{hosp} runs out of {med} in {d} days (lead time {lead} days): order {order_qty:,} {unit} now{inc}."
    if level == "watch":
        slack = max(0, d - lead - SAFETY_DAYS)
        when = "today" if slack == 0 else f"within {slack} days"
        return f"{hosp}: {med} lasts {d} days (lead time {lead} days): reorder {when}{inc}."
    return f"{hosp}: {med} lasts {d}+ days{inc}."
