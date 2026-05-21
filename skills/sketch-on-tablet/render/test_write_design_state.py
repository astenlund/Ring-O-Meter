"""Tests for write_design_state.py atomic-write helper.

Stdlib-only; no rmscene or PyMuPDF.
"""
import sys
import tempfile
import unittest
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))

import write_design_state  # noqa: E402


def _seed_session(session_dir, mode="color", iterations=()):
    """Write an initial design-state.md with frontmatter and zero or
    more existing iteration sections."""
    body = f"""---
slug: test-slug
topic: test topic
created: 2026-05-13T12:00:00Z
current_mode: {mode}
---
"""
    for nn, content in iterations:
        body += f"\n## Iteration {nn}\n\n{content}\n"
    (session_dir / "design-state.md").write_text(body, encoding="utf-8")


class WriteDesignStateTests(unittest.TestCase):
    def test_appends_new_iter_section_preserves_prior(self):
        # Arrange
        with tempfile.TemporaryDirectory() as tmp:
            session = Path(tmp)
            _seed_session(session, mode="color", iterations=[("00", "iter-0 body")])

            # Act
            write_design_state.write(
                session_dir=session, iter_nn="01", mode="color",
                delta="iter-1 body",
            )

            # Assert
            content = (session / "design-state.md").read_text(encoding="utf-8")
            self.assertIn("## Iteration 00", content)
            self.assertIn("iter-0 body", content)
            self.assertIn("## Iteration 01", content)
            self.assertIn("iter-1 body", content)
            self.assertIn("current_mode: color", content)

    def test_mode_change_updates_frontmatter(self):
        # Arrange
        with tempfile.TemporaryDirectory() as tmp:
            session = Path(tmp)
            _seed_session(session, mode="color", iterations=[("00", "x")])

            # Act
            write_design_state.write(
                session_dir=session, iter_nn="01", mode="bw", delta="y",
            )

            # Assert
            content = (session / "design-state.md").read_text(encoding="utf-8")
            self.assertIn("current_mode: bw", content)
            self.assertNotIn("current_mode: color", content)

    def test_atomic_rename_no_tmp_sidecar(self):
        # Arrange
        with tempfile.TemporaryDirectory() as tmp:
            session = Path(tmp)
            _seed_session(session)

            # Act
            write_design_state.write(
                session_dir=session, iter_nn="01", mode="color", delta="x",
            )

            # Assert: no design-state.md.tmp left behind.
            self.assertFalse((session / "design-state.md.tmp").exists())

    def test_re_writing_same_iter_overwrites_that_section(self):
        # Arrange: iter 01 already present.
        with tempfile.TemporaryDirectory() as tmp:
            session = Path(tmp)
            _seed_session(session, iterations=[("00", "iter-0 keep"), ("01", "old body")])

            # Act
            write_design_state.write(
                session_dir=session, iter_nn="01", mode="color", delta="new body",
            )

            # Assert: iter 00 preserved; old iter 01 body gone; new body present.
            content = (session / "design-state.md").read_text(encoding="utf-8")
            self.assertIn("iter-0 keep", content)
            self.assertIn("new body", content)
            self.assertNotIn("old body", content)

    def test_rejects_invalid_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            session = Path(tmp)
            _seed_session(session)
            with self.assertRaises(ValueError):
                write_design_state.write(
                    session_dir=session, iter_nn="01", mode="invalid", delta="x",
                )

    def test_delta_with_backreference_does_not_crash(self):
        # A delta containing what looks like a regex backreference must
        # be written verbatim, not interpreted.
        with tempfile.TemporaryDirectory() as tmp:
            session = Path(tmp)
            _seed_session(session, iterations=[("00", "x")])
            write_design_state.write(
                session_dir=session, iter_nn="01", mode="color",
                delta="see \\g<name> for the docs",
            )
            content = (session / "design-state.md").read_text(encoding="utf-8")
            self.assertIn("see \\g<name> for the docs", content)

    def test_delta_with_iter_marker_raises(self):
        # A delta containing a literal '## Iteration NN' line must be
        # rejected to prevent silent corruption on later writes.
        with tempfile.TemporaryDirectory() as tmp:
            session = Path(tmp)
            _seed_session(session)
            with self.assertRaises(ValueError):
                write_design_state.write(
                    session_dir=session, iter_nn="01", mode="color",
                    delta="something\n## Iteration 99\nbody",
                )

    def test_crlf_frontmatter_handled(self):
        # Frontmatter regex must not break on CRLF input.
        with tempfile.TemporaryDirectory() as tmp:
            session = Path(tmp)
            (session / "design-state.md").write_text(
                "---\r\ncurrent_mode: color\r\n---\r\n",
                encoding="utf-8",
            )
            write_design_state.write(
                session_dir=session, iter_nn="00", mode="bw", delta="x",
            )
            content = (session / "design-state.md").read_text(encoding="utf-8")
            # No double frontmatter; mode updated; LF normalization applied.
            self.assertEqual(content.count("---"), 2)  # exactly one open + close
            self.assertIn("current_mode: bw", content)
            self.assertNotIn("\r\n", content)

    def test_overwriting_middle_section_preserves_blank_line_separator(self):
        # Overwriting an iter section that has a sibling below it must
        # leave the blank-line separator between sections intact;
        # otherwise the next read finds two headings on adjacent lines.
        with tempfile.TemporaryDirectory() as tmp:
            session = Path(tmp)
            _seed_session(
                session,
                iterations=[("00", "first"), ("01", "second"), ("02", "third")],
            )
            write_design_state.write(
                session_dir=session, iter_nn="01", mode="color", delta="rewritten",
            )
            content = (session / "design-state.md").read_text(encoding="utf-8")
            self.assertIn("rewritten\n\n## Iteration 02", content)

    def test_rejects_malformed_iter_nn(self):
        # A single-digit iter_nn produces a heading the section regex
        # cannot match on the next call, leading to silent re-append
        # instead of overwrite. Must raise rather than silently corrupt.
        with tempfile.TemporaryDirectory() as tmp:
            session = Path(tmp)
            _seed_session(session)
            with self.assertRaises(ValueError):
                write_design_state.write(
                    session_dir=session, iter_nn="1", mode="color", delta="x",
                )

    def test_missing_session_dir_raises_filenotfounderror(self):
        # Caller error: passing a nonexistent --session-dir must surface
        # as FileNotFoundError, not a cryptic .tmp write failure.
        with tempfile.TemporaryDirectory() as tmp:
            absent = Path(tmp) / "no-such-session"
            with self.assertRaises(FileNotFoundError):
                write_design_state.write(
                    session_dir=absent, iter_nn="00", mode="color", delta="x",
                )

    def test_pre_existing_duplicate_iter_headings_raise(self):
        # External mutation (or recovery from a partial write) could leave
        # design-state.md with two '## Iteration NN' headings sharing a
        # NN. write() must refuse to proceed, since the section regex
        # below would only see the first match and the duplicate would
        # persist/grow on every later write.
        with tempfile.TemporaryDirectory() as tmp:
            session = Path(tmp)
            (session / "design-state.md").write_text(
                "---\ncurrent_mode: color\n---\n\n"
                "## Iteration 03\n\nfirst body\n\n"
                "## Iteration 03\n\nduplicate body\n",
                encoding="utf-8",
            )
            with self.assertRaises(ValueError) as cm:
                write_design_state.write(
                    session_dir=session, iter_nn="04", mode="color",
                    delta="new body",
                )
        self.assertIn("duplicate", str(cm.exception))
        self.assertIn("03", str(cm.exception))

    def test_fresh_file_has_blank_line_after_frontmatter(self):
        # When design-state.md doesn't exist yet, the prepended frontmatter
        # should be followed by a blank line, matching bootstrap-session.sh.
        with tempfile.TemporaryDirectory() as tmp:
            session = Path(tmp)
            write_design_state.write(
                session_dir=session, iter_nn="00", mode="color", delta="body",
            )
            content = (session / "design-state.md").read_text(encoding="utf-8")
            self.assertIn("---\n\n## Iteration 00", content)


if __name__ == "__main__":
    unittest.main()
