"""Fetch the real road geometry between every pair of hospitals (OSRM, OpenStreetMap data).

Writes app/data/road_paths.json: for each pair "A-B" (A before B) the driving route as [lat, lon] points, simplified so
the file stays small.  The Logistics map drives its trucks along these roads.  Run once and commit the result.

Run:  python -m app.fetch_road_paths
"""
import json
import math
import time
from pathlib import Path

import httpx

from .generate import HOSPITALS

OUT = Path(__file__).resolve().parent / "data" / "road_paths.json"
URL = "https://router.project-osrm.org/route/v1/driving/{a};{b}"
TOLERANCE_M = 12.0            # drop points that deviate less than this from the straight line between their neighbours


def metres(p: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
    """Distance of p from segment a-b, in metres (local flat approximation, fine at this scale)."""
    k = 111_320.0
    cos = math.cos(math.radians(a[0]))
    px, py, ax, ay, bx, by = p[1] * k * cos, p[0] * k, a[1] * k * cos, a[0] * k, b[1] * k * cos, b[0] * k
    dx, dy = bx - ax, by - ay
    t = 0.0 if dx == dy == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def simplify(pts: list[tuple[float, float]], tol: float = TOLERANCE_M) -> list[tuple[float, float]]:
    """Douglas-Peucker, iterative so very long routes cannot overflow the stack."""
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        lo, hi = stack.pop()
        far, at = 0.0, -1
        for i in range(lo + 1, hi):
            d = metres(pts[i], pts[lo], pts[hi])
            if d > far:
                far, at = d, i
        if at >= 0 and far > tol:
            keep[at] = True
            stack += [(lo, at), (at, hi)]
    return [p for p, k in zip(pts, keep) if k]


def fetch() -> dict:
    paths: dict[str, list[list[float]]] = {}
    for i, a in enumerate(HOSPITALS):
        for b in HOSPITALS[i + 1:]:
            r = httpx.get(URL.format(a=f"{a[4]},{a[3]}", b=f"{b[4]},{b[3]}"),
                          params={"overview": "full", "geometries": "geojson"},
                          headers={"User-Agent": "singularity-hackathon-data/1.0"}, timeout=60)
            r.raise_for_status()
            data = r.json()
            if data.get("code") != "Ok":
                raise RuntimeError(f"OSRM error for {a[0]}-{b[0]}: {data.get('code')}")
            pts = [(lat, lon) for lon, lat in data["routes"][0]["geometry"]["coordinates"]]
            paths[f"{a[0]}-{b[0]}"] = [[round(lat, 5), round(lon, 5)] for lat, lon in simplify(pts)]
            print(f"{a[0]}-{b[0]}: {len(pts)} -> {len(paths[f'{a[0]}-{b[0]}'])} points")
            time.sleep(1.1)          # be polite to the public demo server
    return {"source": "OSRM public demo server (OpenStreetMap), driving profile, simplified to ~12 m", "paths": paths}


if __name__ == "__main__":
    data = fetch()
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {OUT} ({OUT.stat().st_size // 1024} KB)")
