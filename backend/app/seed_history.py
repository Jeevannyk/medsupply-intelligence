"""Past deliveries, so the Logistics page has a delivery log from the first start.

These are finished transfers (delivered, or cancelled) with their shipments, event trails and receipt discrepancies, dated
in the last few days. They never touch stock (the batches already reflect them) and never show on the map or in the plan.
Seeded once per database (meta flag); set MEDSUPPLY_SEED_HISTORY=0 to skip it, as the tests do.
"""
import json
import os
from datetime import date, datetime, timedelta

from .config import TODAY
from .db import session

# (donor, receiver, medicine, qty, mode, vehicle or carrier, driver, hours ago it was dispatched, outcome, extra delay hours)
# outcome: ok | short:N | damaged:N | cancelled
HISTORY = [
    ("B", "E", "OSEL", 400, "courier", "CR-7F2A91C4", "", 58, "ok", 0),
    ("C", "A", "CEFT", 220, "in_house", "KA-19-AB-4721", "Ravi Shetty", 51, "ok", 0),
    ("G", "H", "ORS", 600, "district", "DK-01-G-77", "Suresh Poojary", 44, "ok", 0),
    ("A", "F", "INSU", 80, "courier", "CR-3B90D1E7", "", 37, "short:10", 0),
    ("H", "E", "AMOX", 300, "in_house", "KA-21-MN-9032", "Imran Khan", 29, "ok", 1.5),
    ("F", "D", "SALB", 150, "in_house", "KA-19-CD-1180", "Lokesh Gowda", 22, "damaged:12", 0),
    ("B", "C", "ORS", 500, "courier", "CR-A41C66F0", "", 15, "ok", 0),
    ("D", "G", "CEFT", 90, "district", "", "", 9, "cancelled", 0),
]
COURIER, DISTRICT_LABEL = "Mock Courier", "District pool"
MODE_LABEL = {"in_house": "Own vehicle", "courier": "Courier", "district": DISTRICT_LABEL}


def seed_history_once() -> bool:
    if os.environ.get("MEDSUPPLY_SEED_HISTORY", "1") == "0":
        return False
    with session() as c:
        if c.execute("SELECT 1 FROM meta WHERE key='history_seeded'").fetchone():
            return False
        now = datetime.now().replace(microsecond=0)
        iso = lambda d: d.isoformat(timespec="seconds")                      # noqa: E731
        for donor, recv, med, qty, mode, vehicle, driver, ago, outcome, extra in HISTORY:
            hours = (c.execute("SELECT hours FROM transport WHERE from_id=? AND to_id=?", (donor, recv)).fetchone() or [1.0])[0]
            b = c.execute("SELECT batch_id, expiry_date FROM batches WHERE hospital_id=? AND medicine_id=? ORDER BY expiry_date LIMIT 1",
                          (donor, med)).fetchone()
            alloc = [{"batch_id": b[0] if b else f"{med}-{donor}-01", "qty": qty,
                      "expires_in_days": (date.fromisoformat(b[1]) - TODAY).days if b else 180}]
            created = now - timedelta(hours=ago + 3)
            planned = now - timedelta(hours=ago + 1)
            cancelled = outcome == "cancelled"
            status = "cancelled" if cancelled else "delivered"
            done = created + timedelta(hours=3 + hours + extra + 0.4)
            cur = c.execute(
                "INSERT INTO transfers (medicine_id, from_id, to_id, qty, allocations, status, awaiting, origin, reason, hours, created_at, updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (med, donor, recv, qty, json.dumps(alloc), status, None, "offer" if mode == "courier" else "request",
                 f"Past transfer: {recv} was short of {med} and {donor} had stock to spare.", hours, iso(created), iso(done if not cancelled else planned)))
            tid = cur.lastrowid

            events: list[tuple[datetime, str, str, str]] = []
            accepted, cond, resolution, delivered = qty, "ok", None, done
            if mode == "courier":
                note = f"Delivery arranged: Courier, tracking {vehicle}"
            elif mode == "district":
                note = "Delivery arranged: District pool: waiting for the district office to assign a vehicle"
            else:
                note = f"Delivery arranged: Own vehicle, vehicle {vehicle}, driver {driver}"
            events.append((planned, "planned", "donor", note))
            if cancelled:
                events.append((planned + timedelta(minutes=35), "cancelled", "system", "Transfer cancelled"))
                c.execute("INSERT INTO shipments (transfer_id, mode, status, carrier, tracking_id, vehicle, driver, cold_chain, planned_hours, progress, "
                          "created_at, updated_at, moved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                          (tid, mode, "cancelled", None, None, None, None, 0, hours, 0, iso(planned), iso(planned), None))
            else:
                dispatched = planned + timedelta(minutes=50)
                eta = dispatched + timedelta(hours=hours + extra)
                arrived = eta + timedelta(minutes=4)
                delivered = arrived + timedelta(minutes=12)
                if outcome.startswith(("short", "damaged")):
                    kind, n = outcome.split(":")
                    accepted, cond = qty - int(n), kind
                    resolution = "written_off" if kind == "damaged" else "returned_to_donor"
                if mode == "district":
                    events.append((planned + timedelta(minutes=20), "assigned", "district", f"Vehicle {vehicle}, driver {driver} assigned"))
                events.append((dispatched, "picked_up", "carrier" if mode == "courier" else "donor",
                               "Courier collected the goods" if mode == "courier" else f"Dispatched with {'district vehicle' if mode == 'district' else 'own vehicle'} {vehicle} (driver {driver})"))
                if extra:
                    events.append((dispatched + timedelta(hours=hours * 0.6), "delayed", "carrier" if mode == "courier" else "system",
                                   f"Delayed by {extra:g} h, new ETA {eta:%H:%M}"))
                events.append((arrived, "arrived", "carrier" if mode == "courier" else recv, "Vehicle reached the drop-off point"))
                events.append((delivered, "delivered", recv, f"Receipt confirmed: {accepted:,} of {qty:,} accepted"))
                if resolution:
                    events.append((delivered, "exception", recv, f"{qty - accepted:,} units {cond}: {resolution.replace('_', ' ')}"))
                c.execute("INSERT INTO shipments (transfer_id, mode, status, carrier, tracking_id, vehicle, driver, cold_chain, planned_hours, dispatched_at, "
                          "eta_at, arrived_at, delivered_at, progress, delayed, received_qty, condition, created_at, updated_at, moved_at) "
                          "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                          (tid, mode, "delivered", COURIER if mode == "courier" else None, vehicle if mode == "courier" else None,
                           None if mode == "courier" else vehicle, None if mode == "courier" else driver, int(med == "INSU"), hours,
                           iso(dispatched), iso(eta), iso(arrived), iso(delivered), 1.0, int(bool(extra)), accepted, cond, iso(planned), iso(delivered), iso(dispatched)))
            sid = c.execute("SELECT id FROM shipments WHERE transfer_id=?", (tid,)).fetchone()[0]
            if resolution:
                c.execute("INSERT INTO discrepancies (transfer_id, shipment_id, medicine_id, expected, received, missing, condition, resolution, note, created_at) "
                          "VALUES (?,?,?,?,?,?,?,?,?,?)", (tid, sid, med, qty, accepted, qty - accepted, cond, resolution, "", iso(delivered)))
            for ts, kind, source, text in events:
                c.execute("INSERT INTO shipment_events (shipment_id, ts, type, source, note, external_id) VALUES (?,?,?,?,?,NULL)",
                          (sid, iso(ts), kind, source, text))
        c.execute("INSERT INTO meta (key, value) VALUES ('history_seeded', '1')")
    return True
