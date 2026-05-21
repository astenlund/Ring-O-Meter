"""Unit tests for write_archive."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import write_archive


VALID_ARCHIVE_CONTENT = (
    "---\nturn-range: 00-04\ncreated: 2026-05-19T15:00:00Z\n---\n\n"
    "Summary of turns 00 through 04.\n"
)
VALID_NEW_HEAD = (
    "---\nslug: foo\ntopic: bar\ncurrent_mode: color\n---\n\n"
    "## Iteration 05\n\nbody\n\n"
    "## Iteration 06\n\nbody\n\n"
)


class WriteArchiveTests(unittest.TestCase):

    def _make_session(self, tmp: str, head_body: str) -> Path:
        session = Path(tmp)
        (session / "archive").mkdir(parents=True, exist_ok=True)
        (session / "design-state.md").write_text(head_body, encoding="utf-8")

        return session

    def test_writes_archive_and_replaces_active_head(self):
        with tempfile.TemporaryDirectory() as tmp:
            head_before = "---\nslug: foo\n---\n\n## Iteration 00\n\nold\n\n## Iteration 05\n\nnew\n"
            session = self._make_session(tmp, head_before)
            archive_path = write_archive.write(
                session,
                turns_to_archive=["00", "01", "02", "03", "04"],
                turns_to_keep=["05", "06"],
                archive_content=VALID_ARCHIVE_CONTENT,
                new_active_head_content=VALID_NEW_HEAD,
            )
            self.assertEqual(archive_path.name, "001-pre-summary.md")
            self.assertTrue(archive_path.exists())
            self.assertEqual(archive_path.read_text(encoding="utf-8"), VALID_ARCHIVE_CONTENT)
            self.assertEqual(
                (session / "design-state.md").read_text(encoding="utf-8"),
                VALID_NEW_HEAD,
            )

    def test_resolves_next_nnn_with_gaps(self):
        with tempfile.TemporaryDirectory() as tmp:
            session = self._make_session(tmp, "---\n---\n")
            (session / "archive" / "001-pre-summary.md").write_text("x", encoding="utf-8")
            (session / "archive" / "003-pre-summary.md").write_text("x", encoding="utf-8")
            archive_path = write_archive.write(
                session,
                turns_to_archive=["00"],
                turns_to_keep=["01"],
                archive_content=VALID_ARCHIVE_CONTENT,
                new_active_head_content="---\n---\n\n## Iteration 01\n\nbody\n",
            )
            self.assertEqual(archive_path.name, "004-pre-summary.md")

    def test_rejects_archived_turn_still_in_new_head(self):
        with tempfile.TemporaryDirectory() as tmp:
            session = self._make_session(tmp, "---\n---\n")
            bad_head = "---\n---\n\n## Iteration 00\n\nleftover\n\n## Iteration 05\n\nkept\n"
            with self.assertRaises(write_archive.ArchiveStructureError) as cm:
                write_archive.write(
                    session,
                    turns_to_archive=["00"],
                    turns_to_keep=["05"],
                    archive_content=VALID_ARCHIVE_CONTENT,
                    new_active_head_content=bad_head,
                )
            self.assertIn("00", str(cm.exception))

    def test_rejects_kept_turn_missing_from_new_head(self):
        with tempfile.TemporaryDirectory() as tmp:
            session = self._make_session(tmp, "---\n---\n")
            bad_head = "---\n---\n\n## Iteration 06\n\nonly one kept\n"
            with self.assertRaises(write_archive.ArchiveStructureError) as cm:
                write_archive.write(
                    session,
                    turns_to_archive=["00"],
                    turns_to_keep=["05", "06"],
                    archive_content=VALID_ARCHIVE_CONTENT,
                    new_active_head_content=bad_head,
                )
            self.assertIn("05", str(cm.exception))

    def test_rejects_extra_turns_in_new_head(self):
        with tempfile.TemporaryDirectory() as tmp:
            session = self._make_session(tmp, "---\n---\n")
            # Turn 07 is neither archived nor kept — subagent hallucination.
            bad_head = "---\n---\n\n## Iteration 05\n\nkept\n\n## Iteration 07\n\nhallucinated\n"
            with self.assertRaises(write_archive.ArchiveStructureError) as cm:
                write_archive.write(
                    session,
                    turns_to_archive=["00"],
                    turns_to_keep=["05"],
                    archive_content=VALID_ARCHIVE_CONTENT,
                    new_active_head_content=bad_head,
                )
            self.assertIn("07", str(cm.exception))

    def test_archive_dir_created_if_absent(self):
        with tempfile.TemporaryDirectory() as tmp:
            session = Path(tmp)
            (session / "design-state.md").write_text("---\n---\n", encoding="utf-8")
            # No archive/ subdir created beforehand.
            archive_path = write_archive.write(
                session,
                turns_to_archive=["00"],
                turns_to_keep=["05"],
                archive_content=VALID_ARCHIVE_CONTENT,
                new_active_head_content="---\n---\n\n## Iteration 05\n\nbody\n",
            )
            self.assertEqual(archive_path.parent.name, "archive")
            self.assertTrue(archive_path.exists())

    def test_rejects_when_session_dir_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / "does-not-exist"
            with self.assertRaises(FileNotFoundError):
                write_archive.write(
                    missing,
                    turns_to_archive=["00"],
                    turns_to_keep=["05"],
                    archive_content=VALID_ARCHIVE_CONTENT,
                    new_active_head_content="---\n---\n\n## Iteration 05\n\nx\n",
                )

    def test_archive_written_before_active_head_rewrite(self):
        # Crash-safety contract: if the second write fails, archive
        # already exists on disk so the cycle is retriable. We verify
        # ordering by making the active-head write fail and confirming
        # the archive landed.
        with tempfile.TemporaryDirectory() as tmp:
            session = self._make_session(tmp, "---\n---\n")
            # Make design-state.md a directory to force the write to fail.
            (session / "design-state.md").unlink()
            (session / "design-state.md").mkdir()
            with self.assertRaises(OSError):
                write_archive.write(
                    session,
                    turns_to_archive=["00"],
                    turns_to_keep=["05"],
                    archive_content=VALID_ARCHIVE_CONTENT,
                    new_active_head_content="---\n---\n\n## Iteration 05\n\nbody\n",
                )
            # Archive should still exist.
            self.assertTrue((session / "archive" / "001-pre-summary.md").exists())


if __name__ == "__main__":
    unittest.main()
