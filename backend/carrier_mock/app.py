"""Mock courier service: a stand-in for a third-party carrier, with its own database.

It books shipments, simulates the road trip on its own clock and reports every status change to MedSupply by
webhook.  Run (from backend/):  python -m uvicorn carrier_mock.app:app --port 8001

CARRIER_TRAVEL_SECONDS is how long a trip takes in real seconds (default 30). A delay stretches it in proportion
to the booked road time, so a 2 h delay on a 1 h trip makes it three times as long.
"""
import os
import sqlite3
import threading
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent.parent
DB = os.environ.get("CARRIER_DB", str(ROOT / "carrier.db"))


def cfg(name: str, default: str) -> str:
    return os.environ.get(name, default)


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE IF NOT EXISTS shipments (tracking_id TEXT PRIMARY KEY, reference TEXT, pickup TEXT, "
                 "dropoff TEXT, plan_hours REAL, cold_chain INTEGER, units INTEGER, status TEXT, started REAL, "
                 "delay_hours REAL DEFAULT 0, progress REAL DEFAULT 0, created REAL)")
    return conn


def post_webhook(evt: dict) -> None:
    """Report an event to MedSupply. Failures are ignored: MedSupply also polls us."""
    try:
        httpx.post(cfg("MEDSUPPLY_WEBHOOK", "http://127.0.0.1:8000/api/logistics/webhook"), json=evt,
                   headers={"X-Carrier-Key": cfg("CARRIER_KEY", "carrier-demo-key")}, timeout=3)
    except httpx.HTTPError:
        pass


def emit(tracking_id: str, type_: str, note: str = "", delay_hours: float = 0) -> None:
    post_webhook({"event_id": uuid.uuid4().hex, "tracking_id": tracking_id, "type": type_, "note": note,
                  "delay_hours": delay_hours})


def tick(now: float | None = None) -> None:
    """Advance every trip on the road; announce arrival. Called once a second by the worker (or directly in tests)."""
    now = time.time() if now is None else now
    travel = float(cfg("CARRIER_TRAVEL_SECONDS", "30"))
    conn = connect()
    try:
        for s in conn.execute("SELECT * FROM shipments WHERE status='in_transit'").fetchall():
            booked = max(s["plan_hours"], 0.1)
            total = travel * (booked + s["delay_hours"]) / booked
            progress = min(1.0, (now - s["started"]) / total) if total > 0 else 1.0
            if progress >= 1.0:
                conn.execute("UPDATE shipments SET status='arrived', progress=1 WHERE tracking_id=?", (s["tracking_id"],))
                conn.commit()
                emit(s["tracking_id"], "arrived", "Vehicle reached the drop-off point")
            else:
                conn.execute("UPDATE shipments SET progress=? WHERE tracking_id=?", (round(progress, 3), s["tracking_id"]))
                conn.commit()
    finally:
        conn.close()


def worker(stop: threading.Event) -> None:
    while not stop.wait(1.0):
        try:
            tick()
        except Exception:      # keep the simulator alive
            pass


@asynccontextmanager
async def lifespan(_: FastAPI):
    connect().close()
    stop = threading.Event()
    threading.Thread(target=worker, args=(stop,), daemon=True).start()
    yield
    stop.set()


app = FastAPI(title="Mock Courier", lifespan=lifespan)


@app.middleware("http")
async def require_key(request: Request, call_next):
    if request.url.path.startswith("/shipments") and request.headers.get("X-Carrier-Key") != cfg("CARRIER_KEY", "carrier-demo-key"):
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=401, content={"detail": "bad carrier key"})
    return await call_next(request)


class Booking(BaseModel):
    reference: str
    pickup: str
    dropoff: str
    plan_hours: float
    cold_chain: bool = False
    units: int = 0


class Simulate(BaseModel):
    action: str                    # delay | breakdown | cold_breach
    hours: float = 0
    note: str = ""


def one(conn, tid: str):
    s = conn.execute("SELECT * FROM shipments WHERE tracking_id=?", (tid,)).fetchone()
    if not s:
        raise HTTPException(404, "unknown tracking id")
    return s


@app.get("/")
def status():
    conn = connect()
    try:
        return {"service": "Mock Courier", "travel_seconds": float(cfg("CARRIER_TRAVEL_SECONDS", "30")),
                "shipments": [dict(r) for r in conn.execute("SELECT * FROM shipments ORDER BY created DESC").fetchall()]}
    finally:
        conn.close()


@app.post("/shipments")
def book(body: Booking):
    tid = "CR-" + uuid.uuid4().hex[:8].upper()
    conn = connect()
    try:
        conn.execute("INSERT INTO shipments (tracking_id, reference, pickup, dropoff, plan_hours, cold_chain, units, status, created) "
                     "VALUES (?,?,?,?,?,?,?,?,?)", (tid, body.reference, body.pickup, body.dropoff, body.plan_hours,
                                                      int(body.cold_chain), body.units, "booked", time.time()))
        conn.commit()
    finally:
        conn.close()
    return {"tracking_id": tid, "status": "booked", "eta_hours": body.plan_hours}


@app.post("/shipments/{tid}/dispatch")
def dispatch(tid: str):
    conn = connect()
    try:
        s = one(conn, tid)
        if s["status"] != "booked":
            raise HTTPException(409, f"shipment is {s['status']}")
        conn.execute("UPDATE shipments SET status='in_transit', started=? WHERE tracking_id=?", (time.time(), tid))
        conn.commit()
    finally:
        conn.close()
    emit(tid, "picked_up", "Courier collected the goods")
    emit(tid, "in_transit", "On the road")
    return {"tracking_id": tid, "status": "in_transit"}


@app.get("/shipments/{tid}")
def get_shipment(tid: str):
    conn = connect()
    try:
        s = one(conn, tid)
        return {"tracking_id": tid, "status": s["status"], "progress": s["progress"],
                "eta_hours": s["plan_hours"] + s["delay_hours"], "delay_hours": s["delay_hours"]}
    finally:
        conn.close()


@app.post("/shipments/{tid}/simulate")
def simulate(tid: str, body: Simulate):
    conn = connect()
    try:
        s = one(conn, tid)
        if s["status"] != "in_transit":
            raise HTTPException(409, f"shipment is {s['status']}")
        if body.action in ("delay", "breakdown"):
            conn.execute("UPDATE shipments SET delay_hours=delay_hours+? WHERE tracking_id=?", (body.hours, tid))
            conn.commit()
            emit(tid, "delayed" if body.action == "delay" else "breakdown",
                 body.note or ("Vehicle breakdown" if body.action == "breakdown" else f"Delayed by {body.hours:g} h"), body.hours)
        elif body.action == "cold_breach":
            emit(tid, "exception", "Temperature went above 8 C: do not use without inspection", 0)
        else:
            raise HTTPException(400, "unknown action")
    finally:
        conn.close()
    return {"ok": True}
