# Rust store and historian performance measurements

Baseline: `ee9d82912cd8105322672a1f5dd1bbb7172a2f46`. No live database,
host configuration, credentials or historian prompt file was modified. All measurements
use disposable fixtures. No schema version, cache epoch, encoding, setting or CLI flag
was changed. The TypeScript storage worker owns the matching WAL durability policy.

## Reproduction and limitations

```sh
timeout 120 python3 crates/mc-store/tests/perf_audit_sql.py
timeout 1200 cargo test --locked --release -j 2 -p mc-store -p mc-module --lib perf_audit -- --include-ignored --nocapture --test-threads=1
```

The Rust instruments use 1k / 10k / 60k messages, 50 / 500 / 3k compartments,
100 / 1k / 6k memories, and 1k / 10k / 60k frozen decisions and tags. Bodies and
tiers contain repeated realistic coding-session prose; raw transcripts have unique
message identities. Rust timings are warmed means unless noted. The machine was
heavily shared, so repeated samples vary: these are directional measurements, not
latency promises. The eviction-only fixture uses 4 KiB sized blobs: eviction reads
identities and lengths, not inflated transcript contents.

The old eviction algorithm is retained as an independent test oracle and timing
control. Its SQL and victim ordering are the previous implementation, not a second
call to the optimized function. Ordinary before measurements were collected before
their production changes. No new memo/cache was added; there is no new invalidation
policy to prove.

## Findings

Unless specified otherwise, numbers refer to the 60k fixture. A dash in the commit
column means no production change was made for that finding.

