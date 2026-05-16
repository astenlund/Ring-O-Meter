"""Tests for the poll_tablet polling daemon.

Stdlib-only: the loop logic, lock file, and signature comparison are
all stdlib; rmapi and the detect/pull wrappers are injected as fakes.
No venv required.

Run:
  python skills/sketch-brainstorm/render/test_poll_tablet.py
or:
  python -m unittest discover -s skills/sketch-brainstorm/render -p "test_*.py"
"""
import io
import json
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
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

    def _run_with_stdout(self, **kwargs):
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = poll_tablet.run(**kwargs)

        return rc, buf.getvalue()

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
            rc, out = self._run_with_stdout(
                cloud_doc="x",
                iter_nn="00",
                pulls_dir=pulls,
                lock_file=lock,
                poll_interval_s=0,
                signature_fn=signature_fn,
                pull_detect_fn=fake_pull_detect,
            )

            # Assert: emits READY, clean exit, lock released, no .tmp sidecar.
            self.assertEqual(rc, 0)
            self.assertIn("READY:00", out)
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
            rc, out = self._run_with_stdout(
                cloud_doc="x",
                iter_nn="00",
                pulls_dir=pulls,
                lock_file=lock,
                poll_interval_s=0,
                signature_fn=signature_fn,
                pull_detect_fn=both_marked,
            )

            # Assert: STOP is emitted (not READY), confirming precedence.
            self.assertEqual(rc, 0)
            self.assertIn("STOP:00", out)
            self.assertNotIn("READY:00", out)
            self.assertFalse(lock.exists())


class ClassifierTests(unittest.TestCase):
    """classify_subprocess_error returns (context, retryable) per the plan's table."""

    def test_auth_expired_via_401_substring(self):
        # Arrange
        exc = subprocess.CalledProcessError(
            returncode=1, cmd=["rmapi", "refresh"], stderr="HTTP 401 from cloud",
        )

        # Act
        ctx, retryable = poll_tablet.classify_subprocess_error("refresh", exc)

        # Assert
        self.assertEqual(ctx, "auth-expired")
        self.assertFalse(retryable)

    def test_auth_expired_via_unauthor_substring_case_insensitive(self):
        # Arrange
        exc = subprocess.CalledProcessError(
            returncode=1, cmd=["rmapi", "stat"], stderr="Unauthorized: token expired",
        )

        # Act
        ctx, retryable = poll_tablet.classify_subprocess_error("stat", exc)

        # Assert
        self.assertEqual(ctx, "auth-expired")
        self.assertFalse(retryable)

    def test_doc_missing_substring_in_pull_stage(self):
        # Arrange
        exc = subprocess.CalledProcessError(
            returncode=1, cmd=["rmapi", "get"], stderr="rmapi: file doesn't exist on remote",
        )

        # Act
        ctx, retryable = poll_tablet.classify_subprocess_error("pull", exc)

        # Assert
        self.assertEqual(ctx, "rmapi-pull-failed-doc-missing")
        self.assertFalse(retryable)

    def test_called_process_error_per_stage_table(self):
        # Arrange
        cases = [
            ("refresh", "rmapi-refresh-failed"),
            ("stat", "rmapi-stat-failed"),
            ("pull", "rmapi-pull-failed"),
            ("detect", "detect-failed"),
        ]
        for stage, expected_ctx in cases:
            with self.subTest(stage=stage):
                exc = subprocess.CalledProcessError(
                    returncode=1, cmd=["rmapi", stage], stderr="connection refused",
                )

                # Act
                ctx, retryable = poll_tablet.classify_subprocess_error(stage, exc)

                # Assert
                self.assertEqual(ctx, expected_ctx)
                self.assertTrue(retryable)

    def test_json_decode_error_classifies_parse_failed(self):
        # Arrange
        exc = json.JSONDecodeError("Expecting value", "bad", 0)

        # Act
        ctx, retryable = poll_tablet.classify_subprocess_error("stat", exc)

        # Assert
        self.assertEqual(ctx, "parse-failed")
        self.assertTrue(retryable)

    def test_runtime_error_in_pull_classifies_shape_invalid(self):
        # Arrange
        exc = RuntimeError("pull-from-tablet.sh produced no output")

        # Act
        ctx, retryable = poll_tablet.classify_subprocess_error("pull", exc)

        # Assert
        self.assertEqual(ctx, "pull-shape-invalid")
        self.assertTrue(retryable)

    def test_os_error_classifies_subprocess_error(self):
        # Arrange
        exc = OSError("permission denied")

        # Act
        ctx, retryable = poll_tablet.classify_subprocess_error("pull", exc)

        # Assert
        self.assertEqual(ctx, "subprocess-error")
        self.assertTrue(retryable)

    def test_none_stderr_does_not_crash(self):
        """CalledProcessError with no captured stderr still classifies cleanly."""
        # Arrange: default constructor leaves stderr=None
        exc = subprocess.CalledProcessError(returncode=1, cmd=["rmapi", "stat"])

        # Act
        ctx, retryable = poll_tablet.classify_subprocess_error("stat", exc)

        # Assert: falls through to generic stage classification, no crash
        self.assertEqual(ctx, "rmapi-stat-failed")
        self.assertTrue(retryable)


