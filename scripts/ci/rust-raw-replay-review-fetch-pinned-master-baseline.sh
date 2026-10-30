#!/usr/bin/env bash
# Fetch immutable baseline objects without needing write access to the source checkout's Git metadata.
set -euo pipefail
baseline_commit="$(tr -d '\r\n' < scripts/rust-raw-replay-baseline.commit)"
if [[ ! "$baseline_commit" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Invalid pinned Rust raw replay baseline commit: $baseline_commit" >&2
  exit 1
fi
remote="${GATE_GIT_REMOTE:-$(git remote get-url origin)}"
# Hosted snapshots may record a mirror path that is not mounted in the job.
# The versioned package metadata names the same upstream; the commit pin remains exact.
if [[ "$remote" == /* && ! -e "$remote" ]]; then
  remote="$(bun -e 'const p = await Bun.file("packages/plugin/package.json").json(); const r = typeof p.repository === "string" ? p.repository : p.repository?.url; if (typeof r !== "string" || !/^(?:git\+)?https:\/\/|^ssh:\/\/|^git@|^file:\/\//.test(r)) throw new Error("No usable declared repository URL for pinned baseline fetch"); console.log(r.replace(/^git\+/, ""));')"
  printf 'Pinned baseline fetch uses the declared repository URL because the local mirror is not mounted\n'
fi
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
