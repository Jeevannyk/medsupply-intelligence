import sqlite3
from contextlib import contextmanager

from .config import DB_PATH


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@contextmanager
def session():
    conn = connect()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def rows(conn: sqlite3.Connection, sql: str, params=()) -> list[dict]:
    return [dict(r) for r in conn.execute(sql, params).fetchall()]


SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS hospitals (
    id TEXT PRIMARY KEY, name TEXT, city TEXT, lat REAL, lon REAL,
    beds INTEGER, patient_load INTEGER, emergency_index REAL);
CREATE TABLE IF NOT EXISTS medicines (
    id TEXT PRIMARY KEY, name TEXT, unit TEXT, criticality INTEGER,
    shelf_life_days INTEGER, alternatives TEXT, unit_cost REAL);
CREATE TABLE IF NOT EXISTS consumption (
    day INTEGER, date TEXT, hospital_id TEXT, medicine_id TEXT,
    units INTEGER, units_base INTEGER, split TEXT,
    PRIMARY KEY (day, hospital_id, medicine_id));
CREATE TABLE IF NOT EXISTS batches (
    batch_id TEXT PRIMARY KEY, hospital_id TEXT, medicine_id TEXT,
    qty INTEGER, expiry_date TEXT, received_date TEXT, source TEXT);
CREATE TABLE IF NOT EXISTS lead_times (
    hospital_id TEXT, medicine_id TEXT, lead_days INTEGER,
    PRIMARY KEY (hospital_id, medicine_id));
CREATE TABLE IF NOT EXISTS transport (
    from_id TEXT, to_id TEXT, km REAL, hours REAL,
    PRIMARY KEY (from_id, to_id));
CREATE TABLE IF NOT EXISTS transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    medicine_id TEXT, from_id TEXT, to_id TEXT, qty INTEGER,
    allocations TEXT, status TEXT, awaiting TEXT, origin TEXT,
    reason TEXT, hours REAL, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS offers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hospital_id TEXT, medicine_id TEXT, batch_id TEXT, qty INTEGER,
    remaining INTEGER, expiry_date TEXT, note TEXT, status TEXT, created_at TEXT, target TEXT);
CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hospital_id TEXT, medicine_id TEXT, qty INTEGER, remaining INTEGER,
    needed_within_days INTEGER, note TEXT, status TEXT, created_at TEXT, target TEXT);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT, sender TEXT, recipient TEXT, kind TEXT, body TEXT,
    transfer_id INTEGER, offer_id INTEGER, request_id INTEGER);
CREATE TABLE IF NOT EXISTS shipments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transfer_id INTEGER UNIQUE, mode TEXT, status TEXT, carrier TEXT, tracking_id TEXT,
    vehicle TEXT, driver TEXT, cold_chain INTEGER DEFAULT 0, handover_code TEXT, planned_hours REAL,
    dispatched_at TEXT, eta_at TEXT, arrived_at TEXT, delivered_at TEXT, progress REAL DEFAULT 0,
    delayed INTEGER DEFAULT 0, received_qty INTEGER, condition TEXT, receipt_note TEXT,
    created_at TEXT, updated_at TEXT, moved_at TEXT);
CREATE TABLE IF NOT EXISTS shipment_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shipment_id INTEGER, ts TEXT, type TEXT, source TEXT, note TEXT, external_id TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS discrepancies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transfer_id INTEGER, shipment_id INTEGER, medicine_id TEXT, expected INTEGER, received INTEGER,
    missing INTEGER, condition TEXT, resolution TEXT, note TEXT, created_at TEXT);
"""


def ensure_schema() -> None:
    """Bring an existing database up to date (adds the optional `target` hospital on offers and requests)."""
    conn = connect()
    try:
        conn.executescript(SCHEMA)
        for table in ("offers", "requests"):
            cols = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
            if "target" not in cols:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN target TEXT")
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(shipments)")}
        if "moved_at" not in cols:
            conn.execute("ALTER TABLE shipments ADD COLUMN moved_at TEXT")
        conn.commit()
    finally:
        conn.close()
