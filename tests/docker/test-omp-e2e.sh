#!/usr/bin/env bash
set -euo pipefail

PASS=0
FAIL=0
DB_PATH="$HOME/.local/share/cortexkit/magic-context/context.db"
PLUGIN_LOG="$(node -e 'console.log(require("os").tmpdir())')/pi/magic-context/magic-context.log"

check() {
    local label="$1"
    local condition="$2"
    if eval "$condition"; then
        echo "PASS [$label]"
        PASS=$((PASS + 1))
    else
        echo "FAIL [$label]"
        FAIL=$((FAIL + 1))
    fi
}

section() {
    echo
    echo "--- $1 ---"
}

section "Real OMP installation and plugin manager"
OMP_VERSION=$(omp --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
PLUGIN_LIST=$(omp plugin list --json 2>&1)
echo "OMP version: ${OMP_VERSION:-unknown}"
echo "$PLUGIN_LIST"
check "omp --version returns a value" "test -n \"$OMP_VERSION\""
check "OMP lists the linked Magic Context package" \
    "echo \"\$PLUGIN_LIST\" | grep -q '@cortexkit/pi-magic-context'"

section "OMP doctor repair"
rm -rf "$HOME/.local/share/cortexkit" "$PLUGIN_LOG"
DOCTOR_OUT=$(magic-context doctor --harness omp --force 2>&1 || true)
echo "$DOCTOR_OUT"
check "OMP doctor reports zero hard failures" \
    "echo \"\$DOCTOR_OUT\" | grep -qE 'FAIL 0'"
check "OMP native compaction is disabled" \
    "test \"$(omp config get compaction.enabled --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).value)))')\" = false"
check "OMP automatic memory is disabled" \
    "test \"$(omp config get memory.backend --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).value)))')\" = off"

section "Real OMP one-turn extension load"
mkdir -p "$HOME/.config/cortexkit" "$HOME/.omp/agent"
cat > "$HOME/.config/cortexkit/magic-context.jsonc" <<'JSON'
{
  "enabled": true,
  "dreamer": { "enabled": false },
  "sidekick": { "enabled": false },
  "embedding": { "provider": "off" },
  "auto_update": false
}
JSON

cat > "$HOME/.omp/agent/models.json" <<'JSON'
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

node /test/aimock-server.cjs > /tmp/aimock.log 2>&1 &
AIMOCK_PID=$!
trap 'kill $AIMOCK_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 15); do
    if curl -fsS http://127.0.0.1:4010/v1/models > /dev/null 2>&1; then
        break
    fi
    sleep 1
done
check "aimock is ready" "curl -fsS http://127.0.0.1:4010/v1/models > /dev/null"

set +e
timeout --signal=KILL 60 omp --print --mode json --no-session \
    --provider mock \
    --model mock/mock-model \
    "Say hello once and then stop." \
    > /tmp/omp.log 2>&1
OMP_EXIT=$?
set -e
echo "OMP exit: $OMP_EXIT"
tail -20 /tmp/omp.log

check "OMP turn exits successfully" "test \"$OMP_EXIT\" -eq 0"
check "OMP emits a terminal agent_end protocol event" \
    "grep -q '\"type\":\"agent_end\"' /tmp/omp.log"

check "OMP produced protocol output" "test -s /tmp/omp.log"
check "Magic Context extension initialized" "test -s $PLUGIN_LOG"
check "shared context database exists" "test -f $DB_PATH"
if [[ -f "$DB_PATH" ]]; then
    SESSION_COUNT=$(sqlite3 "$DB_PATH" \
        "SELECT COUNT(*) FROM session_meta WHERE harness='pi'" 2>/dev/null || echo 0)
    check "OMP turn persisted through the Pi-compatible runtime" \
        "test \"$SESSION_COUNT\" -gt 0"
fi

section "Summary"
echo "PASS: $PASS"
echo "FAIL: $FAIL"
test "$FAIL" -eq 0
