#!/usr/bin/env bash
set -euo pipefail

# release-dashboard.sh — Tag and push a new dashboard release
#
# Usage:
#   ./scripts/release-dashboard.sh 0.2.2                           # release dashboard-v0.2.2
#   ./scripts/release-dashboard.sh 0.2.2 --dry                     # preview without committing/pushing
#   ./scripts/release-dashboard.sh 0.2.2 --notes-file NOTES.md     # release with notes non-interactively
#
# What it does:
#   1. Validates the version is semver
#   2. Checks for clean working tree
#   3. Bumps version in tauri.conf.json
#   4. Runs Rust check (cargo check)
#   5. Commits the version bump
#   6. Creates a git tag (dashboard-v0.2.2)
#   7. Pushes commit + tag to origin
#   8. Waits for CI to build all platforms and finish the workflow
#   9. Reads release notes from /dev/tty or --notes-file
#  10. Publishes the draft release

VERSION=""
DRY=""
NOTES_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry)
      DRY="--dry"
      shift
      ;;
    --notes-file)
      NOTES_FILE="${2:-}"
      if [[ -z "$NOTES_FILE" ]]; then
        echo "Error: --notes-file requires a path"
        exit 1
      fi
      shift 2
      ;;
    -*)
      echo "Error: unknown option '$1'"
      exit 1
      ;;
    *)
      if [[ -n "$VERSION" ]]; then
        echo "Error: unexpected argument '$1'"
        exit 1
      fi
      VERSION="$1"
      shift
      ;;
  esac
done

have_tty() {
  [[ -e /dev/tty ]] && { : </dev/tty >/dev/tty; } 2>/dev/null
}

if [[ -z "$VERSION" ]]; then
  echo "Usage: ./scripts/release-dashboard.sh <version> [--dry] [--notes-file FILE]"
  echo "  e.g. ./scripts/release-dashboard.sh 0.2.2"
  exit 1
fi

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$ ]]; then
  echo "Error: '$VERSION' is not valid semver (expected X.Y.Z)"
  exit 1
fi

if [[ -n "$NOTES_FILE" ]]; then
  if [[ ! -r "$NOTES_FILE" ]]; then
    echo "Error: notes file '$NOTES_FILE' is not readable"
    exit 1
  fi
  if ! grep -q '[^[:space:]]' "$NOTES_FILE"; then
    echo "Error: notes file '$NOTES_FILE' is empty"
    exit 1
  fi
fi

TAG="dashboard-v$VERSION"
TAURI_CONF="packages/dashboard/src-tauri/tauri.conf.json"

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
echo "  Releasing Magic Context Dashboard $TAG"
echo "  ───────────────────────────────────────"
echo ""

# Read current version from tauri.conf.json
CURRENT_VERSION=$(python3 -c "import json; print(json.load(open('$TAURI_CONF'))['version'])")
echo "  Current version: $CURRENT_VERSION"
echo "  New version:     $VERSION"
echo ""

# Dry run
if [[ "$DRY" == "--dry" ]]; then
  echo "[DRY RUN] Would:"
  echo "  1. Update $TAURI_CONF version to $VERSION"
  echo "  2. Run cargo check"
  echo "  3. Commit, tag $TAG, push to origin"
  echo "  4. Wait for CI and all platform builds to finish"
  if [[ -n "$NOTES_FILE" ]]; then
    echo "  5. Publish release with notes from $NOTES_FILE"
  else
    echo "  5. Prompt for release notes before publishing"
  fi
  exit 0
fi

# Step 1: Bump version in tauri.conf.json and update README download link
echo "→ Bumping version in tauri.conf.json..."
python3 -c "
import json
with open('$TAURI_CONF', 'r') as f:
    conf = json.load(f)
conf['version'] = '$VERSION'
with open('$TAURI_CONF', 'w') as f:
    json.dump(conf, f, indent=2)
    f.write('\n')
"
echo "  ✓ Updated to $VERSION"

echo "→ Updating README download link..."
sed -i '' "s|releases/tag/dashboard-v[0-9]*\.[0-9]*\.[0-9]*|releases/tag/$TAG|g" README.md
echo "  ✓ README points to $TAG"
echo ""

# Step 2: Cargo check
echo "→ Running cargo check..."
cd packages/dashboard
cargo check --manifest-path src-tauri/Cargo.toml 2>&1 || { echo "Error: Cargo check failed"; exit 1; }
cd ../..
echo "  ✓ Rust compiles"
echo ""

# Step 3: Commit
echo "→ Committing version bump..."
git add -A
if git diff --cached --quiet; then
  echo "  (no changes — version already at $VERSION)"
else
  git commit -m "dashboard: bump version to $VERSION"
fi

# Step 4: Tag
echo "→ Creating tag $TAG..."
git tag -a "$TAG" -m "Dashboard Release $TAG"
echo ""

# Step 5: Push
echo "→ Pushing to origin..."
git push origin "$BRANCH"
git push origin "$TAG"
echo ""

echo "  ✓ Tagged and pushed $TAG"
echo "  → CI is now building all platforms"
echo "  → Watch: https://github.com/cortexkit/magic-context/actions"
echo ""

# Step 6: Wait for CI
echo "→ Waiting for CI to create the draft release..."
echo "  (checking every 30s for up to 60 minutes)"
ATTEMPTS=0
MAX_ATTEMPTS=120
while [[ $ATTEMPTS -lt $MAX_ATTEMPTS ]]; do
  RELEASE_STATE=$(gh release view "$TAG" --repo cortexkit/magic-context --json isDraft --jq '.isDraft' 2>/dev/null || echo "not_found")
  
  if [[ "$RELEASE_STATE" == "true" ]]; then
    echo "  ✓ Draft release found"
    break
  elif [[ "$RELEASE_STATE" == "false" ]]; then
    echo "  ✓ Release already published"
    break
  fi
  
  ATTEMPTS=$((ATTEMPTS + 1))
  if [[ $((ATTEMPTS % 4)) -eq 0 ]]; then
    echo "  ... still waiting ($((ATTEMPTS * 30 / 60))m elapsed)"
  fi
  sleep 30
