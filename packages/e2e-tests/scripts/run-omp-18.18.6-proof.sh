#!/usr/bin/env bash
# Exact published host and reporter plugin sources keep the regression reproducible.
set -euo pipefail
cd "$(dirname "$0")/../../.."
scenario="${1:-stock}"
out="${2:?usage: run-omp-18.18.6-proof.sh scenario new-output-directory [plugin-entry]}"
plugin="${3:-packages/pi-plugin/dist/index.js}"
mkdir -p target/scratch/omp-683-host
printf '%s\n' '{"private":true,"type":"module","dependencies":{"@oh-my-pi/pi-coding-agent":"18.18.6"}}' > target/scratch/omp-683-host/package.json
(cd target/scratch/omp-683-host && bun install)
if [[ "$scenario" == simple-english || "$scenario" == superpowers ]]; then
  case "$scenario" in
    simple-english) repo=AminBlg/SimpleEnglish; commit=32ea2d3f4404bfbff162c1861e5ae4f1bcc628b3; version=2.1.1 ;;
    superpowers) repo=obra/superpowers; commit=22f0b463e7a5e579904dd6211a520321035526f7; version=7.0.2 ;;
  esac
  mkdir -p "target/scratch/$scenario-$version"
  curl -fsSL "https://codeload.github.com/$repo/tar.gz/$commit" | tar -xz --strip-components=1 -C "target/scratch/$scenario-$version"
fi
bun packages/e2e-tests/scripts/omp-18.18.6-dispatch-proof.ts target/scratch/omp-683-host "$out" "$plugin" "$scenario"
