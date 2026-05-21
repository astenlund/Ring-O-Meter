#!/usr/bin/env bash
# check-rmapi-setup.sh
#
# Read-only verifier for the auth-bootstrap security posture:
#   1) rmapi on PATH
#   2) rmapi authenticated (rmapi -ni ls succeeds)
#   3) PreToolUse hook installed in ~/.claude/settings.json
#
# Exit codes:
#   0 = all three checks pass
#   1 = actionable install gap (auth, hook, or settings.json absent)
#   2 = structural prerequisite error (jq absent, settings.json malformed)
#
# Strictly read-only; safe for Claude to invoke on demand.

set -uo pipefail

fail_count=0
rmapi_found=false

# Check 1: rmapi on PATH
if command -v rmapi >/dev/null 2>&1; then
  rmapi_found=true
  printf '[PASS] rmapi binary on PATH (%s)\n' "$(rmapi --version 2>/dev/null | head -1 || echo unknown)"
else
  printf '[FAIL] rmapi binary not on PATH\n'
  fail_count=$((fail_count + 1))
fi

# Check 2: rmapi authenticated (skipped silently if Check 1 failed)
if [[ $rmapi_found == true ]]; then
  if rmapi -ni ls >/dev/null 2>&1; then
    printf '[PASS] rmapi authenticated (rmapi -ni ls returned)\n'
  else
    printf '[FAIL] rmapi authentication failed (run `rmapi help` to re-pair; see README)\n'
    fail_count=$((fail_count + 1))
  fi
fi

# Prerequisite for Check 3: jq must be on PATH.
if ! command -v jq >/dev/null 2>&1; then
  printf '[ERROR] jq required (needed for check 3)\n'
  exit 2
fi

# Check 3: PreToolUse hook referencing rmapi-conf-deny-hook installed
settings="$HOME/.claude/settings.json"
if [[ ! -f "$settings" ]]; then
  printf '[FAIL] settings.json not found at ~/.claude/settings.json (hook cannot be checked; see README)\n'
  fail_count=$((fail_count + 1))
else
  if ! jq -e . "$settings" >/dev/null 2>&1; then
    printf '[ERROR] settings.json is not valid JSON (hook cannot be checked; repair the file first)\n'
    exit 2
  fi
  # Must stay in sync with the hook's filename (rmapi-conf-deny-hook.sh).
  if jq -e '(.hooks.PreToolUse // []) | map(.hooks // [] | map(.command // "")) | flatten | map(select(test("rmapi-conf-deny-hook"))) | length > 0' "$settings" >/dev/null 2>&1; then
    printf '[PASS] PreToolUse hook for rmapi-conf-deny-hook.sh installed\n'
  else
    printf '[FAIL] PreToolUse hook for rmapi-conf-deny-hook.sh not found (see README)\n'
    fail_count=$((fail_count + 1))
  fi
fi

[[ $fail_count -eq 0 ]] && exit 0 || exit 1
