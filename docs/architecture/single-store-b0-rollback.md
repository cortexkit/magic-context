# Rolling back the single-store marker release (context.db v92 + v93)

This release ships two `context.db` migrations together: v92 (`rust_ordinal_checkpoints`, the Rust adapter's ordinal-walk checkpoints) and v93 (`single_store_projects`, the per-project single-store marker). The plugin's schema fence, `LATEST_SUPPORTED_VERSION`, and the module's `BUILT_CONTEXT_FENCE_VERSION` are both 93. Nothing in this release writes a marker row, so on every box the marker table is empty.

Paths are relative to the repository root.

## An older plugin fails closed against a v93 file

A plugin opens `context.db` only if the file's persisted migration lane is at or below its own fence (`enforceSchemaFence` in `packages/plugin/src/features/magic-context/storage-db.ts`). Once this release has opened the file, its lane is 93. An older plugin with fence 91 or 92 then refuses the file: it logs `storage fatal: refusing to open ... upstream migration lane v93 is newer than this binary supports`, leaves the file untouched and runs without Magic Context storage until it is updated. `b0-adversarial-gate.test.ts` pins this for fences 91 and 92.

The refusal is deliberate. A build older than v93 does not know the marker table, so it could not refuse to run the store.db mirror or drain for a single-store project. Refusing the whole file is the only safe answer it can give.

So a plugin rollback is either:

- **forward:** update the plugin back to a build whose fence is at least 93; or
- **downgrade the file**, as below, and then run the older plugin.

## Manual downgrade of the file

Only do this while the marker table is empty. That is always the case with this release, but check first:

```sql
SELECT COUNT(*) FROM single_store_projects;   -- must be 0
```

Stop every OpenCode, Pi and `ck-mc` process that uses this `context.db`. Back up the file together with its `-wal` and `-shm` sidecars. Then:

```sql
-- back to v92 (for a plugin whose fence is 92)
DROP TABLE single_store_projects;
DELETE FROM schema_migrations WHERE version = 93;

-- and back to v91 as well (for a plugin whose fence is 91)
DROP TABLE rust_ordinal_checkpoints;
DELETE FROM schema_migrations WHERE version = 92;
```

Nothing is lost:

- The marker table is empty.
- The checkpoint table is a cache. The Rust adapter validates it against the host store and rebuilds it by reading the session.

If the marker table is **not** empty, do not downgrade. A row there means that project's memories and notes live only in `context.db`. An older build would drain or mirror over them.

## Never roll `ck-mc` back on its own at v93

Keep the module and the plugin on the same release.

A `ck-mc` built before this release knows nothing of the marker:

- It serves `mirror.pull` for every project, without leaving marked projects out.
- It has no `mirror.marker_status` route.

The new plugin tolerates such a module only while the file holds no marker row. At the marker lane, the plugin reads the old module's "unknown method" answer and allows the mirror only if `single_store_projects` is empty. With any row present it refuses every drain and pull (`single_store_tripwire`).

So an old module next to the new plugin works only by accident of the table being empty. It stops working, fail-closed, the moment any build writes a marker.

In the other direction, the new module serves an old plugin's project-less `mirror.pull` with marked projects' rows left out. It is only reachable on files below the marker lane, because the old plugin refuses a v93 file.
