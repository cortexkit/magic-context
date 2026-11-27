#!/usr/bin/env bash
set -euo pipefail

logs=target/windows-rust-logs
mkdir -p "$logs"
printf 'command\texit\tseconds\n' > "$logs/results.tsv"
status=0

record() {
    local label=$1 output start rc
    shift
    output=$logs/$label.log
    start=$SECONDS
    printf '+ %s\n' "$*" > "$output"
    rc=0
    "$@" >> "$output" 2>&1 || rc=$?
    printf '%s\t%s\t%s\n' "$label" "$rc" "$((SECONDS - start))" >> "$logs/results.tsv"
    printf '%s: exit %s in %ss (%s)\n' "$label" "$rc" "$((SECONDS - start))" "$output"
    if (( rc != 0 )); then status=1; fi
}

toolchain() {
    local version
    version=$(rustc -vV) || return
    printf '%s\n' "$version"
    cargo -Vv || return
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
trap 'rm -rf "$home"' EXIT
export HOME=$(cygpath -am "$home")
export USERPROFILE=$HOME
export XDG_DATA_HOME=$HOME/data XDG_CONFIG_HOME=$HOME/config
export LOCALAPPDATA=$HOME/local APPDATA=$HOME/roaming
mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$LOCALAPPDATA" "$APPDATA"

live=(--features agent-data,managed-settings,memory-replica)
record module-default-build cargo build --locked -p mc-module
record module-live-build cargo build --locked -p mc-module "${live[@]}"
record module-default-test-compile cargo test --locked -p mc-module --no-run
record module-live-test-compile cargo test --locked -p mc-module "${live[@]}" --no-run
record module-default-test cargo test --locked -p mc-module --no-fail-fast
record module-live-test cargo test --locked -p mc-module "${live[@]}" --no-fail-fast

for package in mc-mock-runner mc-tokenizer; do
    record "$package-build" cargo build --locked -p "$package"
    record "$package-test-compile" cargo test --locked -p "$package" --no-run
    record "$package-test" cargo test --locked -p "$package" --no-fail-fast
done

exit "$status"
