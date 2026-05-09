#!/usr/bin/env bash
# pull-from-tablet.sh
#
# Pulls a document from the reMarkable cloud via rmapi get, then
# extracts the .rmdoc archive into a per-document directory ready
# for render-strokes.sh to consume. Owns just the download + extract
# steps; stroke rendering and interpretation are downstream.
#
# Usage from a host repo root:
#   bash .claude/skills/sketch-brainstorm/pull-from-tablet.sh \
#     --cloud-doc Brainstorms/warmup-gate/iter01 \
#     --out-dir .tmp/sketch-brainstorm/pulls/
#
# Required flags: --cloud-doc, --out-dir.
#
# The cloud-doc path uses bare names (no .pdf), since the cloud strips
# the extension on display surfaces (see README rmapi quirks). The
# .rmdoc archive lands at <out-dir>/<basename>.rmdoc and is preserved
# as the canonical source for re-extraction or audit (a future polling
# slice can diff successive pulls without re-fetching). The archive's
# contents extract under <out-dir>/<basename>/, and the rm-dir path
# emitted on stdout drills one level deeper into the per-doc UUID
# subdirectory when the archive is annotated (see "Archive layout"
# below). Re-pulling the same cloud-doc overwrites both the archive
# and the extraction; brainstorm iteration assumes overwrite semantics.
#
# Basename collision: <out-dir> is keyed only on the cloud-doc's leaf
# name, so distinct cloud paths sharing a basename (e.g. Foo/iter01
# and Bar/iter01) clobber each other when pulled into the same
# --out-dir. Callers that need to keep both must use distinct out-dirs
# or pull serially, renaming between pulls.
#
# Archive layout differs between un-annotated and annotated docs:
#   - Un-annotated (newly pushed, never opened on tablet): flat
#     archive with <doc-uuid>.content / .metadata / .pdf at root; no
#     .rm files yet. Wrapper emits <extract-dir> as the rm-dir.
#   - Annotated (opened + saved at least once): same manifest files
#     at root, PLUS a nested <doc-uuid>/ subdirectory containing the
#     per-page <page-uuid>.rm stroke files, PLUS a <doc-uuid>.pagedata
#     file at root. Wrapper drills into <doc-uuid>/ and emits that
#     path so render-strokes.py's sibling-style .content lookup
#     resolves correctly.
#
# Caller-facing stdout: the rm-dir path, so the call can pipe straight
# into render-strokes.sh:
#   STROKES_DIR="$(bash pull-from-tablet.sh --cloud-doc ... --out-dir ...)"
#   bash render-strokes.sh "$STROKES_DIR" out-svgs/
# rmapi progress and any error output stay on stderr; the captured
# stdout is the single rm-dir path string.
#
# Dependencies:
#   - rmapi on PATH and authenticated (same precondition as push)
#   - python on PATH for stdlib zipfile extraction. The render-strokes
#     wrapper already requires Python 3.10+; this wrapper reuses the
#     same skill-level dep but does not require its venv (zipfile is
#     stdlib).
#
# Windows note: invoke via Git Bash or WSL, same as the other wrappers.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/_lib.sh"

usage() {
  cat >&2 <<EOF
Usage: $0 --cloud-doc <path> --out-dir <dir>

Required flags:
  --cloud-doc   reMarkable cloud document path (e.g. "Brainstorms/warmup-gate/iter01").
                Use bare names (no .pdf) per the README rmapi quirks.
  --out-dir     Local directory to receive the .rmdoc archive and the
                extracted contents subdirectory. Created if missing.

Pulls via 'rmapi get', writes <out-dir>/<basename>.rmdoc, then extracts
to <out-dir>/<basename>/. Prints the rm-dir path on stdout: the inner
<doc-uuid>/ subdirectory for annotated docs, or the extract dir itself
for un-annotated docs. Pipe directly to render-strokes.sh.
EOF
  exit 1
}

