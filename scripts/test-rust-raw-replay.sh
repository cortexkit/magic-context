#!/usr/bin/env bash
# Offline host/module/provider-byte regressions; no daemon or live store is used.
set -euo pipefail
finished=0
cd "$(dirname "$0")/.."
if [[ ${MC_RAW_REPLAY_REQUIRED:-0} == 1 && -z ${MC_RAW_REPLAY_BASELINE_ARCHIVE:-} ]]; then
    echo "Required MC_RAW_REPLAY_BASELINE_ARCHIVE (pinned released baseline sources) is missing" >&2
    exit 1
fi
scratch=$(mktemp -d)
trap 'status=$?
if [ "$status" -eq 0 ] && [ "${finished:-0}" != 1 ]; then
    printf "%s\n" "$0: exited before successful completion" >&2
    status=1
fi
rm -rf "$scratch" || { cleanup_status=$?; [ "$status" -ne 0 ] || status=$cleanup_status; }
exit "$status"' EXIT

if [[ -n ${MC_RAW_REPLAY_BASELINE_ARCHIVE:-} ]]; then
    mkdir "$scratch/base"
    tar -xf "$MC_RAW_REPLAY_BASELINE_ARCHIVE" -C "$scratch/base"
    ln -s "$PWD/node_modules" "$scratch/base/node_modules"
    ln -s "$PWD/packages/plugin/node_modules" "$scratch/base/packages/plugin/node_modules"
    # Keep the release's transform, included helper files and types together:
    # copying only transform.rs into the current checkout mixes incompatible private APIs.
    # Add the offline example driver, but leave all release library sources intact.
    cp scripts/rust-raw-replay-baseline.rs "$scratch/base/crates/mc-module/examples/transform_replay.rs"
    baseline_build=(cargo build --locked --manifest-path "$scratch/base/Cargo.toml"
        --target-dir "$scratch/baseline-target" -p mc-module --example transform_replay)
    if [[ ${MC_RAW_REPLAY_BASELINE_RELEASE:-0} == 1 ]]; then
        "${baseline_build[@]}" --release
        baseline_probe="$scratch/baseline-target/release/examples/transform_replay"
    else
        "${baseline_build[@]}"
        baseline_probe="$scratch/baseline-target/debug/examples/transform_replay"
    fi
    cp "$baseline_probe" "$scratch/baseline-probe"
    export MC_RAW_REPLAY_BASELINE="$scratch/baseline-probe"
    export MC_RAW_REPLAY_BASELINE_ADAPTER="$scratch/base/packages/plugin/src/hooks/magic-context/rust-mode-transform.ts"
    export MC_REVIEW_BASELINE_ROOT="$scratch/base"
else
    echo "Master differential skipped: set MC_RAW_REPLAY_BASELINE_ARCHIVE to an offline git archive of the baseline sources."
fi

if [[ -n ${MC_RAW_REPLAY_PROBE:-} ]]; then
    if [[ ! -x "$MC_RAW_REPLAY_PROBE" ]]; then
        echo "Required staged MC_RAW_REPLAY_PROBE is not executable: $MC_RAW_REPLAY_PROBE" >&2
        exit 1
    fi
    printf 'Using staged Rust raw replay driver: %s\n' "$MC_RAW_REPLAY_PROBE"
else
    cargo build -p mc-module --example transform_replay
    # Stage executables outside target, including on removable storage.
    cp "${CARGO_TARGET_DIR:-target}/debug/examples/transform_replay" "$scratch/current-probe"
    export MC_RAW_REPLAY_PROBE="$scratch/current-probe"
fi
bun --version
cargo --version
rustc --version
BUN_JSC_useOMGJIT=0 bun test --timeout 120000 \
    packages/plugin/src/hooks/magic-context/rust-mode*.test.ts \
    packages/plugin/src/hooks/magic-context/rust-served-raw.test.ts \
    packages/plugin/src/plugin/messages-transform.test.ts \
    packages/plugin/src/features/magic-context/transform-decision-log.test.ts \
    packages/plugin/scripts/cache-bust-scheduler-log.test.ts \
    packages/plugin/scripts/cache-bust-sentinel.test.ts "$@"
finished=1
