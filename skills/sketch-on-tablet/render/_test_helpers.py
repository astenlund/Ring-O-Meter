"""Shared kebab-module load harness for test files.

Production scripts in this directory use kebab-case filenames (CLI naming
convention; not directly importable). Tests that need to introspect their
internals load them via importlib with the heavy native deps (fitz, PIL,
rmscene) stubbed at load time so the suite stays stdlib-only and runs
without bootstrapping the venv.

Both `test_composite_annotated.py` and `test_render_strokes.py` need this
harness; consolidating it here means a new stubbed dependency is added in
one place rather than two.
"""
import importlib.util
import sys
from contextlib import contextmanager
from unittest.mock import MagicMock

STUB_MODULE_NAMES = ("fitz", "PIL", "PIL.Image", "rmscene", "rmscene.scene_items")


def load_kebab_module(module_name, file_path):
    """Load a Python file with a kebab-case name as a module."""
    spec = importlib.util.spec_from_file_location(module_name, file_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    return module


@contextmanager
def stubbed_kebab_loads(load_targets):
    """Stub native deps in sys.modules, load each kebab-named module,
    then restore sys.modules to its pre-call state.

    load_targets is a dict mapping {module_name: file_path}. The names are
    what each loaded module is registered under in sys.modules during the
    test run; tests load with distinct prefixes (e.g.,
    `composite_annotated_under_test` vs `composite_annotated_rs_test`) so
    cross-file unittest discovery does not collide.

    Yields a dict {module_name: loaded_module}. The stub-and-restore is
    load-time-scoped (not test-execution-scoped) because unittest discover
    loads ALL test files before running any tests; leaking stubs across
    sibling files would taint imports in tests that genuinely need the
    real native deps.
    """
    originals = {name: sys.modules.get(name) for name in STUB_MODULE_NAMES}
    pre_load_modules = set(sys.modules.keys())
    for name in STUB_MODULE_NAMES:
        sys.modules[name] = MagicMock()
    loaded = {}
    try:
        for module_name, file_path in load_targets.items():
            loaded[module_name] = load_kebab_module(module_name, file_path)
        yield loaded
    finally:
        for name, original in originals.items():
            if original is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = original
        # Drop transitively-loaded helpers whose module namespaces captured
        # stubbed rmscene / PIL functions. Their cached presence in
        # sys.modules would otherwise hand sibling tests a stub-tainted
        # import. The kebab-modules themselves also get dropped here, which
        # is fine: callers keep their own references from the yielded dict.
        for name in set(sys.modules.keys()) - pre_load_modules:
            if name not in STUB_MODULE_NAMES:
                sys.modules.pop(name, None)
