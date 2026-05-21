#!/usr/bin/env bash
# test.sh
#
# Run the skill's Python unit test suite via the skill venv. Bootstraps
# the venv if absent or if requirements.txt has drifted; otherwise reuses.
#
# Usage:
#   bash skills/sketch-on-tablet/test.sh              # run all tests
#   bash skills/sketch-on-tablet/test.sh -v           # verbose
#   bash skills/sketch-on-tablet/test.sh test_poll_tablet   # one module
#   bash skills/sketch-on-tablet/test.sh test_poll_tablet.PollOnceTests.test_idle_iteration_skips_pull
#
# Args after the wrapper name forward to `python -m unittest`. With no
# args, falls back to `discover -s render -p test_*.py` for Python and
# globs both the skill-root `test_*.mjs` files and `render/test_*.mjs`
# for Node. The bash integration test (test_bootstrap_session.sh) is a
# separate runner not covered here.
#
# Windows note: invoke via Git Bash or WSL.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"
REQUIREMENTS="$SCRIPT_DIR/requirements.txt"
. "$SCRIPT_DIR/_lib.sh"

ensure_skill_venv "test.sh"

if [ "$#" -eq 0 ]; then
    "$VENV_PYTHON" -m unittest discover -s "$SCRIPT_DIR/render" -p "test_*.py"
    # Node-side tests run after Python; both are required for a green
    # bar so cross-language contract regressions surface here.
    if command -v node >/dev/null 2>&1; then
        node --test "$SCRIPT_DIR"/test_*.mjs "$SCRIPT_DIR/render"/test_*.mjs
    else
        echo "test.sh: node not on PATH; skipping .mjs tests" >&2
    fi

    exit 0
fi

# With args (verbose flags, module names, or fully-qualified test ids),
# cd into render/ so unittest can import test_poll_tablet etc. as
# top-level modules. Args forward verbatim.
cd "$SCRIPT_DIR/render"
exec "$VENV_PYTHON" -m unittest "$@"
