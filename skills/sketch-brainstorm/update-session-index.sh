#!/usr/bin/env bash
# update-session-index.sh
#
# Bash wrapper around session_index.py. Subcommands:
#   add        --session-dir <dir> --slug <slug>
#   set-active --session-dir <dir>
#
# Uses SKETCH_BRAINSTORM_REPO_ROOT (test override) or walks up to find
# Ring-O-Meter.slnx, then anchors current-session.json at
# <repo-root>/.tmp/sketch-brainstorm/current-session.json.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

usage() {
  cat >&2 <<'EOF'
update-session-index.sh add        --session-dir <dir> --slug <slug>
update-session-index.sh set-active --session-dir <dir>
EOF
}

[[ $# -ge 1 ]] || { usage; exit 1; }
SUBCMD="$1"; shift

SESSION_DIR=""
SLUG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --session-dir)
      [[ $# -ge 2 ]] || { echo "update-session-index.sh: --session-dir requires a value" >&2; exit 1; }
      SESSION_DIR="$2"; shift 2;;
    --slug)
      [[ $# -ge 2 ]] || { echo "update-session-index.sh: --slug requires a value" >&2; exit 1; }
      SLUG="$2"; shift 2;;
    *) echo "update-session-index.sh: unknown flag: $1" >&2; exit 1;;
  esac
done

[[ -n "$SESSION_DIR" ]] || { echo "update-session-index.sh: --session-dir is required" >&2; exit 1; }
# Slug character class [a-z0-9]+(-[a-z0-9]+)* must stay in sync with
# bootstrap-session.sh's --slug validation regex.
[[ "$SESSION_DIR" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9]+(-[a-z0-9]+)*$ ]] || {
  echo "update-session-index.sh: --session-dir must match YYYY-MM-DD-<kebab-slug> (got: $SESSION_DIR)" >&2
  exit 1
}

REPO_ROOT="${SKETCH_BRAINSTORM_REPO_ROOT:-}"
if [[ -z "$REPO_ROOT" ]]; then
  REPO_ROOT="$(find_repo_root "$PWD")" || {
    echo "update-session-index.sh: could not locate Ring-O-Meter.slnx walking up from $PWD" >&2
    exit 1
  }
fi

INDEX_PATH="$REPO_ROOT/.tmp/sketch-brainstorm/current-session.json"

VENV_DIR="$SCRIPT_DIR/.venv"
REQUIREMENTS="$SCRIPT_DIR/requirements.txt"
ensure_skill_venv "update-session-index.sh"

RENDER_DIR="$SCRIPT_DIR/render"

case "$SUBCMD" in
  add)
    [[ -n "$SLUG" ]] || { echo "update-session-index.sh add: --slug is required" >&2; exit 1; }
    INDEX_PATH="$INDEX_PATH" SESSION_DIR="$SESSION_DIR" SLUG="$SLUG" RENDER_DIR="$RENDER_DIR" \
      "$VENV_PYTHON" -c '
import os, sys
sys.path.insert(0, os.environ["RENDER_DIR"])
from pathlib import Path
import session_index
try:
    session_index.add_session(
        Path(os.environ["INDEX_PATH"]),
        session_dir=os.environ["SESSION_DIR"],
        slug=os.environ["SLUG"],
    )
except session_index.SessionIndexError as exc:
    print(f"update-session-index.sh: {exc}", file=sys.stderr)
    sys.exit(1)
'
    ;;
  set-active)
    INDEX_PATH="$INDEX_PATH" SESSION_DIR="$SESSION_DIR" RENDER_DIR="$RENDER_DIR" \
      "$VENV_PYTHON" -c '
import os, sys
sys.path.insert(0, os.environ["RENDER_DIR"])
from pathlib import Path
import session_index
try:
    session_index.set_active(
        Path(os.environ["INDEX_PATH"]),
        session_dir=os.environ["SESSION_DIR"],
    )
except session_index.SessionIndexError as exc:
    print(f"update-session-index.sh: {exc}", file=sys.stderr)
    sys.exit(1)
'
    ;;
  *)
    usage
    exit 1
    ;;
esac
