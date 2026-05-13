"""Background polling daemon for sketch-brainstorm.

Watches the current iteration's reMarkable cloud doc via `rmapi stat`
and emits a single notification line on stdout when the user marks a
control box and backs out: `READY:<NN>` for Finish-turn, `STOP:<NN>`
for End-session. Idle iterations emit nothing, so notifications
correspond one-to-one with events the main chat actually needs to
handle.

This slice owns mtime short-circuit, lock acquisition with heartbeat,
and the READY / STOP notifications. Mode-switch suffixes, ERROR
taxonomy with exponential backoff, and bootstrap-side spawn
integration are documented in the feature spec as separate slices.

Lifecycle:
  - Birth: spawned by the orchestrator via `Bash(run_in_background=true)`.
  - Run:   refresh + stat each tick; on signature change, pull + detect.
  - Death: emit `READY:<NN>` or `STOP:<NN>` and exit 0; or fatal error
           and exit 1; or SIGINT/SIGTERM from the harness.

The script intentionally does not try to outlive its parent chat
session. Durable state is on disk (the session folder, pulls/ archives);
respawning across chats reads from there.
"""
import argparse
import json
import os
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Tuple

SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
DETECT_WRAPPER = SKILL_DIR / "detect-marks.sh"
PULL_WRAPPER = SKILL_DIR / "pull-from-tablet.sh"

# heuristic: polling cadence keeps the prompt cache warm (5-minute TTL)
# while staying within 2x of the lock-staleness threshold (60s) so a
# missed iteration still keeps the lock fresh.
DEFAULT_POLL_INTERVAL_S = 30


@dataclass(frozen=True)
class Signature:
    """Cloud-doc change signature. Equality across two snapshots means
    rmapi observed no cloud-side change."""

    version: int
    modified_client: str


@dataclass(frozen=True)
class DetectionResult:
    """Per-event-class detection outcome from one pull + detect pass.

    Extensible: C3 will add `mode_winner: Optional[str]` for the
    mode-switch winner-takes-all event class.
    """

    finish_turn_marked: bool
    end_session_marked: bool


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def fetch_signature(cloud_doc: str) -> Signature:
    """rmapi refresh + rmapi stat the cloud doc, return a comparable signature.

    Refresh is paired with stat because rmapi maintains a local tree cache;
    stat alone would silently read stale metadata if the cache hadn't been
    nudged. Raises subprocess.CalledProcessError or json.JSONDecodeError on
    rmapi / parse failure; the caller decides how to surface those.
    """
    subprocess.run(
        ["rmapi", "refresh"],
        check=True,
        capture_output=True,
        text=True,
    )
    proc = subprocess.run(
        ["rmapi", "stat", cloud_doc],
        check=True,
        capture_output=True,
        text=True,
    )
    data = json.loads(proc.stdout)

    return Signature(
        version=int(data.get("Version", 0)),
        modified_client=str(data.get("ModifiedClient", "")),
    )


