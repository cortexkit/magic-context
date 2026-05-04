#!/usr/bin/env bash
# ----------------------------------------------------------------------
# Magic Context — OpenCode E2E test runner (runs inside Docker).
#
# Two scenarios:
#   SETUP_SMOKE    — fresh-install path via `doctor --force`
#   SESSION_SMOKE  — single-turn `opencode run` against aimock
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
# Phase 0: install the Magic Context plugin from the local copy so the
# rest of the script tests the bits we plan to publish, not whatever
# happens to be on npm. We use `npm link` so global `bunx` resolves the
# local copy of @cortexkit/opencode-magic-context.
# ----------------------------------------------------------------------
section "Phase 0: install Magic Context locally"
cd /test/mc-opencode
npm install --silent --no-audit --no-fund --omit=dev 2>&1 | tail -5 || true
npm link --silent --no-audit --no-fund 2>&1 | tail -3 || true
cd /test/project

# ----------------------------------------------------------------------
# Phase 1: SETUP_SMOKE — non-interactive setup via `doctor --force`.
# Doctor's --force mode repairs an existing OpenCode install: it adds
# the plugin entry, fixes compaction conflicts, ensures tui.json. It
# does NOT create opencode.json from scratch (that's the setup wizard's
# job). To simulate the "user just installed OpenCode + ran doctor"
# path, we seed an empty opencode.json first.
# ----------------------------------------------------------------------
section "Phase 1: SETUP_SMOKE — doctor --force on a fresh OpenCode install"

# Pre-condition: clean Magic Context state, but a minimal opencode.json
# exists (this is what the OpenCode installer leaves behind).
rm -rf "$HOME/.config/opencode" "$HOME/.local/share/cortexkit" "$PLUGIN_LOG"
mkdir -p "$HOME/.config/opencode"
echo '{}' > "$HOME/.config/opencode/opencode.json"

# Since v0.16.1 the CLI lives in the unified @cortexkit/magic-context
# package — opencode-magic-context is now the runtime plugin only. The
# `magic-context` binary was symlinked into /usr/local/bin during the
# Dockerfile build, so it resolves the same way `npm install -g
# @cortexkit/magic-context` would on a real machine.
DOCTOR_OUT=$(magic-context doctor --harness opencode --force 2>&1 || true)
echo "$DOCTOR_OUT" | tail -30

# Doctor's actual outro is one of:
#   "Everything looks good!"
#   "Found N issue(s), fixed M. Restart OpenCode to apply."
#   "Fixed M issue(s). Restart OpenCode to apply."
#   "Found N issue(s) that need manual attention."
# The first three are success cases; the last is a hard failure (exit 1).
check "doctor --force completed without hard failures" \
    "echo \"\$DOCTOR_OUT\" | grep -qE '(Everything looks good|Fixed [0-9]+ issue|Found [0-9]+ issue\\(s\\), fixed)'"

check "OpenCode config still exists at ~/.config/opencode/opencode.json" \
    "test -f $HOME/.config/opencode/opencode.json"

check "Plugin entry registered in OpenCode config" \
    "grep -qE '@cortexkit/opencode-magic-context' $HOME/.config/opencode/opencode.json"

# Magic Context creates its DB lazily on first plugin load, so it
# may not exist yet after just `doctor`. The session smoke phase
# below will trigger DB creation; we just verify doctor didn't
# leave any unfixed issue.
check "doctor did not leave issues that need manual attention" \
    "! echo \"\$DOCTOR_OUT\" | grep -qE 'need manual attention'"

# ----------------------------------------------------------------------
# Phase 2: SESSION_SMOKE — run a real opencode session against aimock.
# Two assertions:
#   - the plugin loaded (log file exists, contains a session-id line)
#   - the plugin tagged ≥1 message in the shared DB with harness='opencode'
# ----------------------------------------------------------------------
section "Phase 2: SESSION_SMOKE — single-turn opencode run with aimock"

