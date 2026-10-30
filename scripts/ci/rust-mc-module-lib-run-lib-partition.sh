#!/usr/bin/env bash
# Shared by GitHub Actions and scripts/gate.sh; workflow orchestration stays in YAML.
set -euo pipefail
cargo nextest run --archive-file ci-rust-lib/archive.tar.zst --workspace-remap "$GITHUB_WORKSPACE" --profile ci --no-fail-fast --failure-output immediate-final --partition "hash:${1:?missing workflow argument}/4"