def pull_and_detect(cloud_doc: str, pulls_dir: Path) -> DetectionResult:
    """Pull the cloud doc and run the detector. Return per-event-class
    booleans aggregated across all pages of the nested-boxes JSON schema.

    Subprocess output is captured (not streamed) because both wrappers
    write progress / diagnostics on their own channels; the poller's
    stdout must stay reserved for the line-oriented notification protocol.
    """
    pulls_dir.mkdir(parents=True, exist_ok=True)
    pull = subprocess.run(
        [
            "bash",
            str(PULL_WRAPPER),
            "--cloud-doc",
            cloud_doc,
            "--out-dir",
            str(pulls_dir),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    rm_dir = pull.stdout.strip().splitlines()[-1]
    detect = subprocess.run(
        ["bash", str(DETECT_WRAPPER), rm_dir],
        check=True,
        capture_output=True,
        text=True,
    )
    data = json.loads(detect.stdout)
    pages = data.get("per_page", [])
    finish_turn_marked = any(p["boxes"]["finish_turn"]["marked"] for p in pages)
    end_session_marked = any(p["boxes"]["end_session"]["marked"] for p in pages)

    return DetectionResult(
        finish_turn_marked=finish_turn_marked,
        end_session_marked=end_session_marked,
    )


def write_lock(lock_path: Path, pid: int, started: str, heartbeat: str) -> None:
    """Atomic write of the lock JSON via temp + os.replace.

    os.replace is atomic on POSIX and atomic-in-practice on NTFS for small
    files on one volume, which is the only case we hit (lock and tmp share
    the parent directory).
    """
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = lock_path.with_name(lock_path.name + ".tmp")
    payload = {"pid": pid, "started": started, "last_heartbeat": heartbeat}
    tmp.write_text(json.dumps(payload), encoding="utf-8")
    os.replace(tmp, lock_path)


def release_lock(lock_path: Path) -> None:
    try:
        lock_path.unlink()
    except FileNotFoundError:
        pass


_IDLE_RESULT = DetectionResult(finish_turn_marked=False, end_session_marked=False)


def poll_once(
    cloud_doc: str,
    pulls_dir: Path,
    last_sig: Signature,
    signature_fn: Callable[[str], Signature],
    pull_detect_fn: Callable[[str, Path], DetectionResult],
) -> Tuple[Signature, DetectionResult]:
    """One polling iteration. Returns (new_signature, result).

    Factored out of the loop so tests can drive it deterministically with
    fake signature_fn / pull_detect_fn. Idle iterations return
    (last_sig, all-false DetectionResult) without touching the network
    beyond the stat call.
    """
    current = signature_fn(cloud_doc)
    if current == last_sig:

        return current, _IDLE_RESULT
    result = pull_detect_fn(cloud_doc, pulls_dir)

    return current, result


def run(
    cloud_doc: str,
    iter_nn: str,
    pulls_dir: Path,
    lock_file: Path,
    poll_interval_s: int,
    signature_fn: Callable[[str], Signature] = fetch_signature,
    pull_detect_fn: Callable[[str, Path], DetectionResult] = pull_and_detect,
) -> int:
    """Main polling loop. Returns the desired process exit code.

    Exits 0 after emitting a READY:<NN> or STOP:<NN> line. End-session
    takes precedence over Finish-turn so a user's explicit End-session
    mark wins over an incidental concurrent Finish-turn mark in the
    same turn. The orchestrator respawns the poller after pushing the
    next iteration with updated --cloud-doc and --iter; the per-iter
    respawn shape keeps this slice independent of session-state
    tracking.
    """
    started = utc_now_iso()
    pid = os.getpid()
    write_lock(lock_file, pid, started, started)

    def _on_signal(_signum, _frame):
        release_lock(lock_file)
        sys.exit(0)

    signal.signal(signal.SIGINT, _on_signal)
    signal.signal(signal.SIGTERM, _on_signal)

    try:
        last_sig = signature_fn(cloud_doc)
        while True:
            time.sleep(poll_interval_s)
            write_lock(lock_file, pid, started, utc_now_iso())
            last_sig, result = poll_once(
                cloud_doc, pulls_dir, last_sig, signature_fn, pull_detect_fn
            )
            if result.end_session_marked:
                print(f"STOP:{iter_nn}", flush=True)

                return 0
            if result.finish_turn_marked:
                print(f"READY:{iter_nn}", flush=True)

                return 0
    finally:
        release_lock(lock_file)


def parse_args(argv):
    p = argparse.ArgumentParser(
        description="Poll the current iteration's cloud doc; emit READY:<NN> or STOP:<NN> on mark."
    )
    p.add_argument("--cloud-doc", required=True, help="reMarkable cloud doc path (bare name, no .pdf).")
    p.add_argument("--iter", required=True, help="Two-digit iteration number (e.g. 00, 05).")
    p.add_argument("--pulls-dir", required=True, type=Path, help="Local directory for pulled archives.")
    p.add_argument("--lock-file", required=True, type=Path, help="Path to the poller.lock file.")
    p.add_argument(
        "--poll-interval",
        type=int,
        default=DEFAULT_POLL_INTERVAL_S,
        help=f"Seconds between polls (default {DEFAULT_POLL_INTERVAL_S}).",
    )

    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)

    return run(
        cloud_doc=args.cloud_doc,
        iter_nn=args.iter,
        pulls_dir=args.pulls_dir,
        lock_file=args.lock_file,
        poll_interval_s=args.poll_interval,
    )


if __name__ == "__main__":
    sys.exit(main())
