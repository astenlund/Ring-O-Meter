#!/usr/bin/env bash
# update-session-index.sh
#
# Bash front-end for session_index.py operations. Subcommands:
#   add            --session-dir <dir> --slug <slug>
#   set-active     --session-dir <dir>
#   increment-turn --session-dir <dir>
#
# Bash handles arg parsing, format guards, repo-root resolution, and
# venv preparation; the actual session_index call is delegated to
# render/_session_index_dispatch.py.
#
# Uses SKETCH_BRAINSTORM_REPO_ROOT (test override) or walks up to find
# Ring-O-Meter.slnx, then anchors current-session.json at
# <repo-root>/.tmp/sketch-brainstorm/current-session.json.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CALLER_NAME="$(basename "${BASH_SOURCE[0]}")"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

usage() {
  cat >&2 <<EOF
$CALLER_NAME add            --session-dir <dir> --slug <slug>
$CALLER_NAME set-active     --session-dir <dir>
$CALLER_NAME increment-turn --session-dir <dir>
EOF
}

[[ $# -ge 1 ]] || { usage; exit 1; }
SUBCMD="$1"; shift

SESSION_DIR=""
SLUG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --session-dir)
      [[ $# -ge 2 ]] || { echo "$CALLER_NAME: --session-dir requires a value" >&2; exit 1; }
      SESSION_DIR="$2"; shift 2;;
    --slug)
      [[ $# -ge 2 ]] || { echo "$CALLER_NAME: --slug requires a value" >&2; exit 1; }
      SLUG="$2"; shift 2;;
    *) echo "$CALLER_NAME: unknown flag: $1" >&2; exit 1;;
  esac
done

[[ -n "$SESSION_DIR" ]] || { echo "$CALLER_NAME: --session-dir is required" >&2; exit 1; }
# Slug character class [a-z0-9]+(-[a-z0-9]+)* must stay in sync with
# bootstrap-session.sh's --slug validation regex.
[[ "$SESSION_DIR" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9]+(-[a-z0-9]+)*$ ]] || {
  echo "$CALLER_NAME: --session-dir must match YYYY-MM-DD-<kebab-slug> (got: $SESSION_DIR)" >&2
  exit 1
}

REPO_ROOT="${SKETCH_BRAINSTORM_REPO_ROOT:-}"
if [[ -z "$REPO_ROOT" ]]; then
  REPO_ROOT="$(find_repo_root "$PWD")" || {
    echo "$CALLER_NAME: could not locate Ring-O-Meter.slnx walking up from $PWD" >&2
    exit 1
  }
fi

INDEX_PATH="$REPO_ROOT/.tmp/sketch-brainstorm/current-session.json"

VENV_DIR="$SCRIPT_DIR/.venv"
REQUIREMENTS="$SCRIPT_DIR/requirements.txt"
ensure_skill_venv "$CALLER_NAME"

DISPATCH="$SCRIPT_DIR/render/_session_index_dispatch.py"

case "$SUBCMD" in
  add)
    [[ -n "$SLUG" ]] || { echo "$CALLER_NAME add: --slug is required" >&2; exit 1; }
    exec "$VENV_PYTHON" "$DISPATCH" --index-path "$INDEX_PATH" --caller-name "$CALLER_NAME" \
      add --session-dir "$SESSION_DIR" --slug "$SLUG"
    ;;
  set-active)
    exec "$VENV_PYTHON" "$DISPATCH" --index-path "$INDEX_PATH" --caller-name "$CALLER_NAME" \
      set-active --session-dir "$SESSION_DIR"
    ;;
  increment-turn)
    # Caller is responsible for not invoking this on iter 00; only completed
    # loop-body iterations (iter 01+) count as turns for the resume prompt.
    exec "$VENV_PYTHON" "$DISPATCH" --index-path "$INDEX_PATH" --caller-name "$CALLER_NAME" \
      increment-turn --session-dir "$SESSION_DIR"
    ;;
  *)
    usage
    exit 1
    ;;
esac
