#!/usr/bin/env bash
# Select dependencies for the daemon workspace without changing the module workspace's Cargo home.
prepare_daemon_cargo_home() {
  local source="$1"
  local shared="${CARGO_HOME:-$HOME/.cargo}"
  local probe="$RUNNER_TEMP/daemon-cargo-probe.log"
  if (cd "$source" && CARGO_HOME="$shared" cargo fetch --locked --offline) > "$probe" 2>&1; then
    export DAEMON_CARGO_HOME="$shared"
    printf 'Daemon Cargo home: %s (shared locked graph available offline)\n' "$DAEMON_CARGO_HOME"
  else
    export DAEMON_CARGO_HOME="${GATE_DAEMON_CARGO_HOME:-$RUNNER_TEMP/cargo-home-daemon}"
    mkdir -p "$DAEMON_CARGO_HOME"
    printf 'Daemon Cargo home: %s (job-local network fetch; shared cache cannot serve the locked graph)\n' "$DAEMON_CARGO_HOME"
    (cd "$source" && CARGO_HOME="$DAEMON_CARGO_HOME" CARGO_NET_OFFLINE=false cargo fetch --locked)
  fi
}
