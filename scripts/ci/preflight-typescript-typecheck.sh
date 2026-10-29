#!/usr/bin/env bash
# Preserve each package's typecheck script; independent projects run concurrently after declarations are ready.
set -euo pipefail
status=0
jobs="${TYPECHECK_JOBS:-${GATE_CPUS:-2}}"
if [[ ! "$jobs" =~ ^[1-9][0-9]*$ ]]; then
  printf 'TYPECHECK_JOBS must be a positive integer\n' >&2
  exit 1
fi
if (( jobs > 6 )); then jobs=6; fi
# Plugin and Pi typechecks both verify this composite project. Seed it once before parallel readers.
bun run --cwd packages/retina-local-fs tsc -p tsconfig.build.json || status=1
logs="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/typechecks.XXXXXX")"
pids=()
labels=()
wait_checks() {
  local index label result
  for index in "${!pids[@]}"; do
    label="${labels[$index]}"
    if wait "${pids[$index]}"; then
      cat "$logs/$label.log"
      printf 'PASS typecheck %s\n' "$label"
    else
      result=$?
      cat "$logs/$label.log"
      printf 'FAIL typecheck %s (exit %s)\n' "$label" "$result" >&2
      status=1
    fi
  done
  pids=()
  labels=()
}
start_check() {
  local label="$1"
  shift
  "$@" > "$logs/$label.log" 2>&1 &
  pids+=("$!")
  labels+=("$label")
  if (( ${#pids[@]} >= jobs )); then wait_checks; fi
}
for package in plugin cli retina-local-fs pi-plugin dashboard; do
  start_check "$package" bun run --cwd "packages/$package" typecheck
done
start_check e2e-tests bun run --cwd packages/e2e-tests tsc --noEmit -p tsconfig.ci.json
wait_checks
exit "$status"
