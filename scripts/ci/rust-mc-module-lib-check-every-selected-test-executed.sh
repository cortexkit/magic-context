#!/usr/bin/env bash
# Shared by GitHub Actions and scripts/gate.sh; workflow orchestration stays in YAML.
set -euo pipefail
python3 scripts/check-nextest-inventory.py --junit ci-rust-lib "lib-${1:?missing workflow argument}" target/nextest/ci/junit.xml
