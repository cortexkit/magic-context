#!/usr/bin/env bash
# Shared by GitHub Actions and scripts/gate.sh; workflow orchestration stays in YAML.
set -euo pipefail
bash scripts/test-rust-raw-replay.sh \
  packages/plugin/review-tests/rust-cache-review.test.ts \
  packages/plugin/review-tests/rust-cache-r2.test.ts \
  packages/plugin/review-tests/rust-cache-restart.test.ts \
  -t 'round-two|provider-invisible|JSON number|sorted digest|SIGKILL|release recovery census|raw ctx_reduce|durable replay cost|unchanged ID-less native|no-freeze SQL|seed (a19f37|badc0de|c001d00d|92e41b|67d5a3)'
