#!/usr/bin/env bash
# Exercises hooks/pre-commit in throwaway repositories with stub dotnet and pnpm, so the staging logic is tested without running the real formatters.
# Usage: bash hooks/test-pre-commit.sh

set -u

SCRIPT_NAME=$(basename "${BASH_SOURCE[0]}")
REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
HOOK="$REPO_ROOT/hooks/pre-commit"

mkdir -p "$REPO_ROOT/.tmp"
WORK=$(mktemp -d "$REPO_ROOT/.tmp/pre-commit-test.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

STUBS="$WORK/stubs"
EMPTY_CONFIG="$WORK/empty.gitconfig"
mkdir -p "$STUBS"
: > "$EMPTY_CONFIG"

# Every git call below, setup and the hook's explicit --global and --system lookups included, reads an empty file for both scopes, so no user- or system-level hook, template or signing setting applies.
export GIT_CONFIG_GLOBAL="$EMPTY_CONFIG"
export GIT_CONFIG_SYSTEM="$EMPTY_CONFIG"

# The stubs stand in for the formatters: a "fix" rewrites BAD to GOOD in each named file, and every check passes.
cat > "$STUBS/pnpm" <<'STUB'
#!/bin/sh
case " $* " in
    *" eslint --fix "*)
        shift 3
        for f in "$@"; do
            content=$(cat "$f")
            printf '%s\n' "$(printf '%s' "$content" | sed 's/BAD/GOOD/g')" > "$f"
        done
        ;;
esac
exit 0
STUB
cat > "$STUBS/dotnet" <<'STUB'
#!/bin/sh
case " $* " in
    *" --verify-no-changes "*) exit 0 ;;
    *" format "*)
        shift 3
        for f in "$@"; do
            content=$(cat "$f")
            printf '%s\n' "$(printf '%s' "$content" | sed 's/BAD/GOOD/g')" > "$f"
        done
        ;;
esac
exit 0
STUB
chmod +x "$STUBS/pnpm" "$STUBS/dotnet"

# Prints PATH without every directory that holds the named program, so the hook's command -v probe cannot find it.
path_without() {
    local dir kept=
    local IFS=:
    for dir in $PATH; do
        if [ -n "$dir" ] && [ ! -e "$dir/$1" ] && [ ! -e "$dir/$1.exe" ] && [ ! -e "$dir/$1.cmd" ]; then
            kept="${kept:+$kept:}$dir"
        fi
    done
    printf '%s' "$kept"
}

STUB_PATH="$STUBS:$PATH"
NO_PNPM_PATH=$(path_without pnpm)
NO_DOTNET_PATH=$(path_without dotnet)

FAILURES=0
CASE_COUNT=0
SKIPPED=0

fail() {
    echo "FAIL [$CURRENT_CASE]: $1" >&2
    FAILURES=$((FAILURES + 1))
}

# Setup must succeed, otherwise the assertions that follow would misreport the cause.
setup_git() {
    git -C "$REPO" "$@" || { echo "$SCRIPT_NAME: setup failed in $CURRENT_CASE: git $*" >&2; exit 1; }
}

# Creates a repository with one committed C# file and two committed web files.
new_repo() {
    CURRENT_CASE=$1
    CASE_COUNT=$((CASE_COUNT + 1))
    REPO="$WORK/$1"
    mkdir -p "$REPO/hooks" "$REPO/web/src" "$REPO/src"
    cp "$HOOK" "$REPO/hooks/pre-commit"
    : > "$REPO/Ring-O-Meter.slnx"
    printf 'one\n' > "$REPO/web/src/a.ts"
    printf 'one\n' > "$REPO/web/src/b.ts"
    printf 'one\n' > "$REPO/src/A.cs"
    printf 'one\n' > "$REPO/README.md"
    setup_git init -q
    setup_git config user.name test
    setup_git config user.email test@example.invalid
    setup_git add -A
    setup_git commit -q -m init
    setup_git config core.hooksPath hooks
}

# Stages "staged" as a new line and leaves "unstaged" as a further unstaged line.
stage_partially() {
    printf 'one\nstaged\n' > "$REPO/$1"
    setup_git add -- "$1"
    printf 'one\nstaged\nunstaged\n' > "$REPO/$1"
}

# Reports whether a reduced PATH still provides what git needs to run the hook; a case whose PATH lost them is skipped, which fails the run as unverified.
path_runs_hook() {
    if PATH="$1" command -v git > /dev/null 2>&1 && PATH="$1" command -v sh > /dev/null 2>&1; then
        return 0
    fi
    echo "SKIP [$CURRENT_CASE]: removing the program from PATH also removed git or sh" >&2
    SKIPPED=$((SKIPPED + 1))
    return 1
}

