#!/usr/bin/env bash
# render-html-to-pdf.sh
#
# Bash entry point for the sketch-brainstorm render pipeline. Resolves
# the host repo root, points the Node script at the resolved playwright
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
#   --current-mode <mode>    active render mode: color (default), bw, wireframe.
#                            Drives the chrome footer's mode-switch pre-fill
#                            so cross-machine pixel detection can recover the
#                            active mode from a rendered page.
#   --prerender-out <dir>    after PDF, also export per-page PNGs as
#                            <basename>-page1.png, ...-page2.png
#
# Windows note: invoke via Git Bash or WSL. PowerShell users:
#   bash .claude/skills/sketch-brainstorm/render-html-to-pdf.sh ...

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

REPO_ROOT="$(find_repo_root "$SCRIPT_DIR")" || {
  echo "render-html-to-pdf.sh: could not locate Ring-O-Meter.slnx walking up from $SCRIPT_DIR" >&2
  echo "  (host repo detection assumes the Ring-O-Meter shape; portable packaging is a followup)" >&2
  exit 1
}

# Required by ensure_skill_venv: VENV_DIR + REQUIREMENTS scope vars must be
# set in caller; ensure_skill_venv reads them by name and exports VENV_PYTHON
# back to caller scope on success. Same shape as render-strokes.sh.
VENV_DIR="$SCRIPT_DIR/.venv"
REQUIREMENTS="$SCRIPT_DIR/requirements.txt"

# Resolve Playwright host: prefer per-skill node_modules (gist-
# publication layout); fall back to host repo's web/node_modules
# (in-repo incubation path). render.mjs's createRequire walks
# node_modules from whatever path SKETCH_BRAINSTORM_NODE_HOST points
# at.
NODE_HOST=""
for candidate in "$SCRIPT_DIR" "$REPO_ROOT/web"; do
  if [ -d "$candidate/node_modules/playwright" ]; then
    NODE_HOST="$candidate"
    break
  fi
done
if [ -z "$NODE_HOST" ]; then
  echo "render-html-to-pdf.sh: playwright not found in $SCRIPT_DIR/node_modules or $REPO_ROOT/web/node_modules" >&2
  echo "  Run \`npm install\` in $SCRIPT_DIR (skill-local) or \`pnpm --dir $REPO_ROOT/web install\` (host repo)." >&2
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
CURRENT_MODE="color"
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
    --current-mode)
      [[ $# -ge 2 ]] || { echo "render-html-to-pdf.sh: --current-mode requires a value" >&2; exit 1; }
      CURRENT_MODE="$2"; shift 2;;
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
# --subtopic, --mockup-html, and --current-mode are forwarded only when set.
# --current-mode always has a value (defaults to color above), so always
# forward it; render.mjs validates against the allowed set.
NODE_ARGS=( --topic "$TOPIC" --iteration "$ITERATION" --out "$OUT" --current-mode "$CURRENT_MODE" )
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
