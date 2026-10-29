# Storage

All Magic Context state lives in one SQLite database, `context.db`, shared by every host and every project on the machine, with the Rust module's `store.db` beside it. This page covers the schema fence and how to add a migration, what sharing one database implies for releases, how session-scoped rows are cleaned up and cloned, the timestamp convention, and backups.

Paths are relative to `packages/plugin/`.

## Where the code is

- `src/features/magic-context/storage-db.ts`: opening the database, the fresh schema, `LATEST_SUPPORTED_VERSION`, the migrate-on-open guard.
- `src/features/magic-context/migrations.ts`: versioned migrations.
- `src/features/magic-context/storage-schema-helpers.ts`: `ensureColumn` and `healAllNullColumns`.
- `src/features/magic-context/schema-fence-probe.ts`, `schema-version-fence.test.ts`: fence probes and the lockstep test.
- `src/features/magic-context/storage-session-tables.ts`: `SESSION_SCOPED_TABLES` and session deletion.
- `src/features/magic-context/storage-clone.ts`: copying session state into a clone.
- `src/features/magic-context/fail-closed-block.ts`: refusing loudly when storage cannot be used.
- `src/shared/sqlite.ts`, `src/shared/data-path.ts`, `src/shared/write-transaction-timing.ts`.
- `crates/mc-store/src/lib.rs`: the Rust module's store.
- `docs/migration-version-lanes.md`: version ranges reserved for forks.

## Location and backend

The database is `~/.local/share/cortexkit/magic-context/context.db`. `MAGIC_CONTEXT_STORAGE_DIR` (an absolute path) overrides the directory, and `XDG_DATA_HOME` is honoured. `MAGIC_CONTEXT_TEST_DATA_DIR`, set by the test preloads, takes precedence over both; a test process without it is refused rather than allowed to reach the live database.

`src/shared/sqlite.ts` picks the backend at runtime: `bun:sqlite` under Bun (OpenCode), `node:sqlite` under Node and Electron (Pi, OpenCode Desktop). The Node branch adds a savepoint-aware `transaction()` and maps option names; otherwise the two behave the same. Bind parameters as spread arguments, never as one array: `bun:sqlite` binds a lone array positionally, `node:sqlite` reads it as named parameters and throws.

Every connection sets a 5-second `busy_timeout` before its first schema read. Opening a database that is already at the current version does not take a write lock, so two hosts booting together do not queue behind each other. A write transaction held for a second or more is logged after commit with its call site (`write-transaction-timing.ts`).

## The schema fence

`LATEST_SUPPORTED_VERSION` in `storage-db.ts` is the highest schema version this build understands. It must equal the newest entry in `migrations.ts`; `schema-version-fence.test.ts` asserts that they move together. A build whose fence is below the database's version refuses to open it, and the host fails closed: with `fail_closed_blocking` on (the default), a minimal transform stays registered and throws a recovery error on every primary pass instead of letting the prompt grow unmanaged or falling back to native compaction. The process diagnostics name each blocking process by kind (OpenCode server, OpenCode TUI or CLI instance, Pi, other) with its PID evidence.

Opening a database with pending migrations is itself guarded (`enforceMigrationOnOpenGuard`): if a live OpenCode server or Pi process that uses an older plugin build still holds the database, the migration is refused and logged, because migrating under a running old build would leave that build on a schema it does not understand. For the default shared database the check covers every live instance; for a non-default path, only processes using the same data directory. If the absence of a live server cannot be proven (an unreadable discovery file), the migration is refused too.

Versions below 10,000 belong to upstream Magic Context; forks and sibling plugins sharing `context.db` use 10,000 and above, which the fence ignores (`docs/migration-version-lanes.md`).

## Adding a migration

1. Add the next version to `migrations.ts`, with a `migrations-v<N>.test.ts` beside it.
2. Bump `LATEST_SUPPORTED_VERSION` to the same number. Forgetting this makes the database refuse to open right after the migration runs.
3. Update the fresh-install schema in `storage-db.ts` so a new database starts at the final shape without replaying migrations.
4. Add `ensureColumn` calls for new columns, so an upgraded database whose migration row was lost still gets them. `healAllNullColumns` backfills defaults on columns an older build may have left null. Both live in `storage-schema-helpers.ts` to avoid an import cycle between `storage-db.ts` and `migrations.ts`.
5. If the table is per session, add it to `SESSION_SCOPED_TABLES` (below).

## Shared-database implications

Because every host on the machine opens the same file, a migration is a machine-wide event. The first process to open the database with a new build migrates it, and every host still running an older build then fails closed at its fence. A release that adds a migration therefore ships with rebuilt dists for both plugins (`bun run build:dists` at the repository root builds the OpenCode and Pi packages and load-probes them), and every host has to restart onto the new build.

Tables fall into two groups:

- **Session-scoped** tables carry a `harness` column (`opencode`, `opencode2`, `pi`, `omp`) so hosts never confuse each other's sessions.
- **Project-scoped** tables (memories, git commits, workspaces and similar) are shared across hosts on purpose: a memory written from Pi is visible in OpenCode for the same project.

`context.db` is the domain-state database; the Rust module's `store.db` (same directory, with its own migration chain in `crates/mc-store`) holds rebuildable private session/cache state. The module attaches to `context.db`, and the pair is one consistency unit: back up and restore both together.

## WAL durability boundary

