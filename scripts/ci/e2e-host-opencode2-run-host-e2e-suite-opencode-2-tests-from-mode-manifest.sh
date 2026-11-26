#!/usr/bin/env bash
# Shared by GitHub Actions and scripts/gate.sh; workflow orchestration stays in YAML.
set -euo pipefail
cd packages/e2e-tests
set -o pipefail
shard="${1:?missing workflow argument}/2"
files=$(bun scripts/select-host-shard.ts opencode2 "$shard" | tr '\n' ' ')
if [ -z "${files// /}" ]; then echo 'mode manifest selected no files'; exit 1; fi
echo "Running OpenCode 2 host tests from mode manifest: $files"
known=$(bun scripts/select-host-shard.ts opencode2 "$shard" --known-failures "${MC_E2E_OPENCODE2_VERSION:?missing host version}")
if [[ "$known" == '[]' ]]; then
    # shellcheck disable=SC2086 # The repository-controlled file list must expand into Bun arguments.
    exec bun test --timeout 600000 $files
fi

# Never skip known failures. Compare the exact cases Bun reports, including
# unexpected passes and missing results, before deciding the CI exit status.
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
printf '%s\n' "$known" > "$scratch/known.json"
status=0
# shellcheck disable=SC2086 # The repository-controlled file list must expand into Bun arguments.
bun test --timeout 600000 --reporter=junit --reporter-outfile="$scratch/results.xml" $files || status=$?
python3 ../../scripts/ci/adjudicate-oc2-junit.py "$scratch/known.json" "$scratch/results.xml" "$status"
