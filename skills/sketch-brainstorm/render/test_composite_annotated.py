"""Unit tests for the composite-annotated.py pipeline invariants.

Tripwires for the load-bearing properties that visual smoke testing
won't catch:

  - Page-pattern regex shape and the 1-based filename convention.
  - Numeric (not lexicographic) sort order across page indices, so
    page 10 follows page 9 rather than landing between page 1 and
    page 2.
  - Identical PAGE_W/PAGE_H constants in composite-annotated.py and
    prerender-pages.py. Drift here breaks pixel alignment between the
    composite PNG and the prerender PNGs; the `render.mjs` Node side
    cannot be checked from Python so this catches the python-side cases.
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
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from _test_helpers import stubbed_kebab_loads

_HERE = Path(__file__).resolve().parent
_COMPOSITE_PY = _HERE / "composite-annotated.py"
_PRERENDER_PAGES_PY = _HERE / "prerender-pages.py"

with stubbed_kebab_loads({
    "composite_annotated_under_test": _COMPOSITE_PY,
    "prerender_pages_under_test": _PRERENDER_PAGES_PY,
}) as _modules:
    composite_mod = _modules["composite_annotated_under_test"]
    prerender_pages_mod = _modules["prerender_pages_under_test"]


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
    """composite-annotated.py and prerender-pages.py must agree on the
    Paper Pro viewport. Drift makes prerender PNGs disagree with composite
    PNGs about pixel dimensions. render-strokes.py parity is covered in
    test_render_strokes.py's ResolutionConstantsTests."""

    def test_page_width_matches(self):
        self.assertEqual(composite_mod.PAGE_W, prerender_pages_mod.PAGE_W)

    def test_page_height_matches(self):
        self.assertEqual(composite_mod.PAGE_H, prerender_pages_mod.PAGE_H)

    def test_page_dimensions_are_paper_pro(self):
        # 1620x2160 is the reMarkable Paper Pro viewport. The Node-side
        # render.mjs hardcodes the same; this test only catches drift
        # across the python files. If render.mjs changes, all modules
        # must change in lockstep and this test stays green.
        self.assertEqual(composite_mod.PAGE_W, 1620)
        self.assertEqual(composite_mod.PAGE_H, 2160)


class CollectLinesSinglePointTest(unittest.TestCase):
    """collect_lines should preserve 1-point strokes so the detector
    can see marker-tap geometry. The renderer skips them itself."""

    def test_single_point_stroke_included(self):
        # Arrange: a rmscene tree with one stroke that has one point.
        # _rm_strokes is not in sys.modules at test time (the kebab-load
        # harness drops transitively-loaded helpers); re-stub rmscene
        # during the import + call so isinstance(node, scene_items.Line)
        # can be exercised.
        fake_point = MagicMock(x=10.0, y=20.0)
        fake_line = MagicMock(spec=[])
        fake_line.color = 0
        fake_line.thickness_scale = 1.0
        fake_line.points = [fake_point]
        fake_tree = MagicMock()
        fake_tree.walk.return_value = [fake_line]

        rmscene_stub = MagicMock()
        scene_items_stub = MagicMock()
        # isinstance check against scene_items.Line: align Line with
        # the fake stroke's actual class so isinstance returns True.
        scene_items_stub.Line = fake_line.__class__
        rmscene_stub.scene_items = scene_items_stub
        rmscene_stub.read_tree = MagicMock(return_value=fake_tree)

        stubs = {"rmscene": rmscene_stub, "rmscene.scene_items": scene_items_stub}
        with patch.dict(sys.modules, stubs):
            # Drop any cached _rm_strokes so the import binds to the
            # stubs above rather than reusing a stale (or pre-stubbed)
            # module object.
            sys.modules.pop("_rm_strokes", None)
            try:
                import _rm_strokes
                # collect_lines calls open(rm_file, "rb") before read_tree;
                # use a real temp file so the open() succeeds, then let
                # the patched read_tree return our fake tree.
                with tempfile.NamedTemporaryFile(delete=False) as tmp:
                    tmp_path = Path(tmp.name)
                try:
                    with patch.object(_rm_strokes, "read_tree", return_value=fake_tree):
                        result = _rm_strokes.collect_lines(tmp_path)
                finally:
                    tmp_path.unlink(missing_ok=True)
            finally:
                sys.modules.pop("_rm_strokes", None)

        # Assert
        self.assertEqual(len(result), 1)
        _color, _width, pts = result[0]
        self.assertEqual(pts, [(10.0, 20.0)])


if __name__ == "__main__":
    unittest.main()