Runtime connections use WAL mode with `synchronous=NORMAL`: the host sets it for
`context.db` in `src/shared/sqlite-context-pragmas.ts`, and ck-mc applies it to
WAL-mode `store.db` connections in `crates/mc-store/src/lib.rs`. This saves a WAL
sync on each commit. SQLite's guarantee is structural consistency after a process
crash, OS crash or power loss, not lossless durability: a process crash alone
does not normally discard committed WAL frames, but an OS crash or power loss can
roll back one or more recently acknowledged transactions. SQLite does not promise
an exact count or time window for those lost commits. `NORMAL` is not an assertion
that the latest commit survives sudden power loss, nor an unconditional guarantee
against every broken filesystem or storage device.

The two files have independent WALs and sync/checkpoint boundaries. Treating
`context.db` and `store.db` as one application consistency unit does not make a
multi-file transaction power-loss atomic. ck-mc stages some context publications
in `store.db` and later commits the corresponding rows in `context.db`; ordinary
process-crash recovery replays a surviving pending row. That protocol is not a
cross-file fsync barrier: for example, if the pending-row deletion reaches stable
storage but the matching `context.db` commit does not, the row that would replay
that write is gone. An empty/rebuilt `store.db` cache is supported and the next
session pass can do its normal HARD/bootstrap fold, but a lost `context.db`
transaction is not generally recreated from that cache. A memory, note or other
context-owned update can remain absent unless its writer retries it. Restore both
files from the same backup set; never mix snapshots or restore just one.

There are other persisted cross-store boundaries. The TypeScript transform keeps
its LKG slots (`lkg_slots`), its served markers (`lkg_served_markers`) and its
compaction-marker state in `context.db`, while OpenCode's compaction marker rows
are in `opencode.db`. No transaction spans the two files, so `synchronous=NORMAL`
can lose a recent `context.db` write at power loss even if the separate host-store update
survives. Startup's marker consistency probe is diagnostic-only: it retains state
and waits for a priced publication to replace inconsistent marker rows. A lost
latest LKG capture likewise leaves only an older slot or none; the loader checks
its stored pieces and the replay path checks the input ids/content and
model/provider before using it. If no valid LKG remains, a failed managed pass
refuses the turn rather than replaying an unverified snapshot or sending raw input.
These checks bound the recovery behavior, but they do not make the recent writes
durable.

## Session-scoped tables

`SESSION_SCOPED_TABLES` in `storage-session-tables.ts` lists every table keyed by session, and whether each is harness-scoped. Session deletion (`clearSession` on the host's delete event) depends on this list being complete to remove the session's rows from every table. Startup and background maintenance do not infer session deletion from absence in a local host store.

A deletion that also needs the Rust module to delete its rows is recorded in `pending_session_cleanup` (tagged as a Rust deletion) and retried on dream-timer ticks. The host-side session-to-project mapping is retained until the Rust module acknowledges deletion; removing it sooner would make the durable retry unreachable. A table missing from the list leaks rows forever.

## Clones

`copySessionStateForClone` (`storage-clone.ts`) copies durable session state into a new session inside one immediate transaction: compartments (with ordinals re-mapped to the clone), tags with their source contents and pending operations, optionally notes and facts, and the replay-relevant `session_meta` fields. The destination check runs after the write lock is taken, so two processes cannot both copy into the same empty clone. Cached rendered bytes are not copied, so the clone rematerialises fresh. Pi uses this on branch forks ([pi.md](pi.md)). OpenCode 2 uses it on the first pass for a fork (`v2/fork-inheritance.ts`): it pairs each copied row with the parent row of the same `seq` (the host re-mints copied ids as `<id from the fork event>_<seq>`) and copies the parent's state up to `session_v2.fork_boundary`. OpenCode 1's `/fork` records no link to its source, so it inherits nothing.

## Timestamps

Timestamp columns are epoch milliseconds. Most are written by TypeScript `Date.now()`; the schema comment `-- epoch ms (Date.now())` marks only columns where that is actually the writer. The exceptions to know:

- `memories.created_at` and `updated_at` have a second writer: rows created by the Rust-module mirror are first inserted with `0` and then given the module snapshot's own epoch-ms stamps.
- `workspaces` is written by the dashboard's Rust backend (`chrono` `timestamp_millis`).
- Some writers accept a caller-supplied time (primers, primer candidates, compartment-chunk embeddings).
- Clones copy `created_at` verbatim from the source rows rather than re-stamping.

Durations and deadlines elsewhere in the code are also milliseconds unless the name says otherwise.

## Leases

The per-session historian lease (`compartment_state_lease`, `compartment-lease.ts`) records the holder's PID in `owner_pid`, so a lease whose owner is confirmed dead can be taken over before its TTL; an owner that cannot be confirmed dead is protected until expiry. Lease releases are best effort and tolerate `SQLITE_BUSY`. Dreamer leases are described in [dreamer.md](dreamer.md).

## Backups and repair

`scripts/backup-live-stores.sh` snapshots the live Magic Context and OpenCode stores with `VACUUM INTO`, which reads inside one transaction and never takes a write lock, so each copy is consistent even while sessions are writing. Each copy is integrity-checked and its schema version recorded, so a restore can be matched to the plugin build's fence. To restore, stop every process holding the store, remove the live `-wal` and `-shm` files, copy the snapshot over the live path (both `context.db` and `store.db`), then start one host. A ck-mc rollback also needs a binary that knows the snapshot's `store.db` version, which the manifest records from `cortexkit_schema_version`. ck-mc refuses a `store.db` newer than its own migrations (see [Rollback](rust-module.md#rollback)).

`npx @cortexkit/magic-context doctor repair-db` repairs a corrupt `context.db`; it copies the damaged files to a `.corrupt-backup-<timestamp>` bundle before touching anything.
