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
#     --topic "warmup gate UI" --iteration seed \
#     --out .tmp/sketch-brainstorm/test/seed.pdf
#
# Required flags: --topic, --iteration, --out.
# Optional flag: --mockup-html (path to file with mockup HTML).
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

NODE_HOST="$REPO_ROOT/web"
if [ ! -d "$NODE_HOST/node_modules/playwright" ]; then
  echo "render-html-to-pdf.sh: playwright not found at $NODE_HOST/node_modules/playwright" >&2
  echo "  Run \`pnpm --dir $NODE_HOST install\` to install dependencies." >&2
  exit 1
fi

export SKETCH_BRAINSTORM_NODE_HOST="$NODE_HOST"
export SKETCH_BRAINSTORM_REPO_ROOT="$REPO_ROOT"
exec node "$SCRIPT_DIR/render/render.mjs" "$@"