class RunWithRetryTests(unittest.TestCase):
    """_run_with_retry retries retryable ops with backoff; raises on exhaustion or non-retryable."""

    def test_succeeds_on_first_attempt(self):
        # Arrange
        calls = {"n": 0}

        def op():
            calls["n"] += 1

            return "ok"

        sleeps = []

        # Act
        result = poll_tablet._run_with_retry(op, "stat", sleep_fn=sleeps.append)

        # Assert
        self.assertEqual(result, "ok")
        self.assertEqual(calls["n"], 1)
        self.assertEqual(sleeps, [], "successful op must not sleep")

    def test_retries_then_succeeds(self):
        # Arrange
        calls = {"n": 0}

        def op():
            calls["n"] += 1
            if calls["n"] < 3:
                raise subprocess.CalledProcessError(
                    returncode=1, cmd=["rmapi", "stat"], stderr="timeout",
                )

            return "ok"

        sleeps = []

        # Act
        result = poll_tablet._run_with_retry(op, "stat", sleep_fn=sleeps.append)

        # Assert: 2 failures + 1 success means 2 sleeps from BACKOFF_SLEEPS prefix
        self.assertEqual(result, "ok")
        self.assertEqual(calls["n"], 3)
        self.assertEqual(sleeps, list(poll_tablet.BACKOFF_SLEEPS[:2]))

    def test_exhaustion_reraises_original_exception(self):
        # Arrange: always raise; budget exhausts after len(BACKOFF_SLEEPS) retries
        original = subprocess.CalledProcessError(
            returncode=1, cmd=["rmapi", "stat"], stderr="timeout",
        )

        def op():
            raise original

        sleeps = []

        # Act + Assert: bare re-raise preserves the original instance
        with self.assertRaises(subprocess.CalledProcessError) as ctx:
            poll_tablet._run_with_retry(op, "stat", sleep_fn=sleeps.append)
        self.assertIs(ctx.exception, original)
        # Sleep count equals the backoff schedule length (one sleep per retry attempt)
        self.assertEqual(sleeps, list(poll_tablet.BACKOFF_SLEEPS))

    def test_non_retryable_short_circuits_with_no_sleeps(self):
        """Auth-expired classification skips the backoff loop entirely."""
        # Arrange
        original = subprocess.CalledProcessError(
            returncode=1, cmd=["rmapi", "stat"], stderr="401 Unauthorized",
        )

        def op():
            raise original

        sleeps = []

        # Act + Assert
        with self.assertRaises(subprocess.CalledProcessError) as ctx:
            poll_tablet._run_with_retry(op, "stat", sleep_fn=sleeps.append)
        self.assertIs(ctx.exception, original)
        self.assertEqual(sleeps, [], "non-retryable must not enter the backoff loop")


