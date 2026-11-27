#!/usr/bin/env bash
# Shared by GitHub Actions and scripts/gate.sh; workflow orchestration stays in YAML.
set -euo pipefail
cd packages/e2e-tests
status=0
bun test --timeout 600000 src/cache-analysis.test.ts scripts/ckios-reasoning-only-probe.test.ts || status=1
bun test --timeout 600000 scripts/tool-sweep-marker-refusal-gate.test.ts || status=1
# The oversized-prompt rejection test is long; run it on the lightest measured shard.
bun test --timeout 600000 tests/issue-538-engine-wall.test.ts || status=1

# The home-project test changes the process HOME and must not share a Bun run.
mkdir -p "${TMPDIR:-/tmp}/magic-context"
scratch=$(mktemp -d "${TMPDIR:-/tmp}/magic-context/home-project-XXXXXXXX")
trap 'rm -rf "$scratch"' EXIT
export TMPDIR="$scratch" MC_ISSUE_570_ROOT="$scratch/magic-context/home-project"
mkdir -p "$MC_ISSUE_570_ROOT"
bun test --timeout 600000 tests/issue-570-home-project.test.ts || status=1
exit "$status"
