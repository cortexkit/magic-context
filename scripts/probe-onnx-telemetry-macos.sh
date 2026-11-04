#!/usr/bin/env bash
# Real local macOS native loads. Interposition observes getenv; Seatbelt prevents outbound traffic.
set -euo pipefail
finished=0
cd "$(dirname "$0")/.."
uname -a
bun --version
node --version
cc --version
scratch=$(mktemp -d)
trap 'status=$?
if [ "$status" -eq 0 ] && [ "${finished:-0}" != 1 ]; then
    printf "%s\n" "$0: exited before successful completion" >&2
    status=1
fi
rm -rf "$scratch" || { cleanup_status=$?; [ "$status" -ne 0 ] || status=$cleanup_status; }
exit "$status"' EXIT
cc -dynamiclib scripts/fixtures/onnx-telemetry-macos-probe.c -o "$scratch/guard.dylib"
python3 scripts/fixtures/make-onnx-telemetry-model.py "$scratch/model"
bun build scripts/fixtures/onnx-telemetry-load.ts \
    packages/plugin/src/features/magic-context/memory/embedding-worker.ts \
    packages/plugin/src/features/magic-context/memory/embedding-worker-process.ts \
    --outdir "$scratch/dist" --entry-naming '[name].js' --splitting --target node --format esm \
    --external onnxruntime-node --external onnxruntime-web --external sharp --external bun:sqlite --external bun:ffi --external node:sqlite
printf '{"type":"module"}\n' > "$scratch/dist/package.json"
ln -s "$PWD/packages/plugin/node_modules" "$scratch/dist/node_modules"
ln -s "$PWD/packages/plugin/node_modules" "$scratch/node_modules"
bun build --compile scripts/fixtures/onnx-telemetry-compiled-host.ts --outfile "$scratch/compiled-host"
# Protect the real home from writes even if a dependency ignores the provided HOME.
profile="(version 1)(allow default)(deny network-outbound)(deny file-write* (subpath \"$HOME\"))"
/usr/bin/sandbox-exec -p "$profile" /usr/bin/true
for case in ${ORT_PROBE_CASES:-bun-baseline bun-fixed node-fixed}; do
    runtime=${case%%-*}
    mode=${case#*-}
    executable=$(command -v "$runtime" || true)
    if [[ "$runtime" == compiled ]]; then runtime=bun; executable="$scratch/compiled-host"; fi
    root="$scratch/$case"
    mkdir -p "$root/home" "$root/cache" "$root/tmp"
    # sandbox-exec is SIP-protected, so set dyld variables using an unprotected runtime after entry.
    status=0
    env -u ORT_DISABLE_TELEMETRY HOME="$root/home" XDG_CACHE_HOME="$root/cache" TMPDIR="$root/tmp" \
        XDG_DATA_HOME="$root/data" XDG_CONFIG_HOME="$root/config" ORT_PROBE_ENTRY="$scratch/dist/onnx-telemetry-load.js" \
        ORT_PROBE_MODEL="$scratch/model" ORT_PROBE_MODE="$mode" ORT_PROBE_GUARD="$scratch/guard.dylib" \
        ORT_PROBE_EXECUTABLE="$executable" ORT_PROBE_LOAD_ENTRY="$scratch/dist/onnx-telemetry-load.js" \
        ORT_PROBE_SCAN_ROOT="$root" ORT_PROBE_WAIT_MS="${ORT_PROBE_WAIT_MS:-65000}" \
        /usr/bin/sandbox-exec -p "$profile" "$(command -v "$runtime")" -e '
        const {spawnSync}=require("node:child_process");
        const r=spawnSync(process.env.ORT_PROBE_EXECUTABLE,[process.env.ORT_PROBE_ENTRY,process.env.ORT_PROBE_MODEL,process.env.ORT_PROBE_MODE],{
            env:{...process.env,DYLD_INSERT_LIBRARIES:process.env.ORT_PROBE_GUARD},stdio:"inherit"});
        process.exit(r.status ?? 1);' \
        > "$root/load.log" 2>&1 || status=$?
    echo "=== $case ==="
    cat "$root/load.log"
    if [[ "$status" != 0 ]]; then exit "$status"; fi
    if [[ "$mode" == baseline ]]; then
        grep -q '"phase":"after-load","count":1' "$root/load.log"
        grep -q '"phase":"after-wait","count":1' "$root/load.log"
        echo 'CONTROL: macOS native telemetry created its device ID'
    else
        grep -q 'NATIVE_GETENV.*ORT_DISABLE_TELEMETRY=1' "$root/load.log"
        grep -q '"phase":"after-load","count":0' "$root/load.log"
        grep -q '"phase":"after-wait","count":0' "$root/load.log"
        if grep -q 'BLOCKED_DNS\|BLOCKED_CONNECT' "$root/load.log"; then exit 1; fi
        echo "PASS: native getenv=1, inference, no device ID at load or ${ORT_PROBE_WAIT_MS:-65000} ms, no outbound attempts"
    fi
done
echo 'macOS selected native-load cases passed'
finished=1
