#!/usr/bin/env bash
set -euo pipefail

version=2.15.0
# SHA256SUMS from the upstream v2.15.0 release. Verify the pinned archive
# before extracting or executing the server.
case "$(uname -s):$(uname -m)" in
  Linux:x86_64) platform=linux-amd64; sha256=5d2c51caca950333aba84911df7d377f826f3a59ec36061c6539105084f65c92 ;;
  Linux:aarch64) platform=linux-arm64; sha256=cdc208f5a3f42963a52b6ab06ef65626bb870315dc936e26ba571780c6351112 ;;
  *) printf 'No pinned nats-server archive for %s/%s\n' "$(uname -s)" "$(uname -m)" >&2; exit 1 ;;
esac

work=$(mktemp -d "${RUNNER_TEMP:?}/mc-nats.XXXXXXXX")
name="nats-server-v${version}-${platform}"
archive="$work/$name.tar.gz"
curl --proto '=https' --fail --silent --show-error --location --retry 3 \
  --connect-timeout 15 --max-time 120 --output "$archive" \
  "https://github.com/nats-io/nats-server/releases/download/v${version}/$name.tar.gz"
printf '%s  %s\n' "$sha256" "$archive" | sha256sum --check --strict
tar -xzf "$archive" -C "$work" "$name/nats-server"
"$work/$name/nats-server" --version
printf '%s\n' "$work/$name" >> "${GITHUB_PATH:?}"
