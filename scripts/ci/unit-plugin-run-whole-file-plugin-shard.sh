#!/usr/bin/env bash
# Shared by GitHub Actions and scripts/gate.sh; workflow orchestration stays in YAML.
set -euo pipefail
bun packages/e2e-tests/scripts/select-unit-shard.ts plugin "$UNIT_MODE" "${1:?missing workflow argument}/4" > "$RUNNER_TEMP/unit-files.txt"
mapfile -t files < "$RUNNER_TEMP/unit-files.txt"
test "${#files[@]}" -gt 0
printf '%s\n' "${files[@]}"
if [[ "$UNIT_MODE" == assertions ]]; then export MAGIC_CONTEXT_DEBUG_ASSERTIONS=1; fi
bun run --cwd packages/plugin test --reporter=junit --reporter-outfile "${UNIT_JUNIT_FILE:-$GITHUB_WORKSPACE/unit-junit.xml}" "${files[@]}"
