"""Rasterize each page of a PDF to PNG using PyMuPDF.

Output naming: <out-dir>/<prefix>-page1.png, ...-page2.png, ...
Used by render-html-to-pdf.sh's --prerender-out flag to capture
per-page snapshots of a freshly-rendered iter PDF, which feed the
future verify-before-push slice.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import fitz  # PyMuPDF

PAGE_W = 1620
PAGE_H = 2160


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Rasterize each PDF page to a PNG.",
    )
    parser.add_argument("--pdf", required=True, type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument(
        "--prefix",
        required=True,
        help="Output filename prefix; pages render as <prefix>-pageN.png.",
    )
    args = parser.parse_args(argv)

    if not args.pdf.is_file():
        print(f"error: pdf not found: {args.pdf}", file=sys.stderr)
        return 1

    args.out_dir.mkdir(parents=True, exist_ok=True)

    try:
        doc = fitz.open(args.pdf)
    except Exception as exc:
        print(f"prerender-pages.py: failed to open PDF '{args.pdf}': {exc}", file=sys.stderr)
        return 1
    try:
        for index, page in enumerate(doc, start=1):
            # Match composite-annotated.py output dimensions exactly
            # (1620x2160). Compute zoom from the actual page rect rather
            # than a fixed factor so a future template viewport change is
            # absorbed without drifting silently from composite output.
            zoom_x = PAGE_W / page.rect.width
            zoom_y = PAGE_H / page.rect.height
            matrix = fitz.Matrix(zoom_x, zoom_y)
            pix = page.get_pixmap(matrix=matrix, alpha=False)
            out_path = args.out_dir / f"{args.prefix}-page{index}.png"
            pix.save(out_path)
            print(f"wrote {out_path}", file=sys.stderr)
    finally:
        doc.close()

    return 0


if __name__ == "__main__":
    sys.exit(main())
