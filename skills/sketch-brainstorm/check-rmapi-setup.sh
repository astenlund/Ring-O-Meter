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

# (Checks 2-4 added in following tasks.)

[[ $fail_count -eq 0 ]] && exit 0 || exit 1
