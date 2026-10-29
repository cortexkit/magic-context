#!/usr/bin/env bash
set -euo pipefail
lane=${1:?usage: prepare-container-image.sh lane image}
image=${2:?image tag required}
case "$lane" in opencode-1|opencode-2|omp) ;; *) exit 2 ;; esac
repo=$(git rev-parse --show-toplevel)
name="two-pass-install-${lane}-$$"
cleanup() { docker stop -t 1 "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
# Installation has registry access but no credential, home, store, or Docker-socket mount.
docker run -d --rm --name "$name" --cpus 4 --memory 8g --pids-limit 1024 \
    --network bridge --entrypoint /bin/bash -v "$repo:/source:ro" oven/bun:1.4.2 -c 'exec sleep infinity' >/dev/null
docker exec "$name" /bin/bash -c '
    set -euo pipefail
    lane=$1
    apt-get update
    apt-get install -y --no-install-recommends lsof procps
    bun /source/packages/plugin/scripts/two-pass-activation-runs/install-host.ts stage /source /opt/two-pass "$lane"
    export HOME=/opt/build-home TMPDIR=/tmp XDG_CONFIG_HOME=/opt/two-pass/host-sdk
    mkdir -p "$HOME" "$XDG_CONFIG_HOME"
    bun /source/packages/plugin/scripts/two-pass-activation-runs/install-host.ts build /source /opt/two-pass "$lane"
    rm -rf /opt/build-home
' _ "$lane"
# Snapshot only the credential-free install layer. Runtime uses no mounts and a fresh tmpfs auth root.
docker commit "$name" "$image" >/dev/null
printf 'PREPARED %s %s\n' "$lane" "$image"
