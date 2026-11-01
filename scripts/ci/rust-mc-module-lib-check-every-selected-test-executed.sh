#!/usr/bin/env bash
# Shared by GitHub Actions and scripts/gate.sh; workflow orchestration stays in YAML.
set -euo pipefail
partition="lib-${1:?missing workflow argument}"
if [[ "$1" == parity ]]; then partition=parity; fi
python3 scripts/check-nextest-inventory.py --junit ci-rust-lib "$partition" target/nextest/ci/junit.xml
