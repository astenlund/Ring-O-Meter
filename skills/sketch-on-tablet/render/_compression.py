"""Shared constants and helpers for the compression slice.

Single source of truth for the archive filename pattern, the
iteration-heading scanner, and the next-NNN resolution used by both
check_compression_needed.py (read-only trigger path) and write_archive.py
(write path with caller-mkdir contract).

Stdlib-only by design: both consumers need to import without venv deps.
"""
import re
from pathlib import Path

# Matches `## Iteration NN` headings inside design-state.md, anchored
# to line boundaries (re.MULTILINE) with optional trailing whitespace.
# Distinct from _ITER_MARKER_RE in write_design_state.py (looser, no
# `\s*$`, used for duplicate-heading detection inside an iter body) and
# from ITER_NN_RE in _chrome_boxes.py (bare digit-run validator for CLI
# args, no surrounding text).
ITER_HEADING_RE = re.compile(r"^## Iteration (\d+)\s*$", re.MULTILINE)

# Matches archive filenames in `<session>/archive/`. Three-digit padded
# sequence + literal suffix. The 3-digit cap is part of the design's
# filename-ordering contract; sessions are not expected to exceed ~999
# archives in practice (one archive per turn at interactive cadence of
# minutes per turn).
ARCHIVE_NAME_RE = re.compile(r"^(\d{3})-pre-summary\.md$")


def next_archive_nnn(archive_dir: Path, *, tolerate_missing: bool) -> str:
    """Return next zero-padded archive sequence number as 3 digits.

    Resolution is `max(existing NNN) + 1`, tolerant of gaps so a manually
    deleted archive does not reuse its number.

    Parameters
    ----------
    tolerate_missing : bool
        True: return "001" when archive_dir does not exist (read-only
        trigger path where the caller does not mkdir first).
        False: caller guarantees archive_dir exists (write path runs
        mkdir immediately before calling); a missing dir surfaces as
        FileNotFoundError from iterdir, which is the correct signal that
        the caller's contract was violated.
    """
    if tolerate_missing and not archive_dir.exists():

        return "001"
    highest = 0
    for entry in archive_dir.iterdir():
        m = ARCHIVE_NAME_RE.match(entry.name)
        if m:
            highest = max(highest, int(m.group(1)))

    return f"{highest + 1:03d}"
