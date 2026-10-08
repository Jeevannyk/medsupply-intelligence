"""Hospital exchange: how hospitals talk to each other about stock.

* A hospital with excess stock posts an OFFER, to one named hospital or to everyone.
* A hospital short of stock posts a REQUEST, to one named hospital or to everyone.
* The other side answers: a named hospital accepts or declines; for a broadcast any hospital may accept.
  Accepting means both sides agree, so it opens a TRANSFER that is already approved.
* The network AI plan proposes transfers too; the donor approves or declines them.
  Transfer life cycle: pending (AI proposal only) -> approved -> in_transit -> delivered
  (or declined / cancelled). Delivery moves the batch in the database.
* The network admin only watches and proposes; it never approves, declines, dispatches or receives.
* Every step posts a message, so each transfer carries its own thread.
"""
import json
from datetime import datetime, timedelta

from . import logistics
from .config import TODAY
from .db import rows, session
from .engine import ACTIVE, Engine, days_until
from .logistics import LogisticsError
from .optimizer import arrival_day


class ExchangeError(ValueError):
    pass


def now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def post_message(c, sender, recipient, body, kind="chat", transfer_id=None, offer_id=None, request_id=None):
    c.execute("INSERT INTO messages (ts, sender, recipient, kind, body, transfer_id, offer_id, request_id) "
              "VALUES (?,?,?,?,?,?,?,?)", (now(), sender, recipient, kind, body, transfer_id, offer_id, request_id))


def committed(c) -> dict:
    """batch_id -> units promised in active transfers."""
    out = {}
    for t in rows(c, f"SELECT allocations FROM transfers WHERE status IN {ACTIVE}"):
        for a in json.loads(t["allocations"] or "[]"):
            out[a["batch_id"]] = out.get(a["batch_id"], 0) + int(a["qty"])
    return out


def allocate(c, hospital, medicine, qty, hours, batch_id=None) -> list[dict]:
    """Pick free donor batches, earliest expiry first, that stay usable after arrival."""
    taken = committed(c)
    arr = arrival_day(hours)
    q = "SELECT * FROM batches WHERE hospital_id=? AND medicine_id=? AND qty>0"
    args = [hospital, medicine]
    if batch_id:
        q += " AND batch_id=?"
        args.append(batch_id)
    allocs, left = [], qty
    for b in sorted(rows(c, q, args), key=lambda b: b["expiry_date"]):
        exp = days_until(b["expiry_date"])
        free = b["qty"] - taken.get(b["batch_id"], 0)
        if exp - arr < 2 or free <= 0:
            continue
        take = min(free, left)
        allocs.append({"batch_id": b["batch_id"], "qty": int(take), "expires_in_days": exp})
        left -= take
        if left <= 0:
            break
    if left > 0:
        raise ExchangeError(f"{hospital} has only {qty - left:,} free units of {medicine} that can be shipped")
    return allocs


