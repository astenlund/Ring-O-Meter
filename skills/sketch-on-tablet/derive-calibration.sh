#!/usr/bin/env bash
# derive-calibration.sh
#
# Run the .rm-to-PDF scale derivation against a pulled calibration
# rm-dir. The user has just marked five reference dots on the
# calibration PDF and backed out to the file picker; we've pulled
# the resulting .rmdoc archive and now derive the scale from the
# five centroids.
#
# Usage:
#   bash skills/sketch-on-tablet/derive-calibration.sh \
#     <rm-dir> <firmware-note> <output-json>
#
# <rm-dir> is the directory inside an extracted .rmdoc archive that
# contains the user's five .rm strokes (typically <doc-uuid>/).
# <firmware-note> is the device's firmware version string from the
# About screen (e.g. "Paper Pro 3.14.1.2"); included verbatim in
# calibration.json for archaeological purposes.
# <output-json> is where calibration.json should be written (usually
# skills/sketch-on-tablet/calibration.json).
#
# On success, prints `scale: 0.4523 (residuals max 1.6 px)` to
# stdout and writes the full payload to <output-json>. On any
# rejection (count mismatch, asymmetric scale, residual > 3 px),
# exits non-zero with the diagnostic on stderr.
#
# Windows note: invoke via Git Bash or WSL.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"
REQUIREMENTS="$SCRIPT_DIR/requirements.txt"
DERIVE_SCRIPT="$SCRIPT_DIR/render/derive_calibration.py"
. "$SCRIPT_DIR/_lib.sh"

if [ "$#" -ne 3 ]; then
    echo "usage: derive-calibration.sh <rm-dir> <firmware-note> <output-json>" >&2
    exit 1
fi

ensure_skill_venv "derive-calibration.sh"
exec "$VENV_PYTHON" "$DERIVE_SCRIPT" "$@"
