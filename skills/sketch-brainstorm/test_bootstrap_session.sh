#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Register both temp dirs in a single EXIT trap. RETURN traps only fire
# from functions or sourced scripts, NOT from top-level execution; if we
# layered a second `trap '...' RETURN` we'd leak the second tmp dir.
TMP="$(mktemp -d)"
TMP2="$(mktemp -d)"
trap 'rm -rf "$TMP" "$TMP2"' EXIT

# Run bootstrap-session.sh into a sandboxed SKETCH_BRAINSTORM_REPO_ROOT.
SKETCH_BRAINSTORM_REPO_ROOT="$TMP" \
  bash "$SCRIPT_DIR/bootstrap-session.sh" \
    --slug warmup-gate \
    --topic "warmup gate settings panel" \
    --description "design a settings panel for the warmup confirmation gate"

# Assert the session folder exists with the right name (date-prefixed).
TODAY="$(date -u +%Y-%m-%d)"
SESSION_DIR="$TMP/.tmp/sketch-brainstorm/sessions/${TODAY}-warmup-gate"
[[ -d "$SESSION_DIR" ]] || { echo "fail: session dir not created at $SESSION_DIR" >&2; exit 1; }

# Assert all five turn-typed subdirs exist (mockups, prerender, pulls,
# strokes, composites) plus archive/.
for sub in mockups prerender pulls strokes composites archive; do
  [[ -d "$SESSION_DIR/$sub" ]] || { echo "fail: subdir $sub missing" >&2; exit 1; }
done

# Assert usage.json exists (created empty for the future vocabulary-
# lifecycle slice's per-gesture tallies).
[[ -f "$SESSION_DIR/usage.json" ]] || { echo "fail: usage.json missing" >&2; exit 1; }

# Assert design-state.md exists with the expected frontmatter and iter-00
# section.
DS="$SESSION_DIR/design-state.md"
[[ -f "$DS" ]] || { echo "fail: design-state.md missing" >&2; exit 1; }

grep -q "^slug: warmup-gate$" "$DS" || { echo "fail: slug missing in frontmatter" >&2; exit 1; }
grep -q "^topic: warmup gate settings panel$" "$DS" || { echo "fail: topic missing" >&2; exit 1; }
grep -q "^current_mode: color$" "$DS" || { echo "fail: design-state.md missing 'current_mode: color' frontmatter" >&2; exit 1; }
grep -q "^## Iteration 00$" "$DS" || { echo "fail: ## Iteration 00 heading missing" >&2; exit 1; }
grep -q "warmup confirmation gate" "$DS" || { echo "fail: description not embedded" >&2; exit 1; }

# Idempotency re-run: bootstrap-session.sh should not overwrite design-state.md.
SKETCH_BRAINSTORM_REPO_ROOT="$TMP" \
  bash "$SCRIPT_DIR/bootstrap-session.sh" \
    --slug warmup-gate \
    --topic "warmup gate settings panel" \
    --description "DIFFERENT DESCRIPTION SHOULD NOT OVERWRITE"

# Original description should still be in the file.
grep -q "warmup confirmation gate" "$DS" || { echo "fail: idempotency violated; design-state.md was overwritten" >&2; exit 1; }
# The "DIFFERENT" sentinel must NOT appear.
if grep -q "DIFFERENT DESCRIPTION" "$DS"; then
  echo "fail: idempotency violated; new description leaked into existing design-state.md" >&2
  exit 1
fi
# A second "## Iteration 00" heading would also be a violation.
[[ "$(grep -c "^## Iteration 00$" "$DS")" -eq 1 ]] || { echo "fail: idempotency re-run added a second ## Iteration 00 heading" >&2; exit 1; }

# Assert blank-path produces an Iteration 00 section + usage.json.
SKETCH_BRAINSTORM_REPO_ROOT="$TMP2" \
  bash "$SCRIPT_DIR/bootstrap-session.sh" \
    --slug blank-test \
    --topic "blank test"

SESSION_DIR2="$TMP2/.tmp/sketch-brainstorm/sessions/${TODAY}-blank-test"
DS2="$SESSION_DIR2/design-state.md"
[[ -f "$DS2" ]] || { echo "fail: blank-path design-state.md missing" >&2; exit 1; }
grep -q "^## Iteration 00$" "$DS2" || { echo "fail: blank-path iter heading missing" >&2; exit 1; }
[[ -f "$SESSION_DIR2/usage.json" ]] || { echo "fail: blank-path usage.json missing" >&2; exit 1; }

# Negative test: slug with path separators must be rejected.
TMP3="$(mktemp -d)"
TMP4="$(mktemp -d)"
trap 'rm -rf "$TMP" "$TMP2" "$TMP3" "$TMP4"' EXIT
if SKETCH_BRAINSTORM_REPO_ROOT="$TMP3" \
     bash "$SCRIPT_DIR/bootstrap-session.sh" \
       --slug "evil/../boom" \
       --topic "shape test" 2>/dev/null; then
  echo "fail: slug with slash should have been rejected" >&2
  exit 1
fi

# Negative test: topic with newline must be rejected.
if SKETCH_BRAINSTORM_REPO_ROOT="$TMP3" \
     bash "$SCRIPT_DIR/bootstrap-session.sh" \
       --slug "newline-test" \
       --topic $'multi\nline' 2>/dev/null; then
  echo "fail: topic with newline should have been rejected" >&2
  exit 1
fi

# Negative test: missing arg value must be rejected with friendly message.
if SKETCH_BRAINSTORM_REPO_ROOT="$TMP3" \
     bash "$SCRIPT_DIR/bootstrap-session.sh" \
       --slug 2>/dev/null; then
  echo "fail: missing slug value should have been rejected" >&2
  exit 1
fi

# Negative test: with no SKETCH_BRAINSTORM_REPO_ROOT and PWD outside
# any Ring-O-Meter checkout, bootstrap-session.sh must hard-fail with
# the canonical diagnostic. The cd into TMP4 is load-bearing: without
# it, $PWD is the test script's CWD (the repo root) and find_repo_root
# would silently succeed, inverting the test. Run inside a subshell so
# the cd doesn't leak to sibling cases.
if NEG_OUTPUT="$(cd "$TMP4" && unset SKETCH_BRAINSTORM_REPO_ROOT && \
     bash "$SCRIPT_DIR/bootstrap-session.sh" \
       --slug "outside-repo-test" \
       --topic "no marker ancestor" 2>&1)"; then
  echo "fail: bootstrap-session.sh should have hard-failed outside a repo" >&2
  exit 1
fi
# Diagnostic string must match bootstrap-session.sh / find_repo_root in _lib.sh;
# update all three together when the marker filename changes.
case "$NEG_OUTPUT" in
  *"could not locate Ring-O-Meter.slnx"*) ;;
  *)
    echo "fail: missing 'could not locate Ring-O-Meter.slnx' diagnostic; got:" >&2
    echo "$NEG_OUTPUT" >&2
    exit 1
    ;;
esac

echo "all tests passed"
