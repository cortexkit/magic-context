#!/usr/bin/env bash
# Shared by GitHub Actions and scripts/gate.sh; workflow orchestration stays in YAML.
set -euo pipefail
source scripts/ci/daemon-cargo-home.sh
prepare_daemon_cargo_home "$GITHUB_WORKSPACE/.siblings/subconscious"
export MC_TEST_DAEMON_CARGO_HOME="$DAEMON_CARGO_HOME"
printf 'Module Cargo home: %s (inherited)\n' "${CARGO_HOME:-$HOME/.cargo}"
status=0
cargo test --locked -p mc-module --test '*' --bins --no-fail-fast || status=1
cargo test --locked -p mc-module --doc --no-fail-fast || status=1
exit "$status"
