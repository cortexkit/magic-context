#!/usr/bin/env bash
# Run all docker E2E test images locally.
#
# Usage:
#   tests/docker/run-e2e.sh              # both harnesses
#   tests/docker/run-e2e.sh opencode     # OpenCode only
#   tests/docker/run-e2e.sh pi           # Pi only
#
# Pre-requisite: run `bun run --cwd packages/plugin build` and
# `bun run --cwd packages/pi-plugin build` first — the Dockerfiles
# COPY pre-built dist/ trees rather than build inside the image.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TARGET="${1:-all}"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

run_target() {
    local harness="$1"
    local dockerfile="$SCRIPT_DIR/Dockerfile.$harness"
    local image="mc-e2e-$harness"

    echo ""
    echo "════════════════════════════════════════════════════════════"
    echo "  Building $image image (linux/amd64)..."
    echo "════════════════════════════════════════════════════════════"
    docker build \
        --platform linux/amd64 \
        -f "$dockerfile" \
        -t "$image" \
        "$REPO_ROOT"

    echo ""
    echo "════════════════════════════════════════════════════════════"
    echo "  Running $image..."
    echo "════════════════════════════════════════════════════════════"
    if docker run --rm --platform linux/amd64 "$image"; then
        echo -e "${GREEN}✓ $harness E2E PASSED${NC}"
        return 0
    else
        echo -e "${RED}✗ $harness E2E FAILED${NC}"
        return 1
    fi
}

# Pre-build local dists. The Dockerfiles COPY these — they don't build
# inside the image. This is intentional: keeps the image small, makes
# iteration fast, and tests the same artifact CI publishes.
echo "Pre-building local dist artifacts..."
bun run --cwd "$REPO_ROOT/packages/plugin" build
bun run --cwd "$REPO_ROOT/packages/pi-plugin" build

# pi-plugin needs node_modules baked into the image because its
# CLI is a Node ESM bundle that requires its dependency tree at
# runtime. Skip optional deps to keep the image small.
echo "Installing pi-plugin runtime dependencies..."
(cd "$REPO_ROOT/packages/pi-plugin" && bun install --production --frozen-lockfile 2>/dev/null || npm install --omit=dev --no-audit --no-fund)

EXIT=0
case "$TARGET" in
    all)
        run_target opencode || EXIT=1
        run_target pi || EXIT=1
        ;;
    opencode|pi)
        run_target "$TARGET" || EXIT=1
        ;;
    *)
        echo "Unknown target: $TARGET" >&2
        echo "Usage: $0 [opencode|pi|all]" >&2
        exit 2
        ;;
esac

echo ""
if [[ $EXIT -eq 0 ]]; then
    echo -e "${GREEN}All requested E2E targets passed.${NC}"
else
    echo -e "${RED}One or more E2E targets failed.${NC}"
fi
exit $EXIT
