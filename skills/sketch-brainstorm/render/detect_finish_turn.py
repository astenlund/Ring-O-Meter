"""Stroke-region Finish-turn checkbox detector.

Per pulled rm-dir: read calibration.json, read the .content manifest
for the rendered page count + page UUIDs, inverse-transform the
Finish-turn box (PDF (1540, 2100) 40x40) into .rm coordinates, parse
strokes via _rm_strokes.collect_lines(), and hit-test each stroke
against the box region. A stroke is "on the box" when its capsule
area inside the box meets MIN_AREA_RM_SQ; the page is "marked" when
at least one stroke qualifies. The top-level `marked` boolean is the OR across pages
(matches the mirrored-box behaviour: either page firing means the
user finished the turn).

Output: a single JSON line on stdout, exit 0 on a clean run
regardless of result. Exit non-zero is reserved for script errors
(missing calibration.json, malformed rm-dir, rmscene exception,
unreadable .content manifest).
"""
import json
import sys
from pathlib import Path

from _rm_strokes import CALIBRATION_JSON, PAGE_W, capsule_area, collect_lines

# LOCKSTEP with page-chrome.css .finish-turn-checkbox dimensions.
# Do not change either without updating the other.
# Finish-turn box in PDF coordinates. Load-bearing constant -
# pinned in page-chrome.css and remarkable-tablet-brainstorm.md.
FINISH_TURN_BOX_PDF = (1540.0, 2100.0, 40.0, 40.0)  # x, y, w, h

# heuristic: minimum capsule area (in .rm^2) for a stroke to qualify
# as a mark on the box. Calibrated against snap-to-straight chords,
# thick-marker single taps, and palm-rest grazes. See
# .claude/features/remarkable-tablet-brainstorm.md "Detection algorithm".
MIN_AREA_RM_SQ = 100.0


def load_calibration():
    """Load and validate CALIBRATION_JSON. Exits non-zero on any problem."""
    if not CALIBRATION_JSON.exists():
        print(
            f"calibration.json not found at {CALIBRATION_JSON}; "
            f"run derive-calibration.sh first",
            file=sys.stderr,
        )
        sys.exit(1)
    try:
        data = json.loads(CALIBRATION_JSON.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        print(f"calibration.json is not valid JSON ({e}); re-run derive-calibration.sh", file=sys.stderr)
        sys.exit(1)
    scale = data.get("scale")
    if not isinstance(scale, (int, float)) or scale <= 0:
        print("calibration.json missing or invalid 'scale'; re-run derive-calibration.sh", file=sys.stderr)
        sys.exit(1)
    return data


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


def stroke_qualifies(points, width, box_rm):
    """Return True iff the stroke's capsule area inside the box meets
    the threshold."""
    return capsule_area(points, width, box_rm) >= MIN_AREA_RM_SQ


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
    rendered page (i is 0-based, matches cPages.pages[] order). On
    absence/invalid/missing-key, exits non-zero with a diagnostic.
    """
    content_path = rm_dir.parent / f"{rm_dir.name}.content"
    if not content_path.exists():
        print(
            f"content manifest unreadable: {content_path.name} not found",
            file=sys.stderr,
        )
        sys.exit(1)
    try:
        data = json.loads(content_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        print(
            f"content manifest unreadable: invalid JSON ({e})",
            file=sys.stderr,
        )
        sys.exit(1)
    cpages = data.get("cPages") or {}
    pages = cpages.get("pages") or []
    if not pages:
        print(
            "content manifest unreadable: cPages.pages missing or empty",
            file=sys.stderr,
        )
        sys.exit(1)
    return [p.get("id") for p in pages]


def detect(rm_dir, scale):
    """Run the detector against rm_dir at the given scale. Returns
    the JSON payload as a dict."""
    box_rm = inverse_transform_box(FINISH_TURN_BOX_PDF, scale)
    page_uuids = page_uuids_from_manifest(rm_dir)
    per_page = []
    any_marked = False
    for i, uuid in enumerate(page_uuids):
        rm_file = rm_dir / f"{uuid}.rm" if uuid else None
        if rm_file is None or not rm_file.exists():
            per_page.append({
                "page": i + 1,
                "marked": False,
                "hit_strokes": 0,
                "total_strokes": 0,
            })
            continue
        lines = collect_lines(rm_file)
        hit_count = 0
        for _color, width, pts in lines:
            if stroke_qualifies(pts, width, box_rm):
                hit_count += 1
        page_marked = hit_count > 0
        if page_marked:
            any_marked = True
        per_page.append({
            "page": i + 1,
            "marked": page_marked,
            "hit_strokes": hit_count,
            "total_strokes": len(lines),
        })

    return {"marked": any_marked, "per_page": per_page}


def main():
    if len(sys.argv) != 2:
        print(
            "usage: detect_finish_turn.py <rm-dir>",
            file=sys.stderr,
        )
        sys.exit(1)
    rm_dir = Path(sys.argv[1])
    if not rm_dir.is_dir():
        print(f"rm-dir not a directory: {rm_dir}", file=sys.stderr)
        sys.exit(1)
    calibration = load_calibration()
    scale = calibration["scale"]
    payload = detect(rm_dir, scale)
    print(json.dumps(payload))


if __name__ == "__main__":
    main()
