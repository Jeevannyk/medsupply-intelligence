"""Delivery between dispatch and receipt: one shipment per transfer, carried in-house, by a courier API, or by a
district pool.

MedSupply owns what moves and the stock numbers; the carrier owns movement and ETA.  Stock changes only when the
receiver confirms with the handover code (see Exchange._deliver), never because a carrier reports "delivered".
All timestamps use a simulation clock (real time plus an offset) so a demo can fast-forward a road trip.
"""
import os
import secrets
from datetime import datetime, timedelta

import httpx

from .db import rows, session
from .optimizer import arrival_day

MODES = ("in_house", "courier", "district")
MODE_LABEL = {"in_house": "Own vehicle", "courier": "Courier", "district": "District pool"}
COLD_CHAIN = {"INSU"}                 # medicines that need a refrigerated carrier
DELAY_GRACE_H = 0.5                   # how late a trip may run before it is flagged
OVERDUE_ASSUME_H = 13                 # an overdue trip is assumed not to arrive today (the planner works in days)
EVENT_TYPES = ("picked_up", "in_transit", "delayed", "breakdown", "arrived", "exception")


def travel_seconds() -> float:
    """How long a trip takes in the demo, whatever the real road time (the real figure stays on the transfer)."""
    return float(os.environ.get("LOGISTICS_TRAVEL_SECONDS", "30"))


class LogisticsError(ValueError):
    pass


# ------------------------------------------------------------------ clock
def sim_offset(c=None) -> float:
    def read(conn):
        r = conn.execute("SELECT value FROM meta WHERE key='sim_offset_hours'").fetchone()
        return float(r[0]) if r else 0.0
    if c is not None:
        return read(c)
    with session() as conn:
        return read(conn)


def sim_now(c=None) -> datetime:
    return datetime.now() + timedelta(hours=sim_offset(c))


def stamp(c=None) -> str:
    return sim_now(c).isoformat(timespec="seconds")