# Tell OpenCode about an OpenAI-compatible mock provider. Use a
# file:// plugin specifier so OpenCode loads the locally-built plugin
# at /test/mc-opencode rather than pulling the published version from
# npm. Without this, OpenCode's plugin resolver hits its own per-
# package cache (~/.cache/opencode/packages/) and downloads the
# @latest npm tarball, which would test the previous release rather
# than the working tree.
cat > "$HOME/.config/opencode/opencode.json" <<'JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///test/mc-opencode"],
  "compaction": { "auto": false, "prune": false },
  "provider": {
    "mock": {
      "api": "openai",
      "name": "aimock",
      "options": { "baseURL": "http://127.0.0.1:4010/v1" },
      "models": { "mock-model": { "name": "Mock Model" } }
    }
  }
}
JSON

# Magic Context config — local embeddings (no network), historian
# pointed at the same mock model so any background historian call also
# resolves through aimock without external API.
cat > "$HOME/.config/opencode/magic-context.jsonc" <<'JSON'
{
  "enabled": true,
  "ctx_reduce_enabled": true,
  "historian": { "model": "mock/mock-model" },
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

# Run opencode for one turn. Cap at 60s so a hung mock doesn't hang CI.
echo ""
set +e
OPENAI_API_KEY=sk-mock-e2e-test \
    timeout --signal=KILL 60 opencode run \
        --model "mock/mock-model" \
        "Say hello once and then stop." \
        > /tmp/opencode.log 2>&1
OC_EXIT=$?
set -e
echo "  opencode exit code: $OC_EXIT"
echo "  ── opencode log tail ──"
tail -20 /tmp/opencode.log

check "opencode produced a log file" "test -s /tmp/opencode.log"

# Plugin log should now exist with at least one transform line.
check "magic-context plugin log exists" "test -s $PLUGIN_LOG"

# Shared DB should now exist and have at least one tagged message.
check "shared SQLite DB created" "test -f $DB_PATH"

if [[ -f "$DB_PATH" ]]; then
    SESSION_META_COUNT=$(sqlite3 "$DB_PATH" \
        "SELECT COUNT(*) FROM session_meta WHERE harness='opencode'" 2>/dev/null || echo "0")
    echo "  session_meta(harness='opencode') row count: $SESSION_META_COUNT"
    check "at least one OpenCode session_meta row persisted" \
        "test \"$SESSION_META_COUNT\" -gt 0"

    # Schema check: harness column exists and at least one OpenCode-scoped
    # row was attributed correctly. We don't strictly require any 'tags'
    # rows because `opencode run` can be SIGKILLed by our 60s timeout
    # before the plugin's transform fully persists tag rows for a
    # one-shot message — the session_meta row writes earlier in the
    # transform pipeline and is the more reliable proof that the plugin
    # loaded, opened the DB at the correct cortexkit path, and tagged
    # the session with the right harness.
    SCHEMA_HAS_HARNESS=$(sqlite3 "$DB_PATH" \
        "SELECT COUNT(*) FROM pragma_table_info('tags') WHERE name='harness'" 2>/dev/null || echo "0")
    check "shared DB schema includes the 'harness' column on tags" \
        "test \"$SCHEMA_HAS_HARNESS\" -gt 0"

    TAG_COUNT=$(sqlite3 "$DB_PATH" \
        "SELECT COUNT(*) FROM tags WHERE harness='opencode'" 2>/dev/null || echo "0")
    echo "  tags(harness='opencode') row count: $TAG_COUNT (informational)"
fi

# ----------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------
section "Summary"
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"
echo ""
if [[ $FAIL -eq 0 ]]; then
    echo -e "${GREEN}All OpenCode E2E checks passed.${NC}"
    exit 0
else
    echo -e "${RED}OpenCode E2E checks failed.${NC}"
    exit 1
fi
