"""Tests for the poll_tablet polling daemon.

Stdlib-only: the loop logic, lock file, and signature comparison are
all stdlib; rmapi and the detect/pull wrappers are injected as fakes.
No venv required.

Run:
  python skills/sketch-brainstorm/render/test_poll_tablet.py
or:
  python -m unittest discover -s skills/sketch-brainstorm/render -p "test_*.py"
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))

import poll_tablet  # noqa: E402


class LockFileTests(unittest.TestCase):
    """Atomic write contract for poller.lock."""

    def test_write_lock_creates_parent_dirs(self):
        # Arrange
        with tempfile.TemporaryDirectory() as tmp:
            lock = Path(tmp) / "missing" / "subdir" / "poller.lock"

            # Act
            poll_tablet.write_lock(lock, pid=123, started="2026-05-13T12:00:00Z", heartbeat="2026-05-13T12:00:00Z")

            # Assert
            self.assertTrue(lock.exists())
            payload = json.loads(lock.read_text(encoding="utf-8"))
            self.assertEqual(payload["pid"], 123)
            self.assertEqual(payload["started"], "2026-05-13T12:00:00Z")
            self.assertEqual(payload["last_heartbeat"], "2026-05-13T12:00:00Z")

    def test_write_lock_overwrites_existing(self):
        # Arrange
        with tempfile.TemporaryDirectory() as tmp:
            lock = Path(tmp) / "poller.lock"
            poll_tablet.write_lock(lock, pid=1, started="2026-05-13T12:00:00Z", heartbeat="2026-05-13T12:00:00Z")

            # Act
            poll_tablet.write_lock(lock, pid=2, started="2026-05-13T12:00:00Z", heartbeat="2026-05-13T12:00:30Z")

            # Assert
            payload = json.loads(lock.read_text(encoding="utf-8"))
            self.assertEqual(payload["pid"], 2)
            self.assertEqual(payload["last_heartbeat"], "2026-05-13T12:00:30Z")

    def test_write_lock_leaves_no_tmp_sidecar(self):
        """Atomic-rename guarantee: no .tmp sidecar survives a successful write."""
        # Arrange
        with tempfile.TemporaryDirectory() as tmp:
            lock = Path(tmp) / "poller.lock"

            # Act
            poll_tablet.write_lock(lock, pid=1, started="2026-05-13T12:00:00Z", heartbeat="2026-05-13T12:00:00Z")

            # Assert
            tmp_sidecar = Path(tmp) / "poller.lock.tmp"
            self.assertFalse(tmp_sidecar.exists())

    def test_release_lock_tolerates_missing(self):
        # Arrange
        with tempfile.TemporaryDirectory() as tmp:
            lock = Path(tmp) / "never-existed.lock"

            # Act + Assert: no exception
            poll_tablet.release_lock(lock)


class SignatureTests(unittest.TestCase):
    """Signature equality is the change-detection primitive."""

    def test_equal_signatures_are_equal(self):
        # Arrange
        a = poll_tablet.Signature(version=3, modified_client="2026-05-13T12:00:00Z")
        b = poll_tablet.Signature(version=3, modified_client="2026-05-13T12:00:00Z")

        # Act + Assert
        self.assertEqual(a, b)

    def test_version_bump_breaks_equality(self):
        # Arrange
        a = poll_tablet.Signature(version=3, modified_client="2026-05-13T12:00:00Z")
        b = poll_tablet.Signature(version=4, modified_client="2026-05-13T12:00:00Z")

        # Act + Assert
        self.assertNotEqual(a, b)

    def test_modified_client_change_breaks_equality(self):
        """Doc types that don't increment Version still trigger via timestamp."""
        # Arrange
        a = poll_tablet.Signature(version=0, modified_client="2026-05-13T12:00:00Z")
        b = poll_tablet.Signature(version=0, modified_client="2026-05-13T12:00:30Z")

        # Act + Assert
        self.assertNotEqual(a, b)


