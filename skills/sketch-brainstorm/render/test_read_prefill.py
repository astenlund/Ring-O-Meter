"""Tests for the pixel-read pre-fill helper.

Requires the venv (PyMuPDF). Renders a synthetic PDF with one of the
three mode-switch boxes filled, asserts the helper identifies it.

Run via the venv's python:
  skills/sketch-brainstorm/.venv/Scripts/python.exe \\
    skills/sketch-brainstorm/render/test_read_prefill.py
"""
import sys
import tempfile
import unittest
from pathlib import Path

import fitz

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))

from read_prefill import MODE_BOXES, read_prefill  # noqa: E402


def _make_pdf_with_filled_box(filled_mode, path):
    """Create a single-page PDF (1620x2160) with one mode-switch box
    painted dark gold and the others left white."""
    doc = fitz.open()
    page = doc.new_page(width=1620, height=2160)
    for name, (x, y, w, h) in MODE_BOXES.items():
        rect = fitz.Rect(x, y, x + w, y + h)
        if name == filled_mode:
            page.draw_rect(rect, color=(0.627, 0.502, 0.125), fill=(0.627, 0.502, 0.125))
        else:
            page.draw_rect(rect, color=(0.133, 0.133, 0.133), width=3)  # border only
    doc.save(str(path))
    doc.close()


class ReadPrefillTests(unittest.TestCase):
    def test_color_box_filled(self):
        with tempfile.TemporaryDirectory() as tmp:
            pdf = Path(tmp) / "color.pdf"
            _make_pdf_with_filled_box("color", pdf)
            self.assertEqual(read_prefill(pdf), "color")

    def test_bw_box_filled(self):
        with tempfile.TemporaryDirectory() as tmp:
            pdf = Path(tmp) / "bw.pdf"
            _make_pdf_with_filled_box("bw", pdf)
            self.assertEqual(read_prefill(pdf), "bw")

    def test_wireframe_box_filled(self):
        with tempfile.TemporaryDirectory() as tmp:
            pdf = Path(tmp) / "wf.pdf"
            _make_pdf_with_filled_box("wireframe", pdf)
            self.assertEqual(read_prefill(pdf), "wireframe")

    def test_no_box_filled_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            pdf = Path(tmp) / "empty.pdf"
            # Paint all three as borders only.
            doc = fitz.open()
            page = doc.new_page(width=1620, height=2160)
            for name, (x, y, w, h) in MODE_BOXES.items():
                rect = fitz.Rect(x, y, x + w, y + h)
                page.draw_rect(rect, color=(0.133, 0.133, 0.133), width=3)
            doc.save(str(pdf))
            doc.close()

            with self.assertRaises(RuntimeError):
                read_prefill(pdf)


if __name__ == "__main__":
    unittest.main()
