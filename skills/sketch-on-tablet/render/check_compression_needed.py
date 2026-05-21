"""Compression trigger logic for the sketch-on-tablet skill.

Scans a session's design-state.md for `## Iteration NN` headings, applies
the watermark rule, and reports whether any older turns should be rotated
into an `archive/NNN-pre-summary.md` file.

Authoritative state: design-state.md alone. The archive directory is
read only by filename pattern (NNN-pre-summary.md) to resolve the next
sequence number; no YAML in archive files is ever parsed by this module.
This keeps the helper free of YAML-aware tooling per the design's
"shell driver never parses or rewrites YAML frontmatter" rule.

Stdlib-only; runs under the shared venv but has no venv-specific
dependencies.
"""
import json
import sys
from pathlib import Path

from _compression import ITER_HEADING_RE, next_archive_nnn

# Active head retains the most recent (1 + WATERMARK_OFFSET) turns
# verbatim; anything older rotates into the archive chain. With
# WATERMARK_OFFSET = 5, a session holding turns 00..10 keeps 05..10
# (six turns) and archives 00..04. User-set per design Q&A 2026-05-19.
WATERMARK_OFFSET = 5


def check_trigger(session_dir: Path) -> dict:
    """Return a dict describing whether compression should fire.

    Always returns a `trigger: bool`. On trigger, also returns
    `turns_to_archive`, `turns_to_keep` (both lists of zero-padded
    string NN), and `archive_nnn` (next three-digit archive sequence).
    """
    state_path = session_dir / "design-state.md"
    if not state_path.exists():
        return {"trigger": False, "reason": "design-state.md absent"}

    text = state_path.read_text(encoding="utf-8")
    turns = sorted(int(n) for n in ITER_HEADING_RE.findall(text))
    if not turns:
        return {"trigger": False, "reason": "no iteration sections"}

    latest = turns[-1]
    watermark = latest - WATERMARK_OFFSET
    to_archive = [n for n in turns if n < watermark]
    if not to_archive:
        return {"trigger": False, "reason": "all turns above watermark"}

    to_keep = [n for n in turns if n >= watermark]

    return {
        "trigger": True,
        "turns_to_archive": [f"{n:02d}" for n in to_archive],
        "turns_to_keep": [f"{n:02d}" for n in to_keep],
        "archive_nnn": next_archive_nnn(session_dir / "archive", tolerate_missing=True),
        "latest_turn": f"{latest:02d}",
        "watermark_turn": f"{watermark:02d}",
    }


def main(argv=None):
    if argv is None:
        argv = sys.argv[1:]
    if len(argv) != 1:
        print("usage: check_compression_needed.py <session-dir>", file=sys.stderr)

        return 2
    try:
        result = check_trigger(Path(argv[0]))
    except OSError as e:
        print(f"check-compression-needed: {e}", file=sys.stderr)

        return 2
    print(json.dumps(result))

    return 0


if __name__ == "__main__":
    sys.exit(main())
