#!/usr/bin/env bash
# Build the WebAssembly module next to its JavaScript loader, then run every
# test vector through it from Node. Needs the wasm32-unknown-unknown target.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
cd "$root"
cargo build --locked --release --target wasm32-unknown-unknown -p cortexkit-compaction-view-wasm
cp "$root/target/wasm32-unknown-unknown/release/cortexkit_compaction_view_wasm.wasm" \
	"$here/js/compaction_view.wasm"
node --test "$here/js/vectors.test.mjs"
