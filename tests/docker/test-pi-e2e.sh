#!/usr/bin/env bash
# ----------------------------------------------------------------------
# Magic Context — Pi E2E test runner (runs inside Docker).
#
# Two scenarios:
#   SETUP_SMOKE    — fresh-install path via `magic-context doctor --harness pi --force`
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
# Pi 0.71.x writes --version output to stderr, so capture both 2>&1.
PI_VERSION=$(pi --version 2>&1 | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo "")
echo "  Pi version: ${PI_VERSION:-unknown}"
check "pi --version returns a value" "test -n \"$PI_VERSION\""

# ----------------------------------------------------------------------
# Phase 1: SETUP_SMOKE — non-interactive doctor --force.
# Since v0.16.1 the CLI is unified into @cortexkit/magic-context with
# `--harness pi` selecting the Pi-specific doctor pipeline. The
# `magic-context` binary was symlinked into /usr/local/bin in the
# Dockerfile.
# ----------------------------------------------------------------------
section "Phase 1: SETUP_SMOKE — magic-context doctor --harness pi --force on a clean machine"

# Pre-condition: no Magic Context state exists.
rm -rf "$HOME/.local/share/cortexkit" "$PLUGIN_LOG"

DOCTOR_OUT=$(magic-context doctor --harness pi --force 2>&1 || true)
echo "$DOCTOR_OUT" | tail -40

check "magic-context doctor --harness pi --force exits with a Doctor summary" \
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

# The Magic Context Pi extension was already pre-installed via
# `pi install /test/mc-pi` during the Dockerfile build, so it's
# registered in ~/.pi/agent/settings.json with the correct file
# path. Doctor's settings rewrite (which adds the npm: prefix) gets
# overridden here back to the local install — without this, Pi
# would try to npm-install a package that doesn't exist on npm yet.
node -e '
  const fs = require("node:fs");
  const path = "/root/.pi/agent/settings.json";
  const settings = JSON.parse(fs.readFileSync(path, "utf-8"));
  if (Array.isArray(settings.packages)) {
    settings.packages = settings.packages
      .filter((p) => !String(p).includes("npm:") || !String(p).includes("pi-magic-context"))
      .concat(["file:/test/mc-pi"]);
    settings.packages = [...new Set(settings.packages)];
    fs.writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
  }
'

# Magic Context config: minimal — just enable the extension. Subagents
# are off because the session-smoke is single-turn; aimock is for the
# main turn only.
cat > "$HOME/.pi/agent/magic-context.jsonc" <<'JSON'
{
  "enabled": true,
  "ctx_reduce_enabled": true,
  "dreamer": { "enabled": false },
  "sidekick": { "enabled": false },
  "embedding": { "provider": "off" },
  "auto_update": false
}
JSON

# Register a custom OpenAI-compatible provider pointed at aimock via
# Pi's models.json (the supported way to add custom providers without
# writing an extension).
cat > "$HOME/.pi/agent/models.json" <<'JSON'
{
  "providers": {
    "mock": {
      "api": "openai-completions",
      "baseUrl": "http://127.0.0.1:4010/v1",
      "apiKey": "sk-mock",
      "models": [
        {
          "id": "mock-model",
          "name": "Mock Model",
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 4096,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
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

echo ""
set +e
# The extension was registered via `pi install` in the Dockerfile, so
# Pi auto-loads it from settings.json. The mock provider/model is
# defined in models.json (above).
timeout --signal=KILL 60 pi --print --mode json --no-session \
    --provider mock \
    --model "mock/mock-model" \
    "Say hello once and then stop." \
    > /tmp/pi.log 2>&1
PI_EXIT=$?
set -e
echo "  pi exit code: $PI_EXIT"
echo "  ── pi log tail ──"
tail -10 /tmp/pi.log

check "pi produced output" "test -s /tmp/pi.log"
check "magic-context plugin log exists" "test -s $PLUGIN_LOG"
check "shared SQLite DB created" "test -f $DB_PATH"

if [[ -f "$DB_PATH" ]]; then
    SESSION_META_COUNT=$(sqlite3 "$DB_PATH" \
        "SELECT COUNT(*) FROM session_meta WHERE harness='pi'" 2>/dev/null || echo "0")
    echo "  session_meta(harness='pi') row count: $SESSION_META_COUNT"
    check "at least one Pi session_meta row persisted" \
        "test \"$SESSION_META_COUNT\" -gt 0"

    SCHEMA_HAS_HARNESS=$(sqlite3 "$DB_PATH" \
        "SELECT COUNT(*) FROM pragma_table_info('tags') WHERE name='harness'" 2>/dev/null || echo "0")
    check "shared DB schema includes the 'harness' column on tags" \
        "test \"$SCHEMA_HAS_HARNESS\" -gt 0"

    TAG_COUNT=$(sqlite3 "$DB_PATH" \
        "SELECT COUNT(*) FROM tags WHERE harness='pi'" 2>/dev/null || echo "0")
    echo "  tags(harness='pi') row count: $TAG_COUNT (informational)"
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
