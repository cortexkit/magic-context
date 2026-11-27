#!/usr/bin/env bash
set -euo pipefail

mkdir -p "${TMPDIR:-/tmp}/magic-context/mapper-step-cap"
scratch=$(mktemp -d "${TMPDIR:-/tmp}/magic-context/mapper-step-cap/pi-XXXXXXXX")
trap 'rm -rf -- "$scratch"' EXIT
export TMPDIR="$scratch" HOME="$scratch/home"
export XDG_DATA_HOME="$scratch/data" XDG_CONFIG_HOME="$scratch/config"
export XDG_STATE_HOME="$scratch/state" XDG_RUNTIME_DIR="$scratch/runtime" XDG_CACHE_HOME="$scratch/cache"
export OPENCODE_DB="$XDG_DATA_HOME/opencode/opencode.db" MAGIC_CONTEXT_STORAGE_DIR="$scratch/context"
export PI_CODING_AGENT_DIR="$scratch/pi" MC_E2E_MAPPER_STEP_PROBE=1
mkdir -p "$HOME" "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_STATE_HOME" "$XDG_RUNTIME_DIR" "$XDG_CACHE_HOME" "$MAGIC_CONTEXT_STORAGE_DIR" "$PI_CODING_AGENT_DIR"
cd packages/e2e-tests
bun test --timeout 600000 tests/dreamer-mapper-step-cap-pi.test.ts
