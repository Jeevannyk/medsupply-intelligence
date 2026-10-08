"""Hospital exchange: how hospitals talk to each other about stock.

* A hospital with excess stock broadcasts a surplus OFFER; the network AI
  suggests which hospitals can use it before it expires and messages them.
* A hospital short of stock broadcasts a REQUEST; the AI suggests donors.
* Either side (or the AI plan) opens a TRANSFER. Life cycle:
    pending (awaiting the other party) -> approved -> in_transit -> delivered
    (or declined / cancelled). Delivery moves the batch in the database.
* Every step posts a message, so each transfer carries its own thread.
"""
import json
from datetime import datetime, timedelta

from .config import TODAY
from .db import rows, session
from .engine import ACTIVE, Engine, days_until
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

    def _create(self, c, medicine, frm, to, allocations, origin, reason, awaiting, initiator):
        if frm == to:
            raise ExchangeError("Donor and recipient must differ")
        qty = sum(a["qty"] for a in allocations)
        hours = self.e.hours[(frm, to)]
        cur = c.execute(
            "INSERT INTO transfers (medicine_id, from_id, to_id, qty, allocations, status, awaiting, origin, "
            "reason, hours, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (medicine, frm, to, qty, json.dumps(allocations), "pending", awaiting, origin, reason, hours, now(), now()))
        tid = cur.lastrowid
        med = self.e.M[medicine]
        post_message(c, initiator, awaiting,
                     f"Transfer #{tid}: {qty:,} {med['unit']} of {med['name']} from {self.name(frm)} to "
                     f"{self.name(to)} (~{hours} h). {reason} Awaiting approval from {self.name(awaiting)}.",
                     "system", transfer_id=tid)
        return tid

    # ------------------------------------------------------------ AI plan
    def send_plan(self, scenario, weights, move_ids=None) -> list[int]:
        a = self.e.analysis(scenario, weights)
        ids = []
        with session() as c:
            for mv in a["plan"]["moves"]:
                if move_ids and mv["id"] not in move_ids:
                    continue
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
    def act(self, tid: int, action: str, actor: str, note: str = "") -> dict:
        with session() as c:
            t = next(iter(rows(c, "SELECT * FROM transfers WHERE id=?", (tid,))), None)
            if not t:
                raise ExchangeError(f"Transfer #{tid} not found")
            st, frm, to = t["status"], t["from_id"], t["to_id"]
            admin = actor == "NET"
            med = self.e.M[t["medicine_id"]]
            label = f"{t['qty']:,} {med['unit']} of {med['name']}"
            if action == "approve":
                if st != "pending" or not (admin or actor == t["awaiting"]):
                    raise ExchangeError("Only the awaited party can approve a pending transfer")
                new, awaiting, body = "approved", frm, f"{self.name(actor)} approved transfer #{tid} ({label})."
            elif action == "decline":
                if st != "pending" or not (admin or actor in (frm, to)):
                    raise ExchangeError("Only a pending transfer can be declined by its parties")
                new, awaiting, body = "declined", None, f"{self.name(actor)} declined transfer #{tid} ({label})."
            elif action == "dispatch":
                if st != "approved" or not (admin or actor == frm):
                    raise ExchangeError("Only the donor can dispatch an approved transfer")
                eta = datetime.now() + timedelta(hours=t["hours"] or 0)
                new, awaiting = "in_transit", to
                body = f"{self.name(frm)} dispatched transfer #{tid} ({label}). ETA {eta:%H:%M}."
            elif action == "receive":
                if st != "in_transit" or not (admin or actor == to):
                    raise ExchangeError("Only the recipient can confirm receipt of an in-transit transfer")
                self._deliver(c, t)
                new, awaiting = "delivered", None
                body = f"{self.name(to)} received transfer #{tid} ({label}). Stock records updated."
            elif action == "cancel":
                if st not in ("pending", "approved") or not (admin or actor in (frm, to)):
                    raise ExchangeError("Only pending or approved transfers can be cancelled")
                new, awaiting, body = "cancelled", None, f"{self.name(actor)} cancelled transfer #{tid} ({label})."
            else:
                raise ExchangeError(f"Unknown action {action}")
            if note:
                body += f" Note: {note}"
            c.execute("UPDATE transfers SET status=?, awaiting=?, updated_at=? WHERE id=?", (new, awaiting, now(), tid))
            for party in sorted({frm, to} - {actor}):
                post_message(c, actor, party, body, "system", transfer_id=tid)
        self.e.invalidate()
        return self.transfer(tid)

    def _deliver(self, c, t):
        for a in json.loads(t["allocations"]):
            src = next(iter(rows(c, "SELECT * FROM batches WHERE batch_id=?", (a["batch_id"],))), None)
            if not src or src["qty"] < a["qty"]:
                raise ExchangeError(f"Batch {a['batch_id']} no longer has {a['qty']} units at the donor")
            c.execute("UPDATE batches SET qty=qty-? WHERE batch_id=?", (a["qty"], a["batch_id"]))
            c.execute("INSERT INTO batches (batch_id, hospital_id, medicine_id, qty, expiry_date, received_date, source) "
                      "VALUES (?,?,?,?,?,?,?)",
                      (f"{a['batch_id']}>{t['to_id']}#{t['id']}", t["to_id"], t["medicine_id"], a["qty"],
                       src["expiry_date"], TODAY.isoformat(), f"transfer #{t['id']} from {t['from_id']}"))

    # ------------------------------------------------------ offers/requests
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

    def post_offer(self, scenario, hospital, medicine, qty, batch_id=None, note=""):
        med = self.e.M[medicine]
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
                            "status, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                            (hospital, medicine, batch_id, qty, qty, expiry, note, "open", now()))
            oid = cur.lastrowid
            takers = self.suggest_takers(scenario, hospital, medicine, days_until(expiry))
            sugg = ", ".join(f"{self.name(t['hospital'])} (can use {t['can_use']:,})" for t in takers) or "none yet"
            post_message(c, hospital, "ALL",
                         f"Surplus offer #{oid}: {qty:,} {med['unit']} of {med['name']} available, expires {expiry}. "
                         f"{note} AI-matched takers: {sugg}.", "offer", offer_id=oid)
            for t in takers:
                post_message(c, "AI", t["hospital"],
                             f"{self.name(hospital)} is offering {med['name']} (offer #{oid}). Your projected unmet demand "
                             f"before it expires is {t['can_use']:,} {med['unit']}; claim it to cut your next order.",
                             "match", offer_id=oid)
        self.e.invalidate()
        return {"offer_id": oid, "suggested_takers": takers}

    def claim_offer(self, offer_id, hospital, qty):
        with session() as c:
            o = next(iter(rows(c, "SELECT * FROM offers WHERE id=?", (offer_id,))), None)
            if not o or o["status"] != "open":
                raise ExchangeError("Offer is not open")
            qty = min(int(qty), o["remaining"])
            if qty <= 0:
                raise ExchangeError("Nothing left on this offer")
            allocs = allocate(c, o["hospital_id"], o["medicine_id"], qty, self.e.hours[(o["hospital_id"], hospital)],
                              o["batch_id"])
            tid = self._create(c, o["medicine_id"], o["hospital_id"], hospital, allocs, "offer",
                               f"Claimed from surplus offer #{offer_id}.", awaiting=o["hospital_id"], initiator=hospital)
            rem = o["remaining"] - qty
            c.execute("UPDATE offers SET remaining=?, status=? WHERE id=?", (rem, "open" if rem > 0 else "claimed", offer_id))
        self.e.invalidate()
        return self.transfer(tid)

    def post_request(self, scenario, hospital, medicine, qty, needed_within_days=7, note=""):
        med = self.e.M[medicine]
        with session() as c:
            cur = c.execute("INSERT INTO requests (hospital_id, medicine_id, qty, remaining, needed_within_days, note, "
                            "status, created_at) VALUES (?,?,?,?,?,?,?,?)",
                            (hospital, medicine, qty, qty, needed_within_days, note, "open", now()))
            rid = cur.lastrowid
            donors = self.suggest_donors(scenario, hospital, medicine)
            sugg = ", ".join(f"{self.name(d['hospital'])} (spare {d['surplus']:,})" for d in donors) or "none with spare stock"
            post_message(c, hospital, "ALL",
                         f"Stock request #{rid}: {self.name(hospital)} needs {qty:,} {med['unit']} of {med['name']} "
                         f"within {needed_within_days} days. {note} AI-suggested donors: {sugg}.", "request", request_id=rid)
            for d in donors:
                post_message(c, "AI", d["hospital"],
                             f"{self.name(hospital)} needs {med['name']} (request #{rid}). You hold {d['surplus']:,} "
                             f"{med['unit']} above your own 14-day P90 demand; {d['hours']} h away.", "match", request_id=rid)
        self.e.invalidate()
        return {"request_id": rid, "suggested_donors": donors}

    def respond_request(self, request_id, donor, qty):
        with session() as c:
            r = next(iter(rows(c, "SELECT * FROM requests WHERE id=?", (request_id,))), None)
            if not r or r["status"] != "open":
                raise ExchangeError("Request is not open")
            qty = min(int(qty), r["remaining"])
            allocs = allocate(c, donor, r["medicine_id"], qty, self.e.hours[(donor, r["hospital_id"])])
            tid = self._create(c, r["medicine_id"], donor, r["hospital_id"], allocs, "request",
                               f"Response to stock request #{request_id}.", awaiting=r["hospital_id"], initiator=donor)
            rem = r["remaining"] - qty
            c.execute("UPDATE requests SET remaining=?, status=? WHERE id=?", (rem, "open" if rem > 0 else "fulfilled", request_id))
        self.e.invalidate()
        return self.transfer(tid)

    def message(self, sender, recipient, body, transfer_id=None):
        with session() as c:
            post_message(c, sender, recipient, body, "chat", transfer_id=transfer_id)
        return {"ok": True}

    # -------------------------------------------------------------- views
    def transfer(self, tid):
        with session() as c:
            t = rows(c, "SELECT * FROM transfers WHERE id=?", (tid,))[0]
            t["allocations"] = json.loads(t["allocations"] or "[]")
            t["messages"] = rows(c, "SELECT * FROM messages WHERE transfer_id=? ORDER BY id", (tid,))
        return t

    def board(self, hospital: str | None = None) -> dict:
        with session() as c:
            ts = rows(c, "SELECT * FROM transfers ORDER BY id DESC")
            offers = rows(c, "SELECT * FROM offers ORDER BY id DESC")
            reqs = rows(c, "SELECT * FROM requests ORDER BY id DESC")
            if hospital and hospital != "NET":
                msgs = rows(c, "SELECT * FROM messages WHERE recipient IN (?, 'ALL') OR sender=? ORDER BY id DESC LIMIT 200",
                            (hospital, hospital))
            else:
                msgs = rows(c, "SELECT * FROM messages ORDER BY id DESC LIMIT 200")
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
