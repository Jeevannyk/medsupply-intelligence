import pytest
from fastapi.testclient import TestClient

from app import generate
from app.config import DB_PATH


@pytest.fixture(scope="module")
def client(monkeypatch_module=None):
    generate.generate(DB_PATH)
    from app.main import app, engine
    engine.load_static()
    with TestClient(app) as c:
        yield c


def test_history_is_seeded_once_and_populates_the_log(client, monkeypatch):
    from app.seed_history import seed_history_once
    assert client.get("/api/logistics").json()["shipments"] == []                  # tests start empty
    monkeypatch.setenv("MEDSUPPLY_SEED_HISTORY", "1")
    assert seed_history_once() is True
    assert seed_history_once() is False                                             # not twice
    log = client.get("/api/logistics").json()
    ships = log["shipments"]
    assert len(ships) >= 7
    assert {s["status"] for s in ships} == {"delivered", "cancelled"}
    assert {s["mode"] for s in ships} == {"in_house", "courier", "district"}
    key = [s["dispatched_at"] or s["created_at"] for s in ships]
    assert key == sorted(key, reverse=True)                                         # newest first
    assert all(s["events"] for s in ships) and all(s["handover_code"] is None for s in ships)
    kinds = {(d["condition"], d["resolution"]) for d in log["discrepancies"]}
    assert kinds == {("short", "returned_to_donor"), ("damaged", "written_off")}


def test_seeded_history_does_not_touch_stock_the_plan_or_the_map(client):
    before = client.get("/api/overview").json()
    assert before["verification"]["passed"] is True
    assert all(t["status"] in ("delivered", "cancelled") for t in client.get("/api/exchange").json()["transfers"])
    assert client.get("/api/exchange").json()["counts"]["pending"] == 0
    assert client.get("/api/judge").json()["stock_total"] == 20000                  # the seeded moves are already in the batches
    assert before["plan"]["moves"]                                                  # the optimizer still plans
