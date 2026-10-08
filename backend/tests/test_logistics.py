import pytest
from fastapi.testclient import TestClient

from app import generate, logistics
from app.config import DB_PATH

KEY = {"X-Carrier-Key": "carrier-demo-key"}


@pytest.fixture(scope="module")
def client():
    generate.generate(DB_PATH)
    from app.main import app, engine
    engine.load_static()
    with TestClient(app) as c:
        yield c


@pytest.fixture
def carrier(client, monkeypatch):
    """The mock courier service, wired to the app in-process: calls go to it, its webhooks come back."""
    import carrier_mock.app as cm
    cc = TestClient(cm.app)

    def request(method, path, payload=None):
        r = cc.request(method, path, json=payload, headers=KEY)
        if r.status_code >= 400:
            raise logistics.LogisticsError(f"courier said {r.status_code}")
        return r.json()

    monkeypatch.setattr(logistics, "carrier_request", request)
    monkeypatch.setattr(cm, "post_webhook", lambda evt: client.post("/api/logistics/webhook", json=evt, headers=KEY))
    return cm


@pytest.fixture
def slow(monkeypatch):
    """Trips take the demo's real 30 seconds instead of arriving instantly."""
    monkeypatch.setenv("LOGISTICS_TRAVEL_SECONDS", "30")


def stock(client, h, m):
    return next(c for c in client.get("/api/overview").json()["cells"] if c["hospital"] == h and c["medicine"] == m)["physical"]


def act(client, tid, action, actor, **extra):
    return client.post(f"/api/transfers/{tid}/action", json={"action": action, "actor": actor, **extra})


_pairs = iter([(d, r) for _ in range(40) for d, r in (("C", "E"), ("A", "F"), ("H", "E"), ("B", "G"), ("C", "F"), ("A", "G"))])


def approved_transfer(client, qty=120):
    """A request answered by the donor: an agreed (approved) transfer of ORS, which never needs a cold chain."""
    donor, receiver = next(_pairs)
    rq = client.post("/api/requests", json={"hospital": receiver, "medicine": "ORS", "qty": qty, "target": donor}).json()
    t = client.post(f"/api/requests/{rq['request_id']}/respond", json={"donor": donor, "qty": qty}).json()
    assert t["status"] == "approved"
    return next(x for x in client.get("/api/exchange").json()["transfers"] if x["id"] == t["id"])


def deliver(client, t, mode="in_house", **kw):
    r = client.post(f"/api/transfers/{t['id']}/delivery",
                    json={"actor": t["from_id"], "mode": mode, "vehicle": "KA-19-AB-1234", "driver": "Ravi", **kw})
    assert r.status_code == 200, r.text
    return r.json()


def shipment_of(client, tid, viewer=None):
    params = {"hospital": viewer} if viewer else {}
    return next(x for x in client.get("/api/exchange", params=params).json()["transfers"] if x["id"] == tid)["shipment"]


def test_delivery_mode_recommendation():
    assert logistics.recommend_mode(1.0, "ORS", 200)["mode"] == "in_house"
    assert logistics.recommend_mode(1.0, "INSU", 50)["mode"] == "courier"      # cold chain
    assert logistics.recommend_mode(3.5, "ORS", 200)["mode"] == "courier"      # long trip
    assert logistics.recommend_mode(1.0, "ORS", 5000)["mode"] == "courier"     # too big for a van


