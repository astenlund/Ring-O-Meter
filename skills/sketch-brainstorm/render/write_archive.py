"""Archive writer + active-head rewriter for the compression slice.

Receives a parsed compression-subagent response plus the orchestrator's
turn-list inputs, validates the structural invariants (archived turns
absent from the new head; kept turns present in the new head), resolves
the next archive sequence number from filename listing, and writes the
archive file followed by the replacement design-state.md.

Write order (crash-safety contract):
  1. archive/NNN-pre-summary.md   (atomic)
  2. design-state.md              (atomic)

If step 2 fails, the orphan archive is harmless: the next compression
cycle sees the same un-archived turns still in design-state.md and
produces a fresh (overlapping) archive. Data is never lost.

Stdlib-only; reuses _atomic_write.atomic_write_text.
"""
import argparse
import json
import re
import sys
from pathlib import Path

from _atomic_write import atomic_write_text

_ITER_HEADING_RE = re.compile(r"^## Iteration (\d+)\s*$", re.MULTILINE)
_ARCHIVE_NAME_RE = re.compile(r"^(\d{3})-pre-summary\.md$")


class ArchiveStructureError(ValueError):
    """Raised when the subagent's new_active_head_content fails the
    structural invariant (archived turns present or kept turns absent).
    """


def write(
    session_dir: Path,
    *,
    turns_to_archive: list[str],
    turns_to_keep: list[str],
    archive_content: str,
    new_active_head_content: str,
) -> Path:
    """Write the archive file and replace design-state.md.

    Returns the path of the new archive file. Raises FileNotFoundError
    if session_dir does not exist, ArchiveStructureError if the new
    head violates the turn-set invariants, OSError on write failure.
    """
    if not session_dir.is_dir():
        raise FileNotFoundError(f"session dir not found: {session_dir}")

    _validate_invariants(new_active_head_content, turns_to_archive, turns_to_keep)

    archive_dir = session_dir / "archive"
    archive_dir.mkdir(parents=True, exist_ok=True)
    nnn = _next_archive_nnn(archive_dir)
    archive_path = archive_dir / f"{nnn}-pre-summary.md"

    # Step 1: archive write (durable record).
    atomic_write_text(archive_path, archive_content)
    # Step 2: active-head rewrite (the orphan-on-crash failure mode
    # is documented in the module docstring).
    atomic_write_text(session_dir / "design-state.md", new_active_head_content)

    return archive_path


def _validate_invariants(
    new_head: str,
    turns_to_archive: list[str],
    turns_to_keep: list[str],
) -> None:
    """Confirm three structural invariants on the new head:

    1. No archived turn appears in the new head (leaked).
    2. Every kept turn appears in the new head (missing).
    3. No turn outside the archive-or-keep sets appears in the new head (extra).

    Raises ArchiveStructureError on any violation.
    """
    head_turns = {int(n) for n in _ITER_HEADING_RE.findall(new_head)}
    archived_ints = {int(n) for n in turns_to_archive}
    kept_ints = {int(n) for n in turns_to_keep}

    leaked = sorted(head_turns & archived_ints)
    if leaked:
        raise ArchiveStructureError(
            f"new_active_head_content still contains archived turns: "
            f"{[f'{n:02d}' for n in leaked]}"
        )
    missing = sorted(kept_ints - head_turns)
    if missing:
        raise ArchiveStructureError(
            f"new_active_head_content missing kept turns: "
            f"{[f'{n:02d}' for n in missing]}"
        )
    extra = sorted(head_turns - kept_ints - archived_ints)
    if extra:
        raise ArchiveStructureError(
            f"new_active_head_content contains unexpected turns not in "
            f"keep or archive list: {[f'{n:02d}' for n in extra]}"
        )


def _next_archive_nnn(archive_dir: Path) -> str:
    """Return next zero-padded sequence number as 3 digits; max + 1.

    Caller must ensure archive_dir exists before calling (write() runs mkdir
    first). No existence guard here -- contrast with check_compression_needed's
    parallel function which adds one for the read-only trigger path where mkdir
    is not performed.
    """
    highest = 0
    for entry in archive_dir.iterdir():
        m = _ARCHIVE_NAME_RE.match(entry.name)
        if m:
            highest = max(highest, int(m.group(1)))

    return f"{highest + 1:03d}"


def _parse_csv_list(arg: str) -> list[str]:
    return [s.strip() for s in arg.split(",") if s.strip()]


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--session-dir", required=True, type=Path)
    p.add_argument("--turns-to-archive", required=True, type=_parse_csv_list,
                   help="Comma-separated zero-padded turn numbers (e.g., 00,01,02)")
    p.add_argument("--turns-to-keep", required=True, type=_parse_csv_list,
                   help="Comma-separated zero-padded turn numbers")
    args = p.parse_args(argv)

    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        print(f"write-archive: malformed JSON on stdin: {exc}", file=sys.stderr)

        return 2

    archive_content = payload.get("archive_content")
    new_head = payload.get("new_active_head_content")
    if not isinstance(archive_content, str) or not isinstance(new_head, str):
        print("write-archive: stdin payload missing archive_content or new_active_head_content",
              file=sys.stderr)

        return 2

    try:
        archive_path = write(
            args.session_dir,
            turns_to_archive=args.turns_to_archive,
            turns_to_keep=args.turns_to_keep,
            archive_content=archive_content,
            new_active_head_content=new_head,
        )
    except (FileNotFoundError, ArchiveStructureError, OSError) as e:
        print(f"write-archive: {e}", file=sys.stderr)

        return 1

    print(archive_path)

    return 0


if __name__ == "__main__":
    sys.exit(main())
