import pytest
from fastapi.testclient import TestClient

from app import generate
from app.config import DB_PATH


@pytest.fixture(scope="module")
def client():
    generate.generate(DB_PATH)
    from app.main import app, engine
    engine.load_static()
    with TestClient(app) as c:
        yield c


def test_judge_scenario_numbers_add_up(client):
    j = client.get("/api/judge").json()
    assert j["stock_total"] == 20000
    assert j["weekly_demand"] == [2000, 2875, 3750, 4625, 5500]
    assert j["totals"]["before"] == j["totals"]["after"] == 20000
    assert j["passed"], [c for c in j["checks"] if not c["passed"]]
    for row in j["ledger"]:
        assert row["before"] - row["out"] + row["in"] == row["after"]
    assert j["moves"], "the misallocated 20,000 units should trigger transfers"


def test_plan_verified_and_conserved_for_every_medicine(client):
    for scenario in ("outbreak", "normal"):
        a = client.get("/api/overview", params={"scenario": scenario}).json()
        assert a["verification"]["passed"], [c for c in a["verification"]["checks"] if not c["passed"]]
        for t in a["verification"]["totals"]:
            assert t["before"] == t["after"]
        for mv in a["plan"]["moves"]:
            assert mv["qty"] == sum(x["qty"] for x in mv["allocations"])
            assert all(x["expires_in_days"] - mv["arrival_day"] >= 2 for x in mv["allocations"])


def test_forecast_beats_naive_and_detects_outbreak(client):
    a = client.get("/api/overview").json()
    osel = a["metrics"]["network_by_medicine"]["OSEL"]
    assert osel["gbm_outbreak_adjusted"]["wape"] < osel["seasonal_naive"]["wape"]
    assert any(s["medicine"] == "OSEL" for s in a["spikes"])
    assert not client.get("/api/overview", params={"scenario": "normal"}).json()["spikes"]


def test_system_reduces_stockouts_and_waste(client):
    o = client.get("/api/overview").json()["outcome"]
    assert o["with"]["unmet_units"] < o["without"]["unmet_units"]
    assert o["with"]["waste"] < o["without"]["waste"]


def test_warning_text_mentions_days_and_lead_time(client):
    w = client.get("/api/overview").json()["warnings"][0]
    assert "runs out" in w["message"] and "lead time" in w["message"]


def test_transfer_lifecycle_moves_stock_and_conserves_units(client):
    before = client.get("/api/judge").json()["stock_total"]
    ids = client.post("/api/exchange/send-plan", json={"scenario": "outbreak"}).json()["transfer_ids"]
    assert ids
    t = client.get("/api/exchange").json()["transfers"]
    first = next(x for x in t if x["id"] == ids[0])
    assert first["status"] == "pending" and first["awaiting"] == first["from_id"]
    # wrong party cannot approve
    assert client.post(f"/api/transfers/{first['id']}/action", json={"action": "approve", "actor": first["to_id"]}).status_code == 400
    for action, actor in (("approve", first["from_id"]), ("dispatch", first["from_id"]), ("receive", first["to_id"])):
        r = client.post(f"/api/transfers/{first['id']}/action", json={"action": action, "actor": actor})
        assert r.status_code == 200, r.text
    done = r.json()
    assert done["status"] == "delivered" and len(done["messages"]) >= 4
    a = client.get("/api/overview").json()
    for t in a["verification"]["totals"]:
        assert t["before"] == t["after"]
    assert client.get("/api/judge").json()["stock_total"] == before
    # plan already sent -> engine should not re-propose the same moves
    assert len(a["plan"]["moves"]) < len(ids)


def test_offer_broadcast_and_claim(client):
    r = client.post("/api/offers", json={"hospital": "F", "medicine": "ORS", "qty": 300, "batch_id": "ORS-F-02",
                                         "note": "expiring soon"}).json()
    assert r["offer_id"]
    taker = (r["suggested_takers"] or [{"hospital": "A"}])[0]["hospital"]
    t = client.post(f"/api/offers/{r['offer_id']}/claim", json={"hospital": taker, "qty": 100}).json()
    assert t["status"] == "approved" and t["awaiting"] == "F" and t["qty"] == 100   # agreed; F dispatches next
    board = client.get("/api/exchange", params={"hospital": taker}).json()
    assert any(m["offer_id"] == r["offer_id"] for m in board["messages"])


def test_request_and_response(client):
    r = client.post("/api/requests", json={"hospital": "E", "medicine": "CEFT", "qty": 50}).json()
    donor = (r["suggested_donors"] or [{"hospital": "B"}])[0]["hospital"]
    t = client.post(f"/api/requests/{r['request_id']}/respond", json={"donor": donor, "qty": 20}).json()
    assert t["status"] == "approved" and t["awaiting"] == donor and t["from_id"] == donor


def test_assistant_is_grounded(client):
    a = client.post("/api/assistant", json={"question": "Which hospitals are at highest shortage risk next week?"}).json()
    assert a["mode"] == "rules" and a["tools"][0]["name"] == "shortage_risks"
    for risk in a["tools"][0]["result"]["risks"][:3]:
        assert risk["warning"] in a["answer"]
    p = client.post("/api/assistant", json={"question": "Who should get ceftriaxone first?"}).json()
    assert p["tools"][0]["name"] == "priority_ranking"


def test_forecast_analysis_describes_current_chart(client):
    chart = client.get("/api/forecast", params={"medicine": "CEFT", "hospital": "A"}).json()
    a = client.post("/api/analyze/forecast", json={"medicine": "CEFT", "hospital": "A"}).json()
    assert a["mode"] == "rules"                       # tests never call Gemini
    for label in ("What happened", "What to expect", "What to do"):
        assert label in a["analysis"]
    assert "How sure" not in a["analysis"]
    assert f"{chart['next_14d']:,}" in a["analysis"]  # the number on the chart is the number in the text
    risk = next(c for c in client.get("/api/overview").json()["cells"] if c["hospital"] == "A" and c["medicine"] == "CEFT")
    assert str(int(risk["days_to_stockout"])) in a["analysis"]
    assert client.post("/api/analyze/forecast", json={"medicine": "XXX"}).status_code == 404
    assert client.post("/api/analyze/forecast", json={"medicine": "OSEL", "hospital": "Z"}).status_code == 404


def test_medicine_catalogue_reconciles_with_stock_and_expiry(client):
    o = client.get("/api/overview").json()
    for med in ("OSEL", "CEFT", "INSU", "ORS"):
        d = client.get(f"/api/medicines/{med}").json()
        in_stores = sum(c["physical"] for c in o["cells"] if c["medicine"] == med)
        assert d["totals"]["units"] == in_stores == sum(b["qty"] for b in d["batches"])
        assert sum(h["units"] for h in d["hospitals"]) == in_stores
        days = [b["days_left"] for b in d["batches"]]
        assert days == sorted(days), "batches must be in expiry order"
        waste = sum(e["projected_waste"] for e in o["expiry"] if e["medicine"] == med)
        assert d["totals"]["projected_waste"] == waste
        assert sum(t["units"] for t in d["timeline"]) == in_stores
    assert client.get("/api/medicines/OSEL").json()["totals"]["units"] == 20000
    assert client.get("/api/medicines/XXX").status_code == 404
