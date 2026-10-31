#!/usr/bin/env bash
# Shared by GitHub Actions and scripts/gate.sh; workflow orchestration stays in YAML.
set -euo pipefail
status=0
for package in cli retina-local-fs; do
  bun run --cwd "packages/$package" test || status=1
done
MAGIC_CONTEXT_DEBUG_ASSERTIONS=1 bun run --cwd packages/cli test || status=1
MAGIC_CONTEXT_DEBUG_ASSERTIONS=1 bun run --cwd packages/retina-local-fs test --timeout=60000 || status=1
exit "$status"
