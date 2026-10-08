import os
import tempfile
from pathlib import Path

os.environ["MEDSUPPLY_DB"] = str(Path(tempfile.gettempdir()) / "medsupply_test.db")
os.environ.pop("GEMINI_API_KEY", None)
