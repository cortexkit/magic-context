#!/usr/bin/env bash
# Shared by GitHub Actions and scripts/gate.sh; workflow orchestration stays in YAML.
set -euo pipefail
bun run --cwd packages/plugin check:tui-compiled
bun packages/plugin/scripts/gen-historian-prompt-golden.ts --check
bun packages/plugin/scripts/gen-pass-decision-table.ts --check
bun crates/mc-module/src/summary/two_pass/text_goldens.ts --check
(cd packages/e2e-tests && bun test ./scripts/ci-dists.test.ts)
