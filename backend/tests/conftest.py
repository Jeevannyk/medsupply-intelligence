import os
import tempfile
from pathlib import Path

os.environ["MEDSUPPLY_DB"] = str(Path(tempfile.gettempdir()) / "medsupply_test.db")
# An empty value stops app.config from loading a real key from .env, so tests never call Gemini.
os.environ["GEMINI_API_KEY"] = ""