def test_own_vehicle_flow_needs_the_handover_code(client):
    t = approved_transfer(client)
    frm, to = t["from_id"], t["to_id"]
    assert client.post(f"/api/transfers/{t['id']}/delivery", json={"actor": to, "mode": "in_house", "vehicle": "x", "driver": "y"}).status_code == 400
    assert client.post(f"/api/transfers/{t['id']}/delivery", json={"actor": frm, "mode": "in_house"}).status_code == 400   # needs vehicle + driver
    s = deliver(client, t)["shipment"]
    assert s["status"] == "planned" and s["vehicle"] == "KA-19-AB-1234"
    d = act(client, t["id"], "dispatch", frm).json()
    code = d["shipment"]["handover_code"]
    assert d["status"] == "in_transit" and len(code) == 6 and d["shipment"]["eta_at"]
    assert shipment_of(client, t["id"], to)["handover_code"] is None            # only the donor sees it
    assert shipment_of(client, t["id"])["handover_code"] is None                # not the admin either
    assert act(client, t["id"], "receive", to).status_code == 400               # no code
    assert act(client, t["id"], "receive", to, code="000000" if code != "000000" else "111111").status_code == 400
    m = t["medicine_id"]
    donor0, rec0 = stock(client, frm, m), stock(client, to, m)
    r = act(client, t["id"], "receive", to, code=code)
    assert r.status_code == 200 and r.json()["status"] == "delivered"
    assert stock(client, frm, m) == donor0 - t["qty"] and stock(client, to, m) == rec0 + t["qty"]
    assert shipment_of(client, t["id"])["status"] == "delivered"


def test_short_delivery_is_returned_to_the_donor_and_logged(client):
    t = approved_transfer(client)
    frm, to, m = t["from_id"], t["to_id"], t["medicine_id"]
    deliver(client, t)
    code = act(client, t["id"], "dispatch", frm).json()["shipment"]["handover_code"]
    donor0, rec0 = stock(client, frm, m), stock(client, to, m)
    got = t["qty"] - 20
    r = act(client, t["id"], "receive", to, code=code, received_qty=got, condition="short")
    assert r.status_code == 200
    assert stock(client, to, m) == rec0 + got
    assert stock(client, frm, m) == donor0 - got                                 # the 20 never left the donor's books
    assert stock(client, frm, m) + stock(client, to, m) == donor0 + rec0         # nothing lost
    d = next(x for x in client.get("/api/logistics").json()["discrepancies"] if x["transfer_id"] == t["id"])
    assert (d["missing"], d["condition"], d["resolution"]) == (20, "short", "returned_to_donor")


def test_damaged_units_are_written_off(client):
    t = approved_transfer(client)
    frm, to, m = t["from_id"], t["to_id"], t["medicine_id"]
    code = act(client, t["id"], "dispatch", frm).json()["shipment"]["handover_code"]   # no delivery arranged: own vehicle by default
    donor0, rec0 = stock(client, frm, m), stock(client, to, m)
    assert act(client, t["id"], "receive", to, code=code, received_qty=t["qty"] - 15, condition="damaged").status_code == 200
    assert stock(client, frm, m) == donor0 - t["qty"]
    assert stock(client, to, m) == rec0 + t["qty"] - 15
    assert stock(client, frm, m) + stock(client, to, m) == donor0 + rec0 - 15    # the damaged units are gone
    assert act(client, t["id"], "receive", to, code=code).status_code == 400     # cannot receive twice


def test_over_receiving_is_rejected(client):
    t = approved_transfer(client)
    code = act(client, t["id"], "dispatch", t["from_id"]).json()["shipment"]["handover_code"]
    assert act(client, t["id"], "receive", t["to_id"], code=code, received_qty=t["qty"] + 1).status_code == 400


def test_late_trip_is_flagged_and_the_planner_expects_it_later(client, slow):
    from app.main import engine
    t = approved_transfer(client)
    frm = t["from_id"]
    deliver(client, t)
    act(client, t["id"], "dispatch", frm)

    def landing_day():
        _, cur, _, _ = engine.pipeline_batches()
        return next(b.arrive for bl in cur.values() for b in bl if b.virtual and b.id.endswith(f">{t['to_id']}")
                    and b.id.startswith(t["allocations"][0]["batch_id"]))

    assert landing_day() == 0                                                    # on time: lands today
    s = shipment_of(client, t["id"], frm)
    assert client.post(f"/api/logistics/shipments/{s['id']}/delay", json={"hours": 30, "reason": "road closed"}).status_code == 200
    s = shipment_of(client, t["id"], frm)
    assert s["delayed"] == 1 and s["remaining_hours"] > 29
    assert landing_day() >= 1                                                    # a late trip lands later
    assert any(e["type"] == "delayed" for e in s["events"])


