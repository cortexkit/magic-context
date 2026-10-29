#!/usr/bin/env bash
# Shared by GitHub Actions and scripts/gate.sh; collect independent failures.
set -euo pipefail
source scripts/ci/checks.sh
check cortexkit-layout bash scripts/check-cortexkit-layout.sh
check docs-layout bash scripts/check-docs-layout.sh
check docs-layout-tests bash scripts/check-docs-layout.test.sh
check cargo-pins-self-test python3 scripts/cargo-lock-pins.py --self-test
check nextest-inventory-self-test python3 scripts/check-nextest-inventory.py --self-test
check artifact-wait-self-test python3 scripts/wait-ci-artifact.py --self-test
check artifact-download-self-test python3 scripts/download-ci-artifact.py --self-test
check ci-evidence-tests timeout 180s python3 scripts/ci-gate.test.py -v
check release-tests timeout 180s python3 scripts/release.test.py -v
check merge-tests timeout 180s python3 scripts/merge-pr.test.py -v
check cargo-path-dependencies timeout 180s python3 scripts/check-cargo-path-dependencies.py
check cargo-path-self-test timeout 180s python3 scripts/check-cargo-path-dependencies.py --self-test
check golden-checker-tests python3 scripts/check-goldens.test.py -v
check mode-manifest bun packages/e2e-tests/scripts/validate-mode-manifest.ts
check gate-tests bun test ./scripts/gate.test.ts
check shard-contracts bash -c 'cd packages/e2e-tests && bun test scripts/validate-mode-manifest.test.ts scripts/select-rust-shard.test.ts scripts/select-host-shard.test.ts scripts/select-unit-shard.test.ts scripts/ci-workflow.test.ts scripts/run-slow-unit-tests.test.ts'
check slow-unit-inventory bash -c 'cd packages/e2e-tests && bun scripts/run-slow-unit-tests.ts --dry-run'
exit "$status"
