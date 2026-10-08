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


def stock(client, hospital, medicine):
    cells = client.get("/api/overview").json()["cells"]
    return next(c for c in cells if c["hospital"] == hospital and c["medicine"] == medicine)


def handover_code(client, tid):
    t = next(x for x in client.get("/api/exchange").json()["transfers"] if x["id"] == tid)
    board = client.get("/api/exchange", params={"hospital": t["from_id"]}).json()       # only the donor's view shows the code
    return next(x for x in board["transfers"] if x["id"] == tid)["shipment"]["handover_code"]


def act(client, tid, action, actor):
    body = {"action": action, "actor": actor}
    if action == "receive" and actor != "NET":
        body["code"] = handover_code(client, tid)
    return client.post(f"/api/transfers/{tid}/action", json=body)


def test_send_only_the_selected_move_and_its_arrow_disappears(client):
    plan = client.get("/api/overview").json()["plan"]["moves"]
    assert len(plan) >= 2
    pick = plan[0]
    ids = client.post("/api/exchange/send-plan", json={"move_ids": [pick["key"]]}).json()["transfer_ids"]
    assert len(ids) == 1                                   # one transfer, not the whole plan
    sent = next(t for t in client.get("/api/exchange").json()["transfers"] if t["id"] == ids[0])
    assert (sent["from_id"], sent["to_id"], sent["medicine_id"]) == (pick["from"], pick["to"], pick["medicine"])
    left = client.get("/api/overview").json()["plan"]["moves"]
    assert pick["key"] not in {m["key"] for m in left}     # that arrow is gone from the graph
    assert len(left) >= 1                                  # the other moves were not sent
    assert len(client.get("/api/exchange").json()["transfers"]) == 1


def test_empty_selection_sends_nothing(client):
    r = client.post("/api/exchange/send-plan", json={"move_ids": []})
    assert r.status_code == 400


def test_network_admin_cannot_approve_decline_dispatch_receive_or_cancel(client):
    t = client.get("/api/exchange").json()["transfers"][0]
    for action in ("approve", "decline", "dispatch", "receive", "cancel"):
        assert act(client, t["id"], action, "NET").status_code == 400, action
    assert client.get("/api/exchange").json()["transfers"][-1]["status"] == "pending"


def test_stock_updates_after_receive_for_both_hospitals(client):
    t = next(x for x in client.get("/api/exchange").json()["transfers"] if x["status"] == "pending")
    m, frm, to, qty = t["medicine_id"], t["from_id"], t["to_id"], t["qty"]
    donor0, rec0 = stock(client, frm, m)["physical"], stock(client, to, m)["physical"]
    for action, actor in (("approve", frm), ("dispatch", frm), ("receive", to)):
        assert act(client, t["id"], action, actor).status_code == 200
    assert stock(client, frm, m)["physical"] == donor0 - qty
    assert stock(client, to, m)["physical"] == rec0 + qty


def post(client, path, **body):
    return client.post(f"/api/{path}", json=body)


def run(client, tid, steps):
    for action, actor in steps:
        assert act(client, tid, action, actor).status_code == 200, action


def test_request_to_one_hospital_is_accepted_then_dispatched_and_received(client):
    donor, requester, med = "B", "E", "ORS"
    before = stock(client, donor, med)["physical"] + stock(client, requester, med)["physical"]
    r = post(client, "requests", hospital=requester, medicine=med, qty=100, target=donor).json()
    assert r["target"] == donor
    assert post(client, f"requests/{r['request_id']}/respond", donor="C", qty=100).status_code == 400    # not addressed to C
    assert post(client, f"requests/{r['request_id']}/respond", donor=requester, qty=100).status_code == 400  # own request
    t = post(client, f"requests/{r['request_id']}/respond", donor=donor, qty=100).json()
    assert t["status"] == "approved" and t["awaiting"] == donor and t["from_id"] == donor and t["to_id"] == requester
    assert act(client, t["id"], "dispatch", requester).status_code == 400                                 # only the donor dispatches
    run(client, t["id"], (("dispatch", donor), ("receive", requester)))
    assert stock(client, donor, med)["physical"] + stock(client, requester, med)["physical"] == before   # units conserved
    assert stock(client, requester, med)["physical"] >= 100


