#!/usr/bin/env bash
# Compare clean package file lists against the pre-subprocess commit, without changing any branch.
set -euo pipefail
finished=0
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
scratch=$(mktemp -d "$root/.issue672-pack.XXXXXX")
trap 'status=$?
if [ "$status" -eq 0 ] && [ "${finished:-0}" != 1 ]; then
    printf "%s\n" "$0: exited before successful completion" >&2
    status=1
fi
rm -rf "$scratch" || { cleanup_status=$?; [ "$status" -ne 0 ] || status=$cleanup_status; }
exit "$status"' EXIT
mkdir -p "$scratch/base" "$scratch/new" "$scratch/home" "$scratch/cache"
git archive e75dcf1a1daf47e49c01364db6f1866bf792e0d3 | tar -x -C "$scratch/base"
git archive HEAD | tar -x -C "$scratch/new"
# Overlay current transport source so the comparison also covers uncommitted edits.
for path in packages/plugin/package.json packages/pi-plugin/package.json packages/plugin/src/features/magic-context/memory/embedding-worker-client.ts packages/plugin/src/features/magic-context/memory/embedding-worker.fixture.ts packages/plugin/src/features/magic-context/memory/onnx-telemetry.ts; do
    cp "$root/$path" "$scratch/new/$path"
done
for revision in base new; do
    for package in plugin pi-plugin retina-local-fs cli; do
        ln -s "$root/packages/$package/node_modules" "$scratch/$revision/packages/$package/node_modules"
    done
    ln -s "$root/node_modules" "$scratch/$revision/node_modules"
    if ! bun run --cwd "$scratch/$revision/packages/plugin" build > "$scratch/$revision-plugin-build.log" 2>&1; then
        cat "$scratch/$revision-plugin-build.log"; exit 1
    fi
    if ! bun run --cwd "$scratch/$revision/packages/pi-plugin" build > "$scratch/$revision-pi-build.log" 2>&1; then
        cat "$scratch/$revision-pi-build.log"; exit 1
    fi
    for package in plugin pi-plugin; do
        (cd "$scratch/$revision/packages/$package" && HOME="$scratch/home" npm_config_cache="$scratch/cache" \
            npm pack --dry-run --json) > "$scratch/$revision-$package.json"
    done
done
npm --version
REPORT_DIR="${ORT_PACK_REPORT_DIR:-$scratch}" node - "$scratch" <<'JS'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
for (const pkg of ['plugin', 'pi-plugin']) {
    const base = JSON.parse(fs.readFileSync(path.join(root, `base-${pkg}.json`)))[0];
    const next = JSON.parse(fs.readFileSync(path.join(root, `new-${pkg}.json`)))[0];
    const oldPaths = new Set(base.files.map(f => f.path));
    const newPaths = new Set(next.files.map(f => f.path));
    const added = [...newPaths].filter(p => !oldPaths.has(p));
    const removed = [...oldPaths].filter(p => !newPaths.has(p));
    // Splitting names include content hashes; compare entry names separately from changed chunks.
    const normalized = p => p.replace(/-[a-z0-9]{8}\.js$/, '-HASH.js');
    const normalizedOld = new Set([...oldPaths].map(normalized));
    const normalizedNew = new Set([...newPaths].map(normalized));
    const semanticAdded = [...normalizedNew].filter(p => !normalizedOld.has(p));
    const semanticRemoved = [...normalizedOld].filter(p => !normalizedNew.has(p));
    const entries = pkg === 'plugin'
        ? ['dist/embedding-worker-process.js', 'dist/v2/embedding-worker-process.js']
        : ['dist/embedding-worker-process.js'];
    for (const entry of entries) if (!newPaths.has(entry)) throw new Error(`packed subprocess entry missing: ${pkg}/${entry}`);
    const report = { package: next.name, baseFiles: base.files.length, newFiles: next.files.length,
        entries, semanticAdded, semanticRemoved, added, removed };
    fs.writeFileSync(path.join(process.env.REPORT_DIR, `issue-672-pack-${pkg}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, added: `${added.length} paths (see JSON report)`, removed: `${removed.length} paths (see JSON report)` }));
}
console.log('Packed file-list summary: 4 npm pack --dry-run calls, 3 subprocess entries present');
JS
finished=1
