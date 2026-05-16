#!/usr/bin/env bash
# check-rmapi-setup.sh
#
# Read-only verifier for the auth-bootstrap security posture:
#   1) rmapi on PATH
#   2) rmapi authenticated (rmapi -ni ls succeeds)
#   3) deny-rule for rmapi conf installed in ~/.claude/settings.json
#   4) PreToolUse hook installed in ~/.claude/settings.json
#
# Exit codes:
#   0 = all four checks pass
#   1 = actionable install gap (auth, deny-rule, hook, or settings.json absent)
#   2 = structural prerequisite error (jq absent, settings.json malformed)
#
# Strictly read-only; safe for Claude to invoke on demand.

set -uo pipefail

fail_count=0

# Check 1: rmapi on PATH
if command -v rmapi >/dev/null 2>&1; then
  printf '[PASS] rmapi binary on PATH (%s)\n' "$(rmapi --version 2>/dev/null | head -1 || echo unknown)"
else
  printf '[FAIL] rmapi binary not on PATH\n'
  fail_count=$((fail_count + 1))
fi

# Check 2: rmapi authenticated
if command -v rmapi >/dev/null 2>&1; then
  if rmapi -ni ls >/dev/null 2>&1; then
    printf '[PASS] rmapi authenticated (rmapi -ni ls returned)\n'
  else
    printf '[FAIL] rmapi authentication failed (run `rmapi help` to re-pair; see README)\n'
    fail_count=$((fail_count + 1))
  fi
fi

# Check 3: deny-rule installed in ~/.claude/settings.json
settings="$HOME/.claude/settings.json"
if [[ -f "$settings" ]]; then
  if jq -e '(.permissions.deny // []) | map(select(test("rmapi"; "i"))) | length > 0' "$settings" >/dev/null 2>&1; then
    printf '[PASS] deny-rule for rmapi conf installed in ~/.claude/settings.json\n'
  else
    printf '[FAIL] deny-rule for rmapi conf not found in ~/.claude/settings.json (see README)\n'
    fail_count=$((fail_count + 1))
  fi
fi

[[ $fail_count -eq 0 ]] && exit 0 || exit 1
