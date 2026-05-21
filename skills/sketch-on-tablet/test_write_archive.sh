#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TMP_HAPPY="$(mktemp -d)"
TMP_BAD_INVARIANT="$(mktemp -d)"
TMP_BAD_FLAG="$(mktemp -d)"
trap 'rm -rf "$TMP_HAPPY" "$TMP_BAD_INVARIANT" "$TMP_BAD_FLAG"' EXIT

# Helper: write a seven-iteration session under the given session-dir.
seed_session() {
  local target="$1"
  mkdir -p "$target/archive"
  {
    printf -- "---\nslug: foo\n---\n\n"
    for n in 00 01 02 03 04 05 06; do printf "## Iteration %s\n\nbody\n\n" "$n"; done
  } > "$target/design-state.md"
}

# Happy path: archive turn 00, keep 01..06.
seed_session "$TMP_HAPPY"
PAYLOAD='{"archive_content":"---\nturn-range: 00-00\n---\n\nSummary.\n","new_active_head_content":"---\nslug: foo\n---\n\n## Iteration 01\n\nbody\n\n## Iteration 02\n\nbody\n\n## Iteration 03\n\nbody\n\n## Iteration 04\n\nbody\n\n## Iteration 05\n\nbody\n\n## Iteration 06\n\nbody\n"}'

OUTPUT="$(printf '%s' "$PAYLOAD" | bash "$SCRIPT_DIR/write-archive.sh" \
  --session-dir "$TMP_HAPPY" \
  --turns-to-archive "00" \
  --turns-to-keep "01,02,03,04,05,06")"

[[ -f "$TMP_HAPPY/archive/001-pre-summary.md" ]] \
  || { echo "fail: archive file not created" >&2; exit 1; }
grep -q "## Iteration 00" "$TMP_HAPPY/design-state.md" \
  && { echo "fail: archived turn 00 still in design-state.md" >&2; exit 1; }
grep -q "## Iteration 06" "$TMP_HAPPY/design-state.md" \
  || { echo "fail: kept turn 06 missing from design-state.md" >&2; exit 1; }
echo "$OUTPUT" | grep -q "001-pre-summary.md" \
  || { echo "fail: stdout should report archive path; got: $OUTPUT" >&2; exit 1; }

# Negative: structural-invariant violation (turn 99 is neither archived
# nor kept; fires the extra-turn check) exits non-zero. Either of the
# three invariant directions would do here; the test only asserts the
# non-zero exit, not which branch fires. Fresh temp dir keeps this case
# independent of the happy-path mutations above, so a future regression
# that swapped validate-then-write to write-then-validate would leave a
# detectable orphan write.
seed_session "$TMP_BAD_INVARIANT"
BAD_PAYLOAD='{"archive_content":"---\nx\n---\n\ny","new_active_head_content":"---\n---\n\n## Iteration 99\n\nwrong\n"}'
if printf '%s' "$BAD_PAYLOAD" | bash "$SCRIPT_DIR/write-archive.sh" \
     --session-dir "$TMP_BAD_INVARIANT" \
     --turns-to-archive "01" \
     --turns-to-keep "02" >/dev/null 2>&1; then
  echo "fail: structural-invariant violation should exit non-zero" >&2
  exit 1
fi
# Confirm no orphan write occurred: the seeded design-state.md must be
# unchanged (still contains turn 00) and no archive file was created.
grep -q "## Iteration 00" "$TMP_BAD_INVARIANT/design-state.md" \
  || { echo "fail: rejected invariant violation left design-state.md mutated" >&2; exit 1; }
[[ -z "$(ls -A "$TMP_BAD_INVARIANT/archive")" ]] \
  || { echo "fail: rejected invariant violation wrote an orphan archive" >&2; exit 1; }

# Negative: missing required flag exits non-zero.
seed_session "$TMP_BAD_FLAG"
if printf '%s' "$PAYLOAD" | bash "$SCRIPT_DIR/write-archive.sh" \
     --session-dir "$TMP_BAD_FLAG" \
     --turns-to-keep "02" >/dev/null 2>&1; then
  echo "fail: missing --turns-to-archive must exit non-zero" >&2
  exit 1
fi

echo "test_write_archive: PASS"
