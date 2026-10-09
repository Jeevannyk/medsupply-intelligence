"""Load a hospital's real stock from a CSV: the way real batch records replace the simulated ones.

Scope: current stock batches only. Daily demand history stays as it is (the forecast and the with/without-system comparison
depend on it). The import is all-or-nothing and has a preview step, so a bad file can never leave stock half-changed.

Columns (header row required, any order, case-insensitive):
  hospital_id, medicine_id, qty, expiry_date (YYYY-MM-DD)   required
  batch_id                                                    optional (made up when empty)

A file replaces ALL stock of every hospital it mentions; hospitals it does not mention are untouched.
A hospital may import only its own rows; the network admin may import any hospital's.
"""
import csv
import io
from collections import defaultdict
from datetime import date

from .config import TODAY
from .db import rows, session

REQUIRED = ("hospital_id", "medicine_id", "qty", "expiry_date")
MAX_ROWS, MAX_CHARS, MAX_ERRORS = 5000, 1_000_000, 25
ACTIVE = ("pending", "approved", "in_transit")


def export_csv() -> str:
    """The current stock in the import format, so it doubles as the template to edit and upload."""
    with session() as c:
        data = rows(c, "SELECT hospital_id, medicine_id, batch_id, qty, expiry_date FROM batches WHERE qty > 0 "
                       "ORDER BY hospital_id, medicine_id, expiry_date, batch_id")
    out = io.StringIO()
    w = csv.writer(out, lineterminator="\n")
    w.writerow(["hospital_id", "medicine_id", "batch_id", "qty", "expiry_date"])
    for r in data:
        w.writerow([r["hospital_id"], r["medicine_id"], r["batch_id"], r["qty"], r["expiry_date"]])
    return out.getvalue()


def _err(row: int | None, message: str) -> dict:
    return {"row": row, "message": message}


def _parse(text: str, actor: str, hospitals: set, medicines: set) -> tuple[list[dict], list[dict]]:
    """Check every row. Returns (records, errors); records are only usable when there are no errors."""
    if actor != "NET" and actor not in hospitals:
        return [], [_err(None, "Only a hospital (for its own stock) or the network admin can import stock.")]
    if not text.strip():
        return [], [_err(None, "The file is empty.")]
    if len(text) > MAX_CHARS:
        return [], [_err(None, "The file is too large (limit about 1 MB).")]
    reader = csv.DictReader(io.StringIO(text.lstrip("﻿")))
    if not reader.fieldnames:
        return [], [_err(None, "The file has no header row.")]
    reader.fieldnames = [f.strip().lower() for f in reader.fieldnames]
    missing = [c for c in REQUIRED if c not in reader.fieldnames]
    if missing:
        return [], [_err(1, f"Missing column(s): {', '.join(missing)}. Expected: hospital_id, medicine_id, batch_id (optional), qty, expiry_date.")]

    recs, errs, seen = [], [], set()
    for n, raw in enumerate(reader, start=2):                      # the header is row 1
        r = {k: (v or "").strip() for k, v in raw.items() if k}
        if not any(r.values()):
            continue                                               # blank line
        if len(recs) + len(errs) >= MAX_ROWS:
            errs.append(_err(n, f"Too many rows (limit {MAX_ROWS})."))
            break
        problems = []
        h, m = r["hospital_id"].upper(), r["medicine_id"].upper()
        if h not in hospitals:
            problems.append(f"unknown hospital '{r['hospital_id']}'")
        elif actor != "NET" and h != actor:
            problems.append(f"you can only import stock for hospital {actor}, not {h}")
        if m not in medicines:
            problems.append(f"unknown medicine '{r['medicine_id']}'")
        qty = None
        try:
            qty = int(float(r["qty"]))
            if qty <= 0 or float(r["qty"]) != qty:
                raise ValueError
        except ValueError:
            problems.append(f"qty must be a whole number above 0 (got '{r['qty']}')")
        exp = None
        try:
            exp = date.fromisoformat(r["expiry_date"])
            if exp <= TODAY:
                problems.append(f"expiry {exp} is not after today ({TODAY}), so this stock is already expired")
        except ValueError:
            problems.append(f"expiry_date must look like 2027-03-31 (got '{r['expiry_date']}')")
        bid = r.get("batch_id", "")
        if bid:
            if bid in seen:
                problems.append(f"batch_id '{bid}' appears twice in the file")
            seen.add(bid)
        if problems:
            errs.append(_err(n, "; ".join(problems)))
        else:
            recs.append({"hospital_id": h, "medicine_id": m, "batch_id": bid, "qty": qty, "expiry_date": exp.isoformat()})
    if not recs and not errs:
        errs.append(_err(None, "The file has a header but no stock rows."))
    return recs, errs


