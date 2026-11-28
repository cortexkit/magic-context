#!/usr/bin/env bash
set -euo pipefail

finished=0
home=
cleanup() {
    local status=$?
    local cleanup_status=0 first_rm=0 fallback=not-needed
    if [ "$status" -eq 0 ] && [ "${finished:-0}" != 1 ]; then
        printf '%s\n' "$0: exited before successful completion" >&2
        status=1
    fi
    if [ -n "$home" ]; then
        home_inventory > "$logs/home-before-cleanup.tsv" || true
        native_cleanup inspect > "$logs/native-before-cleanup.log" 2>&1 ||
            printf '%s\n' 'Failed to collect native Windows cleanup evidence.' >&2
        rm -rf -- "$home" > "$logs/cleanup-rm.log" 2>&1 || first_rm=$?
        cleanup_status=$first_rm
        if [ "$first_rm" -ne 0 ]; then
            cat "$logs/cleanup-rm.log" >&2
            home_inventory > "$logs/home-after-failed-cleanup.tsv" || true
            fallback=0
            native_cleanup remove-system-profile > "$logs/native-cleanup-fallback.log" 2>&1 || fallback=$?
            if [ "$fallback" -eq 0 ]; then
                cleanup_status=0
                rm -rf -- "$home" >> "$logs/cleanup-rm.log" 2>&1 || cleanup_status=$?
                cat "$logs/native-cleanup-fallback.log"
            else
                cat "$logs/native-cleanup-fallback.log" >&2
            fi
        fi
        printf 'initial_rm_exit\tnative_fallback_exit\tcleanup_exit\n%s\t%s\t%s\n' \
            "$first_rm" "$fallback" "$cleanup_status" > "$logs/cleanup-result.tsv"
        if [ "$cleanup_status" -ne 0 ]; then
            cat "$logs/cleanup-rm.log" >&2
            [ "$status" -ne 0 ] || status=$cleanup_status
        fi
    fi
    exit "$status"
}
trap cleanup EXIT

logs=target/windows-rust-logs
mkdir -p "$logs"
printf 'command\texit\tseconds\toutcome\n' > "$logs/results.tsv"
status=0

home_inventory() {
    # Include the native AppData tree under USERPROFILE, not just $LOCALAPPDATA.
    # Do not follow links out of the disposable home or read file contents.
    LC_ALL=C find -P "$home" -mindepth 1 -maxdepth 8 -printf '%P\t%y\t%s\t%T@\n' \
        2>> "$logs/home-inventory-errors.log" | LC_ALL=C sort
}

home_changes() {
    local label=$1 rc=0
    if home_inventory > "$logs/home-current.tsv"; then
        diff -u --label previous --label "$label" "$logs/home-previous.tsv" "$logs/home-current.tsv" \
            >> "$logs/home-changes.diff" || rc=$?
        if [ "$rc" -gt 1 ]; then
            printf 'Could not compare home inventory after %s (exit %s).\n' "$label" "$rc" >&2
        fi
        mv -f -- "$logs/home-current.tsv" "$logs/home-previous.tsv" ||
            printf 'Could not save home inventory after %s.\n' "$label" >&2
    else
        printf 'Could not read home inventory after %s.\n' "$label" >&2
    fi
}

native_cleanup() {
    # This diagnostic may fail independently of the test and cleanup outcomes.
    bounded 30s powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass \
        -File "$(cygpath -am scripts/ci/rust-windows-cleanup.ps1)" \
        -Mode "$1" -StartedAt "$run_started" -Workspace "$(cygpath -am "$PWD")" \
        -ScratchHome "$(cygpath -am "$home")"
}

