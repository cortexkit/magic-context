#!/usr/bin/env bash
# Shared by GitHub Actions and scripts/gate.sh; workflow orchestration stays in YAML.
set -euo pipefail
cd packages/plugin
bun test --timeout 120000 ./src/hooks/magic-context/system-prompt-delivery.integration.test.ts
