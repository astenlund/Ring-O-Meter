"""Read and update .tmp/sketch-brainstorm/current-session.json.

The index tracks the active session and the history of all sessions in
this project. Used by bootstrap-session.sh to register a newly created
session and by the resume flow to switch the active pointer to an
existing session. Atomic writes via _atomic_write so partial updates
under crash never leave a half-written file.

Concurrent-write safety: atomic_write_text (write-to-temp + rename)
makes each individual write crash-safe; it does NOT prevent a
lost-update race between two concurrent read-modify-write cycles. Two
simultaneous bootstrap invocations against the same project could
produce a lost update. Single-user single-machine scope makes this
implausible in practice; no mutex is added.

Index schema:
  {
    "active_session": "sessions/<session_dir>",
    "history": [
      {"session_dir": "<YYYY-MM-DD-slug>", "slug": "<slug>", "status": "active|dormant", "turns": N}
    ]
  }
active_session stores a "sessions/"-prefixed pointer for relative path
construction; history entries store the bare session_dir. Consumers that
need to correlate the active pointer back to a history entry must strip
the _SESSIONS_PREFIX.

Stdlib-only; runs under the existing sketch-brainstorm venv but has no
venv-specific dependencies.
"""

import json
from pathlib import Path
from typing import Any

from _atomic_write import atomic_write_text

_SESSIONS_PREFIX = "sessions/"


class SessionIndexError(Exception):
    """Raised when the index is malformed or a requested session is absent."""


def read_index(path: Path) -> dict[str, Any]:
    """Return the index contents, or an empty index if the file is absent.

    Raises SessionIndexError on JSON-parse failure.
    """
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"active_session": None, "history": []}
    except json.JSONDecodeError as exc:
        raise SessionIndexError(f"malformed JSON in {path}: {exc}") from exc


def add_session(path: Path, *, session_dir: str, slug: str) -> None:
    """Append the session to history and set it active.

    Idempotent on the same session_dir: a re-run promotes the existing entry
    to active (if not already) without duplicating it. The stored slug is NOT
    updated on re-run; pass the same slug both times. Any previously-active
    session is demoted to dormant.
    """
    index = read_index(path)
    history = index["history"]

    if any(e["session_dir"] == session_dir for e in history):
        set_active(path, session_dir=session_dir)
        return

    for entry in history:
        entry["status"] = _demote(entry["status"])

    history.append({
        "session_dir": session_dir,
        "slug": slug,
        "status": "active",
        "turns": 0,
    })
    index["active_session"] = f"{_SESSIONS_PREFIX}{session_dir}"
    _write(path, index)


def set_active(path: Path, *, session_dir: str) -> None:
    """Promote an existing history entry to active.

    Raises SessionIndexError if the session_dir is not in history.
    """
    index = read_index(path)
    history = index["history"]

    match = next((e for e in history if e["session_dir"] == session_dir), None)
    if match is None:
        raise SessionIndexError(f"session_dir not in history: {session_dir}")

    for entry in history:
        entry["status"] = "active" if entry is match else _demote(entry["status"])
    index["active_session"] = f"{_SESSIONS_PREFIX}{session_dir}"
    _write(path, index)


def _demote(status: str) -> str:
    """Demote an active session to dormant; leave ended states unchanged."""
    return "dormant" if status == "active" else status


def _write(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_text(path, json.dumps(payload, indent=2) + "\n")
