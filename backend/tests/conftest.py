import os
import tempfile
from pathlib import Path

os.environ["MEDSUPPLY_DB"] = str(Path(tempfile.gettempdir()) / "medsupply_test.db")
# An empty value stops app.config from loading a real key from .env, so tests never call Gemini.
os.environ["GEMINI_API_KEY"] = ""

# The mock courier service keeps its own database, separate from the app's.
os.environ["CARRIER_DB"] = str(Path(tempfile.gettempdir()) / "carrier_test.db")
os.environ["CARRIER_KEY"] = "carrier-demo-key"

# Trips arrive instantly in tests; the ones that test the travel time set their own value.
os.environ["LOGISTICS_TRAVEL_SECONDS"] = "0"

# The tests start from an empty network; the seeding itself is tested on its own.
os.environ["MEDSUPPLY_SEED_HISTORY"] = "0"
