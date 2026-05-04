#!/usr/bin/env bash
# ----------------------------------------------------------------------
# Magic Context — Pi E2E test runner (runs inside Docker).
#
# Two scenarios:
#   SETUP_SMOKE    — fresh-install path via `magic-context-pi doctor --force`
#   SESSION_SMOKE  — single-turn `pi --print --mode json` against aimock
#
# Both assertions check the shared SQLite DB at
#   ~/.local/share/cortexkit/magic-context/context.db
# rather than scraping logs, so failures are unambiguous.
# ----------------------------------------------------------------------

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

PASS=0
FAIL=0
DB_PATH="$HOME/.local/share/cortexkit/magic-context/context.db"
PLUGIN_LOG="$(node -e 'console.log(require("os").tmpdir())')/magic-context.log"

check() {
    local label="$1"
    local condition="$2"
    if eval "$condition"; then
        echo -e "  ${GREEN}PASS${NC} [$label]"
        PASS=$((PASS + 1))
    else
        echo -e "  ${RED}FAIL${NC} [$label]"
        FAIL=$((FAIL + 1))
    fi
}

section() {
    echo ""
    echo -e "${BLUE}─── $1 ───${NC}"
    echo ""
}

# ----------------------------------------------------------------------
# Phase 0: verify Pi version meets the >= 0.71.0 floor we declare in
# the Pi extension's peer dependency.
# ----------------------------------------------------------------------
section "Phase 0: Pi installation sanity"
PI_VERSION=$(pi --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo "")
echo "  Pi version: ${PI_VERSION:-unknown}"
check "pi --version returns a value" "test -n \"$PI_VERSION\""

# ----------------------------------------------------------------------
# Phase 1: SETUP_SMOKE — non-interactive doctor --force.
# magic-context-pi binary was symlinked into /usr/local/bin in the
# Dockerfile.
# ----------------------------------------------------------------------
section "Phase 1: SETUP_SMOKE — magic-context-pi doctor --force on a clean machine"

# Pre-condition: no Magic Context state exists.
rm -rf "$HOME/.local/share/cortexkit" "$PLUGIN_LOG"

DOCTOR_OUT=$(magic-context-pi doctor --force 2>&1 || true)
echo "$DOCTOR_OUT" | tail -40

check "magic-context-pi doctor --force exits with a Doctor summary" \
    "echo \"\$DOCTOR_OUT\" | grep -qE 'Doctor (complete|repair complete|found failures)'"

check "Pi user config created at ~/.pi/agent/magic-context.jsonc" \
    "test -f $HOME/.pi/agent/magic-context.jsonc"

check "Pi settings.json registered the magic-context package" \
    "grep -q 'pi-magic-context' $HOME/.pi/agent/settings.json"

# Doctor should report Pi version meets the 0.71.0 floor (we installed
# >= 0.71.0 in the Dockerfile).
check "doctor confirms Pi version meets 0.71.0 floor" \
    "echo \"\$DOCTOR_OUT\" | grep -qE 'PASS Pi version meets minimum'"

# Doctor's summary line uses "FAIL <n>". 0 failures is acceptable; only
# infra issues (no Pi, no DB) should fail at this point.
check "doctor reports zero hard failures" \
    "echo \"\$DOCTOR_OUT\" | grep -qE 'FAIL 0'"

# ----------------------------------------------------------------------
# Phase 2: SESSION_SMOKE — run a single Pi turn against aimock with
# the Magic Context extension loaded.
# ----------------------------------------------------------------------
section "Phase 2: SESSION_SMOKE — single-turn pi --print with aimock"

# Magic Context config: point everything at the mock model so any
# subagent (historian/sidekick) also resolves to aimock.
cat > "$HOME/.pi/agent/magic-context.jsonc" <<'JSON'
{
  "enabled": true,
  "ctx_reduce_enabled": true,
  "historian": { "model": "openai/mock-model" },
  "dreamer": { "enabled": false },
  "sidekick": { "enabled": false },
  "embedding": { "provider": "off" },
  "auto_update": false
}
JSON

# Start aimock in the background.
node /test/aimock-server.cjs > /tmp/aimock.log 2>&1 &
AIMOCK_PID=$!
# shellcheck disable=SC2064
trap "kill $AIMOCK_PID 2>/dev/null || true" EXIT

# Wait for aimock to be ready (max 15s).
for _ in $(seq 1 15); do
    if curl -fsS http://127.0.0.1:4010/v1/models > /dev/null 2>&1; then
        break
    fi
    sleep 1
done
check "aimock /v1/models responds" \
    "curl -fsS http://127.0.0.1:4010/v1/models > /dev/null"

# Run pi for one turn. Cap at 60s.
echo ""
set +e
timeout --signal=KILL 60 pi --print --mode json --no-session \
    --model "openai/mock-model" \
    "Say hello once and then stop." \
    > /tmp/pi.log 2>&1
PI_EXIT=$?
set -e
echo "  pi exit code: $PI_EXIT"
echo "  ── pi log tail ──"
tail -20 /tmp/pi.log

check "pi produced a log file" "test -s /tmp/pi.log"

# Plugin log should now exist.
check "magic-context plugin log exists" "test -s $PLUGIN_LOG"

# Shared DB should now exist and have at least one tagged message.
check "shared SQLite DB created" "test -f $DB_PATH"

if [[ -f "$DB_PATH" ]]; then
    TAG_COUNT=$(sqlite3 "$DB_PATH" \
        "SELECT COUNT(*) FROM tags WHERE harness='pi'" 2>/dev/null || echo "0")
    echo "  tags(harness='pi') row count: $TAG_COUNT"
    check "at least one Pi-harness tag persisted" "test \"$TAG_COUNT\" -gt 0"

    SESSION_META_COUNT=$(sqlite3 "$DB_PATH" \
        "SELECT COUNT(*) FROM session_meta WHERE harness='pi'" 2>/dev/null || echo "0")
    echo "  session_meta(harness='pi') row count: $SESSION_META_COUNT"
    check "at least one Pi session_meta row persisted" \
        "test \"$SESSION_META_COUNT\" -gt 0"
fi

# ----------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------
section "Summary"
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"
echo ""
if [[ $FAIL -eq 0 ]]; then
    echo -e "${GREEN}All Pi E2E checks passed.${NC}"
    exit 0
else
    echo -e "${RED}Pi E2E checks failed.${NC}"
    exit 1
fi
