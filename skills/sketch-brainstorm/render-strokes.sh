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

# Python is required both to create the venv and to hash requirements.txt
# for drift detection, so check it once up-front regardless of which path
# we end up taking.
if ! command -v python >/dev/null 2>&1; then
    echo "render-strokes.sh: 'python' not on PATH. Install Python 3.10+ first." >&2
    exit 1
fi

# Drift detection: hash requirements.txt and store the result inside the
# venv. On a subsequent run, mismatched hashes mean a dep was added,
# removed, or version-bumped since this venv was created; rebootstrap so
# the new deps land. The existing 'rm -rf "$VENV_DIR"' wipes the sentinel
# along with the rest of the venv, so no separate cleanup is needed.
req_hash() {
    python -c "import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" "$1"
}

CURRENT_REQ_HASH="$(req_hash "$REQUIREMENTS")"

bootstrap_needed=false
if ! VENV_PYTHON="$(detect_venv_python 2>/dev/null)"; then
    bootstrap_needed=true
elif [ "$(cat "$VENV_DIR/.req-hash" 2>/dev/null)" != "$CURRENT_REQ_HASH" ]; then
    echo "render-strokes.sh: requirements.txt has changed since venv bootstrap; rebootstrapping..."
    bootstrap_needed=true
fi

if $bootstrap_needed; then
    echo "render-strokes.sh: bootstrapping venv at $VENV_DIR..."
    rm -rf "$VENV_DIR"
    python -m venv "$VENV_DIR"
    VENV_PYTHON="$(detect_venv_python)"
    "$VENV_PYTHON" -m pip install --quiet --upgrade pip
    "$VENV_PYTHON" -m pip install --quiet -r "$REQUIREMENTS"
    echo "$CURRENT_REQ_HASH" > "$VENV_DIR/.req-hash"
    echo "render-strokes.sh: venv ready"
fi

exec "$VENV_PYTHON" "$RENDER_SCRIPT" "$@"
