#!/usr/bin/env bash
# Shared by GitHub Actions and scripts/gate.sh; workflow orchestration stays in YAML.
set -euo pipefail
cd packages/plugin
if [[ -n "${MC_CONFORMANCE_ORACLE_BINARY:-}" ]]; then
  export MC_SYSTEM_DELIVERY_FIXTURE_BINARY="$MC_CONFORMANCE_ORACLE_BINARY"
fi
bun test --timeout 120000 ./src/hooks/magic-context/system-prompt-delivery.integration.test.ts
