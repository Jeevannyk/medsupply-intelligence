import os
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_env(*files: Path) -> None:
    """Minimal .env loader (KEY=value lines). Real environment variables win."""
    for f in files:
        if not f.is_file():
            continue
        for line in f.read_text(encoding="utf-8-sig").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            v = v.strip().strip('"').strip("'")
            if v:
                os.environ.setdefault(k.strip(), v)


load_env(ROOT / ".env", ROOT.parent / ".env")
DB_PATH = Path(os.environ.get("MEDSUPPLY_DB", ROOT / "medsupply.db"))

# "Today" for the simulation. History covers the 120 days before today;
# 14 further days of ground-truth demand are generated but hidden from models.
TODAY = date(2026, 10, 8)
HISTORY_DAYS = 120
FUTURE_DAYS = 14
HORIZON = 14          # forecast horizon (days)
SAFETY_DAYS = 3       # buffer on top of supplier lead time
LONG_HORIZON = 800    # days used when projecting batch expiry
SEED = 2026

OUTBREAK_START = 92   # history day index the outbreak begins
OUTBREAK_MEDICINE = "OSEL"

SCENARIOS = {
    "outbreak": "Outbreak (current)",
    "normal": "No outbreak (counterfactual)",
}

DEFAULT_WEIGHTS = {
    "patient_load": 0.25,
    "emergency": 0.25,
    "criticality": 0.15,
    "no_alternative": 0.15,
    "urgency": 0.20,
}
