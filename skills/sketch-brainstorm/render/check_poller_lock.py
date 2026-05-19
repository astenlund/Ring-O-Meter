"""Read .tmp/sketch-brainstorm/poller.lock and classify it.

Outputs a dict with `status` in {absent, alive, stale} and supporting
fields. Bootstrap uses this before deciding whether to claim the lock
for a new poller. The check is read-only.

PID-alive uses os.kill(pid, 0): on both Unix and Windows under CPython
3.x this raises ProcessLookupError when the process is gone and returns
quietly when it exists. PermissionError is treated as alive (the process
exists but is owned by someone else; bootstrap should still surface
force-claim).

Heartbeat staleness threshold: 60 seconds, matching the feature spec.
The poller writes its heartbeat each iteration at the 30s poll cadence,
so a 60s threshold tolerates one missed iteration.
"""

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# 2 * DEFAULT_POLL_INTERVAL_S (30 s in poll_tablet.py) — tolerates one missed
# heartbeat. Update in lockstep with DEFAULT_POLL_INTERVAL_S if the poll
# cadence changes.
HEARTBEAT_STALENESS_S = 60


def check_lock(path: Path) -> dict[str, Any]:
    """Return one of: absent, alive, stale (with reason).

    Never raises on read-side errors; treats malformed JSON and missing
    fields as stale-malformed so bootstrap can claim and proceed.
    """
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"status": "absent"}
    except json.JSONDecodeError:
        return {"status": "stale", "reason": "malformed"}

    try:
        pid = int(payload["pid"])
        heartbeat_str = payload["last_heartbeat"]
    except (KeyError, TypeError, ValueError):
        return {"status": "stale", "reason": "malformed"}

    if not _pid_alive(pid):
        return {"status": "stale", "reason": "pid-dead", "pid": pid}

    age = _heartbeat_age_s(heartbeat_str)
    if age is None:
        return {"status": "stale", "reason": "malformed"}
    if age > HEARTBEAT_STALENESS_S:
        return {
            "status": "stale",
            "reason": "heartbeat-stale",
            "pid": pid,
            "heartbeat_age_s": int(age),
        }

    return {
        "status": "alive",
        "pid": pid,
        "heartbeat_age_s": int(age),
        "started": payload.get("started"),
    }


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _heartbeat_age_s(heartbeat_str: str) -> float | None:
    try:
        # Tolerate both naive and Z-suffixed ISO 8601.
        normalized = heartbeat_str.replace("Z", "+00:00")
        when = datetime.fromisoformat(normalized)
        if when.tzinfo is None:
            when = when.replace(tzinfo=timezone.utc)
    except (AttributeError, TypeError, ValueError):
        return None
    delta = datetime.now(timezone.utc) - when

    return max(0.0, delta.total_seconds())
