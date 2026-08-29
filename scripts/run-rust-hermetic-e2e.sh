#!/usr/bin/env bash
# Execute the hermetic Rust e2e group from the committed mode manifest.
#
# This is the single invocation used by the local release script and the release
# workflow. Keeping prerequisite checks, the manifest selection, and Bun's
# true-green summary check here prevents CI from silently testing a different
# subset than a local release.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd -P)
E2E_DIR="$REPO_ROOT/packages/e2e-tests"
MANIFEST_VALIDATOR="$E2E_DIR/scripts/validate-mode-manifest.ts"
PREREQUISITE_DETECTOR="$E2E_DIR/scripts/check-rust-prerequisites.ts"

if [[ "$#" -ne 0 ]]; then
    echo "Usage: scripts/run-rust-hermetic-e2e.sh" >&2
    exit 2
fi

run_e2e_group() {
    local mode="$1" label="$2" files="$3" output status
    echo "  [e2e:$mode:$label:start] bun test..."
    status=0
    # Rust stacks create real daemon, module, and OpenCode processes. Serial file
    # execution keeps their sockets, ports, and timing drills isolated.
    # shellcheck disable=SC2086 # The manifest emits repository-controlled test paths.
    output=$(cd "$E2E_DIR" && MC_E2E_MODE="$mode" NODE_ENV="" bun test --timeout 600000 --max-concurrency=1 $files 2>&1) || status=$?
    echo "$output"
    if echo "$output" | grep -qE "[1-9][0-9]* fail"; then
        echo "Error: e2e ($mode/$label) failed (fail count > 0)" >&2
        echo "  [e2e:$mode:$label:end] status=fail"
        return 1
    fi
    if ! echo "$output" | grep -qE "[1-9][0-9]* pass"; then
        echo "Error: e2e ($mode/$label) produced no passing-test summary (crash, timeout, or zero tests collected)" >&2
        echo "  [e2e:$mode:$label:end] status=fail"
        return 1
    fi
    if [[ "$status" -ne 0 ]]; then
        echo "  [e2e:$mode:$label] note: tests passed but Bun exited $status (known post-completion panic) — tolerated"
    fi
    echo "  [e2e:$mode:$label:end] status=pass"
}

echo "  [e2e:rust:prerequisites:start] resolving current Rust workspaces..."
# `--hermetic` verifies the two source workspaces without performing the obsolete
# root-target ck-mc build. HermeticSubcStack performs the one authoritative build
# into its e2e-owned target directory and renames that current-tree binary to
# ckdev-mc-e2e before spawning it.
if ! bun "$PREREQUISITE_DETECTOR" --hermetic; then
    echo "Error: Rust e2e prerequisite detector failed; the rust group is RED (never skipped)." >&2
    echo "  [e2e:rust:prerequisites:end] status=fail"
    exit 1
fi
if ! command -v opencode >/dev/null 2>&1; then
    echo "Error: 'opencode' not found on PATH — Rust e2e spawns 'opencode serve'." >&2
    echo "  [e2e:rust:prerequisites:end] status=fail"
    exit 1
fi
echo "  [e2e:rust:prerequisites:end] status=pass"

RUST_E2E_FILES=$(bun "$MANIFEST_VALIDATOR" --mode rust --harness all | tr '\n' ' ')
if [[ -z "$RUST_E2E_FILES" ]]; then
    echo "Error: Rust e2e manifest selected zero test files" >&2
    exit 1
fi

echo "Running Rust hermetic e2e tests from mode manifest: $RUST_E2E_FILES"
run_e2e_group "rust" "hermetic" "$RUST_E2E_FILES"
