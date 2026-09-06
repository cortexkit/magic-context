#!/usr/bin/env bash
set -euo pipefail

PASS=0
FAIL=0
DB_PATH="$HOME/.local/share/cortexkit/magic-context/context.db"
# OMP is a first-class harness: it logs under its own tmpdir subtree and records
# session_meta rows as harness='omp', not 'pi'.
PLUGIN_LOG="$(node -e 'console.log(require("os").tmpdir())')/omp/magic-context/magic-context.log"

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

version_at_least() {
    local actual="$1"
    local minimum="$2"
    local -a actual_parts minimum_parts
    local index

    [[ "$actual" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
    [[ "$minimum" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
    IFS=. read -r -a actual_parts <<<"$actual"
    IFS=. read -r -a minimum_parts <<<"$minimum"
    for index in 0 1 2; do
        if ((10#${actual_parts[$index]} > 10#${minimum_parts[$index]})); then
            return 0
        fi
        if ((10#${actual_parts[$index]} < 10#${minimum_parts[$index]})); then
            return 1
        fi
    done
    return 0
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
check "omp --version reports the tested 17.1.7 floor or newer" \
    "version_at_least \"$OMP_VERSION\" 17.1.7"
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
    "grep -qE '\"type\"[[:space:]]*:[[:space:]]*\"agent_end\"' /tmp/omp.log"

section "OMP subagent argv contract"
cat > /tmp/omp-subagent-system.txt <<'PROMPT'
Reply once, then stop.
PROMPT
OMP_PACKAGE_DIR="$(npm root -g)/@oh-my-pi/pi-coding-agent"
node -e 'const m = require(process.argv[1]); console.log(`OMP package manifest: name=${m.name} version=${m.version} bin=${JSON.stringify(m.bin)}`)' \
    "$OMP_PACKAGE_DIR/package.json"
OMP_BIN_PATH="$(command -v omp)"
BUN_EXEC_PATH="$(command -v bun)"
MAGIC_CONTEXT_PI_SUBAGENT=1 \
    OMP_BIN_PATH="$OMP_BIN_PATH" \
    BUN_EXEC_PATH="$BUN_EXEC_PATH" \
    node --input-type=module > /tmp/omp-subagent-invocation <<'NODE'
import { __test } from "/test/e2e/subagent-runner-e2e.mjs";

const invocation = __test.resolvePiInvocation({
    execPath: process.env.BUN_EXEC_PATH,
    argv1: process.env.OMP_BIN_PATH,
    resolvePackageJson: () => null,
});
if (invocation.targetHarness !== "omp") {
    throw new Error(`resolved real OMP installation as ${invocation.targetHarness}`);
}
const args = __test.buildArgs(
    {
        agent: "historian",
        systemPrompt: "loaded from the explicit path",
        userMessage: "Run the one-shot child turn.",
        model: "mock/mock-model",
    },
    {
        targetHarness: invocation.targetHarness,
        systemPromptPath: "/tmp/omp-subagent-system.txt",
        modelRef: "mock/mock-model",
    },
);
if (!args.includes("--no-rules")) {
    throw new Error("resolved OMP argv is missing --no-rules");
}
for (const flag of ["--no-prompt-templates", "--no-context-files"]) {
    if (args.includes(flag)) throw new Error(`resolved OMP argv includes ${flag}`);
}
for (const arg of [invocation.command, ...invocation.prefixArgs, ...args]) {
    console.log(arg);
}
NODE
mapfile -t OMP_SUBAGENT_INVOCATION < /tmp/omp-subagent-invocation
OMP_SUBAGENT_COMMAND="${OMP_SUBAGENT_INVOCATION[0]}"
OMP_SUBAGENT_ARGS=("${OMP_SUBAGENT_INVOCATION[@]:1}")
printf 'OMP resolved subagent invocation:'
printf ' %q' "$OMP_SUBAGENT_COMMAND" "${OMP_SUBAGENT_ARGS[@]}"
printf '\n'
set +e
MAGIC_CONTEXT_PI_SUBAGENT=1 timeout --signal=KILL 60 \
    "$OMP_SUBAGENT_COMMAND" "${OMP_SUBAGENT_ARGS[@]}" > /tmp/omp-subagent.log 2>&1
OMP_SUBAGENT_EXIT=$?
set -e
echo "OMP subagent exit: $OMP_SUBAGENT_EXIT"
tail -20 /tmp/omp-subagent.log
check "OMP accepts the translated subagent argv" "test \"$OMP_SUBAGENT_EXIT\" -eq 0"
check "OMP subagent emits a terminal agent_end protocol event" \
    "grep -qE '\"type\"[[:space:]]*:[[:space:]]*\"agent_end\"' /tmp/omp-subagent.log"

check "OMP produced protocol output" "test -s /tmp/omp.log"
check "Magic Context extension initialized" "test -s $PLUGIN_LOG"
check "shared context database exists" "test -f $DB_PATH"
if [[ -f "$DB_PATH" ]]; then
    SESSION_COUNT=$(sqlite3 "$DB_PATH" \
        "SELECT COUNT(*) FROM session_meta WHERE harness='omp'" 2>/dev/null || echo 0)
    check "OMP turn persisted under the omp harness" \
        "test \"$SESSION_COUNT\" -gt 0"
fi

section "Summary"
echo "PASS: $PASS"
echo "FAIL: $FAIL"
test "$FAIL" -eq 0
