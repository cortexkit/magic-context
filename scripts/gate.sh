#!/usr/bin/env bash
# Run CI's builds, contract/layout checks, formatting, typechecks and pinned lints.
# Artifact publication is owned by CI; this command only builds and checks.
set -uo pipefail

if [[ "${1:-}" != preflight || $# != 1 ]]; then
  printf 'usage: bash scripts/gate.sh preflight\n' >&2
  exit 64
fi
cd "$(dirname "$0")/.." || exit 1
passed=0
failed=0
run() {
  local label=$1
  shift
  printf '\nPREFLIGHT %s\n' "$label"
  if "$@"; then
    passed=$((passed + 1))
    printf 'PREFLIGHT PASS %s\n' "$label"
  else
    local code=$?
    failed=$((failed + 1))
    printf 'PREFLIGHT FAIL %s exit=%s\n' "$label" "$code" >&2
  fi
}

run install bun install --frozen-lockfile
run build bun run build
run pi-e2e-argv bun run --cwd packages/pi-plugin build:e2e-argv
run dashboard-build bun run --cwd packages/dashboard build
run compiled-tui bun run --cwd packages/plugin check:tui-compiled
run historian-golden bun crates/mc-module/gen/gen-historian-prompt-golden.ts --check
run compiled-dists bun test packages/e2e-tests/scripts/ci-dists.test.ts
run cortexkit-layout bash scripts/check-cortexkit-layout.sh
run docs-layout bash scripts/check-docs-layout.sh
run docs-layout-controls bash scripts/check-docs-layout.test.sh
run cargo-lock-controls python3 scripts/cargo-lock-pins.py --self-test
run nextest-inventory-controls python3 scripts/check-nextest-inventory.py --self-test
run wait-artifact-controls python3 scripts/wait-ci-artifact.py --self-test
run download-artifact-controls python3 scripts/download-ci-artifact.py --self-test
run ci-gate-controls timeout 180s python3 scripts/ci-gate.test.py -v
run release-controls timeout 180s python3 scripts/release.test.py -v
run merge-controls timeout 180s python3 scripts/merge-pr.test.py -v
run cargo-paths timeout 180s python3 scripts/check-cargo-path-dependencies.py
run cargo-path-controls timeout 180s python3 scripts/check-cargo-path-dependencies.py --self-test
run host-manifest bun packages/e2e-tests/scripts/validate-mode-manifest.ts
run shard-controls bash -c 'cd packages/e2e-tests && bun test scripts/validate-mode-manifest.test.ts scripts/select-rust-shard.test.ts scripts/select-host-shard.test.ts scripts/select-unit-shard.test.ts scripts/ci-workflow.test.ts scripts/run-slow-unit-tests.test.ts'
run slow-unit-registration bash -c 'cd packages/e2e-tests && bun scripts/run-slow-unit-tests.ts --dry-run'
run rust-format cargo fmt --check
for package in plugin cli retina-local-fs pi-plugin dashboard; do
  run "typecheck-$package" bun run --cwd "packages/$package" typecheck
done
run typecheck-e2e-ci bun run --cwd packages/e2e-tests tsc --noEmit -p tsconfig.ci.json
for package in plugin cli retina-local-fs pi-plugin dashboard; do
  run "lint-$package" bun run --cwd "packages/$package" lint
done
printf '\nPREFLIGHT SUMMARY passed=%s failed=%s\n' "$passed" "$failed"
[[ $failed == 0 ]]
