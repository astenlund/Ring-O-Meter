"""Render reMarkable .rm v6 strokes as SVG overlays for each page.

Auto-fit is still the fallback scale source when calibration.json is
absent. When present, render-strokes.py reads its scale and skips the
union-bounds derivation. See `_rm_strokes.py` for the shared parser
and the .rm coordinate-system contract.
"""
import json
import math
import sys
from pathlib import Path

from _rm_strokes import (
    CALIBRATION_JSON,
    PAGE_W,
    PAGE_H,
    CalibrationError,
    collect_lines,
    load_calibration,
    ordered_rm_files,
)


def union_bounds(
    all_lines: dict[Path, list[tuple[str, float, list[tuple[float, float]]]]],
) -> tuple[float, float, float, float]:
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


def derive_scale(bounds: tuple[float, float, float, float]) -> float:
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


def rm_to_page(x: float, y: float, scale: float) -> tuple[float, float]:
    return x * scale + PAGE_W / 2, y * scale


def render_svg(
    lines: list[tuple[str, float, list[tuple[float, float]]]],
    scale: float,
    out_svg: Path,
) -> None:
    polylines = []
    for color, width, pts in lines:
        if len(pts) < 2:
            continue  # 1-point strokes are detector input, not visible SVG
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


def main():
    if len(sys.argv) != 3:
        print(f"usage: {sys.argv[0]} <rm-dir> <out-dir>", file=sys.stderr)
        sys.exit(1)
    rm_dir = Path(sys.argv[1])
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)

    pairs = ordered_rm_files(rm_dir)
    all_lines = {rm: collect_lines(rm) for _, rm in pairs}

    # Prefer the firmware-versioned scale from calibration.json over
    # the per-call auto-fit. Auto-fit is known-loose for tight stroke
    # clusters (the original docstring above explains why); the
    # calibrated scale is geometrically correct across all stroke
    # layouts. Fall back to auto-fit if calibration.json is absent
    # (e.g., on a fresh clone before the user has run the ceremony).
    if CALIBRATION_JSON.exists():
        try:
            scale = load_calibration()["scale"]
        except CalibrationError as e:
            print(str(e), file=sys.stderr)
            sys.exit(1)
        print(f"using calibrated scale: {scale:.4f}")
        if not any(all_lines.values()):
            print("warning: no strokes found in any .rm file; writing empty SVGs", file=sys.stderr)
    else:
        bounds = union_bounds(all_lines)
        if not math.isfinite(bounds[2]):
            print("warning: no strokes found in any .rm file; writing empty SVGs", file=sys.stderr)
            for pdf_index, rm_file in pairs:
                out_svg = out_dir / f"strokes-page{pdf_index + 1}.svg"
                render_svg([], 1.0, out_svg)
            return
        scale = derive_scale(bounds)
        print(
            f"calibration.json absent; falling back to auto-fit "
            f"(known-loose for tight stroke clusters; run derive-calibration.sh)",
            file=sys.stderr,
        )
        print(f"bounds: x=({bounds[0]:.0f}..{bounds[2]:.0f}) y=({bounds[1]:.0f}..{bounds[3]:.0f})")
        print(f"derived scale: {scale:.4f}")

    for pdf_index, rm_file in pairs:
        out_svg = out_dir / f"strokes-page{pdf_index + 1}.svg"
        render_svg(all_lines[rm_file], scale, out_svg)
        print(f"{rm_file.name} -> {out_svg.name}: {len(all_lines[rm_file])} polylines")


if __name__ == "__main__":
    main()
