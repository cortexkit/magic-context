#!/usr/bin/env bash
# Offline Linux cost and failure probes; the trained model is downloaded locally before this script.
set -euo pipefail
finished=0
cd "$(dirname "$0")/.."
bun --version
node --version
scratch=$(mktemp -d)
trap 'status=$?
if [ "$status" -eq 0 ] && [ "${finished:-0}" != 1 ]; then
    printf "%s\n" "$0: exited before successful completion" >&2
    status=1
fi
rm -rf "$scratch" || { cleanup_status=$?; [ "$status" -ne 0 ] || status=$cleanup_status; }
exit "$status"' EXIT
bun build scripts/fixtures/embedding-transport-probe.ts \
    packages/plugin/src/features/magic-context/memory/embedding-worker.ts \
    packages/plugin/src/features/magic-context/memory/embedding-worker-process.ts \
    packages/plugin/src/features/magic-context/memory/embedding-worker.fixture.ts \
    --outdir "$scratch/dist" --entry-naming '[name].js' --splitting --target node --format esm \
    --external onnxruntime-node --external onnxruntime-web --external sharp --external bun:ffi --external bun:sqlite --external node:sqlite
printf '{"type":"module"}\n' > "$scratch/dist/package.json"
ln -s "$PWD/packages/plugin/node_modules" "$scratch/dist/node_modules"
report=${ORT_TRANSPORT_REPORT:-"$scratch/report.jsonl"}
: > "$report"
native_model=()
if [[ -f .issue672-assets/model/onnx/model.onnx ]]; then native_model=(real "$PWD/.issue672-assets/model"); fi
for runtime in bun node; do
    root="$scratch/lifecycle-$runtime"
    mkdir -p "$root/home" "$root/cache" "$root/tmp"
    env HOME="$root/home" XDG_CACHE_HOME="$root/cache" TMPDIR="$root/tmp" XDG_DATA_HOME="$root/data" XDG_CONFIG_HOME="$root/config" \
        ORT_DISABLE_TELEMETRY=1 "$runtime" "$scratch/dist/embedding-transport-probe.js" lifecycle "${native_model[@]}"
    if [[ ${ORT_TRANSPORT_BENCH:-1} == 1 ]]; then
        for mode in old new; do
            root="$scratch/bench-$runtime-$mode"
            mkdir -p "$root/home" "$root/cache" "$root/tmp"
            env HOME="$root/home" XDG_CACHE_HOME="$root/cache" TMPDIR="$root/tmp" XDG_DATA_HOME="$root/data" XDG_CONFIG_HOME="$root/config" \
                ORT_DISABLE_TELEMETRY=1 "$runtime" "$scratch/dist/embedding-transport-probe.js" bench "$mode" "$PWD/.issue672-assets/model" \
                >> "$report" 2> "$root/stderr.log"
        done
    fi
done
if [[ ${ORT_TRANSPORT_BENCH:-1} == 1 ]]; then
    node -e 'const rows=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse); for(const row of rows){ const {samplesMs,...summary}=row; console.log(JSON.stringify(summary));} console.log(`Benchmark summary: ${rows.length} scenarios, ${rows.reduce((n,r)=>n+r.batches,0)} batches`);' "$report"
fi
finished=1
