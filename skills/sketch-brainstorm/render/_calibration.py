"""Calibration file location and schema management.

Single source of truth for the calibration.json path, schema version,
error type, and loader. Extracted from _rm_strokes so consumers that
only need calibration don't transitively pull in rmscene.
"""
import json
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parent.parent
CALIBRATION_JSON = SKILL_ROOT / "calibration.json"
# Bump this and the load_calibration guard together whenever the
# inverse-transform formula changes (e.g., a y_offset field is added).
CALIBRATION_SCHEMA_VERSION = 2


class CalibrationError(Exception):
    """Raised when calibration.json is missing, invalid, or unparseable."""


def load_calibration():
    """Load and validate CALIBRATION_JSON.

    Raises CalibrationError on missing file, invalid JSON, an unknown
    schema_version, or an invalid scale value. Callers translate to a
    non-zero exit + diagnostic in their `main()`.

    schema_version contract: missing -> v1 (back-compat with calibrations
    written before the field was introduced); 2 -> the linear
    `pdf_y = cy * scale` inverse-transform plus heuristic fields;
    anything else -> reject so an old calibration cannot silently
    misproject under new math. The schema check fires before the scale
    check so a hypothetical v3 file dropping `scale` produces
    'regenerate calibration' guidance, not a misleading 'missing scale'
    diagnostic.
    """
    if not CALIBRATION_JSON.exists():
        raise CalibrationError(
            f"calibration.json not found at {CALIBRATION_JSON}; "
            f"run derive-calibration.sh first"
        )
    try:
        data = json.loads(CALIBRATION_JSON.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise CalibrationError(
            f"calibration.json is not valid JSON ({e}); re-run derive-calibration.sh"
        ) from e
    # Default must be the literal 1 (the version implied by absence of the field
    # for files written before schema_version was introduced), NOT the constant.
    # Using the constant as default would silently read pre-field files under
    # the wrong semantics whenever CALIBRATION_SCHEMA_VERSION is bumped.
    schema_version = data.get("schema_version", 1)
    if schema_version != CALIBRATION_SCHEMA_VERSION:
        raise CalibrationError(
            f"calibration.json schema_version={schema_version!r} not supported by this "
            f"reader (expected {CALIBRATION_SCHEMA_VERSION}); re-run derive-calibration.sh to regenerate"
        )
    scale = data.get("scale")
    if not isinstance(scale, (int, float)) or scale <= 0:
        raise CalibrationError(
            "calibration.json missing or invalid 'scale'; re-run derive-calibration.sh"
        )
    data.setdefault("fill_luminance_threshold", 160)
    data.setdefault("fill_ratio_threshold", 0.3)
    data.setdefault("winner_margin", 0.15)
    data.setdefault("min_area_rm_sq", 100.0)

    return data
