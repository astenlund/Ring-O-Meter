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

# Test: Read tool with file_path containing rmapi.conf -> exit 2
ec=$(printf '{"tool_name":"Read","tool_input":{"file_path":"/home/user/.config/rmapi/rmapi.conf"}}' | bash "$HOOK" >/dev/null 2>&1 && echo 0 || echo $?)
[[ "$ec" == "2" ]] || { echo "fail: Read of rmapi.conf should exit 2, got $ec" >&2; exit 1; }

echo "OK: hook Read-file_path test passed"

# Test: Grep with path containing rmapi.conf -> exit 2 (Grep uses `path`, not `file_path`)
ec=$(printf '{"tool_name":"Grep","tool_input":{"pattern":"token","path":"/home/user/.config/rmapi/rmapi.conf"}}' | bash "$HOOK" >/dev/null 2>&1 && echo 0 || echo $?)
[[ "$ec" == "2" ]] || { echo "fail: Grep of rmapi.conf should exit 2, got $ec" >&2; exit 1; }

echo "OK: hook Grep-path test passed"

# Test: case-insensitive match (uppercase) -> exit 2
ec=$(printf '{"tool_name":"Bash","tool_input":{"command":"type RMAPI.CONF"}}' | bash "$HOOK" >/dev/null 2>&1 && echo 0 || echo $?)
[[ "$ec" == "2" ]] || { echo "fail: case-insensitive RMAPI.CONF should exit 2, got $ec" >&2; exit 1; }

echo "OK: hook case-insensitive test passed"

# Test: RMAPI_CONFIG sandbox probe (env var, no literal rmapi.conf) -> exit 0
ec=$(printf '{"tool_name":"Bash","tool_input":{"command":"RMAPI_CONFIG=/tmp/throwaway rmapi help"}}' | bash "$HOOK" >/dev/null 2>&1 && echo 0 || echo $?)
[[ "$ec" == "0" ]] || { echo "fail: RMAPI_CONFIG probe should exit 0, got $ec" >&2; exit 1; }

echo "OK: hook RMAPI_CONFIG probe test passed"

# Test: ordinary rmapi command -> exit 0
ec=$(printf '{"tool_name":"Bash","tool_input":{"command":"rmapi -ni ls"}}' | bash "$HOOK" >/dev/null 2>&1 && echo 0 || echo $?)
[[ "$ec" == "0" ]] || { echo "fail: rmapi -ni ls should exit 0, got $ec" >&2; exit 1; }

echo "OK: hook negative-case rmapi command test passed"

# Test: malformed stdin → exit 0 fail-open (not exit 2)
ec=$(printf 'not json' | bash "$HOOK" >/dev/null 2>&1 && echo 0 || echo $?)
[[ "$ec" == "0" ]] || { echo "fail: malformed stdin should exit 0, got $ec" >&2; exit 1; }

# Test: empty stdin → exit 0
ec=$(printf '' | bash "$HOOK" >/dev/null 2>&1 && echo 0 || echo $?)
[[ "$ec" == "0" ]] || { echo "fail: empty stdin should exit 0, got $ec" >&2; exit 1; }

echo "OK: hook fail-open tests passed"
