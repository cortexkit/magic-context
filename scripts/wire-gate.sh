#!/usr/bin/env bash
# Build the throwaway subc daemon and the mock runner, then run ck-mc's wire
# suite against them (crates/mc-module/tests/wire.rs). Building the daemon
# needs network once per daemon revision; the binary is kept under the target
# directory after that.
set -euo pipefail
cd "$(dirname "$0")/.."

# The daemon the fleet runs. Bump it together with the subc crates.
DAEMON_REV=3a4c32794d9ee3625c2d54208a7fbbb84bf890e2

target_dir=$(cargo metadata --format-version 1 --no-deps --locked |
	python3 -c 'import json, sys; print(json.load(sys.stdin)["target_directory"])')
daemon_root="$target_dir/test-daemon/$DAEMON_REV"
if [ ! -x "$daemon_root/bin/ck-subc" ]; then
	CARGO_NET_OFFLINE=false cargo --config net.offline=false install --locked \
		--git https://github.com/cortexkit/subconscious --rev "$DAEMON_REV" \
		subc-core --bin ck-subc --root "$daemon_root"
fi
cargo build --locked -p mc-mock-runner --bin ck-mock-runner
MC_TEST_CK_SUBC_BIN="$daemon_root/bin/ck-subc" \
	MC_TEST_MOCK_RUNNER_BIN="$target_dir/debug/ck-mock-runner" \
	cargo test --locked -p mc-module --test wire -- --ignored --nocapture
