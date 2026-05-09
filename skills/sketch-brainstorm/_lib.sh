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
# wrapper made it the second consumer of the auth shape. Future
# wrappers (a `setup-rmapi.sh` helper, a polling daemon) will reuse
# this same precondition.

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
