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
trap 'rm -rf "$TMP" ${TMP2:+"$TMP2"} ${TMP3:+"$TMP3"} ${TMP4:+"$TMP4"} ${TMP5:+"$TMP5"} ${TMP6:+"$TMP6"} ${TMP7:+"$TMP7"} ${TMP8:+"$TMP8"}' EXIT

# Build a PATH that strips the rmapi binary without removing bash/system tools.
# Setting PATH="$TMP" alone would drop bash itself (fatal on Windows Git Bash
# where bash is not on the default stripped path), so we filter only the directory
# that owns the real rmapi binary. If rmapi is absent, fall back to an empty-dir
# PATH element that still keeps the rest of PATH intact.
RMAPI_BIN="$(command -v rmapi 2>/dev/null || true)"
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

# Test: settings.json with hook stanza referencing rmapi-conf-deny-hook.sh -> Check 3 PASS
TMP3="$(mktemp -d)"
mkdir -p "$TMP3/.claude"
cat >"$TMP3/.claude/settings.json" <<'EOF'
{
  "hooks": {
    "PreToolUse": [
      {"matcher": "Bash", "hooks": [{"type": "command", "command": "bash $HOME/.claude/skills/sketch-brainstorm/rmapi-conf-deny-hook.sh"}]}
    ]
  }
}
EOF
out=$(HOME="$TMP3" bash "$CHECK" 2>&1 || true)
grep -q '\[PASS\] PreToolUse hook' <<<"$out" || { echo "fail: missing Check 3 PASS; got: $out" >&2; exit 1; }

# Test: settings.json without rmapi hook (empty hooks object) -> Check 3 FAIL
TMP4="$(mktemp -d)"
mkdir -p "$TMP4/.claude"
cat >"$TMP4/.claude/settings.json" <<'EOF'
{"hooks": {}}
EOF
out=$(HOME="$TMP4" bash "$CHECK" 2>&1 || true)
grep -q '\[FAIL\] PreToolUse hook' <<<"$out" || { echo "fail: missing Check 3 FAIL (empty hooks); got: $out" >&2; exit 1; }

# Test: settings.json with PreToolUse hooks present but none referencing rmapi-conf-deny-hook -> Check 3 FAIL
cat >"$TMP4/.claude/settings.json" <<'EOF'
{"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "bash $HOME/.claude/hooks/other-hook.sh"}]}]}}
EOF
out=$(HOME="$TMP4" bash "$CHECK" 2>&1 || true)
grep -q '\[FAIL\] PreToolUse hook' <<<"$out" || { echo "fail: missing Check 3 FAIL (non-rmapi hooks present); got: $out" >&2; exit 1; }

rm -rf "$TMP3" "$TMP4"
echo "OK: verifier Check 3 (hook) test passed"

# Test: jq absent -> ERROR exit 2
TMP5="$(mktemp -d)"
# Fake rmapi that satisfies Checks 1 and 2 so only the jq guard is exercised.
cat >"$TMP5/rmapi" <<'EOF'
#!/usr/bin/env bash
[[ "${1:-}" == "--version" ]] && { echo "rmapi 0.0.33"; exit 0; }
exit 0
EOF
chmod +x "$TMP5/rmapi"

# Filter jq's directory out of PATH (analogous to NO_RMAPI_PATH in the first test).
JQ_BIN="$(command -v jq 2>/dev/null || true)"
if [[ -n "$JQ_BIN" ]]; then
  JQ_DIR="$(dirname "$JQ_BIN")"
  NO_JQ_PATH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -vxF "$JQ_DIR" | tr '\n' ':')"
else
  NO_JQ_PATH="$TMP5:$PATH"
fi

out=$(PATH="$TMP5:$NO_JQ_PATH" bash "$CHECK" 2>&1 || true)
ec=$(PATH="$TMP5:$NO_JQ_PATH" bash "$CHECK" >/dev/null 2>&1 && echo 0 || echo $?)
grep -q '\[ERROR\] jq required' <<<"$out" || { echo "fail: missing jq-absent ERROR; got: $out" >&2; exit 1; }
[[ "$ec" == "2" ]] || { echo "fail: jq-absent should exit 2, got $ec" >&2; exit 1; }

rm -rf "$TMP5"
echo "OK: verifier jq-absent test passed"

# Test: settings.json absent -> Check 3 FAIL with "not found", exit 1
TMP6="$(mktemp -d)"  # no .claude/settings.json inside
out=$(HOME="$TMP6" bash "$CHECK" 2>&1 || true)
ec=$(HOME="$TMP6" bash "$CHECK" >/dev/null 2>&1 && echo 0 || echo $?)
grep -q '\[FAIL\] settings.json not found' <<<"$out" || { echo "fail: missing settings.json-not-found FAIL; got: $out" >&2; exit 1; }
[[ "$ec" == "1" ]] || { echo "fail: settings.json-absent should exit 1, got $ec" >&2; exit 1; }

rm -rf "$TMP6"
echo "OK: verifier settings.json-absent test passed"

# Test: settings.json exists but malformed JSON -> ERROR exit 2
TMP7="$(mktemp -d)"
mkdir -p "$TMP7/.claude"
printf 'not json {{{' > "$TMP7/.claude/settings.json"
out=$(HOME="$TMP7" bash "$CHECK" 2>&1 || true)
ec=$(HOME="$TMP7" bash "$CHECK" >/dev/null 2>&1 && echo 0 || echo $?)
grep -q '\[ERROR\] settings.json is not valid JSON' <<<"$out" || { echo "fail: missing malformed-JSON ERROR; got: $out" >&2; exit 1; }
[[ "$ec" == "2" ]] || { echo "fail: malformed settings.json should exit 2, got $ec" >&2; exit 1; }

rm -rf "$TMP7"
echo "OK: verifier malformed-settings.json test passed"

# Test: all three checks pass -> exit 0
TMP8="$(mktemp -d)"
mkdir -p "$TMP8/.claude"
cat >"$TMP8/.claude/settings.json" <<'EOF'
{
  "hooks": {
    "PreToolUse": [
      {"matcher": "Bash", "hooks": [{"type": "command", "command": "bash $HOME/.claude/skills/sketch-brainstorm/rmapi-conf-deny-hook.sh"}]}
    ]
  }
}
EOF

# Fake rmapi that succeeds on both --version and -ni ls.
cat >"$TMP8/rmapi" <<'EOF'
#!/usr/bin/env bash
[[ "${1:-}" == "--version" ]] && { echo "rmapi 0.0.33 (fake)"; exit 0; }
# -ni ls case: emit a fake listing and exit 0
[[ "${1:-}" == "-ni" && "${2:-}" == "ls" ]] && { echo "[d] Trash"; exit 0; }
exit 0
EOF
chmod +x "$TMP8/rmapi"

# All-pass: capture both output and exit code from one invocation (this
# scenario always exits 0, so $? is unambiguous after the subshell).
out=$(HOME="$TMP8" PATH="$TMP8:$PATH" bash "$CHECK" 2>&1)
ec=$?
[[ "$ec" == "0" ]] || { echo "fail: all-pass scenario should exit 0, got $ec; output: $out" >&2; exit 1; }
# Should have exactly three PASS lines.
pass_count=$(grep -c '^\[PASS\]' <<<"$out" || echo 0)
[[ "$pass_count" == "3" ]] || { echo "fail: expected 3 PASS lines, got $pass_count; output: $out" >&2; exit 1; }

rm -rf "$TMP8"
echo "OK: verifier all-pass integration test passed"
