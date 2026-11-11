# Synthetic export fixture rows

This is a reader fixture, not a copy of a user's database. Every project,
harness, session, account, credential label, run, agent, flow and model name is
invented. The source instance ID is freshly minted by the real schema
initializer; no live store was opened. `acct1` and `acct2` are labels only.

| export_seq | case | run id | session identity | model | warm or not | terminal reason |
|---|---|---|---|---|---|---|
| 1 | Old-storage label (names only), first run | `run-fixture-1` | `/synthetic/project-a` / `synthetic-harness` / `synthetic-legacy-session` | `synthetic-model-1` | ordinary | `completed` |
| 3 | Same old-storage label (names only), second run | `run-fixture-2` | Same identity as row 1 | `synthetic-model-2` | ordinary | `completed` |
| 4 | New-storage label (names only), agent head before refreeze, ordinal 0 | `run-fixture-3` | (project root omitted) / `synthetic-agent-harness` / `synthetic-agent-head` | `synthetic-model-3` | ordinary | null (not the final slice) |
| 5 | Same agent head, after refreeze, ordinal 1 | `run-fixture-3` | Same identity as row 4 | `synthetic-model-3` | ordinary | `completed` |
| 6 | Same head, one keep-warm attempt | `run-fixture-3` (billed under this run; not another run) | Same identity as row 4 | `synthetic-model-3` | `warm: true` | null |
| 7 | Worker session | `run-fixture-4` | `/synthetic/project-b` / `synthetic-agent-harness` / `synthetic-worker` | `synthetic-model-4` | ordinary | `completed` |
| 8 | Run ending in error | `run-fixture-5` | `/synthetic/project-b` / `synthetic-agent-harness` / `synthetic-error-session` | `synthetic-model-5` | ordinary | `error` |
| 9 | Sessionless classifier (`kind: "system_one"`) | JSON run ID absent; SQL run ID is empty; `flow_id: "synthetic-flow-1"` | No session object | `synthetic-classifier-model` | not a session/warm fact | member absent |

## Storage is not encoded

**A fact cannot distinguish old storage from new storage.** There is no storage
engine/layout member in `SpendSegment`. Rows 1/3 and 4/5/6 use invented names to
label the requested cases; the fixture did not instantiate two WAL storage
engines. The head additionally exercises a real refreeze split, a warm, and the
real omitted-project-root serializer. These are independent of storage version.
No storage version should be inferred from a session name or the omitted root.

## The real sequence gap

After emitting run 1, the generator submits the exact same records and run ID to
`ExportStore::emit_export_run` a second time. Its actual `INSERT OR IGNORE`
collides on the existing `fact_id`. SQLite's `AUTOINCREMENT` consumes candidate
2 even though no duplicate row is inserted; the next new fact gets 3. Nothing
edits `export_seq`, `sqlite_sequence`, fact IDs, or JSON to manufacture the gap.
The resulting sequence is **1, 3, 4, 5, 6, 7, 8, 9**, with `high_water = 9`.
The reader must use a greater-than cursor, not expect sequence 2 to arrive.

## Rebuild

The committed, environment-gated test is
`export_index::tests::write_export_facts_reader_fixture_when_requested` in
`crates/broca-store/src/export_index.rs`. It returns immediately unless
`BROCA_EXPORT_FACTS_READER_FIXTURE` names a **new** output path. It refuses to
overwrite an existing file. Example invocation from the repository root:

```sh
BROCA_EXPORT_FACTS_READER_FIXTURE="$PWD/.cortexkit/internal-docs/export-facts-reader-kit/fixture-run-index.db" \
CARGO_BUILD_JOBS=4 nice -n 10 env CARGO_INCREMENTAL=0 \
cargo nextest run --locked -p broca-store \
-E 'test(export_index::tests::write_export_facts_reader_fixture_when_requested)'
```

Run this on the approved build server, returning the database via `return_paths`;
if either compiler-wrapper variable is set to an empty string, unset that empty
variable before the command, without clearing a configured nonempty wrapper.
Delete or move a previous generated database only when intentionally rebuilding.
The generator calls the real `init_schema` on a fresh SQLite connection before
opening it with `ExportStore::open` (which opens existing databases only).
Every session fact goes through real WAL billing derivation and the real exporter. The classifier is
constructed as `SystemOneFact` with a SHA-256 of an invented label as its fact ID,
not by the classifier runtime's batch derivation, and inserted by
`emit_system_one_fact`, which uses that type's serializer; no JSON payload is
handwritten. The keep-warm has successful billing evidence, so its fact includes
`warm_outcome: "complete"`; the head and worker also carry invented agent-scope
attribution distinct from their broca episode IDs.

After inserts, the generator drops the **empty** auxiliary
`export_imported_runs` table so the delivered database has only `export_meta`
and `export_facts` user tables. SQLite's internal `sqlite_sequence` and the real
export-fact indexes remain. This pruned artifact is for read-only clients, not
for reopening as a production writer database.

Generate the unedited dump locally with:

```sh
sqlite3 -readonly .cortexkit/internal-docs/export-facts-reader-kit/fixture-run-index.db .dump \
  > .cortexkit/internal-docs/export-facts-reader-kit/fixture.sql
```

The source ID (and consequently session fact hashes) changes on each rebuild.
Regenerate `SHA256SUMS` for the kit files after rebuilding. No credential secrets
or real identities are needed.
