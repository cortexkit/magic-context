#!/usr/bin/env bash
# Shared by GitHub Actions and scripts/gate.sh; workflow orchestration stays in YAML.
set -euo pipefail
host="$RUNNER_TEMP/oc2-host"
mkdir -p "$host"
printf '{"private":true,"dependencies":{"@opencode/cli":"%s"},"trustedDependencies":["@opencode/cli"]}\n' "${1:?missing workflow argument}" > "$host/package.json"
bun install --cwd "$host"
echo "MC_E2E_OPENCODE2_CLI=$host/node_modules/@opencode/cli/bin/opencode.exe" >> "$GITHUB_ENV"
