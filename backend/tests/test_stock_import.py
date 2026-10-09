import pytest
from fastapi.testclient import TestClient

from app import generate
from app.config import DB_PATH

HEADER = "hospital_id,medicine_id,batch_id,qty,expiry_date\n"


@pytest.fixture(scope="module")
def client():
    generate.generate(DB_PATH)
    from app.main import app, engine
    engine.load_static()
    with TestClient(app) as c:
        yield c


def post(client, csv, actor="NET", apply=False):
    return client.post("/api/import/stock", json={"csv": csv, "actor": actor, "apply": apply}).json()


def cell(client, h, m):
    return next(c for c in client.get("/api/overview").json()["cells"] if c["hospital"] == h and c["medicine"] == m)


def current(client):
    return client.get("/api/import/stock/export").text


def total_units(client):
    return sum(c["physical"] for c in client.get("/api/overview").json()["cells"])


def test_export_is_a_template_that_imports_back_unchanged(client):
    csv = current(client)
    assert csv.startswith(HEADER) and csv.count("\n") > 70
    before = total_units(client)
    r = post(client, csv, apply=True)
    assert r["ok"] and r["applied"] and r["errors"] == []
    assert r["summary"]["changes"] == [] and r["summary"]["units_before"] == r["summary"]["units_after"]
    assert total_units(client) == before                                            # a round trip changes nothing


def test_preview_changes_nothing_and_apply_changes_only_that_hospital(client):
    csv = current(client)
    lines = [ln for ln in csv.splitlines() if not (ln.startswith("B,CEFT,") or ln.startswith("hospital_id"))]
    new = HEADER + "\n".join(lines) + "\nB,CEFT,B-NEW-1,100,2027-03-31\n"
    others_before = {(c["hospital"], c["medicine"]): c["physical"] for c in client.get("/api/overview").json()["cells"] if c["hospital"] != "B"}
    old = cell(client, "B", "CEFT")
    preview = post(client, new, apply=False)                                         # check only
    assert preview["ok"] and not preview["applied"]
    assert cell(client, "B", "CEFT")["physical"] == old["physical"]                  # nothing happened yet
    assert preview["summary"]["changes"] == [{"hospital": "B", "medicine": "CEFT", "before": old["physical"], "after": 100}]

    done = post(client, new, apply=True)
    assert done["applied"]
    now = cell(client, "B", "CEFT")
    assert now["physical"] == 100 and now["risk"] in ("stockout", "critical", "high")   # the plan and risk recomputed on the new stock
    assert now["days_to_stockout"] < old["days_to_stockout"]
    others_after = {(c["hospital"], c["medicine"]): c["physical"] for c in client.get("/api/overview").json()["cells"] if c["hospital"] != "B"}
    assert others_after == others_before                                             # other hospitals untouched
    assert "B-NEW-1" in current(client)


def test_every_bad_row_is_reported_with_its_row_number_and_nothing_is_applied(client):
    before = current(client)
    bad = HEADER + "\n".join([
        "Z,OSEL,,10,2027-01-01",            # row 2 unknown hospital
        "A,NOPE,,10,2027-01-01",            # row 3 unknown medicine
        "A,OSEL,,0,2027-01-01",             # row 4 qty 0
        "A,OSEL,,-3,2027-01-01",            # row 5 negative
        "A,OSEL,,1.5,2027-01-01",           # row 6 fraction
        "A,OSEL,,abc,2027-01-01",           # row 7 not a number
        "A,OSEL,,10,31/12/2027",            # row 8 bad date format
        "A,OSEL,,10,2020-01-01",            # row 9 already expired
        "A,OSEL,DUP,10,2027-01-01",         # row 10 ok
        "A,OSEL,DUP,10,2027-01-01",         # row 11 duplicate batch id
    ]) + "\n"
    r = post(client, bad, apply=True)
    assert not r["ok"] and not r["applied"]
    by_row = {e["row"]: e["message"] for e in r["errors"]}
    assert "unknown hospital" in by_row[2] and "unknown medicine" in by_row[3]
    assert all("qty must be a whole number" in by_row[n] for n in (4, 5, 6, 7))
    assert "expiry_date must look like" in by_row[8] and "already expired" in by_row[9]
    assert "appears twice" in by_row[11] and 10 not in by_row
    assert current(client) == before                                                 # all or nothing


@pytest.mark.parametrize("text,fragment", [
    ("", "empty"),
    ("hospital_id,medicine_id\nA,OSEL\n", "Missing column"),
    (HEADER, "no stock rows"),
])
def test_unusable_files_are_explained(client, text, fragment):
    r = post(client, text, apply=True)
    assert not r["ok"] and fragment in r["errors"][0]["message"]


def test_a_real_world_file_is_accepted(client):
    """Excel-style: UTF-8 BOM, odd header case and spacing, an extra column, CRLF line ends, blank lines, lower-case ids, no batch ids."""
    text = "﻿ Hospital_ID , MEDICINE_ID ,Qty,Expiry_Date,Notes\r\nc,ors,500,2027-06-30,from store 2\r\n\r\nc,ors,250,2027-09-30,\r\n"
    r = post(client, text, actor="C", apply=True)
    assert r["ok"] and r["applied"] and r["summary"]["rows"] == 2
    assert cell(client, "C", "ORS")["physical"] == 750
    ids = [ln.split(",")[2] for ln in current(client).splitlines() if ln.startswith("C,ORS,")]
    assert len(ids) == 2 and len(set(ids)) == 2 and all(i.startswith("IMP-C-ORS-") for i in ids)   # unique made-up batch ids
    assert cell(client, "C", "OSEL")["physical"] == 0                                # the file replaces ALL of C's stock


def test_who_may_import_what(client):
    row = HEADER + "D,ORS,,100,2027-06-30\n"
    r = post(client, row, actor="E", apply=True)
    assert not r["ok"] and "only import stock for hospital E" in r["errors"][0]["message"]
    assert post(client, row, actor="DIST")["errors"][0]["message"].startswith("Only a hospital")
    assert post(client, row, actor="NOBODY")["errors"][0]["message"].startswith("Only a hospital")
    assert post(client, row, actor="D", apply=True)["applied"]                       # a hospital may import its own
    assert post(client, HEADER + "E,ORS,,100,2027-06-30\n", actor="NET", apply=True)["applied"]      # the admin may import any


def test_stock_a_transfer_depends_on_cannot_be_replaced(client):
    rq = client.post("/api/requests", json={"hospital": "F", "medicine": "ORS", "qty": 50, "target": "B"}).json()
    t = client.post(f"/api/requests/{rq['request_id']}/respond", json={"donor": "B", "qty": 50}).json()
    csv = HEADER + "B,ORS,,900,2027-06-30\n"
    blocked = post(client, csv, apply=True)
    assert not blocked["ok"] and f"transfer #{t['id']}" in blocked["errors"][0]["message"]
    assert client.post(f"/api/transfers/{t['id']}/action", json={"action": "cancel", "actor": "B"}).status_code == 200
    assert post(client, csv, apply=True)["applied"]                                  # fine once it is cancelled


def test_batch_ids_cannot_collide_with_another_hospital(client):
    taken = next(ln.split(",")[2] for ln in current(client).splitlines() if ln.startswith("G,"))
    r = post(client, HEADER + f"H,ORS,{taken},100,2027-06-30\n", actor="H", apply=True)
    assert not r["ok"] and "already belongs to a hospital" in r["errors"][0]["message"]


def test_the_plan_still_verifies_after_an_import(client):
    assert client.get("/api/overview").json()["verification"]["passed"] is True
