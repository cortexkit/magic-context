# ck-mc write probe

Tools behind `docs/reports/ckmc-write-amplification-design.md`. They measure how many bytes ck-mc writes per transform pass and which table owns each written page. Nothing here opens a live store: the live `context.db`, `store.db` and `opencode.db` are only ever read by `cp -c` (an APFS clone), and every measurement runs against the clones.

Work files go to `$TMPDIR/magic-context/ckmc-writes` unless `CKMC_PROBE_DIR` says otherwise.

## Real module, real daemon

```sh
scripts/ckmc-write-probe/prep.sh golden          # clone the live stores once
scripts/ckmc-write-probe/prep.sh run run1        # a fresh run directory from the clones
cd scripts/ckmc-write-probe
PROBE_RUN=$TMPDIR/magic-context/ckmc-writes/run1 \
PROBE_SESSION=ses_... PROBE_PROJECT_ROOT=/path/to/the/session/project \
PROBE_PIN=1 PROBE_BROCA=1 bun drive.ts
python3 summarize.py $TMPDIR/magic-context/ckmc-writes/run1/passes.jsonl
python3 walcommits.py $TMPDIR/magic-context/ckmc-writes/run1/data/cortexkit/magic-context/store.db
```

`drive.ts` starts a private `ckdev-subc` and `ckdev-mc` (dev-named copies of the installed binaries, or inputs from `CKMC_PROBE_CK_MC` / `CKMC_PROBE_CK_SUBC`), the hermetic historian producer when `PROBE_BROCA=1`, and drives the plugin's real Rust-mode transform with the session's messages since its newest compaction. `PROBE_PLAN` lists the passes: `first`, `defer` (no new message), `newmsg` (one new agent step), `execute` (usage above the threshold), `hard` (model switch, which changes the render identity), `historian` (usage high enough to fire the historian), `wait_historian` (let a historian run publish, then pass).

Per pass it records the module's disk-write counter (`rusage.py`, macOS `proc_pid_rusage`), the WAL frames appended to each store (`walattr.py`), the owning table of every written `store.db` page, the session's row sizes (`rowinfo.py`) and the SHA-256 of the served messages.

- `PROBE_PIN=1` holds a read snapshot on both stores (`pin.py`) so no checkpoint can reset a WAL. Every frame stays attributable, but checkpoint writes are deferred, so `module_bytes_written` then excludes them.
- `PROBE_PIN=0` is the live configuration: `module_bytes_written` includes checkpoints.

Confirm isolation with `lsof -p <pid>` on the probe's `ck-mc` and `ck-subc`: every regular file must be under the run directory.

`PROBE_SQL_TRACE=1` also logs every write statement the plugin process runs against `context.db` to `$PROBE_RUN/sqltrace.jsonl`: the pass, the table, the columns it sets, its bound bytes, the WAL frames it appended (exact for autocommit statements under `PROBE_PIN=1`), and for each bound string of 64 KiB or more how much of it matches the same statement's previous value. `python3 sqlsum.py $PROBE_RUN` prints the per-pass summary. `pluginrows.py <context.db clone> <session prefix>...` lists the bytes per column of a session's `session_meta` and `lkg_slots` rows.

## The proposed migration 63

`migcheck/` holds the exact migration text (`migration63.sql`) and a Rust probe that runs it with the SQLite ck-mc links (3.46.0, through `rusqlite =0.32.1` with `bundled`). The crate is outside the repository's Cargo workspace, and its committed `Cargo.lock` pins that dependency resolution. Build it from a copy so no build output lands here:

```sh
W=$TMPDIR/magic-context/ckmc-writes-r2
cp -R scripts/ckmc-write-probe/migcheck $W/migcheck-src
(cd $W/migcheck-src && CARGO_TARGET_DIR=$W/target-exact cargo build --release -j 2 --features exact)
(cd $W/migcheck-src && CARGO_TARGET_DIR=$W/target-fast cargo build --release -j 2)
cp -c $W/golden/mc/store.db $W/mig/store.db
$W/target-exact/release/migcheck migrate $W/mig/store.db
$W/target-exact/release/migcheck verify $W/golden/mc/store.db $W/mig/store.db
$W/target-exact/release/migcheck fixtures
$W/target-fast/release/migcheck loadcost $W/golden/mc/store.db $W/mig/store.db <session> 60
```

`verify` compares every moved value with the serde-parsed original; `--features exact` compares numbers by their text and keeps key order, so it also reports byte identity. `MIGCHECK_SQL=<file>` runs a different migration text, which is how a deliberately broken aggregate shows that `verify` catches corruption. `loadcost` parses into `serde_json::Value`, a proxy for the typed structs, so compare the two layouts rather than the absolute times.

## SQL-level replay of one commit

`sqlexp.py <golden>/mc/store.db <work dir> <session> [scenario ...]` (the golden clone has its WAL folded in) runs the statements `McStore::commit_transform` issues, with a ck-mc connection's pragmas, on per-scenario clones, for today's layout and for the proposed split layout. Its `migrate()` is a Python split used only to build the split layout for the cost model; it is not migration 63, and its timing is not the migration's (use `migcheck` for that).

## Live evidence without opening the live store

- `sampler.sh [count] [interval]` clones `store.db` periodically and `diffsamples.py` lists the fields each commit changed.
- `reconcile.sh <ck-mc pid> [seconds]` compares the live module's write counter with the commits counted between two clones.
