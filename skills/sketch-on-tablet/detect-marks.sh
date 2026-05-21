#!/usr/bin/env bash
# detect-marks.sh
#
# Stroke-region checkbox detector. Per pulled rm-dir, emits a JSON
# line on stdout describing per-box marked state across the chrome
# checkbox registry (Finish-turn, End-session, mode-switch trio),
# plus per-page detail. Reads the firmware-versioned scale from
# calibration.json at the skill root.
#
# Usage:
#   bash skills/sketch-on-tablet/detect-marks.sh <rm-dir>
#
# <rm-dir> is the directory inside an extracted .rmdoc archive that
# contains the per-page <uuid>.rm files. Output JSON shape:
#   {"per_page":[{"page":1,"boxes":{"finish_turn":{...}, ...}}, ...]}
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
DETECT_SCRIPT="$SCRIPT_DIR/render/detect_marks.py"
. "$SCRIPT_DIR/_lib.sh"

if [ "$#" -ne 1 ]; then
    echo "usage: detect-marks.sh <rm-dir>" >&2
    exit 1
fi

ensure_skill_venv "detect-marks.sh"
exec "$VENV_PYTHON" "$DETECT_SCRIPT" "$@"
