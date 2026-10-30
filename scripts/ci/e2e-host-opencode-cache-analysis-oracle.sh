#!/usr/bin/env bash
# Shared by GitHub Actions and scripts/gate.sh; workflow orchestration stays in YAML.
set -euo pipefail
cd packages/e2e-tests && bun test --timeout 600000 src/cache-analysis.test.ts