def run(text: str, actor: str, hospitals: set, medicines: set, apply: bool) -> dict:
    recs, errs = _parse(text, actor, hospitals, medicines)
    result = {"ok": False, "applied": False, "errors": errs[:MAX_ERRORS], "more_errors": max(0, len(errs) - MAX_ERRORS), "summary": None}
    if errs:
        return result
    touched = sorted({r["hospital_id"] for r in recs})
    with session() as c:
        marks = ",".join("?" * len(touched))
        busy = rows(c, f"SELECT id, from_id FROM transfers WHERE status IN ({','.join('?' * len(ACTIVE))}) AND from_id IN ({marks})", (*ACTIVE, *touched))
        if busy:
            result["errors"] = [_err(None, f"Hospital {b['from_id']} has transfer #{b['id']} in progress that depends on its current stock. Finish or cancel it first.") for b in busy]
            return result
        keep = {r["batch_id"] for r in rows(c, f"SELECT batch_id FROM batches WHERE hospital_id NOT IN ({marks})", tuple(touched))}
        clash = [r["batch_id"] for r in recs if r["batch_id"] and r["batch_id"] in keep]
        if clash:
            result["errors"] = [_err(None, f"batch_id '{b}' already belongs to a hospital that is not in this file.") for b in clash[:MAX_ERRORS]]
            return result
        before = defaultdict(int)
        for r in rows(c, f"SELECT hospital_id, medicine_id, SUM(qty) AS q FROM batches WHERE hospital_id IN ({marks}) GROUP BY hospital_id, medicine_id", tuple(touched)):
            before[(r["hospital_id"], r["medicine_id"])] = r["q"]
        after = defaultdict(int)
        counter = defaultdict(int)
        for r in recs:
            after[(r["hospital_id"], r["medicine_id"])] += r["qty"]
            if not r["batch_id"]:                                  # made-up ids never clash with a kept batch
                counter[(r["hospital_id"], r["medicine_id"])] += 1
                n = counter[(r["hospital_id"], r["medicine_id"])]
                bid = f"IMP-{r['hospital_id']}-{r['medicine_id']}-{n:02d}"
                while bid in keep:
                    n += 1
                    bid = f"IMP-{r['hospital_id']}-{r['medicine_id']}-{n:02d}"
                r["batch_id"] = bid
        changes = [{"hospital": h, "medicine": m, "before": before.get((h, m), 0), "after": after.get((h, m), 0)}
                   for h, m in sorted(set(before) | set(after)) if before.get((h, m), 0) != after.get((h, m), 0)]
        result["summary"] = {"rows": len(recs), "hospitals": touched, "batches_replaced": sum(1 for _ in rows(c, f"SELECT 1 FROM batches WHERE hospital_id IN ({marks})", tuple(touched))),
                             "units_before": sum(before.values()), "units_after": sum(after.values()), "changes": changes}
        result["ok"] = True
        if apply:
            c.execute(f"DELETE FROM batches WHERE hospital_id IN ({marks})", tuple(touched))
            c.executemany("INSERT INTO batches (batch_id, hospital_id, medicine_id, qty, expiry_date, received_date, source) VALUES (?,?,?,?,?,?,?)",
                          [(r["batch_id"], r["hospital_id"], r["medicine_id"], r["qty"], r["expiry_date"], TODAY.isoformat(), "csv import") for r in recs])
            result["applied"] = True
    return result
