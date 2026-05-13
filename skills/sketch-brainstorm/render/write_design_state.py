"""Atomic-write helper for design-state.md.

Replaces the manual "write the frontmatter and the new iter section
together" protocol with a single deterministic call. Used by main chat
on each turn after a poller READY notification.

CLI shape:
    bash write-design-state.sh \\
        --session-dir <path> --iter NN --mode color|bw|wireframe \\
        < content-delta-on-stdin

Implementation: read existing design-state.md (frontmatter + iter
sections), update frontmatter.current_mode, replace-or-append the
target iter section, write to design-state.md.tmp, rename to
design-state.md. The rename is atomic on POSIX and atomic-in-practice
on NTFS for same-volume same-directory renames (same guarantee that
poller.lock relies on).
"""
import argparse
import re
import sys
from pathlib import Path

from _atomic_write import atomic_write_text
from _chrome_boxes import ITER_NN_RE, VALID_MODES

_FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n", re.DOTALL)
# Lookahead matches any `## ` heading (not just `## Iteration `) so that
# a future schema addition such as `## Archive` does not get absorbed
# into the prior iter section and silently deleted on the next write.
_ITER_SECTION_RE_TEMPLATE = r"(\n## Iteration {nn}\n.*?)(?=\n## |\Z)"
_ITER_MARKER_RE = re.compile(r"^## Iteration ", re.MULTILINE)
_CURRENT_MODE_RE = re.compile(r"^current_mode:.*$", re.MULTILINE)


def _validate_delta(delta):
    """Reject deltas that contain literal '## Iteration NN' lines.

    Such markers would be parsed as real iter section boundaries by the
    next write() call, silently corrupting the file. Subagent output
    should not legitimately need to emit literal section markers inside
    an iter body.
    """
    if _ITER_MARKER_RE.search(delta):
        raise ValueError(
            "delta contains a literal '## Iteration ' line, which would "
            "be parsed as a section marker by subsequent writes; escape "
            "or rephrase the content"
        )


def write(session_dir, iter_nn, mode, delta):
    """Atomically update design-state.md with a new/updated iter section
    and the requested current_mode."""
    if mode not in VALID_MODES:
        raise ValueError(f"invalid mode {mode!r}; expected one of {VALID_MODES}")
    if not ITER_NN_RE.fullmatch(iter_nn):
        # A mis-formatted iter_nn (e.g., "1" instead of "01") writes a
        # heading the section regex cannot match on the next call, so
        # the same iteration silently re-appends instead of overwriting.
        raise ValueError(f"iter_nn must be at least two decimal digits; got {iter_nn!r}")
    _validate_delta(delta)

    session_path = Path(session_dir)
    if not session_path.is_dir():
        raise FileNotFoundError(f"session dir not found: {session_path}")
    path = session_path / "design-state.md"
    content = path.read_text(encoding="utf-8") if path.exists() else ""
    content = content.replace("\r\n", "\n")

    # Update frontmatter.current_mode.
    m = _FRONTMATTER_RE.match(content)
    if m:
        fm = m.group(1)
        if _CURRENT_MODE_RE.search(fm):
            new_fm = _CURRENT_MODE_RE.sub(f"current_mode: {mode}", fm)
        else:
            new_fm = fm + f"\ncurrent_mode: {mode}"
        content = f"---\n{new_fm}\n---\n" + content[m.end():]
    else:
        content = f"---\ncurrent_mode: {mode}\n---\n\n" + content

    # Replace-or-append iter section.
    section_re = re.compile(_ITER_SECTION_RE_TEMPLATE.format(nn=re.escape(iter_nn)), re.DOTALL)
    new_section = f"\n## Iteration {iter_nn}\n\n{delta}\n"
    match = section_re.search(content)
    if match:
        # Trailing `\n` after rstrip preserves the blank-line separator
        # between this section and the next; without it the lookahead's
        # `\n## ` would be consumed leaving sections jammed together.
        content = content[:match.start()] + new_section.rstrip() + "\n" + content[match.end():]
    else:
        content = content.rstrip() + "\n" + new_section

    atomic_write_text(path, content)


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--session-dir", required=True, type=Path)
    p.add_argument("--iter", dest="iter_nn", required=True)
    p.add_argument("--mode", required=True, choices=VALID_MODES)
    args = p.parse_args(argv)
    delta = sys.stdin.read()
    try:
        write(args.session_dir, args.iter_nn, args.mode, delta)
    except (FileNotFoundError, ValueError, OSError) as e:
        print(f"write-design-state: {e}", file=sys.stderr)

        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