class PollOnceTests(unittest.TestCase):
    """Single-iteration semantics: idle vs changed, marked vs unmarked."""

    def _fake_signature_fn(self, sig):
        return lambda _cloud_doc: sig

    def _fake_pull_detect_fn(self, result, calls):
        def fn(_cloud_doc, _pulls_dir):
            calls.append(1)

            return result

        return fn

    def test_idle_iteration_skips_pull(self):
        """Equal signature on two reads means no cloud-side change; do not pull."""
        # Arrange
        sig = poll_tablet.Signature(version=3, modified_client="2026-05-13T12:00:00Z")
        pull_calls = []
        marked_result = poll_tablet.DetectionResult(
            finish_turn_marked=True, end_session_marked=False,
        )

        # Act
        new_sig, result = poll_tablet.poll_once(
            cloud_doc="x",
            pulls_dir=Path("/unused"),
            last_sig=sig,
            signature_fn=self._fake_signature_fn(sig),
            pull_detect_fn=self._fake_pull_detect_fn(marked_result, pull_calls),
        )

        # Assert
        self.assertEqual(new_sig, sig)
        self.assertFalse(result.finish_turn_marked)
        self.assertFalse(result.end_session_marked)
        self.assertEqual(pull_calls, [], "pull must not run on an idle iteration")

    def test_changed_signature_unmarked_returns_all_false(self):
        """Cloud doc changed but no control box marked: return all-false, update signature."""
        # Arrange
        prev = poll_tablet.Signature(version=3, modified_client="2026-05-13T12:00:00Z")
        curr = poll_tablet.Signature(version=4, modified_client="2026-05-13T12:01:00Z")
        pull_calls = []
        unmarked_result = poll_tablet.DetectionResult(
            finish_turn_marked=False, end_session_marked=False,
        )

        # Act
        new_sig, result = poll_tablet.poll_once(
            cloud_doc="x",
            pulls_dir=Path("/unused"),
            last_sig=prev,
            signature_fn=self._fake_signature_fn(curr),
            pull_detect_fn=self._fake_pull_detect_fn(unmarked_result, pull_calls),
        )

        # Assert
        self.assertEqual(new_sig, curr)
        self.assertFalse(result.finish_turn_marked)
        self.assertFalse(result.end_session_marked)
        self.assertEqual(pull_calls, [1], "pull must run when the signature changes")

    def test_changed_signature_finish_turn_marked(self):
        """Cloud doc changed and Finish-turn box marked: result reflects it."""
        # Arrange
        prev = poll_tablet.Signature(version=3, modified_client="2026-05-13T12:00:00Z")
        curr = poll_tablet.Signature(version=4, modified_client="2026-05-13T12:01:00Z")
        pull_calls = []
        marked_result = poll_tablet.DetectionResult(
            finish_turn_marked=True, end_session_marked=False,
        )

        # Act
        new_sig, result = poll_tablet.poll_once(
            cloud_doc="x",
            pulls_dir=Path("/unused"),
            last_sig=prev,
            signature_fn=self._fake_signature_fn(curr),
            pull_detect_fn=self._fake_pull_detect_fn(marked_result, pull_calls),
        )

        # Assert
        self.assertEqual(new_sig, curr)
        self.assertTrue(result.finish_turn_marked)
        self.assertFalse(result.end_session_marked)
        self.assertEqual(pull_calls, [1])


class StopEmissionTests(unittest.TestCase):
    """End-session detection drives STOP:<NN> emission."""

    def test_end_session_marked_propagates_through_poll_once(self):
        # Arrange
        prev = poll_tablet.Signature(version=3, modified_client="2026-05-13T12:00:00Z")
        curr = poll_tablet.Signature(version=4, modified_client="2026-05-13T12:00:30Z")
        pull_calls = []

        def fake_detect(_cloud_doc, _pulls_dir):
            pull_calls.append(1)

            return poll_tablet.DetectionResult(
                finish_turn_marked=False, end_session_marked=True,
            )

        # Act
        new_sig, result = poll_tablet.poll_once(
            cloud_doc="x",
            pulls_dir=Path("/unused"),
            last_sig=prev,
            signature_fn=lambda _: curr,
            pull_detect_fn=fake_detect,
        )

        # Assert
        self.assertEqual(new_sig, curr)
        self.assertTrue(result.end_session_marked)
        self.assertFalse(result.finish_turn_marked)
        self.assertEqual(pull_calls, [1])

    def test_end_session_takes_precedence_over_finish_turn(self):
        """Both boxes marked in same turn: End-session wins; Finish-turn flag still surfaced."""
        # Arrange
        prev = poll_tablet.Signature(version=3, modified_client="2026-05-13T12:00:00Z")
        curr = poll_tablet.Signature(version=4, modified_client="2026-05-13T12:00:30Z")

        def fake_detect(_cloud_doc, _pulls_dir):
            return poll_tablet.DetectionResult(
                finish_turn_marked=True, end_session_marked=True,
            )

        # Act
        _new_sig, result = poll_tablet.poll_once(
            cloud_doc="x",
            pulls_dir=Path("/unused"),
            last_sig=prev,
            signature_fn=lambda _: curr,
            pull_detect_fn=fake_detect,
        )

        # Assert: both flags carry through; precedence ordering lives in run()'s emit block.
        self.assertTrue(result.end_session_marked)
        self.assertTrue(result.finish_turn_marked)


if __name__ == "__main__":
    unittest.main()
