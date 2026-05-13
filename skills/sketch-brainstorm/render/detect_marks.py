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

from _rm_strokes import CALIBRATION_JSON, PAGE_W, capsule_area, collect_lines

# LOCKSTEP with page-chrome.css .finish-turn-checkbox dimensions.
# Do not change either without updating the other.
# Finish-turn box in PDF coordinates. Load-bearing constant -
# pinned in page-chrome.css and remarkable-tablet-brainstorm.md.
FINISH_TURN_BOX_PDF = (1540.0, 2100.0, 40.0, 40.0)  # x, y, w, h

# LOCKSTEP with page-chrome.css .end-session-checkbox dimensions.
# End-session box in PDF coordinates. (x, y, w, h) = (1540, 2040, 40, 40).
END_SESSION_BOX_PDF = (1540.0, 2040.0, 40.0, 40.0)

# LOCKSTEP with page-chrome.css .mode-switch-row / .mode-switch-checkbox.
# Mode-switch trio: three 40x40 boxes in the left half of the chrome
# footer, horizontally at x=80, 240, 400 / y=2100 on each page.
MODE_COLOR_BOX_PDF     = (80.0,  2100.0, 40.0, 40.0)
MODE_BW_BOX_PDF        = (240.0, 2100.0, 40.0, 40.0)
MODE_WIREFRAME_BOX_PDF = (400.0, 2100.0, 40.0, 40.0)

# Box registry: detector reports per-box area for every entry here.
BOX_REGISTRY = {
    "finish_turn":    FINISH_TURN_BOX_PDF,
    "end_session":    END_SESSION_BOX_PDF,
    "mode_color":     MODE_COLOR_BOX_PDF,
    "mode_bw":        MODE_BW_BOX_PDF,
    "mode_wireframe": MODE_WIREFRAME_BOX_PDF,
}

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


def detect_page(rm_file, scale):
    """Per-page detection: returns a {box_name: {area_rm_sq, marked}} dict.

    Iterates every entry in BOX_REGISTRY. When rm_file is None or
    missing, strokes is empty and every box's loop body skips the
    threshold check, yielding {area_rm_sq: 0.0, marked: False}.
    """
    boxes = {}
    # Materialize once: the box loop below re-iterates strokes per box.
    strokes = list(collect_lines(rm_file)) if rm_file is not None and rm_file.exists() else []
    for box_name, pdf_box in BOX_REGISTRY.items():
        rm_box = inverse_transform_box(pdf_box, scale)
        total_area = 0.0
        marked = False
        for _color, width, points in strokes:
            stroke_area = capsule_area(points, width, rm_box)
            if stroke_area >= MIN_AREA_RM_SQ:
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
        print(
            "usage: detect_marks.py <rm-dir>",
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