done

if [[ $ATTEMPTS -ge $MAX_ATTEMPTS ]]; then
  echo "  ⚠ Timed out waiting for release. Check CI manually."
  echo "  → https://github.com/cortexkit/magic-context/actions"
  exit 0
fi

# Step 7: Wait for all platform assets
MIN_ASSETS=10
echo ""
echo "→ Waiting for all platform assets (expecting ≥$MIN_ASSETS)..."
echo "  (checking every 30s for up to 60 minutes)"
ASSET_ATTEMPTS=0
ASSET_MAX=120
ASSET_COUNT=0
while [[ $ASSET_ATTEMPTS -lt $ASSET_MAX ]]; do
  ASSET_COUNT=$(gh release view "$TAG" --repo cortexkit/magic-context --json assets --jq '.assets | length' 2>/dev/null || echo "0")

  if [[ "$ASSET_COUNT" -ge "$MIN_ASSETS" ]]; then
    echo "  ✓ Found $ASSET_COUNT assets — minimum asset threshold reached"
    break
  fi

  ASSET_ATTEMPTS=$((ASSET_ATTEMPTS + 1))
  if [[ $((ASSET_ATTEMPTS % 4)) -eq 0 ]]; then
    ELAPSED=$((ASSET_ATTEMPTS * 30 / 60))
    echo "  ... $ASSET_COUNT assets so far (${ELAPSED}m elapsed)"
  fi
  sleep 30
done

if [[ "$ASSET_COUNT" -lt "$MIN_ASSETS" ]]; then
  echo "  ⚠ Only $ASSET_COUNT assets after waiting. Some platforms may have failed."
  if have_tty; then
    read -r -p "  Publish with $ASSET_COUNT assets? [y/N] " confirm </dev/tty
  else
    confirm=""
  fi
  if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo "  Skipping publish. Run manually: gh release edit $TAG --repo cortexkit/magic-context --draft=false"
    exit 0
  fi
fi

# Step 8: Wait for the release workflow to finish before publishing
echo ""
echo "→ Waiting for Dashboard Release workflow to complete..."
echo "  (checking every 30s for up to 60 minutes)"
WORKFLOW_ATTEMPTS=0
WORKFLOW_MAX=120
RUN_ID=""
while [[ $WORKFLOW_ATTEMPTS -lt $WORKFLOW_MAX ]]; do
  RUN_INFO=$(gh run list --repo cortexkit/magic-context --workflow "Dashboard Release" --limit 20 --json databaseId,status,conclusion,headBranch --jq ".[] | select(.headBranch == \"$TAG\") | \"\(.databaseId) \(.status) \(.conclusion)\"" 2>/dev/null | head -n 1 || true)

  if [[ -n "$RUN_INFO" ]]; then
    read -r RUN_ID RUN_STATUS RUN_CONCLUSION <<<"$RUN_INFO"
    if [[ "$RUN_STATUS" == "completed" ]]; then
      if [[ "$RUN_CONCLUSION" == "success" ]]; then
        echo "  ✓ Workflow completed successfully"
        break
      fi
      echo "  ✗ Workflow completed with conclusion: $RUN_CONCLUSION"
      echo "  → https://github.com/cortexkit/magic-context/actions/runs/$RUN_ID"
      exit 1
    fi
  fi

  WORKFLOW_ATTEMPTS=$((WORKFLOW_ATTEMPTS + 1))
  if [[ $((WORKFLOW_ATTEMPTS % 4)) -eq 0 ]]; then
    ELAPSED=$((WORKFLOW_ATTEMPTS * 30 / 60))
    if [[ -n "$RUN_ID" ]]; then
      echo "  ... workflow $RUN_STATUS (${ELAPSED}m elapsed)"
    else
      echo "  ... waiting for workflow run (${ELAPSED}m elapsed)"
    fi
  fi
  sleep 30
done

if [[ $WORKFLOW_ATTEMPTS -ge $WORKFLOW_MAX ]]; then
  echo "  ⚠ Timed out waiting for workflow. Skipping publish."
  echo "  → https://github.com/cortexkit/magic-context/actions"
  exit 0
fi

# Step 9: Prompt for release notes
echo ""
NOTES=""
if [[ -n "$NOTES_FILE" ]]; then
  echo "→ Using release notes from $NOTES_FILE"
  NOTES=$(cat "$NOTES_FILE")
elif have_tty; then
  echo "→ Enter release notes (end with Ctrl-D or empty line):"
  echo "  (markdown supported)"
  echo ""
  while IFS= read -r line </dev/tty; do
    [[ -z "$line" ]] && break
    NOTES="$NOTES$line
"
  done
else
  echo "→ No tty available and no --notes-file provided."
  echo "  Skipping publish so the release is not published with empty notes."
  echo "  Run manually: gh release edit $TAG --repo cortexkit/magic-context --notes-file NOTES.md --draft=false"
  exit 0
fi

# Step 10: Publish the release
echo ""
echo "→ Publishing release..."
if [[ -n "$NOTES" ]]; then
  gh release edit "$TAG" --repo cortexkit/magic-context --draft=false --notes "$NOTES"
else
  gh release edit "$TAG" --repo cortexkit/magic-context --draft=false
fi

echo ""
echo "  ✓ Dashboard $TAG released!"
echo "  → https://github.com/cortexkit/magic-context/releases/tag/$TAG"