def test_broadcast_request_can_be_accepted_by_any_hospital(client):
    r = post(client, "requests", hospital="E", medicine="ORS", qty=50).json()
    assert r["target"] is None
    t = post(client, f"requests/{r['request_id']}/respond", donor="H", qty=50).json()
    assert (t["from_id"], t["to_id"], t["status"]) == ("H", "E", "approved")


def test_offer_to_one_hospital_only_that_hospital_can_accept_or_decline(client):
    o = post(client, "offers", hospital="F", medicine="ORS", qty=100, target="A").json()
    assert o["target"] == "A"
    assert post(client, f"offers/{o['offer_id']}/claim", hospital="B", qty=100).status_code == 400
    assert post(client, f"offers/{o['offer_id']}/decline", hospital="B").status_code == 400
    t = post(client, f"offers/{o['offer_id']}/claim", hospital="A", qty=100).json()
    assert (t["from_id"], t["to_id"], t["status"], t["awaiting"]) == ("F", "A", "approved", "F")
    o2 = post(client, "offers", hospital="F", medicine="ORS", qty=50, target="A").json()
    assert post(client, f"offers/{o2['offer_id']}/decline", hospital="A").status_code == 200
    assert post(client, f"offers/{o2['offer_id']}/claim", hospital="A", qty=50).status_code == 400       # declined = closed


def test_broadcast_offer_can_be_accepted_by_any_needy_hospital(client):
    o = post(client, "offers", hospital="G", medicine="ORS", qty=80).json()
    assert o["target"] is None
    assert post(client, f"offers/{o['offer_id']}/claim", hospital="G", qty=80).status_code == 400        # own offer
    t = post(client, f"offers/{o['offer_id']}/claim", hospital="D", qty=80).json()
    assert (t["from_id"], t["to_id"], t["status"]) == ("G", "D", "approved")


def test_declining_a_request_and_withdrawing_posts(client):
    r = post(client, "requests", hospital="E", medicine="ORS", qty=20, target="B").json()["request_id"]
    assert post(client, f"requests/{r}/decline", hospital="C").status_code == 400
    assert post(client, f"requests/{r}/decline", hospital="B").status_code == 200
    r2 = post(client, "requests", hospital="E", medicine="ORS", qty=20).json()["request_id"]
    assert post(client, f"requests/{r2}/withdraw", hospital="B").status_code == 400                       # not the poster
    assert post(client, f"requests/{r2}/withdraw", hospital="E").status_code == 200
    assert post(client, f"requests/{r2}/respond", donor="B", qty=20).status_code == 400                   # withdrawn = closed


def test_admin_cannot_post_or_accept_and_bad_input_is_rejected(client):
    assert post(client, "requests", hospital="NET", medicine="ORS", qty=10).status_code == 400
    assert post(client, "offers", hospital="NET", medicine="ORS", qty=10).status_code == 400
    assert post(client, "requests", hospital="E", medicine="ORS", qty=10, target="E").status_code == 400  # to itself
    assert post(client, "requests", hospital="E", medicine="ORS", qty=10, target="XX").status_code == 400
    assert post(client, "requests", hospital="E", medicine="ORS", qty=0).status_code == 400
    r = post(client, "requests", hospital="E", medicine="ORS", qty=10).json()["request_id"]
    assert post(client, f"requests/{r}/respond", donor="NET", qty=10).status_code == 400
    big = post(client, "requests", hospital="E", medicine="ORS", qty=10_000_000).json()["request_id"]
    assert post(client, f"requests/{big}/respond", donor="B", qty=10_000_000).status_code == 400          # donor lacks that much


def test_emergency_loans_cover_red_hospitals_when_nobody_has_spare_stock(client):
    """With no spare stock above the normal reserve, donors with long cover lend what they can after
    keeping enough for their own resupply wait, and every verification check still passes."""
    a = client.get("/api/overview").json()
    loans = [m for m in a["plan"]["moves"] if m["kind"] == "emergency"]
    assert loans, "red hospitals should get emergency-loan suggestions"
    assert a["verification"]["passed"], [c for c in a["verification"]["checks"] if not c["passed"]]
    for m in loans:
        assert "keeping" in m["reason"] and "reorder" in m["reason"]
