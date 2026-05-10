#!/usr/bin/env bash
# render-html-to-pdf.sh
#
# Bash entry point for the sketch-brainstorm render pipeline. Resolves
# the host repo root, points the Node script at the host's playwright
# install via SKETCH_BRAINSTORM_NODE_HOST, and forwards CLI flags to
# render.mjs.
#
# Usage from a host repo root:
#   bash .claude/skills/sketch-brainstorm/render-html-to-pdf.sh \
#     --topic "warmup gate UI" --iteration 00 \
#     --out .tmp/sketch-brainstorm/test/warmup-gate-00.pdf
#
# Required flags: --topic, --iteration (two-digit zero-padded NN), --out.
# Optional flags:
#   --subtopic <string>      forward-compat for multi-sketch headers
#   --mockup-html <path>     path to file with mockup HTML body
#   --prerender-out <dir>    after PDF, also export per-page PNGs as
#                            <basename>-page1.png, ...-page2.png
#
# Windows note: invoke via Git Bash or WSL. PowerShell users:
#   bash .claude/skills/sketch-brainstorm/render-html-to-pdf.sh ...

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Walk up from the script directory looking for Ring-O-Meter.slnx
# (the host repo's marker file). When the skill ships to its own gist,
# this routine becomes "look up node_modules/playwright reachable from
# the gist's own checkout".
find_repo_root() {
  local dir="$SCRIPT_DIR"
  while [ "$dir" != "/" ] && [ "$dir" != "" ]; do
    if [ -f "$dir/Ring-O-Meter.slnx" ]; then
      echo "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}

REPO_ROOT="$(find_repo_root)" || {
  echo "render-html-to-pdf.sh: could not locate Ring-O-Meter.slnx walking up from $SCRIPT_DIR" >&2
  echo "  (host repo detection assumes the Ring-O-Meter shape; portable packaging is a followup)" >&2
  exit 1
}

# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

# Required by ensure_skill_venv: VENV_DIR + REQUIREMENTS scope vars must be
# set in caller; ensure_skill_venv reads them by name and exports VENV_PYTHON
# back to caller scope on success. Same shape as render-strokes.sh.
VENV_DIR="$SCRIPT_DIR/.venv"
REQUIREMENTS="$SCRIPT_DIR/requirements.txt"

NODE_HOST="$REPO_ROOT/web"
if [ ! -d "$NODE_HOST/node_modules/playwright" ]; then
  echo "render-html-to-pdf.sh: playwright not found at $NODE_HOST/node_modules/playwright" >&2
  echo "  Run \`pnpm --dir $NODE_HOST install\` to install dependencies." >&2
  exit 1
fi

export SKETCH_BRAINSTORM_NODE_HOST="$NODE_HOST"
export SKETCH_BRAINSTORM_REPO_ROOT="$REPO_ROOT"

# Parse flags. We can no longer pass "$@" through verbatim because
# --prerender-out is a wrapper-side flag (not consumed by render.mjs)
# and we need to capture it for the post-render step below.
TOPIC=""
ITERATION=""
SUBTOPIC=""
MOCKUP_HTML=""
OUT=""
PRERENDER_OUT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --topic)
      [[ $# -ge 2 ]] || { echo "render-html-to-pdf.sh: --topic requires a value" >&2; exit 1; }
      TOPIC="$2"; shift 2;;
    --iteration)
      [[ $# -ge 2 ]] || { echo "render-html-to-pdf.sh: --iteration requires a value" >&2; exit 1; }
      ITERATION="$2"; shift 2;;
    --subtopic)
      [[ $# -ge 2 ]] || { echo "render-html-to-pdf.sh: --subtopic requires a value" >&2; exit 1; }
      SUBTOPIC="$2"; shift 2;;
    --mockup-html)
      [[ $# -ge 2 ]] || { echo "render-html-to-pdf.sh: --mockup-html requires a value" >&2; exit 1; }
      MOCKUP_HTML="$2"; shift 2;;
    --out)
      [[ $# -ge 2 ]] || { echo "render-html-to-pdf.sh: --out requires a value" >&2; exit 1; }
      OUT="$2"; shift 2;;
    --prerender-out)
      [[ $# -ge 2 ]] || { echo "render-html-to-pdf.sh: --prerender-out requires a value" >&2; exit 1; }
      PRERENDER_OUT="$2"; shift 2;;
    *)
      echo "render-html-to-pdf.sh: unknown flag: $1" >&2
      exit 1
      ;;
  esac
done

# Build node argv: --topic, --iteration, --out are required by render.mjs;
# --subtopic and --mockup-html are forwarded only when set.
NODE_ARGS=( --topic "$TOPIC" --iteration "$ITERATION" --out "$OUT" )
if [[ -n "$SUBTOPIC" ]]; then
  NODE_ARGS+=( --subtopic "$SUBTOPIC" )
fi
if [[ -n "$MOCKUP_HTML" ]]; then
  NODE_ARGS+=( --mockup-html "$MOCKUP_HTML" )
fi

node "$SCRIPT_DIR/render/render.mjs" "${NODE_ARGS[@]}"

if [[ -n "$PRERENDER_OUT" ]]; then
  ensure_skill_venv "render-html-to-pdf.sh"
  # Strip .pdf or .PDF suffix from --out path; either casing is acceptable
  # because basename's suffix arg is case-sensitive on Linux/macOS.
  PREFIX="$(basename "${OUT%.[Pp][Dd][Ff]}")"
  "$VENV_PYTHON" "$SCRIPT_DIR/render/prerender-pages.py" \
    --pdf "$OUT" \
    --out-dir "$PRERENDER_OUT" \
    --prefix "$PREFIX"
fi
