#!/usr/bin/env bash
# Reproduction runner for issue 995 (see issue-995-embedding-shutdown.ts for the
# modes). Manual, not CI: it downloads Node 26.13.1 and the MiniLM model, so it
# needs network access, and it runs on Linux x64.
#
# Run from the repository root on a Linux x64 machine with network access (on the
# project's build server: a remote job with 4 vCPUs and network), for example:
#   bash packages/e2e-tests/scripts/issue-995-embedding-shutdown.sh 20 pi-shutdown retire exit
# Arguments: <runs per mode> [modes...] (default modes: measure pi-shutdown retire exit)
# Environment:
#   ISSUE_995_REF=<commit>   build that commit instead of the current checkout
#                            (the driver is always taken from the current checkout)
#   ISSUE_995_RUNTIMES="node bun"   which runtimes to run
#
# Everything it writes (Node, model, Magic Context storage, XDG directories, the
# OpenCode database path, the project) is under $TMPDIR/magic-context/issue-995/,
# removed at the start of each run; no live store or configuration is opened.
# Core dumps are disabled. Each line reports the child's exit code and
# napi_lines, the number of stderr lines that mention the native binding's
# 'terminate called' / Napi::Error abort; exit 134 with napi_lines=1 is the
# abort from the issue.
set -euo pipefail
runs=${1:-20}
shift || true
modes=("$@")
[[ ${#modes[@]} -gt 0 ]] || modes=(measure pi-shutdown retire exit)
read -r -a runtimes <<< "${ISSUE_995_RUNTIMES:-node bun}"
repo=$PWD
export TMPDIR=${TMPDIR:-/tmp}
root="$TMPDIR/magic-context/issue-995"
rm -rf "$root"
mkdir -p "$root"
ulimit -c 0

echo "== tools"
bun --version
bun install --frozen-lockfile >/dev/null
curl -fsSL https://nodejs.org/dist/v26.13.1/node-v26.13.1-linux-x64.tar.xz -o "$root/node.tar.xz"
curl -fsSL https://nodejs.org/dist/v26.13.1/SHASUMS256.txt -o "$root/SHASUMS256.txt"
(cd "$root" && grep ' node-v26.13.1-linux-x64.tar.xz$' SHASUMS256.txt | sed 's/node-v26.13.1-linux-x64.tar.xz/node.tar.xz/' | sha256sum --check)
tar -xJf "$root/node.tar.xz" -C "$root"
node26="$root/node-v26.13.1-linux-x64/bin/node"
echo "node $("$node26" --version)"

export XDG_DATA_HOME="$root/data" XDG_CONFIG_HOME="$root/config" XDG_STATE_HOME="$root/state"
export XDG_RUNTIME_DIR="$root/runtime" XDG_CACHE_HOME="$root/cache"
export OPENCODE_DB="$root/opencode.db" MAGIC_CONTEXT_STORAGE_DIR="$root/storage"
mkdir -m 700 -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME/cortexkit" "$XDG_STATE_HOME" "$XDG_RUNTIME_DIR" "$XDG_CACHE_HOME" "$MAGIC_CONTEXT_STORAGE_DIR"
printf '{"embedding":{"provider":"local","model":"Xenova/all-MiniLM-L6-v2"}}\n' > "$XDG_CONFIG_HOME/cortexkit/magic-context.jsonc"
project="$root/project"
mkdir -p "$project"
git -C "$project" init -q
git -C "$project" -c user.email=probe@example.invalid -c user.name=probe commit -q --allow-empty -m init

models="$MAGIC_CONTEXT_STORAGE_DIR/models"
model=Xenova/all-MiniLM-L6-v2
revision=751bff37182d3f1213fa05d7196b954e230abad9
for file in config.json tokenizer.json tokenizer_config.json special_tokens_map.json onnx/model.onnx; do
	mkdir -p "$(dirname "$models/$model/$file")"
	curl -fsSL --retry 2 "https://huggingface.co/$model/resolve/$revision/$file" -o "$models/$model/$file"
done

checkout=$repo
label=checkout
if [[ -n ${ISSUE_995_REF:-} ]]; then
	label=$ISSUE_995_REF
	checkout="$root/ref"
	mkdir -p "$checkout"
	git archive "$ISSUE_995_REF" | tar -x -C "$checkout"
	ln -s "$repo/node_modules" "$checkout/node_modules"
	for package in plugin pi-plugin retina-local-fs e2e-tests; do
		if [[ -d "$repo/packages/$package/node_modules" ]]; then
			ln -s "$repo/packages/$package/node_modules" "$checkout/packages/$package/node_modules"
		fi
	done
	cp "$repo/packages/e2e-tests/scripts/issue-995-embedding-shutdown.ts" "$checkout/packages/e2e-tests/scripts/"
fi
echo "== build ($label)"
(cd "$checkout" && bun run --cwd packages/pi-plugin build >/dev/null)
dist="$checkout/packages/pi-plugin/dist"
(cd "$checkout" && bun build packages/e2e-tests/scripts/issue-995-embedding-shutdown.ts --outfile "$dist/issue-995-driver.js" \
	--target node --format esm --external onnxruntime-node --external onnxruntime-web --external sharp \
	--external bun:ffi --external bun:sqlite --external node:sqlite >/dev/null)

run_mode() {
	local runtime=$1 mode=$2 count=$3
	local exe=$node26
	[[ $runtime == bun ]] && exe=bun
	local -A totals=()
	for i in $(seq 1 "$count"); do
		local delay=$((200 + RANDOM % 1200))
		set +e
		timeout 120 "$exe" "$dist/issue-995-driver.js" "$mode" "$project" "$delay" > "$root/out" 2> "$root/err"
		local code=$?
		set -e
		local napi
		napi=$(grep -c "terminate called\|Napi::Error" "$root/err" || true)
		echo "$label $runtime $mode #$i delay=${delay}ms exit=$code napi_lines=$napi $(tr '\n' ' ' < "$root/out")"
		if [[ $code -ne 0 ]]; then sed -n '1,4p' "$root/err" | sed 's/^/    stderr: /'; fi
		totals[$code]=$(( ${totals[$code]:-0} + 1 ))
	done
	local summary=""
	for key in "${!totals[@]}"; do summary+="exit $key: ${totals[$key]}; "; done
	echo "TOTAL $label $runtime $mode runs=$count $summary"
}
for runtime in "${runtimes[@]}"; do
	for mode in "${modes[@]}"; do
		case $mode in
			measure|yield-cost) run_mode "$runtime" "$mode" 1 ;;
			*) run_mode "$runtime" "$mode" "$runs" ;;
		esac
	done
done
