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
