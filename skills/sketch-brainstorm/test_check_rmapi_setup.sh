#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CHECK="$SCRIPT_DIR/check-rmapi-setup.sh"

# Test: rmapi NOT on PATH -> check 1 FAIL line + non-zero exit
TMP="$(mktemp -d)"
# Comprehensive trap with TMPn placeholders (TMP2 onward populated by later
# test cases as they grow). ${TMPn:+"$TMPn"} expands to "$TMPn" when set, and
# to nothing when unset - avoiding rm -rf "" (which deletes cwd on some
# systems) when a test failed early before reaching a given mktemp call.
trap 'rm -rf "$TMP" ${TMP2:+"$TMP2"} ${TMP3:+"$TMP3"} ${TMP4:+"$TMP4"} ${TMP5:+"$TMP5"} ${TMP6:+"$TMP6"} ${TMP7:+"$TMP7"} ${TMP8:+"$TMP8"} ${TMP9:+"$TMP9"} ${TMP10:+"$TMP10"}' EXIT

# Build a PATH that strips the rmapi binary without removing bash/system tools.
# Setting PATH="$TMP" alone would drop bash itself (fatal on Windows Git Bash
# where bash is not on the default stripped path), so we filter only the directory
# that owns the real rmapi binary. If rmapi is absent, fall back to an empty-dir
# PATH element that still keeps the rest of PATH intact.
RMAPI_BIN="$(which rmapi 2>/dev/null || true)"
if [[ -n "$RMAPI_BIN" ]]; then
  RMAPI_DIR="$(dirname "$RMAPI_BIN")"
  NO_RMAPI_PATH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -vxF "$RMAPI_DIR" | tr '\n' ':')"
else
  NO_RMAPI_PATH="$TMP:$PATH"
fi

out=$(PATH="$NO_RMAPI_PATH" bash "$CHECK" 2>&1 || true)
ec=$(PATH="$NO_RMAPI_PATH" bash "$CHECK" >/dev/null 2>&1 && echo 0 || echo $?)
grep -q '\[FAIL\] rmapi binary not on PATH' <<<"$out" || { echo "fail: missing PATH-FAIL line; got: $out" >&2; exit 1; }
[[ "$ec" != "0" ]] || { echo "fail: rmapi-absent should produce non-zero exit, got 0" >&2; exit 1; }

echo "OK: verifier Check 1 (rmapi absent) test passed"

# Test: rmapi present but auth fails -> Check 1 PASS, Check 2 FAIL, non-zero exit
TMP2="$(mktemp -d)"
cat >"$TMP2/rmapi" <<'EOF'
#!/usr/bin/env bash
# Fake rmapi: --version succeeds; any other invocation fails with auth-expired stderr.
if [[ "${1:-}" == "--version" ]]; then
  echo "rmapi version 0.0.33 (fake)"
  exit 0
fi
echo "missing token, not asking, aborting" >&2
exit 1
EOF
chmod +x "$TMP2/rmapi"

out=$(PATH="$TMP2:$PATH" bash "$CHECK" 2>&1 || true)
ec=$(PATH="$TMP2:$PATH" bash "$CHECK" >/dev/null 2>&1 && echo 0 || echo $?)
grep -q '\[PASS\] rmapi binary on PATH' <<<"$out" || { echo "fail: missing PASS line for Check 1; got: $out" >&2; exit 1; }
grep -q '\[FAIL\] rmapi authentication' <<<"$out" || { echo "fail: missing Check 2 FAIL; got: $out" >&2; exit 1; }
[[ "$ec" == "1" ]] || { echo "fail: auth-failure should produce exit 1, got $ec" >&2; exit 1; }

rm -rf "$TMP2"
echo "OK: verifier Check 2 (auth) test passed"

# Test: settings.json with deny-rule containing "rmapi" -> Check 3 PASS
TMP3="$(mktemp -d)"
mkdir -p "$TMP3/.claude"
cat >"$TMP3/.claude/settings.json" <<'EOF'
{
  "permissions": {
    "deny": ["Read(//$HOME/.config/rmapi/**)"]
  }
}
EOF
out=$(HOME="$TMP3" bash "$CHECK" 2>&1 || true)
grep -q '\[PASS\] deny-rule' <<<"$out" || { echo "fail: missing Check 3 PASS; got: $out" >&2; exit 1; }

# Test: settings.json without rmapi deny entries -> Check 3 FAIL
TMP4="$(mktemp -d)"
mkdir -p "$TMP4/.claude"
cat >"$TMP4/.claude/settings.json" <<'EOF'
{"permissions": {"deny": ["Read(//$HOME/.ssh/**)"]}}
EOF
out=$(HOME="$TMP4" bash "$CHECK" 2>&1 || true)
grep -q '\[FAIL\] deny-rule' <<<"$out" || { echo "fail: missing Check 3 FAIL; got: $out" >&2; exit 1; }

rm -rf "$TMP3" "$TMP4"
echo "OK: verifier Check 3 (deny-rule) test passed"

# Test: settings.json with hook stanza referencing rmapi-conf-deny-hook.sh -> Check 4 PASS
TMP5="$(mktemp -d)"
mkdir -p "$TMP5/.claude"
cat >"$TMP5/.claude/settings.json" <<'EOF'
{
  "permissions": {"deny": ["Read(//$HOME/.config/rmapi/**)"]},
  "hooks": {
    "PreToolUse": [
      {"matcher": "Bash", "hooks": [{"type": "command", "command": "bash $HOME/.claude/skills/sketch-brainstorm/rmapi-conf-deny-hook.sh"}]}
    ]
  }
}
EOF
out=$(HOME="$TMP5" bash "$CHECK" 2>&1 || true)
grep -q '\[PASS\] PreToolUse hook' <<<"$out" || { echo "fail: missing Check 4 PASS; got: $out" >&2; exit 1; }

# Test: settings.json without rmapi hook -> Check 4 FAIL
TMP6="$(mktemp -d)"
mkdir -p "$TMP6/.claude"
cat >"$TMP6/.claude/settings.json" <<'EOF'
{"permissions": {"deny": ["Read(//$HOME/.config/rmapi/**)"]}, "hooks": {}}
EOF
out=$(HOME="$TMP6" bash "$CHECK" 2>&1 || true)
grep -q '\[FAIL\] PreToolUse hook' <<<"$out" || { echo "fail: missing Check 4 FAIL; got: $out" >&2; exit 1; }

rm -rf "$TMP5" "$TMP6"
echo "OK: verifier Check 4 (hook) test passed"
