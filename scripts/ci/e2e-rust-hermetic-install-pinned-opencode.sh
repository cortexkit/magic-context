#!/usr/bin/env bash
# Shared by GitHub Actions and scripts/gate.sh; workflow orchestration stays in YAML.
set -euo pipefail
OPENCODE_VERSION=1.18.32 bash tests/docker/install-opencode.sh
echo "$HOME/.opencode/bin" >> "$GITHUB_PATH"
