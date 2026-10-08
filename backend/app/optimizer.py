"""Redistribution engine: mixed-integer program solved with HiGHS (scipy.optimize.milp).

Per medicine, decision x[b, j] = units of donor batch b sent to recipient j.
Hard constraints
  * recipient j receives at most its need (unmet demand before supplier resupply can arrive)
  * donor batch b gives at most its quantity; donor i gives at most its surplus
    (stock above its own P90 demand over max(horizon, lead time + safety))
  * x[b, j] <= demand j can consume between arrival and batch expiry
    (never ship stock that expires in transit or before it can be used)
  * minimum lot size (no trivial moves)
Objective: maximise priority-weighted coverage + expiring units rescued,
minus a small per-move and per-hour transport penalty.

Fairness: each recipient's need is split into tiers (first 25%, next 25%,
last 50%) with a bonus per tier larger than any priority gap, so when stock is
scarce every hospital gets its first quarter covered before anyone gets its
remainder; priority decides the order inside a tier.
"""
from dataclasses import dataclass

import numpy as np
from scipy.optimize import Bounds, LinearConstraint, milp
from scipy.sparse import lil_matrix

from .inventory import Batch

MIN_LOT = 10
MOVE_PENALTY = 3.0
WASTE_BONUS = 0.6
HOUR_COST = 0.002
TIERS = [(0.25, 2.0), (0.25, 1.0), (0.50, 0.0)]   # (share of need, bonus); priority weight is in [1, 2]


@dataclass
class Party:
    hospital: str
    need: float
    surplus: float
    weight: float        # 1 + priority score / 100
    batches: list[Batch]
    waste: dict          # batch id -> projected units wasted at donor
    demand: np.ndarray   # median demand path (long)
    unmet: np.ndarray    # projected unmet demand per day without transfers (long)


def arrival_day(hours: float) -> int:
    return 0 if hours <= 12 else int(np.ceil(hours / 24))


def routes_for(parties: list[Party], hours: dict):
    recipients = [p for p in parties if p.need >= 1]
    donors = [p for p in parties if p.surplus >= 1 and p.need < 1]
    routes = []   # (donor, batch, recipient, cap, hours)
    for d in donors:
        for b in d.batches:
            if b.arrive > 0 or b.qty <= 0:
                continue
            for r in recipients:
                h = hours[(d.hospital, r.hospital)]
                arr = arrival_day(h)
                if b.exp - arr < 2:
                    continue
                absorb = float(r.demand[arr:b.exp].sum())
                cap = int(min(b.qty, r.need, d.surplus, absorb))
                if cap >= MIN_LOT:
                    routes.append((d, b, r, cap, h))
    return recipients, donors, routes


def plan(parties: list[Party], hours: dict) -> list[dict]:
    recipients, donors, routes = routes_for(parties, hours)
    if not routes:
        return []
    recipients = [r for r in recipients if any(rt[2] is r for rt in routes)]
    nr = len(routes)
    waste_keys = sorted({(rt[0].hospital, rt[1].id) for rt in routes if rt[0].waste.get(rt[1].id, 0) >= 1})
    nz = len(waste_keys)
    nt = len(recipients) * len(TIERS)
    X, Yo, Z, U = 0, nr, 2 * nr, 2 * nr + nz           # variable block offsets
    nvar = U + nt

    c = np.zeros(nvar)
    ub_v = np.zeros(nvar)
    for i, (d, b, r, cap, h) in enumerate(routes):
        c[X + i] = HOUR_COST * h + 0.0005 * min(b.exp, 365)   # tie-break: ship earlier-expiring stock
        c[Yo + i] = MOVE_PENALTY
        ub_v[X + i] = cap
        ub_v[Yo + i] = 1
    for k, (hk, bid) in enumerate(waste_keys):
        c[Z + k] = -WASTE_BONUS
        ub_v[Z + k] = next(p.waste[bid] for p in donors if p.hospital == hk)
    for j, r in enumerate(recipients):
        for t, (share, bonus) in enumerate(TIERS):
            c[U + j * len(TIERS) + t] = -(r.weight + bonus)
            ub_v[U + j * len(TIERS) + t] = share * np.floor(r.need)

    by_batch: dict = {}
    by_donor: dict = {}
    by_recip: dict = {}
    for i, (d, b, r, cap, h) in enumerate(routes):
        by_batch.setdefault((d.hospital, b.id), []).append(i)
        by_donor.setdefault(d.hospital, []).append(i)
        by_recip.setdefault(r.hospital, []).append(i)

    A_rows, lo, hi = [], [], []

    def add(coefs: dict, lower, upper):
        A_rows.append(coefs)
        lo.append(lower)
        hi.append(upper)

    for j, r in enumerate(recipients):
        coefs = {X + i: 1.0 for i in by_recip[r.hospital]}
        for t in range(len(TIERS)):
            coefs[U + j * len(TIERS) + t] = -1.0
        add(coefs, 0.0, 0.0)                                            # received = sum of tiers
        add({X + i: 1.0 for i in by_recip[r.hospital]}, -np.inf, np.floor(r.need))
    for (hk, bid), idx in by_batch.items():
        add({X + i: 1.0 for i in idx}, -np.inf, routes[idx[0]][1].qty)
    for d in donors:
        if d.hospital in by_donor:
            add({X + i: 1.0 for i in by_donor[d.hospital]}, -np.inf, np.floor(d.surplus))
    for i, (d, b, r, cap, h) in enumerate(routes):
        add({X + i: 1.0, Yo + i: -cap}, -np.inf, 0.0)                    # x <= cap * y
        add({X + i: -1.0, Yo + i: min(MIN_LOT, cap)}, -np.inf, 0.0)      # x >= lot * y
    for k, key in enumerate(waste_keys):
        coefs = {Z + k: 1.0}
        for i in by_batch[key]:
            coefs[X + i] = -1.0
        add(coefs, -np.inf, 0.0)                                        # rescued <= shipped

    A = lil_matrix((len(A_rows), nvar))
    for row, coefs in enumerate(A_rows):
        for col, v in coefs.items():
            A[row, col] = v
    integrality = np.zeros(nvar)
    integrality[X:Z] = 1
    res = milp(c, constraints=LinearConstraint(A.tocsr(), lo, hi), bounds=Bounds(np.zeros(nvar), ub_v),
               integrality=integrality, options={"time_limit": 10})
    if res.x is None:
        return greedy(routes)
    x = np.round(res.x[X:X + nr]).astype(int)
    return aggregate([(routes[i], int(x[i]), "need") for i in range(nr) if x[i] > 0])


