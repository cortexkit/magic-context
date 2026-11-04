#!/usr/bin/env bash
set -Eeuo pipefail
finished=0

: "${SUBC_CONNECTION_FILE:?SUBC_CONNECTION_FILE must name the mounted connection file}"
: "${DRIVE_REPO:=/snapshot/repo}"

if [[ ! -r "$SUBC_CONNECTION_FILE" ]]; then
    printf 'connection file is not readable: %s\n' "$SUBC_CONNECTION_FILE" >&2
    exit 1
fi
if [[ ! -d "$DRIVE_REPO" ]]; then
    printf 'drive repository is missing: %s\n' "$DRIVE_REPO" >&2
    exit 1
fi

subc_port=$(jq -er '(.port // .endpoints[0].port) | numbers' "$SUBC_CONNECTION_FILE")
if ((subc_port < 1 || subc_port > 65535)); then
    printf 'invalid subc port in %s: %s\n' "$SUBC_CONNECTION_FILE" "$subc_port" >&2
    exit 1
fi

socat "TCP4-LISTEN:${subc_port},bind=127.0.0.1,reuseaddr,fork" \
    "TCP4:host.docker.internal:${subc_port}" \
    >/tmp/mc-drive-socat.log 2>&1 &
forwarder_pid=$!
cleanup() {
    kill "$forwarder_pid" 2>/dev/null || true
}
trap 'status=$?
if [ "$status" -eq 0 ] && [ "${finished:-0}" != 1 ]; then
    printf "%s\n" "$0: exited before successful completion" >&2
    status=1
fi
cleanup || { cleanup_status=$?; [ "$status" -ne 0 ] || status=$cleanup_status; }
exit "$status"' EXIT
trap cleanup INT TERM
sleep 0.2
if ! kill -0 "$forwarder_pid" 2>/dev/null; then
    printf 'subc forwarder failed to start; see /tmp/mc-drive-socat.log\n' >&2
    cat /tmp/mc-drive-socat.log >&2 || true
    exit 1
fi

# The cloned session row records its host-side working directory. OpenCode
# resolves the session's project (and Magic Context finds the project config
# carrying transform_mode) from that recorded path, so recreate it as a
# symlink to the snapshot repo instead of rewriting database rows.
: "${DRIVE_SESSION_DIR:=/Users/ufukaltinok/Work/Projects/CortexKit/benchmarks}"
if [[ ! -e "$DRIVE_SESSION_DIR" ]]; then
    mkdir -p "$(dirname "$DRIVE_SESSION_DIR")"
    ln -s "$DRIVE_REPO" "$DRIVE_SESSION_DIR"
fi

# The plugin's subc client resolves the connection file from the XDG data dir
# default, not only from the config value, so expose the mounted file at that
# default location too.
xdg_conn_dir="${XDG_DATA_HOME:-$HOME/.local/share}/cortexkit/run"
mkdir -p "$xdg_conn_dir"
if [[ ! -e "$xdg_conn_dir/subc-connection.json" ]]; then
    ln -s "$SUBC_CONNECTION_FILE" "$xdg_conn_dir/subc-connection.json"
fi

# tmux starts at the host-path symlink, not /snapshot/repo: the working
# directory string travels to the host-side mc-module, which stats the
# project root on the HOST filesystem. The host path exists there (the real
# checkout) and resolves to the snapshot clone inside the container.
if ! tmux has-session -t drive 2>/dev/null; then
    tmux new-session -d -s drive -c "$DRIVE_SESSION_DIR" bash
fi

exec tail -f /dev/null
finished=1
