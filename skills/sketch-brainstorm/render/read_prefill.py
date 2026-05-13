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

# LOCKSTEP with page-chrome.css .mode-switch-row / .mode-switch-checkbox.
# Mirrors detect_marks.MODE_*_BOX_PDF; kept local to this cold-path
# helper so it can be invoked without dragging in the stroke-detection
# module (different runtime context: cloud PDF rasterization, not .rm
# stroke parsing). Coords are in CSS pixels relative to the 1620 px wide
# render viewport; read_prefill scales them to the PDF's actual point
# size at runtime (Chromium emits a 0.75x scaled PDF: 96 CSS DPI -> 72
# PDF DPI -> page rect 1215.12 x 1620 points for a 1620x2160 px viewport).
PAGE_WIDTH_CSS = 1620.0
MODE_BOXES = {
    "color":     (80.0,  2100.0, 40.0, 40.0),
    "bw":        (240.0, 2100.0, 40.0, 40.0),
    "wireframe": (400.0, 2100.0, 40.0, 40.0),
}

# heuristic: pixel-luminance threshold below which a pixel counts as
# "filled" (the dark gold pre-fill rasterizes to luminance ~95 in 0-255).
FILL_LUMINANCE_THRESHOLD = 160

# heuristic: minimum filled-pixel ratio for a box to count as pre-filled.
FILL_RATIO_THRESHOLD = 0.3

# heuristic: minimum margin between winner and runner-up to declare
# unambiguous detection. Below this margin, exit non-zero.
WINNER_MARGIN = 0.15


def read_prefill(pdf_path: Path) -> str:
    """Open the PDF, sample each mode-switch box region on page 1,
    return the active mode name. Raises RuntimeError on ambiguous sample."""
    doc = fitz.open(str(pdf_path))
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
            pix = page.get_pixmap(clip=clip, dpi=100)
            total = pix.width * pix.height
            filled = 0
            for py in range(pix.height):
                for px in range(pix.width):
                    r, g, b = pix.pixel(px, py)[:3]
                    luminance = 0.299 * r + 0.587 * g + 0.114 * b
                    if luminance < FILL_LUMINANCE_THRESHOLD:
                        filled += 1
            ratios[name] = filled / total if total else 0.0
    finally:
        doc.close()

    sorted_modes = sorted(ratios.items(), key=lambda kv: kv[1], reverse=True)
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
    except Exception as e:
        print(f"read_prefill: {e}", file=sys.stderr)

        return 1
    print(json.dumps({"active_mode": active}))

    return 0


if __name__ == "__main__":
    sys.exit(main())
