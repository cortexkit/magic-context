#!/usr/bin/env bash
# Shared by GitHub Actions and scripts/gate.sh; workflow orchestration stays in YAML.
set -euo pipefail
bun run --cwd packages/plugin check:tui-compiled
bun crates/mc-module/gen/gen-historian-prompt-golden.ts --check
bun crates/mc-module/gen/gen-memory-actions-golden.ts --check
bun crates/mc-module/gen/gen-curate-undo-golden.ts --check
(cd packages/e2e-tests && bun test ./scripts/ci-dists.test.ts)