class ErrorEmissionTests(unittest.TestCase):
    """run() emits ERROR lines per the spec, with suppression and recovery semantics."""

    def _run(self, **kwargs):
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = poll_tablet.run(**kwargs)

        return rc, buf.getvalue()

    def test_emits_error_for_retryable_exhaustion_then_recovers(self):
        """Retryable failure exhausts the budget on loop iter 1, then loop iter 2 succeeds and READY fires."""
        # Arrange: retry exhaustion calls op() 1 + len(BACKOFF_SLEEPS) = 5 times.
        # Initial fetch (tick 1) succeeds; loop iter 1's signature_fn raises 5 consecutive times (ticks 2-6);
        # loop iter 2's signature_fn succeeds (tick 7) and detect fires READY.
        budget = 1 + len(poll_tablet.BACKOFF_SLEEPS)
        first_fail = 2
        last_fail = first_fail + budget - 1
        with tempfile.TemporaryDirectory() as tmp:
            lock = Path(tmp) / "poller.lock"
            pulls = Path(tmp) / "pulls"
            tick = {"n": 0}

            def signature_fn(_doc):
                tick["n"] += 1
                if first_fail <= tick["n"] <= last_fail:
                    raise subprocess.CalledProcessError(
                        returncode=1, cmd=["rmapi", "stat"], stderr="timeout",
                    )

                return poll_tablet.Signature(version=tick["n"], modified_client=str(tick["n"]))

            def pull_detect_fn(_doc, _dir):
                return poll_tablet.DetectionResult(
                    finish_turn_marked=True, end_session_marked=False, mode_winner=None,
                )

            # Act
            rc, out = self._run(
                cloud_doc="x",
                iter_nn="00",
                pulls_dir=pulls,
                lock_file=lock,
                poll_interval_s=0,
                signature_fn=signature_fn,
                pull_detect_fn=pull_detect_fn,
                sleep_fn=lambda _: None,
            )

            # Assert
            self.assertEqual(rc, 0)
            error_lines = [line for line in out.splitlines() if line.startswith("ERROR:")]
            self.assertEqual(len(error_lines), 1, f"got {error_lines}")
            self.assertTrue(error_lines[0].startswith("ERROR:rmapi-stat-failed:"))
            self.assertIn("timeout", error_lines[0])
            self.assertIn("READY:00", out)
            self.assertFalse(lock.exists())

    def test_suppresses_repeated_identical_errors(self):
        """Two back-to-back exhaustions with the same context emit ERROR only once."""
        # Arrange: each exhausted iter consumes `budget` ticks. Iter1 + iter2 both exhaust;
        # iter3 succeeds and fires READY.
        budget = 1 + len(poll_tablet.BACKOFF_SLEEPS)
        success_tick = 1 + 2 * budget + 1  # initial fetch + 2 exhausted iters + 1 success
        with tempfile.TemporaryDirectory() as tmp:
            lock = Path(tmp) / "poller.lock"
            pulls = Path(tmp) / "pulls"
            tick = {"n": 0}

            def signature_fn(_doc):
                tick["n"] += 1
                if 2 <= tick["n"] < success_tick:
                    raise subprocess.CalledProcessError(
                        returncode=1, cmd=["rmapi", "stat"], stderr="timeout",
                    )

                return poll_tablet.Signature(version=tick["n"], modified_client=str(tick["n"]))

            def pull_detect_fn(_doc, _dir):
                return poll_tablet.DetectionResult(
                    finish_turn_marked=True, end_session_marked=False, mode_winner=None,
                )

            # Act
            _rc, out = self._run(
                cloud_doc="x",
                iter_nn="00",
                pulls_dir=pulls,
                lock_file=lock,
                poll_interval_s=0,
                signature_fn=signature_fn,
                pull_detect_fn=pull_detect_fn,
                sleep_fn=lambda _: None,
            )

            # Assert: exactly one ERROR despite two consecutive identical-context exhaustions
            error_lines = [line for line in out.splitlines() if line.startswith("ERROR:")]
            self.assertEqual(len(error_lines), 1, f"got {error_lines}")
            self.assertIn("READY:00", out)

    def test_resets_suppression_after_clean_success_tick(self):
        """A fully clean tick between two identical exhaustions must re-emit the second ERROR."""
        # Arrange: iter 1 exhausts (ERROR #1), iter 2 succeeds with no marks (suppression reset),
        # iter 3 exhausts again (ERROR #2), iter 4 succeeds with no marks, iter 5 fires READY.
        budget = 1 + len(poll_tablet.BACKOFF_SLEEPS)
        with tempfile.TemporaryDirectory() as tmp:
            lock = Path(tmp) / "poller.lock"
            pulls = Path(tmp) / "pulls"
            tick = {"n": 0}
            # Iter 1 exhaustion: ticks 2..(1+budget) — i.e. 2..6.
            iter1_range = range(2, 2 + budget)
            # After iter 1, one success tick at (2+budget) = 7.
            # Iter 3 exhaustion: ticks (2+budget+1)..(1+2*budget+1) — i.e. 8..12.
            iter3_first = 2 + budget + 1
            iter3_range = range(iter3_first, iter3_first + budget)
            fail_ticks = set(iter1_range) | set(iter3_range)
            detect_calls = {"n": 0}

            def signature_fn(_doc):
                tick["n"] += 1
                if tick["n"] in fail_ticks:
                    raise subprocess.CalledProcessError(
                        returncode=1, cmd=["rmapi", "stat"], stderr="timeout",
                    )

                return poll_tablet.Signature(version=tick["n"], modified_client=str(tick["n"]))

            def pull_detect_fn(_doc, _dir):
                detect_calls["n"] += 1
                if detect_calls["n"] >= 3:
                    return poll_tablet.DetectionResult(
                        finish_turn_marked=True, end_session_marked=False, mode_winner=None,
                    )

                return poll_tablet.DetectionResult(
                    finish_turn_marked=False, end_session_marked=False, mode_winner=None,
                )

            # Act
            _rc, out = self._run(
                cloud_doc="x",
                iter_nn="00",
                pulls_dir=pulls,
                lock_file=lock,
                poll_interval_s=0,
                signature_fn=signature_fn,
                pull_detect_fn=pull_detect_fn,
                sleep_fn=lambda _: None,
            )

            # Assert: TWO ERROR lines because the clean tick between them reset suppression
            error_lines = [line for line in out.splitlines() if line.startswith("ERROR:")]
            self.assertEqual(len(error_lines), 2, f"got {error_lines}")
            self.assertIn("READY:00", out)

    def test_initial_fetch_failure_emits_error_then_loop_recovers(self):
        """Pre-loop fetch exhausts → emits ERROR, loop seeds with empty sig, next tick fires READY."""
        # Arrange: initial fetch exhaustion calls op() len(BACKOFF_SLEEPS)+1 = 5 times,
        # consuming ticks 1..5. First successful tick is 6.
        budget = 1 + len(poll_tablet.BACKOFF_SLEEPS)
        with tempfile.TemporaryDirectory() as tmp:
            lock = Path(tmp) / "poller.lock"
            pulls = Path(tmp) / "pulls"
            tick = {"n": 0}

            def signature_fn(_doc):
                tick["n"] += 1
                if tick["n"] <= budget:
                    raise subprocess.CalledProcessError(
                        returncode=1, cmd=["rmapi", "stat"], stderr="connection refused",
                    )

                return poll_tablet.Signature(version=tick["n"], modified_client=str(tick["n"]))

            def pull_detect_fn(_doc, _dir):
                return poll_tablet.DetectionResult(
                    finish_turn_marked=True, end_session_marked=False, mode_winner=None,
                )

            # Act
            rc, out = self._run(
                cloud_doc="x",
                iter_nn="00",
                pulls_dir=pulls,
                lock_file=lock,
                poll_interval_s=0,
                signature_fn=signature_fn,
                pull_detect_fn=pull_detect_fn,
                sleep_fn=lambda _: None,
            )

            # Assert: ERROR from initial fetch exhaustion, then loop recovered to READY
            self.assertEqual(rc, 0)
            error_lines = [line for line in out.splitlines() if line.startswith("ERROR:")]
            self.assertEqual(len(error_lines), 1, f"got {error_lines}")
            self.assertTrue(error_lines[0].startswith("ERROR:rmapi-stat-failed:"))
            self.assertIn("READY:00", out)

    def test_auth_expired_short_circuits_to_immediate_error_emission(self):
        """Non-retryable auth-expired emits ERROR on the first failure with no sleeps."""
        # Arrange: initial fetch (tick 1) succeeds, loop iter 1 raises auth-expired (tick 2) -
        # auth-expired is non-retryable, so a single op() call (no retries, no sleeps).
        # Loop iter 2 (tick 3) succeeds and fires READY.
        with tempfile.TemporaryDirectory() as tmp:
            lock = Path(tmp) / "poller.lock"
            pulls = Path(tmp) / "pulls"
            tick = {"n": 0}
            sleeps = []

            def signature_fn(_doc):
                tick["n"] += 1
                if tick["n"] == 2:
                    raise subprocess.CalledProcessError(
                        returncode=1, cmd=["rmapi", "stat"], stderr="HTTP 401 Unauthorized",
                    )

                return poll_tablet.Signature(version=tick["n"], modified_client=str(tick["n"]))

            def pull_detect_fn(_doc, _dir):
                return poll_tablet.DetectionResult(
                    finish_turn_marked=True, end_session_marked=False, mode_winner=None,
                )

            # Act
            _rc, out = self._run(
                cloud_doc="x",
                iter_nn="00",
                pulls_dir=pulls,
                lock_file=lock,
                poll_interval_s=0,
                signature_fn=signature_fn,
                pull_detect_fn=pull_detect_fn,
                sleep_fn=sleeps.append,
            )

            # Assert: ERROR:auth-expired emitted, zero sleeps for the auth-expired branch
            error_lines = [line for line in out.splitlines() if line.startswith("ERROR:")]
            self.assertEqual(len(error_lines), 1, f"got {error_lines}")
            self.assertTrue(error_lines[0].startswith("ERROR:auth-expired:"))
            self.assertEqual(sleeps, [], "auth-expired must not trigger backoff sleeps")


if __name__ == "__main__":
    unittest.main()
