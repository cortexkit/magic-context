#!/usr/bin/env bash
# Shared by GitHub Actions and scripts/gate.sh; workflow orchestration stays in YAML.
set -euo pipefail
export TMPDIR="${TMPDIR:-${RUNNER_TEMP:-/tmp}}/magic-context/issue-947-ci"
mkdir -p "$TMPDIR"
export HOME="$(mktemp -d "$TMPDIR/home.XXXXXX")"
unset OPENCODE_DB
cd packages/e2e-tests
bun test tests/opencode2/hidden-run-notifications.test.ts
