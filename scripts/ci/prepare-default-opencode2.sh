#!/usr/bin/env bash
# Cached dependency trees can retain the publisher's unrun-postinstall command instead of the native host.
set -euo pipefail
version="$(bun -e 'const { pinnedOpenCode2Version } = await import("./packages/e2e-tests/src/opencode2-runner/cli-resolution.ts"); console.log(pinnedOpenCode2Version());')"
candidate="$(bun -e 'const { CLI } = await import("./packages/e2e-tests/src/opencode2-runner/spawn.ts"); console.log(CLI);')"
probe="$RUNNER_TEMP/default-opencode2-probe.log"
verify="$GITHUB_WORKSPACE/scripts/ci/e2e-host-opencode2-verify-the-ga-host-binary.sh"
if MC_E2E_OPENCODE2_CLI="$candidate" MC_E2E_OPENCODE2_VERSION="$version" bash "$verify" > "$probe" 2>&1; then
  printf 'MC_E2E_OPENCODE2_CLI=%s\n' "$candidate" >> "$GITHUB_ENV"
  printf 'OpenCode 2 default host: %s (verified cached source, version %s)\n' "$candidate" "$version"
  exit 0
fi
if ! python3 - "$candidate" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
if not path.is_file():
    raise SystemExit(1)
with path.open("rb") as source:
    header = source.read(2048)
raise SystemExit(0 if b"@opencode/cli's postinstall script was not run" in header else 1)
PY
then
  printf 'OpenCode 2 cached host failed exact-version verification: %s\n' "$candidate" >&2
  cat "$probe" >&2
  exit 1
fi
printf 'OpenCode 2 cached host is an unrun-postinstall command; installing the real pinned host %s\n' "$version"
bash "$GITHUB_WORKSPACE/scripts/ci/e2e-host-opencode2-install-the-selected-exact-host.sh" "$version"
selected=""
while IFS= read -r line; do
  case "$line" in MC_E2E_OPENCODE2_CLI=*) selected="${line#MC_E2E_OPENCODE2_CLI=}" ;; esac
done < "$GITHUB_ENV"
test -n "$selected"
MC_E2E_OPENCODE2_CLI="$selected" MC_E2E_OPENCODE2_VERSION="$version" bash "$verify"
printf 'OpenCode 2 default host: %s (verified job-local install, version %s)\n' "$selected" "$version"
