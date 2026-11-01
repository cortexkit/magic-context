#!/usr/bin/env bash
# Shared by GitHub Actions and scripts/gate.sh; workflow orchestration stays in YAML.
set -euo pipefail
set -euo pipefail
target="$GITHUB_WORKSPACE/packages/e2e-tests/.cache/rust-e2e-cargo-target"
mkdir -p "$target/prebuilt"
printf 'Module Cargo home: %s (inherited)\n' "${CARGO_HOME:-$HOME/.cargo}"
CARGO_TARGET_DIR="$target" cargo build --release -p mc-module --bin ck-mc --example transform_replay
cp "$target/release/ck-mc" "$target/prebuilt/ckdev-mc-e2e"
cp "$target/release/examples/transform_replay" "$target/prebuilt/rust-raw-replay-probe"
CARGO_TARGET_DIR="$target" cargo build --release -p mc-module --features drive-fault
cp "$target/release/ck-mc" "$target/prebuilt/ckdev-mc-e2e-drive-fault"
source "$GITHUB_WORKSPACE/scripts/ci/daemon-cargo-home.sh"
prepare_daemon_cargo_home "$GITHUB_WORKSPACE/.siblings/subconscious"
(cd "$GITHUB_WORKSPACE/.siblings/subconscious" && CARGO_HOME="$DAEMON_CARGO_HOME" CARGO_TARGET_DIR="$target" cargo build --locked --release -p subc-core --bins)
cp "$target/release/ck-subc" "$target/prebuilt/ckdev-subc"
printf '%s\n' "$GITHUB_SHA" > "$target/prebuilt/commit.txt"
tar -czf "$RUNNER_TEMP/rust-hermetic-binaries.tar.gz" -C "$target/prebuilt" .
(cd "$RUNNER_TEMP" && sha256sum rust-hermetic-binaries.tar.gz > rust-hermetic-binaries.sha256)
