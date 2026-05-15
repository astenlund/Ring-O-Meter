"""Geometric primitives: capsule-area integral and Liang-Barsky clip.

Dependency-free at import time (math only). Consumers:
  - detect_marks.py: per-stroke capsule area inside each chrome-footer
    checkbox region.

Lives separately from `_rm_strokes.py` so consumers can use these
primitives without dragging in `rmscene`. The stdlib-only test
`test_geometry.py` exercises them directly without bootstrapping the
skill venv.
"""
import math


def points_bbox(points):
    """Axis-aligned bounding box of a point list as (x_min, x_max, y_min, y_max).

    Returns None for an empty list. For a single-point list returns a
    degenerate bbox (x, x, y, y) - the overlap test against an inflated
    box then reduces to the same check as _point_in_box.
    """
    if not points:
        return None
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]

    return min(xs), max(xs), min(ys), max(ys)


def capsule_area(points, width, box):
    """Compute the visible inked area of a stroke inside a box.

    Models the stroke as a capsule: rectangle along the centerline of
    width W, plus half-disc caps of radius W/2 at the pen-down and
    pen-up endpoints. The portion of this shape that falls inside
    `box` is the visible inked area.

    Args:
        points: list of (x, y) tuples in .rm coordinates. May be empty,
            single-point (marker tap), or multi-point.
        width: stroke width in .rm units (W).
        box: (x_min, x_max, y_min, y_max) in .rm coordinates.

    Returns:
        Total capsule area inside box as a float. Returns 0.0 for an
        empty point list.

    Formula:
        area = clipped_centerline_length * W + caps_fraction * pi*(W/2)^2
    where:
      - clipped_centerline_length is sum of segment portions inside box
        (Liang-Barsky per segment).
      - caps_fraction in {0, 1/2, 1} reflects how many of the two
        terminal endpoints (pen-down, pen-up) fall inside the box
        inflated by W/2. For 1-point strokes pen-down and pen-up
        coincide, so caps_fraction collapses to 1 (full disc).
    """
    if not points:
        return 0.0

    x_min, x_max, y_min, y_max = box

    # Pre-filter: if the stroke's axis-aligned bbox doesn't overlap the
    # target box inflated by W/2 on each side, neither the clipped
    # centerline nor the cap discs can intersect; return 0.0 without
    # running Liang-Barsky per segment. Saves work in the common case
    # where most strokes miss most boxes (5 boxes x hundreds of strokes
    # per page).
    stroke_x_min, stroke_x_max, stroke_y_min, stroke_y_max = points_bbox(points)
    inflate = width / 2.0
    if (stroke_x_max < x_min - inflate or stroke_x_min > x_max + inflate
            or stroke_y_max < y_min - inflate or stroke_y_min > y_max + inflate):
        return 0.0

    clipped_length = 0.0
    for i in range(len(points) - 1):
        clipped = _liang_barsky_clip(points[i], points[i + 1], x_min, x_max, y_min, y_max)
        if clipped is not None:
            (cx1, cy1), (cx2, cy2) = clipped
            clipped_length += math.hypot(cx2 - cx1, cy2 - cy1)

    inflated = (x_min - width / 2, x_max + width / 2, y_min - width / 2, y_max + width / 2)
    if len(points) == 1:
        caps_fraction = 1.0 if _point_in_box(points[0], inflated) else 0.0
    else:
        n_inside = 0
        if _point_in_box(points[0], inflated):
            n_inside += 1
        if _point_in_box(points[-1], inflated):
            n_inside += 1
        caps_fraction = n_inside / 2.0

    cap_area = caps_fraction * math.pi * (width / 2.0) ** 2

    return clipped_length * width + cap_area


def _liang_barsky_clip(p1, p2, x_min, x_max, y_min, y_max):
    """Clip segment (p1, p2) to rectangle [x_min, x_max] x [y_min, y_max].

    Returns clipped endpoints as ((x1', y1'), (x2', y2')) or None if the
    segment is entirely outside the box. Standard Liang-Barsky.
    """
    x1, y1 = p1
    x2, y2 = p2
    dx = x2 - x1
    dy = y2 - y1
    t0, t1 = 0.0, 1.0

    for p, q in ((-dx, x1 - x_min), (dx, x_max - x1), (-dy, y1 - y_min), (dy, y_max - y1)):
        if p == 0:
            if q < 0:
                return None
            continue
        t = q / p
        if p < 0:
            if t > t1:
                return None
            if t > t0:
                t0 = t
        else:
            if t < t0:
                return None
            if t < t1:
                t1 = t

    return ((x1 + t0 * dx, y1 + t0 * dy), (x1 + t1 * dx, y1 + t1 * dy))


def _point_in_box(point, box):
    """Inclusive containment test."""
    x, y = point
    x_min, x_max, y_min, y_max = box

    return x_min <= x <= x_max and y_min <= y <= y_max
