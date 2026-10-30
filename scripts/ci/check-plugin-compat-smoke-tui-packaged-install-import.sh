#!/usr/bin/env bash
# Shared by GitHub Actions and scripts/gate.sh; workflow orchestration stays in YAML.
set -euo pipefail
bun packages/plugin/scripts/smoke-tui-pack-install.ts --skip-build
