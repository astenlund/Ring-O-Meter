#!/usr/bin/env bash
# check-compression-needed.sh
#
# Print a single JSON line on stdout describing whether the named
# session's design-state.md needs compression. Always exits 0 unless
# the session-dir argument is missing or the Python helper errors
# (caller surface: trigger states are data, not errors).
#
# Usage:
#   bash check-compression-needed.sh <session-dir>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/_lib.sh"

if [ "$#" -ne 1 ]; then
    echo "usage: check-compression-needed.sh <session-dir>" >&2
    exit 2
fi

VENV_DIR="$SCRIPT_DIR/.venv"
REQUIREMENTS="$SCRIPT_DIR/requirements.txt"
ensure_skill_venv "check-compression-needed.sh"
exec "$VENV_PYTHON" "$SCRIPT_DIR/render/check_compression_needed.py" "$1"
