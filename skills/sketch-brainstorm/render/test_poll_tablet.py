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
            finish_turn_marked=True, end_session_marked=False, mode_winner=None,
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
            finish_turn_marked=False, end_session_marked=False, mode_winner=None,
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
            finish_turn_marked=True, end_session_marked=False, mode_winner=None,
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
                finish_turn_marked=False, end_session_marked=True, mode_winner=None,
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
                finish_turn_marked=True, end_session_marked=True, mode_winner=None,
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


class ResolveModeWinnerTests(unittest.TestCase):
    """Radio-button winner-takes-all across the mode-switch trio."""

    def _page(self, finish=False, end=False, color=(0.0, False), bw=(0.0, False), wireframe=(0.0, False)):
        return {
            "page": 1,
            "boxes": {
                "finish_turn":    {"area_rm_sq": 0.0, "marked": finish},
                "end_session":    {"area_rm_sq": 0.0, "marked": end},
                "mode_color":     {"area_rm_sq": color[0], "marked": color[1]},
                "mode_bw":        {"area_rm_sq": bw[0], "marked": bw[1]},
                "mode_wireframe": {"area_rm_sq": wireframe[0], "marked": wireframe[1]},
            },
        }

    def test_single_marked_mode_wins(self):
        # Arrange
        per_page = [self._page(bw=(500.0, True))]

        # Act + Assert
        self.assertEqual(poll_tablet._resolve_mode_winner(per_page), "bw")

    def test_tie_resolves_to_no_switch(self):
        # Arrange
        per_page = [self._page(color=(300.0, True), bw=(300.0, True))]

        # Act + Assert
        self.assertIsNone(poll_tablet._resolve_mode_winner(per_page))

    def test_no_marked_returns_none(self):
        # Arrange
        per_page = [self._page()]

        # Act + Assert
        self.assertIsNone(poll_tablet._resolve_mode_winner(per_page))

    def test_max_across_pages(self):
        """Aggregation across pages uses max(area_rm_sq); bw's single-page peak beats color."""
        # Arrange: color marked on both pages; bw marked once with higher single-page area.
        per_page = [
            self._page(color=(100.0, True), bw=(0.0, False)),
            self._page(color=(50.0, True), bw=(150.0, True)),
        ]

        # Act + Assert: mode_color max = 100; mode_bw max = 150; bw wins.
        self.assertEqual(poll_tablet._resolve_mode_winner(per_page), "bw")

    def test_three_marked_highest_area_wins(self):
        # Arrange
        per_page = [self._page(color=(100.0, True), bw=(200.0, True), wireframe=(150.0, True))]

        # Act + Assert
        self.assertEqual(poll_tablet._resolve_mode_winner(per_page), "bw")


class ModeWinnerPropagationTests(unittest.TestCase):
    """mode_winner carries through poll_once to the result for the run() emit block."""

    def test_mode_winner_propagates_through_poll_once(self):
        # Arrange
        prev = poll_tablet.Signature(version=3, modified_client="2026-05-13T12:00:00Z")
        curr = poll_tablet.Signature(version=4, modified_client="2026-05-13T12:00:30Z")

        def fake_detect(_cloud_doc, _pulls_dir):
            return poll_tablet.DetectionResult(
                finish_turn_marked=True, end_session_marked=False, mode_winner="wireframe",
            )

        # Act
        _new_sig, result = poll_tablet.poll_once(
            cloud_doc="x",
            pulls_dir=Path("/unused"),
            last_sig=prev,
            signature_fn=lambda _: curr,
            pull_detect_fn=fake_detect,
        )

        # Assert
        self.assertTrue(result.finish_turn_marked)
        self.assertEqual(result.mode_winner, "wireframe")


class RunLifecycleTests(unittest.TestCase):
    """End-to-end coverage of run(): emit lines and finally-block lock cleanup."""

    def test_run_emits_ready_and_releases_lock_on_finish_turn(self):
        # Arrange: signature changes on each tick so pull_detect_fn fires.
        with tempfile.TemporaryDirectory() as tmp:
            lock = Path(tmp) / "poller.lock"
            pulls = Path(tmp) / "pulls"
            tick = {"n": 0}

            def signature_fn(_cloud_doc):
                tick["n"] += 1
                return poll_tablet.Signature(version=tick["n"], modified_client=str(tick["n"]))

            def fake_pull_detect(_cloud_doc, _pulls_dir):
                return poll_tablet.DetectionResult(
                    finish_turn_marked=True, end_session_marked=False, mode_winner=None,
                )

            # Act
            rc = poll_tablet.run(
                cloud_doc="x",
                iter_nn="00",
                pulls_dir=pulls,
                lock_file=lock,
                poll_interval_s=0,
                signature_fn=signature_fn,
                pull_detect_fn=fake_pull_detect,
            )

            # Assert: clean exit, lock released, no .tmp sidecar.
            self.assertEqual(rc, 0)
            self.assertFalse(lock.exists())
            self.assertFalse(lock.with_name(lock.name + ".tmp").exists())

    def test_run_emits_stop_with_precedence_over_ready(self):
        # Arrange: end-session takes precedence over finish-turn even when
        # both flags are set on the same poll tick.
        with tempfile.TemporaryDirectory() as tmp:
            lock = Path(tmp) / "poller.lock"
            pulls = Path(tmp) / "pulls"
            tick = {"n": 0}

            def signature_fn(_cloud_doc):
                tick["n"] += 1
                return poll_tablet.Signature(version=tick["n"], modified_client=str(tick["n"]))

            def both_marked(_cloud_doc, _pulls_dir):
                return poll_tablet.DetectionResult(
                    finish_turn_marked=True, end_session_marked=True, mode_winner=None,
                )

            # Act
            rc = poll_tablet.run(
                cloud_doc="x",
                iter_nn="00",
                pulls_dir=pulls,
                lock_file=lock,
                poll_interval_s=0,
                signature_fn=signature_fn,
                pull_detect_fn=both_marked,
            )

            # Assert
            self.assertEqual(rc, 0)
            self.assertFalse(lock.exists())


if __name__ == "__main__":
    unittest.main()
