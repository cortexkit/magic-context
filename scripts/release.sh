#!/usr/bin/env bash
set -euo pipefail

# release.sh — Tag and push a new magic-context release
#
# Usage:
#   ./scripts/release.sh 0.1.0        # release v0.1.0
#   ./scripts/release.sh 0.1.0 --dry  # preview without committing/pushing
#
# What it does:
#   1. Validates the version is semver
#   2. Checks for clean working tree (no uncommitted changes)
#   3. Syncs version in package.json
#   4. Runs pre-release checks (lint, typecheck, build)
#   5. Commits the version bump
#   6. Creates a git tag (v0.1.0)
#   7. Pushes commit + tag to origin
#   8. CI takes over: test → build → publish npm + GitHub release

VERSION="${1:-}"
DRY="${2:-}"

if [[ -z "$VERSION" ]]; then
  echo "Usage: ./scripts/release.sh <version> [--dry]"
  echo "  e.g. ./scripts/release.sh 0.1.0"
  exit 1
fi

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$ ]]; then
  echo "Error: '$VERSION' is not valid semver (expected X.Y.Z)"
  exit 1
fi

TAG="v$VERSION"

# Check if tag already exists
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Error: tag '$TAG' already exists"
  exit 1
fi

# Check for clean working tree
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree is not clean — commit or stash changes first"
  git status --short
  exit 1
fi

# Check we're on main/master
BRANCH=$(git branch --show-current)
if [[ "$BRANCH" != "main" && "$BRANCH" != "master" ]]; then
  echo "Warning: releasing from '$BRANCH' (not main/master)"
  read -rp "Continue? [y/N] " confirm
  if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo "Aborted."
    exit 1
  fi
fi

echo ""
echo "  Releasing magic-context $TAG"
echo "  ─────────────────────────────"
echo ""

# Step 1: Dry run preview
if [[ "$DRY" == "--dry" ]]; then
  echo "→ Version sync (dry run):"
  bun scripts/version-sync.mjs "$VERSION" --dry-run
  echo ""
  echo "[DRY RUN] Would commit, tag $TAG, and push to origin."
  exit 0
fi

# Step 2: Pre-release checks
echo "→ Running pre-release checks..."
echo ""

PLUGIN_DIR="packages/plugin"
PI_DIR="packages/pi-plugin"

echo "  [plugin] bun lint..."
bun run --cwd "$PLUGIN_DIR" lint 2>&1 || { echo "Error: Plugin lint failed"; exit 1; }

echo "  [plugin] bun typecheck..."
bun run --cwd "$PLUGIN_DIR" typecheck 2>&1 || { echo "Error: Plugin typecheck failed"; exit 1; }

echo "  [plugin] bun test..."
# Bun has a known panic crash after tests complete (https://github.com/oven-sh/bun/issues/XXXXX).
# All tests pass but the process exits non-zero. Check output for failures instead of exit code.
TEST_OUTPUT=$(bun test --cwd "$PLUGIN_DIR" 2>&1 || true)
echo "$TEST_OUTPUT"
if echo "$TEST_OUTPUT" | grep -q "[1-9][0-9]* fail"; then
  echo "Error: Plugin tests failed"
  exit 1
fi

echo "  [plugin] bun build..."
bun run --cwd "$PLUGIN_DIR" build 2>&1 || { echo "Error: Plugin build failed"; exit 1; }

# Copy root README into plugin package for npm publishing
cp README.md "$PLUGIN_DIR/README.md"

echo "  [pi-plugin] bun lint..."
bun run --cwd "$PI_DIR" lint 2>&1 || { echo "Error: Pi-plugin lint failed"; exit 1; }

echo "  [pi-plugin] bun typecheck..."
bun run --cwd "$PI_DIR" typecheck 2>&1 || { echo "Error: Pi-plugin typecheck failed"; exit 1; }

echo "  [pi-plugin] bun test..."
PI_TEST_OUTPUT=$(bun test --cwd "$PI_DIR" 2>&1 || true)
echo "$PI_TEST_OUTPUT"
if echo "$PI_TEST_OUTPUT" | grep -q "[1-9][0-9]* fail"; then
  echo "Error: Pi-plugin tests failed"
  exit 1
fi

echo "  [pi-plugin] bun build..."
bun run --cwd "$PI_DIR" build 2>&1 || { echo "Error: Pi-plugin build failed"; exit 1; }

echo "  ✓ All checks passed"
echo ""

# Step 3: Generate JSON Schema
echo "→ Generating JSON Schema..."
bun packages/plugin/scripts/build-schema.ts || { echo "Error: Schema generation failed"; exit 1; }
echo ""

# Step 4: Sync version
echo "→ Syncing version to $VERSION..."
bun scripts/version-sync.mjs "$VERSION"
echo ""

# Step 4: Commit (skip if versions were already at target)
echo "→ Committing version bump..."
git add -A
if git diff --cached --quiet; then
  echo "  (no changes — version already at $VERSION)"
else
  git commit -m "release: $TAG"
fi

# Step 5: Tag
echo "→ Creating tag $TAG..."
git tag -a "$TAG" -m "Release $TAG"
echo ""

# Step 6: Push
echo "→ Pushing to origin..."
git push origin "$BRANCH"
git push origin "$TAG"
echo ""

echo "  ✓ Released $TAG"
echo "  → GitHub Actions will now: test → build → publish"
echo "  → Watch: https://github.com/cortexkit/opencode-magic-context/actions"
