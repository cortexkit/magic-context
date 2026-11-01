#!/usr/bin/env bash
# Shared by GitHub Actions and scripts/gate.sh; workflow orchestration stays in YAML.
set -euo pipefail
docker run --rm --platform linux/amd64 mc-e2e-opencode
