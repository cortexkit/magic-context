#!/bin/bash
# Prepare clones for the write probe. The live stores are only ever read by `cp -c` (an
# APFS clone); nothing in this directory opens them in place.
#
#   prep.sh golden        clone the live stores and the OpenCode store into $W/golden
#   prep.sh run <name>    build $W/<name> from the golden clones for one drive.ts run
#
# W defaults to $TMPDIR/magic-context/ckmc-writes (override with CKMC_PROBE_DIR).
set -euo pipefail
W=${CKMC_PROBE_DIR:-${TMPDIR%/}/magic-context/ckmc-writes}
LIVE=${MAGIC_CONTEXT_STORAGE_DIR:-$HOME/.local/share/cortexkit/magic-context}
OPENCODE_DATA=${OPENCODE_DATA_DIR:-$HOME/.local/share/opencode}
G=$W/golden

case "${1:-}" in
golden)
    rm -rf "$G"; mkdir -p "$G/mc" "$G/oc"
    cp -c "$LIVE/store.db" "$LIVE/store.db-wal" "$LIVE/context.db" "$LIVE/context.db-wal" "$G/mc/"
    cp -c "$OPENCODE_DATA/opencode.db" "$OPENCODE_DATA/opencode.db-wal" "$G/oc/"
    # Fold the copied WALs into the clones, and switch the OpenCode clone to a rollback
    # journal so the plugin's read-only reader can open it without a -shm file.
    for db in "$G/mc/store.db" "$G/mc/context.db"; do sqlite3 "$db" "pragma wal_checkpoint(TRUNCATE);" >/dev/null; done
    sqlite3 "$G/oc/opencode.db" "pragma journal_mode=delete;" >/dev/null
    ls -la "$G/mc" "$G/oc"
    ;;
run)
    R=$W/${2:?run name required}
    rm -rf "$R"; mkdir -p "$R/data/cortexkit/magic-context" "$R/oc" "$R/bin"
    cp -c "$G/mc/store.db" "$G/mc/context.db" "$R/data/cortexkit/magic-context/"
    cp -c "$G/oc/opencode.db" "$R/oc/"
    cp "${CKMC_PROBE_CK_MC:-$HOME/.local/share/cortexkit/bin/ck-mc}" "$R/bin/ckdev-mc"
    cp "${CKMC_PROBE_CK_SUBC:-$HOME/.local/share/cortexkit/bin/ck-subc}" "$R/bin/ckdev-subc"
    # The clone sits at a new path, so its lease file starts at epoch 1; reset the copied
    # writer fence so the probe module is not fenced out by the live writer's epoch.
    sqlite3 "$R/data/cortexkit/magic-context/store.db" "update cortexkit_fence set epoch = 0;"
    ls -la "$R/data/cortexkit/magic-context"
    ;;
*)
    echo "usage: $0 golden | run <name>" >&2
    exit 2
    ;;
esac
