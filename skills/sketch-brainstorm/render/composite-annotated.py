"""Composite stroke SVG overlays onto the source PDF pages.

Reads the source PDF (the one originally pushed to the tablet) and one
SVG overlay per annotated page, produces one PNG per annotated page
showing the mockup with the user's strokes overlaid in their original
colors at their original positions. Output is what the interpretation
subagent will read multimodally; for un-annotated pages there is no
SVG and no composite is produced.

Page resolution is the reMarkable Paper Pro viewport (1620x2160 px),
matching the outbound render and the SVG overlay viewBox; both the
PDF and the SVG are rasterized at exactly that resolution by computing
the zoom matrix from each document's page rect so the strokes line up
pixel-for-pixel with the rendered mockup.

PyMuPDF (fitz) handles both PDF and SVG via the same get_pixmap path:
fitz.open(svg_path) opens an SVG as a single-page document. This
sidesteps cairosvg's libcairo system-DLL requirement that breaks on
Windows without GTK / MSYS2 installed. Pillow is used only for the
final alpha-composite step.
"""
import re
import sys
from pathlib import Path

import fitz  # PyMuPDF
from PIL import Image

PAGE_W = 1620
PAGE_H = 2160


def _pixmap_to_pil(pix: fitz.Pixmap) -> Image.Image:
    mode = "RGBA" if pix.alpha else "RGB"

    return Image.frombytes(mode, (pix.width, pix.height), pix.samples)


def rasterize_pdf_page(doc: "fitz.Document", page_index: int) -> Image.Image:
    """Render one PDF page to a PIL image at PAGE_W x PAGE_H, RGB.

    The PDF was produced by Playwright at CSS-px dimensions; PDF unit
    is 1/72in and Playwright treats CSS-px as 96 DPI, so the page
    rect ends up at 3/4 of the original CSS px count. Compute the
    zoom matrix from the actual page rect rather than a hardcoded
    factor so a future template change doesn't drift this silently.

    Caller opens and closes the fitz.Document; this function borrows
    it (no open/close here) so a multi-page composite only parses the
    PDF once.
    """
    if not (0 <= page_index < doc.page_count):
        raise IndexError(
            f"PDF has {doc.page_count} pages; page index {page_index} out of range"
        )
    page = doc[page_index]
    zoom_x = PAGE_W / page.rect.width
    zoom_y = PAGE_H / page.rect.height
    matrix = fitz.Matrix(zoom_x, zoom_y)
    pix = page.get_pixmap(matrix=matrix, alpha=False)

    return _pixmap_to_pil(pix)


def rasterize_svg(svg_path: Path) -> Image.Image:
    """Render an SVG overlay to a PIL image at PAGE_W x PAGE_H, RGBA.

    The strokes producer (render-strokes.py) emits viewBox 0 0 1620
    2160, so the SVG document's page rect already matches the target
    resolution; the matrix collapses to identity in the common case.
    Compute it explicitly so a future viewBox change is absorbed.

    Raises RuntimeError on SVG-open failure; caller (main) translates
    to non-zero exit + diagnostic.
    """
    try:
        doc = fitz.open(svg_path)
    except Exception as exc:
        raise RuntimeError(f"failed to open SVG '{svg_path}': {exc}") from exc
    try:
        page = doc[0]  # SVGs render as single-page documents in fitz
        zoom_x = PAGE_W / page.rect.width
        zoom_y = PAGE_H / page.rect.height
        matrix = fitz.Matrix(zoom_x, zoom_y)
        pix = page.get_pixmap(matrix=matrix, alpha=True)

        return _pixmap_to_pil(pix)
    finally:
        doc.close()


def composite_page(pdf_image: Image.Image, svg_image: Image.Image) -> Image.Image:
    """Overlay svg_image (RGBA) onto pdf_image (RGB), return RGB."""
    result = pdf_image.copy()
    result.paste(svg_image, mask=svg_image.split()[3])

    return result


_PAGE_PATTERN = re.compile(r"^strokes-page(\d+)\.svg$")


def collect_strokes_pages(strokes_dir: Path) -> list[tuple[int, Path]]:
    """Return sorted [(pdf_page_number, svg_path)] for strokes-pageN.svg files.

    The strokes producer (render-strokes.py) emits one SVG per page
    that has at least one stroke, named after the 1-based PDF page
    index. Returns numeric-sorted tuples so page 10 follows page 9
    rather than page 1 (lexicographic sort would interleave them).
    Pages without strokes get no SVG and contribute no entry.
    """
    svgs = []
    for entry in strokes_dir.iterdir():
        match = _PAGE_PATTERN.match(entry.name)
        if match:
            svgs.append((int(match.group(1)), entry))
    svgs.sort()

    return svgs


def main():
    if len(sys.argv) != 4:
        print(f"usage: {sys.argv[0]} <pdf> <strokes-dir> <out-dir>", file=sys.stderr)
        return 1

    pdf_path = Path(sys.argv[1])
    strokes_dir = Path(sys.argv[2])
    out_dir = Path(sys.argv[3])
    out_dir.mkdir(parents=True, exist_ok=True)

    if not pdf_path.is_file():
        print(f"composite-annotated.py: pdf not found: {pdf_path}", file=sys.stderr)
        return 1
    if not strokes_dir.is_dir():
        print(f"composite-annotated.py: strokes-dir not found: {strokes_dir}", file=sys.stderr)
        return 1

    svgs = collect_strokes_pages(strokes_dir)
    if not svgs:
        print(
            f"composite-annotated.py: no strokes-pageN.svg files in {strokes_dir}; "
            f"nothing to composite",
            file=sys.stderr,
        )
        return 0

    try:
        pdf_doc = fitz.open(pdf_path)
    except Exception as exc:
        print(
            f"composite-annotated.py: failed to open PDF '{pdf_path}': {exc}",
            file=sys.stderr,
        )
        return 1
    try:
        for page_number, svg_path in svgs:
            # strokes-pageN encodes 1-based; fitz uses 0-based.
            pdf_image = rasterize_pdf_page(pdf_doc, page_number - 1)
            try:
                svg_image = rasterize_svg(svg_path)
            except RuntimeError as exc:
                print(f"composite-annotated.py: {exc}", file=sys.stderr)
                return 1
            composite = composite_page(pdf_image, svg_image)
            out_path = out_dir / f"composite-page{page_number}.png"
            composite.save(out_path, format="PNG")
            print(f"{svg_path.name} + page {page_number} -> {out_path.name}", file=sys.stderr)
    finally:
        pdf_doc.close()

    return 0


if __name__ == "__main__":
    sys.exit(main())
