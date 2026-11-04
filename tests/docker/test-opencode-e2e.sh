#!/usr/bin/env bash
# ----------------------------------------------------------------------
# Magic Context — OpenCode E2E test runner (runs inside Docker).
#
# Two scenarios:
#   SETUP_SMOKE    — doctor recognizes an unregistered, fresh host
#   SESSION_SMOKE  — single-turn `opencode run` against aimock
#
# The session assertions check the shared SQLite DB at
#   ~/.local/share/cortexkit/magic-context/context.db
# rather than scraping logs, so failures are unambiguous.
# ----------------------------------------------------------------------

set -euo pipefail
finished=0

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

PASS=0
FAIL=0
DB_PATH="$HOME/.local/share/cortexkit/magic-context/context.db"
PLUGIN_LOG="$(node -e 'console.log(require("os").tmpdir())')/opencode/magic-context/magic-context.log"

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
# happens to be on npm. Install a tarball as a consumer: npm still resolves
# root devDependencies with --omit=dev, unlike dependencies of a tarball.
# ----------------------------------------------------------------------
section "Phase 0: install Magic Context locally"
cd /test/mc-opencode
# A failed install leaves file: plugins unable to resolve their runtime imports.
# Preserve npm's resolver error instead of diagnosing a missing DB much later.
PLUGIN_TARBALL=$(npm pack --ignore-scripts --silent)
mkdir -p /test/mc-install
if ! npm install --prefix /test/mc-install --no-audit --no-fund \
    "/test/mc-opencode/$PLUGIN_TARBALL"; then
    echo "Magic Context dependency installation failed; the file: plugin cannot load."
    exit 1
fi
cd /test/project

# ----------------------------------------------------------------------
# Phase 1: SETUP_SMOKE — doctor on an unregistered OpenCode install.
# Installing the npm package does not register it with the host. Doctor
# reports this optional install as informational, even with --force;
# setup owns registration. The session phase registers the local plugin.
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

check "Doctor reports the unregistered host as informational" \
    "echo \"\$DOCTOR_OUT\" | grep -qE 'Magic Context is not installed there \(run setup to add it\)'"

check "Doctor does not register a plugin on an optional host" \
    "! grep -qE '@cortexkit/opencode-magic-context' $HOME/.config/opencode/opencode.json"

check "Missing first-session database is informational" \
    "echo \"\$DOCTOR_OUT\" | grep -q 'OpenCode session database not yet created' && ! echo \"\$DOCTOR_OUT\" | grep -q 'FAIL OpenCode session database'"

# Magic Context creates its DB lazily on first plugin load, so it
# may not exist yet after just `doctor`. The session smoke phase
# below will trigger DB creation; we just verify doctor didn't
# leave any unfixed issue.
check "doctor did not leave issues that need manual attention" \
    "! echo \"\$DOCTOR_OUT\" | grep -qE 'need manual attention'"

# ----------------------------------------------------------------------
# Phase 2: SESSION_SMOKE — run a real opencode session against aimock.
# Two assertions:
#   - the plugin entered its server hook (boot breadcrumb, not doctor output)
#   - the plugin tagged ≥1 message in the shared DB with harness='opencode'
# ----------------------------------------------------------------------
section "Phase 2: SESSION_SMOKE — single-turn opencode run with aimock"

# Tell OpenCode about an OpenAI-compatible mock provider. Use a
# file:// plugin specifier so OpenCode loads the locally-built plugin
# from the installed local tarball rather than pulling the published version from
# npm. Without this, OpenCode's plugin resolver hits its own per-
# package cache (~/.cache/opencode/packages/) and downloads the
# @latest npm tarball, which would test the previous release rather
# than the working tree.
cat > "$HOME/.config/opencode/opencode.json" <<'JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///test/mc-install/node_modules/@cortexkit/opencode-magic-context"],
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
mkdir -p "$HOME/.config/cortexkit"
cat > "$HOME/.config/cortexkit/magic-context.jsonc" <<'JSON'
{
  "enabled": true,
  "historian": { "model": "mock/mock-model" },
  "dreamer": { "enabled": false },
  "embedding": { "provider": "off" },
  "auto_update": false
}
JSON

# Start aimock in the background.
node /test/aimock-server.cjs > /tmp/aimock.log 2>&1 &
AIMOCK_PID=$!
# shellcheck disable=SC2064
trap 'status=$?
if [ "$status" -eq 0 ] && [ "${finished:-0}" != 1 ]; then
    printf "%s\n" "$0: exited before successful completion" >&2
    status=1
