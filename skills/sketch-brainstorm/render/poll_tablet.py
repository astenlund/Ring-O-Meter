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
from typing import Callable, Optional, Tuple

from _atomic_write import atomic_write_text
from _chrome_boxes import ITER_NN_RE, VALID_MODES

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
    """Per-event-class detection outcome from one pull + detect pass."""

    finish_turn_marked: bool
    end_session_marked: bool
    mode_winner: Optional[str]  # "color" | "bw" | "wireframe" | None


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


def _resolve_mode_winner(per_page) -> Optional[str]:
    """Apply radio-button winner-takes-all on the mode-switch trio.

    Two distinct cross-page aggregations apply here, matching the
    output contract:
      - `marked` collapses across pages with OR (any page qualifies).
      - `area_rm_sq` collapses across pages with max (for tiebreak).
    Returns the box's short name if any box is marked and a unique
    area-winner exists; None on no marks or ties.
    """
    per_mode_max = {short: 0.0 for short in VALID_MODES}
    qualifying = []
    for short in VALID_MODES:
        marked = False
        for page in per_page:
            box = page["boxes"][f"mode_{short}"]
            if box["area_rm_sq"] > per_mode_max[short]:
                per_mode_max[short] = box["area_rm_sq"]
            if box["marked"]:
                marked = True
        if marked:
            qualifying.append(short)
    if not qualifying:
        return None
    if len(qualifying) == 1:
        return qualifying[0]
    qualifying.sort(key=lambda s: per_mode_max[s], reverse=True)
    # Float equality is safe here: detect_marks rounds area_rm_sq to 3dp,
    # so values arrive at this comparison as canonical 3-decimal floats.
    if per_mode_max[qualifying[0]] == per_mode_max[qualifying[1]]:
        return None

    return qualifying[0]


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
    pull_lines = pull.stdout.strip().splitlines()
    if not pull_lines:
        raise RuntimeError("pull-from-tablet.sh produced no output (rm-dir path missing)")
    rm_dir = pull_lines[-1]
    if not Path(rm_dir).is_dir():
        raise RuntimeError(f"pull-from-tablet.sh emitted non-directory rm_dir: {rm_dir!r}")
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
    mode_winner = _resolve_mode_winner(pages)

    return DetectionResult(
        finish_turn_marked=finish_turn_marked,
        end_session_marked=end_session_marked,
        mode_winner=mode_winner,
    )


def write_lock(lock_path: Path, pid: int, started: str, heartbeat: str) -> None:
    """Atomic write of the lock JSON."""
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"pid": pid, "started": started, "last_heartbeat": heartbeat}
    atomic_write_text(lock_path, json.dumps(payload))


def release_lock(lock_path: Path) -> None:
    try:
        lock_path.unlink()
    except FileNotFoundError:
        pass


_IDLE_RESULT = DetectionResult(finish_turn_marked=False, end_session_marked=False, mode_winner=None)


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

    # Signal handlers set a flag; the loop checks it and exits via the
    # normal return path so the finally-block lock cleanup runs once.
    # Avoids the project's `sys.exit() only in main()` convention break
    # and removes the prior pattern's duplicated release_lock() call.
    shutdown_requested = [False]

    def _on_signal(_signum, _frame):
        shutdown_requested[0] = True

    signal.signal(signal.SIGINT, _on_signal)
    signal.signal(signal.SIGTERM, _on_signal)

    try:
        last_sig = signature_fn(cloud_doc)
        while not shutdown_requested[0]:
            time.sleep(poll_interval_s)
            if shutdown_requested[0]:
                break
            write_lock(lock_file, pid, started, utc_now_iso())
            last_sig, result = poll_once(
                cloud_doc, pulls_dir, last_sig, signature_fn, pull_detect_fn
            )
            if result.end_session_marked:
                print(f"STOP:{iter_nn}", flush=True)

                return 0
            if result.finish_turn_marked:
                suffix = f":mode={result.mode_winner}" if result.mode_winner else ""
                print(f"READY:{iter_nn}{suffix}", flush=True)

                return 0

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
    args = p.parse_args(argv)
    if not ITER_NN_RE.fullmatch(args.iter):
        p.error(f"--iter must be at least two decimal digits; got {args.iter!r}")

    return args


def main(argv=None):
    args = parse_args(argv)
    try:
        return run(
            cloud_doc=args.cloud_doc,
            iter_nn=args.iter,
            pulls_dir=args.pulls_dir,
            lock_file=args.lock_file,
            poll_interval_s=args.poll_interval,
        )
    except (subprocess.CalledProcessError, json.JSONDecodeError, OSError, RuntimeError) as e:
        print(f"poll_tablet: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
