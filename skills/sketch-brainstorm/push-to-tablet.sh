#!/usr/bin/env bash
# push-to-tablet.sh
#
# Pushes a rendered PDF to a folder on the reMarkable cloud via rmapi.
# Owns just the upload step; cloud-path composition (project root +
# per-session slug) and any session/lock state belong to the bootstrap
# orchestration slice that calls this wrapper.
#
# Usage from a host repo root:
#   bash .claude/skills/sketch-brainstorm/push-to-tablet.sh \
#     --pdf .tmp/sketch-brainstorm/test/seed.pdf \
#     --cloud-folder Brainstorms/warmup-gate
#
# Required flags: --pdf, --cloud-folder.
#
# Behavior:
#   1. Verify rmapi is on PATH and authenticated to the cloud.
#   2. Ensure the destination folder exists (rmapi mkdir is non-idempotent;
#      we run it and tolerate the already-exists error).
#   3. Upload with --force so a re-render of the same iteration name
#      replaces the previous version rather than creating a numbered
#      duplicate document. Iter file names (seed, iter01, ...) are unique
#      under normal flow, so --force only matters during dev re-renders.
#
# rmapi quirks this wrapper relies on (see README "rmapi quirks"):
#   - rmapi put has no --name flag; the cloud filename equals the source
#     basename. Callers that need a different cloud name must rename the
#     local file before calling.
#   - The cloud strips '.pdf' in display surfaces (file picker, rmapi ls).
#   - rmapi mkdir creates a single level; passing a multi-segment path
#     when intermediate folders do not exist will fail. Callers ensuring
#     deep paths exist must call this wrapper for each parent in turn,
#     or seed the layout interactively before first use.
#
# Windows note: invoke via Git Bash or WSL, same as the render wrappers.

set -euo pipefail

usage() {
  cat >&2 <<EOF
Usage: $0 --pdf <local-pdf> --cloud-folder <cloud-folder>

Required flags:
  --pdf            Local PDF file to upload.
  --cloud-folder   reMarkable cloud folder path (e.g. "Brainstorms/warmup-gate").
                   Created with 'rmapi mkdir' if missing.

Pushes the PDF into the cloud folder via 'rmapi put --force'. The cloud
filename is the source basename (no extension shown in the file picker).
EOF
  exit 1
}

PDF=""
CLOUD_FOLDER=""

while [ $# -gt 0 ]; do
  case "$1" in
    --pdf)
      [ $# -ge 2 ] || { echo "--pdf requires a value" >&2; usage; }
      PDF="$2"
      shift 2
      ;;
    --cloud-folder)
      [ $# -ge 2 ] || { echo "--cloud-folder requires a value" >&2; usage; }
      CLOUD_FOLDER="$2"
      shift 2
      ;;
    -h|--help)
      usage
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      ;;
  esac
done

[ -n "$PDF" ] || { echo "push-to-tablet.sh: --pdf is required" >&2; usage; }
[ -n "$CLOUD_FOLDER" ] || { echo "push-to-tablet.sh: --cloud-folder is required" >&2; usage; }
[ -f "$PDF" ] || { echo "push-to-tablet.sh: PDF not found: $PDF" >&2; exit 1; }

if ! command -v rmapi >/dev/null 2>&1; then
  echo "push-to-tablet.sh: rmapi not on PATH" >&2
  echo "  Install rmapi (https://github.com/ddvk/rmapi) and pair the machine" >&2
  echo "  via the future setup-rmapi.sh helper (or rmapi's first-run prompt)." >&2
  exit 1
fi

# Auth precondition: 'rmapi ls' on the cloud root succeeds when the token
# is valid. Any failure here means the token is missing, expired, or the
# device cannot reach the cloud; either way upload won't work, so fail
# early with a clear pointer rather than letting 'rmapi put' fail mid-call.
if ! rmapi ls >/dev/null 2>&1; then
  echo "push-to-tablet.sh: rmapi cannot list the cloud root" >&2
  echo "  Token missing or expired. Re-pair the machine, or run" >&2
  echo "  'rmapi ls' interactively to surface the underlying error." >&2
  exit 1
fi

# Ensure destination exists. rmapi has no --parents flag and no exists
# primitive, so we attempt mkdir and pattern-match the already-exists
# error against rmapi 0.0.33's exact wording. The match must be tight:
# a missing-parent error reads "directory doesn't exist", which also
# contains the substring "exist", so a loose match would silently swallow
# a real failure (the README rmapi-quirks section captures that mkdir is
# single-level only). If rmapi changes the wording in a future release,
# update the literal here in lockstep with the README quirk.
mkdir_stderr=$(rmapi mkdir "$CLOUD_FOLDER" 2>&1 >/dev/null) || {
  if echo "$mkdir_stderr" | grep -qE "entry already exists"; then
    : # already exists; not an error in our usage
  else
    echo "push-to-tablet.sh: rmapi mkdir '$CLOUD_FOLDER' failed:" >&2
    echo "$mkdir_stderr" >&2
    exit 1
  fi
}

if ! rmapi put --force "$PDF" "$CLOUD_FOLDER"; then
  echo "push-to-tablet.sh: rmapi put failed for '$PDF' -> '$CLOUD_FOLDER'" >&2
  echo "  Check network connectivity, cloud quota, and that the folder exists." >&2
  exit 1
fi
