#!/usr/bin/env bash
# render-strokes.sh
#
# Inbound stroke-rendering wrapper. Bootstraps a self-contained
# Python venv on first run, installs rmscene + helpers, then invokes
# render-strokes.py to convert .rm files in <input-dir> to SVG
# overlays in <output-dir>.
#
# Usage:
#   bash skills/sketch-brainstorm/render-strokes.sh <rm-dir> <out-dir>
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

if [ "$#" -ne 2 ]; then
    echo "usage: render-strokes.sh <rm-dir> <out-dir>" >&2
    exit 1
fi

# Detect the venv's Python regardless of POSIX vs Windows layout.
# Windows venvs put python at Scripts/python.exe; POSIX at bin/python.
detect_venv_python() {
    if [ -x "$VENV_DIR/bin/python" ]; then
        echo "$VENV_DIR/bin/python"
    elif [ -x "$VENV_DIR/Scripts/python.exe" ]; then
        echo "$VENV_DIR/Scripts/python.exe"
    else
        return 1
    fi
}

if ! VENV_PYTHON="$(detect_venv_python 2>/dev/null)"; then
    echo "render-strokes.sh: bootstrapping venv at $VENV_DIR..."
    if ! command -v python >/dev/null 2>&1; then
        echo "  ERROR: 'python' not on PATH. Install Python 3.10+ first." >&2
        exit 1
    fi
    rm -rf "$VENV_DIR"
    python -m venv "$VENV_DIR"
    VENV_PYTHON="$(detect_venv_python)"
    "$VENV_PYTHON" -m pip install --quiet --upgrade pip
    "$VENV_PYTHON" -m pip install --quiet -r "$REQUIREMENTS"
    echo "render-strokes.sh: venv ready"
fi
exec "$VENV_PYTHON" "$RENDER_SCRIPT" "$@"
