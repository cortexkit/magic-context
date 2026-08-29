#!/usr/bin/env bash
# Run the release gate's non-Rust e2e suites in a hermetic native-architecture
# container. The outer invocation builds the cached image and mounts the
# checkout read-only; the inner invocation stages that checkout in tmpfs before
# running Bun so dependency links and test artifacts cannot touch the host.
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
REPO_ROOT=${MC_E2E_REPO_ROOT:-$(cd -- "$SCRIPT_DIR/.." && pwd -P)}
IMAGE=${MC_E2E_DOCKER_IMAGE:-mc-e2e-host}
INNER=${MC_E2E_DOCKER_INNER:-0}

if [[ "$INNER" != 1 ]]; then
    if ! command -v docker >/dev/null 2>&1; then
        echo "Error: docker is required for the containerized host e2e gate" >&2
        exit 1
    fi

    echo "  [e2e:docker] building $IMAGE (cached layers reused; native architecture)..."
    docker build \
        -f "$REPO_ROOT/tests/docker/Dockerfile.e2e-host" \
        -t "$IMAGE" \
        "$REPO_ROOT/tests/docker"

    # The checkout stays read-only. /workspace is a tmpfs copy used for Bun's
    # workspace linker and for optional local dist builds; /tmp holds every
    # runtime cache and test sandbox. No host HOME or ~/.local/share is mounted.
    exec docker run --rm --init --read-only \
        --mount "type=bind,src=$REPO_ROOT,dst=/repo,readonly" \
        --tmpfs /workspace:rw,exec,size=8g \
        --tmpfs /tmp:rw,exec,size=8g \
        --tmpfs /run:rw,exec,size=64m \
        --env MC_E2E_DOCKER_INNER=1 \
        --env MC_E2E_REPO_ROOT=/workspace \
        --env E2E_OC_FILES="${E2E_OC_FILES:-}" \
        --env E2E_PI_FILES="${E2E_PI_FILES:-}" \
        --env HOME=/tmp/mc-home \
        --env XDG_CONFIG_HOME=/tmp/mc-config \
        --env XDG_DATA_HOME=/tmp/mc-data \
        --env XDG_CACHE_HOME=/tmp/mc-cache \
        --env NODE_ENV= \
        "$IMAGE" \
        bash /repo/scripts/release-e2e-docker.sh --inside
fi

if [[ "${1:-}" != "--inside" ]]; then
    echo "Error: internal e2e runner invocation is missing --inside" >&2
    exit 2
fi

# The outer runner sets this to /workspace. Keep the check explicit so a future
# change cannot accidentally run tests against the read-only bind mount.
if [[ "$REPO_ROOT" != /workspace ]]; then
    echo "Error: container e2e runner must use the tmpfs workspace (/workspace)" >&2
    exit 2
fi

mkdir -p "$REPO_ROOT" "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME"

# Copy source and already-built release artifacts out of the read-only checkout.
# Exclude host dependency trees and runtime state; Bun installs a fresh,
# container-local hoisted tree below.
echo "  [e2e:docker] staging read-only checkout in tmpfs..."
tar \
    --exclude=.git \
    --exclude=node_modules \
    --exclude=.cortexkit \
    --exclude=target \
    -C /repo -cf - . | tar -C "$REPO_ROOT" -xf -

cd "$REPO_ROOT"
E2E_MANIFEST_VALIDATOR="$REPO_ROOT/packages/e2e-tests/scripts/validate-mode-manifest.ts"

BUN_CACHE_DIR="$XDG_CACHE_HOME/bun-install"
echo "  [e2e:docker] bun install (container-local cache)..."
bun install \
    --frozen-lockfile \
    --linker=hoisted \
    --cache-dir "$BUN_CACHE_DIR" \
    --no-progress

# release.sh builds these artifacts before reaching the gate. Building only when
# they are absent keeps the standalone runner useful without duplicating release
# work, while still ensuring the tests exercise bundled plugin code.
if [[ ! -f packages/plugin/dist/index.js ]]; then
    echo "  [e2e:docker] plugin dist missing; building in tmpfs..."
    bun run --cwd packages/plugin build
fi
if [[ ! -f packages/pi-plugin/dist/index.js ]]; then
    echo "  [e2e:docker] Pi dist missing; building in tmpfs..."
    bun run --cwd packages/pi-plugin build
fi

run_e2e_group() {
    local mode="$1" label="$2" files="$3" output status
    echo "  [e2e:$mode:$label:start] bun test..."
    status=0
    output=$(cd "$REPO_ROOT/packages/e2e-tests" && MC_E2E_MODE="$mode" NODE_ENV="" bun test --timeout 600000 $files 2>&1) || status=$?
    echo "$output"

    # Keep this gate identical to release.sh: a positive pass summary is
    # required, a non-zero fail count blocks the release, and Bun's known
    # post-completion panic is tolerated only after a green summary exists.
    if echo "$output" | grep -qE "[1-9][0-9]* fail"; then
        echo "Error: e2e ($mode/$label) failed (fail count > 0)"
        echo "  [e2e:$mode:$label:end] status=fail"
        return 1
    fi
    if ! echo "$output" | grep -qE "[1-9][0-9]* pass"; then
        echo "Error: e2e ($mode/$label) produced no passing-test summary (crash, timeout, or zero tests collected)"
        echo "  [e2e:$mode:$label:end] status=fail"
        return 1
    fi
    if [ "$status" -ne 0 ]; then
        echo "  [e2e:$mode:$label] note: tests passed but Bun exited $status (known post-completion panic) — tolerated"
    fi
    echo "  [e2e:$mode:$label:end] status=pass"
}

# Both lists must be revalidated inside the staged checkout. The outer release
# path passes its validated values in, and this check catches any drift while
# also making the standalone Docker runner deterministic.
MANIFEST_OC_FILES=$(bun "$E2E_MANIFEST_VALIDATOR" --mode ts --harness opencode | tr '\n' ' ')
MANIFEST_PI_FILES=$(bun "$E2E_MANIFEST_VALIDATOR" --mode ts --harness pi | tr '\n' ' ')
if [[ -n "${E2E_OC_FILES:-}" && "$E2E_OC_FILES" != "$MANIFEST_OC_FILES" ]]; then
    echo "Error: manifest-derived OpenCode list changed across the Docker boundary" >&2
    exit 1
fi
if [[ -n "${E2E_PI_FILES:-}" && "$E2E_PI_FILES" != "$MANIFEST_PI_FILES" ]]; then
    echo "Error: manifest-derived Pi list changed across the Docker boundary" >&2
    exit 1
fi
E2E_OC_FILES="$MANIFEST_OC_FILES"
E2E_PI_FILES="$MANIFEST_PI_FILES"

EXIT=0
run_e2e_group "ts" "opencode" "$E2E_OC_FILES" || EXIT=1
run_e2e_group "ts" "pi" "$E2E_PI_FILES" || EXIT=1

if [[ "$EXIT" -eq 0 ]]; then
    echo "  ✓ Containerized host e2e checks passed"
else
    echo "Error: one or more containerized host e2e groups failed"
fi
exit "$EXIT"
