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
  node scripts/version-sync.mjs "$VERSION" --dry-run
  echo ""
  echo "[DRY RUN] Would commit, tag $TAG, and push to origin."
  exit 0
fi

# Step 2: Pre-release checks
echo "→ Running pre-release checks..."
echo ""

echo "  bun lint..."
bun run lint 2>&1 || { echo "Error: Lint failed"; exit 1; }

echo "  bun typecheck..."
bun run typecheck 2>&1 || { echo "Error: Typecheck failed"; exit 1; }

echo "  bun build..."
bun run build 2>&1 || { echo "Error: Build failed"; exit 1; }

echo "  ✓ All checks passed"
echo ""

# Step 3: Sync version
echo "→ Syncing version to $VERSION..."
node scripts/version-sync.mjs "$VERSION"
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
echo "  → Watch: https://github.com/ualtinok/opencode-magic-context/actions"
