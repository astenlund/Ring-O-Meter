#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Absent branch
OUT="$(SKETCH_BRAINSTORM_REPO_ROOT="$TMP" \
       bash "$SCRIPT_DIR/check-poller-lock.sh")"
echo "$OUT" | grep -q '"status": "absent"' \
  || { echo "fail: absent branch missing status" >&2; echo "got: $OUT"; exit 1; }

# Stale-PID branch (write a lock with a dead PID)
LOCK="$TMP/.tmp/sketch-brainstorm/poller.lock"
mkdir -p "$(dirname "$LOCK")"
cat > "$LOCK" <<'EOF'
{"pid": 2147483647, "started": "2026-05-19T00:00:00Z", "last_heartbeat": "2026-05-19T00:00:00Z"}
EOF

OUT="$(SKETCH_BRAINSTORM_REPO_ROOT="$TMP" \
       bash "$SCRIPT_DIR/check-poller-lock.sh")"
echo "$OUT" | grep -q '"status": "stale"' \
  || { echo "fail: stale-pid branch missing status" >&2; echo "got: $OUT"; exit 1; }
echo "$OUT" | grep -q '"reason": "pid-dead"' \
  || { echo "fail: stale-pid branch missing reason" >&2; echo "got: $OUT"; exit 1; }

# Malformed-JSON branch
echo "{not valid json" > "$LOCK"
OUT="$(SKETCH_BRAINSTORM_REPO_ROOT="$TMP" \
       bash "$SCRIPT_DIR/check-poller-lock.sh")"
echo "$OUT" | grep -q '"reason": "malformed"' \
  || { echo "fail: malformed branch missing reason" >&2; echo "got: $OUT"; exit 1; }

# Wrapper always exits 0 regardless of branch (lock states are data).
SKETCH_BRAINSTORM_REPO_ROOT="$TMP" \
  bash "$SCRIPT_DIR/check-poller-lock.sh" >/dev/null

echo "test_check_poller_lock: PASS"
