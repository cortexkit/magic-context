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

logs=target/windows-rust-long-head
mkdir -p "$logs"
printf 'command\texit\tseconds\n' > "$logs/results.tsv"

export CARGO_HOME=${CARGO_HOME:-$USERPROFILE/.cargo}
export RUSTUP_HOME=${RUSTUP_HOME:-$USERPROFILE/.rustup}
home=$(mktemp -d "$(cygpath -u "$RUNNER_TEMP")/mc-windows-long-head.XXXXXX")
HOME=$(cygpath -am "$home")
export HOME
export USERPROFILE=$HOME
export XDG_DATA_HOME=$HOME/data XDG_CONFIG_HOME=$HOME/config
export LOCALAPPDATA=$HOME/local APPDATA=$HOME/roaming
mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$LOCALAPPDATA" "$APPDATA"

record() {
    local label=$1 limit=$2 start rc=0
    shift 2
    start=$SECONDS
    printf '+ %s\n' "$*" > "$logs/$label.log"
    LC_ALL=C timeout --verbose --kill-after=30s "$limit" "$@" >> "$logs/$label.log" 2>&1 || rc=$?
    if [[ $label == scenario && $rc == 0 ]] && ! grep -q 'long-head elapsed_ms=.*assertions done; scratch cleanup attempted' "$logs/$label.log"; then
        printf 'The exact test did not reach its final phase. See %s/%s.log.\n' "$logs" "$label" >&2
        rc=125
    fi
    printf '%s\t%s\t%s\n' "$label" "$rc" "$((SECONDS-start))" >> "$logs/results.tsv"
    printf '%s: exit %s in %ss (%s/%s.log)\n' "$label" "$rc" "$((SECONDS-start))" "$logs" "$label"
    return "$rc"
}

command=(cargo test --locked -p mc-module --features context-db-timing --test scenarios)
record compile 18m "${command[@]}" --no-run
export MC_LONG_HEAD_TIMING=1
status=0
record scenario 12m "${command[@]}" a_long_head_session_keeps_ck_mcs_index_window_sized \
    -- --exact --nocapture || status=$?

finished=1
exit "$status"
