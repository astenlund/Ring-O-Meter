"""JSON-shape test for the stroke-region Finish-turn detector.

The only test we ship for the detector itself (per the design spec's
testing strategy: synthetic-fixture tests on the geometry math add
little value; the high-risk failure modes are real-device edge cases
this can't catch). This test locks the JSON output contract - the
keys and types that the future polling-loop slice will read.

Stubs rmscene + calibration.json + the .content manifest so the test
runs stdlib-only without the venv and without any real .rm file.

Run:
  python skills/sketch-brainstorm/render/test_detect_finish_turn.py
or:
  python -m unittest discover -s skills/sketch-brainstorm/render -p "test_*.py"
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))

# Stub rmscene so module import doesn't require the venv.
sys.modules.setdefault("rmscene", MagicMock())
sys.modules.setdefault("rmscene.scene_items", MagicMock())

import detect_finish_turn  # noqa: E402


def _write_manifest(parent_dir, uuid, page_uuids):
    """Write a minimal <uuid>.content sibling to parent_dir."""
    content_path = parent_dir / f"{uuid}.content"
    content_path.write_text(
        json.dumps({"cPages": {"pages": [{"id": pid} for pid in page_uuids]}}),
        encoding="utf-8",
    )


def _make_rm_dir(parent_dir, uuid, page_uuids):
    """Create a rm-dir with empty <page_uuid>.rm files."""
    rm_dir = parent_dir / uuid
    rm_dir.mkdir()
    for pid in page_uuids:
        (rm_dir / f"{pid}.rm").touch()
    return rm_dir


class JsonShapeTests(unittest.TestCase):
    """Lock the detector's JSON output schema."""

    def test_top_level_keys(self):
        """Output has exactly the expected top-level keys with correct types."""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            _write_manifest(tmp_path, "doc-uuid", ["page-uuid-1", "page-uuid-2"])
            rm_dir = _make_rm_dir(tmp_path, "doc-uuid", ["page-uuid-1", "page-uuid-2"])
            with patch.object(detect_finish_turn, "collect_lines", return_value=[]):
                payload = detect_finish_turn.detect(rm_dir, scale=0.45)
        self.assertEqual(set(payload.keys()), {"marked", "per_page"})
        self.assertIsInstance(payload["marked"], bool)
        self.assertIsInstance(payload["per_page"], list)

    def test_per_page_entry_keys(self):
        """Each per_page entry has the expected keys with correct types."""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            _write_manifest(tmp_path, "doc-uuid", ["page-uuid-1"])
            rm_dir = _make_rm_dir(tmp_path, "doc-uuid", ["page-uuid-1"])
            with patch.object(detect_finish_turn, "collect_lines", return_value=[]):
                payload = detect_finish_turn.detect(rm_dir, scale=0.45)
        self.assertEqual(len(payload["per_page"]), 1)
        entry = payload["per_page"][0]
        self.assertEqual(set(entry.keys()), {"page", "marked", "hit_strokes", "total_strokes"})
        self.assertIsInstance(entry["page"], int)
        self.assertIsInstance(entry["marked"], bool)
        self.assertIsInstance(entry["hit_strokes"], int)
        self.assertIsInstance(entry["total_strokes"], int)

    def test_per_page_length_from_manifest(self):
        """per_page length comes from the manifest, not from .rm file presence."""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            # Manifest declares 3 pages; rm-dir only has files for 2.
            _write_manifest(tmp_path, "doc-uuid", ["p1", "p2", "p3-never-opened"])
            rm_dir = tmp_path / "doc-uuid"
            rm_dir.mkdir()
            (rm_dir / "p1.rm").touch()
            (rm_dir / "p2.rm").touch()
            with patch.object(detect_finish_turn, "collect_lines", return_value=[]):
                payload = detect_finish_turn.detect(rm_dir, scale=0.45)
        self.assertEqual(len(payload["per_page"]), 3)
        # Synthesized entry for never-opened page has 0 strokes total.
        third = payload["per_page"][2]
        self.assertEqual(third["page"], 3)
        self.assertFalse(third["marked"])
        self.assertEqual(third["hit_strokes"], 0)
        self.assertEqual(third["total_strokes"], 0)

    def test_marked_is_or_across_pages(self):
        """Top-level `marked` is true iff any page is marked."""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            _write_manifest(tmp_path, "doc-uuid", ["p1", "p2"])
            rm_dir = _make_rm_dir(tmp_path, "doc-uuid", ["p1", "p2"])

            # First page strokes don't hit the box; second page has one stroke
            # with 4 points all inside the Finish-turn .rm rectangle.
            def fake_collect(rm_file):
                if rm_file.name.startswith("p2"):
                    # At scale 0.45, the Finish-turn box .rm rectangle is
                    # roughly (730/0.45, 770/0.45) x (2100/0.45, 2140/0.45)
                    # = (~1622, ~1711) x (~4667, ~4756). Use 4 points well
                    # inside that range.
                    return [("#000", 2.0, [(1650, 4700), (1660, 4710), (1670, 4720), (1680, 4730)])]
                return [("#000", 2.0, [(0, 0), (10, 10)])]
            with patch.object(detect_finish_turn, "collect_lines", side_effect=fake_collect):
                payload = detect_finish_turn.detect(rm_dir, scale=0.45)
        self.assertTrue(payload["marked"])
        self.assertFalse(payload["per_page"][0]["marked"])
        self.assertTrue(payload["per_page"][1]["marked"])


if __name__ == "__main__":
    unittest.main()
