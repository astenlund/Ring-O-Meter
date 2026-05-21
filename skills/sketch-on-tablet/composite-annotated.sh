#!/usr/bin/env bash
# composite-annotated.sh
#
# Composites stroke SVG overlays onto the source PDF, producing one PNG
# per annotated page. Output feeds the interpretation subagent. Owns
# just the composite step; rasterization happens via PyMuPDF (PDF + SVG)
# and Pillow (alpha-composite) inside the shared sketch-on-tablet
# Python venv. cairosvg was tried first but rejected: cairocffi requires
# a system libcairo DLL that isn't bundled with the pip wheel on Windows
# without GTK / MSYS2; PyMuPDF handles SVG natively with no system deps.
#
# Usage from a host repo root:
#   bash .claude/skills/sketch-on-tablet/composite-annotated.sh \
#     --pdf .tmp/sketch-on-tablet/pulls/iter01/<doc-uuid>.pdf \
#     --strokes-dir .tmp/sketch-on-tablet/pulls/iter01-svgs/ \
#     --out-dir .tmp/sketch-on-tablet/pulls/iter01-composites/
#
# Required flags: --pdf, --strokes-dir, --out-dir
#
# Output: one composite-pageN.png per strokes-pageN.svg present in
# strokes-dir, written under <out-dir>. Pages without an SVG (i.e.,
# pages with zero strokes) are skipped silently because the
# interpretation subagent only needs to read pages that carry user
# annotations.
#
# Source PDF: the .rmdoc archive's <doc-uuid>.pdf, surfaced by the pull
# wrapper at <pull-out-dir>/<basename>/<doc-uuid>.pdf for annotated
# docs (manifest sits one level above the rm-dir; see README rmapi
# quirks). Pass that path directly.
#
# Dependencies:
#   - python (3.10+) on PATH
#   - The shared skill venv at skills/sketch-on-tablet/.venv with
#     pymupdf and Pillow installed (rmscene is in the venv too via the
#     shared requirements.txt). Bootstrapped on first run via _lib.sh's
#     ensure_skill_venv; rebootstraps when requirements.txt drifts.
#
# Windows note: invoke via Git Bash or WSL.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"
REQUIREMENTS="$SCRIPT_DIR/requirements.txt"
COMPOSITE_SCRIPT="$SCRIPT_DIR/render/composite-annotated.py"
. "$SCRIPT_DIR/_lib.sh"

usage() {
  cat >&2 <<EOF
Usage: $0 --pdf <pdf> --strokes-dir <strokes-dir> --out-dir <out-dir>

Required flags:
  --pdf           Source PDF (e.g., the .rmdoc archive's <doc-uuid>.pdf
                  one level above the rm-dir; see README rmapi quirks).
  --strokes-dir   Directory containing strokes-pageN.svg overlays from
                  render-strokes.sh.
  --out-dir       Directory to receive composite-pageN.png files.
                  Created if missing.

Composites each strokes-pageN.svg onto PDF page N at 1620x2160 px (the
reMarkable Paper Pro viewport) and writes composite-pageN.png. Pages
without strokes are skipped silently.
EOF
  exit 1
}

PDF=""
STROKES_DIR=""
OUT_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --pdf)
      [ $# -ge 2 ] || { echo "--pdf requires a value" >&2; usage; }
      PDF="$2"
      shift 2
      ;;
    --strokes-dir)
      [ $# -ge 2 ] || { echo "--strokes-dir requires a value" >&2; usage; }
      STROKES_DIR="$2"
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

[ -n "$PDF" ] || { echo "composite-annotated.sh: --pdf is required" >&2; usage; }
[ -n "$STROKES_DIR" ] || { echo "composite-annotated.sh: --strokes-dir is required" >&2; usage; }
[ -n "$OUT_DIR" ] || { echo "composite-annotated.sh: --out-dir is required" >&2; usage; }
[ -f "$PDF" ] || { echo "composite-annotated.sh: PDF not found: $PDF" >&2; exit 1; }
[ -d "$STROKES_DIR" ] || { echo "composite-annotated.sh: strokes-dir not found: $STROKES_DIR" >&2; exit 1; }

ensure_skill_venv "composite-annotated.sh"
exec "$VENV_PYTHON" "$COMPOSITE_SCRIPT" "$PDF" "$STROKES_DIR" "$OUT_DIR"