def test_trip_past_its_eta_is_flagged_by_the_monitor(client):
    t = approved_transfer(client)
    act(client, t["id"], "dispatch", t["from_id"])
    assert shipment_of(client, t["id"])["delayed"] == 0
    assert client.post("/api/logistics/sim/advance", json={"hours": 5}).status_code == 200
    s = shipment_of(client, t["id"])
    assert s["delayed"] == 1 and any(e["source"] == "system" and e["type"] == "delayed" for e in s["events"])
    assert client.post("/api/logistics/sim/advance", json={"hours": 0}).status_code == 400


def test_district_pool_needs_a_vehicle_before_dispatch(client):
    t = approved_transfer(client)
    frm = t["from_id"]
    s = deliver(client, t, mode="district")["shipment"]
    assert s["status"] == "requested"
    assert act(client, t["id"], "dispatch", frm).status_code == 400              # no vehicle yet
    q = client.get("/api/logistics").json()["district_queue"]
    assert any(x["id"] == s["id"] for x in q)
    path = f"/api/logistics/shipments/{s['id']}/assign"
    assert client.post(path, json={"actor": frm, "vehicle": "V1", "driver": "D1"}).status_code == 400    # only the district office
    assert client.post(path, json={"actor": "DIST", "vehicle": "", "driver": ""}).status_code == 400
    assert client.post(path, json={"actor": "DIST", "vehicle": "DK-01-G-77", "driver": "Suresh"}).status_code == 200
    d = act(client, t["id"], "dispatch", frm)
    assert d.status_code == 200 and d.json()["shipment"]["vehicle"] == "DK-01-G-77"


def test_courier_flow_with_webhooks_and_delay(client, carrier, slow):
    t = approved_transfer(client)
    frm, to = t["from_id"], t["to_id"]
    s = deliver(client, t, mode="courier")["shipment"]
    assert s["tracking_id"].startswith("CR-") and s["carrier"] == "Mock Courier"
    code = act(client, t["id"], "dispatch", frm).json()["shipment"]["handover_code"]
    s = shipment_of(client, t["id"], frm)
    assert s["status"] == "in_transit" and any(e["source"] == "carrier" and e["type"] == "picked_up" for e in s["events"])
    eta0 = s["eta_at"]
    client.post(f"/api/logistics/shipments/{s['id']}/delay", json={"hours": 2, "reason": "traffic"})   # courier reports it by webhook
    s = shipment_of(client, t["id"], frm)
    assert s["delayed"] == 1 and s["eta_at"] > eta0
    assert any(e["source"] == "carrier" and e["type"] == "delayed" for e in s["events"])
    # the courier's clock runs out: it announces arrival, but stock does not move until the hospital confirms
    m = t["medicine_id"]
    rec0 = stock(client, to, m)
    carrier.tick(now=9_999_999_999)
    s = shipment_of(client, t["id"], frm)
    assert s["status"] == "arrived" and stock(client, to, m) == rec0
    assert act(client, t["id"], "receive", to, code=code).status_code == 200
    assert stock(client, to, m) == rec0 + t["qty"]


def test_webhook_is_authenticated_and_idempotent(client, carrier, slow):
    t = approved_transfer(client)
    deliver(client, t, mode="courier")
    s = shipment_of(client, t["id"], t["from_id"])
    evt = {"event_id": "evt-1", "tracking_id": s["tracking_id"], "type": "delayed", "note": "x", "delay_hours": 1}
    assert client.post("/api/logistics/webhook", json=evt).status_code == 401
    assert client.post("/api/logistics/webhook", json=evt, headers={"X-Carrier-Key": "wrong"}).status_code == 401
    act(client, t["id"], "dispatch", t["from_id"])
    eta0 = shipment_of(client, t["id"], t["from_id"])["eta_at"]
    assert client.post("/api/logistics/webhook", json=evt, headers=KEY).json()["duplicate"] is False
    assert client.post("/api/logistics/webhook", json=evt, headers=KEY).json()["duplicate"] is True      # same event twice
    eta1 = shipment_of(client, t["id"], t["from_id"])["eta_at"]
    assert eta1 > eta0
    bad = {**evt, "event_id": "evt-2", "tracking_id": "CR-NOPE"}
    assert client.post("/api/logistics/webhook", json=bad, headers=KEY).status_code == 400
    assert client.post("/api/logistics/webhook", json={**evt, "event_id": "evt-3", "type": "teleported"}, headers=KEY).status_code == 400


