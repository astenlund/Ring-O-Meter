"""Unit tests for the capsule-area + Liang-Barsky helpers in _rm_strokes.

Pure-geometric; stdlib-only. Stubs rmscene so _rm_strokes imports
cleanly without the venv (the helpers under test don't touch rmscene,
but the production module imports it at top level).
"""
import math
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))

# Stub rmscene so module import doesn't require the venv.
sys.modules.setdefault("rmscene", MagicMock())
sys.modules.setdefault("rmscene.scene_items", MagicMock())

from _rm_strokes import capsule_area  # noqa: E402


class CapsuleAreaTests(unittest.TestCase):
    """Per-stroke visible-ink area inside a box, for the detector."""

    BOX = (-44.0, 44.0, 0.0, 88.0)  # 88x88 box centered at x=0, y=44

    def test_thin_pen_chord_through_box(self):
        # Arrange: horizontal line crossing the box, endpoints outside.
        points = [(-100.0, 44.0), (100.0, 44.0)]
        width = 4.0

        # Act
        area = capsule_area(points, width, self.BOX)

        # Assert: clipped length 88, width 4, no caps inside; area = 352.
        self.assertAlmostEqual(area, 352.0, delta=0.1)

    def test_marker_single_tap_centered(self):
        # Arrange: 1-point stroke at box center, thick marker.
        points = [(0.0, 44.0)]
        width = 30.0

        # Act
        area = capsule_area(points, width, self.BOX)

        # Assert: caps_fraction = 1 (full disc), area = pi * (W/2)^2.
        expected = math.pi * 15.0 * 15.0
        self.assertAlmostEqual(area, expected, delta=0.1)

    def test_palm_graze_below_threshold(self):
        # Arrange: short stroke just clipping the box edge, thin pen.
        points = [(-50.0, 44.0), (-43.0, 44.0)]
        width = 4.0

        # Act
        area = capsule_area(points, width, self.BOX)

        # Assert: well below 100 .rm^2 threshold.
        self.assertLess(area, 30.0)

    def test_stroke_entirely_outside_box(self):
        # Arrange: stroke 200 units to the right of the box.
        points = [(200.0, 44.0), (300.0, 44.0)]
        width = 4.0

        # Act
        area = capsule_area(points, width, self.BOX)

        # Assert: zero clipped length, zero caps.
        self.assertEqual(area, 0.0)

    def test_stroke_entirely_inside_box(self):
        # Arrange: stroke fully inside box, both endpoints inside.
        points = [(-20.0, 44.0), (20.0, 44.0)]
        width = 4.0

        # Act
        area = capsule_area(points, width, self.BOX)

        # Assert: clipped length 40, both caps inside, area = 40*4 + pi*4.
        expected = 40.0 * 4.0 + math.pi * 4.0
        self.assertAlmostEqual(area, expected, delta=0.1)

    def test_one_endpoint_inside_inflated_box(self):
        # Arrange: half-graze; one endpoint inside box, one outside.
        points = [(-60.0, 44.0), (0.0, 44.0)]
        width = 4.0

        # Act
        area = capsule_area(points, width, self.BOX)

        # Assert: clipped length 44 (from -44 to 0), width 4, one cap.
        expected = 44.0 * 4.0 + 0.5 * math.pi * 4.0
        self.assertAlmostEqual(area, expected, delta=0.1)

    def test_snap_straight_cross_through_box(self):
        # Arrange: snap-to-straight diagonal, endpoints outside.
        # Box diagonal ~125 .rm; thin pen.
        points = [(-100.0, -10.0), (100.0, 100.0)]
        width = 4.0

        # Act
        area = capsule_area(points, width, self.BOX)

        # Assert: clipped diagonal >0, no caps inside, area > 100 (passes).
        self.assertGreater(area, 100.0)


if __name__ == "__main__":
    unittest.main()
