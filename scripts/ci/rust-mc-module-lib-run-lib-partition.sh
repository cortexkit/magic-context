#!/usr/bin/env bash
# Shared by GitHub Actions and scripts/gate.sh; workflow orchestration stays in YAML.
set -euo pipefail
if [[ "${1:?missing workflow argument}" == parity ]]; then
  cargo nextest run --archive-file ci-rust-lib/archive.tar.zst --workspace-remap "$GITHUB_WORKSPACE" --profile ci --no-fail-fast --failure-output immediate-final --run-ignored all -E "$MC_PARITY_FILTER"
  exit
fi
cargo nextest run --archive-file ci-rust-lib/archive.tar.zst --workspace-remap "$GITHUB_WORKSPACE" --profile ci --no-fail-fast --failure-output immediate-final --partition "hash:${1:?missing workflow argument}/4" -E "not ($MC_PARITY_FILTER)"
