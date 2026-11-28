#!/usr/bin/env bash
set -euo pipefail

logs=target/windows-rust-timing
source "$(dirname -- "${BASH_SOURCE[0]}")/rust-windows-home.sh"
mkdir -p "$logs"
log=$logs/nextest.log
{ rustc -vV; cargo nextest --version; } > "$log" 2>&1

start_windows_home x86_64-pc-windows-msvc

command=(cargo nextest run --locked -p mc-module --lib --no-fail-fast --color never
    --show-progress none --status-level pass --final-status-level none --failure-output never)
printf '\n+ %s\n' "${command[*]}" >> "$log"
start=$SECONDS
rc=0
LC_ALL=C timeout --verbose --kill-after=30s 45m "${command[@]}" >> "$log" 2>&1 || rc=$?
elapsed=$((SECONDS - start))
printf 'exit\tseconds\n%s\t%s\n' "$rc" "$elapsed" > "$logs/result.tsv"
windows_home_after_command nextest

# The pinned Nextest streams completed statuses such as `PASS [ 1.002s] mc-module test::name`.
# Skip threshold notices rather than reporting them as measured durations.
LC_ALL=C awk '
    match($0, /^[[:space:]]*(PASS|FAIL|ABORT|LEAK|TIMEOUT|EXECFAIL)[[:space:]]+\[[[:space:]]*[0-9]+(\.[0-9]+)?s\][[:space:]]+/) {
        name = substr($0, RLENGTH + 1)
        sub(/^[^[:space:]]+[[:space:]]+/, "", name)
        sub(/\r$/, "", name)
        seconds = substr($0, 1, RLENGTH)
        sub(/^.*\[[[:space:]]*/, "", seconds)
        sub(/s\].*$/, "", seconds)
        printf "%s\t%s\t%s\n", name, seconds, $1
    }
' "$log" > "$logs/completed.tsv"
{
    printf 'test\tseconds\tstatus\n'
    LC_ALL=C sort -t $'\t' -k2,2nr -k1,1 "$logs/completed.tsv"
} > "$logs/test-times.tsv"
rm -- "$logs/completed.tsv"
printf 'Nextest exit %s in %ss. Slowest completed tests:\n' "$rc" "$elapsed"
head -n 21 "$logs/test-times.tsv"
if (( rc == 0 )) && ! grep -q '^.*[[:space:]]PASS$' "$logs/test-times.tsv"; then
    printf 'Nextest reported success without any parsed passing tests. See %s.\n' "$log" >&2
    rc=125
fi

finish_windows_home "$rc"
