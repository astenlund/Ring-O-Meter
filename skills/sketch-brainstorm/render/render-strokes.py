"""Render reMarkable .rm v6 strokes as SVG overlays for each page.

The .rm coordinate system is center-origin in x, top-origin in y, and
recorded at higher resolution than the PDF renders at. The exact scale
varies by device firmware, so we auto-fit: scan the union of all
strokes' bounds across all pages, derive the scale that maps that
bounding box onto the 1620x2160 viewport without warping aspect ratio,
and apply that scale uniformly. Strokes that fall outside the page
extent (e.g., the user wrote off-canvas) get clipped naturally by the
SVG viewBox.

Auto-fit caveat: the derivation assumes the strokes' union bounds are
roughly representative of the page extent. When strokes are tightly
clustered in a small region (e.g., a Finish-turn-only annotation with
no other marks on the page) the bounds are not representative and the
derived scale is loose, displacing the strokes from where they were
drawn. The proper fix is to calibrate against a pinned reference -
the Finish-turn checkbox at `(1540, 2100) 40x40` (authoritative
coordinates are in .finish-turn-checkbox in page-chrome.css; update
both if the box moves) is the natural landmark - and use a fixed
device-firmware-versioned scale instead of auto-fitting per call.
Punted to a later slice; auto-fit works well enough for spread-out
annotations, which dominate the iteration loop.

Page ordering: .rm filenames are random UUIDs, so alphabetical sort
scrambles annotations relative to PDF page order. The .rmdoc archive's
sibling <doc-uuid>.content file lists pages in authoring order with a
`redir.value` field giving each page's index in the underlying PDF.
We read that mapping so each strokes-pageN.svg lands on the matching
PDF page on composite. Falling back to alphabetical if .content is
missing surfaces a warning rather than failing silently.
"""
import math
from pathlib import Path
import json
import sys

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


def collect_lines(rm_file):
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
            if len(pts) >= 2:  # single-point polylines are invisible in SVG
                lines.append((color, width, pts))
    return lines


def union_bounds(all_lines):
    """Find combined bounding box across every stroke from every page."""
    x_min = y_min = math.inf
    x_max = y_max = -math.inf
    for lines in all_lines.values():
        for _, _, pts in lines:
            for x, y in pts:
                if x < x_min:
                    x_min = x
                if x > x_max:
                    x_max = x
                if y < y_min:
                    y_min = y
                if y > y_max:
                    y_max = y
    return x_min, y_min, x_max, y_max


def derive_scale(bounds):
    """Pick a uniform scale that fits the bounds onto 1620x2160.

    .rm uses center-origin in x. Treat the maximum |x| as the
    half-page-width and y_max as the page-height extent. Take the
    smaller (more conservative) per-axis scale so neither dimension
    overflows the viewport.
    """
    x_min, y_min, x_max, y_max = bounds
    half_w = max(abs(x_min), abs(x_max))
    height_extent = max(y_max, abs(y_min))
    scale_x = (PAGE_W / 2) / half_w if half_w else 1.0
    scale_y = PAGE_H / height_extent if height_extent else 1.0

    return min(scale_x, scale_y)


def rm_to_page(x, y, scale):
    return x * scale + PAGE_W / 2, y * scale


def render_svg(lines, scale, out_svg):
    polylines = []
    for color, width, pts in lines:
        coords = " ".join(
            f"{px:.1f},{py:.1f}" for px, py in (rm_to_page(x, y, scale) for x, y in pts)
        )
        polylines.append(
            f'<polyline points="{coords}" fill="none" '
            f'stroke="{color}" stroke-width="{width:.1f}" '
            f'stroke-linecap="round" stroke-linejoin="round"/>'
        )
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'viewBox="0 0 {PAGE_W} {PAGE_H}" width="{PAGE_W}" height="{PAGE_H}">'
        + "".join(polylines)
        + "</svg>"
    )
    out_svg.write_text(svg, encoding="utf-8")


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
            # No .rm file means the page has no annotations; skip
            # silently. Composites for those pages stay strokes-free.
            continue
        # Fall back to i (the page's position in the authoring list) rather
        # than len(ordered) so unannotated pages that were skipped above do
        # not collapse the index and cause two annotated pages to map to the
        # same output slot.
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
            continue
        pdf_index = redir_map[i] if i < len(redir_map) and isinstance(redir_map[i], int) else i
        ordered.append((pdf_index, rm_file))

    return ordered


def ordered_rm_files(rm_dir):
    """Return [(pdf_page_index, rm_file)] in PDF-page order.

    Reads the .rmdoc archive's <doc-uuid>.content sibling file (where
    rm_dir.name is the doc UUID). Two schemas observed in the wild:
    formatVersion>=2 puts the page list at cPages.pages[] with
    structured id+redir entries; formatVersion 1 puts a plain list of
    page UUIDs at top-level `pages` and a parallel int list at
    `redirectionPageMap` for the PDF-page mapping. Falls back to
    alphabetical filename sort with a warning if neither schema
    produces pages.
    """
    content_file = rm_dir.parent / f"{rm_dir.name}.content"
    ordered = []
    if content_file.exists():
        data = json.loads(content_file.read_text(encoding="utf-8"))
        ordered = _page_order_modern(rm_dir, data)
        if not ordered:
            ordered = _page_order_legacy(rm_dir, data)
    if not ordered:
        # Only fall back to alphabetical sort when .rm files actually exist
        # in the directory. If they do, the content file was missing or its
        # schema was not recognised — warn the caller. If they don't, all
        # pages are genuinely unannotated; no warning or fallback is needed.
        rm_files_found = sorted(rm_dir.glob("*.rm"))
        if rm_files_found:
            print(
                f"warning: {content_file.name} did not yield a page order "
                f"(missing or unrecognised schema); falling back to "
                f"alphabetical filename sort (page order may be wrong)",
                file=sys.stderr,
            )
            ordered = list(enumerate(rm_files_found))
    ordered.sort(key=lambda pair: pair[0])

    return ordered


def main():
    if len(sys.argv) != 3:
        print(f"usage: {sys.argv[0]} <rm-dir> <out-dir>", file=sys.stderr)
        sys.exit(1)
    rm_dir = Path(sys.argv[1])
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)

    pairs = ordered_rm_files(rm_dir)
    all_lines = {rm: collect_lines(rm) for _, rm in pairs}
    bounds = union_bounds(all_lines)

    if not math.isfinite(bounds[2]):
        print("warning: no strokes found in any .rm file; writing empty SVGs", file=sys.stderr)
        for pdf_index, rm_file in pairs:
            out_svg = out_dir / f"strokes-page{pdf_index + 1}.svg"
            render_svg([], 1.0, out_svg)
        return

    scale = derive_scale(bounds)
    print(f"bounds: x=({bounds[0]:.0f}..{bounds[2]:.0f}) y=({bounds[1]:.0f}..{bounds[3]:.0f})")
    print(f"derived scale: {scale:.4f}")

    for pdf_index, rm_file in pairs:
        # PDF page numbers are 1-based; redir.value is 0-based.
        out_svg = out_dir / f"strokes-page{pdf_index + 1}.svg"
        render_svg(all_lines[rm_file], scale, out_svg)
        print(f"{rm_file.name} -> {out_svg.name}: {len(all_lines[rm_file])} polylines")


if __name__ == "__main__":
    main()
