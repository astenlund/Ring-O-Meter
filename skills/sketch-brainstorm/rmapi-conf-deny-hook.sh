#!/usr/bin/env bash
# rmapi-conf-deny-hook.sh
#
# PreToolUse hook that blocks tool calls referencing the rmapi conf file.
# Reads tool-call JSON on stdin; exits 2 (block) on match; exits 0 (pass)
# on no-match or malformed JSON (fail-open).
#
# See `.claude/features/remarkable-tablet-brainstorm.md` (Transport section)
# for the design.

set -uo pipefail

input=$(cat)

# Fail-open on malformed JSON - Claude Code's protocol version may change
# the envelope shape; blocking on parse failure would be a false-positive.
if ! tool_command=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null); then
  exit 0
fi

file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // ""' 2>/dev/null || echo "")
grep_path=$(printf '%s' "$input" | jq -r '.tool_input.path // ""' 2>/dev/null || echo "")
haystack="$tool_command $file_path $grep_path"

if printf '%s' "$haystack" | grep -iq 'rmapi\.conf'; then
  # Optional positional arg overrides the audit log path (used by tests for
  # hermetic isolation). Production callers pass no args; fallback is default.
  log_path="${1:-$HOME/.claude/sketch-brainstorm-conf-access.log}"
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  # NOTE: verify the actual Claude Code hook envelope field before shipping.
  # Claude Code may use `.tool` instead of `.tool_name` for the tool identifier.
  # The block/pass behavior does not depend on this (it depends on the regex match),
  # so the worst case of a wrong field name is audit log entries showing "unknown"
  # instead of "Bash"/"Read"/etc. Confirm empirically or from CC docs.
  tool_name=$(printf '%s' "$input" | jq -r '.tool_name // "unknown"' 2>/dev/null || echo "unknown")
  # First non-empty field, truncated to 500 chars.
  context=""
  for field in "$tool_command" "$file_path" "$grep_path"; do
    if [[ -n "$field" ]]; then
      context="${field:0:500}"
      break
    fi
  done
  # Best-effort: directory create + append both ignored on failure so a
  # log-write problem does not prevent the exit 2 block.
  mkdir -p "$(dirname "$log_path")" 2>/dev/null || true
  printf '%s\t%s\t%s\n' "$ts" "$tool_name" "$context" >> "$log_path" 2>/dev/null || true
  printf 'Blocked: rmapi conf access via %s\n' "$tool_name" >&2
  exit 2
fi

exit 0