| Finding | Classification | Before → after | Commit | Test / evidence | Notes |
|---|---|---|---|---|---|
| RS-1 | NEGLIGIBLE on this fixture | Full fence read 0.807 → unchanged 0.744 ms; thin fenced transaction 0.675 → 0.711 ms | — | `measure_module_findings`; existing trigger/column drift refusal tests | Around the 1 ms threshold across loaded-machine repeats. Keep the live in-transaction schema checks rather than introducing a security-sensitive schema memo. |
| RS-2 | CONFIRMED, fixed | Fold replay context transaction 6.624 → 0.018 ms; duplicate-fact transaction 1.771 → 0.813 ms (earlier post-fix runs: 0.013 / 0.323 ms) | `7c2332e5d7` | `fold_upsert_and_replace_preserve_retained_row_ids_and_bytes`; `fact_probes_preserve_exact_dedup_and_highest_watermark_across_batches` | Tail-bounded bodies, sequence map, identity-only replacement deletion, bounded exact-content probes and one watermark write. Exact content dedup, insertion order, ids and timestamps are retained. |
| RS-3 | CONFIRMED, partially fixed; storage-key change stopped | Eight-copy transcript transaction stage 9.314 → 0.821 ms, with 8.563 ms preparation outside the lock; 3k-row eviction control 3672.085 → 5.996 ms | `2b27ab1774` | `prepared_transcripts_and_eviction_preserve_payloads_and_victim_order`; publish CAS/raw-recovery tests | Same compressor functions, payloads, per-compartment key and budgets. Persisted fixture payload total remains 4,343,696 bytes. Once-per-chunk storage needs a storage/read-contract migration and was not built. Raw payload eviction remains forbidden by the existing durable recovery contract. |
| RS-4 | CONFIRMED; not implemented at the cache-safety boundary | Frozen codec read 16.069 ms; commit 25.983 ms, unchanged | — | `measure_store_findings`; `corrupt_chunk_is_discarded_and_the_next_commit_rewrites_every_chunk` | A memo keyed only by session / row_version / sv is not enough: existing tests deliberately change chunk bodies without advancing those keys. A safe decoded memo must retain body verification. No dirty-flag encoding, format or epoch change was attempted; this remains follow-up work, not a claimed fix. |
| RS-5 | POLICY for complete row validation; NEGLIGIBLE warm hits; date indexing ALREADY FIXED | Cold validation 47.591 ms; warm validation 0.254 ms, unchanged | dates: `cf13833bf17f` | same-count rewrite/content-change/race tests in `context_boundaries`; `measure_store_findings` | `source_row_identity` hashes the complete summary row, so selecting only boundary columns would weaken validation. Dates already use a sequence HashMap in `single_store_schema::apply_compartment_dates`, introduced by the named commit. No mutex/LRU change was built; multi-session cold-miss contention is not quantified here. |
| RS-6 | NEGLIGIBLE for measured scalar concurrency; bulk pooling not assessed | Four threads, 40 scalar reads per sample: 0.006 ms amortized wall time/read, unchanged | — | `measure_module_findings` asserts each reader sees the seeded maximum | This does not prove large concurrent body reads are cheap. No pool was added based on a scalar-only workload. |
| RS-7 | CONFIRMED; page-id contract change stopped | 21,228,930-byte capability parse 4.352 ms; SHA-256 48.277 ms, unchanged | — | `measure_module_findings` asserts the capability; byte-identical reply-page tests | SHA is the content-addressed immutable reply id and dedup key. It was not replaced with a counter/short hash or a new page-id format. Parse reuse needs coordination with the main transport parse; no public SDK/outcome change was built. |
| RS-8 | NEGLIGIBLE | Whole commit with eight new tag mints, 60k existing tags: 0.291 ms, unchanged | — | `measure_store_findings`; existing tag-generation and overlay commit tests | The entire measured commit is below 1 ms, not just the MAX queries. |
| RS-9 | NEGLIGIBLE for ordinary unchanged config | 0.007 ms/project lookup, unchanged | — | `measure_module_findings`; config mtime/guidance/tier tests | Explicit throwaway user config and one project. Alternating-project caches and large guidance files were not benchmarked. No warning suppression or mtime-keyed served-text cache was introduced. |
| RS-10 | POLICY for no-fire decision ordering; read cost confirmed | Assembly snapshot 11.544 ms, unchanged | — | `measure_store_findings`; historian below-budget/emergency/fold-only and filtered-noise tests | The substance floor uses the selected chunk, which depends on producer prompt fit and its memory/reference budget. Moving it before those reads can change no-fire decisions. No negative memo, prompt-fit change or filtered-noise regrouping was built; the full no-fire stage is not isolated by this snapshot measurement. |
| RS-11 | POLICY; facade connection latency not measured | Direct transform fixtures require no facade session-resolution connection; external facade latency not sampled | — | session resolver routing/parse tests and transform suite | Do not cache a mutable external session resolution without a freshness/authority contract. No real thalamus/host service was opened to time this item. This is an explicit measurement gap. |
| RS-12 | NEGLIGIBLE warm checks; POLICY for deadline polling | Cached directory identity 0.021 ms, unchanged | — | `measure_module_findings`; nested/broken/remembered git identity tests | Immediate detection of a new repository is deliberate. A plain blocking child wait would remove the current bounded git timeout; no wait policy was changed. Cold git execution was not timed. |
| RS-13 | CONFIRMED correctness bug, fixed; LIKE matching retained | Oldest in-range hits: 0 → 3 across the three corpora behind 101 newer matches each; undated LIKE scan 4.114 → about 5.091 ms under shared load | `e2faa6e4cb` | `dated_search_reaches_hits_beyond_each_corpus_limit` failed on old code (expected 3, got 0), now passes | Inclusive SQL dates precede LIMIT 100 for memories, compartments and notes. Undated candidate ids/order/caps are independently asserted. FTS token matching would change literal substring semantics and was not substituted. |
| RS-14 | NOT REPRODUCIBLE as a served hot-path cost | No production `publish_fold` caller; exact-content probe plan uses the project/status/expiry index | — | source caller review; SQL `EXPLAIN QUERY PLAN` | Do not delete a tested publishing API or add a migration index for a test-only caller. The reachable fact-promotion path is optimized under RS-2. |
| RS-15 | NEGLIGIBLE measured pieces; offline migration left alone | Schema walk 0.049 ms; four canonicalizations 0.036 ms; 50 full memory-id reads 0.624 ms; two serializations of an eight-compartment pending fold 0.029 ms | — | `measure_store_findings`; archive/merge atomicity tests | Authenticated root sets are per-session, not one filesystem stat per message. The initial exploratory message-scaled stat loop was not representative and is not used to justify a fix. Offline migration row loops/notes lookup were not timed or changed. |

## Paired WAL durability and context.db writer occupancy

Approved WAL policy commits: `82b0c9f554`, completed for backup/verification readers
in `23f7e3a9f9`. Fresh-open assertions inspect the actual connection's `journal_mode`
and `synchronous`, including both reader and writer connections. The raw upstream
`cortexkit-store::open_sqlite` connection opens **store.db in WAL with synchronous=2
(FULL)**. `McStore::open` now explicitly selects NORMAL when that connection is WAL.

The existing attached two-file offline migration still switches to DELETE journals
and uses FULL for the super-journal transaction. Returning to WAL re-applies NORMAL.
No migration version or migration data mapping changed.

The SQL instrument measures after BEGIN IMMEDIATE succeeds through COMMIT, including
100 changed tag writes per mode, so lock acquisition wait is excluded:

