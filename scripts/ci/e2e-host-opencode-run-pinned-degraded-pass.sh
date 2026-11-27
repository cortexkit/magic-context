#!/usr/bin/env bash
set -euo pipefail

mkdir -p "${TMPDIR:-/tmp}/magic-context"
scratch=$(mktemp -d "${TMPDIR:-/tmp}/magic-context/oc1-degraded-XXXXXXXX")
dist="$PWD/packages/plugin/dist/index.js"
saved="$dist.degraded-$$"
finished=false
child=
cleanup() {
    local status=$?
    trap - EXIT
    if [[ "$finished" != true ]]; then
        printf 'Pinned degraded-pass step did not finish (exit %s); restoring the plugin entry\n' "$status" >&2
    fi
    if [[ -n "$child" ]]; then
        kill -TERM "$child" 2>/dev/null || true
        wait "$child" 2>/dev/null || true
    fi
    if [[ -f "$saved" ]] && ! mv -- "$saved" "$dist"; then
        printf 'Could not restore plugin entry from %s\n' "$saved" >&2
        if (( status == 0 )); then status=1; fi
    fi
    rm -rf -- "$scratch" || { if (( status == 0 )); then status=1; fi; }
    exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

export TMPDIR="$scratch/magic-context/degraded-pass/magic-context/degraded-residuals-full"
export HOME="$scratch/home" XDG_DATA_HOME="$scratch/data" XDG_CONFIG_HOME="$scratch/config"
export XDG_STATE_HOME="$scratch/state" XDG_RUNTIME_DIR="$scratch/runtime" XDG_CACHE_HOME="$scratch/cache"
export OPENCODE_DB="$XDG_DATA_HOME/opencode/opencode.db" MAGIC_CONTEXT_STORAGE_DIR="$scratch/context"
export MC_DEGRADED_RESIDUALS_HOST=1
mkdir -p "$TMPDIR" "$HOME" "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_STATE_HOME" "$XDG_RUNTIME_DIR" "$XDG_CACHE_HOME" "$MAGIC_CONTEXT_STORAGE_DIR"
OPENCODE_VERSION=1.18.30 bash tests/docker/install-opencode.sh
export PATH="$HOME/.opencode/bin:$PATH"
bash scripts/ci/e2e-host-opencode-verify-opencode-on-path.sh

# The writer-lock probe matches source stack frames, not bundled names.
mv -- "$dist" "$saved"
cd packages/e2e-tests
bun test --timeout 600000 tests/degraded-pass-lock.test.ts &
child=$!
status=0
wait "$child" || status=$?
child=
finished=true
exit "$status"
