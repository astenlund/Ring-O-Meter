"""Fixture smoke test for the calibration derivation.

Re-derives the scale from the committed reference .rmdoc and
verifies it matches the saved calibration.json within +/- 0.001.
This catches geometry-math regressions cheaply; per the design
spec's testing strategy, this is the only behavior-level test
shipped for the derivation.

Unlike test_detect_marks.py (which stubs rmscene), this
test actually parses the real .rmdoc through rmscene and uses
scipy for the Hungarian assignment, so it requires the venv.

Run via the venv's python:
  skills/sketch-brainstorm/.venv/Scripts/python.exe \\
    skills/sketch-brainstorm/render/test_derive_calibration.py
Bootstrap the venv first by running any skill wrapper (e.g. render-strokes.sh),
then re-run with the venv's python directly.
"""
import json
import os
import re
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))

import derive_calibration  # noqa: E402

_SKILL_ROOT = _HERE.parent
_FIXTURES_DIR = _SKILL_ROOT / "test-fixtures"
_CALIBRATION_JSON = _SKILL_ROOT / "calibration.json"
_DOC_UUID_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
)


def _resolve_fixture():
    """Find the calibration .rmdoc in test-fixtures/. Returns None
    if calibration.json or the fixture is absent (test will skip).

    Single-fixture model: there's exactly one committed calibration
    at any time; multi-fixture archival (older firmwares alongside
    newer) is YAGNI until a real firmware update happens.
    """
    if not _CALIBRATION_JSON.exists():
        return None
    if not _FIXTURES_DIR.is_dir():
        return None
    rmdocs = list(_FIXTURES_DIR.glob("calibration-*.rmdoc"))

    return rmdocs[0] if rmdocs else None


def _extract_rm_dir(rmdoc_path, target_dir):
    """Unzip the .rmdoc into target_dir and return the inner rm-dir.

    Mirrors pull-from-tablet.sh's extraction logic: annotated .rmdoc
    archives have a nested <doc-uuid>/ subdirectory containing the
    per-page .rm files. Prefer a UUID-named directory when present so
    a future firmware shipping a flat or multi-dir layout surfaces a
    clear diagnostic instead of returning an unrelated sibling.
    """
    target_dir = Path(target_dir).resolve()
    with zipfile.ZipFile(rmdoc_path) as z:
        for member in z.namelist():
            member_path = (target_dir / member).resolve()
            if not str(member_path).startswith(str(target_dir) + os.sep):
                raise RuntimeError(f"zip slip detected: {member!r} would escape target dir")
        z.extractall(target_dir)
    dirs = [e for e in target_dir.iterdir() if e.is_dir()]
    uuid_dirs = [d for d in dirs if _DOC_UUID_RE.fullmatch(d.name)]
    if uuid_dirs:
        return uuid_dirs[0]
    if len(dirs) == 1:
        return dirs[0]
    raise RuntimeError(
        f"unrecognised .rmdoc layout in {rmdoc_path}: "
        f"expected a doc-UUID directory or a single nested directory; "
        f"found {[d.name for d in dirs]}"
    )


@unittest.skipIf(_resolve_fixture() is None, "no committed calibration fixture")
class FixtureScaleSmokeTests(unittest.TestCase):
    """Re-derive scale from the committed .rmdoc and assert it matches
    the saved calibration.json within a tight tolerance."""

    def test_scale_matches_saved(self):
        fixture = _resolve_fixture()
        saved = json.loads(_CALIBRATION_JSON.read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            rm_dir = _extract_rm_dir(fixture, tmp_path)
            payload = derive_calibration.derive(rm_dir, saved["firmware_note"])
        # +/- 0.001 catches geometry-math regressions; tighter would
        # break on floating-point reordering.
        self.assertAlmostEqual(payload["scale"], saved["scale"], delta=0.001)

    def test_residuals_under_threshold(self):
        """All per-dot residuals should be under 3 px in the re-derivation."""
        fixture = _resolve_fixture()
        saved = json.loads(_CALIBRATION_JSON.read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            rm_dir = _extract_rm_dir(fixture, tmp_path)
            payload = derive_calibration.derive(rm_dir, saved["firmware_note"])
        for label, residual in payload["residuals_px"].items():
            self.assertLess(residual, 3.0, f"residual at {label} = {residual} px")


if __name__ == "__main__":
    unittest.main()
