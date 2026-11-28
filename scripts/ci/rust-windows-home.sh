#!/usr/bin/env bash
# Source from a Windows diagnostic runner after setting its artifact directory.
set -euo pipefail

finished=0
home=
cleanup() {
    local status=$?
    local cleanup_status=0 audit=0 first_rm=not-run fallback=not-needed
    if [ "$status" -eq 0 ] && [ "${finished:-0}" != 1 ]; then
        printf '%s\n' "$0: exited before successful completion" >&2
        status=1
    fi
    if [ -n "$home" ]; then
        inventory_to before-cleanup "$logs/home-before-cleanup.tsv" || true
        native_cleanup inspect > "$logs/native-before-cleanup.log" 2>&1 || audit=$?
        if [ "$audit" -ne 0 ]; then
            printf 'Windows home audit failed (exit %s); leaving the disposable home intact.\n' "$audit" >&2
            cat "$logs/native-before-cleanup.log" >&2
            cleanup_status=$audit
        else
            first_rm=0
            rm -rf -- "$home" > "$logs/cleanup-rm.log" 2>&1 || first_rm=$?
            cleanup_status=$first_rm
            if [ "$first_rm" -ne 0 ]; then
                cat "$logs/cleanup-rm.log" >&2
                inventory_to after-failed-cleanup "$logs/home-after-failed-cleanup.tsv" || true
                fallback=0
                native_cleanup remove-system-profile > "$logs/native-cleanup-fallback.log" 2>&1 || fallback=$?
                if [ "$fallback" -eq 0 ]; then
                    cat "$logs/native-cleanup-fallback.log"
                    cleanup_status=0
                    rm -rf -- "$home" > "$logs/cleanup-retry.log" 2>&1 || cleanup_status=$?
                    if [ "$cleanup_status" -ne 0 ]; then cat "$logs/cleanup-retry.log" >&2; fi
                else
                    cat "$logs/native-cleanup-fallback.log" >&2
                fi
            fi
        fi
        printf 'native_audit_exit\tinitial_rm_exit\tnative_fallback_exit\tcleanup_exit\n%s\t%s\t%s\t%s\n' \
            "$audit" "$first_rm" "$fallback" "$cleanup_status" > "$logs/cleanup-result.tsv"
        if [ "$cleanup_status" -ne 0 ]; then
            [ "$status" -ne 0 ] || status=$cleanup_status
        fi
    fi
    exit "$status"
}
trap cleanup EXIT

inventory_to() {
    local label=$1 output=$2 rc=0
    native_cleanup inventory 10s > "$output" 2> "$logs/home-inventory-stderr.log" || rc=$?
    if [ "$rc" -ne 0 ]; then
        printf 'Could not read home inventory at %s (exit %s).\n' "$label" "$rc" >&2
        {
            printf '\n--- %s (exit %s) ---\n' "$label" "$rc"
            cat "$logs/home-inventory-stderr.log"
        } >> "$logs/home-inventory-errors.log"
        cat "$logs/home-inventory-stderr.log" >&2
        return "$rc"
    fi
}

cache_presence() {
    # The native listing could itself affect the profile. Check this exact
    # directory with Bash before and after each listing to distinguish it.
    local stage=$1 label=$2 present=no
    if [[ -d "$home/AppData/Local/Microsoft/Windows/INetCache" ]]; then present=yes; fi
    printf '%s\t%s\t%s\n' "$stage" "$label" "$present" >> "$logs/inetcache-presence.tsv"
}

home_changes() {
    local label=$1 rc=0
    if inventory_to "$label" "$logs/home-current.tsv"; then
        diff -u --label previous --label "$label" "$logs/home-previous.tsv" "$logs/home-current.tsv" \
            >> "$logs/home-changes.diff" || rc=$?
        if [ "$rc" -gt 1 ]; then
            printf 'Could not compare home inventory after %s (exit %s).\n' "$label" "$rc" >&2
        fi
        mv -f -- "$logs/home-current.tsv" "$logs/home-previous.tsv" ||
            printf 'Could not save home inventory after %s.\n' "$label" >&2
    fi
}

native_cleanup() {
    # This diagnostic may fail independently of the test and cleanup outcomes.
    LC_ALL=C timeout --verbose --kill-after=5s "${2:-30s}" powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass \
        -File "$(cygpath -am scripts/ci/rust-windows-cleanup.ps1)" \
        -Mode "$1" -StartedAt "$run_started" -Workspace "$(cygpath -am "$PWD")" \
        -ScratchHome "$(cygpath -am "$home")"
}

windows_home_after_command() {
    cache_presence after-command "$1"
    home_changes "$1"
    cache_presence after-inventory "$1"
}

start_windows_home() {
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
    printf 'phase\tcommand\tinetcache_directory_present\n' > "$logs/inetcache-presence.tsv"
    cache_presence before-inventory home-setup
    inventory_to home-setup "$logs/home-previous.tsv" || true
    cache_presence after-inventory home-setup
    cp -- "$logs/home-previous.tsv" "$logs/home-at-start.tsv"
    printf '%s\n' '# Home path, bytes, attributes and mtime; each diff is labeled by the preceding command.' > "$logs/home-changes.diff"
}

finish_windows_home() {
    finished=1
    exit "$1"
}
