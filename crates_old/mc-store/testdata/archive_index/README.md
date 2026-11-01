# Raw archive store integration

The engine remains dormant. A future integration can apply `integration.patch` to
register `store`, `fts`, and `ordinals` under `mc_store::archive_index`. No crate
roots, shared schema, dependencies, or FTS5 settings are changed here. The public
`UnavailableRawArchive` adapter still reports that raw-archive operations are
unavailable; these files provide a tested store engine, not live tool/RPC routing
or a host reader.

## Store boundary

1. Bootstrap `context.db` with `context_schema::BOOTSTRAP`, then call
   `store::install(&connection)` for the archive-owned raw-parts, identity and revision
   tables. Existing TypeScript source identities are adopted lazily during ingestion.
2. Feed `store::RawMessage` values to `store::ingest` in `IngestBatch`. Historical
   pages carry one-based ordinals in the complete host raw transcript; ordinal zero
   requests a live append. Existing IDs always retain their assigned ordinals.
   Bridges must omit native compaction-summary rows from canonical history, and
    report the first removed suffix ordinal in `revert_from` when the host confirms
    a revert. No OpenCode or Pi source database is opened here.
3. Each request accepts at most 100 source messages. `index_limit` bounds each
   pending-prefix or deferred-revision scan to 1–100 rows. There can additionally be
   up to 100 covered-ID edits from the input batch; all work is bounded independently
   of transcript length. An empty batch resumes persisted pending rows. The
   `message_history_index` watermark is the contiguous indexed prefix, not the
   maximum observed ordinal. Missing ordinals leave a durable dirty floor.
4. Omitted IDs are never removals. `revert_from` is an explicit positive host
   declaration that the entire suffix starting at that ordinal was removed; this
   truncates raw rows, identity assignments, source rows and mapped FTS rows in the
   same transaction. It is **not** an arbitrary middle-message delete API.
5. `source_revision` is a persisted opaque host label, not a sortable revision or
   concurrency check. The caller must reject observations from outdated host
   sessions/revisions before passing them to ingestion.
6. `fts::backfill_rowid_map` resumes existing TypeScript FTS rows in transactions
   capped at 100 rows, preserving the existing schema's restart cursor and timestamps.
   Legacy edits/reverts defer or reject while affected FTS documents cannot be addressed
   by rowid. The source watermark and opaque revision never publish partial writes.
7. `fts::search` accepts an FTS5 expression and applies content-only matching,
   ordinal cutoff and inclusive time predicates before LIMIT. `store::read_by_id`
   and `read_range` return original parts, not FTS text. A range returns only archived
   rows; callers must distinguish absent source history from a complete expansion.
   Exceeding the byte budget is an error, not silent truncation.

The source rows/hash/skip markers use the existing TypeScript tables and conventions.
Archive-owned tables contain full original parts even for empty, non-indexable or
oversized text. The FTS table remains `porter unicode61`; no automerge, crisismerge,
usermerge or other shared merge setting is written.

## Differential verification

`tests/archive_index.rs` compiles these files directly before public module registration.
Its Bun subprocess runs the **real** TypeScript schema migrations and indexer on a
throwaway context database. `sequences.json` is shared raw input with explicit canonical
ID/ordinal fixtures. Each step compares FTS content/identity/timestamps, source hashes,
versions, roles, ordinals and contiguous watermarks; the TypeScript source rows also
independently carry those ordinals. The TypeScript removal path clears a whole session,
so its surviving prefix is rebuilt before logical-row comparison with the Rust suffix
truncate. Physical FTS rowids and wall-clock update times intentionally are not compared.
Fixtures directly supply explicit message-ID/ordinal pairs to both indexers. Host
adapters' scanning and checkpoint caching of OpenCode/Pi logs is outside these tests.

The differential runner also covers bounded pages, ordinal holes, ignored/directive/
steering text, Unicode whitespace, numeric versions, oversized UTF-8 and FTS queries.
Rust tests cover restart, complete original tool parts, collision rollback, and a child
process exiting while the writer transaction is active. All fixture roots are under
`$TMPDIR/magic-context/archive-index-2b/` and are removed after each run.

Verification commands (Cargo runs on Linux):

- `cargo test -p mc-store --test archive_index -- --nocapture`
- `cargo clippy -p mc-store --test archive_index -- -D warnings`
- `rustfmt --check --edition 2021 crates/mc-store/src/archive_index/{store,fts,ordinals}.rs crates/mc-store/tests/archive_index.rs`
- `bun run --cwd packages/plugin typecheck`
- `packages/plugin/node_modules/.bin/tsc -p crates/mc-store/testdata/archive_index/tsconfig.json`

The tests `mutation_contract_identity_ordinals_ignore_request_position` and
`mutation_contract_watermark_is_committed_with_source_rows` verify stable identity
ordinals and transactional index progress. To prove they detect faults, deliberately
replace the known-ID return in `ordinals::assign` with the request's first position,
or disable the progress-table write in `store::ingest`, respectively. Run both
`mutation_contract` tests: only the corresponding test should fail.
