#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Case 1: absent design-state.md → trigger=false
OUTPUT="$(bash "$SCRIPT_DIR/check-compression-needed.sh" "$TMP")"
echo "$OUTPUT" | grep -q '"trigger": false' \
  || { echo "fail: absent design-state.md should report trigger=false; got: $OUTPUT" >&2; exit 1; }

# Case 2: below threshold → trigger=false
{
  printf -- "---\nslug: foo\n---\n\n"
  for n in 00 01 02 03 04 05; do printf "## Iteration %s\n\nbody\n\n" "$n"; done
} > "$TMP/design-state.md"
OUTPUT="$(bash "$SCRIPT_DIR/check-compression-needed.sh" "$TMP")"
echo "$OUTPUT" | grep -q '"trigger": false' \
  || { echo "fail: below threshold should report trigger=false; got: $OUTPUT" >&2; exit 1; }

# Case 3: above threshold → trigger=true with expected fields
{
  printf -- "---\nslug: foo\n---\n\n"
  for n in 00 01 02 03 04 05 06; do printf "## Iteration %s\n\nbody\n\n" "$n"; done
} > "$TMP/design-state.md"
OUTPUT="$(bash "$SCRIPT_DIR/check-compression-needed.sh" "$TMP")"
echo "$OUTPUT" | grep -q '"trigger": true' \
  || { echo "fail: above threshold should report trigger=true; got: $OUTPUT" >&2; exit 1; }
echo "$OUTPUT" | grep -q '"archive_nnn": "001"' \
  || { echo "fail: archive_nnn should be 001; got: $OUTPUT" >&2; exit 1; }

# Case 4: missing argument exits non-zero
if bash "$SCRIPT_DIR/check-compression-needed.sh" >/dev/null 2>&1; then
  echo "fail: missing session-dir argument should exit non-zero" >&2
  exit 1
fi

echo "test_check_compression_needed: PASS"
