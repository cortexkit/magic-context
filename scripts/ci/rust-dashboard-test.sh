#!/usr/bin/env bash
# Shared by GitHub Actions and scripts/gate.sh; workflow orchestration stays in YAML.
set -euo pipefail

# Tauri regenerates tracked schemas during the build. Local build-server checkouts
# are read-only, so copy the dashboard but keep sibling fixture packages read-only.
if [[ "${GATE_DASHBOARD_WRITABLE_COPY:-0}" == 1 ]]; then
  root="$PWD"
  mkdir -p target/scratch packages/dashboard/src-tauri/target
  scratch="$(mktemp -d "$root/target/scratch/dashboard-tests.XXXXXX")"
  mkdir -p "$scratch/packages/dashboard"
  tar -C packages/dashboard --exclude='./src-tauri/target' -cf - . |
    tar -C "$scratch/packages/dashboard" -xf -
  # Cargo walks up from the copy and otherwise finds the repository workspace,
  # which excludes only the original dashboard path, not this scratch copy.
  printf '\n[workspace]\n' >> "$scratch/packages/dashboard/src-tauri/Cargo.toml"
  for package in "$root"/packages/*; do
    if [[ "$package" != "$root/packages/dashboard" ]]; then
      ln -s "$package" "$scratch/packages/"
    fi
  done
  ln -s "$root/node_modules" "$scratch/node_modules"
  ln -s "$root/test-vectors" "$scratch/test-vectors"
  # Reuse the normal Cargo target instead of recompiling into each scratch copy.
  ln -s "$root/packages/dashboard/src-tauri/target" "$scratch/packages/dashboard/src-tauri/target"
  cd "$scratch"
fi

cargo test --manifest-path packages/dashboard/src-tauri/Cargo.toml --locked --no-fail-fast
