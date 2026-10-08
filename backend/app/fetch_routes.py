"""Fetch real road distances/durations between the hospitals (OSRM, OpenStreetMap data).

Writes app/data/routes.json, which generate.py reads; run once, commit the result so
data generation stays offline and reproducible.

Run:  python -m app.fetch_routes
"""
import json
from pathlib import Path

import httpx

from .generate import HOSPITALS

OUT = Path(__file__).resolve().parent / "data" / "routes.json"
URL = "https://router.project-osrm.org/table/v1/driving/{coords}"


def fetch() -> dict:
    ids = [h[0] for h in HOSPITALS]
    coords = ";".join(f"{h[4]},{h[3]}" for h in HOSPITALS)           # OSRM wants lon,lat
    r = httpx.get(URL.format(coords=coords), params={"annotations": "distance,duration"},
                  headers={"User-Agent": "singularity-hackathon-data/1.0"}, timeout=60)
    r.raise_for_status()
    t = r.json()
    if t.get("code") != "Ok":
        raise RuntimeError(f"OSRM error: {t.get('code')} {t.get('message')}")
    km = {a: {b: round(t["distances"][i][j] / 1000, 1) for j, b in enumerate(ids)} for i, a in enumerate(ids)}
    hours = {a: {b: round(t["durations"][i][j] / 3600, 2) for j, b in enumerate(ids)} for i, a in enumerate(ids)}
    return {"source": "OSRM public demo server (OpenStreetMap), driving profile", "km": km, "hours": hours}


if __name__ == "__main__":
    data = fetch()
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(data, indent=1), encoding="utf-8")
    print(f"Wrote {OUT}")
