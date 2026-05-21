#!/usr/bin/env bash
# read-prefill.sh
#
# Cold-path pre-fill pixel-read helper for cross-machine resume.
# Reads the latest cloud PDF and identifies the pre-filled
# mode-switch box. Emits {"active_mode": "color"|"bw"|"wireframe"}
# on stdout, exit 0; exit non-zero with stderr diagnostic on
# rasterization failure or ambiguous sample.
#
# Usage:
#   bash skills/sketch-on-tablet/read-prefill.sh <path-to-pdf>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"
REQUIREMENTS="$SCRIPT_DIR/requirements.txt"
HELPER="$SCRIPT_DIR/render/read_prefill.py"
. "$SCRIPT_DIR/_lib.sh"

if [ "$#" -ne 1 ]; then
    echo "usage: read-prefill.sh <path-to-pdf>" >&2
    exit 1
fi

ensure_skill_venv "read-prefill.sh"
exec "$VENV_PYTHON" "$HELPER" "$@"
