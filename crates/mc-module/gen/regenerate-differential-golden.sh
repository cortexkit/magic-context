#!/usr/bin/env bash
set -euo pipefail

# Rebuild differential fixtures DG-1 through DG-6 and update the committed input-provenance hash.
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
exec bun "$repo_root/crates/mc-module/gen/gen-differential-golden.ts"
