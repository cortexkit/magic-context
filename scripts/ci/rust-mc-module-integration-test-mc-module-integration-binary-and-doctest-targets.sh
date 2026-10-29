#!/usr/bin/env bash
# Shared by GitHub Actions and scripts/gate.sh; workflow orchestration stays in YAML.
set -euo pipefail
status=0
cargo test --locked -p mc-module --test '*' --bins --no-fail-fast || status=1
cargo test --locked -p mc-module --doc --no-fail-fast || status=1
exit "$status"
