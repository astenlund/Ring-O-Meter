#!/usr/bin/env bash
# _lib.sh
#
# Shared helpers for sketch-brainstorm wrappers. Source from a wrapper:
#
#   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   . "$SCRIPT_DIR/_lib.sh"
#
# This file is not intended to be executed directly. It carries no
# top-level side effects beyond function declarations; sourcing it is
# safe at any point before the first call.
#
# Rationale: the rmapi auth precondition was inlined in each transport
# wrapper (push, pull) verbatim. The QUICK_WINS-trigger rule for the
# sibling `find_repo_root` extraction (extract when a second consumer
# arrives) applies here once the second consumer landed; the pull
# wrapper made it the second consumer of the auth shape. The polling
# daemon is now the third; a future `setup-rmapi.sh` helper will reuse
# this same precondition.

# require_python <wrapper-name>
#
# Verifies python 3.10+ is on PATH. On failure, prints a script-prefixed
# diagnostic and exits the calling wrapper with status 1. Used by
# wrappers that need Python for stdlib-only operations (e.g., zipfile
# extraction) without necessarily bootstrapping the skill venv. Also
# called internally by ensure_skill_venv, which needs Python both for
# the dep hash and for the venv itself.
require_python() {
  local prefix="$1"
  if ! command -v python >/dev/null 2>&1; then
    echo "$prefix: 'python' not on PATH. Install Python 3.10+ first." >&2
    exit 1
  fi
  if ! python -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" 2>/dev/null; then
    echo "$prefix: Python 3.10+ required; found $(python --version 2>&1)." >&2
    exit 1
  fi
}

# require_rmapi_authenticated <wrapper-name>
#
# Verifies rmapi is on PATH and can list the cloud root (i.e., the
# token at $RMAPI_CONFIG / ~/.rmapi is present and valid AND the cloud
# is reachable). On failure, prints a script-prefixed diagnostic
# pointing at re-pairing and exits the calling wrapper with status 1.
#
# The <wrapper-name> argument prefixes diagnostics so a user who sees
# the error in a chained pipeline can tell which wrapper failed.
#
# Token hygiene: this function never reads or echoes ~/.rmapi. rmapi
# itself reads the token internally; we only invoke 'rmapi ls' and
# discard its output. This function's diagnostics carry only static
# hand-written text, never rmapi's own output. Note this is a local
# property, not a skill-wide invariant: sibling wrappers that need to
# surface real rmapi errors (e.g., the 'rmapi get' failure path in
# pull-from-tablet.sh) deliberately let rmapi's stderr through, which
# is correct for those error paths but worth knowing when adding new
# rmapi invocations elsewhere in the skill.
require_rmapi_authenticated() {
  local prefix="$1"
  if ! command -v rmapi >/dev/null 2>&1; then
    echo "$prefix: rmapi not on PATH" >&2
    echo "  Install rmapi (https://github.com/ddvk/rmapi) and pair the machine" >&2
    echo "  via the future setup-rmapi.sh helper (or rmapi's first-run prompt)." >&2
    exit 1
  fi
  if ! rmapi ls >/dev/null 2>&1; then
    echo "$prefix: rmapi cannot list the cloud root" >&2
    echo "  Token missing or expired. Re-pair the machine, or run" >&2
    echo "  'rmapi ls' interactively to surface the underlying error." >&2
    exit 1
  fi
}

# _detect_venv_python
#
# Internal helper: print the path to the venv's python executable, or
# return non-zero if no venv is present yet. Handles the POSIX vs
# Windows venv layouts (bin/python vs Scripts/python.exe).
_detect_venv_python() {
  if [ -x "$VENV_DIR/bin/python" ]; then
    echo "$VENV_DIR/bin/python"
  elif [ -x "$VENV_DIR/Scripts/python.exe" ]; then
    echo "$VENV_DIR/Scripts/python.exe"
  else
    return 1
  fi
}

# ensure_skill_venv <wrapper-name>
#
# Ensures the shared skill venv at $VENV_DIR exists and reflects the
# current $REQUIREMENTS hash. Bootstraps if absent or if requirements
# have drifted since the venv was created. On success, the variable
# VENV_PYTHON is set in the calling shell to the venv's python.
#
# Caller must set $VENV_DIR and $REQUIREMENTS before invoking. The
# <wrapper-name> argument prefixes diagnostics so the user can tell
# which wrapper is bootstrapping.
#
# Drift detection: hashes $REQUIREMENTS via Python (always available
# as a hard dep, simpler than juggling sha256sum vs shasum portability),
# stores the digest at $VENV_DIR/.req-hash after a successful install,
# compares on subsequent runs and rebootstraps on divergence. Existing
# 'rm -rf "$VENV_DIR"' wipes the sentinel, so no separate cleanup
# step is needed when the venv is being recreated.
ensure_skill_venv() {
  local prefix="$1"
  require_python "$prefix"
  local current_hash stored_hash need
  current_hash="$(python -c "import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" "$REQUIREMENTS")"
  stored_hash="$(cat "$VENV_DIR/.req-hash" 2>/dev/null || true)"
  need=false
  if ! _detect_venv_python >/dev/null 2>&1; then
    need=true
  elif [ "$stored_hash" != "$current_hash" ]; then
    echo "$prefix: requirements.txt has changed since venv bootstrap; rebootstrapping..."
    need=true
  fi
  if $need; then
    echo "$prefix: bootstrapping venv at $VENV_DIR..."
    rm -rf "$VENV_DIR"
    python -m venv "$VENV_DIR"
    VENV_PYTHON="$(_detect_venv_python)"
    "$VENV_PYTHON" -m pip install --quiet --upgrade pip
    "$VENV_PYTHON" -m pip install --quiet -r "$REQUIREMENTS"
    echo "$current_hash" > "$VENV_DIR/.req-hash"
    echo "$prefix: venv ready"
  else
    VENV_PYTHON="$(_detect_venv_python)"
  fi
}
