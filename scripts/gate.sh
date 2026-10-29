#!/usr/bin/env bash
# CI's workflow is the lane manifest; its shared scripts own the actual commands.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
exec bun scripts/gate.ts "$@"