def test_unreachable_courier_is_a_clear_error(client, monkeypatch):
    t = approved_transfer(client)

    def down(method, path, payload=None):
        raise logistics.LogisticsError("The courier service is not reachable. Choose another delivery mode.")

    monkeypatch.setattr(logistics, "carrier_request", down)
    r = client.post(f"/api/transfers/{t['id']}/delivery", json={"actor": t["from_id"], "mode": "courier"})
    assert r.status_code == 400 and "not reachable" in r.json()["detail"]
    assert deliver(client, t)["shipment"]["mode"] == "in_house"                  # the donor falls back to their own vehicle


def test_cancelling_before_dispatch_closes_the_shipment(client):
    t = approved_transfer(client)
    deliver(client, t)
    assert act(client, t["id"], "cancel", t["from_id"]).status_code == 200
    assert shipment_of(client, t["id"])["status"] == "cancelled"


def test_receipt_is_blocked_until_the_vehicle_arrives(client, slow):
    t = approved_transfer(client)
    frm, to = t["from_id"], t["to_id"]
    code = act(client, t["id"], "dispatch", frm).json()["shipment"]["handover_code"]
    s = shipment_of(client, t["id"], frm)
    assert s["at_door"] is False and 0 < s["remaining_seconds"] <= 30 and s["progress"] < 1
    r = act(client, t["id"], "receive", to, code=code)
    assert r.status_code == 400 and "not arrived" in r.json()["detail"]          # the right code is not enough while it is on the road
    assert shipment_of(client, t["id"], frm)["status"] == "in_transit"
    client.post("/api/logistics/sim/advance", json={"hours": 1})                    # the vehicle gets there
    assert shipment_of(client, t["id"], frm)["at_door"] is True
    assert act(client, t["id"], "receive", to, code=code).status_code == 200


def test_a_delay_slows_the_truck_but_never_moves_it_backwards(client, slow):
    t = approved_transfer(client)
    frm = t["from_id"]
    act(client, t["id"], "dispatch", frm)
    client.post("/api/logistics/sim/advance", json={"hours": 0.004})                # about 14 s into the 30 s trip
    before = shipment_of(client, t["id"], frm)
    assert 0.3 < before["progress"] < 0.7
    sid = before["id"]
    assert client.post(f"/api/logistics/shipments/{sid}/delay", json={"hours": 6}).status_code == 200
    after = shipment_of(client, t["id"], frm)
    assert after["progress"] >= before["progress"] - 0.01                           # it keeps its place on the road
    assert after["remaining_seconds"] > 6 * 3600 - 120 and after["at_door"] is False


def test_cannot_delay_a_vehicle_that_has_already_arrived(client):
    t = approved_transfer(client)
    act(client, t["id"], "dispatch", t["from_id"])                                   # instant trip in tests
    s = shipment_of(client, t["id"], t["from_id"])
    assert s["at_door"] is True
    assert client.post(f"/api/logistics/shipments/{s['id']}/delay", json={"hours": 3}).status_code == 400


def test_road_paths_cover_every_hospital_pair_on_real_roads(client):
    data = client.get("/api/road-paths").json()["paths"]
    hospitals = client.get("/api/meta").json()["hospitals"]
    ids = [h["id"] for h in hospitals]
    pairs = [f"{a}-{b}" for i, a in enumerate(ids) for b in ids[i + 1:]]
    assert sorted(data) == sorted(pairs) and len(pairs) == 28
    at = {h["id"]: (h["lat"], h["lon"]) for h in hospitals}
    for key, pts in data.items():
        a, b = key.split("-")
        assert len(pts) >= 3, key                                                  # a real road, not a straight line
        for (lat, lon), hid in ((pts[0], a), (pts[-1], b)):                       # it starts and ends at the hospitals
            assert abs(lat - at[hid][0]) < 0.01 and abs(lon - at[hid][1]) < 0.01, (key, hid)
