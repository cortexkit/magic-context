#!/usr/bin/env bash
# Shared by GitHub Actions and scripts/gate.sh; workflow orchestration stays in YAML.
set -euo pipefail
cd packages/e2e-tests
set -o pipefail
files=$(bun scripts/select-host-shard.ts opencode2 "${1:?missing workflow argument}/2" | tr '\n' ' ')
if [ -z "${files// /}" ]; then echo 'mode manifest selected no files'; exit 1; fi
echo "Running OpenCode 2 host tests from mode manifest: $files"
# shellcheck disable=SC2086 # The repository-controlled file list must expand into Bun arguments.
bun test --timeout 600000 $files
