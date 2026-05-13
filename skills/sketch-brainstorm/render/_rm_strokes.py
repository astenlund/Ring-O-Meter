"""Shared .rm parsing and coordinate-system constants.

Single source of truth for `.rm`-stroke parsing, pen color mapping,
and Paper Pro viewport constants. Consumers:
  - render-strokes.py: produces SVG overlays from strokes.
  - derive_calibration.py: reduces strokes to centroids for the
    five-dot calibration ceremony.
  - detect_marks.py: computes per-stroke capsule area inside each
    chrome-footer checkbox region (Finish-turn, End-session, mode-
    switch trio).

The .rm coordinate system is center-origin in x (positive = right),
top-origin in y (positive = downward, same direction as PDF), and
records at higher resolution than the PDF renders at. The exact
scale is firmware-versioned and lives in calibration.json; this
module is scale-agnostic.

Page ordering: .rm filenames are random UUIDs, so alphabetical sort
scrambles annotations relative to PDF page order. The .rmdoc
archive's sibling <doc-uuid>.content file lists pages in authoring
order with a `redir.value` field giving each page's index in the
underlying PDF. We read that mapping so consumers can land each
page's data on the matching PDF page.
"""
import json
import math
import sys
from pathlib import Path

from rmscene import read_tree, scene_items

PAGE_W = 1620
PAGE_H = 2160

# Skill root + calibration.json path. Centralized so consumers don't
# duplicate the `parent.parent` walk; if the layout ever changes, only
# one site needs updating.
SKILL_ROOT = Path(__file__).resolve().parent.parent
CALIBRATION_JSON = SKILL_ROOT / "calibration.json"

PEN_COLORS = {
    # rmscene.scene_items.PenColor enum -> on-screen hex.
    # Preserving color is load-bearing: the vocabulary uses red for
    # Remove and green for Add as optional emphasis. Flattening to
    # black makes those gestures unreadable from the composite.
    0: "#000000",   # BLACK
    1: "#888888",   # GRAY
    2: "#ffffff",   # WHITE
    3: "#e0c020",   # YELLOW
    4: "#1b8b40",   # GREEN
    5: "#e060a0",   # PINK
    6: "#2060d0",   # BLUE
    7: "#d22020",   # RED
    8: "#888888",   # GRAY_OVERLAP (highlighter-like grey)
    9: "#fff080",   # HIGHLIGHT (translucent yellow rendered opaque)
    10: "#1b8b40",  # GREEN_2
    11: "#20c0c0",  # CYAN
    12: "#c020c0",  # MAGENTA
    13: "#e0c020",  # YELLOW_2
}


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

    # Clipped centerline length: sum across each (point[i], point[i+1]) segment.
    clipped_length = 0.0
    for i in range(len(points) - 1):
        clipped = _liang_barsky_clip(points[i], points[i + 1], x_min, x_max, y_min, y_max)
        if clipped is not None:
            (cx1, cy1), (cx2, cy2) = clipped
            clipped_length += math.hypot(cx2 - cx1, cy2 - cy1)

    # Cap contributions: box inflated by W/2 on each side; count terminal
    # endpoints inside the inflated rectangle.
    inflated = (x_min - width / 2, x_max + width / 2, y_min - width / 2, y_max + width / 2)
    if len(points) == 1:
        # 1-point stroke: pen-down and pen-up coincide; a single point
        # inside the inflated box yields a full disc (caps_fraction = 1).
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
                return None  # parallel to boundary and outside
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


def collect_lines(rm_file: Path) -> list[tuple[str, float, list[tuple[float, float]]]]:
    """Return a list of (color, width, points) tuples for all strokes."""
    with open(rm_file, "rb") as f:
        tree = read_tree(f)
    lines = []
    for node in tree.walk():
        if isinstance(node, scene_items.Line):
            raw_color = getattr(node, "color", 0)
            if raw_color not in PEN_COLORS:
                print(f"warning: unknown pen color {raw_color!r}; rendering as black", file=sys.stderr)
            color = PEN_COLORS.get(raw_color, PEN_COLORS[0])
            width = max(1.0, getattr(node, "thickness_scale", 1.0) * 2)
            pts = [(p.x, p.y) for p in node.points]
            lines.append((color, width, pts))

    return lines


def _page_order_modern(rm_dir, data):
    """formatVersion>=2 style: cPages.pages[] objects with id + redir."""
    cpages = data.get("cPages") or {}
    pages = cpages.get("pages") or []
    ordered = []
    for i, page in enumerate(pages):
        page_id = page.get("id")
        redir = (page.get("redir") or {}).get("value")
        if page_id is None:
            continue
        rm_file = rm_dir / f"{page_id}.rm"
        if not rm_file.exists():
            # No .rm file means the page has no annotations; skip for
            # rendering. Note: detect_finish_turn.page_uuids_from_manifest
            # intentionally does NOT apply this filter so per_page length
            # matches the manifest's full page count regardless of .rm presence.
            continue
        if redir is not None and not isinstance(redir, int):
            print(
                f"warning: page {i} redir.value has unexpected type "
                f"{type(redir).__name__!r} (expected int); "
                f"falling back to position {i}",
                file=sys.stderr,
            )
            redir = None
        pdf_index = redir if isinstance(redir, int) else i
        ordered.append((pdf_index, rm_file))

    return ordered


def _page_order_legacy(rm_dir, data):
    """formatVersion 1 style: top-level pages[] + redirectionPageMap[]."""
    page_ids = data.get("pages") or []
    redir_map = data.get("redirectionPageMap") or []
    ordered = []
    for i, page_id in enumerate(page_ids):
        if not isinstance(page_id, str):
            continue
        rm_file = rm_dir / f"{page_id}.rm"
        if not rm_file.exists():
            # Same filter as _page_order_modern; see note there.
            continue
        pdf_index = redir_map[i] if i < len(redir_map) and isinstance(redir_map[i], int) else i
        ordered.append((pdf_index, rm_file))

    return ordered


def ordered_rm_files(rm_dir: Path) -> list[tuple[int, Path]]:
    """Return [(pdf_page_index, rm_file)] in PDF-page order.

    Reads the .rmdoc archive's <doc-uuid>.content sibling file (where
    rm_dir.name is the doc UUID). Two schemas observed in the wild;
    falls back to alphabetical filename sort with a warning if neither
    produces pages.
    """
    content_file = rm_dir.parent / f"{rm_dir.name}.content"
    ordered = []
    if content_file.exists():
        try:
            data = json.loads(content_file.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            print(
                f"warning: {content_file.name} contains invalid JSON ({e}); "
                f"falling back to alphabetical filename sort",
                file=sys.stderr,
            )
            data = {}
        ordered = _page_order_modern(rm_dir, data)
        if not ordered:
            ordered = _page_order_legacy(rm_dir, data)
    if not ordered:
        rm_files_found = sorted(rm_dir.glob("*.rm"))
        if rm_files_found:
            reason = "not found" if not content_file.exists() else "unrecognised schema"
            print(
                f"warning: {content_file.name} {reason}; falling back to "
                f"alphabetical filename sort (page order may be wrong)",
                file=sys.stderr,
            )
            ordered = list(enumerate(rm_files_found))
    ordered.sort(key=lambda pair: pair[0])

    return ordered