class Exchange:
    def __init__(self, engine: Engine):
        self.e = engine

    def name(self, h):
        return self.e.H[h]["name"] if h in self.e.H else ("Network AI" if h == "AI" else h)

    def _create(self, c, medicine, frm, to, allocations, origin, reason, awaiting, initiator, status="pending"):
        if frm == to:
            raise ExchangeError("Donor and recipient must differ")
        qty = sum(a["qty"] for a in allocations)
        hours = self.e.hours[(frm, to)]
        cur = c.execute(
            "INSERT INTO transfers (medicine_id, from_id, to_id, qty, allocations, status, awaiting, origin, "
            "reason, hours, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (medicine, frm, to, qty, json.dumps(allocations), status, awaiting, origin, reason, hours, now(), now()))
        tid = cur.lastrowid
        med = self.e.M[medicine]
        tail = (f"Awaiting approval from {self.name(awaiting)}." if status == "pending"
                else f"Agreed by both hospitals. {self.name(frm)} to dispatch.")
        post_message(c, initiator, awaiting,
                     f"Transfer #{tid}: {qty:,} {med['unit']} of {med['name']} from {self.name(frm)} to "
                     f"{self.name(to)} (~{hours} h). {reason} {tail}",
                     "system", transfer_id=tid)
        return tid

    # ------------------------------------------------------------ AI plan
    def send_plan(self, scenario, weights, move_ids=None) -> list[int]:
        """Open transfers for the selected moves only (matched by stable key or id).
        move_ids=None sends the whole plan; an empty list sends nothing."""
        a = self.e.analysis(scenario, weights)
        chosen = [mv for mv in a["plan"]["moves"] if move_ids is None or mv["key"] in move_ids or mv["id"] in move_ids]
        if move_ids is not None and not chosen:
            raise ExchangeError("The selected transfers are no longer in the plan. Refresh and select again.")
        ids = []
        with session() as c:
            for mv in chosen:
                tid = self._create(c, mv["medicine"], mv["from"], mv["to"], mv["allocations"], "ai_plan",
                                   mv["reason"], awaiting=mv["from"], initiator="AI")
                post_message(c, "AI", mv["to"],
                             f"Incoming: {mv['qty']:,} {mv['unit']} of {self.e.M[mv['medicine']]['name']} proposed from "
                             f"{self.name(mv['from'])} (transfer #{tid}). You will be notified when it is dispatched.",
                             "system", transfer_id=tid)
                ids.append(tid)
        self.e.invalidate()
        return ids

    # -------------------------------------------------------- transitions
    def act(self, tid: int, action: str, actor: str, note: str = "", code: str | None = None,
            received_qty: int | None = None, condition: str = "ok") -> dict:
        with session() as c:
            t = next(iter(rows(c, "SELECT * FROM transfers WHERE id=?", (tid,))), None)
            if not t:
                raise ExchangeError(f"Transfer #{tid} not found")
            st, frm, to = t["status"], t["from_id"], t["to_id"]
            if actor not in self.e.H:
                raise ExchangeError("Only a hospital node can approve, decline, dispatch, receive or cancel a transfer. "
                                    "The network admin can propose transfers but not act on them.")
            med = self.e.M[t["medicine_id"]]
            label = f"{t['qty']:,} {med['unit']} of {med['name']}"
            if action == "approve":
                if st != "pending" or actor != t["awaiting"]:
                    raise ExchangeError("Only the awaited party can approve a pending transfer")
                new, awaiting, body = "approved", frm, f"{self.name(actor)} approved transfer #{tid} ({label})."
            elif action == "decline":
                if st != "pending" or actor not in (frm, to):
                    raise ExchangeError("Only a pending transfer can be declined by its parties")
                new, awaiting, body = "declined", None, f"{self.name(actor)} declined transfer #{tid} ({label})."
            elif action == "dispatch":
                if st != "approved" or actor != frm:
                    raise ExchangeError("Only the donor can dispatch an approved transfer")
                s = logistics.dispatch(c, t, self.name(frm), self.name(to))
                new, awaiting = "in_transit", to
                body = (f"{self.name(frm)} dispatched transfer #{tid} ({label}) with {logistics.describe(s)}. "
                        f"ETA {logistics.parse(s['eta_at']):%H:%M}. Confirm receipt with the donor's handover code.")
            elif action == "receive":
                if st != "in_transit" or actor != to:
                    raise ExchangeError("Only the recipient can confirm receipt of an in-transit transfer")
                s = logistics.shipment_for(c, tid)
                accepted, missing, cond, resolution = logistics.check_receipt(s, t, code, received_qty, condition)
                self._deliver(c, t, accepted, resolution)
                logistics.close(c, t, s, accepted, missing, cond, resolution, note, actor)
                new, awaiting = "delivered", None
                body = f"{self.name(to)} received transfer #{tid} ({label}). Stock records updated."
                if missing:
                    body = (f"{self.name(to)} received {accepted:,} of {label} on transfer #{tid}; {missing:,} {cond}, "
                            f"{resolution.replace('_', ' ')}. Stock records updated for the {accepted:,} accepted.")
            elif action == "cancel":
                if st not in ("pending", "approved") or actor not in (frm, to):
                    raise ExchangeError("Only pending or approved transfers can be cancelled")
                logistics.cancel(c, t)
                new, awaiting, body = "cancelled", None, f"{self.name(actor)} cancelled transfer #{tid} ({label})."
            else:
                raise ExchangeError(f"Unknown action {action}")
            if note:
                body += f" Note: {note}"
            c.execute("UPDATE transfers SET status=?, awaiting=?, updated_at=? WHERE id=?", (new, awaiting, now(), tid))
            for party in sorted({frm, to} - {actor}):
                post_message(c, actor, party, body, "system", transfer_id=tid)
        self.e.invalidate()
        return self.transfer(tid, actor)

    def _deliver(self, c, t, accepted: int | None = None, resolution: str | None = None):
        """Move the accepted units into the recipient's stock. Units that never arrived intact either go back to
        the donor's batch (short) or are written off (damaged); either way only `accepted` reaches the recipient."""
        left = int(t["qty"]) if accepted is None else int(accepted)
        for a in json.loads(t["allocations"]):
            src = next(iter(rows(c, "SELECT * FROM batches WHERE batch_id=?", (a["batch_id"],))), None)
            if not src or src["qty"] < a["qty"]:
                raise ExchangeError(f"Batch {a['batch_id']} no longer has {a['qty']} units at the donor")
            take = min(int(a["qty"]), left)
            left -= take
            leave = take if resolution == "returned_to_donor" else int(a["qty"])
            c.execute("UPDATE batches SET qty=qty-? WHERE batch_id=?", (leave, a["batch_id"]))
            if take > 0:
                c.execute("INSERT INTO batches (batch_id, hospital_id, medicine_id, qty, expiry_date, received_date, source) "
                          "VALUES (?,?,?,?,?,?,?)",
                          (f"{a['batch_id']}>{t['to_id']}#{t['id']}", t["to_id"], t["medicine_id"], take,
                           src["expiry_date"], TODAY.isoformat(), f"transfer #{t['id']} from {t['from_id']}"))

    # ------------------------------------------------------ offers/requests
    def _check_party(self, hospital, target=None):
        if hospital not in self.e.H:
            raise ExchangeError("Offers and requests are posted by a hospital node, not the network admin")
        if target in ("", "ALL"):
            target = None
        if target is not None:
            if target not in self.e.H:
                raise ExchangeError(f"Unknown hospital {target}")
            if target == hospital:
                raise ExchangeError("Choose a different hospital")
        return target

    def suggest_takers(self, scenario, hospital, medicine, expiry_days, limit=4):
        out = []
        for h in self.e.H:
            if h == hospital:
                continue
            room = self.e.room(scenario, h, medicine, expiry_days)
            if room >= 10:
                out.append({"hospital": h, "can_use": room, "hours": self.e.hours[(hospital, h)]})
        return sorted(out, key=lambda x: (-x["can_use"], x["hours"]))[:limit]

    def suggest_donors(self, scenario, hospital, medicine, limit=4):
        a = self.e.analysis(scenario)
        out = [{"hospital": c["hospital"], "surplus": c["surplus"], "hours": self.e.hours[(c["hospital"], hospital)]}
               for c in a["cells"] if c["medicine"] == medicine and c["hospital"] != hospital and c["surplus"] >= 10]
        return sorted(out, key=lambda x: (x["hours"], -x["surplus"]))[:limit]

    def post_offer(self, scenario, hospital, medicine, qty, batch_id=None, note="", target=None):
        target = self._check_party(hospital, target)
        med = self.e.M[medicine]
        qty = int(qty)
        if qty <= 0:
            raise ExchangeError("Quantity must be positive")
        with session() as c:
            if batch_id:
                b = next(iter(rows(c, "SELECT * FROM batches WHERE batch_id=? AND hospital_id=?", (batch_id, hospital))), None)
                if not b:
                    raise ExchangeError(f"Batch {batch_id} not found at {hospital}")
                expiry = b["expiry_date"]
            else:
                bs = rows(c, "SELECT expiry_date FROM batches WHERE hospital_id=? AND medicine_id=? AND qty>0 "
                             "ORDER BY expiry_date", (hospital, medicine))
                expiry = bs[0]["expiry_date"] if bs else (TODAY + timedelta(days=180)).isoformat()
            allocate(c, hospital, medicine, qty, 0, batch_id)   # validates free stock
            cur = c.execute("INSERT INTO offers (hospital_id, medicine_id, batch_id, qty, remaining, expiry_date, note, "
                            "status, created_at, target) VALUES (?,?,?,?,?,?,?,?,?,?)",
                            (hospital, medicine, batch_id, qty, qty, expiry, note, "open", now(), target))
            oid = cur.lastrowid
            takers = [] if target else self.suggest_takers(scenario, hospital, medicine, days_until(expiry))
            if target:
                post_message(c, hospital, target,
                             f"{self.name(hospital)} offers you {qty:,} {med['unit']} of {med['name']} (expires {expiry}). "
                             f"{note} Accept or decline in Offers & requests.", "offer", offer_id=oid)
            else:
                sugg = ", ".join(f"{self.name(t['hospital'])} (can use {t['can_use']:,})" for t in takers) or "none yet"
                post_message(c, hospital, "ALL",
                             f"Surplus offer #{oid}: {qty:,} {med['unit']} of {med['name']} available, expires {expiry}. "
                             f"{note} AI-matched takers: {sugg}.", "offer", offer_id=oid)
                for t in takers:
                    post_message(c, "AI", t["hospital"],
                                 f"{self.name(hospital)} is offering {med['name']} (offer #{oid}). Your projected unmet demand "
                                 f"before it expires is {t['can_use']:,} {med['unit']}; accept it to cut your next order.",
                                 "match", offer_id=oid)
        self.e.invalidate()
        return {"offer_id": oid, "suggested_takers": takers, "target": target}

    def claim_offer(self, offer_id, hospital, qty):
        """The taker accepts an offer (a named hospital's, or any broadcast one)."""
        if hospital not in self.e.H:
            raise ExchangeError("Only a hospital node can accept an offer")
        with session() as c:
            o = next(iter(rows(c, "SELECT * FROM offers WHERE id=?", (offer_id,))), None)
            if not o or o["status"] != "open":
                raise ExchangeError("Offer is not open")
            if hospital == o["hospital_id"]:
                raise ExchangeError("You cannot accept your own offer")
            if o["target"] and o["target"] != hospital:
                raise ExchangeError(f"This offer is addressed to {self.name(o['target'])}")
            qty = min(int(qty), o["remaining"])
            if qty <= 0:
                raise ExchangeError("Nothing left on this offer")
            allocs = allocate(c, o["hospital_id"], o["medicine_id"], qty, self.e.hours[(o["hospital_id"], hospital)],
                              o["batch_id"])
            tid = self._create(c, o["medicine_id"], o["hospital_id"], hospital, allocs, "offer",
                               f"{self.name(hospital)} accepted offer #{offer_id}.", awaiting=o["hospital_id"],
                               initiator=hospital, status="approved")
            rem = o["remaining"] - qty
            c.execute("UPDATE offers SET remaining=?, status=? WHERE id=?", (rem, "open" if rem > 0 else "claimed", offer_id))
        self.e.invalidate()
        return self.transfer(tid)

    def post_request(self, scenario, hospital, medicine, qty, needed_within_days=7, note="", target=None):
        target = self._check_party(hospital, target)
        med = self.e.M[medicine]
        qty = int(qty)
        if qty <= 0:
            raise ExchangeError("Quantity must be positive")
        with session() as c:
            cur = c.execute("INSERT INTO requests (hospital_id, medicine_id, qty, remaining, needed_within_days, note, "
                            "status, created_at, target) VALUES (?,?,?,?,?,?,?,?,?)",
                            (hospital, medicine, qty, qty, needed_within_days, note, "open", now(), target))
            rid = cur.lastrowid
            donors = [] if target else self.suggest_donors(scenario, hospital, medicine)
            if target:
                post_message(c, hospital, target,
                             f"{self.name(hospital)} asks you for {qty:,} {med['unit']} of {med['name']} within "
                             f"{needed_within_days} days. {note} Accept or decline in Offers & requests.",
                             "request", request_id=rid)
            else:
                sugg = ", ".join(f"{self.name(d['hospital'])} (spare {d['surplus']:,})" for d in donors) or "none with spare stock"
                post_message(c, hospital, "ALL",
                             f"Stock request #{rid}: {self.name(hospital)} needs {qty:,} {med['unit']} of {med['name']} "
                             f"within {needed_within_days} days. {note} AI-suggested donors: {sugg}.", "request", request_id=rid)
                for d in donors:
                    post_message(c, "AI", d["hospital"],
                                 f"{self.name(hospital)} needs {med['name']} (request #{rid}). You hold {d['surplus']:,} "
                                 f"{med['unit']} above your own 14-day P90 demand; {d['hours']} h away.", "match", request_id=rid)
        self.e.invalidate()
        return {"request_id": rid, "suggested_donors": donors, "target": target}

    def respond_request(self, request_id, donor, qty):
        """A donor accepts a request (a named hospital's, or any broadcast one)."""
        if donor not in self.e.H:
            raise ExchangeError("Only a hospital node can accept a request")
        with session() as c:
            r = next(iter(rows(c, "SELECT * FROM requests WHERE id=?", (request_id,))), None)
            if not r or r["status"] != "open":
                raise ExchangeError("Request is not open")
            if donor == r["hospital_id"]:
                raise ExchangeError("You cannot accept your own request")
            if r["target"] and r["target"] != donor:
                raise ExchangeError(f"This request is addressed to {self.name(r['target'])}")
            qty = min(int(qty), r["remaining"])
            if qty <= 0:
                raise ExchangeError("Nothing left on this request")
            allocs = allocate(c, donor, r["medicine_id"], qty, self.e.hours[(donor, r["hospital_id"])])
            tid = self._create(c, r["medicine_id"], donor, r["hospital_id"], allocs, "request",
                               f"{self.name(donor)} accepted request #{request_id}.", awaiting=donor,
                               initiator=donor, status="approved")
            rem = r["remaining"] - qty
            c.execute("UPDATE requests SET remaining=?, status=? WHERE id=?", (rem, "open" if rem > 0 else "fulfilled", request_id))
        self.e.invalidate()
        return self.transfer(tid)

    def decline(self, table, item_id, hospital):
        """The addressed hospital declines an offer or request made to it."""
        if table not in ("offers", "requests"):
            raise ExchangeError("Unknown item")
        with session() as c:
            r = next(iter(rows(c, f"SELECT * FROM {table} WHERE id=?", (item_id,))), None)
            if not r or r["status"] != "open":
                raise ExchangeError("Item is not open")
            if not r["target"] or r["target"] != hospital:
                raise ExchangeError("Only the hospital it is addressed to can decline it")
            c.execute(f"UPDATE {table} SET status='declined' WHERE id=?", (item_id,))
            kind = "offer" if table == "offers" else "request"
            med = self.e.M[r["medicine_id"]]
            post_message(c, hospital, r["hospital_id"],
                         f"{self.name(hospital)} declined your {kind} of {r['qty']:,} {med['unit']} of {med['name']}.",
                         "system", **({"offer_id": item_id} if table == "offers" else {"request_id": item_id}))
        return {"ok": True}

    def withdraw(self, table, item_id, hospital):
        """The poster takes back an offer or request that is still open."""
        if table not in ("offers", "requests"):
            raise ExchangeError("Unknown item")
        with session() as c:
            r = next(iter(rows(c, f"SELECT * FROM {table} WHERE id=?", (item_id,))), None)
            if not r or r["status"] != "open":
                raise ExchangeError("Item is not open")
            if r["hospital_id"] != hospital:
                raise ExchangeError("Only the hospital that posted it can withdraw it")
            c.execute(f"UPDATE {table} SET status='withdrawn' WHERE id=?", (item_id,))
        self.e.invalidate()
        return {"ok": True}

    def message(self, sender, recipient, body, transfer_id=None):
        with session() as c:
            post_message(c, sender, recipient, body, "chat", transfer_id=transfer_id)
        return {"ok": True}

    # -------------------------------------------------------------- views
    def transfer(self, tid, viewer: str | None = None):
        with session() as c:
            t = rows(c, "SELECT * FROM transfers WHERE id=?", (tid,))[0]
            t["allocations"] = json.loads(t["allocations"] or "[]")
            t["messages"] = rows(c, "SELECT * FROM messages WHERE transfer_id=? ORDER BY id", (tid,))
            t["shipment"] = logistics.public(c, logistics.shipment_for(c, tid), viewer == t["from_id"])
        return t

    # ------------------------------------------------------------ logistics
    def recommend_delivery(self, tid: int) -> dict:
        with session() as c:
            t = next(iter(rows(c, "SELECT * FROM transfers WHERE id=?", (tid,))), None)
        if not t:
            raise ExchangeError(f"Transfer #{tid} not found")
        return {"hours": t["hours"], **logistics.recommend_mode(float(t["hours"] or 0), t["medicine_id"], int(t["qty"]))}

    def arrange_delivery(self, tid: int, actor: str, mode: str, vehicle: str = "", driver: str = "") -> dict:
        with session() as c:
            t = next(iter(rows(c, "SELECT * FROM transfers WHERE id=?", (tid,))), None)
            if not t:
                raise ExchangeError(f"Transfer #{tid} not found")
            if actor != t["from_id"] or actor not in self.e.H:
                raise ExchangeError("Only the donor arranges delivery")
            if t["status"] != "approved":
                raise ExchangeError("Delivery is arranged once the transfer is approved and before it is dispatched")
            s = logistics.arrange(c, t, mode, vehicle, driver, self.name(t["from_id"]), self.name(t["to_id"]))
            post_message(c, actor, t["to_id"], f"{self.name(actor)} arranged delivery for transfer #{tid}: "
                         f"{logistics.MODE_LABEL[mode]}" + (f", {logistics.describe(s)}." if mode != "district" else
                         ": waiting for the district office to assign a vehicle."), "system", transfer_id=tid)
            if mode == "district":
                post_message(c, actor, "DIST", f"Vehicle needed for transfer #{tid}: {t['qty']:,} units of "
                             f"{self.e.M[t['medicine_id']]['name']} from {self.name(t['from_id'])} to {self.name(t['to_id'])} "
                             f"(~{t['hours']} h).", "system", transfer_id=tid)
        return self.transfer(tid, actor)

    def assign_vehicle(self, shipment_id: int, actor: str, vehicle: str, driver: str) -> dict:
        if actor != "DIST":
            raise ExchangeError("Only the district logistics office assigns pool vehicles")
        with session() as c:
            s = logistics.assign_district(c, shipment_id, vehicle, driver)
            t = rows(c, "SELECT * FROM transfers WHERE id=?", (s["transfer_id"],))[0]
            for party in (t["from_id"], t["to_id"]):
                post_message(c, "DIST", party, f"District office assigned {logistics.describe(s)} to transfer #{t['id']}. "
                             f"{self.name(t['from_id'])} can dispatch.", "system", transfer_id=t["id"])
        return self.transfer(t["id"], actor)

    def webhook(self, evt: dict) -> dict:
        with session() as c:
            out = logistics.apply_event(c, evt)
            if not out["duplicate"] and evt.get("type") in ("delayed", "breakdown", "exception", "arrived"):
                s = next(iter(rows(c, "SELECT * FROM shipments WHERE id=?", (out["shipment_id"],))))
                t = rows(c, "SELECT * FROM transfers WHERE id=?", (s["transfer_id"],))[0]
                what = {"arrived": "arrived at the door, waiting for the receiver to confirm"}.get(
                    evt["type"], f"is delayed ({evt.get('note') or 'carrier report'}), new ETA {logistics.parse(s['eta_at']):%H:%M}")
                for party in (t["from_id"], t["to_id"]):
                    post_message(c, "CARRIER", party, f"Shipment for transfer #{t['id']} {what}.", "system", transfer_id=t["id"])
        self.e.invalidate()
        return out

    def simulate_delay(self, shipment_id: int, hours: float, reason: str = "") -> dict:
        with session() as c:
            s = logistics.simulate_delay(c, shipment_id, hours, reason)
            t = rows(c, "SELECT * FROM transfers WHERE id=?", (s["transfer_id"],))[0]
            if s["mode"] != "courier":      # a courier reports its own delays through the webhook
                for party in (t["from_id"], t["to_id"]):
                    post_message(c, "SYSTEM", party, f"Shipment for transfer #{t['id']} is delayed by {hours:g} h, "
                                 f"new ETA {logistics.parse(s['eta_at']):%H:%M}.", "system", transfer_id=t["id"])
        self.e.invalidate()
        return {"ok": True}

    def logistics_board(self, viewer: str | None = None) -> dict:
        logistics.sync_couriers()
        logistics.refresh()
        with session() as c:
            ships = rows(c, "SELECT * FROM shipments ORDER BY COALESCE(dispatched_at, created_at) DESC, id DESC")
            out, queue = [], []
            for s in ships:
                t = rows(c, "SELECT * FROM transfers WHERE id=?", (s["transfer_id"],))[0]
                if viewer in self.e.H and viewer not in (t["from_id"], t["to_id"]):
                    continue
                item = logistics.public(c, s, viewer == t["from_id"])
                item.update(from_id=t["from_id"], to_id=t["to_id"], medicine_id=t["medicine_id"], qty=t["qty"],
                            transfer_status=t["status"])
                out.append(item)
                if s["mode"] == "district" and s["status"] == "requested":
                    queue.append(item)
            discrepancies = rows(c, "SELECT * FROM discrepancies ORDER BY id DESC LIMIT 50")
            now = logistics.stamp(c)
        return {"shipments": out, "district_queue": queue, "discrepancies": discrepancies, "sim_now": now}

    def board(self, hospital: str | None = None) -> dict:
        if hospital == "DIST":
            hospital = "NET"
        logistics.refresh()
        with session() as c:
            ts = rows(c, "SELECT * FROM transfers ORDER BY id DESC")
            offers = rows(c, "SELECT * FROM offers ORDER BY id DESC")
            reqs = rows(c, "SELECT * FROM requests ORDER BY id DESC")
            if hospital and hospital != "NET":
                msgs = rows(c, "SELECT * FROM messages WHERE recipient IN (?, 'ALL') OR sender=? ORDER BY id DESC LIMIT 200",
                            (hospital, hospital))
            else:
                msgs = rows(c, "SELECT * FROM messages ORDER BY id DESC LIMIT 200")
            ships = {s["transfer_id"]: s for s in rows(c, "SELECT * FROM shipments")}
            for t in ts:
                t["shipment"] = logistics.public(c, ships.get(t["id"]), hospital == t["from_id"])
        for t in ts:
            t["allocations"] = json.loads(t["allocations"] or "[]")
        if hospital and hospital != "NET":
            ts = [t for t in ts if hospital in (t["from_id"], t["to_id"])]
        # de-duplicate self-addressed copies when viewing the whole network
        seen, uniq = set(), []
        for m in msgs:
            k = (m["ts"], m["body"])
            if k in seen:
                continue
            seen.add(k)
            uniq.append(m)
        counts = {s: sum(1 for t in ts if t["status"] == s) for s in ("pending", "approved", "in_transit", "delivered")}
        todo = [t for t in ts if t["awaiting"] == hospital] if hospital and hospital != "NET" else \
            [t for t in ts if t["status"] in ACTIVE]
        return {"transfers": ts, "offers": offers, "requests": reqs, "messages": uniq, "counts": counts, "todo": todo}
