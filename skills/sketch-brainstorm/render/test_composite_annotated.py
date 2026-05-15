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
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import MagicMock, patch

_HERE = Path(__file__).resolve().parent
_COMPOSITE_PY = _HERE / "composite-annotated.py"
_RENDER_STROKES_PY = _HERE / "render-strokes.py"
_PRERENDER_PAGES_PY = _HERE / "prerender-pages.py"


def _load_kebab_module(module_name, file_path):
    """Load a Python file with a kebab-case name as a module."""
    spec = importlib.util.spec_from_file_location(module_name, file_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    return module


# Stub the heavy native deps for the kebab-module load only. The stubs
# are installed in sys.modules just long enough to satisfy each loaded
# module's `import fitz` / `from PIL import Image` / `import rmscene`,
# then sys.modules is restored before this file finishes loading.
# The kebab-modules capture their own references to the MagicMock
# objects during exec_module, so test methods still see the mocks via
# composite_mod.fitz, render_strokes_mod.PIL, etc. Restoring sys.modules
# is load-time-scoped (try/finally) rather than test-execution-scoped
# (tearDownModule) because `unittest discover` loads ALL test files
# before running any tests; a test-execution-scoped restore would leak
# the stubs into sibling files loaded between this file's load and its
# tearDownModule fire (test_prerender_pages.py is the canary).
_STUB_MODULE_NAMES = ("fitz", "PIL", "PIL.Image", "rmscene", "rmscene.scene_items")
_originals = {name: sys.modules.get(name) for name in _STUB_MODULE_NAMES}
_pre_load_modules = set(sys.modules.keys())
for _name in _STUB_MODULE_NAMES:
    sys.modules[_name] = MagicMock()
try:
    composite_mod = _load_kebab_module("composite_annotated_under_test", _COMPOSITE_PY)
    render_strokes_mod = _load_kebab_module("render_strokes_under_test", _RENDER_STROKES_PY)
    prerender_pages_mod = _load_kebab_module("prerender_pages_under_test", _PRERENDER_PAGES_PY)
finally:
    # Restore the explicit stubs to their pre-existing state.
    for _name, _original in _originals.items():
        if _original is None:
            sys.modules.pop(_name, None)
        else:
            sys.modules[_name] = _original
    # Drop transitively-loaded helpers (e.g., _rm_strokes) whose module
    # namespaces captured stubbed rmscene / PIL functions. Their cached
    # presence in sys.modules would otherwise hand siblings like
    # test_derive_calibration.py a stub-tainted import. The kebab-modules
    # themselves also get dropped here, which is fine: the locals
    # composite_mod / render_strokes_mod / prerender_pages_mod still
    # hold their references for this file's own tests.
    for _name in set(sys.modules.keys()) - _pre_load_modules:
        if _name not in _STUB_MODULE_NAMES:
            sys.modules.pop(_name, None)


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
    """All three python-side modules must agree on the Paper Pro viewport.
    Drift here silently shifts strokes off-position relative to the
    rendered mockup, or makes prerender PNGs disagree with composite
    PNGs about pixel dimensions."""

    def test_page_width_matches(self):
        self.assertEqual(composite_mod.PAGE_W, render_strokes_mod.PAGE_W)
        self.assertEqual(composite_mod.PAGE_W, prerender_pages_mod.PAGE_W)

    def test_page_height_matches(self):
        self.assertEqual(composite_mod.PAGE_H, render_strokes_mod.PAGE_H)
        self.assertEqual(composite_mod.PAGE_H, prerender_pages_mod.PAGE_H)

    def test_page_dimensions_are_paper_pro(self):
        # 1620x2160 is the reMarkable Paper Pro viewport. The Node-side
        # render.mjs hardcodes the same; this test only catches drift
        # across the python files. If render.mjs changes, all three
        # modules must change in lockstep and this test stays green.
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


class RenderStrokesMainTests(unittest.TestCase):
    """Cover both branches of render-strokes.py main(): calibration-
    present (load JSON scale via load_calibration) vs auto-fit fallback
    (derive scale from union_bounds). Mocks are applied directly to the
    kebab-loaded render_strokes_mod's namespace via patch.object — the
    module retains its bound references after _rm_strokes is dropped
    from sys.modules at lines 78-87, so patching there reaches main()'s
    free-variable lookups via the module's __globals__."""

    def _run_main(self, rm_dir, out_dir, **patches):
        """Invoke render_strokes_mod.main() with sys.argv set to the
        usage shape and the named symbols patched on render_strokes_mod
        for the call's duration."""
        argv = [str(_RENDER_STROKES_PY), str(rm_dir), str(out_dir)]
        with ExitStack() as stack:
            stack.enter_context(patch.object(sys, "argv", argv))
            for name, value in patches.items():
                stack.enter_context(patch.object(render_strokes_mod, name, value))

            return render_strokes_mod.main()

    def _scenario_dirs(self, root):
        """Build a fake rm_dir + out_dir pair under root. The rm-file
        contents don't matter — collect_lines is mocked — but the file
        must exist so main()'s mkdir/path arithmetic doesn't trip.
        Callers own cleanup: root must be a TemporaryDirectory (or equivalent)
        that will remove the tree on exit."""
        rm_dir = root / "rm"
        out_dir = root / "out"
        rm_dir.mkdir()
        fake_rm = rm_dir / "page1.rm"
        fake_rm.write_bytes(b"")

        return rm_dir, out_dir, fake_rm

    def test_main_uses_calibrated_scale_when_calibration_present(self):
        # Arrange
        with tempfile.TemporaryDirectory() as tmp:
            rm_dir, out_dir, fake_rm = self._scenario_dirs(Path(tmp))
            calibration_json = MagicMock()
            calibration_json.exists.return_value = True
            render_svg_spy = MagicMock()

            # Act
            ret = self._run_main(
                rm_dir, out_dir,
                CALIBRATION_JSON=calibration_json,
                load_calibration=MagicMock(return_value={"scale": 0.42, "schema_version": 1}),
                ordered_rm_files=MagicMock(return_value=[(0, fake_rm)]),
                collect_lines=MagicMock(return_value=[("black", 1.0, [(0.0, 0.0), (1.0, 1.0)])]),
                render_svg=render_svg_spy,
            )

        # Assert: render_svg(lines, scale, out_svg) — positional, scale at index 1.
        self.assertEqual(ret, 0)
        render_svg_spy.assert_called_once()
        self.assertEqual(render_svg_spy.call_args.args[1], 0.42)

    def test_main_falls_back_to_auto_fit_when_calibration_absent(self):
        # Arrange
        with tempfile.TemporaryDirectory() as tmp:
            rm_dir, out_dir, fake_rm = self._scenario_dirs(Path(tmp))
            calibration_json = MagicMock()
            calibration_json.exists.return_value = False
            render_svg_spy = MagicMock()
            derive_scale_spy = MagicMock(return_value=1.5)

            # Act
            ret = self._run_main(
                rm_dir, out_dir,
                CALIBRATION_JSON=calibration_json,
                ordered_rm_files=MagicMock(return_value=[(0, fake_rm)]),
                collect_lines=MagicMock(return_value=[("black", 1.0, [(0.0, 0.0), (1.0, 1.0)])]),
                render_svg=render_svg_spy,
                union_bounds=MagicMock(return_value=(-100.0, 0.0, 100.0, 200.0)),
                derive_scale=derive_scale_spy,
            )

        # Assert: derive_scale received the bounds; render_svg got the derived scale.
        self.assertEqual(ret, 0)
        derive_scale_spy.assert_called_once_with((-100.0, 0.0, 100.0, 200.0))
        render_svg_spy.assert_called_once()
        self.assertEqual(render_svg_spy.call_args.args[1], 1.5)


if __name__ == "__main__":
    unittest.main()
