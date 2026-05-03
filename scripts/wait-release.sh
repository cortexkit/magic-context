#!/usr/bin/env bash
# Wait for the GitHub Actions release workflow to complete for a given tag.
# Usage: ./scripts/wait-release.sh v0.6.1
# Polls every 5 seconds, exits 0 on success, 1 on failure.

set -euo pipefail

TAG="${1:?Usage: wait-release.sh <tag>}"
REPO="cortexkit/magic-context"
INTERVAL=5

echo "⏳ Waiting for release workflow on ${TAG}..."

while true; do
  # Get the latest run for the release workflow triggered by this tag
  RUN_JSON=$(gh run list --repo "$REPO" --workflow release.yml --branch "$TAG" --limit 1 --json status,conclusion,databaseId 2>/dev/null || echo "[]")

  STATUS=$(echo "$RUN_JSON" | jq -r '.[0].status // "not_found"')
  CONCLUSION=$(echo "$RUN_JSON" | jq -r '.[0].conclusion // ""')
  RUN_ID=$(echo "$RUN_JSON" | jq -r '.[0].databaseId // ""')

  if [ "$STATUS" = "not_found" ]; then
    printf "\r  Workflow not started yet..."
    sleep "$INTERVAL"
    continue
  fi

  if [ "$STATUS" = "completed" ]; then
    if [ "$CONCLUSION" = "success" ]; then
      echo ""
      echo "✅ Release workflow succeeded (run $RUN_ID)"
      echo "   https://github.com/$REPO/actions/runs/$RUN_ID"
      exit 0
    else
      echo ""
      echo "❌ Release workflow failed: conclusion=$CONCLUSION (run $RUN_ID)"
      echo "   https://github.com/$REPO/actions/runs/$RUN_ID"
      exit 1
    fi
  fi

  printf "\r  Status: %-12s (run $RUN_ID)" "$STATUS"
  sleep "$INTERVAL"
done
