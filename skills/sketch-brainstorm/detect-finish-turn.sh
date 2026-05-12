#!/usr/bin/env bash
# detect-finish-turn.sh
#
# Stroke-region Finish-turn checkbox detector. Per pulled rm-dir,
# emits a JSON line on stdout describing whether the Finish-turn
# box is marked on any page, plus per-page detail. Reads the
# firmware-versioned scale from calibration.json at the skill root.
#
# Usage:
#   bash skills/sketch-brainstorm/detect-finish-turn.sh <rm-dir>
#
# <rm-dir> is the directory inside an extracted .rmdoc archive that
# contains the per-page <uuid>.rm files. Output JSON shape:
#   {"marked":true,"per_page":[{"page":1,"marked":false,
#    "hit_strokes":0,"total_strokes":4}, ...]}
#
# Exit 0 on a clean run regardless of result. Exit non-zero is
# reserved for script errors (missing calibration.json, unreadable
# .content manifest, rmscene exception).
#
# Windows note: invoke via Git Bash or WSL.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"
REQUIREMENTS="$SCRIPT_DIR/requirements.txt"
DETECT_SCRIPT="$SCRIPT_DIR/render/detect_finish_turn.py"
. "$SCRIPT_DIR/_lib.sh"

if [ "$#" -ne 1 ]; then
    echo "usage: detect-finish-turn.sh <rm-dir>" >&2
    exit 1
fi

ensure_skill_venv "detect-finish-turn.sh"
exec "$VENV_PYTHON" "$DETECT_SCRIPT" "$@"
