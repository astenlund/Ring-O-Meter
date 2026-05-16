#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK="$SCRIPT_DIR/rmapi-conf-deny-hook.sh"

# Test: innocuous Bash call → exit 0 silent
out=$(printf '{"tool_name":"Bash","tool_input":{"command":"ls /tmp"}}' | bash "$HOOK" 2>&1 || true)
ec=$(printf '{"tool_name":"Bash","tool_input":{"command":"ls /tmp"}}' | bash "$HOOK" >/dev/null 2>&1 && echo 0 || echo $?)
[[ "$ec" == "0" ]] || { echo "fail: innocuous Bash should exit 0, got $ec" >&2; exit 1; }
[[ -z "$out" ]] || { echo "fail: innocuous Bash should be silent, got: $out" >&2; exit 1; }

echo "OK: hook no-match test passed"

# Test: Bash command containing rmapi.conf -> exit 2
ec=$(printf '{"tool_name":"Bash","tool_input":{"command":"cat ~/.config/rmapi/rmapi.conf"}}' | bash "$HOOK" >/dev/null 2>&1 && echo 0 || echo $?)
[[ "$ec" == "2" ]] || { echo "fail: Bash rmapi.conf read should exit 2, got $ec" >&2; exit 1; }

echo "OK: hook Bash-match test passed"
