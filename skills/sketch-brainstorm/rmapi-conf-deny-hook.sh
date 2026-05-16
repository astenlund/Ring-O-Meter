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
  printf 'Blocked: rmapi conf access\n' >&2
  exit 2
fi

exit 0
