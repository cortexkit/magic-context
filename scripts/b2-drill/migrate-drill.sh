#!/usr/bin/env bash
# Single-store rehearsal, migration step: run `doctor single-store migrate` against
# clones of the scrubbed snapshot made by copy-and-scrub.py, never against a live store.
#
# Usage: scripts/b2-drill/migrate-drill.sh <drill-root> <name>
#   <drill-root>/snapshot/{context,store}.db must exist (copy-and-scrub.py).
#   Creates <drill-root>/<name>/ as an isolated host root (HOME, XDG_* all inside it),
#   APFS-clones the snapshot into it (copy-on-write, so no extra disk until written),
#   then proves, in order:
#     1. the lsof refusal: a process holding the copied context.db open blocks migrate;
#     2. the real migration, with its render check, backup path and printed undo;
#     3. idempotency: a second run reports "already migrated" without calling the engine.
#   Prints schema versions and the ALF spot-check counts before and after.
#
# Environment: CK_MC must name the ck-mc binary built from this tree (never the
# installed one). The drill stages and runs it as ckdev-mc so it cannot be
# mistaken for a live fleet process. Runs the built CLI with Node, as before.
set -euo pipefail

ROOT_ARG="${1:?drill root}"
NAME="${2:?run name}"
WORKTREE="$(cd "$(dirname "$0")/../.." && pwd)"
CK_MC="${CK_MC:?set CK_MC to target/release/ck-mc built from this tree}"
ALF_SESSION="${ALF_SESSION:-ses_227ce5788ffeRPA9THoPLOQreO}"

DRILL_ROOT="$(cd "$ROOT_ARG" && pwd -P)"
ALLOWED_ROOT="$(cd "${TMPDIR:-/tmp}" && pwd -P)/magic-context/"
if [[ "$DRILL_ROOT" != "$ALLOWED_ROOT"* ]]; then
    echo "refusing drill root outside \$TMPDIR/magic-context: $DRILL_ROOT" >&2
    exit 2
fi
SNAP="$DRILL_ROOT/snapshot"
RUN="$DRILL_ROOT/$NAME"
DATA="$RUN/data/cortexkit/magic-context"
[ -e "$RUN" ] && { echo "refusing to reuse $RUN" >&2; exit 2; }
mkdir -p "$DATA" "$RUN/data/opencode" "$RUN/home" "$RUN/config" "$RUN/state" "$RUN/cache" "$RUN/runtime" "$RUN/tmp" "$RUN/bin"
# The migration engine reads only context.db and store.db; OpenCode's database is
# cloned into the host roots later, not here.
cp -c "$SNAP/context.db" "$SNAP/store.db" "$DATA/"
cp "$CK_MC" "$RUN/bin/ckdev-mc"

export HOME="$RUN/home" XDG_DATA_HOME="$RUN/data" XDG_CONFIG_HOME="$RUN/config"
export XDG_STATE_HOME="$RUN/state" XDG_CACHE_HOME="$RUN/cache" XDG_RUNTIME_DIR="$RUN/runtime"
export TMPDIR="$RUN/tmp" MAGIC_CONTEXT_STORAGE_DIR="$DATA"
unset OPENCODE_DB
CLI=(node "$WORKTREE/packages/cli/dist/index.js" doctor single-store migrate --ck-mc "$RUN/bin/ckdev-mc" ${MIGRATE_EXTRA_ARGS:-})

state() {
    echo "--- $1"
    sqlite3 "$DATA/context.db" \
        "SELECT 'context_version', MAX(version) FROM schema_migrations;
         SELECT 'context_alf_compartments', COUNT(*), MAX(sequence) FROM compartments WHERE session_id = '$ALF_SESSION';"
    sqlite3 "$DATA/store.db" \
        "SELECT 'store_version', namespace, MAX(version) FROM cortexkit_schema_version GROUP BY namespace;
         SELECT 'store_alf_compartments', COUNT(*), MAX(sequence) FROM mc_compartments WHERE session_id = '$ALF_SESSION';" \
        2>&1 || true
}

state "before"

echo "=== 1. lsof refusal: hold the copied context.db open"
python3 -c 'import sys,time; f=open(sys.argv[1],"rb"); print("holder ready", flush=True); time.sleep(600)' "$DATA/context.db" &
HOLDER=$!
sleep 2
lsof -p "$HOLDER" -Fn | grep '^n' | sed 's/^n/holder open: /' | grep -F "$RUN" || true
set +e
"${CLI[@]}"
REFUSED=$?
set -e
kill "$HOLDER" 2>/dev/null || true
wait "$HOLDER" 2>/dev/null || true
echo "refusal exit=$REFUSED (holder PID $HOLDER)"
[ "$REFUSED" -eq 2 ] || { echo "expected refusal exit 2" >&2; exit 1; }

echo "=== 2. migrate"
START=$(date +%s)
"${CLI[@]}"
echo "migrate wall seconds: $(( $(date +%s) - START ))"
state "after"

echo "=== 3. idempotent rerun"
"${CLI[@]}"