record() {
    local label=$1 output start rc outcome
    shift
    output=$logs/$label.log
    start=$SECONDS
    printf '+ %s\n' "$*" > "$output"
    rc=0
    "$@" >> "$output" 2>&1 || rc=$?
    if [[ $label == probe-* && $rc == 0 ]] && ! grep -Eq '^running 1 test[[:space:]]*$' "$output"; then
        printf 'Expected exactly one test for %s.\n' "$label" >> "$output"
        rc=125
    fi
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
    if [ -n "$home" ]; then home_changes "$label"; fi
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

probe() {
    local label=$1 limit=$2 test=$3
    shift 3
    record "probe-$label" bounded "$limit" cargo test --locked -p mc-module --lib "$test" -- --exact --nocapture "$@"
}

test_module_binary() {
    local label=$1 limit=$2 selection=$3 mode
    shift 3
    for mode in default live; do
        local features=()
        if [[ $mode == live ]]; then features=("${live[@]}"); fi
        record "module-$mode-test-$label" bounded "$limit" cargo test --locked -p mc-module \
            "${features[@]}" "$selection" "$@" --no-fail-fast -- --nocapture
    done
}

record toolchain toolchain
if (( status != 0 )); then exit "$status"; fi
record fixture-eol bounded 2m git ls-files --eol -- \
    crates/mc-module/testdata/mc-app-read-samples-v5/SHA256SUMS \
    crates/mc-module/testdata/role-lease-v1.5/ \
    crates/mc-module/assets/catalog_tools_only.txt

# Keep the installed toolchain and Cargo cache, but give the binaries only
# disposable data and config directories (including Windows fallbacks).
export CARGO_HOME=${CARGO_HOME:-$USERPROFILE/.cargo}
export RUSTUP_HOME=${RUSTUP_HOME:-$USERPROFILE/.rustup}
run_started=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
home=$(mktemp -d "$(cygpath -u "$RUNNER_TEMP")/mc-windows.XXXXXX")
HOME=$(cygpath -am "$home")
export HOME
export USERPROFILE=$HOME
export XDG_DATA_HOME=$HOME/data XDG_CONFIG_HOME=$HOME/config
export LOCALAPPDATA=$HOME/local APPDATA=$HOME/roaming
mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$LOCALAPPDATA" "$APPDATA"
home_inventory > "$logs/home-previous.tsv" || true
cp -- "$logs/home-previous.tsv" "$logs/home-at-start.tsv"
printf '%s\n' '# Home path, type, bytes and mtime; each diff is labeled by the preceding command.' > "$logs/home-changes.diff"

live=(--features "agent-data,managed-settings,memory-replica")
record module-default-build bounded 18m cargo build --locked -p mc-module
record module-live-build bounded 18m cargo build --locked -p mc-module "${live[@]}"
record module-default-test-compile bounded 20m cargo test --locked -p mc-module --no-run
record module-live-test-compile bounded 20m cargo test --locked -p mc-module "${live[@]}" --no-run

probe sqlite-create 5m context_db::creation_probe::fresh_store_creation_timing --ignored
probe sqlite-commit 3m store::commit_probe::production_store_commit_timing --ignored
probe crash-resume 5m move_in::tests::crash_resume_at_every_transaction_boundary
probe child-workdir 3m child_scopes::tests::a_relative_folder_or_no_daemon_is_refused_by_name
probe lab-frozen-path 3m dreamer::lab::tests::spec_refuses_live_path_hardlink_and_checkout_escape
probe legacy-dir-key 3m legacy_projects::key::tests::a_folder_outside_any_checkout_keeps_the_plugins_directory_key
probe app-read-pin 3m app_read::tests::samples_v5_remain_pinned
probe catalog-pin 3m catalog::tests::text_revision_is_the_one_config_json_records
probe lease-pin 3m dreamer::lease::tests::the_copied_samples_match_their_published_digests
probe git-export 3m dreamer::branches::tests::a_copy_holds_one_commit_reads_its_history_up_to_there_and_is_deleted_when_dropped
probe lab-git 3m dreamer::lab::git::review_tests::lab_git_allows_five_commands_without_running_textconv
probe project-publication 3m context_db::tests::a_publish_records_the_sessions_project_only_when_it_has_one
probe primer-publication 3m context_db::tests::a_runs_events_and_primer_candidate_land_with_its_summaries

# Run the same test targets as cargo test, but let the next executable start
# even if one times out. Collect results for both feature sets before moving
# to the next target.
test_module_binary lib 45m --lib
test_module_binary bin 3m --bin ck-mc
for test_file in crates/mc-module/tests/*.rs; do
    test_name=${test_file##*/}
    test_name=${test_name%.rs}
    limit=5m
    if [[ $test_name == scenarios ]]; then
        # The long-head test alone took 335s on Windows x64. Allow for the
        # other scenarios running alongside it and for slower ARM64 runners.
        limit=10m
    fi
    test_module_binary "integration-$test_name" "$limit" --test "$test_name"
done
test_module_binary doc 5m --doc

for package in mc-mock-runner mc-tokenizer; do
    record "$package-build" bounded 8m cargo build --locked -p "$package"
    record "$package-test-compile" bounded 4m cargo test --locked -p "$package" --no-run
    record "$package-test" bounded 5m cargo test --locked -p "$package" --no-fail-fast
done

finished=1
exit "$status"
