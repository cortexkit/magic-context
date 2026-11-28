#!/usr/bin/env bash
set -euo pipefail

logs=target/windows-rust-long-head
source "$(dirname -- "${BASH_SOURCE[0]}")/rust-windows-home.sh"
mkdir -p "$logs"
printf 'command\texit\tseconds\n' > "$logs/results.tsv"

start_windows_home x86_64-pc-windows-msvc

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
    windows_home_after_command "$label"
    return "$rc"
}

command=(cargo test --locked -p mc-module --features context-db-timing --test scenarios)
record compile 18m "${command[@]}" --no-run
export MC_LONG_HEAD_TIMING=1
status=0
record scenario 12m "${command[@]}" a_long_head_session_keeps_ck_mcs_index_window_sized \
    -- --exact --nocapture || status=$?

finish_windows_home "$status"