def time_bucket() -> int:
    """Changes every 5 simulated minutes so cached analyses notice a trip running late."""
    return int(sim_now().timestamp() // 300)


def advance(hours: float) -> float:
    if hours <= 0 or hours > 72:
        raise LogisticsError("Advance by between 0 and 72 hours")
    with session() as c:
        new = sim_offset(c) + hours
        c.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('sim_offset_hours', ?)", (str(new),))
    return new


def parse(ts: str) -> datetime:
    return datetime.fromisoformat(ts)


# ---------------------------------------------------------------- carrier
def carrier_request(method: str, path: str, payload: dict | None = None) -> dict:
    """The only place MedSupply talks to the courier service (tests replace this function)."""
    url = os.environ.get("CARRIER_URL", "http://127.0.0.1:8001").rstrip("/") + path
    key = os.environ.get("CARRIER_KEY", "carrier-demo-key")
    try:
        r = httpx.request(method, url, json=payload, headers={"X-Carrier-Key": key}, timeout=3)
    except httpx.HTTPError as ex:
        raise LogisticsError("The courier service is not reachable. Choose another delivery mode.") from ex
    if r.status_code >= 400:
        raise LogisticsError(f"Courier refused the request ({r.status_code}). Choose another delivery mode.")
    return r.json()


# ----------------------------------------------------------------- events
def add_event(c, shipment_id: int, type_: str, source: str, note: str = "", external_id: str | None = None) -> bool:
    cur = c.execute("INSERT OR IGNORE INTO shipment_events (shipment_id, ts, type, source, note, external_id) "
                    "VALUES (?,?,?,?,?,?)", (shipment_id, stamp(c), type_, source, note, external_id))
    return cur.rowcount == 1


def shipment_for(c, transfer_id: int) -> dict | None:
    return next(iter(rows(c, "SELECT * FROM shipments WHERE transfer_id=?", (transfer_id,))), None)


def _touch(c, sid: int, **fields) -> None:
    fields["updated_at"] = stamp(c)
    c.execute(f"UPDATE shipments SET {', '.join(f'{k}=?' for k in fields)} WHERE id=?", (*fields.values(), sid))


# --------------------------------------------------------- choosing a mode
def recommend_mode(hours: float, medicine: str, qty: int) -> dict:
    reasons = []
    if medicine in COLD_CHAIN:
        mode = "courier"
        reasons.append("needs a refrigerated carrier (cold chain)")
    elif hours > 2 or qty > 3000:
        mode = "courier"
        reasons.append(f"{hours:g} h road trip" if hours > 2 else f"{qty:,} units is more than one van carries")
    else:
        mode = "in_house"
        reasons.append(f"short {hours:g} h trip, donor's own vehicle is quickest")
    return {"mode": mode, "reasons": reasons,
            "alternatives": [{"mode": m, "label": MODE_LABEL[m]} for m in MODES if m != mode],
            "note": "District pool is for when neither a vehicle nor a courier is available."}


def arrange(c, t: dict, mode: str, vehicle: str, driver: str, from_name: str, to_name: str) -> dict:
    """The donor picks how an approved transfer will travel. Can be changed until it is dispatched."""
    if mode not in MODES:
        raise LogisticsError(f"Delivery mode must be one of {list(MODES)}")
    vehicle, driver = (vehicle or "").strip(), (driver or "").strip()
    if mode == "in_house" and not (vehicle and driver):
        raise LogisticsError("Enter the vehicle and driver for your own delivery")
    old = shipment_for(c, t["id"])
    if old and old["status"] not in ("planned", "requested", "assigned"):
        raise LogisticsError("This shipment is already under way")
    fields = dict(mode=mode, carrier=None, tracking_id=None, vehicle=None, driver=None, status="planned",
                  cold_chain=int(t["medicine_id"] in COLD_CHAIN), planned_hours=float(t["hours"] or 0))
    note = f"Delivery arranged: {MODE_LABEL[mode]}"
    if mode == "in_house":
        fields.update(vehicle=vehicle, driver=driver)
        note += f", vehicle {vehicle}, driver {driver}"
    elif mode == "courier":
        booked = carrier_request("POST", "/shipments", {
            "reference": f"transfer-{t['id']}", "pickup": from_name, "dropoff": to_name,
            "plan_hours": float(t["hours"] or 0), "cold_chain": bool(fields["cold_chain"]), "units": int(t["qty"])})
        fields.update(carrier="Mock Courier", tracking_id=booked["tracking_id"])
        note += f", tracking {booked['tracking_id']}"
    else:
        fields.update(status="requested")
        note += ": waiting for the district office to assign a vehicle"
    if old:
        _touch(c, old["id"], **fields)
        sid = old["id"]
    else:
        c.execute("INSERT INTO shipments (transfer_id, created_at, updated_at) VALUES (?,?,?)", (t["id"], stamp(c), stamp(c)))
        sid = c.execute("SELECT id FROM shipments WHERE transfer_id=?", (t["id"],)).fetchone()[0]
        _touch(c, sid, **fields)
    add_event(c, sid, "planned", "donor", note)
    return next(iter(rows(c, "SELECT * FROM shipments WHERE id=?", (sid,))))


def assign_district(c, sid: int, vehicle: str, driver: str) -> dict:
    s = next(iter(rows(c, "SELECT * FROM shipments WHERE id=?", (sid,))), None)
    if not s or s["mode"] != "district" or s["status"] != "requested":
        raise LogisticsError("Not a district request waiting for a vehicle")
    vehicle, driver = (vehicle or "").strip(), (driver or "").strip()
    if not (vehicle and driver):
        raise LogisticsError("Enter the vehicle and driver to assign")
    _touch(c, sid, vehicle=vehicle, driver=driver, status="assigned")
    add_event(c, sid, "assigned", "district", f"Vehicle {vehicle}, driver {driver} assigned")
    return next(iter(rows(c, "SELECT * FROM shipments WHERE id=?", (sid,))))


# ----------------------------------------------------------- dispatch / en route
def describe(s: dict) -> str:
    if s["mode"] == "courier":
        return f"courier {s['carrier']}, tracking {s['tracking_id']}"
    who = "district vehicle" if s["mode"] == "district" else "own vehicle"
    return f"{who} {s['vehicle']} (driver {s['driver']})"


def dispatch(c, t: dict, from_name: str, to_name: str) -> dict:
    """The donor hands the goods over. Creates a plain own-vehicle shipment if none was arranged."""
    s = shipment_for(c, t["id"])
    if s is None:
        s = arrange(c, t, "in_house", "unspecified vehicle", "not recorded", from_name, to_name)
    if s["status"] == "requested":
        raise LogisticsError("The district office has not assigned a vehicle yet")
    if s["status"] not in ("planned", "assigned"):
        raise LogisticsError("This shipment cannot be dispatched in its current state")
    now = sim_now(c)
    eta = now + timedelta(seconds=travel_seconds())
    if s["mode"] == "courier":
        carrier_request("POST", f"/shipments/{s['tracking_id']}/dispatch")
    _touch(c, s["id"], status="in_transit", dispatched_at=now.isoformat(timespec="seconds"), moved_at=now.isoformat(timespec="seconds"),
           eta_at=eta.isoformat(timespec="seconds"), handover_code=f"{secrets.randbelow(10**6):06d}", progress=0.0)
    add_event(c, s["id"], "picked_up", "donor", f"Dispatched with {describe(s)}")
    return next(iter(rows(c, "SELECT * FROM shipments WHERE id=?", (s["id"],))))


def apply_event(c, evt: dict) -> dict:
    """A courier webhook. Idempotent: the same event_id is applied once."""
    if evt.get("type") not in EVENT_TYPES:
        raise LogisticsError(f"Unknown event type {evt.get('type')}")
    s = next(iter(rows(c, "SELECT * FROM shipments WHERE tracking_id=?", (evt.get("tracking_id"),))), None)
    if not s:
        raise LogisticsError("Unknown tracking id")
    if not add_event(c, s["id"], evt["type"], "carrier", evt.get("note", ""), evt.get("event_id")):
        return {"duplicate": True, "shipment_id": s["id"]}
    kind = evt["type"]
    if kind in ("delayed", "breakdown", "exception") and s["status"] == "in_transit" and not at_door(s):
        _rebase(c, s, float(evt.get("delay_hours") or 0))
    elif kind == "arrived" and s["status"] == "in_transit":
        _touch(c, s["id"], status="arrived", arrived_at=stamp(c), progress=1.0)
    return {"duplicate": False, "shipment_id": s["id"]}


def simulate_delay(c, sid: int, hours: float, reason: str = "") -> dict:
    """Demo control: the trip runs late. A courier is told to slow down and reports it back by webhook."""
    s = next(iter(rows(c, "SELECT * FROM shipments WHERE id=?", (sid,))), None)
    if not s or s["status"] != "in_transit":
        raise LogisticsError("Only a shipment on the road can be delayed")
    if not 0 < hours <= 72:
        raise LogisticsError("Delay by between 0 and 72 hours")
    if at_door(s):
        raise LogisticsError("The vehicle has already reached its destination")
    if s["mode"] == "courier":
        carrier_request("POST", f"/shipments/{s['tracking_id']}/simulate",
                        {"action": "delay", "hours": hours, "note": reason or f"Delayed by {hours:g} h"})
    else:
        eta = _rebase(c, s, hours)
        add_event(c, sid, "delayed", "system", reason or f"Delayed by {hours:g} h, new ETA {eta:%H:%M}")
    return next(iter(rows(c, "SELECT * FROM shipments WHERE id=?", (sid,))))


def refresh() -> bool:
    """Lazy monitor: flag own-vehicle and district trips that have not arrived by their ETA."""
    changed = False
    with session() as c:
        now = sim_now(c)
        for s in rows(c, "SELECT * FROM shipments WHERE status='in_transit' AND mode!='courier' AND delayed=0"):
            eta = parse(s["eta_at"])
            if now > eta + timedelta(hours=DELAY_GRACE_H):
                _touch(c, s["id"], delayed=1)
                add_event(c, s["id"], "delayed", "system", f"Not arrived by ETA {eta:%H:%M}")
                changed = True
    return changed


def sync_couriers() -> bool:
    """Best-effort poll of the courier for progress, and for an 'arrived' whose webhook was missed."""
    changed = False
    with session() as c:
        for s in rows(c, "SELECT * FROM shipments WHERE status='in_transit' AND mode='courier'"):
            try:
                remote = carrier_request("GET", f"/shipments/{s['tracking_id']}")
            except LogisticsError:
                continue
            if remote.get("status") == "arrived":
                if add_event(c, s["id"], "arrived", "carrier", "Reported by courier poll", f"poll-arrived-{s['id']}"):
                    _touch(c, s["id"], status="arrived", arrived_at=stamp(c), progress=1.0)
                    changed = True
    return changed


def remaining_seconds(s: dict, now: datetime | None = None) -> float:
    return max(0.0, (parse(s["eta_at"]) - (now or sim_now())).total_seconds())


def remaining_hours(s: dict, now: datetime | None = None) -> float:
    return remaining_seconds(s, now) / 3600


def at_door(s: dict) -> bool:
    """The vehicle has reached the destination: the receiver may now confirm."""
    if s["status"] == "arrived":
        return True
    return s["status"] == "in_transit" and bool(s["eta_at"]) and remaining_seconds(s) <= 0


def position(s: dict, now: datetime | None = None) -> float:
    """How far along the route the vehicle is (0..1). A delay slows it down from where it is; it never jumps back."""
    if s["status"] in ("arrived", "delivered"):
        return 1.0
    if s["status"] != "in_transit":
        return 0.0
    now = now or sim_now()
    p0 = float(s["progress"] or 0)
    t0 = parse(s["moved_at"] or s["dispatched_at"])
    span = (parse(s["eta_at"]) - t0).total_seconds()
    if span <= 0:
        return 1.0
    return round(p0 + (1 - p0) * min(1.0, max(0.0, (now - t0).total_seconds() / span)), 4)


def _rebase(c, s: dict, hours: float) -> datetime:
    """Start a new leg from the current position with the ETA pushed out by `hours`."""
    now = sim_now(c)
    eta = parse(s["eta_at"]) + timedelta(hours=hours)
    _touch(c, s["id"], delayed=1, progress=position(s, now), moved_at=now.isoformat(timespec="seconds"),
           eta_at=eta.isoformat(timespec="seconds"))
    return eta


def engine_arrival_day(s: dict) -> int | None:
    """Day the planner should expect this shipment to land; None = not on the road yet."""
    if s["status"] == "arrived":
        return 0
    if s["status"] != "in_transit":
        return None
    rem = remaining_hours(s)
    if s["delayed"] and rem <= 0:
        rem = OVERDUE_ASSUME_H
    return arrival_day(rem)


def public(c, s: dict | None, donor_view: bool) -> dict | None:
    if s is None:
        return None
    d = dict(s)
    d["events"] = rows(c, "SELECT * FROM shipment_events WHERE shipment_id=? ORDER BY id", (s["id"],))
    d["progress"] = position(s)
    d["remaining_seconds"] = round(remaining_seconds(s), 1) if s["status"] == "in_transit" else None
    d["remaining_hours"] = round(remaining_hours(s), 2) if s["status"] == "in_transit" else None
    d["at_door"] = at_door(s)
    d["mode_label"] = MODE_LABEL.get(s["mode"], s["mode"])
    if not donor_view or s["status"] in ("delivered", "cancelled"):
        d["handover_code"] = None
    return d


# ------------------------------------------------------------------ receipt
def check_receipt(s: dict | None, t: dict, code: str | None, received_qty: int | None, condition: str):
    """Validate the handover and work out the discrepancy. Returns (accepted, missing, condition, resolution)."""
    if s is not None and s["status"] in ("in_transit", "arrived") and not at_door(s):
        raise LogisticsError(f"The vehicle has not arrived yet: about {int(remaining_seconds(s)) + 1} s to go.")
    if s is not None and s["handover_code"] and (code or "").strip() != s["handover_code"]:
        raise LogisticsError("Wrong handover code. Ask the donor's driver for the 6-digit code.")
    qty = int(t["qty"]) if received_qty is None else int(received_qty)
    if qty < 0 or qty > int(t["qty"]):
        raise LogisticsError(f"Received quantity must be between 0 and {int(t['qty']):,}")
    missing = int(t["qty"]) - qty
    if missing == 0:
        return qty, 0, "ok", None
    cond = condition if condition in ("short", "damaged") else "short"
    return qty, missing, cond, ("written_off" if cond == "damaged" else "returned_to_donor")


def close(c, t: dict, s: dict | None, accepted: int, missing: int, cond: str, resolution: str | None,
          note: str, actor: str) -> None:
    if s is None:
        return
    _touch(c, s["id"], status="delivered", delivered_at=stamp(c), received_qty=accepted, condition=cond,
           receipt_note=note or None, progress=1.0)
    add_event(c, s["id"], "delivered", actor, f"Receipt confirmed: {accepted:,} of {int(t['qty']):,} accepted")
    if missing:
        c.execute("INSERT INTO discrepancies (transfer_id, shipment_id, medicine_id, expected, received, missing, "
                  "condition, resolution, note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                  (t["id"], s["id"], t["medicine_id"], int(t["qty"]), accepted, missing, cond, resolution, note, stamp(c)))
        add_event(c, s["id"], "exception", actor, f"{missing:,} units {cond}: {resolution.replace('_', ' ')}")


def cancel(c, t: dict) -> None:
    s = shipment_for(c, t["id"])
    if s and s["status"] in ("planned", "requested", "assigned"):
        _touch(c, s["id"], status="cancelled")
        add_event(c, s["id"], "cancelled", "system", "Transfer cancelled")
