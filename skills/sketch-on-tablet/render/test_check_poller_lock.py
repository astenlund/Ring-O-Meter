"""Unit tests for check_poller_lock.

Covers absent, stale-heartbeat, stale-PID, alive, malformed-JSON, and
missing-field branches. Uses os.getpid() to source a real live PID for
the alive branch; uses an obviously-dead PID (2^31 - 1) for the stale-PID
branch.
"""

import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import check_poller_lock


def _utc_iso(offset_seconds: float = 0.0) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=offset_seconds)).strftime("%Y-%m-%dT%H:%M:%SZ")


class CheckPollerLockTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.lock_path = self.tmp / "poller.lock"

    def test_absent_lock(self) -> None:
        result = check_poller_lock.check_lock(self.lock_path)
        self.assertEqual(result["status"], "absent")

    def test_alive_lock(self) -> None:
        self.lock_path.write_text(json.dumps({
            "pid": os.getpid(),
            "started": _utc_iso(),
            "last_heartbeat": _utc_iso(),
        }))
        result = check_poller_lock.check_lock(self.lock_path)
        self.assertEqual(result["status"], "alive")
        self.assertEqual(result["pid"], os.getpid())

    def test_stale_pid(self) -> None:
        # 2^31 - 1 = 2147483647 is well outside any plausible live PID range.
        self.lock_path.write_text(json.dumps({
            "pid": 2147483647,
            "started": _utc_iso(),
            "last_heartbeat": _utc_iso(),
        }))
        result = check_poller_lock.check_lock(self.lock_path)
        self.assertEqual(result["status"], "stale")
        self.assertEqual(result["reason"], "pid-dead")

    def test_stale_heartbeat(self) -> None:
        # Heartbeat 120s in the past with our own (alive) PID.
        self.lock_path.write_text(json.dumps({
            "pid": os.getpid(),
            "started": _utc_iso(offset_seconds=-180),
            "last_heartbeat": _utc_iso(offset_seconds=-120),
        }))
        result = check_poller_lock.check_lock(self.lock_path)
        self.assertEqual(result["status"], "stale")
        self.assertEqual(result["reason"], "heartbeat-stale")

    def test_malformed_json(self) -> None:
        self.lock_path.write_text("{not valid json")
        result = check_poller_lock.check_lock(self.lock_path)
        self.assertEqual(result["status"], "stale")
        self.assertEqual(result["reason"], "malformed")

    def test_missing_field(self) -> None:
        self.lock_path.write_text(json.dumps({"pid": os.getpid()}))
        result = check_poller_lock.check_lock(self.lock_path)
        self.assertEqual(result["status"], "stale")
        self.assertEqual(result["reason"], "malformed")


if __name__ == "__main__":
    unittest.main()
