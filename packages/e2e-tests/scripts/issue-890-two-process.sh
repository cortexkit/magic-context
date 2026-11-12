#!/usr/bin/env bash
set -euo pipefail

# Two OpenCode 2 servers on one throwaway store, both loading Magic Context:
# checks that hidden summarizer runs still succeed (see issue-890-two-process.ts
# for exactly what is asserted).
#
# Run from the repository root on Linux, with network access for the host install:
#   bash packages/e2e-tests/scripts/issue-890-two-process.sh
# Optional:
#   ISSUE_890_VERSION=2.2.6     OpenCode 2 version to install (default 2.2.7)
#   ISSUE_890_OPENCHAMBER=1     also load OpenChamber's generated rate-limit retry
#                               plugin, extracted from a pinned commit and checked
#                               against a pinned SHA-256
#   ISSUE_890_KEEP=1            run with keep_subagents=true
#   ISSUE_890_OUTPUT=<path>     where to write the evidence JSON
#
# Installs only an isolated host/schema pair under target/scratch; the package
# manifests, lockfile and live host configuration stay intact.
version="${ISSUE_890_VERSION:-2.2.7}"
install="$PWD/target/scratch/issue-890-host"
mkdir -p "$install" target/scratch/issue-890-failover
printf '{"private":true,"dependencies":{"@opencode/cli":"%s","@opencode/ai":"%s"},"trustedDependencies":["@opencode/cli"]}\n' "$version" "$version" > "$install/package.json"
bun install --cwd "$install" --linker=hoisted
bun install --frozen-lockfile
bun run --cwd packages/plugin build > target/scratch/issue-890-build.log 2>&1

if [[ "${ISSUE_890_OPENCHAMBER:-0}" == 1 ]]; then
  # Extract the actual generated retry plugin, not OpenChamber's server runtime.
  bun -e '
    const url = "https://raw.githubusercontent.com/openchamber/openchamber/f5caf83c743747d4f5394b4fb2c1bd242f00bb53/packages/web/server/lib/limit-failover/runtime.js";
    const response = await fetch(url);
    if (!response.ok) throw new Error(`OpenChamber source: ${response.status}`);
    const match = (await response.text()).match(/const PLUGIN_SOURCE = `([\s\S]*?)`;/);
    if (!match) throw new Error("Missing generated failover plugin");
    const source = Function("ROUTE", "PLUGIN_ID", "return `" + match[1] + "`;")("/api/openchamber/limit-failover", "openchamber-limit-failover");
    const hash = new Bun.CryptoHasher("sha256").update(source).digest("hex");
    if (hash !== "7dd15a239d243aa8f81335d57c336e59cc3fee1f8ae1ba5c2c6cb69981ff6a09") throw new Error(`Generated plugin changed: ${hash}`);
    await Bun.write("target/scratch/issue-890-failover/index.js", source);
    await Bun.write("target/scratch/issue-890-failover/package.json", JSON.stringify({name: "openchamber-limit-failover", private: true, type: "module", exports: {".": "./index.js"}}));
    console.log(`OpenChamber generated retry plugin SHA256 ${hash}`);
  '
  export ISSUE_890_FAILOVER_PLUGIN="$PWD/target/scratch/issue-890-failover"
fi

MC_E2E_OPENCODE2_CLI="$install/node_modules/@opencode/cli/bin/opencode.exe" \
MC_E2E_OPENCODE2_VERSION="$version" MC_E2E_OPENCODE2_AI_ROOT="$install" \
  bun packages/e2e-tests/scripts/issue-890-two-process.ts
