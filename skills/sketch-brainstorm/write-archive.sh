#!/usr/bin/env bash
# write-archive.sh
#
# Bash wrapper for the archive writer. Reads a compression subagent's
# parsed JSON payload on stdin (the output of parse-compress-response.mjs),
# takes session-dir + the turn-list inputs from the trigger check, and
# performs the two-step atomic file writes (archive first, then
# design-state.md replacement).
#
# Usage:
#   <parsed.json bash write-archive.sh \
#     --session-dir <path> \
#     --turns-to-archive 00,01,02 \
#     --turns-to-keep 03,04,05,06,07,08

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/_lib.sh"

VENV_DIR="$SCRIPT_DIR/.venv"
REQUIREMENTS="$SCRIPT_DIR/requirements.txt"
ensure_skill_venv "write-archive.sh"
exec "$VENV_PYTHON" "$SCRIPT_DIR/render/write_archive.py" "$@"
