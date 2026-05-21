#!/usr/bin/env bash
# write-design-state.sh
#
# Atomic-write helper for design-state.md. Mechanizes the
# write-to-temp + rename protocol so main chat doesn't have to
# orchestrate it manually each turn.
#
# Usage:
#   bash write-design-state.sh --session-dir <path> --iter NN \
#                              --mode color|bw|wireframe <<< "<content delta>"

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="$SCRIPT_DIR/render/write_design_state.py"
. "$SCRIPT_DIR/_lib.sh"

require_python "write-design-state.sh"
exec python "$HELPER" "$@"
