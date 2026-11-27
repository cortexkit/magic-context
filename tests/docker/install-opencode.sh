#!/usr/bin/env bash
# Install the OpenCode CLI for E2E tests, using the GitHub API only as a fallback.
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
    # A deadline of zero disables the elapsed time limit. The caller caps each request.
    local label="$1" limit="$2" delay_step="$3" deadline="$4"
    shift 4
    local attempt=0 delay remaining
    while (( attempt < limit && (deadline == 0 || SECONDS < deadline) )); do
        attempt=$((attempt + 1))
        if "$@"; then return 0; fi
        if (( attempt == limit )); then break; fi
        delay=$((attempt * delay_step))
        if (( deadline != 0 )); then
            remaining=$((deadline - SECONDS))
            if (( remaining <= 0 )); then break; fi
            if (( delay >= remaining )); then delay=$((remaining - 1)); fi
        fi
        echo "install-opencode: $label failed (attempt $attempt); retrying" >&2
        sleep "$delay"
    done
    echo "install-opencode: $label failed after $attempt attempts" >&2
    return 1
}

installer="$(mktemp)"
trap 'rm -f "$installer"' EXIT

fetch_installer() {
    curl -fsSL --connect-timeout 15 --max-time 120 https://opencode.ai/install -o "$installer" \
        && [ -s "$installer" ]
}
retry "installer fetch" 5 5 0 fetch_installer

version="${OPENCODE_VERSION:-1.18.31}"
if [ "$version" = latest ]; then
    set_latest_version() {
        local tag="${1#v}"
        if [[ ! "$tag" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]]; then
            echo "install-opencode: latest release lookup did not return a version tag" >&2
            return 1
        fi
        version="$tag"
    }

    resolve_latest_redirect() {
        local latest_url remaining=$((lookup_deadline - SECONDS))
        if (( remaining <= 0 )); then return 1; fi
        if (( remaining > 30 )); then remaining=30; fi
        latest_url="$(curl -fsSL --connect-timeout 15 --max-time "$remaining" -o /dev/null -w '%{url_effective}' \
            https://github.com/anomalyco/opencode/releases/latest)" || return 1
        set_latest_version "${latest_url##*/}"
    }

    resolve_latest_api() {
        local response tag token="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
        local headers=(-H "Accept: application/vnd.github+json")
        if [ -n "$token" ]; then headers+=(-H "Authorization: Bearer $token"); fi
        response="$(curl -fsS --connect-timeout 15 --max-time 30 "${headers[@]}" \
            https://api.github.com/repos/anomalyco/opencode/releases/latest)" || return 1
        tag="$(node -e '
            const tag = JSON.parse(require("node:fs").readFileSync(0, "utf8")).tag_name;
            if (typeof tag !== "string") process.exit(1);
            process.stdout.write(tag);
        ' <<< "$response" 2>/dev/null)" || return 1
        set_latest_version "$tag"
    }

    # Ten growing pauses (5 through 50 seconds) leave time for a late success.
    # Cap wall time too, so hanging requests cannot extend the redirect budget.
    latest_retry_step="${OPENCODE_LATEST_RETRY_STEP_SECONDS:-5}"
    if [[ ! "$latest_retry_step" =~ ^(0|[1-9][0-9]{0,2})$ ]]; then
        echo "install-opencode: OPENCODE_LATEST_RETRY_STEP_SECONDS must be an integer from 0 to 999" >&2
        exit 1
    fi
    lookup_deadline=$((SECONDS + 300))
    if retry "latest release redirect lookup" 11 "$latest_retry_step" "$lookup_deadline" resolve_latest_redirect; then
        echo "install-opencode: resolved latest version via GitHub release redirect"
    elif resolve_latest_api; then
        echo "install-opencode: resolved latest version via GitHub releases API"
    else
        echo "install-opencode: could not resolve latest OpenCode release via GitHub release redirect or releases API" >&2
        exit 1
    fi
fi
echo "install-opencode: installing opencode v${version}"

run_installer() { bash "$installer" --version "$version"; }
retry "installer run" 5 5 0 run_installer

# The installer writes to $HOME/.opencode/bin (/root inside the images, the runner's
# home on a CI host).
export PATH="$HOME/.opencode/bin:$PATH"
if ! command -v opencode >/dev/null 2>&1; then
    echo "install-opencode: installer completed but no opencode binary on PATH" >&2
    exit 1
fi
opencode --version
