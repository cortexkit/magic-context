# Git archive producer handoff

`index.rs` provides `index_project` (system clock) and `index_project_at`
(explicit clock), plus the independently usable reader, transactional upsert,
latest-indexed-SHA lookup and project-cap enforcement. The caller passes the
canonical opaque project identity and an independent repository directory.
The producer does not derive identity, run on explicit searches, or embed vectors.
Options retain fractional days/counts accepted by the plugin configuration schema.
Fractional counts are passed to Git and SQLite unchanged: Git rejects fractional
`--max-count` as a transient read failure, and SQLite rejects fractional OFFSET
when cap eviction is necessary. These failures match the plugin producer.

`fts::initialize_schema` installs the TypeScript git tables, tokenizer and
write-through triggers idempotently on an owned connection. Enable SQLite foreign
keys on that connection to cascade embedding deletion, as required by the context
schema. The existing schema owner remains responsible for migrations.

`crates/mc-store/testdata/git_archive/root-registration.patch` adds `pub mod fts`
and `pub mod index` to `crates/mc-store/src/git_archive/mod.rs`. From the repository
root, run `git apply crates/mc-store/testdata/git_archive/root-registration.patch`
when integrating the producer;
root files are intentionally not changed in this delivery. The existing
`UnavailableGitArchive` trait object deliberately
remains unavailable until its integration owner wires real ingestion/retrieval.
The producer's `GitCommit` contains the TypeScript fields (SHA, short SHA, author,
message, committed time). The generic seam's `GitCommitRecord` is not an exact
storage DTO: it has provenance/parents but lacks author/short SHA/indexed time.
The integration owner should use the producer API rather than fabricate those
fields through a lossy adapter. Query/ranking and vector production are separate.

The following git-commit indexing behavior matches the plugin producer in
`packages/plugin/src/features/magic-context/git-commits/`:

- Walk HEAD (or a reader-supplied revision), exclude history reachable from the
  newest stored SHA by committed time and SHA, omit merge rows but walk both
  parents, and keep the configured since-days window.
- Read one capped `git log` invocation, with a 10-second timeout and 32-MiB limit
  on each output pipe. Retry once without the newest indexed SHA exclusion only
  when Git reports `bad object`, meaning the stored SHA no longer exists.
- Keep unreachable rows after rewrites; remove rows only for project-cap eviction.
- Upsert by globally unique SHA only when the message changes. Unchanged rows keep
  metadata, identity and indexed time. A nonpositive storage cap disables eviction.
- There is **no per-message truncation cap** in the TypeScript producer. Long
  messages are retained intact within the subprocess output bound.
- Structural failures return non-indexable without cap enforcement. Successful
  empty scans and transient failures still enforce the cap.

The Rust sweep takes SQLite's writer lock with `BEGIN IMMEDIATE` and gives
batch publication and cap eviction a single transaction, including FTS and
embedding cascades. This prevents an eviction error from leaving partially
published, over-cap rows. TypeScript commits its upsert batch before its separate
cap delete. Successful outputs match; Rust additionally rolls back the whole
sweep when eviction fails.

`git_archive.rs` creates disposable real repositories and databases only. Its
`oracle.ts` invokes the actual shipped TypeScript reader/indexer/storage/migrations
with embeddings disabled and a frozen clock. Comparisons cover complete stored
rows (including indexed time), FTS content and the FTS5 vocabulary, not a copied
implementation or an expected value derived by Rust traversal. Bun is required:
missing Bun fails the tests, it does not silently skip parity.

Run on Linux with 4 CPUs:

```sh
cargo test --locked -p mc-store --test git_archive
```

The integration test includes the two feature files with `#[path]` until root
registration lands. This is test wiring, not a production compatibility shim.

## TypeScript counter finding (Bun 1.4.2)

The plugin counter at
`packages/plugin/src/features/magic-context/git-commits/storage-git-commits.ts:139-145`
uses native `.run().changes > 0` to count updated rows. With Bun 1.4.2, consecutive
FTS-triggered writes inside one immediate transaction can charge deferred FTS
internal writes to a subsequent unchanged upsert. A duplicate SHA/message batch
reports `{ inserted: 1, updated: 1 }`, despite one durable row, no message update
and SQLite `changes() = 0` for the second statement. A direct native statement
reproduction gave insert `changes: 5`, unchanged repeat `changes: 4`, and an
immediate `SELECT changes()` value of zero; another unchanged repeat then gave
`changes: 0`. The wrapper returns the native result unchanged
(`packages/plugin/src/shared/sqlite.ts:425-435`).

Minimal reproduction from the repository root on Bun 1.4.2:

```ts
import { Database } from "./packages/plugin/src/shared/sqlite";
import { initializeDatabase } from "./packages/plugin/src/features/magic-context/storage-db";
import { runMigrations } from "./packages/plugin/src/features/magic-context/migrations";
import { upsertCommits } from "./packages/plugin/src/features/magic-context/git-commits/storage-git-commits";
const db = new Database(":memory:");
initializeDatabase(db);
runMigrations(db);
const commit = {
    sha: "a".repeat(40), shortSha: "aaaaaaa", message: "same",
    author: null, committedAtMs: 1,
};
console.log(upsertCommits(db, "fixture", [commit, commit]));
console.log(db.prepare("SELECT changes(), count(*) AS rows FROM git_commits").get());
db.close();
// The duplicate is counted as updated, but SQLite reports no changed source
// rows for that second upsert and only one stored commit:
// { inserted: 1, updated: 1 }; { "changes()": 0, rows: 1 }
```

The Rust implementation counts actual changed source rows, as specified by the
SQL's message-change predicate and the plugin's unchanged-row tests. The parity
fixtures compare every stored/FTS/vocabulary value and other index diagnostics,
but assert Rust's `updated` counts independently instead of emulating this native
Bun artifact. Fix the TypeScript counter separately; no TypeScript production
code changes are included here.
