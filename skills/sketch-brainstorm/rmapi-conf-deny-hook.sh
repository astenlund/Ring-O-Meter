#!/usr/bin/env bash
# rmapi-conf-deny-hook.sh
#
# PreToolUse hook that blocks tool calls referencing the rmapi conf file.
# Reads tool-call JSON on stdin; exits 2 (block) on match; exits 0 (pass)
# on no-match or malformed JSON (fail-open).
#
# Optional: pass an absolute path as $1 to override the default audit log
# (~/.claude/sketch-brainstorm-conf-access.log). Used by tests for isolation.
#
# See `.claude/features/remarkable-tablet-brainstorm.md` (Transport section)
# for the design.

set -uo pipefail

input=$(cat)

# Extract the three tool-specific path/command fields in one jq invocation.
# Tab-separated output lets `read` split them without spawning extra processes.
# Fail-open on malformed JSON (jq exits non-zero) - Claude Code's protocol
# version may change the envelope shape; blocking on parse failure would be
# a false-positive.
if ! fields=$(printf '%s' "$input" | jq -r '
  [ (.tool_input.command   // ""),
    (.tool_input.file_path // ""),
    (.tool_input.path      // "") ] | join("\t")
' 2>/dev/null); then
  exit 0
fi
IFS=$'\t' read -r tool_command file_path grep_path <<< "$fields"
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
  # First non-empty field, truncated to 500 chars. The "" init is a set -u
  # guard: if none of the three fields is non-empty the printf below would
  # reference an unset variable, though in practice a haystack match guarantees
  # at least one non-empty field.
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