fi
kill "$AIMOCK_PID" 2>/dev/null || true
exit "$status"' EXIT

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

# Doctor also writes this log; only the server hook emits the boot breadcrumb.
check "magic-context plugin entered server hook" \
    "grep -q '\[magic-context\] boot: entering pid=' $PLUGIN_LOG"

# Shared DB should now exist and have at least one tagged message.
check "shared SQLite DB created" "test -f $DB_PATH"
# A missing DB can mean load failure or storage initialization failure.
# Print the plugin log here and the host's session.error events below.
if [[ ! -f "$DB_PATH" && -s "$PLUGIN_LOG" ]]; then
    echo "  ── magic-context log (shared DB missing) ──"
    tail -60 "$PLUGIN_LOG"
fi

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

    # OpenCode 1.18.30 calls both server() and setup() on the published
    # { id, server, setup } export. If setup() locks harness=opencode2, every
    # session-scoped row is mislabelled. These DISTINCT checks are the
    # regression that would have stopped that lock from shipping.
    SESSION_META_ANY=$(sqlite3 "$DB_PATH" \
        "SELECT COUNT(*) FROM session_meta" 2>/dev/null || echo "0")
    SESSION_META_HARNESSES=$(sqlite3 "$DB_PATH" \
        "SELECT IFNULL(group_concat(harness, ','), '') FROM (SELECT DISTINCT harness FROM session_meta ORDER BY 1)" \
        2>/dev/null || echo "")
    echo "  session_meta DISTINCT harness: $SESSION_META_HARNESSES (rows=$SESSION_META_ANY)"
    # Empty tables mean the turn died before persist (qemu timeout). When any
    # row exists, the set of labels must be exactly opencode — opencode2 here
    # is the v1 setup() lock that shipped in 0.42.4/5.
    # Native CI runners finish the turn; only the qemu-emulated local run may
    # legitimately stop before persist, so in CI an empty table is a failure.
    if [[ -n "${CI:-}" ]]; then
        check "session_meta persisted at least one row" "test \"$SESSION_META_ANY\" -gt 0"
    fi
    if [[ "$SESSION_META_ANY" -gt 0 ]]; then
        check "session_meta DISTINCT harness is exactly opencode" \
            "test \"$SESSION_META_HARNESSES\" = \"opencode\""
    fi

    TAG_ANY=$(sqlite3 "$DB_PATH" \
        "SELECT COUNT(*) FROM tags" 2>/dev/null || echo "0")
    TAG_HARNESSES=$(sqlite3 "$DB_PATH" \
        "SELECT IFNULL(group_concat(harness, ','), '') FROM (SELECT DISTINCT harness FROM tags ORDER BY 1)" \
        2>/dev/null || echo "")
    echo "  tags DISTINCT harness: $TAG_HARNESSES (rows=$TAG_ANY)"
    if [[ "$TAG_ANY" -gt 0 ]]; then
        check "tags DISTINCT harness is exactly opencode" \
            "test \"$TAG_HARNESSES\" = \"opencode\""
    fi
fi

# ----------------------------------------------------------------------
# DUAL_INSTANCE_BOOT keeps one real OpenCode server active for this project
# while a second OpenCode process boots against the same MC database. A separate
# SQLite connection holds a representative BEGIN IMMEDIATE write lock so this
# harness exercises startup diagnostics and lock behavior together.
# ----------------------------------------------------------------------
section "Phase 3: DUAL_INSTANCE_BOOT — shared project and contended MC database"

DUAL_STORAGE="$HOME/.local/share/cortexkit/magic-context"
DUAL_A_MC=/tmp/dual-instance-a-mc.log
DUAL_B_MC=/tmp/dual-instance-b-mc.log
DUAL_A_LOG=/tmp/dual-instance-a.log
DUAL_B_LOG=/tmp/dual-instance-b.log
rm -f "$DUAL_A_MC" "$DUAL_B_MC" "$DUAL_A_LOG" "$DUAL_B_LOG"

MAGIC_CONTEXT_STORAGE_DIR="$DUAL_STORAGE" MAGIC_CONTEXT_LOG_PATH="$DUAL_A_MC" \
    opencode serve --hostname 127.0.0.1 --port 4098 >"$DUAL_A_LOG" 2>&1 &
DUAL_A_PID=$!
for _ in $(seq 1 150); do
    if curl -fsS --max-time 0.2 http://127.0.0.1:4098/doc >/dev/null 2>&1; then break; fi
    sleep 0.1
