#!/usr/bin/env bash
set -euo pipefail

ROOT=/test/hermetic
export HOME="$ROOT/home"
export XDG_CONFIG_HOME="$ROOT/config"
export XDG_DATA_HOME="$ROOT/data"
export XDG_STATE_HOME="$ROOT/state"
export XDG_CACHE_HOME="$ROOT/cache"
export OPENCODE_DB=opencode2.db
export OPENCODE_DISABLE_DEFAULT_PLUGINS=true
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME"

command -v opencode2 >/dev/null || { echo "FAIL opencode2 binary missing"; exit 1; }
[[ "$(opencode2 --version)" == "opencode v${OPENCODE2_VERSION}" ]] || {
    echo "FAIL unexpected OpenCode version: $(opencode2 --version)"
    exit 1
}
[[ "$(node -p "require('/test/host/node_modules/@opencode/cli/package.json').version")" == "$OPENCODE2_VERSION" ]]
[[ "$(node -p "require('/test/host/node_modules/@opencode/cli-linux-x64/package.json').version")" == "$OPENCODE2_VERSION" ]]

PLUGIN_PACKAGE=/test/mc-install/node_modules/@cortexkit/opencode-magic-context
PLUGIN_VERSION=$(node -p "require('$PLUGIN_PACKAGE/package.json').version")
export MC_PLUGIN_SPEC="@cortexkit/opencode-magic-context@$PLUGIN_VERSION"
node --input-type=module <<'JS'
import { readFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync("/test/mc-install/node_modules/@cortexkit/opencode-magic-context/package.json"));
const forbidden = Object.keys(pkg.dependencies ?? {}).filter((name) => name.startsWith("@opencode/"));
if (forbidden.length) throw new Error(`published dependencies contain forbidden v2 packages: ${forbidden.join(", ")}`);
JS

# Seed the exact package in GA's private Npm generation cache. The fixed package
# spec then resolves through its exports map without fetching the released npm
# artifact, while both server and TUI exercise Host.resolve's name-target path.
CACHE_GENERATION="$XDG_CACHE_HOME/opencode/npm/$MC_PLUGIN_SPEC/1"
mkdir -p "$CACHE_GENERATION"
cp -a /test/mc-install/node_modules "$CACHE_GENERATION/node_modules"

bun /test/lane.mjs

test -s "$XDG_DATA_HOME/opencode/opencode2.db" || {
    echo "FAIL hermetic OpenCode database missing"
    exit 1
}
test -s "$XDG_DATA_HOME/cortexkit/magic-context/context.db" || {
    echo "FAIL hermetic Magic Context database missing"
    exit 1
}

SESSION_ID=$(tr -d '\n' < /test/session-id)
rm -f /tmp/opencode2-tui.log
# Wait for the sidebar marker rather than for a fixed wall-clock: on a loaded
# CI runner the TUI boot plus plugin load plus first paint took longer than the
# old 20 s cap and failed a lane whose product code had not changed, while a
# quiet runner finishes in a few seconds. The bound below is a ceiling, not a
# budget: the TUI is stopped the moment the marker appears.
TUI_MARKER_CEILING_SECONDS=120
set +e
script -qefc "stty rows 40 cols 160; opencode2 --standalone --print-logs --session '$SESSION_ID'" \
    /tmp/opencode2-tui.log >/tmp/opencode2-tui.stdout 2>&1 &
TUI_PID=$!
TUI_MARKER_SEEN=0
for ((elapsed = 0; elapsed < TUI_MARKER_CEILING_SECONDS; elapsed++)); do
    # "Knowledge" is a section title only the real sidebar component draws,
    # under its "MAGIC CONTEXT" header. The plugin also has a four-line
    # plain-text projection for hosts that register no OpenTUI runtime
    # modules; it has no section titles and writes the header in mixed case.
    # Matching both is what makes this lane fail if the Linux GA host silently
    # lands on the fallback.
    if grep -aFq "Knowledge" /tmp/opencode2-tui.log 2>/dev/null \
        && grep -aFq "MAGIC CONTEXT" /tmp/opencode2-tui.log 2>/dev/null; then
        TUI_MARKER_SEEN=1
        echo "TUI sidebar marker painted after ${elapsed}s"
        break
    fi
    if ! kill -0 "$TUI_PID" 2>/dev/null; then
        break
    fi
    sleep 1
done
kill -TERM "$TUI_PID" 2>/dev/null
wait "$TUI_PID"
TUI_EXIT=$?
set -e
if [[ $TUI_MARKER_SEEN -eq 0 && $TUI_EXIT -ne 0 && $TUI_EXIT -ne 124 && $TUI_EXIT -ne 143 ]]; then
    echo "FAIL OpenCode 2 TUI exited unexpectedly: $TUI_EXIT"
    tail -80 /tmp/opencode2-tui.stdout
    exit 1
fi
if [[ $TUI_MARKER_SEEN -eq 0 ]]; then
    echo "FAIL GA TUI did not execute setup and paint the Magic Context sidebar component"
    tail -80 /tmp/opencode2-tui.stdout
    exit 1
fi

echo "PASS @opencode/cli@$OPENCODE2_VERSION and @opencode/cli-linux-x64@$OPENCODE2_VERSION exact pins"
echo "PASS GA TUI executed setup and painted the RPC-backed sidebar component"
echo "All OpenCode $OPENCODE2_VERSION Docker E2E checks passed."
