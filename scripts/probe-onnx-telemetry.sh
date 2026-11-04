#!/usr/bin/env bash
# Linux-only offline integration probe. Native DNS/connect are denied before ORT loads.
set -euo pipefail
finished=0
cd "$(dirname "$0")/.."
bun --version
node --version
cc --version
python3 --version
strace --version
scratch=$(mktemp -d)
trap 'status=$?
if [ "$status" -eq 0 ] && [ "${finished:-0}" != 1 ]; then
    printf "%s\n" "$0: exited before successful completion" >&2
    status=1
fi
rm -rf "$scratch" || { cleanup_status=$?; [ "$status" -ne 0 ] || status=$cleanup_status; }
exit "$status"' EXIT
cc -shared -fPIC -I/usr/include/node scripts/fixtures/onnx-telemetry-probe.c -ldl -o "$scratch/guard.so"
cp "$scratch/guard.so" "$scratch/probe.node"
python3 scripts/fixtures/make-onnx-telemetry-model.py "$scratch/model"
bun build scripts/fixtures/onnx-telemetry-load.ts \
    packages/plugin/src/features/magic-context/memory/embedding-worker.ts \
    packages/plugin/src/features/magic-context/memory/embedding-worker-process.ts \
    --outdir "$scratch/dist" --entry-naming '[name].js' --splitting --target node --format esm \
    --external onnxruntime-node --external onnxruntime-web --external sharp --external bun:sqlite --external bun:ffi --external node:sqlite
printf '{"type":"module"}\n' > "$scratch/dist/package.json"
ln -s "$PWD/packages/plugin/node_modules" "$scratch/dist/node_modules"
ln -s "$PWD/packages/plugin/node_modules" "$scratch/node_modules"
if [[ ${ORT_PROBE_COMPILED_HOST:-1} == 1 ]]; then
    bun build --compile scripts/fixtures/onnx-telemetry-compiled-host.ts --outfile "$scratch/compiled-host"
fi

# Read getenv through a native addon; process.env alone cannot prove what ORT sees.
probes=0
controls=0
optouts=0
for runtime in ${ORT_PROBE_RUNTIMES:-bun node}; do
    probes=$((probes + 1))
    mkdir -p "$scratch/env-$runtime/home" "$scratch/env-$runtime/cache"
    env -u ORT_DISABLE_TELEMETRY HOME="$scratch/env-$runtime/home" XDG_CACHE_HOME="$scratch/env-$runtime/cache" \
        PROBE="$scratch/probe.node" "$runtime" -e '
        const p = require(process.env.PROBE);
        console.log("MAIN native before", p.readNativeEnv());
        process.env.ORT_DISABLE_TELEMETRY = "1";
        console.log("MAIN JS", process.env.ORT_DISABLE_TELEMETRY, "native after", p.readNativeEnv());
        delete process.env.ORT_DISABLE_TELEMETRY;
        const {Worker} = require("node:worker_threads");
        const w = new Worker(`const p = require(process.env.PROBE); process.env.ORT_DISABLE_TELEMETRY = "1"; console.log("WORKER JS", process.env.ORT_DISABLE_TELEMETRY, "native after", p.readNativeEnv());`, {eval:true});
        w.on("error", e => { console.error(e); process.exitCode=1; });'
done

