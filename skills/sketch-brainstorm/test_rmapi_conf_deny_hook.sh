#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK="$SCRIPT_DIR/rmapi-conf-deny-hook.sh"

# Hermetic sandbox shared by all tests that need filesystem fixtures or a
# scratch audit log. Hoisted to the top per the global rule "declare all
# mktemp -d temp dirs at the top of the script and register one trap EXIT".
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

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

# Test: audit log entry created on block
# The hook accepts an optional positional arg for the audit log path; the
# tests use it for hermetic isolation. Production callers (Claude Code's
# PreToolUse harness) pass no args, so the hook falls back to its default
# path.
printf '{"tool_name":"Bash","tool_input":{"command":"cat ~/.config/rmapi/rmapi.conf"}}' | \
  bash "$HOOK" "$TMP/audit.log" >/dev/null 2>&1 || true
[[ -f "$TMP/audit.log" ]] || { echo "fail: audit log not created" >&2; exit 1; }
# Column-exact assertion: context (col 3) contains the rmapi.conf excerpt
# AND resolved column (col 4) is literally "-" for a direct match (the
# Bash command field matched the regex literally, no symlink resolution
# triggered). Mirrors the column-exact awk style used by the symlink test
# below, so a regression that swaps the column layout fails here too.
awk -F'\t' '$3 ~ /rmapi\.conf/ && $4 == "-" {found=1} END {exit !found}' "$TMP/audit.log" \
  || { echo "fail: audit log direct-match expected col-3 to contain rmapi.conf and col-4 == \"-\"" >&2; cat "$TMP/audit.log" >&2; exit 1; }

echo "OK: hook audit log creation test passed"

# Test: exit 2 fires even when audit log path is unwritable
ec=$(printf '{"tool_name":"Bash","tool_input":{"command":"cat ~/.config/rmapi/rmapi.conf"}}' | \
       bash "$HOOK" "/nonexistent/dir/that/cannot/be/created/audit.log" >/dev/null 2>&1 && echo 0 || echo $?)
[[ "$ec" == "2" ]] || { echo "fail: hook must exit 2 even when log write fails, got $ec" >&2; exit 1; }

echo "OK: hook exit-2-on-unwritable-log test passed"

# Test: no audit entry on no-match (different filename so the positive test's
# log doesn't confuse the assertion)
printf '{"tool_name":"Bash","tool_input":{"command":"ls /tmp"}}' | \
  bash "$HOOK" "$TMP/no-match.log" >/dev/null 2>&1 || true
[[ ! -f "$TMP/no-match.log" ]] || { echo "fail: audit log created on no-match" >&2; exit 1; }

echo "OK: hook no-audit-on-no-match test passed"

# Test: stderr carries the "Blocked:" message on a match.
# Capture stderr only: 2>&1 1>/dev/null redirects stderr to the capture pipe
# while discarding stdout.
stderr_out=$(printf '{"tool_name":"Bash","tool_input":{"command":"cat ~/.config/rmapi/rmapi.conf"}}' | \
  bash "$HOOK" "$TMP/stderr-test.log" 2>&1 1>/dev/null || true)
grep -q "Blocked: rmapi conf access via" <<<"$stderr_out" || \
  { echo "fail: missing Blocked stderr; got: $stderr_out" >&2; exit 1; }

echo "OK: hook stderr message test passed"

# Test: Write tool with a non-existent absolute path -> exit 0. Pass chain:
# GNU realpath -m returns the absolute path unchanged; BSD realpath fails-
# open to empty; either way the haystack contains only the non-rmapi path.
ec=$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$TMP/new-file.txt" \
       | bash "$HOOK" >/dev/null 2>&1 && echo 0 || echo $?)
[[ "$ec" == "0" ]] || { echo "fail: non-existent path Write should exit 0, got $ec" >&2; exit 1; }

echo "OK: hook non-existent path test passed"

# Test: symlink-bypass blocked via realpath canonicalization.
# On Windows Git Bash / MSYS2, `ln -s` typically creates a copy rather than
# a real symlink unless MSYS=winsymlinks:nativestrict is set; skip symlink-
# creation tests there. The hook itself still works on Windows in production;
# only the test fixture setup is fragile. Glob match covers `msys` (Git
# Bash) and `msys2` (MSYS2 native bash).
if [[ "${OSTYPE:-}" == msys* ]]; then
  echo "SKIP: Windows symlink creation requires MSYS=winsymlinks:nativestrict"
else
  echo "fake-token" > "$TMP/fake-rmapi.conf"
  ln -s "$TMP/fake-rmapi.conf" "$TMP/token"
  # Fresh audit log path per-test so the awk column-exact assertion below
  # scans only this test's output, not earlier tests that share `$TMP/audit.log`.
  ec=$(printf '{"tool_name":"Read","tool_input":{"file_path":"%s"}}' "$TMP/token" \
         | bash "$HOOK" "$TMP/audit-symlink.log" >/dev/null 2>&1 && echo 0 || echo $?)
  [[ "$ec" == "2" ]] || { echo "fail: symlink to rmapi.conf should exit 2, got $ec" >&2; exit 1; }

  echo "OK: hook symlink-bypass blocked test passed"

  # Column-exact assertion: the 4th tab-separated column must contain the
  # resolved path (the symlink's target), not the symlink name. Substring
  # grep would also pass on a bug that put the resolved path in the wrong
  # column; awk -F'\t' on $4 is column-exact.
  awk -F'\t' '$4 ~ /fake-rmapi\.conf/ {found=1} END {exit !found}' "$TMP/audit-symlink.log" \
    || { echo "fail: audit log 4th column missing resolved path" >&2; cat "$TMP/audit-symlink.log" >&2; exit 1; }

  echo "OK: hook symlink-bypass 4th column test passed"

  # Test: legitimate symlink to a NON-rmapi file -> exit 0 (must not over-block).
  # Confirms realpath canonicalization doesn't false-positive on unrelated symlinks.
  echo "other-content" > "$TMP/other.txt"
  ln -s "$TMP/other.txt" "$TMP/alias"
  ec=$(printf '{"tool_name":"Read","tool_input":{"file_path":"%s"}}' "$TMP/alias" \
         | bash "$HOOK" >/dev/null 2>&1 && echo 0 || echo $?)
  [[ "$ec" == "0" ]] || { echo "fail: symlink to non-rmapi target should exit 0, got $ec" >&2; exit 1; }

  echo "OK: hook symlink-to-non-rmapi test passed"
fi
