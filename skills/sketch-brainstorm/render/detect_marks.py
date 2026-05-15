"""Stroke-region checkbox detector for page-chrome interaction boxes.

Per pulled rm-dir: read calibration.json, read the .content manifest
for the rendered page count + page UUIDs, inverse-transform each
registered box from PDF coordinates into .rm coordinates, parse
strokes via _rm_strokes.collect_lines(), and hit-test each stroke
against the box region. A stroke is "on the box" when its capsule
area inside the box meets MIN_AREA_RM_SQ; a box is "marked" when at
least one stroke qualifies. Per-page output reports every registered
box.

Output: a single JSON line on stdout, exit 0 on a clean run
regardless of result. Exit non-zero is reserved for script errors
(missing calibration.json, malformed rm-dir, rmscene exception,
unreadable .content manifest).
"""
import json
import sys
from pathlib import Path

from _chrome_boxes import BOX_REGISTRY
from _geometry import capsule_area
from _calibration import CalibrationError, load_calibration
from _rm_strokes import PAGE_W, collect_lines


class ManifestError(Exception):
    """Raised when the .content manifest is missing, invalid, or empty."""


class StrokeParseError(Exception):
    """Raised when rmscene fails to parse a `.rm` stroke file."""


# heuristic: minimum capsule area (in .rm^2) for a stroke to qualify
# as a mark on the box. Calibrated against snap-to-straight chords,
# thick-marker single taps, and palm-rest grazes. See
# .claude/features/remarkable-tablet-brainstorm.md "Detection algorithm".
MIN_AREA_RM_SQ = 100.0


def inverse_transform_box(pdf_box, scale):
    """Convert a PDF (x, y, w, h) box to .rm (x_min, x_max, y_min, y_max).

    The .rm system is center-origin in x (positive = right of center),
    top-origin in y (positive = downward). Inverse of render-strokes.py's
    rm_to_page formula.
    """
    px, py, pw, ph = pdf_box
    cx = PAGE_W / 2
    rm_x_min = (px - cx) / scale
    rm_x_max = (px + pw - cx) / scale
    rm_y_min = py / scale
    rm_y_max = (py + ph) / scale

    return rm_x_min, rm_x_max, rm_y_min, rm_y_max


def page_uuids_from_manifest(rm_dir):
    """Return page UUIDs from the .content manifest in manifest order.

    The manifest sits next to rm_dir (at <doc-uuid>.content where
    rm_dir.name is the doc UUID). We use cPages.pages[] WITHOUT filtering
    for .rm-file existence -- this is intentional: per_page must cover every
    rendered page regardless of annotation presence. (This differs from
    _rm_strokes.ordered_rm_files, which skips unannotated pages for rendering.)
    Do NOT use the top-level `pageCount` field; it is 0 for documents that were
    pushed but never opened.

    Returns page_uuids where page_uuids[i] is the UUID string for the i-th
    rendered page (i is 0-based, matches cPages.pages[] order). Raises
    ManifestError on absent file, invalid JSON, or missing pages key;
    caller (main) translates to non-zero exit + diagnostic.
    """
    content_path = rm_dir.parent / f"{rm_dir.name}.content"
    if not content_path.exists():
        raise ManifestError(
            f"content manifest unreadable: {content_path.name} not found"
        )
    try:
        data = json.loads(content_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise ManifestError(f"content manifest unreadable: invalid JSON ({e})") from e
    cpages = data.get("cPages") or {}
    pages = cpages.get("pages") or []
    if not pages:
        raise ManifestError("content manifest unreadable: cPages.pages missing or empty")

    return [p.get("id") for p in pages]


def detect_page(rm_file, scale):
    """Per-page detection: returns a {box_name: {area_rm_sq, marked}} dict.

    Iterates every entry in BOX_REGISTRY. When rm_file is None or
    missing, strokes is empty and every box's loop body skips the
    threshold check, yielding {area_rm_sq: 0.0, marked: False}.
    """
    boxes = {}
    # Materialize once: the box loop below re-iterates strokes per box.
    # Wrap rmscene parse failures into a typed exception so main() can
    # produce a clean diagnostic instead of a raw library traceback.
    if rm_file is not None and rm_file.exists():
        try:
            strokes = list(collect_lines(rm_file))
        except Exception as e:
            raise StrokeParseError(f"failed to parse {rm_file.name}: {e}") from e
    else:
        strokes = []
    for box_name, pdf_box in BOX_REGISTRY.items():
        rm_box = inverse_transform_box(pdf_box, scale)
        total_area = 0.0
        marked = False
        for _color, width, points in strokes:
            stroke_area = capsule_area(points, width, rm_box)
            if stroke_area >= MIN_AREA_RM_SQ:
                # Sum within page + max across pages (see _resolve_mode_winner):
                # prefers repeated marking over a single huge stroke when both
                # occur on different pages.
                total_area += stroke_area
                marked = True
        boxes[box_name] = {"area_rm_sq": round(total_area, 3), "marked": marked}

    return boxes


def detect(rm_dir, scale):
    """Run the detector against rm_dir at the given scale. Returns
    the JSON payload as a dict."""
    page_uuids = page_uuids_from_manifest(rm_dir)
    per_page = []
    for i, uuid in enumerate(page_uuids):
        rm_file = rm_dir / f"{uuid}.rm" if uuid else None
        per_page.append({"page": i + 1, "boxes": detect_page(rm_file, scale)})

    return {"per_page": per_page}


def main():
    if len(sys.argv) != 2:
        print("usage: detect_marks.py <rm-dir>", file=sys.stderr)
        return 1
    rm_dir = Path(sys.argv[1])
    if not rm_dir.is_dir():
        print(f"rm-dir not a directory: {rm_dir}", file=sys.stderr)
        return 1
    try:
        calibration = load_calibration()
        global MIN_AREA_RM_SQ
        MIN_AREA_RM_SQ = calibration["min_area_rm_sq"]
        payload = detect(rm_dir, calibration["scale"])
    except (CalibrationError, ManifestError, StrokeParseError, OSError) as e:
        print(str(e), file=sys.stderr)
        return 1
    print(json.dumps(payload))

    return 0


if __name__ == "__main__":
    sys.exit(main())
