"""Unit tests for _calibration.py schema validation.

stdlib-only; no venv required.

Run:
  python skills/sketch-on-tablet/render/test_calibration.py
or:
  python -m unittest discover -s skills/sketch-on-tablet/render -p "test_*.py"
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))

import _calibration  # noqa: E402


class LoadCalibrationSchemaTests(unittest.TestCase):
    """load_calibration must reject schema_version values it doesn't
    understand so an old reader never silently misprojects a calibration
    written under a future formula."""

    def _load_with_json(self, payload: dict):
        """Write payload to a temp calibration.json, patch CALIBRATION_JSON to
        point at it, call load_calibration(), and return the result (or raise)."""
        with tempfile.TemporaryDirectory() as tmp:
            f = Path(tmp) / "calibration.json"
            f.write_text(json.dumps(payload), encoding="utf-8")
            with patch.object(_calibration, "CALIBRATION_JSON", f):
                return _calibration.load_calibration()

    def test_load_calibration_rejects_future_schema(self):
        with self.assertRaises(_calibration.CalibrationError) as cm:
            self._load_with_json({"schema_version": 3, "scale": 0.42284})
        self.assertIn("schema_version", str(cm.exception))

    def test_load_calibration_rejects_v1_missing_schema(self):
        with self.assertRaises(_calibration.CalibrationError):
            self._load_with_json({"scale": 0.42284})

    def test_load_calibration_accepts_current_schema(self):
        data = self._load_with_json({"schema_version": 2, "scale": 0.42284})
        self.assertEqual(data["scale"], 0.42284)


if __name__ == "__main__":
    unittest.main()
