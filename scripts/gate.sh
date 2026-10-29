#!/usr/bin/env bash
# CI's workflow is the lane manifest; its shared scripts own the actual commands.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
command -v bun >/dev/null || { printf 'Missing OS prerequisite: bun\n' >&2; exit 1; }
bun scripts/check-bun.mjs
exec bun scripts/gate.ts "$@"
