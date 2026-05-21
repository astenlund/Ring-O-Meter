#!/usr/bin/env bash
# render-strokes.sh
#
# Inbound stroke-rendering wrapper. Bootstraps a self-contained
# Python venv on first run, installs rmscene + helpers, then invokes
# render-strokes.py to convert .rm files in <input-dir> to SVG
# overlays in <output-dir>.
#
# Usage:
#   bash skills/sketch-on-tablet/render-strokes.sh <rm-dir> <out-dir>
#
# <rm-dir> is the directory inside an extracted .rmdoc archive that
# contains the per-page <uuid>.rm files (typically the directory named
# after the document's UUID).
# <out-dir> receives strokes-page1.svg, strokes-page2.svg, ...
#
# Windows note: invoke via Git Bash or WSL.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"
REQUIREMENTS="$SCRIPT_DIR/requirements.txt"
RENDER_SCRIPT="$SCRIPT_DIR/render/render-strokes.py"
. "$SCRIPT_DIR/_lib.sh"

if [ "$#" -ne 2 ]; then
    echo "usage: render-strokes.sh <rm-dir> <out-dir>" >&2
    exit 1
fi

ensure_skill_venv "render-strokes.sh"
exec "$VENV_PYTHON" "$RENDER_SCRIPT" "$@"
