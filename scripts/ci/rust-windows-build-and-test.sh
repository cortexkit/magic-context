#!/usr/bin/env bash
set -euo pipefail

finished=0
home=
cleanup() {
    local status=$?
    local cleanup_status
    if [ "$status" -eq 0 ] && [ "${finished:-0}" != 1 ]; then
        printf '%s\n' "$0: exited before successful completion" >&2
        status=1
    fi
    if [ -n "$home" ]; then
        rm -rf -- "$home" || { cleanup_status=$?; [ "$status" -ne 0 ] || status=$cleanup_status; }
    fi
    exit "$status"
}
trap cleanup EXIT

logs=target/windows-rust-logs
mkdir -p "$logs"
printf 'command\texit\tseconds\toutcome\n' > "$logs/results.tsv"
status=0

record() {
    local label=$1 output start rc outcome
    shift
    output=$logs/$label.log
    start=$SECONDS
    printf '+ %s\n' "$*" > "$output"
    rc=0
    "$@" >> "$output" 2>&1 || rc=$?
    outcome=passed
    if (( rc != 0 )); then outcome=failed; fi
    # A command killed for another reason can also exit 137. Check timeout's
    # signal diagnostic before counting it as a timeout.
    if (( rc == 124 )) || { (( rc == 137 )) && grep -Fq 'timeout: sending signal ' "$output"; }; then
        outcome=timeout
    fi
    printf '%s\t%s\t%s\t%s\n' "$label" "$rc" "$((SECONDS - start))" "$outcome" >> "$logs/results.tsv"
    printf '%s: %s (exit %s in %ss; %s)\n' "$label" "$outcome" "$rc" "$((SECONDS - start))" "$output"
    if (( rc != 0 )); then status=1; fi
}

bounded() {
    LC_ALL=C timeout --verbose --kill-after=30s "$@"
}

toolchain() {
    local version
    version=$(bounded 2m rustc -vV) || return
    printf '%s\n' "$version"
    bounded 2m cargo -Vv || return
    if ! grep -Fxq "host: $MC_WINDOWS_TARGET" <<< "${version//$'\r'/}"; then
        printf 'Expected native Rust host: %s\n' "$MC_WINDOWS_TARGET" >&2
        return 1
    fi
}

record toolchain toolchain
if (( status != 0 )); then exit "$status"; fi

# Keep the installed toolchain and Cargo cache, but give the binaries only
# disposable data and config directories (including Windows fallbacks).
export CARGO_HOME=${CARGO_HOME:-$USERPROFILE/.cargo}
export RUSTUP_HOME=${RUSTUP_HOME:-$USERPROFILE/.rustup}
home=$(mktemp -d "$(cygpath -u "$RUNNER_TEMP")/mc-windows.XXXXXX")
HOME=$(cygpath -am "$home")
export HOME
export USERPROFILE=$HOME
export XDG_DATA_HOME=$HOME/data XDG_CONFIG_HOME=$HOME/config
export LOCALAPPDATA=$HOME/local APPDATA=$HOME/roaming
mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$LOCALAPPDATA" "$APPDATA"

live=(--features "agent-data,managed-settings,memory-replica")
record module-default-build bounded 18m cargo build --locked -p mc-module
record module-live-build bounded 18m cargo build --locked -p mc-module "${live[@]}"
record module-default-test-compile bounded 20m cargo test --locked -p mc-module --no-run
record module-live-test-compile bounded 20m cargo test --locked -p mc-module "${live[@]}" --no-run
record module-default-test bounded 45m cargo test --locked -p mc-module --no-fail-fast
record module-live-test bounded 45m cargo test --locked -p mc-module "${live[@]}" --no-fail-fast

for package in mc-mock-runner mc-tokenizer; do
    record "$package-build" bounded 8m cargo build --locked -p "$package"
    record "$package-test-compile" bounded 4m cargo test --locked -p "$package" --no-run
    record "$package-test" bounded 5m cargo test --locked -p "$package" --no-fail-fast
done

finished=1
exit "$status"
