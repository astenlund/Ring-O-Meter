"""Unit tests for session_index.

Covers add_session, set_active, read_index, and SessionIndexError raise
paths. Stdlib-only. The harness builds a temporary repo root and exercises
the public API end-to-end through atomic writes.
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import session_index


class SessionIndexTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.index_path = self.tmp / ".tmp/sketch-brainstorm/current-session.json"

    def test_read_index_returns_empty_when_absent(self) -> None:
        result = session_index.read_index(self.index_path)
        self.assertEqual(result, {"active_session": None, "history": []})

    def test_add_session_creates_index_with_active_pointer(self) -> None:
        session_index.add_session(
            self.index_path,
            session_dir="2026-05-19-warmup-gate",
            slug="warmup-gate",
        )
        loaded = json.loads(self.index_path.read_text())
        self.assertEqual(loaded["active_session"], "sessions/2026-05-19-warmup-gate")
        self.assertEqual(len(loaded["history"]), 1)
        entry = loaded["history"][0]
        self.assertEqual(entry["session_dir"], "2026-05-19-warmup-gate")
        self.assertEqual(entry["slug"], "warmup-gate")
        self.assertEqual(entry["status"], "active")
        self.assertEqual(entry["turns"], 0)

    def test_add_session_marks_prior_active_as_dormant(self) -> None:
        session_index.add_session(
            self.index_path, session_dir="2026-05-18-old", slug="old",
        )
        session_index.add_session(
            self.index_path, session_dir="2026-05-19-new", slug="new",
        )
        loaded = json.loads(self.index_path.read_text())
        self.assertEqual(loaded["active_session"], "sessions/2026-05-19-new")
        statuses = {e["session_dir"]: e["status"] for e in loaded["history"]}
        self.assertEqual(statuses["2026-05-18-old"], "dormant")
        self.assertEqual(statuses["2026-05-19-new"], "active")

    def test_add_session_is_idempotent_on_same_session_dir(self) -> None:
        session_index.add_session(
            self.index_path, session_dir="2026-05-19-warmup-gate", slug="warmup-gate",
        )
        session_index.add_session(
            self.index_path, session_dir="2026-05-19-warmup-gate", slug="warmup-gate",
        )
        loaded = json.loads(self.index_path.read_text())
        self.assertEqual(len(loaded["history"]), 1)
        self.assertEqual(loaded["active_session"], "sessions/2026-05-19-warmup-gate")

    def test_set_active_promotes_history_entry(self) -> None:
        session_index.add_session(
            self.index_path, session_dir="2026-05-18-old", slug="old",
        )
        session_index.add_session(
            self.index_path, session_dir="2026-05-19-new", slug="new",
        )
        session_index.set_active(self.index_path, session_dir="2026-05-18-old")
        loaded = json.loads(self.index_path.read_text())
        self.assertEqual(loaded["active_session"], "sessions/2026-05-18-old")
        statuses = {e["session_dir"]: e["status"] for e in loaded["history"]}
        self.assertEqual(statuses["2026-05-18-old"], "active")
        self.assertEqual(statuses["2026-05-19-new"], "dormant")

    def test_set_active_raises_on_unknown_session(self) -> None:
        with self.assertRaises(session_index.SessionIndexError):
            session_index.set_active(self.index_path, session_dir="never-existed")

    def test_read_index_raises_on_malformed_json(self) -> None:
        self.index_path.parent.mkdir(parents=True)
        self.index_path.write_text("{not valid json")
        with self.assertRaises(session_index.SessionIndexError):
            session_index.read_index(self.index_path)


if __name__ == "__main__":
    unittest.main()
