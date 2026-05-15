"""Cold-path pre-fill pixel-read helper.

Reads the cloud PDF's mode-switch box regions and identifies which is
pre-filled. Emits a single JSON line on stdout:
    {"active_mode": "color" | "bw" | "wireframe"}
Exit 0 on clean detection; exit non-zero with stderr diagnostic on
PDF rasterization failure or ambiguous pre-fill sample.

Detection criterion (subject to empirical calibration per Open question
in the feature spec): rasterize each mode-switch box region at 100 DPI
(yields a ~56x56 pixmap per box; PyMuPDF scales by dpi/72), count
pixels whose luminance is below a threshold (filled boxes paint a dark
gold; empty boxes are white interior with a thin dark border). The
box with the highest filled-pixel ratio wins, provided it exceeds a
minimum margin over the runner-up.
"""
import argparse
import json
import sys
from pathlib import Path

import fitz  # PyMuPDF

from _chrome_boxes import BOX_REGISTRY, VALID_MODES

# Coords are in CSS pixels relative to the 1620 px wide render viewport;
# read_prefill scales them to the PDF's actual point size at runtime
# (Chromium emits a 0.75x scaled PDF: 96 CSS DPI -> 72 PDF DPI -> page
# rect 1215.12 x 1620 points for a 1620x2160 px viewport).
PAGE_WIDTH_CSS = 1620.0

# Derived from BOX_REGISTRY so a new mode added to _chrome_boxes raises
# KeyError here on import (fail-fast) rather than silently truncating.
MODE_BOXES = {m: BOX_REGISTRY[f"mode_{m}"] for m in VALID_MODES}

# heuristic: pixel-luminance threshold below which a pixel counts as
# "filled" (the dark gold pre-fill rasterizes to luminance ~95 in 0-255).
# LOCKSTEP with the `.mode-switch-checkbox[data-mode=...]` `background`
# colors in page-chrome.css; a theme change to the fill color requires
# recalibrating this threshold.
FILL_LUMINANCE_THRESHOLD = 160

# heuristic: minimum filled-pixel ratio for a box to count as pre-filled.
FILL_RATIO_THRESHOLD = 0.3

# heuristic: minimum margin between winner and runner-up to declare
# unambiguous detection. Below this margin, exit non-zero.
WINNER_MARGIN = 0.15


def read_prefill(pdf_path: Path) -> str:
    """Open the PDF, sample each mode-switch box region on page 1,
    return the active mode name. Raises RuntimeError on rasterization
    failure or ambiguous sample."""
    try:
        doc = fitz.open(str(pdf_path))
    except Exception as exc:
        raise RuntimeError(f"failed to open PDF {pdf_path!r}: {exc}") from exc
    try:
        if doc.page_count == 0:
            raise RuntimeError("PDF has no pages")
        page = doc[0]

        # Scale CSS-pixel coords to the PDF's actual point space. Chromium
        # writes a 0.75x-scaled PDF (1620x2160 CSS px -> 1215.12x1620 pt);
        # synthetic test PDFs use 1:1 (page width 1620 pt). Detect at
        # runtime so the helper covers both.
        scale = page.rect.width / PAGE_WIDTH_CSS

        ratios = {}
        for name, (x, y, w, h) in MODE_BOXES.items():
            clip = fitz.Rect(x * scale, y * scale, (x + w) * scale, (y + h) * scale)
            try:
                pix = page.get_pixmap(clip=clip, dpi=100)
            except Exception as exc:
                raise RuntimeError(f"rasterization failed for {name} box: {exc}") from exc
            gray_pix = fitz.Pixmap(fitz.csGRAY, pix)
            total = gray_pix.width * gray_pix.height
            filled = sum(1 for b in gray_pix.samples if b < FILL_LUMINANCE_THRESHOLD)
            ratios[name] = filled / total if total else 0.0
    finally:
        doc.close()

    sorted_modes = sorted(ratios.items(), key=lambda kv: kv[1], reverse=True)
    if len(sorted_modes) < 2:
        raise RuntimeError(f"fewer than two mode boxes sampled (got {len(sorted_modes)})")
    winner_name, winner_ratio = sorted_modes[0]
    runner_ratio = sorted_modes[1][1]

    if winner_ratio < FILL_RATIO_THRESHOLD:
        raise RuntimeError(f"no box reads as filled (max ratio {winner_ratio:.3f})")
    if winner_ratio - runner_ratio < WINNER_MARGIN:
        raise RuntimeError(
            f"ambiguous pre-fill: {winner_name}={winner_ratio:.3f}, "
            f"runner-up={runner_ratio:.3f}"
        )

    return winner_name


def main(argv=None):
    p = argparse.ArgumentParser(description="Read pre-filled mode-switch box from a rendered PDF.")
    p.add_argument("pdf", type=Path, help="Path to the rendered PDF.")
    args = p.parse_args(argv)
    try:
        active = read_prefill(args.pdf)
    except (RuntimeError, OSError) as e:
        print(f"read_prefill: {e}", file=sys.stderr)
        return 1
    print(json.dumps({"active_mode": active}))

    return 0


if __name__ == "__main__":
    sys.exit(main())
