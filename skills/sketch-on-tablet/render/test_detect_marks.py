"""JSON-shape test for the stroke-region checkbox detector.

The only test we ship for the detector itself (per the design spec's
testing strategy: synthetic-fixture tests on the geometry math add
little value; the high-risk failure modes are real-device edge cases
this can't catch). This test locks the JSON output contract - the
keys and types that the polling-loop slice reads.

Stubs rmscene + calibration.json + the .content manifest so the test
runs stdlib-only without the venv and without any real .rm file.

Run:
  python skills/sketch-on-tablet/render/test_detect_marks.py
or:
  python -m unittest discover -s skills/sketch-on-tablet/render -p "test_*.py"
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

import detect_marks  # noqa: E402
from _chrome_boxes import BOX_REGISTRY  # noqa: E402

# Derived rather than literal so a new box in BOX_REGISTRY surfaces here
# at test time instead of silently passing against a stale set.
_EXPECTED_BOX_NAMES = set(BOX_REGISTRY.keys())
_TEST_MIN_AREA_RM_SQ = 100.0  # heuristic: fixture value; matches calibration.json min_area_rm_sq historical default; see detect_page Args


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
            with patch.object(detect_marks, "collect_lines", return_value=[]):
                payload = detect_marks.detect(rm_dir, scale=0.45, min_area_rm_sq=_TEST_MIN_AREA_RM_SQ)
        self.assertEqual(set(payload.keys()), {"per_page"})
        self.assertIsInstance(payload["per_page"], list)

    def test_per_page_boxes_present(self):
        """Each per_page entry exposes the full BOX_REGISTRY with zero defaults."""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            _write_manifest(tmp_path, "doc-uuid", ["page-uuid-1"])
            rm_dir = _make_rm_dir(tmp_path, "doc-uuid", ["page-uuid-1"])

            with patch.object(detect_marks, "collect_lines", return_value=[]):
                output = detect_marks.detect(rm_dir, scale=0.45, min_area_rm_sq=_TEST_MIN_AREA_RM_SQ)

        self.assertIn("per_page", output)
        self.assertEqual(len(output["per_page"]), 1)
        page = output["per_page"][0]
        self.assertEqual(page["page"], 1)
        self.assertIn("boxes", page)
        self.assertEqual(set(page["boxes"].keys()), _EXPECTED_BOX_NAMES)
        for name, box in page["boxes"].items():
            self.assertEqual(box, {"area_rm_sq": 0.0, "marked": False}, f"box {name}")

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
            with patch.object(detect_marks, "collect_lines", return_value=[]):
                payload = detect_marks.detect(rm_dir, scale=0.45, min_area_rm_sq=_TEST_MIN_AREA_RM_SQ)
        self.assertEqual(len(payload["per_page"]), 3)
        # Synthesized entry for never-opened page has all-zero boxes.
        third = payload["per_page"][2]
        self.assertEqual(third["page"], 3)
        self.assertEqual(set(third["boxes"].keys()), _EXPECTED_BOX_NAMES)
        for name, box in third["boxes"].items():
            self.assertEqual(box, {"area_rm_sq": 0.0, "marked": False}, f"box {name}")

    def test_qualifying_stroke_marks_only_its_page(self):
        """Per-page box.marked is true iff a qualifying stroke landed in that box."""
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
                    # Width 4 across ~42 .rm of centerline inside the box
                    # gives capsule area ~180 .rm^2, above the 100 threshold.
                    return [("#000", 4.0, [(1650, 4700), (1660, 4710), (1670, 4720), (1680, 4730)])]
                return [("#000", 2.0, [(0, 0), (10, 10)])]
            with patch.object(detect_marks, "collect_lines", side_effect=fake_collect):
                payload = detect_marks.detect(rm_dir, scale=0.45, min_area_rm_sq=_TEST_MIN_AREA_RM_SQ)
        self.assertFalse(payload["per_page"][0]["boxes"]["finish_turn"]["marked"])
        self.assertTrue(payload["per_page"][1]["boxes"]["finish_turn"]["marked"])


class CapsuleAreaQualificationTests(unittest.TestCase):
    """Stroke qualifies iff its capsule area meets the threshold."""

    def test_palm_graze_does_not_qualify(self):
        # Arrange: tiny stroke whose capsule area is well below threshold.
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            _write_manifest(tmp_path, "doc-uuid", ["page-uuid-1"])
            rm_dir = _make_rm_dir(tmp_path, "doc-uuid", ["page-uuid-1"])
            # 5 .rm length, W=4 -> ~20 .rm^2 capsule area, below 100 threshold.
            tiny_stroke = ("#000000", 4.0, [(-50.0, 44.0), (-43.0, 44.0)])

            with patch.object(detect_marks, "collect_lines", return_value=[tiny_stroke]):
                # Act
                output = detect_marks.detect(rm_dir, scale=0.45, min_area_rm_sq=_TEST_MIN_AREA_RM_SQ)

        # Assert
        self.assertFalse(output["per_page"][0]["boxes"]["finish_turn"]["marked"])

    def test_thick_marker_tap_qualifies(self):
        # Arrange: 1-point stroke with thick marker inside the Finish-turn box.
        # Finish-turn at PDF (1540, 2100) 40x40 -> .rm at scale 0.45:
        # rm_x: (1540-810)/0.45 .. (1580-810)/0.45 = 1622 .. 1711
        # rm_y: 2100/0.45 .. 2140/0.45 = 4667 .. 4756
        # A thick stroke centered there should qualify via cap area.
        tap_stroke = ("#000000", 30.0, [(1666.0, 4711.0)])
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            _write_manifest(tmp_path, "doc-uuid", ["page-uuid-1"])
            rm_dir = _make_rm_dir(tmp_path, "doc-uuid", ["page-uuid-1"])

            with patch.object(detect_marks, "collect_lines", return_value=[tap_stroke]):
                # Act
                output = detect_marks.detect(rm_dir, scale=0.45, min_area_rm_sq=_TEST_MIN_AREA_RM_SQ)

        # Assert: caps_fraction=1, area = pi*15^2 ~ 707; passes 100 threshold.
        self.assertTrue(output["per_page"][0]["boxes"]["finish_turn"]["marked"])

    def test_mode_bw_marked_isolated(self):
        # Arrange: stroke clearly inside the B&W box, not in others.
        # B&W at PDF (240, 2100) 40x40 -> .rm at scale 0.45:
        # rm_x: (240-810)/0.45 .. (280-810)/0.45 = -1267 .. -1178
        # rm_y: 2100/0.45 .. 2140/0.45 = 4667 .. 4756
        bw_stroke = ("#000000", 30.0, [(-1222.0, 4711.0)])
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            _write_manifest(tmp_path, "doc-uuid", ["page-uuid-1"])
            rm_dir = _make_rm_dir(tmp_path, "doc-uuid", ["page-uuid-1"])

            with patch.object(detect_marks, "collect_lines", return_value=[bw_stroke]):
                output = detect_marks.detect(rm_dir, scale=0.45, min_area_rm_sq=_TEST_MIN_AREA_RM_SQ)

        boxes = output["per_page"][0]["boxes"]
        self.assertTrue(boxes["mode_bw"]["marked"])
        self.assertFalse(boxes["mode_color"]["marked"])
        self.assertFalse(boxes["mode_wireframe"]["marked"])
        self.assertFalse(boxes["finish_turn"]["marked"])
        self.assertFalse(boxes["end_session"]["marked"])

    def test_end_session_marked_by_qualifying_stroke(self):
        # Arrange: stroke that lands clearly inside the End-session box.
        # End-session at PDF (1540, 2040) 40x40 -> .rm box at scale 0.45:
        # rm_x: (1540-810)/0.45 .. (1580-810)/0.45 = ~1622 .. ~1711
        # rm_y: 2040/0.45 .. 2080/0.45 = ~4533 .. ~4622
        big_stroke = ("#000000", 30.0, [(1666.0, 4577.0)])
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            _write_manifest(tmp_path, "doc-uuid", ["page-uuid-1"])
            rm_dir = _make_rm_dir(tmp_path, "doc-uuid", ["page-uuid-1"])

            with patch.object(detect_marks, "collect_lines", return_value=[big_stroke]):
                output = detect_marks.detect(rm_dir, scale=0.45, min_area_rm_sq=_TEST_MIN_AREA_RM_SQ)

        boxes = output["per_page"][0]["boxes"]
        self.assertTrue(boxes["end_session"]["marked"])
        self.assertGreater(boxes["end_session"]["area_rm_sq"], 100.0)
        self.assertFalse(boxes["finish_turn"]["marked"])


class PageUuidsFromManifestTests(unittest.TestCase):
    """Direct tests of page_uuids_from_manifest's delegation to manifest_pages.

    These cover schema branches (legacy) and error paths (missing file,
    bad JSON, no recognised pages). Called via page_uuids_from_manifest()
    rather than manifest_pages() directly because the test file's
    fixture environment is already wired for the detect_marks side.
    """

    def test_legacy_schema_returns_uuids_in_order(self):
        # Arrange: legacy-schema .content (no cPages; top-level pages[]).
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            content_path = tmp_path / "doc-uuid.content"
            content_path.write_text(
                json.dumps({"pages": ["uuid1", "uuid2"], "redirectionPageMap": [0, 1]}),
                encoding="utf-8",
            )
            rm_dir = tmp_path / "doc-uuid"
            rm_dir.mkdir()

            # Act
            result = detect_marks.page_uuids_from_manifest(rm_dir)

        # Assert
        self.assertEqual(result, ["uuid1", "uuid2"])

    def test_no_pages_raises_manifest_error(self):
        # Arrange: valid JSON but neither cPages nor top-level pages[].
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            content_path = tmp_path / "doc-uuid.content"
            content_path.write_text(json.dumps({"someOtherKey": "value"}), encoding="utf-8")
            rm_dir = tmp_path / "doc-uuid"
            rm_dir.mkdir()

            # Act / Assert
            with self.assertRaises(detect_marks.ManifestError) as ctx:
                detect_marks.page_uuids_from_manifest(rm_dir)
        self.assertIn("no pages found", str(ctx.exception))

    def test_missing_content_file_raises_manifest_error(self):
        # Arrange: rm_dir with no sibling .content file at all.
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            rm_dir = tmp_path / "doc-uuid"
            rm_dir.mkdir()

            # Act / Assert
            with self.assertRaises(detect_marks.ManifestError) as ctx:
                detect_marks.page_uuids_from_manifest(rm_dir)
        self.assertIn("not found", str(ctx.exception))

    def test_bad_json_raises_manifest_error(self):
        # Arrange: .content file with malformed JSON.
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            content_path = tmp_path / "doc-uuid.content"
            content_path.write_text("not valid json", encoding="utf-8")
            rm_dir = tmp_path / "doc-uuid"
            rm_dir.mkdir()

            # Act / Assert
            with self.assertRaises(detect_marks.ManifestError) as ctx:
                detect_marks.page_uuids_from_manifest(rm_dir)
        self.assertIn("invalid JSON", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
