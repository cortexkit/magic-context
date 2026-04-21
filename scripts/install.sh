#!/usr/bin/env bash
set -euo pipefail

# Magic Context — Interactive Setup
# Usage: curl -fsSL https://raw.githubusercontent.com/cortexkit/opencode-magic-context/master/scripts/install.sh | bash

PACKAGE="@cortexkit/opencode-magic-context"
MIN_NODE_MAJOR=20
MIN_NODE_MINOR=12

# Return 0 if system node satisfies the minimum version.
check_node_version() {
  if ! command -v node &>/dev/null; then
    return 1
  fi
  local version major minor
  version=$(node -v 2>/dev/null | sed 's/^v//')
  major=$(echo "$version" | cut -d. -f1)
  minor=$(echo "$version" | cut -d. -f2)
  if [ "$major" -lt "$MIN_NODE_MAJOR" ]; then
    return 1
  fi
  if [ "$major" -eq "$MIN_NODE_MAJOR" ] && [ "$minor" -lt "$MIN_NODE_MINOR" ]; then
    return 1
  fi
  return 0
}

main() {
  echo ""
  echo "  ✨ Magic Context — Setup"
  echo "  ────────────────────────"
  echo ""

  # Preferred path: bun is present AND a modern Node is available on PATH.
  # bunx (without --bun) will execute the CLI's node shebang, so the setup
  # process runs under Node. This matters because @clack/prompts' interactive
  # select() does not currently work under Bun when stdin is redirected from
  # /dev/tty (curl | bash path) — see diagnostic notes in src/cli/prompts.ts.
  if command -v bun &>/dev/null && check_node_version; then
    echo "  → Using bunx (delegating to node)"
    echo ""
    bunx "$PACKAGE" setup </dev/tty
  elif command -v npx &>/dev/null && check_node_version; then
    NODE_VERSION=$(node -v 2>/dev/null | sed 's/^v//')
    echo "  → Using npx (Node $NODE_VERSION)"
    echo ""
    npx -y "$PACKAGE" setup </dev/tty
  elif command -v bun &>/dev/null; then
    # Bun is installed but Node is missing or too old. Force the bun runtime
    # as a last resort; interactive select prompts may not work under
    # curl | bash in this path. Users can re-run directly with:
    #   bunx --bun @cortexkit/opencode-magic-context@latest setup
    echo "  ⚠ Node $MIN_NODE_MAJOR.$MIN_NODE_MINOR+ is required for the piped installer."
    echo "    Falling back to Bun runtime — if the historian model picker freezes,"
    echo "    re-run directly:"
    echo ""
    echo "      bunx --bun $PACKAGE@latest setup"
    echo ""
    bunx --bun "$PACKAGE" setup </dev/tty
  else
    echo "  ✗ Neither a compatible Node (>= $MIN_NODE_MAJOR.$MIN_NODE_MINOR) nor bun found."
    echo ""
    echo "  Install one of:"
    echo "    • bun:  curl -fsSL https://bun.sh/install | bash"
    echo "    • node: https://nodejs.org (>= $MIN_NODE_MAJOR.$MIN_NODE_MINOR)"
    echo ""
    exit 1
  fi
}

main "$@"