| Fixture | FULL median → NORMAL median | FULL p95 → NORMAL p95 |
|---|---|---|
| 1k tags | 75.6 → 16.7 µs | 403.3 → 308.6 µs |
| 10k tags | 64.1 → 12.9 µs | 232.3 → 26.6 µs |
| 60k tags | 52.3 → 13.5 µs | 100.5 → 27.0 µs |

The RS-2 context transaction measurements use `SqliteContextDomain`: elapsed time
includes its mutex, BEGIN and COMMIT, without a contending writer. The module's live
schema bracket cost is measured separately in RS-1; it must not be mistaken for a
schema-fenced end-to-end fold measurement. RS-3's deflate/eviction work is on store.db;
context.db's lock is never held during it. Plugin and ck-mc still use the same
context.db writer lock; neither a new lock nor a second domain store was introduced.

## Byte identity, correctness and verification

The parent clarified that a corrected **new** dated ctx_search result is allowed:
it is not a rewrite of a prior tool result in history. Literal matching and undated
output remain unchanged. Existing transform/history and persisted frozen decisions
were not deliberately changed. No TypeScript or Pi transform twin needed an edit;
these changes are Rust domain-write/search implementations over the shared schema.

The final Rust suites passed 1,573 mc-module library tests, 228 mc-store library
tests, and 19 other non-host tests: **1,820 passed, 24 ignored**. Seven host/copy
cases were explicitly filtered, not reported as passes. This includes the existing
byte-identity/parity cases `four_pure_defer_passes_preserve_served_bytes_and_durable_drop_state`,
`growing_tail_defers_byte_stable_and_no_write`, `restart_replays_byte_identical`,
`historian_chunk_golden_fixture_matches_builder`, `aft_store_compose_replay_parity`,
and `tail_hygiene::tests::parity_golden_matches_ts_reference_across_full_corpus`.
The new row/payload oracle checks persisted inputs before/after the optimized writes.

Commands used for the final gates:

```sh
timeout 3600 cargo test --locked --release -j 2 -p mc-store -p mc-module -- --test-threads=2 --skip through_real_daemon --skip a_module_on_a_store_ahead_of_it_refuses_on_health_and_on_transform --skip a_copy_of_a_real_store_migrates_to_this_build_and_passes_quick_check
timeout 3600 cargo clippy --locked --release -j 2 -p mc-store -p mc-module --all-targets -- -D warnings
timeout 120 cargo fmt --all --check
```

All passed. Clippy checked both packages' 16 primary targets (1 mc-store, 15
mc-module), including test and production configurations. Versions: rustc
1.99.0 `b940084d7`, cargo 1.99.0 `5f94df478`, clippy 0.1.99, rustfmt 1.10.0;
the SQL instrument reports Python SQLite 3.54.0. Final instrument/regression runs
passed six cases. Comments in each uncommitted production diff were reviewed before
committing. Cargo.lock, package manifests and lockfiles did not change.

Real-daemon tests build sibling daemon checkouts and the copy test needs private
data, so those cases were filtered to keep all explicit build/test work within this
worktree and avoid live stores. No real host was run: there is no host pid/lsof result
to claim. `pure-replay-differential.ts` was not run because it creates/builds additional
checkouts and native hosts; the existing Rust byte-identity/parity suite and persisted
row/payload comparison are the local evidence, not a claimed cross-commit host replay.
No JS package was edited; bun test/typecheck/lint were not relevant package gates.

## Stops and follow-up

Still unbuilt: RS-3 once-per-chunk storage, RS-4 decoded memo/dirty flags, RS-7
page-id/parse carrier changes. They need storage/format/cache-safety or transport
review before implementation. RS-11 external connection latency and RS-15 offline
migration costs remain unmeasured. Scalar/warm measurements do not settle multi-session
cold boundary/read-pool contention. These are explicit limitations, not silent fixes.

## Tool issues

Shared compile slots caused an initial 1,200-second baseline timeout and a later
3,600-second broad clippy timeout. Builds used -j 2, sequential package-scoped gates
and longer outer timeouts, without bypassing the slot guard or killing other builds.
One queued build saw stale dependency artifacts while files were being edited after
an AFT restart; a fresh build resolved that. Initial all-target clippy also found test
layout/type-complexity issues and a benchmark accidentally auto-discovered as an
integration crate. Those were fixed (the library-only module instrument now lives in
`tests/support`), and all-target clippy was rerun successfully. AFT's initial inspection
was PARTIAL while rust-analyzer indexed; authoritative cargo/clippy gates cover the
changed code. Borrowed call graphs were cross-checked against this checkout's source.
