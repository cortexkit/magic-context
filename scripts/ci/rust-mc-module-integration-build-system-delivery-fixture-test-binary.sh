#!/usr/bin/env bash
# Shared by GitHub Actions and scripts/gate.sh; workflow orchestration stays in YAML.
set -euo pipefail
set -euo pipefail
artifacts="$RUNNER_TEMP/mc-module-lib-test-artifacts.json"
cargo test --locked -p mc-module --lib --no-run --no-fail-fast --message-format=json > "$artifacts"
binary="$(python3 - "$artifacts" <<'PY'
import json
import sys

matches = []
with open(sys.argv[1]) as messages:
    for line in messages:
        message = json.loads(line)
        target = message.get("target", {})
        profile = message.get("profile", {})
        if (
            message.get("reason") == "compiler-artifact"
            and target.get("name") == "mc_module"
            and "lib" in target.get("kind", [])
            and profile.get("test")
            and message.get("executable")
        ):
            matches.append(message["executable"])

if len(matches) != 1:
    raise SystemExit(f"expected one mc-module lib test binary, found {len(matches)}")
print(matches[0])
PY
)"
test -x "$binary"
echo "MC_SYSTEM_DELIVERY_FIXTURE_BINARY=$binary" >> "$GITHUB_ENV"
printf 'Prebuilt system-delivery fixture: %s\n' "$binary"
