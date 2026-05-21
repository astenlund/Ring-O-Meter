"""Shared .rm parsing, manifest reading, and coordinate-system constants.

Single source of truth for `.rm`-stroke parsing, pen color mapping,
Paper Pro viewport constants, and `.content` manifest parsing (both
modern cPages and legacy pages[] schemas). Calibration concerns (path,
schema version, error type, loader) live in _calibration.py. Consumers:
  - render-strokes.py: produces SVG overlays from strokes.
  - derive_calibration.py: reduces strokes to centroids for the
    five-dot calibration ceremony.
  - detect_marks.py: reads page manifests via manifest_pages/ManifestError,
    parses strokes via collect_lines, then hands areas off to
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


class ManifestError(Exception):
    """Raised when the .content manifest is missing, invalid, or empty."""


def manifest_pages(rm_dir):
    """Return [(pdf_index, uuid_or_None)] for every manifest entry in
    cPages.pages order (modern) or pages[]+redirectionPageMap order
    (legacy).

    Raises ManifestError for: missing content file, invalid JSON.
    Returns [] when the file is present and valid JSON but no recognised
    schema pages are found.

    Unlike ordered_rm_files this does NOT filter for .rm-file presence
    or sort by pdf_index; callers that need rendering order go through
    ordered_rm_files. Callers that only need UUIDs (e.g.,
    detect_marks.page_uuids_from_manifest) discard pdf_index; it is
    returned as a byproduct of the shared parse and not recomputed by
    callers.
    """
    content_path = rm_dir.parent / f"{rm_dir.name}.content"
    if not content_path.exists():
        raise ManifestError(
            f"content manifest unreadable: {content_path.name} not found"
        )
    try:
        data = json.loads(content_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise ManifestError(
            f"content manifest unreadable: invalid JSON ({e})"
        ) from e

    cpages = data.get("cPages") or {}
    modern_pages = cpages.get("pages") or []
    if modern_pages:
        ordered = []
        for i, page in enumerate(modern_pages):
            page_id = page.get("id")
            redir = (page.get("redir") or {}).get("value")
            if redir is not None and not isinstance(redir, int):
                print(
                    f"warning: page {i} redir.value has unexpected type "
                    f"{type(redir).__name__!r} (expected int); "
                    f"falling back to position {i}",
                    file=sys.stderr,
                )
                redir = None
            pdf_index = redir if isinstance(redir, int) else i
            ordered.append((pdf_index, page_id))

        return ordered

    legacy_pages = data.get("pages") or []
    redir_map = data.get("redirectionPageMap") or []
    ordered = []
    for i, page_id in enumerate(legacy_pages):
        if not isinstance(page_id, str):
            continue
        pdf_index = redir_map[i] if i < len(redir_map) and isinstance(redir_map[i], int) else i
        ordered.append((pdf_index, page_id))

    return ordered


def ordered_rm_files(rm_dir: Path) -> list[tuple[int, Path]]:
    """Return [(pdf_page_index, rm_file)] in PDF-page order.

    Reads the .rmdoc archive's <doc-uuid>.content sibling file (where
    rm_dir.name is the doc UUID) via manifest_pages, which handles
    both modern and legacy schemas. Filters for .rm-file existence
    (unannotated pages have no .rm file; skip them for rendering).
    Falls back to alphabetical filename sort with a warning when the
    manifest is missing, malformed, or yields no recognised pages.
    """
    content_file = rm_dir.parent / f"{rm_dir.name}.content"
    ordered = []
    if content_file.exists():
        # Guard ensures manifest_pages() only ever raises here for bad
        # JSON, never for missing-file (Case 1 of its contract is
        # reached only via page_uuids_from_manifest()).
        try:
            pages = manifest_pages(rm_dir)
        except ManifestError as e:
            print(
                f"warning: {content_file.name} contains invalid JSON ({e}); "
                f"falling back to alphabetical filename sort",
                file=sys.stderr,
            )
            pages = []
        ordered = [
            (pdf_index, rm_dir / f"{uuid}.rm")
            for pdf_index, uuid in pages
            if uuid and (rm_dir / f"{uuid}.rm").exists()
        ]
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
