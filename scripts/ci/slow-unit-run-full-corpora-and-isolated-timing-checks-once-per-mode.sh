#!/usr/bin/env bash
# Shared by GitHub Actions and scripts/gate.sh; workflow orchestration stays in YAML.
set -euo pipefail
if [[ "$UNIT_MODE" == assertions ]]; then export MAGIC_CONTEXT_DEBUG_ASSERTIONS=1; fi
bun packages/e2e-tests/scripts/run-slow-unit-tests.ts