done
# Subscribe globally before /config bootstraps the instance. The project event
# endpoint bootstraps before subscribing and can miss plugin load failures.
# Retain the existing 20s config deadline. Keep reading until the server stops:
# /config can return before asynchronous plugin initialization publishes errors.
{
node --input-type=module > /tmp/opencode-events.log 2>&1 <<'JS' || true
import { writeFileSync } from "node:fs";
const controller = new AbortController();
const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]);
let events;
try {
    const response = await fetch("http://127.0.0.1:4098/global/event", { signal });
    if (!response.ok) throw new Error(`Event subscription: HTTP ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    if (first.done) throw new Error("Event subscription closed before bootstrap");
    process.stdout.write(decoder.decode(first.value, { stream: true }));
    events = (async () => {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            process.stdout.write(decoder.decode(next.value, { stream: true }));
        }
    })().catch((error) => {
        if (!signal.aborted) console.error(error);
    });
    const config = await fetch("http://127.0.0.1:4098/config?directory=/test/project", { signal });
    writeFileSync("/tmp/dual-instance-a-config.json", await config.text());
    if (!config.ok) throw new Error(`Config bootstrap: HTTP ${config.status}`);
    await events;
} finally {
    controller.abort();
    await events;
}
JS
} &
EVENTS_PID=$!
for _ in $(seq 1 150); do
    [[ -s "$DUAL_A_MC" ]] && break
    sleep 0.1
done
check "instance A loaded Magic Context for the project" "test -s $DUAL_A_MC"

# Keep a write transaction open long enough to overlap instance B's storage
# initialization. WAL readers remain available; current-schema boot must avoid
# acquiring a migration write lock merely to discover that no migration exists.
({ echo "PRAGMA busy_timeout=1000; BEGIN IMMEDIATE;"; sleep 6; echo "COMMIT;"; } | \
    sqlite3 "$DB_PATH" >/tmp/dual-instance-holder.log 2>&1) &
DUAL_HOLDER_PID=$!
sleep 0.2
DUAL_STARTED_MS=$(date +%s%3N)
set +e
MAGIC_CONTEXT_STORAGE_DIR="$DUAL_STORAGE" MAGIC_CONTEXT_LOG_PATH="$DUAL_B_MC" \
    timeout --signal=KILL 20 opencode debug config >"$DUAL_B_LOG" 2>&1 &
DUAL_B_PID=$!
DUAL_FIRST_LOG_MS=-1
for _ in $(seq 1 300); do
    if [[ -s "$DUAL_B_MC" ]]; then
        DUAL_FIRST_LOG_MS=$(( $(date +%s%3N) - DUAL_STARTED_MS ))
        break
    fi
    kill -0 "$DUAL_B_PID" 2>/dev/null || break
    sleep 0.1
done
wait "$DUAL_B_PID"
DUAL_B_EXIT=$?
set -e
wait "$DUAL_HOLDER_PID" 2>/dev/null || true
DUAL_READY_MS=$(( $(date +%s%3N) - DUAL_STARTED_MS ))
DUAL_RPC_FILE_COUNT=$(find "$DUAL_STORAGE/rpc" -type f -name 'port-*.json' 2>/dev/null | wc -l || true)
kill "$DUAL_A_PID" 2>/dev/null || true
wait "$DUAL_A_PID" 2>/dev/null || true
kill "$EVENTS_PID" 2>/dev/null || true
wait "$EVENTS_PID" 2>/dev/null || true

echo "  instance B first Magic Context log: ${DUAL_FIRST_LOG_MS}ms"
echo "  instance B host config ready: ${DUAL_READY_MS}ms (exit=$DUAL_B_EXIT)"
check "instance B emits boot: entering before contention" \
    "test \"$DUAL_FIRST_LOG_MS\" -ge 0 && grep -q '\[magic-context\] boot: entering pid=' $DUAL_B_MC"
check "instance B completes while instance A remains active" "test \"$DUAL_B_EXIT\" -eq 0"
check "instance B stays inside the 20s host-start cap" "test \"$DUAL_READY_MS\" -lt 20000"
check "instance A published project-scoped RPC discovery" \
    "test \"$DUAL_RPC_FILE_COUNT\" -gt 0"

# ----------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------
section "Summary"
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"
echo ""
if [[ $FAIL -eq 0 ]]; then
    echo -e "${GREEN}All OpenCode E2E checks passed.${NC}"
    finished=1
    exit 0
else
    echo "  ── OpenCode bootstrap events (includes session.error load failures) ──"
    cat /tmp/opencode-events.log 2>/dev/null || true
    echo -e "${RED}OpenCode E2E checks failed.${NC}"
    exit 1
fi
