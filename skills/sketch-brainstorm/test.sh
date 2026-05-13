#!/usr/bin/env bash
# test.sh
#
# Run the skill's Python unit test suite via the skill venv. Bootstraps
# the venv if absent or if requirements.txt has drifted; otherwise reuses.
#
# Usage:
#   bash skills/sketch-brainstorm/test.sh              # run all tests
#   bash skills/sketch-brainstorm/test.sh -v           # verbose
#   bash skills/sketch-brainstorm/test.sh test_poll_tablet   # one module
#   bash skills/sketch-brainstorm/test.sh test_poll_tablet.PollOnceTests.test_idle_iteration_skips_pull
#
# Args after the wrapper name forward to `python -m unittest`. With no
# args, falls back to `discover -s render -p test_*.py`. Node-side tests
# (test_interpret_parse.mjs, test_render_format.mjs) and the bash
# integration test (test_bootstrap_session.sh) are separate runners; this
# wrapper covers the Python surface only.
#
# Windows note: invoke via Git Bash or WSL.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"
REQUIREMENTS="$SCRIPT_DIR/requirements.txt"
. "$SCRIPT_DIR/_lib.sh"

ensure_skill_venv "test.sh"

if [ "$#" -eq 0 ]; then
    exec "$VENV_PYTHON" -m unittest discover -s "$SCRIPT_DIR/render" -p "test_*.py"
fi

# With args (verbose flags, module names, or fully-qualified test ids),
# cd into render/ so unittest can import test_poll_tablet etc. as
# top-level modules. Args forward verbatim.
cd "$SCRIPT_DIR/render"
exec "$VENV_PYTHON" -m unittest "$@"
