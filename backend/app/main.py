"""FastAPI service.  Run:  uvicorn app.main:app --reload --port 8000"""
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import json
import os

from . import generate, logistics, stock_import
from .assistant import Assistant
from .config import DB_PATH, DEFAULT_WEIGHTS, SCENARIOS, TODAY
from .db import ensure_schema
from .engine import Engine
from .exchange import Exchange, ExchangeError
from .logistics import LogisticsError
from .seed_history import seed_history_once

if not DB_PATH.exists():
    generate.generate()
ensure_schema()
seed_history_once()          # a few past deliveries so the Logistics log is not empty on a fresh start

engine = Engine()
exchange = Exchange(engine)
assistant = Assistant(engine)

app = FastAPI(title="Medical Supply Intelligence API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.exception_handler(ExchangeError)
def exchange_error(_: Request, exc: ExchangeError):
    return JSONResponse(status_code=400, content={"detail": str(exc)})


@app.exception_handler(LogisticsError)
def logistics_error(_: Request, exc: LogisticsError):
    return JSONResponse(status_code=400, content={"detail": str(exc)})


def clean(obj):
    """Drop internal keys (prefixed with _) before serialising."""
    if isinstance(obj, dict):
        return {k: clean(v) for k, v in obj.items() if not str(k).startswith("_")}
    if isinstance(obj, list):
        return [clean(v) for v in obj]
    return obj


def weights_from(request: Request) -> dict:
    w = {}
    for k in DEFAULT_WEIGHTS:
        v = request.query_params.get(f"w_{k}")
        if v is not None:
            w[k] = max(0.0, float(v))
    return w


def check_scenario(s: str) -> str:
    if s not in SCENARIOS:
        raise HTTPException(400, f"scenario must be one of {list(SCENARIOS)}")
    return s


@app.get("/api/meta")
def meta():
    return {"today": TODAY.isoformat(), "scenarios": SCENARIOS, "hospitals": engine.hospitals,
            "medicines": engine.medicines, "default_weights": DEFAULT_WEIGHTS, "meta": engine.meta,
            "transport": [{"from": a, "to": b, "hours": h, "km": engine.km[(a, b)]}
                          for (a, b), h in engine.hours.items() if a < b]}


@app.get("/api/overview")
def overview(request: Request, scenario: str = "outbreak"):
    return clean(engine.analysis(check_scenario(scenario), weights_from(request)))


@app.get("/api/forecast")
def forecast(scenario: str = "outbreak", medicine: str = "OSEL", hospital: str = "ALL"):
    if medicine not in engine.M or (hospital != "ALL" and hospital not in engine.H):
        raise HTTPException(404, "unknown medicine or hospital")
    return engine.series(check_scenario(scenario), medicine, hospital)


@app.get("/api/hospital/{hospital}")
def hospital(hospital: str, request: Request, scenario: str = "outbreak"):
    if hospital not in engine.H:
        raise HTTPException(404, "unknown hospital")
    d = engine.hospital_detail(check_scenario(scenario), hospital, weights_from(request))
    d["exchange"] = exchange.board(hospital)
    return clean(d)


class StockImport(BaseModel):
    csv: str                      # the file's text
    actor: str                    # who is importing: a hospital id (own rows only) or NET (any)
    apply: bool = False           # False = check and preview only, True = replace the stock


@app.get("/api/import/stock/export")
def export_stock():
    """The current stock as a CSV, in exactly the format the import accepts (the template)."""
    return Response(stock_import.export_csv(), media_type="text/csv",
                    headers={"Content-Disposition": 'attachment; filename="current_stock.csv"'})


@app.post("/api/import/stock")
def import_stock(body: StockImport):
    """Replace a hospital's stock with the batches in a CSV. Always validates the whole file first; changes nothing unless apply=true."""
    result = stock_import.run(body.csv, body.actor, set(engine.H), set(engine.M), body.apply)
    if result["applied"]:
        engine.invalidate()       # stock changed: recompute risk, plan and orders
    return result


@app.get("/api/road-paths")
def road_paths():
    """Real driving routes between hospital pairs ("A-B" with A before B, as [lat, lon] points) for the delivery map."""
    f = Path(__file__).resolve().parent / "data" / "road_paths.json"
    return json.loads(f.read_text(encoding="utf-8")) if f.is_file() else {"source": "none", "paths": {}}


@app.get("/api/medicines/{medicine}")
def medicine_detail(medicine: str, scenario: str = "outbreak"):
    if medicine not in engine.M:
        raise HTTPException(404, "unknown medicine")
    return clean(engine.medicine_detail(check_scenario(scenario), medicine))


@app.get("/api/judge")
def judge(scenario: str = "outbreak"):
    return clean(engine.judge(check_scenario(scenario)))


@app.get("/api/compare")
def compare(request: Request):
    w = weights_from(request)
    return {s: clean(engine.analysis(s, w)["outcome"]) | {"kpis": engine.analysis(s, w)["kpis"]} for s in SCENARIOS}


# ------------------------------------------------------------------ exchange
class SendPlan(BaseModel):
    scenario: str = "outbreak"
    move_ids: list[str] | None = None
    weights: dict | None = None


class Action(BaseModel):
    action: str
    actor: str
    note: str = ""
    code: str | None = None             # receive: the donor's handover code
    received_qty: int | None = None     # receive: units accepted into stock (default: all)
    condition: str = "ok"               # receive: ok | short | damaged


class Delivery(BaseModel):
    actor: str
    mode: str                           # in_house | courier | district
    vehicle: str = ""
    driver: str = ""


class Assign(BaseModel):
    actor: str
    vehicle: str
    driver: str


class CarrierEvent(BaseModel):
    event_id: str
    tracking_id: str
    type: str
    note: str = ""
    delay_hours: float = 0


class Advance(BaseModel):
    hours: float


class Delay(BaseModel):
    hours: float
    reason: str = ""


class Offer(BaseModel):
    hospital: str
    medicine: str
    qty: int
    batch_id: str | None = None
    note: str = ""
    target: str | None = None      # None = broadcast to every hospital
    scenario: str = "outbreak"


class Claim(BaseModel):
    hospital: str
    qty: int


class StockRequest(BaseModel):
    hospital: str
    medicine: str
    qty: int
    needed_within_days: int = 7
    note: str = ""
    target: str | None = None      # None = broadcast to every hospital
    scenario: str = "outbreak"


class Respond(BaseModel):
    donor: str
    qty: int


class Who(BaseModel):
    hospital: str


class Message(BaseModel):
    sender: str
    recipient: str = "ALL"
    body: str
    transfer_id: int | None = None


class Question(BaseModel):
    question: str
    scenario: str = "outbreak"


class ForecastAnalysis(BaseModel):
    medicine: str
    hospital: str = "ALL"
    scenario: str = "outbreak"


@app.get("/api/exchange")
def board(hospital: str | None = Query(None)):
    return exchange.board(hospital)


@app.post("/api/exchange/send-plan")
def send_plan(body: SendPlan):
    return {"transfer_ids": exchange.send_plan(check_scenario(body.scenario), body.weights, body.move_ids)}


@app.post("/api/transfers/{tid}/action")
def act(tid: int, body: Action):
    return exchange.act(tid, body.action, body.actor, body.note, body.code, body.received_qty, body.condition)


# ---------------------------------------------------------------- logistics
@app.get("/api/transfers/{tid}/delivery-options")
def delivery_options(tid: int):
    return exchange.recommend_delivery(tid)


@app.post("/api/transfers/{tid}/delivery")
def arrange_delivery(tid: int, body: Delivery):
    return exchange.arrange_delivery(tid, body.actor, body.mode, body.vehicle, body.driver)


@app.get("/api/logistics")
def logistics_board(viewer: str | None = Query(None)):
    return exchange.logistics_board(viewer)


@app.post("/api/logistics/shipments/{sid}/assign")
def assign_vehicle(sid: int, body: Assign):
    return exchange.assign_vehicle(sid, body.actor, body.vehicle, body.driver)


@app.post("/api/logistics/shipments/{sid}/delay")
def simulate_delay(sid: int, body: Delay):
    return exchange.simulate_delay(sid, body.hours, body.reason)


@app.post("/api/logistics/sim/advance")
def advance_clock(body: Advance):
    now = logistics.advance(body.hours)
    engine.invalidate()
    return {"sim_offset_hours": now}


@app.post("/api/logistics/webhook")
def carrier_webhook(body: CarrierEvent, request: Request):
    if request.headers.get("X-Carrier-Key") != os.environ.get("CARRIER_KEY", "carrier-demo-key"):
        raise HTTPException(401, "bad carrier key")
    return exchange.webhook(body.model_dump())


@app.post("/api/offers")
def post_offer(body: Offer):
    return exchange.post_offer(check_scenario(body.scenario), body.hospital, body.medicine, body.qty,
                               body.batch_id, body.note, body.target)


@app.post("/api/offers/{oid}/claim")
def claim(oid: int, body: Claim):
    return exchange.claim_offer(oid, body.hospital, body.qty)


@app.post("/api/requests")
def post_request(body: StockRequest):
    return exchange.post_request(check_scenario(body.scenario), body.hospital, body.medicine, body.qty,
                                 body.needed_within_days, body.note, body.target)


@app.post("/api/requests/{rid}/respond")
def respond(rid: int, body: Respond):
    return exchange.respond_request(rid, body.donor, body.qty)


@app.post("/api/offers/{oid}/decline")
def decline_offer(oid: int, body: Who):
    return exchange.decline("offers", oid, body.hospital)


@app.post("/api/offers/{oid}/withdraw")
def withdraw_offer(oid: int, body: Who):
    return exchange.withdraw("offers", oid, body.hospital)


@app.post("/api/requests/{rid}/decline")
def decline_request(rid: int, body: Who):
    return exchange.decline("requests", rid, body.hospital)


@app.post("/api/requests/{rid}/withdraw")
def withdraw_request(rid: int, body: Who):
    return exchange.withdraw("requests", rid, body.hospital)


@app.post("/api/messages")
def message(body: Message):
    return exchange.message(body.sender, body.recipient, body.body, body.transfer_id)


@app.post("/api/assistant")
def ask(body: Question):
    return clean(assistant.ask(body.question, check_scenario(body.scenario)))


@app.post("/api/analyze/forecast")
def analyze_forecast(body: ForecastAnalysis):
    """Plain-language reading of the demand chart currently on screen (AI if Gemini is configured in .env)."""
    if body.medicine not in engine.M or (body.hospital != "ALL" and body.hospital not in engine.H):
        raise HTTPException(404, "unknown medicine or hospital")
    return clean(assistant.analyze_forecast(check_scenario(body.scenario), body.medicine, body.hospital))


@app.post("/api/reset")
def reset():
    generate.generate()
    seed_history_once()
    engine.load_static()
    return {"ok": True}


# Serve the built React app if present (single-process demo).
DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{path:path}")
    def spa(path: str):
        f = DIST / path
        return FileResponse(f if path and f.is_file() else DIST / "index.html")
