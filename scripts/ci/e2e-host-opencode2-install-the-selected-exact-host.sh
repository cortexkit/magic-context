#!/usr/bin/env bash
# Shared by GitHub Actions and scripts/gate.sh; workflow orchestration stays in YAML.
set -euo pipefail
version="${1:?missing workflow argument}"
host="$RUNNER_TEMP/oc2-host"
mkdir -p "$host"
case "$version" in
  2.0.*|2.1.0)
    # These hosts use the schema packages already pinned in the workspace.
    printf '{"private":true,"dependencies":{"@opencode/cli":"%s"},"trustedDependencies":["@opencode/cli"]}\n' "$version" > "$host/package.json"
    bun install --cwd "$host"
    ;;
  *)
    # The guard must use the selected host's schema, not a pinned older one.
    printf '{"private":true,"dependencies":{"@opencode/cli":"%s","@opencode/ai":"%s"},"trustedDependencies":["@opencode/cli"]}\n' "$version" "$version" > "$host/package.json"
    bun install --cwd "$host" --linker=hoisted
    printf 'MC_E2E_OPENCODE2_AI_ROOT=%s\n' "$host" >> "$GITHUB_ENV"
    ;;
esac
printf 'MC_E2E_OPENCODE2_CLI=%s/node_modules/@opencode/cli/bin/opencode.exe\n' "$host" >> "$GITHUB_ENV"
