"""Shared .rm parsing and coordinate-system constants.

Single source of truth for `.rm`-stroke parsing, pen color mapping,
and Paper Pro viewport constants. Consumers:
  - render-strokes.py: produces SVG overlays from strokes.
  - derive_calibration.py: reduces strokes to centroids for the
    five-dot calibration ceremony.
  - detect_marks.py: parses strokes, then hands them off to
    `_geometry.capsule_area` for the chrome-footer hit-test.

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
# Bump this and the load_calibration guard together whenever the
# inverse-transform formula changes (e.g., a y_offset field is added).
CALIBRATION_SCHEMA_VERSION = 1

class CalibrationError(Exception):
    """Raised when calibration.json is missing, invalid, or unparseable."""


def load_calibration():
    """Load and validate CALIBRATION_JSON.

    Raises CalibrationError on missing file, invalid JSON, an unknown
    schema_version, or an invalid scale value. Callers translate to a
    non-zero exit + diagnostic in their `main()`.

    schema_version contract: missing -> v1 (back-compat with calibrations
    written before the field was introduced); 1 -> the linear
    `pdf_y = cy * scale` inverse-transform; anything else -> reject so
    an old calibration cannot silently misproject under new math. The
    schema check fires before the scale check so a hypothetical v2
    file dropping `scale` produces 'regenerate calibration' guidance,
    not a misleading 'missing scale' diagnostic.
    """
    if not CALIBRATION_JSON.exists():
        raise CalibrationError(
            f"calibration.json not found at {CALIBRATION_JSON}; "
            f"run derive-calibration.sh first"
        )
    try:
        data = json.loads(CALIBRATION_JSON.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise CalibrationError(
            f"calibration.json is not valid JSON ({e}); re-run derive-calibration.sh"
        ) from e
    # Default must be the literal 1 (the version implied by absence of the field
    # for files written before schema_version was introduced), NOT the constant.
    # Using the constant as default would silently read pre-field files under
    # the wrong semantics whenever CALIBRATION_SCHEMA_VERSION is bumped.
    schema_version = data.get("schema_version", 1)
    if schema_version != CALIBRATION_SCHEMA_VERSION:
        raise CalibrationError(
            f"calibration.json schema_version={schema_version!r} not supported by this "
            f"reader (expected {CALIBRATION_SCHEMA_VERSION}); re-run derive-calibration.sh to regenerate"
        )
    scale = data.get("scale")
    if not isinstance(scale, (int, float)) or scale <= 0:
        raise CalibrationError(
            "calibration.json missing or invalid 'scale'; re-run derive-calibration.sh"
        )

    return data


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
            # rendering. Note: detect_marks.page_uuids_from_manifest
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
