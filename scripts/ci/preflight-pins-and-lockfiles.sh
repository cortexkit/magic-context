#!/usr/bin/env bash
# These checks are intentionally whole-repository, even for a --changed full gate.
set -euo pipefail
source scripts/ci/checks.sh
check cargo-lock-pins python3 scripts/cargo-lock-pins.py
check workspace-lock bash -c 'cargo metadata --locked --format-version 1 > "$RUNNER_TEMP/workspace-metadata.json" && python3 -c '\''import json,os; print("workspace Cargo.lock:", len(json.load(open(os.environ["RUNNER_TEMP"]+"/workspace-metadata.json"))["packages"]), "packages")'\'''
check dashboard-lock bash -c 'cargo metadata --locked --format-version 1 --manifest-path packages/dashboard/src-tauri/Cargo.toml > "$RUNNER_TEMP/dashboard-metadata.json" && python3 -c '\''import json,os; print("dashboard Cargo.lock:", len(json.load(open(os.environ["RUNNER_TEMP"]+"/dashboard-metadata.json"))["packages"]), "packages")'\'''
check golden-generators python3 scripts/check-goldens.py
check opencode2-source-and-release-pins bash -c 'cd packages/e2e-tests && bun test ./tests/opencode2/pins.test.ts'
exit "$status"
