#!/usr/bin/env bash
# Shared by GitHub Actions and scripts/gate.sh; workflow orchestration stays in YAML.
set -euo pipefail
bun -e "const { CLI } = await import('./packages/e2e-tests/src/opencode2-runner/spawn.ts'); const { execFileSync } = await import('node:child_process'); const version = execFileSync(CLI, ['--version']).toString().trim(); console.log(CLI, version); if (version !== 'opencode v' + process.env.MC_E2E_OPENCODE2_VERSION) throw new Error('OpenCode 2 host lane requires its exact matrix version')"