for runtime in ${ORT_PROBE_RUNTIMES:-bun node}; do
    for mode in ${ORT_PROBE_MODES:-baseline startup main-env fixed}; do
        root="$scratch/$runtime-$mode"
        mkdir -p "$root/home" "$root/cache"
        args=()
        load_mode="$mode"
        wait_ms=${ORT_PROBE_WAIT_MS:-65000}
        if [[ "$mode" == startup ]]; then args+=(ORT_DISABLE_TELEMETRY=1); load_mode=baseline; fi
        env -u ORT_DISABLE_TELEMETRY -u HTTPS_PROXY -u HTTP_PROXY -u ALL_PROXY -u https_proxy -u http_proxy -u all_proxy \
            HOME="$root/home" XDG_CACHE_HOME="$root/cache" XDG_DATA_HOME="$root/data" XDG_CONFIG_HOME="$root/config" \
            LD_PRELOAD="$scratch/guard.so" ORT_PROBE_WAIT_MS="$wait_ms" "${args[@]}" \
            strace -f -qq -e trace=network -o "$root/network.log" \
            "$runtime" "$scratch/dist/onnx-telemetry-load.js" "$scratch/model" "$load_mode" \
            > "$root/load.log" 2>&1
        printf '\n=== %s %s ===\n' "$runtime" "$mode"
        grep -E 'NATIVE_GETENV|BLOCKED_|LOAD|ld.so' "$root/load.log" || true
        grep -E 'AF_INET|sun_path|socketpair' "$root/network.log" || true
        ids=$(find "$root" -type f -name deviceid | wc -l)
        printf 'DEVICE_ID_FILES=%s\n' "$ids"
        if [[ "$mode" == baseline ]]; then
            grep -q 'BLOCKED_DNS mobile.events.data.microsoft.com' "$root/load.log"
            test "$ids" -eq 1
            controls=$((controls + 1))
            find "$root" -type f -name deviceid -printf 'DEVICE_ID_PATH=%P\n'
            echo 'CONTROL: telemetry upload destination attempted and blocked; device ID created'
        else
            grep -q 'NATIVE_GETENV ORT_DISABLE_TELEMETRY=1' "$root/load.log"
            if grep -q 'BLOCKED_DNS\|BLOCKED_CONNECT' "$root/load.log" ||
                grep -Eq '(connect|sendto|sendmsg)\(.*sa_family=AF_INET' "$root/network.log"; then
                echo 'FAIL: outbound network activity while opted out' >&2
                exit 1
            fi
            test "$ids" -eq 0
            optouts=$((optouts + 1))
            echo 'PASS: native opt-out observed, zero outbound DNS/connect/upload attempts, zero device IDs'
        fi
    done
done

if [[ ${ORT_PROBE_COMPILED_HOST:-1} == 1 ]]; then
    root="$scratch/compiled-bun"
    mkdir -p "$root/home" "$root/cache"
    status=0
    env -u ORT_DISABLE_TELEMETRY HOME="$root/home" XDG_CACHE_HOME="$root/cache" XDG_DATA_HOME="$root/data" XDG_CONFIG_HOME="$root/config" \
        LD_PRELOAD="$scratch/guard.so" ORT_PROBE_WAIT_MS="${ORT_PROBE_WAIT_MS:-65000}" \
        ORT_PROBE_MODEL="$scratch/model" ORT_PROBE_MODE="${ORT_PROBE_COMPILED_MODE:-fixed}" ORT_PROBE_LOAD_ENTRY="$scratch/dist/onnx-telemetry-load.js" \
        strace -f -qq -e trace=network -o "$root/network.log" "$scratch/compiled-host" > "$root/load.log" 2>&1 || status=$?
    echo "=== compiled Bun host ${ORT_PROBE_COMPILED_MODE:-fixed} ==="
    cat "$root/load.log"
    if [[ "$status" != 0 ]]; then exit "$status"; fi
    grep -q 'NATIVE_GETENV ORT_DISABLE_TELEMETRY=1' "$root/load.log"
    if grep -q 'BLOCKED_DNS\|BLOCKED_CONNECT' "$root/load.log" ||
        grep -Eq '(connect|sendto|sendmsg)\(.*sa_family=AF_INET' "$root/network.log"; then
        echo 'FAIL: compiled host attempted outbound network activity' >&2
        exit 1
    fi
    test "$(find "$root" -type f -name deviceid | wc -l)" -eq 0
    optouts=$((optouts + 1))
    echo 'PASS: compiled host native opt-out, zero outbound attempts, zero device IDs'
fi
echo "Integration summary: $probes native-env probes, $controls positive telemetry controls, $optouts opted-out real loads passed"
finished=1