def rescue(parties: list[Party], hours: dict, moves: list[dict]) -> list[dict]:
    """Second pass for stock that will still expire unused at the donor: send it to
    hospitals that would run out before that expiry date anyway, which shrinks their
    next supplier order.  Capped by the recipient's projected unmet demand between
    arrival and expiry, so no new waste is created."""
    by_h = {p.hospital: p for p in parties}
    shipped: dict = {}
    received = {p.hospital: 0 for p in parties}
    for mv in moves:
        received[mv["to"]] += mv["qty"]
        for a in mv["allocations"]:
            shipped[a["batch_id"]] = shipped.get(a["batch_id"], 0) + a["qty"]
    picks = []
    for d in parties:
        if d.need >= 1:
            continue
        for b in sorted(d.batches, key=lambda b: b.exp):
            left_waste = int(d.waste.get(b.id, 0) - shipped.get(b.id, 0))
            left_qty = b.qty - shipped.get(b.id, 0)
            amount = min(left_waste, left_qty)
            if amount < MIN_LOT:
                continue
            cands = sorted((r for r in parties if r.hospital != d.hospital and not any(
                r.waste.get(x.id, 0) >= 1 for x in r.batches)), key=lambda r: (-r.weight, hours[(d.hospital, r.hospital)]))
            for r in cands:
                h = hours[(d.hospital, r.hospital)]
                arr = arrival_day(h)
                if b.exp - arr < 2:
                    continue
                room = int(r.unmet[arr:b.exp].sum()) - received[r.hospital]
                q = min(amount, room)
                if q >= MIN_LOT:
                    picks.append(((d, b, r, q, h), q, "rescue"))
                    received[r.hospital] += q
                    shipped[b.id] = shipped.get(b.id, 0) + q
                    amount -= q
                if amount < MIN_LOT:
                    break
    return aggregate(picks)


def greedy(routes) -> list[dict]:
    """Fallback if the solver fails: highest-weight recipient, nearest donor, earliest-expiring batch."""
    need, surplus, left, picks = {}, {}, {}, []
    for d, b, r, cap, h in sorted(routes, key=lambda rt: (-rt[2].weight, rt[1].exp, rt[4])):
        need.setdefault(r.hospital, np.floor(r.need))
        surplus.setdefault(d.hospital, np.floor(d.surplus))
        left.setdefault((d.hospital, b.id), b.qty)
        q = int(min(cap, need[r.hospital], surplus[d.hospital], left[(d.hospital, b.id)]))
        if q >= MIN_LOT:
            picks.append(((d, b, r, cap, h), q, "need"))
            need[r.hospital] -= q
            surplus[d.hospital] -= q
            left[(d.hospital, b.id)] -= q
    return aggregate(picks)


def aggregate(picks) -> list[dict]:
    moves = {}
    for (d, b, r, cap, h), q, kind in picks:
        m = moves.setdefault((d.hospital, r.hospital, kind), {
            "from": d.hospital, "to": r.hospital, "qty": 0, "hours": round(h, 2), "kind": kind,
            "arrival_day": arrival_day(h), "allocations": []})
        m["qty"] += q
        m["allocations"].append({"batch_id": b.id, "qty": q, "expires_in_days": b.exp})
    return sorted(moves.values(), key=lambda m: -m["qty"])
