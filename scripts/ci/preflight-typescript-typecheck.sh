#!/usr/bin/env bash
# Shared by GitHub Actions and scripts/gate.sh; workflow orchestration stays in YAML.
set -euo pipefail
status=0
for package in plugin cli retina-local-fs pi-plugin dashboard; do
  bun run --cwd "packages/$package" typecheck || status=1
done
bun run --cwd packages/e2e-tests tsc --noEmit -p tsconfig.ci.json || status=1
exit "$status"
