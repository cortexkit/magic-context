#!/usr/bin/env bash
# Shared by GitHub Actions and scripts/gate.sh; workflow orchestration stays in YAML.
set -euo pipefail
cd packages/e2e-tests
status=0
bun test --timeout 600000 tests/opencode2/store-generation-conversion.test.ts || status=1
bun test --timeout 600000 tests/opencode2/marker-s3-runtime.test.ts || status=1

# The mapper probe checks the private TMPDIR before starting its host.
mkdir -p "${TMPDIR:-/tmp}/magic-context"
scratch=$(mktemp -d "${TMPDIR:-/tmp}/magic-context/oc2-mapper-XXXXXXXX")
trap 'rm -rf "$scratch"' EXIT
export TMPDIR="$scratch/magic-context/mapper-step-cap/fixtures"
mkdir -p "$TMPDIR"
MC_E2E_MAPPER_STEP_PROBE=1 bun test --timeout 600000 tests/opencode2/mapper-step-finalize.test.ts || status=1
exit "$status"
