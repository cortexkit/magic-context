#!/usr/bin/env bash
# Shared by GitHub Actions and scripts/gate.sh; workflow orchestration stays in YAML.
set -euo pipefail
status=0
for package in plugin cli retina-local-fs pi-plugin dashboard; do
  bun run --cwd "packages/$package" lint || status=1
done
./packages/plugin/node_modules/.bin/biome check --indent-style=space --indent-width=4 --line-width=100 scripts/gate.ts scripts/gate.test.ts scripts/gate-tools.ts scripts/gate-tools.test.ts || status=1
exit "$status"
