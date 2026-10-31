#!/usr/bin/env bash
# Shared by GitHub Actions and scripts/gate.sh; workflow orchestration stays in YAML.
set -euo pipefail
cd packages/e2e-tests
status=0
bun test --timeout 600000 tests/opencode2/store-generation-conversion.test.ts || status=1
bun test --timeout 600000 tests/opencode2/marker-s3-runtime.test.ts || status=1
exit "$status"
