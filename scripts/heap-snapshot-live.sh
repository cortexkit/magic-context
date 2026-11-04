#!/usr/bin/env bash
set -euo pipefail
finished=0

# The serve must have been restarted with debug_rpc=true in the trusted user
# magic-context config, or with MAGIC_CONTEXT_DEBUG_RPC=1 in its environment.
pid="${1:-}"
if [[ -z "$pid" ]]; then
  pids=( $(pgrep -f 'opencode serve --hostname' || true) )
  if (( ${#pids[@]} == 0 )); then
    pids=( $(pgrep -f 'opencode serve .*--hostname' || true) )
  fi
  if (( ${#pids[@]} != 1 )); then
    printf 'Expected exactly one opencode serve pid, found %d. Pass the desired pid explicitly.\n' "${#pids[@]}" >&2
    exit 2
  fi
  pid="${pids[0]}"
fi

if [[ -n "${MAGIC_CONTEXT_STORAGE_DIR:-}" ]]; then
  storage_dir="$MAGIC_CONTEXT_STORAGE_DIR"
elif [[ -n "${XDG_DATA_HOME:-}" ]]; then
  storage_dir="$XDG_DATA_HOME/cortexkit/magic-context"
else
  storage_dir="$HOME/.local/share/cortexkit/magic-context"
fi

rpc_file="${MAGIC_CONTEXT_RPC_FILE:-}"
if [[ -z "$rpc_file" ]]; then
  for candidate in "$storage_dir"/rpc/*/port-"$pid"-*.json; do
    if [[ -f "$candidate" ]]; then
      rpc_file="$candidate"
      break
    fi
  done
fi
if [[ -z "$rpc_file" || ! -f "$rpc_file" ]]; then
  printf 'No Magic Context RPC discovery file found for pid %s under %s/rpc.\n' "$pid" "$storage_dir" >&2
  exit 1
fi

IFS=$'\t' read -r port token record_pid < <(
  bun -e 'const r=await Bun.file(process.argv[1]).json(); console.log(`${r.port}\t${r.token ?? ""}\t${r.pid}`)' "$rpc_file"
)
if [[ "$record_pid" != "$pid" || -z "$port" || -z "$token" ]]; then
  printf 'Invalid or unauthenticated RPC discovery record: %s\n' "$rpc_file" >&2
  exit 1
fi

response_file="$(mktemp "${TMPDIR:-/tmp}/mc-heap-rpc.XXXXXX")"
trap 'status=$?
if [ "$status" -eq 0 ] && [ "${finished:-0}" != 1 ]; then
    printf "%s\n" "$0: exited before successful completion" >&2
    status=1
fi
rm -f "$response_file" || { cleanup_status=$?; [ "$status" -ne 0 ] || status=$cleanup_status; }
exit "$status"' EXIT
http_status="$({ curl --silent --show-error \
  --output "$response_file" \
  --write-out '%{http_code}' \
  --request POST \
  --header "Authorization: Bearer $token" \
  --header 'Content-Type: application/json' \
  --data '{}' \
  "http://127.0.0.1:$port/rpc/debug.heapSnapshot"; } || true)"
if [[ "$http_status" != "200" ]]; then
  printf 'debug.heapSnapshot returned HTTP %s: ' "$http_status" >&2
  bun -e 'console.error(await Bun.file(process.argv[1]).text())' "$response_file"
  printf 'Restart serve with trusted user config debug_rpc=true or MAGIC_CONTEXT_DEBUG_RPC=1.\n' >&2
  exit 1
fi

snapshot_path="$(bun -e 'const r=await Bun.file(process.argv[1]).json(); if(r.error) throw new Error(r.error); if(typeof r.path!=="string") throw new Error("RPC response has no snapshot path"); console.log(r.path)' "$response_file")"
bun -e 'const r=await Bun.file(process.argv[1]).json(); console.log(JSON.stringify(r,null,2))' "$response_file"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
printf '\nAttribution command:\n  bun %q %q\n' "$repo_root/packages/plugin/scripts/attribute-heap.ts" "$snapshot_path"
finished=1
