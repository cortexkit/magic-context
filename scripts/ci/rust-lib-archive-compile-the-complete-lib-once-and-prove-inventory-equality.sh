#!/usr/bin/env bash
# Shared by GitHub Actions and scripts/gate.sh; workflow orchestration stays in YAML.
set -euo pipefail
mkdir -p ci-rust-lib
cargo nextest --version
cargo nextest archive --locked -p mc-module --lib --archive-file ci-rust-lib/archive.tar.zst
cargo test --locked -p mc-module --lib -- --list > ci-rust-lib/cargo-list.txt
cargo test --locked -p mc-module --lib -- --list --ignored > ci-rust-lib/cargo-ignored.txt
cargo nextest list --archive-file ci-rust-lib/archive.tar.zst --run-ignored all --message-format json > ci-rust-lib/all.json
for shard in 1 2 3 4; do
  cargo nextest list --archive-file ci-rust-lib/archive.tar.zst --run-ignored all --partition "hash:$shard/4" --message-format json > "ci-rust-lib/lib-$shard.json"
done
python3 scripts/check-nextest-inventory.py ci-rust-lib
diff -u ci-rust-lib/cargo-names.txt ci-rust-lib/union-names.txt
rustc -vV > ci-rust-lib/rustc.txt
printf '%s\n' "$GITHUB_SHA" > ci-rust-lib/commit.txt
sha256sum ci-rust-lib/archive.tar.zst > ci-rust-lib/archive.sha256
