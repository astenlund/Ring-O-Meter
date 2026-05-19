#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

INDEX="$TMP/.tmp/sketch-brainstorm/current-session.json"

# add: creates index and writes first session
SKETCH_BRAINSTORM_REPO_ROOT="$TMP" \
  bash "$SCRIPT_DIR/update-session-index.sh" add \
    --session-dir 2026-05-19-warmup-gate \
    --slug warmup-gate

[[ -f "$INDEX" ]] || { echo "fail: index not created" >&2; exit 1; }
grep -q '"active_session": "sessions/2026-05-19-warmup-gate"' "$INDEX" \
  || { echo "fail: active_session not set" >&2; exit 1; }

# add a second session: prior becomes dormant
SKETCH_BRAINSTORM_REPO_ROOT="$TMP" \
  bash "$SCRIPT_DIR/update-session-index.sh" add \
    --session-dir 2026-05-19-pitch-display \
    --slug pitch-display

grep -q '"active_session": "sessions/2026-05-19-pitch-display"' "$INDEX" \
  || { echo "fail: active_session not advanced" >&2; exit 1; }
grep -q '"status": "dormant"' "$INDEX" \
  || { echo "fail: prior session not demoted to dormant" >&2; exit 1; }

# set-active: switch back to the older session
SKETCH_BRAINSTORM_REPO_ROOT="$TMP" \
  bash "$SCRIPT_DIR/update-session-index.sh" set-active \
    --session-dir 2026-05-19-warmup-gate

grep -q '"active_session": "sessions/2026-05-19-warmup-gate"' "$INDEX" \
  || { echo "fail: set-active did not promote session" >&2; exit 1; }

# Negative: set-active on unknown session must exit non-zero
if SKETCH_BRAINSTORM_REPO_ROOT="$TMP" \
     bash "$SCRIPT_DIR/update-session-index.sh" set-active \
       --session-dir never-existed >/dev/null 2>&1; then
  echo "fail: set-active on unknown session must exit non-zero" >&2
  exit 1
fi

# Negative: set-active against absent index (no session yet) must exit non-zero
TMP_EMPTY="$(mktemp -d)"
trap 'rm -rf "$TMP" "$TMP_EMPTY"' EXIT
if SKETCH_BRAINSTORM_REPO_ROOT="$TMP_EMPTY" \
     bash "$SCRIPT_DIR/update-session-index.sh" set-active \
       --session-dir any-session >/dev/null 2>&1; then
  echo "fail: set-active against absent index must exit non-zero" >&2
  exit 1
fi

# Negative: missing required flag must exit non-zero
if SKETCH_BRAINSTORM_REPO_ROOT="$TMP" \
     bash "$SCRIPT_DIR/update-session-index.sh" add \
       --slug warmup-gate >/dev/null 2>&1; then
  echo "fail: missing --session-dir must exit non-zero" >&2
  exit 1
fi

echo "test_update_session_index: PASS"
