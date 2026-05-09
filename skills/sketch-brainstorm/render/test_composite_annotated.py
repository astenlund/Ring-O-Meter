"""Unit tests for the inbound stroke and composite pipeline invariants.

Tripwires for the load-bearing properties that visual smoke testing
won't catch:

  - Page-pattern regex shape and the 1-based filename convention.
  - Numeric (not lexicographic) sort order across page indices, so
    page 10 follows page 9 rather than landing between page 1 and
    page 2.
  - Identical PAGE_W/PAGE_H constants in render-strokes.py and
    composite-annotated.py. Drift here breaks pixel alignment between
    the rendered PDF, the stroke SVG overlay, and the composite PNG;
    the `render.mjs` Node side cannot be checked from Python so this
    catches the python-side cases only.
  - Empty strokes-dir behavior: collect_strokes_pages must return
    [] silently so main() can warn-and-return without raising.

The tests load the production modules via importlib because their
filenames are kebab-case (CLI naming convention; not import-friendly).
fitz / PIL / rmscene get mocked so the tests stay stdlib-only and
run without bootstrapping the venv.

Run:
  python skills/sketch-brainstorm/render/test_composite_annotated.py
or:
  python -m unittest discover -s skills/sketch-brainstorm/render -p "test_*.py"
"""
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock

_HERE = Path(__file__).resolve().parent
_COMPOSITE_PY = _HERE / "composite-annotated.py"
_RENDER_STROKES_PY = _HERE / "render-strokes.py"


def _load_kebab_module(module_name, file_path):
    """Load a Python file with a kebab-case name as a module."""
    spec = importlib.util.spec_from_file_location(module_name, file_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    return module


# Stub the heavy native deps so module load doesn't require the venv.
sys.modules.setdefault("fitz", MagicMock())
sys.modules.setdefault("PIL", MagicMock())
sys.modules.setdefault("PIL.Image", MagicMock())
sys.modules.setdefault("rmscene", MagicMock())
sys.modules.setdefault("rmscene.scene_items", MagicMock())

composite_mod = _load_kebab_module("composite_annotated_under_test", _COMPOSITE_PY)
render_strokes_mod = _load_kebab_module("render_strokes_under_test", _RENDER_STROKES_PY)


class PagePatternTests(unittest.TestCase):
    """The strokes filename convention is the contract between
    render-strokes.py (producer) and composite-annotated.py (consumer).
    Drift on either side silently misroutes pages."""

    def test_matches_single_digit(self):
        match = composite_mod._PAGE_PATTERN.match("strokes-page1.svg")
        self.assertIsNotNone(match)
        self.assertEqual(match.group(1), "1")

    def test_matches_multi_digit(self):
        match = composite_mod._PAGE_PATTERN.match("strokes-page42.svg")
        self.assertIsNotNone(match)
        self.assertEqual(match.group(1), "42")

    def test_leading_zero_parses_to_canonical_int(self):
        # render-strokes.py does not emit leading zeros, but if a future
        # producer ever did, int("01") == 1 keeps the page mapping
        # correct rather than introducing an "01" vs "1" divergence.
        match = composite_mod._PAGE_PATTERN.match("strokes-page01.svg")
        self.assertIsNotNone(match)
        self.assertEqual(int(match.group(1)), 1)

    def test_rejects_extra_suffix(self):
        # Editor backups, test scratch files, etc. must not slip in.
        self.assertIsNone(composite_mod._PAGE_PATTERN.match("strokes-page1.svg.bak"))
        self.assertIsNone(composite_mod._PAGE_PATTERN.match("strokes-page1.svg~"))

    def test_rejects_unrelated_files(self):
        # composite-pageN.png should never round-trip as input.
        self.assertIsNone(composite_mod._PAGE_PATTERN.match("composite-page1.png"))
        self.assertIsNone(composite_mod._PAGE_PATTERN.match("README.md"))
        self.assertIsNone(composite_mod._PAGE_PATTERN.match(""))


class CollectStrokesPagesTests(unittest.TestCase):
    """collect_strokes_pages must return numerically-sorted (page, path)
    tuples so multi-digit page indices don't land between single-digit
    ones via lexicographic sort."""

    def test_empty_dir_returns_empty_list(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(composite_mod.collect_strokes_pages(Path(tmp)), [])

    def test_dir_with_only_unrelated_files_returns_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            (tmp_path / "README.md").write_text("hi")
            (tmp_path / "composite-page1.png").write_text("not an svg")
            self.assertEqual(composite_mod.collect_strokes_pages(tmp_path), [])

    def test_numeric_sort_across_double_digit_pages(self):
        # The bug to catch: lexicographic sort would order
        # ['page1', 'page10', 'page2'], breaking page mapping.
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            for i in (10, 2, 1, 11):
                (tmp_path / f"strokes-page{i}.svg").write_text("")
            result = composite_mod.collect_strokes_pages(tmp_path)
            self.assertEqual([page for page, _ in result], [1, 2, 10, 11])

    def test_returns_paths_with_correct_names(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            (tmp_path / "strokes-page1.svg").write_text("")
            (tmp_path / "strokes-page2.svg").write_text("")
            result = composite_mod.collect_strokes_pages(tmp_path)
            self.assertEqual(result[0][1].name, "strokes-page1.svg")
            self.assertEqual(result[1][1].name, "strokes-page2.svg")


class ResolutionConstantsTests(unittest.TestCase):
    """Both python-side modules must agree on the Paper Pro viewport.
    Drift here silently shifts strokes off-position relative to the
    rendered mockup."""

    def test_page_width_matches(self):
        self.assertEqual(composite_mod.PAGE_W, render_strokes_mod.PAGE_W)

    def test_page_height_matches(self):
        self.assertEqual(composite_mod.PAGE_H, render_strokes_mod.PAGE_H)

    def test_page_dimensions_are_paper_pro(self):
        # 1620x2160 is the reMarkable Paper Pro viewport. The Node-side
        # render.mjs hardcodes the same; this test only catches drift
        # across the python files. If render.mjs changes, both python
        # modules must change in lockstep and this test stays green.
        self.assertEqual(composite_mod.PAGE_W, 1620)
        self.assertEqual(composite_mod.PAGE_H, 2160)


if __name__ == "__main__":
    unittest.main()
