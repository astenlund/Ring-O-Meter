#!/usr/bin/env bash
# check-poller-lock.sh
#
# Print one JSON line describing the state of poller.lock to stdout.
# Always exits 0; lock states are data, not errors. Bootstrap reads
# stdout and branches on the `status` field.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

REPO_ROOT="${SKETCH_ON_TABLET_REPO_ROOT:-}"
if [[ -z "$REPO_ROOT" ]]; then
  REPO_ROOT="$(find_repo_root "$PWD")" || {
    echo "check-poller-lock.sh: could not locate $_REPO_MARKER walking up from $PWD" >&2
    exit 1
  }
fi

LOCK_PATH="$REPO_ROOT/.tmp/sketch-on-tablet/poller.lock"

VENV_DIR="$SCRIPT_DIR/.venv"
REQUIREMENTS="$SCRIPT_DIR/requirements.txt"
ensure_skill_venv "check-poller-lock.sh"

# Inline python -c instead of a direct-script invocation: the try/except
# wraps the check so a venv or import failure emits a fallback JSON
# rather than a non-zero exit (contract: always exits 0). A direct-script
# helper would push that error-handling responsibility back into bash.
LOCK_PATH="$LOCK_PATH" RENDER_DIR="$SCRIPT_DIR/render" \
  "$VENV_PYTHON" -c '
import json, os, sys
sys.path.insert(0, os.environ["RENDER_DIR"])
from pathlib import Path
try:
    import check_poller_lock
    result = check_poller_lock.check_lock(Path(os.environ["LOCK_PATH"]))
except Exception as exc:
    result = {"status": "stale", "reason": "error", "_error": str(exc)}
print(json.dumps(result))
'
