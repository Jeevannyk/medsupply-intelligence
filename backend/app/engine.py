"""Orchestrates forecasts, stock projection, risk, expiry, prioritisation,
redistribution, plan verification and the with/without-system simulation."""
import json
import math
import threading
from datetime import date, timedelta

import numpy as np
import pandas as pd

from . import forecast as fc_mod
from . import logistics, optimizer, priority
from .config import DEFAULT_WEIGHTS, HISTORY_DAYS, HORIZON, SAFETY_DAYS, TODAY
from .db import rows, session
from .inventory import RISK_ORDER, Batch, fefo, risk_level, round_up, warning_text

ACTIVE = ("pending", "approved", "in_transit")
SHORT = 60


def days_until(iso: str) -> int:
    return (date.fromisoformat(iso) - TODAY).days


def r1(x):
    return None if x is None else round(float(x), 1)


class Engine:
    def __init__(self):
        self.lock = threading.RLock()
        self.forecasts: dict = {}
        self.cache: dict = {}
        self.version = 0
        self.load_static()

    # ------------------------------------------------------------------ data
    def load_static(self):
        with session() as c:
            self.hospitals = rows(c, "SELECT * FROM hospitals ORDER BY id")
            meds = rows(c, "SELECT * FROM medicines")
            order = ["OSEL", "CEFT", "AMOX", "INSU", "SALB", "ORS"]
            meds.sort(key=lambda m: order.index(m["id"]) if m["id"] in order else 99)
            for m in meds:
                m["alternatives"] = json.loads(m["alternatives"])
            self.medicines = meds
            self.lead = {(r["hospital_id"], r["medicine_id"]): r["lead_days"]
                         for r in rows(c, "SELECT * FROM lead_times")}
            tr = rows(c, "SELECT * FROM transport")
            self.hours = {(r["from_id"], r["to_id"]): r["hours"] for r in tr}
            self.km = {(r["from_id"], r["to_id"]): r["km"] for r in tr}
            self.hist = pd.read_sql("SELECT * FROM consumption WHERE split='history'", c)
            self.future = pd.read_sql("SELECT * FROM consumption WHERE split='future'", c)
            self.meta = {r["key"]: r["value"] for r in rows(c, "SELECT * FROM meta")}
        self.H = {h["id"]: h for h in self.hospitals}
        self.M = {m["id"]: m for m in self.medicines}
        self.forecasts.clear()
        self.invalidate()

    def invalidate(self):
        with self.lock:
            self.version += 1
            self.cache.clear()

    def forecast(self, scenario: str):
        with self.lock:
            if scenario not in self.forecasts:
                col = "units" if scenario == "outbreak" else "units_base"
                self.forecasts[scenario] = fc_mod.run(self.hist, col)
            return self.forecasts[scenario]

    def truth(self, scenario: str) -> dict:
        col = "units" if scenario == "outbreak" else "units_base"
        piv = self.future.pivot_table(index=["hospital_id", "medicine_id"], columns="day", values=col)
        return {k: piv.loc[k].to_numpy(dtype=float) for k in piv.index}

    def physical_batches(self) -> dict:
        with session() as c:
            bs = rows(c, "SELECT * FROM batches WHERE qty > 0")
        out: dict = {}
        for b in bs:
            out.setdefault((b["hospital_id"], b["medicine_id"]), []).append(
                Batch(b["batch_id"], int(b["qty"]), days_until(b["expiry_date"])))
        return out

    def active_transfers(self) -> list[dict]:
        with session() as c:
            ts = rows(c, f"SELECT * FROM transfers WHERE status IN {ACTIVE}")
        for t in ts:
            t["allocations"] = json.loads(t["allocations"] or "[]")
        with session() as c:
            ships = {s["transfer_id"]: s for s in rows(c, "SELECT * FROM shipments")}
        for t in ts:
            t["shipment"] = ships.get(t["id"])
        return ts

    def pipeline_batches(self):
        """Physical stock with active (pending/approved/in-transit) transfers applied virtually."""
        phys = self.physical_batches()
        cur = {k: [Batch(b.id, b.qty, b.exp, b.arrive) for b in v] for k, v in phys.items()}
        incoming: dict = {}
        outgoing: dict = {}
        for t in self.active_transfers():
            m = t["medicine_id"]
            for a in t["allocations"]:
                src = next((b for b in cur.get((t["from_id"], m), []) if b.id == a["batch_id"]), None)
                if src is None:
                    continue
                q = min(int(a["qty"]), src.qty)
                src.qty -= q
                # a shipment on the road lands when it really will (a late one lands later); otherwise the planned trip time
                ship_day = logistics.engine_arrival_day(t["shipment"]) if t.get("shipment") else None
                arrive = ship_day if ship_day is not None else optimizer.arrival_day(t["hours"] or 0)
                cur.setdefault((t["to_id"], m), []).append(
                    Batch(f"{a['batch_id']}>{t['to_id']}", q, src.exp, arrive, virtual=True))
                incoming[(t["to_id"], m)] = incoming.get((t["to_id"], m), 0) + q
                outgoing[(t["from_id"], m)] = outgoing.get((t["from_id"], m), 0) + q
        cur = {k: [b for b in v if b.qty > 0] for k, v in cur.items()}
        return phys, cur, incoming, outgoing

    # -------------------------------------------------------------- analysis
    def analysis(self, scenario: str = "outbreak", weights: dict | None = None) -> dict:
        weights = {**DEFAULT_WEIGHTS, **(weights or {})}
        if logistics.refresh():          # a trip ran past its ETA since the last look
            self.invalidate()
        key = (scenario, tuple(sorted(weights.items())), self.version, logistics.time_bucket())
        with self.lock:
            if key in self.cache:
                return self.cache[key]
            result = self._analyse(scenario, weights)
            self.cache[key] = result
            return result

    def _cell_projection(self, fc, s, batches):
        short = fefo(batches, fc.ext[s][:SHORT])
        long = fefo(batches, fc.ext[s])
        ratio = np.divide(fc.p90[s], np.maximum(fc.p50[s], 1e-9))
        p90_path = np.concatenate([fc.p90[s], fc.ext[s][HORIZON:SHORT] * ratio[-1]])
        pess = fefo(batches, p90_path)
        return short, long, pess

    def _analyse(self, scenario, weights):
        fc = self.forecast(scenario)
        phys, cur, incoming, outgoing = self.pipeline_batches()
        max_load = max(h["patient_load"] for h in self.hospitals)
        cells = {}
        sims = {}
        for (h, m) in fc.series:
            s = fc.index[(h, m)]
            bl = cur.get((h, m), [])
            L = self.lead[(h, m)]
            short, long, pess = self._cell_projection(fc, s, bl)
            sims[(h, m)] = (short, long)
            dts = short.stockout
            level = risk_level(dts, L)
            on_hand = sum(b.qty for b in bl if b.arrive <= 0 and not b.virtual)
            stock = sum(b.qty for b in bl)
            daily = float(fc.p50[s][:7].mean())
            W = min(HORIZON, L + SAFETY_DAYS)
            need = float(short.unmet[:W].sum())
            reserve = float(fc.p90[s][:max(HORIZON, L + SAFETY_DAYS)].sum())
            waste = float(sum(long.wasted.values()))
            donatable = sum(b.qty for b in bl if b.arrive <= 0 and not b.virtual)
            surplus = 0.0 if (need >= 1 or level in ("stockout", "critical", "high")) else \
                max(0.0, donatable - reserve, min(waste, donatable))
            at_L = float(short.stock_end[L - 1]) if L > 0 else stock
            order = round_up(float(fc.ext[s][L:L + 14].sum()) - at_L) if level != "ok" else 0
            cells[(h, m)] = dict(
                hospital=h, medicine=m, stock=int(stock), on_hand=int(on_hand),
                physical=int(sum(b.qty for b in phys.get((h, m), []))),   # in the store room; moves only on receive
                incoming=int(incoming.get((h, m), 0)), outgoing=int(outgoing.get((h, m), 0)),
                daily_forecast=round(daily, 1), forecast_7d=int(round(fc.p50[s][:7].sum())),
                forecast_14d=int(round(fc.p50[s].sum())),
                days_of_cover=r1(stock / daily) if daily > 0 else None,
                days_to_stockout=r1(dts), days_to_stockout_p90=r1(pess.stockout),
                lead_days=L, risk=level, need=int(need), surplus=int(surplus), reserve=int(reserve),
                projected_waste=int(round(waste)),
                waste_value=int(round(waste * self.M[m]["unit_cost"])),
                order_qty=order, spike=bool(fc.flagged[s]), surge=round(float(fc.ratio[s]), 2),
                message=warning_text(self.H[h]["name"], self.M[m]["name"], self.M[m]["unit"],
                                     dts, L, level, order, int(incoming.get((h, m), 0))),
            )

        # priority (needs every cell's stock/reserve for the alternatives factor)
        for (h, m), cell in cells.items():
            med = self.M[m]
            alt_days, alt_name = 0.0, None
            for a in med["alternatives"]:
                ac = cells.get((h, a))
                if ac:
                    spare = max(0, ac["stock"] - ac["reserve"])
                    d = spare / max(ac["daily_forecast"], 0.1)   # spare days of the alternative
                    if d >= alt_days:
                        alt_days, alt_name = d, self.M[a]["name"]
            hosp = self.H[h]
            f = priority.factors(patient_load=hosp["patient_load"], max_load=max_load,
                                 emergency_index=hosp["emergency_index"], surge=cell["surge"],
                                 criticality=med["criticality"], alt_spare_days=alt_days,
                                 has_alternatives=bool(med["alternatives"]), dts=cell["days_to_stockout"],
                                 lead=cell["lead_days"])
            sc, contrib = priority.score(f, weights)
            cell["priority"] = {
                "score": sc, "factors": f, "contributions": contrib,
                "alternative": alt_name, "alternative_spare_days": round(alt_days, 1),
                "explanation": priority.explain(hosp["name"], f, contrib, dict(
                    patient_load=hosp["patient_load"], surge=cell["surge"],
                    emergency_index=hosp["emergency_index"], dts=cell["days_to_stockout"],
                    lead=cell["lead_days"], has_alternatives=bool(med["alternatives"]),
                    alt_name=alt_name, alt_spare_days=alt_days)),
            }

        expiry = self._expiry(fc, cur, sims)
        plan = self._plan(fc, cur, cells, sims)
        verification = self.verify(fc, cur, cells, plan["moves"])
        orders = self._orders(fc, cells, verification)
        outcome = self._outcome(scenario, fc, phys, cells, verification, orders)

        cell_list = sorted(cells.values(), key=lambda c: (RISK_ORDER[c["risk"]], c["days_to_stockout"] or 999))
        warnings = [c for c in cell_list if c["risk"] != "ok"]
        spikes = [{"hospital": h, "medicine": m, "surge": round(float(fc.ratio[s]), 2),
                   "z": round(float(fc.z[s]), 1), "growth_per_day": round(float(fc.growth[s]), 3),
                   "detected_day": int(fc.detected_day[s]),
                   "detected_date": (TODAY + timedelta(days=int(fc.detected_day[s]) - HISTORY_DAYS)).isoformat()}
                  for (h, m), s in fc.index.items() if fc.flagged[s]]
        return {
            "scenario": scenario, "weights": weights, "today": TODAY.isoformat(),
            "cells": cell_list, "warnings": warnings, "spikes": spikes, "expiry": expiry,
            "plan": plan, "verification": verification, "orders": orders, "outcome": outcome,
            "metrics": fc.metrics, "kpis": self._kpis(cells, expiry, plan, verification, spikes, outcome),
        }

    # --------------------------------------------------------------- expiry
    def _expiry(self, fc, cur, sims):
        out = []
        for (h, m), bl in cur.items():
            if (h, m) not in fc.index:
                continue
            s = fc.index[(h, m)]
            _, long = sims[(h, m)]
            med, hosp = self.M[m], self.H[h]
            for b in bl:
                w = long.wasted.get(b.id, 0)
                if w < max(10, 0.05 * b.qty):
                    continue
                exp = max(b.exp, 0)
                demand_before = float(fc.ext[s][:exp].sum())
                used = long.used.get(b.id, 0)
                earlier = int(round(sum(long.used.get(o.id, 0) for o in bl if o.exp < b.exp and o.id != b.id)))
                wi, ui = int(round(w)), int(round(used))
                out.append({
                    "batch_id": b.id, "hospital": h, "medicine": m, "qty": b.qty,
                    "expiry_date": (TODAY + timedelta(days=b.exp)).isoformat(), "days_left": b.exp,
                    "demand_before_expiry": int(round(demand_before)), "expected_use": ui,
                    "used_by_earlier_batches": earlier, "projected_waste": wi,
                    "waste_pct": round(100 * w / max(b.qty, 1), 1),
                    "value": int(round(w * med["unit_cost"])), "virtual": b.virtual,
                    "reason": (f"{b.qty:,} {med['unit']} expire on {(TODAY + timedelta(days=b.exp)).strftime('%d %b')} "
                               f"(in {b.exp} days). {hosp['name']} is forecast to need {int(round(demand_before)):,} "
                               f"{med['unit']} of {med['name']} before then"
                               + (f", {earlier:,} of which come from earlier-expiring batches" if earlier else "")
                               + f", so this batch supplies only {ui:,}. About {wi:,} {med['unit']} "
                               f"(₹{int(round(w * med['unit_cost'])):,}) will expire unused."),
                })
        return sorted(out, key=lambda e: -e["value"])

    # ----------------------------------------------------------------- plan
    def _plan(self, fc, cur, cells, sims):
        moves, shortfalls = [], []
        for med in self.medicines:
            m = med["id"]
            parties = []
            for h in self.H:
                cell = cells[(h, m)]
                s = fc.index[(h, m)]
                avail = [b for b in cur.get((h, m), []) if b.arrive <= 0 and not b.virtual]
                parties.append(optimizer.Party(
                    hospital=h, need=cell["need"], surplus=cell["surplus"],
                    weight=1 + cell["priority"]["score"] / 100, batches=avail,
                    waste=sims[(h, m)][1].wasted, demand=fc.ext[s], unmet=sims[(h, m)][1].unmet))
            planned = optimizer.plan(parties, self.hours)
            planned += optimizer.rescue(parties, self.hours, planned)
            keeps = {}
            planned += self._emergency_loans(fc, cells, parties, planned, m, keeps)
            received = {}
            waste_left = {}
            for mv in planned:
                if mv["kind"] in ("need", "emergency"):
                    received[mv["to"]] = received.get(mv["to"], 0) + mv["qty"]
                rc, dc = cells[(mv["to"], m)], cells[(mv["from"], m)]
                rescued = 0
                for a in mv["allocations"]:
                    key = a["batch_id"]
                    waste_left.setdefault(key, sims[(mv["from"], m)][1].wasted.get(key, 0))
                    r = min(a["qty"], waste_left[key])
                    waste_left[key] -= r
                    rescued += r
                mv.update({
                    "medicine": m, "unit": med["unit"], "km": self.km[(mv["from"], mv["to"])],
                    "covers_days": r1(mv["qty"] / max(rc["daily_forecast"], 0.1)),
                    "rescued_from_expiry": int(round(rescued)),
                    "recipient_days_to_stockout": rc["days_to_stockout"],
                    "recipient_lead_days": rc["lead_days"],
                    "recipient_priority": rc["priority"]["score"],
                })
                if mv["kind"] == "rescue":
                    exp = min(a["expires_in_days"] for a in mv["allocations"])
                    why = [f"these units would otherwise expire unused at {self.H[mv['from']]['name']} in {exp} days",
                           f"{self.H[mv['to']]['name']} is projected to run short of {med['name']} before then "
                           f"(stock lasts {rc['days_to_stockout']} days), so this replaces part of its next order"]
                elif mv["kind"] == "emergency":
                    why = [f"{self.H[mv['to']]['name']} runs out in {rc['days_to_stockout']} days but resupply takes "
                           f"{rc['lead_days']} days, and no hospital holds stock above its normal 14-day safety reserve",
                           f"{self.H[mv['from']]['name']} lends only what it can spare while keeping "
                           f"{keeps.get(mv['from'], 0):,} {med['unit']} for its own {dc['lead_days']}-day resupply wait "
                           f"plus a {SAFETY_DAYS}-day buffer, and should reorder to replace the loan"]
                else:
                    why = [f"{self.H[mv['to']]['name']} runs out in {rc['days_to_stockout']} days but resupply takes "
                           f"{rc['lead_days']} days"]
                    if rescued >= 1:
                        why.append(f"{int(round(rescued)):,} of these units would otherwise expire unused at "
                                   f"{self.H[mv['from']]['name']}")
                    else:
                        why.append(f"{self.H[mv['from']]['name']} still keeps its own 14-day P90 demand "
                                   f"({dc['reserve']:,} {med['unit']})")
                why.append(f"{mv['km']} km, ~{mv['hours']} h by road")
                mv["text"] = (f"Move {mv['qty']:,} {med['unit']} of {med['name']} from {self.H[mv['from']]['name']} "
                              f"({mv['from']}) to {self.H[mv['to']]['name']} ({mv['to']})")
                mv["reason"] = "; ".join(why) + "."
                moves.append(mv)
            for h in self.H:
                cell = cells[(h, m)]
                if cell["need"] >= 1:
                    got = received.get(h, 0)
                    if cell["need"] - got >= 1:
                        shortfalls.append({"hospital": h, "medicine": m, "need": cell["need"], "received": got,
                                           "shortfall": cell["need"] - got,
                                           "priority": cell["priority"]["score"],
                                           "lead_days": cell["lead_days"],
                                           "alternative": cell["priority"]["alternative"],
                                           "alternative_spare_days": cell["priority"]["alternative_spare_days"]})
        for i, mv in enumerate(moves):
            mv["id"] = f"M{i + 1}"
            mv["key"] = f'{mv["medicine"]}:{mv["from"]}>{mv["to"]}:{mv["kind"]}'   # stable across re-plans
        return {"moves": moves, "shortfalls": shortfalls}

    def _emergency_loans(self, fc, cells, parties, planned, m, keeps):
        """Second optimiser run for need that normal transfers could not cover.  A normal donor must keep
        its P90 demand for 14 days; here a donor only has to cover its own supplier lead time plus the
        safety buffer (it will reorder), so hospitals with long cover can lend the difference."""
        got = {}
        shipped, out_by = {}, {}
        for mv in planned:
            if mv["kind"] in ("need", "emergency"):
                got[mv["to"]] = got.get(mv["to"], 0) + mv["qty"]
            out_by[mv["from"]] = out_by.get(mv["from"], 0) + mv["qty"]
            for a in mv["allocations"]:
                shipped[a["batch_id"]] = shipped.get(a["batch_id"], 0) + a["qty"]
        resid = {p.hospital: p.need - got.get(p.hospital, 0) for p in parties}
        if not any(r >= 1 for r in resid.values()):
            return []
        eparties = []
        for p in parties:
            cell = cells[(p.hospital, m)]
            s = fc.index[(p.hospital, m)]
            need = max(0.0, resid[p.hospital])
            lend = 0.0
            if need < 1 and cell["need"] < 1 and cell["risk"] in ("ok", "watch"):
                keep = float(fc.p90[s][:self.lead[(p.hospital, m)] + SAFETY_DAYS].sum())
                keeps[p.hospital] = int(round(keep))
                lend = max(0.0, sum(b.qty for b in p.batches) - out_by.get(p.hospital, 0) - keep)
            batches = [Batch(b.id, b.qty - shipped.get(b.id, 0), b.exp, b.arrive, b.virtual)
                       for b in p.batches if b.qty - shipped.get(b.id, 0) > 0]
            eparties.append(optimizer.Party(hospital=p.hospital, need=need, surplus=lend, weight=p.weight,
                                            batches=batches, waste={}, demand=p.demand, unmet=p.unmet))
        loans = optimizer.plan(eparties, self.hours)
        for mv in loans:
            mv["kind"] = "emergency"
        return loans

    # --------------------------------------------------------------- verify
    def apply_moves(self, cur, moves):
        after = {k: [Batch(b.id, b.qty, b.exp, b.arrive, b.virtual) for b in v] for k, v in cur.items()}
        for mv in moves:
            for a in mv["allocations"]:
                src = next(b for b in after[(mv["from"], mv["medicine"])] if b.id == a["batch_id"])
                src.qty -= a["qty"]
                after.setdefault((mv["to"], mv["medicine"]), []).append(
                    Batch(f"{a['batch_id']}>{mv['to']}", a["qty"], src.exp, mv["arrival_day"], True))
        return after

    def verify(self, fc, cur, cells, moves) -> dict:
        after = self.apply_moves(cur, moves)
        checks = []

        def check(name, ok, detail):
            checks.append({"name": name, "passed": bool(ok), "detail": detail})

        totals = []
        for med in self.medicines:
            m = med["id"]
            before = sum(b.qty for (h, mm), bl in cur.items() if mm == m for b in bl)
            aft = sum(b.qty for (h, mm), bl in after.items() if mm == m for b in bl)
            moved = sum(mv["qty"] for mv in moves if mv["medicine"] == m)
            totals.append({"medicine": m, "before": before, "after": aft, "moved": moved})
        check("Network units conserved", all(t["before"] == t["after"] for t in totals),
              "; ".join(f"{t['medicine']}: {t['before']:,} → {t['after']:,}" for t in totals))
        overdrawn = [b.id for bl in after.values() for b in bl if b.qty < 0]
        check("No batch over-drawn", not overdrawn, "all donor batches ≥ 0" if not overdrawn else ", ".join(overdrawn))
        bad_exp = [f"{mv['id']}:{a['batch_id']}" for mv in moves for a in mv["allocations"]
                   if a["expires_in_days"] - mv["arrival_day"] < 2]
        check("No stock shipped that expires before it can be used", not bad_exp,
              "every shipped batch has ≥2 usable days after arrival" if not bad_exp else ", ".join(bad_exp))
        over = [mv["id"] for mv in moves if mv["kind"] in ("need", "emergency") and
                sum(x["qty"] for x in moves if x["to"] == mv["to"] and x["medicine"] == mv["medicine"]
                    and x["kind"] in ("need", "emergency")) > cells[(mv["to"], mv["medicine"])]["need"]]
        check("Shortage transfers never exceed the recipient's need", not over,
              "received ≤ unmet demand before supplier resupply" if not over else ", ".join(set(over)))
        late = [mv["id"] for mv in moves if mv["recipient_days_to_stockout"] is not None
                and mv["arrival_day"] > math.floor(mv["recipient_days_to_stockout"])]
        check("Every transfer arrives before the recipient runs out", not late,
              "all routes ≤ 12 h → same-day arrival" if not late else ", ".join(late))

        ledger = []
        donor_bad = []
        touched = sorted({(mv["from"], mv["medicine"]) for mv in moves} | {(mv["to"], mv["medicine"]) for mv in moves})
        for (h, m) in touched:
            s = fc.index[(h, m)]
            W = min(HORIZON, self.lead[(h, m)] + SAFETY_DAYS)
            b_short, b_long, _ = self._cell_projection(fc, s, cur.get((h, m), []))
            a_short, a_long, _ = self._cell_projection(fc, s, after.get((h, m), []))
            out_q = sum(mv["qty"] for mv in moves if mv["from"] == h and mv["medicine"] == m)
            in_q = sum(mv["qty"] for mv in moves if mv["to"] == h and mv["medicine"] == m)
            row = {
                "hospital": h, "medicine": m, "role": "donor" if out_q else "recipient",
                "before": sum(b.qty for b in cur.get((h, m), [])), "out": out_q, "in": in_q,
                "after": sum(b.qty for b in after.get((h, m), [])),
                "dts_before": r1(b_short.stockout), "dts_after": r1(a_short.stockout),
                "window_days": W,
                "unmet_window_before": int(round(b_short.unmet[:W].sum())),
                "unmet_window_after": int(round(a_short.unmet[:W].sum())),
                "unmet_14d_before": int(round(b_short.unmet[:HORIZON].sum())),
                "unmet_14d_after": int(round(a_short.unmet[:HORIZON].sum())),
                "waste_before": int(round(sum(b_long.wasted.values()))),
                "waste_after": int(round(sum(a_long.wasted.values()))),
            }
            row["balanced"] = row["before"] - row["out"] + row["in"] == row["after"]
            ledger.append(row)
            lender = any(mv["kind"] == "emergency" and mv["from"] == h and mv["medicine"] == m for mv in moves)
            gained = (row["unmet_window_after"] > row["unmet_window_before"]) if lender \
                else (row["unmet_14d_after"] > row["unmet_14d_before"])
            if out_q and gained:
                donor_bad.append(f"{h}/{m}")
        check("Donors stay covered", not donor_bad,
              "no donor gains unmet demand (14 days; emergency lenders: until their own resupply arrives)"
              if not donor_bad else ", ".join(donor_bad))
        new_waste = [f"{r['hospital']}/{r['medicine']}" for r in ledger
                     if r["in"] and r["waste_after"] > r["waste_before"] + 5]
        check("No transfer creates new waste at the recipient", not new_waste,
              "recipients use every received unit before it expires" if not new_waste else ", ".join(new_waste))
        check("Ledger balances per hospital (before − out + in = after)", all(r["balanced"] for r in ledger),
              f"{len(ledger)} hospital-medicine rows")
        avoided = [r for r in ledger if r["unmet_window_before"] > 0 and r["unmet_window_after"] == 0]
        summary = {
            "moves": len(moves), "units_moved": sum(mv["qty"] for mv in moves),
            "rescue_moves": sum(1 for mv in moves if mv["kind"] == "rescue"),
            "emergency_moves": sum(1 for mv in moves if mv["kind"] == "emergency"),
            "unmet_window_before": sum(r["unmet_window_before"] for r in ledger),
            "unmet_window_after": sum(r["unmet_window_after"] for r in ledger),
            "unmet_14d_before": sum(r["unmet_14d_before"] for r in ledger),
            "unmet_14d_after": sum(r["unmet_14d_after"] for r in ledger),
            "waste_before": sum(r["waste_before"] for r in ledger),
            "waste_after": sum(r["waste_after"] for r in ledger),
            "stockouts_avoided": len(avoided),
        }
        return {"passed": all(c["passed"] for c in checks), "checks": checks, "totals": totals,
                "ledger": ledger, "summary": summary, "_after": after}

    def _orders(self, fc, cells, verification):
        after = verification["_after"]
        out = []
        for (h, m), cell in cells.items():
            if cell["risk"] not in ("stockout", "critical", "high"):
                continue
            s = fc.index[(h, m)]
            L = cell["lead_days"]
            sim = fefo(after.get((h, m), []), fc.ext[s][:SHORT])
            at_L = float(sim.stock_end[L - 1]) if L > 0 else 0
            q = round_up(float(fc.ext[s][L:L + 14].sum()) - at_L)
            if q > 0:
                out.append({"hospital": h, "medicine": m, "qty": q, "arrives_in_days": L,
                            "text": f"Order {q:,} {self.M[m]['unit']} of {self.M[m]['name']} for "
                                    f"{self.H[h]['name']} today (arrives in {L} days, covers days {L}–{L + 14})."})
        return sorted(out, key=lambda o: o["arrives_in_days"])

    # --------------------------------------------------------- with/without
    def _outcome(self, scenario, fc, phys, cells, verification, orders):
        truth = self.truth(scenario)
        after = verification["_after"]
        n = HORIZON
        res = {"without": dict(stockout_cells=0, stockout_days=0, unmet_units=0, unmet_critical=0, waste=0),
               "with": dict(stockout_cells=0, stockout_days=0, unmet_units=0, unmet_critical=0, waste=0)}
        daily = {"without": np.zeros(n), "with": np.zeros(n)}
        per_cell = []
        for (h, m), cell in cells.items():
            s = fc.index[(h, m)]
            dem = truth[(h, m)][:n]
            L = cell["lead_days"]
            crit = self.M[m]["criticality"] == 3
            # without: no transfers; reactive order on the day stock runs out
            base = [Batch(b.id, b.qty, b.exp) for b in phys.get((h, m), [])]
            sim0 = fefo(base, dem)
            if sim0.stockout is not None:
                k = int(math.floor(sim0.stockout))
                base.append(Batch("reactive-order", int(fc.ext[s][k + L:k + L + 21].sum()), 365, k + L))
                sim0 = fefo(base, dem)
            # with: pipeline + planned transfers + proactive order today for high/critical cells
            withb = [Batch(b.id, b.qty, b.exp, b.arrive) for b in after.get((h, m), [])]
            order = next((o for o in orders if o["hospital"] == h and o["medicine"] == m), None)
            if order:
                withb.append(Batch("proactive-order", order["qty"], 365, L))
            sim1 = fefo(withb, dem)
            for name, sim, bl in (("without", sim0, base), ("with", sim1, withb)):
                u = sim.unmet[:n]
                r = res[name]
                r["stockout_cells"] += int(u.sum() >= 1)
                r["stockout_days"] += int((u >= 1).sum())
                r["unmet_units"] += int(round(u.sum()))
                if crit:
                    r["unmet_critical"] += int(round(u.sum()))
                daily[name] += u
                r["waste"] += int(round(sum(fefo(bl, fc.ext[s]).wasted.values())))
            if sim0.unmet.sum() >= 1 or sim1.unmet.sum() >= 1:
                per_cell.append({"hospital": h, "medicine": m, "unmet_without": int(round(sim0.unmet.sum())),
                                 "unmet_with": int(round(sim1.unmet.sum()))})
        return {"horizon_days": n, "basis": "hidden ground-truth demand for the next 14 days",
                "without": res["without"], "with": res["with"],
                "daily": [{"day": i, "date": (TODAY + timedelta(days=i)).isoformat(),
                           "without": int(round(daily["without"][i])), "with": int(round(daily["with"][i]))}
                          for i in range(n)],
                "cells": sorted(per_cell, key=lambda c: -c["unmet_without"])}

    # -------------------------------------------------------------- helpers
    def room(self, scenario, h, m, until_day) -> int:
        """Projected unmet demand of (h, m) before `until_day` - how much extra it could use."""
        fc = self.forecast(scenario)
        _, cur, _, _ = self.pipeline_batches()
        sim = fefo(cur.get((h, m), []), fc.ext[fc.index[(h, m)]][:max(int(until_day), 1)])
        return int(round(sim.unmet.sum()))

    def series(self, scenario, medicine, hospital="ALL", history_days=56) -> dict:
        fc = self.forecast(scenario)
        idx = [fc.index[(h, medicine)] for h in self.H] if hospital == "ALL" else [fc.index[(hospital, medicine)]]
        Y = fc.Y[idx].sum(0)
        T = Y.shape[0]
        start = T - history_days
        anomalies = sorted({d for s in idx for d in fc.anomaly_days.get(s, []) if d >= start})
        hist = [{"date": (TODAY + timedelta(days=d - T)).isoformat(), "actual": int(Y[d]),
                 "anomaly": d in anomalies} for d in range(start, T)]
        fut = [{"date": (TODAY + timedelta(days=k)).isoformat(), "p50": round(float(fc.p50[idx, k].sum()), 1),
                "p10": round(float(fc.p10[idx, k].sum()), 1), "p90": round(float(fc.p90[idx, k].sum()), 1),
                "gbm": round(float(fc.gbm[idx, k].sum()), 1)} for k in range(HORIZON)]
        weekly = [{"week_ending": (TODAY + timedelta(days=e - T)).isoformat(), "units": int(Y[e - 6:e + 1].sum())}
                  for e in range(T - 1, 20, -7)][::-1]
        flagged = [s for s in idx if fc.flagged[s]]
        det = [int(fc.detected_day[s]) for s in flagged]
        return {"medicine": medicine, "hospital": hospital, "history": hist, "forecast": fut, "weekly": weekly,
                "spike": bool(flagged), "spike_series": len(flagged),
                "detected_date": (TODAY + timedelta(days=min(det) - T)).isoformat() if det else None,
                "outbreak_start": self.meta.get("outbreak_start"),
                "next_7d": int(round(fc.p50[idx, :7].sum())), "next_14d": int(round(fc.p50[idx].sum()))}

    def medicine_detail(self, scenario, medicine) -> dict:
        """One medicine across the network: every batch in expiry order, per-hospital stock, projected waste."""
        a = self.analysis(scenario)
        batches = [{"batch_id": b.id, "hospital": h, "qty": b.qty, "days_left": b.exp,
                    "expiry_date": (TODAY + timedelta(days=b.exp)).isoformat()}
                   for (h, m), bl in self.physical_batches().items() if m == medicine for b in bl]
        batches.sort(key=lambda b: (b["days_left"], b["batch_id"]))
        cells = {c["hospital"]: c for c in a["cells"] if c["medicine"] == medicine}
        waste = [e for e in a["expiry"] if e["medicine"] == medicine]
        timeline, lo = [], -1
        for hi, label in ((30, "within 30 days"), (90, "31–90 days"), (180, "91–180 days"), (365, "181–365 days"), (10 ** 9, "over a year")):
            inside = [b for b in batches if lo < b["days_left"] <= hi]
            timeline.append({"label": label, "batches": len(inside), "units": sum(b["qty"] for b in inside)})
            lo = hi
        return {"medicine": self.M[medicine], "batches": batches, "timeline": timeline,
                "hospitals": [{"hospital": h, "units": cells[h]["physical"], "days_to_stockout": cells[h]["days_to_stockout"],
                               "risk": cells[h]["risk"]} for h in self.H],
                "totals": {"units": sum(b["qty"] for b in batches), "projected_waste": sum(e["projected_waste"] for e in waste),
                           "waste_value": sum(e["value"] for e in waste)}}

    def hospital_detail(self, scenario, hospital, weights=None) -> dict:
        a = self.analysis(scenario, weights)
        _, cur, _, _ = self.pipeline_batches()
        batches = [{"medicine": m, "batch_id": b.id, "qty": b.qty, "days_left": b.exp,
                    "expiry_date": (TODAY + timedelta(days=b.exp)).isoformat(), "virtual": b.virtual,
                    "arrive_day": b.arrive}
                   for (h, m), bl in cur.items() if h == hospital for b in sorted(bl, key=lambda b: b.exp)]
        return {"hospital": self.H[hospital],
                "cells": [c for c in a["cells"] if c["hospital"] == hospital],
                "batches": batches,
                "expiry": [e for e in a["expiry"] if e["hospital"] == hospital],
                "moves": [m for m in a["plan"]["moves"] if hospital in (m["from"], m["to"])],
                "orders": [o for o in a["orders"] if o["hospital"] == hospital],
                "lead_times": {m["id"]: self.lead[(hospital, m["id"])] for m in self.medicines}}

    def judge(self, scenario="outbreak") -> dict:
        """The organisers' sample scenario: 20,000 units, demand rising 2,000 -> 5,500 / week."""
        m = "OSEL"
        a = self.analysis(scenario)
        fc = self.forecast(scenario)
        phys = self.physical_batches()
        idx = [fc.index[(h, m)] for h in self.H]
        Y = fc.Y[idx].sum(0)
        T = Y.shape[0]
        weeks = [int(Y[e - 6:e + 1].sum()) for e in range(T - 29, T, 7)]
        stock = sum(b.qty for h in self.H for b in phys.get((h, m), []))
        last_week = weeks[-1]
        moves = [mv for mv in a["plan"]["moves"] if mv["medicine"] == m]
        ledger = [r for r in a["verification"]["ledger"] if r["medicine"] == m]
        tot = next(t for t in a["verification"]["totals"] if t["medicine"] == m)
        cells = [c for c in a["cells"] if c["medicine"] == m]
        f14 = float(fc.p50[idx].sum())
        out_before = [c for c in cells if c["days_to_stockout"] is not None and c["days_to_stockout"] < c["lead_days"]]
        moved = sum(mv["qty"] for mv in moves)
        statement = (
            f"The network holds {stock:,} units of {self.M[m]['name']}. Weekly demand rose "
            f"{' → '.join(f'{w:,}' for w in weeks)}. At {last_week:,}/week the network as a whole has "
            f"{stock / (last_week / 7):.1f} days of cover, and the forecast for the next 14 days is {f14:,.0f} units, "
            f"so the total is enough but it sits in the wrong places: {', '.join(self.H[c['hospital']]['name'] for c in out_before)} "
            f"run out before supplier resupply can arrive. The plan moves {moved:,} units in {len(moves)} transfers; "
            f"network stock is {tot['before']:,} before and {tot['after']:,} after (conserved).")
        return {"medicine": m, "stock_total": stock, "weekly_demand": weeks,
                "aggregate_cover_days": round(stock / (last_week / 7), 1),
                "forecast_14d": {"p50": round(f14), "p10": round(float(fc.p10[idx].sum())),
                                 "p90": round(float(fc.p90[idx].sum()))},
                "hospitals": cells, "moves": moves, "ledger": ledger, "totals": tot,
                "checks": a["verification"]["checks"], "passed": a["verification"]["passed"],
                "statement": statement}

    def _kpis(self, cells, expiry, plan, verification, spikes, outcome):
        at_risk = [c for c in cells.values() if c["risk"] in ("stockout", "critical", "high")]
        return {
            "cells_at_risk": len(at_risk),
            "hospitals_at_risk": len({c["hospital"] for c in at_risk}),
            "waste_units": sum(e["projected_waste"] for e in expiry),
            "waste_value": sum(e["value"] for e in expiry),
            "moves": len(plan["moves"]), "units_moved": verification["summary"]["units_moved"],
            "stockouts_avoided": outcome["without"]["stockout_cells"] - outcome["with"]["stockout_cells"],
            "unmet_without": outcome["without"]["unmet_units"], "unmet_with": outcome["with"]["unmet_units"],
            "spikes": len(spikes), "plan_verified": verification["passed"],
        }