CLOUD_DOC=""
OUT_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --cloud-doc)
      [ $# -ge 2 ] || { echo "--cloud-doc requires a value" >&2; usage; }
      CLOUD_DOC="$2"
      shift 2
      ;;
    --out-dir)
      [ $# -ge 2 ] || { echo "--out-dir requires a value" >&2; usage; }
      OUT_DIR="$2"
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

[ -n "$CLOUD_DOC" ] || { echo "pull-from-tablet.sh: --cloud-doc is required" >&2; usage; }
[ -n "$OUT_DIR" ] || { echo "pull-from-tablet.sh: --out-dir is required" >&2; usage; }

require_rmapi_authenticated "pull-from-tablet.sh"

if ! command -v python >/dev/null 2>&1; then
  echo "pull-from-tablet.sh: python not on PATH" >&2
  echo "  Install Python 3.10+; used here only for stdlib zipfile extraction." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

# rmapi get writes <basename>.rmdoc to PWD; cd into out-dir so the
# archive lands where the caller expected. rmapi 0.0.33 silently
# overwrites an existing <basename>.rmdoc in PWD, so re-pulls don't
# need a separate cleanup step on the archive itself.
BASENAME="$(basename "$CLOUD_DOC")"
# Defensive: refuse a basename that's empty or resolves to a current /
# parent / root reference, since the downstream 'rm -rf "$EXTRACT_DIR"'
# would otherwise wipe $OUT_DIR/ itself (and the archive that just
# landed alongside it) or escape via "..". basename returns "/" for "/"
# and "//" inputs, "." for empty, ".." for paths ending in "/..".
case "$BASENAME" in
  ""|.|..|/*|*/) echo "pull-from-tablet.sh: refusing unsafe basename '$BASENAME' derived from --cloud-doc '$CLOUD_DOC'" >&2; exit 1 ;;
esac
RMDOC_PATH="$OUT_DIR/$BASENAME.rmdoc"
EXTRACT_DIR="$OUT_DIR/$BASENAME"

# For the missing-doc error pointer, suggest 'rmapi ls' against the
# parent. dirname returns '.' for top-level docs (no slash in the
# path), which is not a valid rmapi argument; collapse that case to
# the no-arg form which lists the cloud root.
PARENT="$(dirname "$CLOUD_DOC")"
if [ "$PARENT" = "." ]; then
  PARENT_HINT="'rmapi ls' (cloud root)"
else
  PARENT_HINT="'rmapi ls $PARENT'"
fi

# Redirect rmapi's "downloading: ... OK" progress to stderr so the
# wrapper's stdout stays the single-line rm-dir contract that callers
# can capture with $(pull-from-tablet.sh ...). Errors already go to
# stderr; this keeps the progress chatter on the same channel.
if ! (cd "$OUT_DIR" && rmapi get "$CLOUD_DOC" >&2); then
  echo "pull-from-tablet.sh: rmapi get failed for '$CLOUD_DOC'" >&2
  echo "  rmapi 0.0.33 reports 'file doesn't exist' for missing docs." >&2
  echo "  Check the path with $PARENT_HINT." >&2
  exit 1
fi

# Re-pulling the same doc overwrites the prior extraction so brainstorm
# iteration cycles cleanly. The archive is overwritten by rmapi get
# above; the extraction directory is wiped here. Any caller that wants
# to retain the previous extraction must rename it before re-pulling.
rm -rf "$EXTRACT_DIR"
mkdir -p "$EXTRACT_DIR"
python -m zipfile -e "$RMDOC_PATH" "$EXTRACT_DIR/"

# .rmdoc layouts observed (see README rmapi quirks):
#   - Un-annotated docs are flat: <doc-uuid>.{content,metadata,pdf}
#     all sit at $EXTRACT_DIR root; no .rm files exist yet.
#   - Annotated docs are hybrid: the same manifest files at root
#     PLUS a nested <doc-uuid>/ subdirectory containing the per-page
#     .rm files. render-strokes.py expects the directory containing
#     the .rm files (with the .content as a sibling one level up),
#     so for annotated docs the wrapper drills into <doc-uuid>/ and
#     hands that path to the caller. For un-annotated docs, no drill
#     happens; the caller still gets a usable path that render-strokes
#     correctly reports as containing zero strokes.
RM_DIR="$EXTRACT_DIR"
shopt -s nullglob
content_files=("$EXTRACT_DIR"/*.content)
shopt -u nullglob
if [ ${#content_files[@]} -gt 0 ]; then
  doc_uuid="$(basename "${content_files[0]}" .content)"
  if [ -d "$EXTRACT_DIR/$doc_uuid" ]; then
    RM_DIR="$EXTRACT_DIR/$doc_uuid"
  fi
fi

# Caller-friendly output: the rm-dir path on stdout, errors and
# rmapi progress on stderr. Pipe-friendly for chaining into
# render-strokes.sh.
echo "$RM_DIR"
