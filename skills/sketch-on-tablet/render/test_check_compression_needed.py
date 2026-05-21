"""Unit tests for check_compression_needed."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from check_compression_needed import WATERMARK_OFFSET, check_trigger


def _write_state(session_dir: Path, turn_count: int) -> None:
    """Write a design-state.md with N iteration sections (00..N-1)."""
    session_dir.mkdir(parents=True, exist_ok=True)
    body = "---\nslug: foo\ntopic: bar\ncurrent_mode: color\n---\n\n"
    for n in range(turn_count):
        body += f"## Iteration {n:02d}\n\nbody for {n}\n\n"
    (session_dir / "design-state.md").write_text(body, encoding="utf-8")


class CheckTriggerTests(unittest.TestCase):

    def test_no_design_state_file_returns_false(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = check_trigger(Path(tmp))
            self.assertFalse(result["trigger"])

    def test_watermark_constant_is_five(self):
        # User-confirmed N=5 (see plan rationale).
        self.assertEqual(WATERMARK_OFFSET, 5)

    def test_below_threshold_returns_false(self):
        # latest=5, watermark = 5-5 = 0; no turns < 0.
        with tempfile.TemporaryDirectory() as tmp:
            _write_state(Path(tmp), turn_count=6)  # turns 00..05
            result = check_trigger(Path(tmp))
            self.assertFalse(result["trigger"])

    def test_at_threshold_triggers_one_turn(self):
        # latest=06, watermark=01, archive turns < 1 (just turn 00).
        with tempfile.TemporaryDirectory() as tmp:
            _write_state(Path(tmp), turn_count=7)  # turns 00..06
            result = check_trigger(Path(tmp))
            self.assertTrue(result["trigger"])
            self.assertEqual(result["turns_to_archive"], ["00"])
            self.assertEqual(result["turns_to_keep"], ["01", "02", "03", "04", "05", "06"])
            self.assertEqual(result["archive_nnn"], "001")

    def test_above_threshold_archives_multiple(self):
        # turns 00..10 (11 turns), latest=10, watermark=05, archive 00..04.
        with tempfile.TemporaryDirectory() as tmp:
            _write_state(Path(tmp), turn_count=11)
            result = check_trigger(Path(tmp))
            self.assertTrue(result["trigger"])
            self.assertEqual(result["turns_to_archive"], ["00", "01", "02", "03", "04"])
            self.assertEqual(result["turns_to_keep"], ["05", "06", "07", "08", "09", "10"])

    def test_existing_archives_advance_nnn(self):
        with tempfile.TemporaryDirectory() as tmp:
            _write_state(Path(tmp), turn_count=11)
            archive = Path(tmp) / "archive"
            archive.mkdir()
            (archive / "001-pre-summary.md").write_text("---\nx\n---\n", encoding="utf-8")
            (archive / "003-pre-summary.md").write_text("---\nx\n---\n", encoding="utf-8")
            result = check_trigger(Path(tmp))
            # Max NNN seen + 1, even with gaps.
            self.assertEqual(result["archive_nnn"], "004")

    def test_design_state_with_no_iter_sections(self):
        with tempfile.TemporaryDirectory() as tmp:
            session = Path(tmp)
            session.mkdir(parents=True, exist_ok=True)
            (session / "design-state.md").write_text(
                "---\nslug: foo\n---\n\n(no iter sections yet)\n", encoding="utf-8")
            result = check_trigger(session)
            self.assertFalse(result["trigger"])

    def test_non_contiguous_turns_handled(self):
        # turns 00, 03, 04, 05, 06, 07 (e.g., after a partial compression).
        with tempfile.TemporaryDirectory() as tmp:
            session = Path(tmp)
            session.mkdir(parents=True, exist_ok=True)
            body = "---\nslug: foo\n---\n\n"
            for n in (0, 3, 4, 5, 6, 7):
                body += f"## Iteration {n:02d}\n\nbody\n\n"
            (session / "design-state.md").write_text(body, encoding="utf-8")
            result = check_trigger(session)
            # latest=07, watermark=02, archive turns where T<2 → just 00.
            self.assertTrue(result["trigger"])
            self.assertEqual(result["turns_to_archive"], ["00"])
            self.assertEqual(result["turns_to_keep"], ["03", "04", "05", "06", "07"])


if __name__ == "__main__":
    unittest.main()
