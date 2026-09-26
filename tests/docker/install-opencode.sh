#!/usr/bin/env bash
# Install the OpenCode CLI inside an e2e image, loudly and without the GitHub API.
#
# The official one-liner (`curl -fsSL https://opencode.ai/install | bash`) fails in
# two silent or recurring ways from CI:
#   - a transient reset on the installer fetch leaves bash reading an empty script,
#     the pipeline exits 0, the Docker layer is marked DONE, and every test in the
#     image later fails with `opencode: not found` (release gate, 2026-09-18);
#   - with no version pinned the installer resolves "latest" through
#     api.github.com, which is rate-limited per source IP and routinely exhausted
#     on shared runner egress ("Failed to fetch version information", release
#     gates on 2026-09-13, 09-15 and again locally on 09-18).
# So: download the installer to a file (its fetch has its own exit status),
# install the tested OpenCode 1.x host (or an explicit OPENCODE_VERSION), retry each
# network step with backoff, and assert the binary runs before the layer ends.
# This script installs OpenCode 1.x through its release installer. OpenCode 2 is not
# installed this way: its images install `@opencode/cli` from npm (see
# tests/docker/opencode2/Dockerfile), and this installer cannot unpack a 2.x release.
set -euo pipefail

retry() {
    # retry <label> <cmd...>: five attempts with linear backoff, loud on give-up.
    local label="$1"
    shift
    local attempt=0
    until "$@"; do
        attempt=$((attempt + 1))
        if [ "$attempt" -ge 5 ]; then
            echo "install-opencode: $label failed after $attempt attempts" >&2
            return 1
        fi
        echo "install-opencode: $label failed (attempt $attempt); retrying" >&2
        sleep $((attempt * 5))
    done
}

installer="$(mktemp)"
trap 'rm -f "$installer"' EXIT

fetch_installer() {
    curl -fsSL --connect-timeout 15 --max-time 120 https://opencode.ai/install -o "$installer" \
        && [ -s "$installer" ]
}
retry "installer fetch" fetch_installer

version="${OPENCODE_VERSION:-1.18.31}"
if [ "$version" = latest ]; then
    # Resolve the release tag through GitHub's redirect, not its rate-limited API.
    resolve_latest_version() {
        local latest_url
        latest_url="$(curl -fsSL --connect-timeout 15 --max-time 120 -o /dev/null -w '%{url_effective}' https://github.com/anomalyco/opencode/releases/latest)" || return 1
        version="${latest_url##*/}"
        version="${version#v}"
        if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]]; then
            echo "install-opencode: could not resolve latest release version from $latest_url" >&2
            return 1
        fi
    }
    retry "latest version lookup" resolve_latest_version
fi
echo "install-opencode: installing opencode v${version}"

run_installer() { bash "$installer" --version "$version"; }
retry "installer run" run_installer

# The installer writes to $HOME/.opencode/bin (/root inside the images, the runner's
# home on a CI host).
export PATH="$HOME/.opencode/bin:$PATH"
if ! command -v opencode >/dev/null 2>&1; then
    echo "install-opencode: installer completed but no opencode binary on PATH" >&2
    exit 1
fi
opencode --version
