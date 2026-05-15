"""Unit tests for the capsule-area + Liang-Barsky helpers in _geometry.

Pure-geometric; stdlib-only. `_geometry` has no runtime dependencies
beyond `math`, so the venv is not required.
"""
import math
import sys
import unittest
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))

from _geometry import capsule_area, points_bbox  # noqa: E402


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


class BboxPreFilterTests(unittest.TestCase):
    """Capsule area returns 0.0 when stroke bbox can't possibly overlap box."""

    BOX = (0.0, 5.0, 0.0, 5.0)  # 5x5 box at origin

    def test_stroke_fully_left_of_box(self):
        # Arrange: stroke entirely to the left of the inflated box.
        points = [(-10.0, 0.0), (-5.0, 0.0)]
        width = 1.0

        # Act
        area = capsule_area(points, width, self.BOX)

        # Assert: bbox pre-filter short-circuits to 0.0.
        self.assertEqual(area, 0.0)

    def test_stroke_fully_above_box(self):
        # Arrange: stroke entirely above the inflated box (y > 5+0.5).
        points = [(2.0, 20.0), (3.0, 20.0)]
        width = 1.0

        # Act
        area = capsule_area(points, width, self.BOX)

        # Assert
        self.assertEqual(area, 0.0)

    def test_single_point_tap_inside_inflated_box(self):
        # Arrange: single-point stroke clearly inside the box.
        points = [(2.0, 2.0)]
        width = 2.0

        # Act
        area = capsule_area(points, width, self.BOX)

        # Assert: full cap disc (caps_fraction = 1), area = pi * (W/2)^2.
        expected = math.pi * 1.0 * 1.0
        self.assertAlmostEqual(area, expected, delta=0.1)

    def test_single_point_tap_outside_inflated_box(self):
        # Arrange: single-point stroke well outside the box, even after
        # inflation by W/2 = 1.0.
        points = [(20.0, 20.0)]
        width = 2.0

        # Act
        area = capsule_area(points, width, self.BOX)

        # Assert: bbox pre-filter returns 0.0. This also verifies
        # points_bbox returns a degenerate (20, 20, 20, 20) for a
        # single point (not None - would raise TypeError on unpack).
        self.assertEqual(area, 0.0)

    def test_stroke_bbox_grazes_inflated_box(self):
        # Arrange: stroke just inside the inflated box on one axis.
        # W=2 inflates box by 1 on each side: effective box (-1, 6, -1, 6).
        # Stroke at y=-0.5 grazes the inflated bottom edge.
        points = [(2.0, -0.5), (3.0, -0.5)]
        width = 2.0

        # Act
        area = capsule_area(points, width, self.BOX)

        # Assert: pre-filter does NOT short-circuit (bboxes overlap);
        # Liang-Barsky produces a non-zero (small) area.
        self.assertGreater(area, 0.0)


class PointsBboxTests(unittest.TestCase):
    """Direct tests of points_bbox helper."""

    def test_empty_list_returns_none(self):
        self.assertIsNone(points_bbox([]))

    def test_single_point_returns_degenerate_bbox(self):
        self.assertEqual(points_bbox([(5.0, 7.0)]), (5.0, 5.0, 7.0, 7.0))

    def test_multi_point_returns_min_max(self):
        self.assertEqual(
            points_bbox([(1.0, 4.0), (3.0, 2.0), (-1.0, 6.0)]),
            (-1.0, 3.0, 2.0, 6.0),
        )


if __name__ == "__main__":
    unittest.main()
