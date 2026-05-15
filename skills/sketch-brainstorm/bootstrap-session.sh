#!/usr/bin/env bash
# bootstrap-session.sh
#
# Create the per-session local folder skeleton and initialize
# design-state.md with frontmatter. Idempotent: rerunning against an
# existing session folder is a no-op (does not overwrite design-state.md).
#
# Args:
#   --slug <kebab-case slug>     (required)
#   --topic <human-readable>     (required; ends up in design-state.md
#                                 frontmatter and chat-rendered headers)
#   --description <text>         (optional; if present, goes into the
#                                 ## Iteration 00 section verbatim)
#
# The orchestrator runs this AFTER the chat-side bootstrap-lite prompts
# (cloud-path config, topic, description-or-blank, collision check)
# resolve. This wrapper handles only the deterministic mechanical bits.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

SLUG=""
TOPIC=""
DESCRIPTION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --slug)
      [[ $# -ge 2 ]] || { echo "bootstrap-session.sh: --slug requires a value" >&2; exit 1; }
      SLUG="$2"; shift 2;;
    --topic)
      [[ $# -ge 2 ]] || { echo "bootstrap-session.sh: --topic requires a value" >&2; exit 1; }
      TOPIC="$2"; shift 2;;
    --description)
      [[ $# -ge 2 ]] || { echo "bootstrap-session.sh: --description requires a value" >&2; exit 1; }
      DESCRIPTION="$2"; shift 2;;
    *) echo "bootstrap-session.sh: unknown flag: $1" >&2; exit 1;;
  esac
done

[[ -n "$SLUG" ]] || { echo "bootstrap-session.sh: --slug is required" >&2; exit 1; }
[[ -n "$TOPIC" ]] || { echo "bootstrap-session.sh: --topic is required" >&2; exit 1; }

# Reject path-traversal slugs and other shapes that would escape the
# session folder boundary; require strict kebab-case.
[[ "$SLUG" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || { echo "bootstrap-session.sh: --slug must be kebab-case (got: $SLUG)" >&2; exit 1; }

# Reject newlines in topic; an embedded newline would emit two YAML
# lines, the second without a key, breaking downstream parsers.
[[ "$TOPIC" != *$'\n'* ]] || { echo "bootstrap-session.sh: --topic must not contain newlines" >&2; exit 1; }

# Repo root: env override for tests; otherwise walk up from $PWD
# looking for the canonical Ring-O-Meter.slnx marker. Hard-fails
# rather than silently writing under whatever happens to be $PWD,
# matching render-html-to-pdf.sh's behaviour.
REPO_ROOT="${SKETCH_BRAINSTORM_REPO_ROOT:-}"
if [[ -z "$REPO_ROOT" ]]; then
  REPO_ROOT="$(find_repo_root "$PWD")" || {
    echo "bootstrap-session.sh: could not locate Ring-O-Meter.slnx walking up from $PWD" >&2
    echo "  Set SKETCH_BRAINSTORM_REPO_ROOT or invoke from inside the repo." >&2
    exit 1
  }
fi

TODAY="$(date -u +%Y-%m-%d)"
SESSION_DIR="$REPO_ROOT/.tmp/sketch-brainstorm/sessions/${TODAY}-${SLUG}"

# Create the directory tree (idempotent).
mkdir -p "$SESSION_DIR"/{mockups,prerender,pulls,strokes,composites,archive}

# Touch an empty usage.json (placeholder for the future vocabulary-
# lifecycle slice's per-gesture tallies). Idempotent: if it already
# exists with content, leave it alone; if absent, create empty.
USAGE="$SESSION_DIR/usage.json"
if [[ ! -f "$USAGE" ]]; then
  : > "$USAGE"
fi

# Initialize design-state.md only if absent (idempotent re-runs preserve
# accumulated state).
DS="$SESSION_DIR/design-state.md"
if [[ ! -f "$DS" ]]; then
  CREATED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  {
    printf '%s\n' '---'
    printf 'slug: %s\n' "$SLUG"
    printf 'topic: %s\n' "$TOPIC"
    printf 'created: %s\n' "$CREATED"
    printf 'current_mode: color\n'
    printf '%s\n' '---'
    printf '\n'
    printf '## Iteration 00\n\n'
    if [[ -n "$DESCRIPTION" ]]; then
      printf '%s\n' "$DESCRIPTION"
    else
      printf '%s\n' '(blank initial page; user sketched directly)'
    fi
    printf '\n'
  } > "$DS"
fi

# Print the session-folder path to stdout for orchestrator consumption.
printf '%s\n' "$SESSION_DIR"
