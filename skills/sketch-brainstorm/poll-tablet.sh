#!/usr/bin/env bash
# poll-tablet.sh
#
# Background polling daemon. Watches the current iteration's reMarkable
# cloud doc via 'rmapi stat' and emits a single READY:<NN> line on stdout
# when the user marks the Finish-turn checkbox and backs out. Idle
# iterations emit nothing.
#
# Intended spawn shape (from the orchestrator):
#   Bash(run_in_background=true) <<<
#     bash skills/sketch-brainstorm/poll-tablet.sh \
#       --cloud-doc Brainstorms/warmup-gate/warmup-gate-05 \
#       --iter 05 \
#       --pulls-dir .tmp/sketch-brainstorm/sessions/<date>-<slug>/pulls/ \
#       --lock-file .tmp/sketch-brainstorm/poller.lock
#
# On READY: emits 'READY:05' and exits 0. The orchestrator dispatches
# interpretation, renders/pushes the next iter, and respawns this script
# with the new --iter / --cloud-doc.
#
# This slice owns READY only. STOP (End-session checkbox), ERROR
# taxonomy with exponential backoff, and bootstrap-side spawn integration
# are documented in the feature spec as separate slices.
#
# Windows note: invoke via Git Bash or WSL.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"
REQUIREMENTS="$SCRIPT_DIR/requirements.txt"
POLL_SCRIPT="$SCRIPT_DIR/render/poll_tablet.py"
. "$SCRIPT_DIR/_lib.sh"

require_rmapi_authenticated "poll-tablet.sh"
ensure_skill_venv "poll-tablet.sh"
exec "$VENV_PYTHON" "$POLL_SCRIPT" "$@"
