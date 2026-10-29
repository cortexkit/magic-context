#!/usr/bin/env bash
# Shared by GitHub Actions and scripts/gate.sh; workflow orchestration stays in YAML.
set -euo pipefail
bun run build
bun run --cwd packages/pi-plugin build:e2e-argv
bun run --cwd packages/dashboard build
