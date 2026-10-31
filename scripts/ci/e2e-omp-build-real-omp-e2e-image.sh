#!/usr/bin/env bash
# Shared by GitHub Actions and scripts/gate.sh; workflow orchestration stays in YAML.
set -euo pipefail
docker build \
  --platform linux/amd64 \
  -f tests/docker/Dockerfile.omp \
  -t mc-e2e-omp \
  .
