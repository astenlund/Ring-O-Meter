"""Unit tests for render-strokes.py main() branches and resolution constants.

Covers:
  - main() with calibration present: reads scale from load_calibration.
  - main() with calibration absent: falls back to union_bounds + derive_scale.
  - PAGE_W / PAGE_H parity between render-strokes.py and composite-annotated.py
    (the three-module invariant; prerender-pages.py is checked in
    test_composite_annotated.py's ResolutionConstantsTests).

The tests load production modules via importlib because their filenames are
kebab-case (CLI naming convention; not import-friendly). fitz / PIL / rmscene
are mocked at load time so the suite stays stdlib-only and runs without the venv.

Run:
  python skills/sketch-brainstorm/render/test_render_strokes.py
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

_STUB_MODULE_NAMES = ("fitz", "PIL", "PIL.Image", "rmscene", "rmscene.scene_items")
_originals = {name: sys.modules.get(name) for name in _STUB_MODULE_NAMES}
_pre_load_modules = set(sys.modules.keys())
for _name in _STUB_MODULE_NAMES:
    sys.modules[_name] = MagicMock()
try:
    composite_mod = importlib.util.module_from_spec(
        s := importlib.util.spec_from_file_location("composite_annotated_rs_test", _COMPOSITE_PY)
    )
    s.loader.exec_module(composite_mod)
    render_strokes_mod = importlib.util.module_from_spec(
        s2 := importlib.util.spec_from_file_location("render_strokes_under_test", _RENDER_STROKES_PY)
    )
    s2.loader.exec_module(render_strokes_mod)
finally:
    for _name, _original in _originals.items():
        if _original is None:
            sys.modules.pop(_name, None)
        else:
            sys.modules[_name] = _original
    for _name in set(sys.modules.keys()) - _pre_load_modules:
        if _name not in _STUB_MODULE_NAMES:
            sys.modules.pop(_name, None)


class ResolutionConstantsTests(unittest.TestCase):
    """render-strokes.py and composite-annotated.py must agree on PAGE_W/PAGE_H.

    Drift silently shifts stroke overlays off-position relative to the
    rendered PDF pages."""

    def test_page_width_matches(self):
        self.assertEqual(render_strokes_mod.PAGE_W, composite_mod.PAGE_W)

    def test_page_height_matches(self):
        self.assertEqual(render_strokes_mod.PAGE_H, composite_mod.PAGE_H)


class RenderStrokesMainTests(unittest.TestCase):
    """Cover both branches of render-strokes.py main(): calibration-
    present (load JSON scale via load_calibration) vs auto-fit fallback
    (derive scale from union_bounds). Mocks are applied directly to the
    kebab-loaded render_strokes_mod's namespace via patch.object — the
    module retains its bound references after _rm_strokes is dropped
    from sys.modules at load time, so patching there reaches main()'s
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
        contents don't matter -- collect_lines is mocked -- but the file
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

        # Assert: render_svg(lines, scale, out_svg) -- positional, scale at index 1.
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
