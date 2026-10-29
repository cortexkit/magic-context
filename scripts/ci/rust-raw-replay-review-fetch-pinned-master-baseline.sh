#!/usr/bin/env bash
# Fetch immutable baseline objects without needing write access to the source checkout's Git metadata.
set -euo pipefail
baseline_commit="$(tr -d '\r\n' < scripts/rust-raw-replay-baseline.commit)"
if [[ ! "$baseline_commit" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Invalid pinned Rust raw replay baseline commit: $baseline_commit" >&2
  exit 1
fi
remote="$(git remote get-url origin)"
repository="$(mktemp -d "$RUNNER_TEMP/raw-replay-git.XXXXXX")"
git clone --shared --bare "$GITHUB_WORKSPACE" "$repository"
git -C "$repository" remote set-url origin "$remote"
baseline_archive="$RUNNER_TEMP/rust-raw-replay-baseline.tar"
(
  cd "$repository"
  git fetch --no-tags --depth=1 origin "$baseline_commit"
  git cat-file -e "${baseline_commit}^{commit}"
  git archive --format=tar "$baseline_commit" \
    crates/mc-module/src packages/plugin/src packages/plugin/package.json \
    packages/retina-local-fs/src packages/retina-local-fs/package.json package.json \
    > "$baseline_archive"
)
test -s "$baseline_archive"
printf 'Pinned Rust raw replay baseline: %s\n' "$baseline_commit"