run_commit() {
    COMMIT_ERR="$WORK/$CURRENT_CASE.stderr"
    COMMIT_STATUS=0
    (cd "$REPO" && PATH="$1" git commit -q -m change) 2> "$COMMIT_ERR" > /dev/null || COMMIT_STATUS=$?
}

expect_refused_naming() {
    if [ "$COMMIT_STATUS" -eq 0 ]; then
        fail "commit succeeded but should have been refused"
    fi
    for path in "$@"; do
        if ! grep -qF -e "$path" "$COMMIT_ERR"; then
            fail "refusal does not name $path: $(cat "$COMMIT_ERR")"
        fi
    done
    if [ "$(git -C "$REPO" rev-list --count HEAD)" != "1" ]; then
        fail "a commit was created"
    fi
}

expect_not_named() {
    local status=0
    grep -qF -e "$1" "$COMMIT_ERR" || status=$?
    case $status in
        0) fail "$1 was named as partially staged" ;;
        1) ;;
        *) fail "could not search the hook output for $1 (grep exited $status)" ;;
    esac
}

expect_committed() {
    if [ "$COMMIT_STATUS" -ne 0 ]; then
        fail "commit was refused: $(cat "$COMMIT_ERR")"
    fi
    if [ "$(git -C "$REPO" rev-list --count HEAD)" != "2" ]; then
        fail "no commit was created"
    fi
}

# A partially staged TS file is refused by name, and its index entry is left as the developer staged it.
new_repo partial-ts
stage_partially web/src/a.ts
run_commit "$STUB_PATH"
expect_refused_naming web/src/a.ts
if [ "$(git -C "$REPO" show :web/src/a.ts)" != "$(printf 'one\nstaged')" ]; then
    fail "the index entry was changed"
fi

# A partially staged C# file is refused by name.
new_repo partial-cs
stage_partially src/A.cs
run_commit "$STUB_PATH"
expect_refused_naming src/A.cs

# Every partially staged file is named, and a fully staged one beside them is not.
new_repo partial-mixed
stage_partially web/src/b.ts
stage_partially src/A.cs
printf 'one\ntwo\n' > "$REPO/web/src/a.ts"
setup_git add -- web/src/a.ts
run_commit "$STUB_PATH"
expect_refused_naming web/src/b.ts src/A.cs
expect_not_named web/src/a.ts

# Fully staged web and C# files are still fixed and re-staged, so the commit holds the fixed content.
new_repo full-stage-fixed
printf 'one\nBAD\n' > "$REPO/web/src/a.ts"
printf 'one\nBAD\n' > "$REPO/src/A.cs"
setup_git add -- web/src/a.ts src/A.cs
run_commit "$STUB_PATH"
expect_committed
for path in web/src/a.ts src/A.cs; do
    if [ "$(git -C "$REPO" show "HEAD:$path")" != "$(printf 'one\nGOOD')" ]; then
        fail "$path was not committed with the fix applied"
    fi
done

# A root-level file whose name starts with a dash is still recognized and refused.
new_repo partial-cs-leading-dash
stage_partially -Dash.cs
run_commit "$STUB_PATH"
expect_refused_naming -Dash.cs

# Without pnpm or dotnet the hook rewrites no file of that kind, so a partially staged one is committed as staged.
for missing in pnpm dotnet; do
    case $missing in
        pnpm) reduced_path=$NO_PNPM_PATH; partial_file=web/src/a.ts ;;
        dotnet) reduced_path=$NO_DOTNET_PATH; partial_file=src/A.cs ;;
    esac
    new_repo "partial-without-$missing"
    if path_runs_hook "$reduced_path"; then
        stage_partially "$partial_file"
        run_commit "$reduced_path"
        expect_committed
        if [ "$(git -C "$REPO" show "HEAD:$partial_file")" != "$(printf 'one\nstaged')" ]; then
            fail "the unstaged line reached the commit"
        fi
    fi
done

# A partially staged file of a kind the hook never rewrites is not refused.
new_repo partial-unhandled-kind
stage_partially README.md
run_commit "$STUB_PATH"
expect_committed

if [ "$FAILURES" -ne 0 ]; then
    echo "$SCRIPT_NAME: $FAILURES failure(s) across $CASE_COUNT cases ($SKIPPED skipped)" >&2
    exit 1
fi
# A skipped case never exercised its gate, so the run cannot count as a pass.
if [ "$SKIPPED" -ne 0 ]; then
    echo "$SCRIPT_NAME: $((CASE_COUNT - SKIPPED)) of $CASE_COUNT cases passed, $SKIPPED skipped and not verified" >&2
    exit 1
fi
echo "$SCRIPT_NAME: all $CASE_COUNT cases passed"
