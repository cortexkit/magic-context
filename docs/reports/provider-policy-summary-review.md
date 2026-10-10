# Provider policy summary: independent correctness review

Reviewed range: `a424544aa619..602f698d5b09` (bounded provider policy summaries,
store migration 68, the `last_answer_json` receipt, the narrowed
`ProviderHookContext.parts`, the map rewrites in `reasoning_budget_cutoff` and
`active_anthropic_turn.rs`, and the TypeScript `publishMessages` copy). This is
a report-only review: no product code changed. The tests named below were added
with this report; recorded-failing tests are `#[ignore]`d with a reason and each
has a passing partner on the same fixture.

## Verdict

No mismatch between a replayed summary and the full computation was found for
any store write that the shipped code performs. In a randomized differential of
600 sequences of production-shaped writes (10,413 hooks, 4,651 of them replays
compared against the full computation), the result was 0 mismatches.

Three latent gaps reproduce when a row is written in a way no shipped writer
uses today. Each one produces a wrong replay with no fallback firing. The writer-guard
change also turns a fail-closed open into a silent one. All four are **Low**:
none is reachable through current code paths. They become real bugs as soon as
a future writer takes one of these paths, and the summary's own tests would not
notice, because those tests only check paths that go through the shipped writers.

| # | Severity | Area | Finding | Recorded-failing test | Passing partner |
| --- | --- | --- | --- | --- | --- |
| F1 | Low (latent) | Replay key | The engine namespace decides which consumed tag numbers deactivate parts, but it is in neither the summary key nor any trigger. Changing a conversation's namespace changes the full result and logs nothing. | `providers::policy_summary::review_tests::namespace_switch_is_seen_by_the_replay` | `consuming_the_same_numbers_in_the_own_namespace_replays_exactly` |
| F2 | Low (latent) | Replay ranks | Changing a row's `kind` between `header` and a non-header kind keeps its `(ordinal, block_index)`, so the replay accepts it. But every later non-header part moves one place in the frozen-baseline order. The replayed summary's `baseline_end` diverges, and later appends would place the baseline boundary wrong. | `providers::policy_summary::review_tests::kind_flip_is_seen_by_the_replay` | `changing_the_kind_flip_row_otherwise_replays_exactly` |
| F3 | Low (latent) | Triggers | The update trigger is `AFTER UPDATE OF policy_json`. An update that changes only the `ordinal` or `lineage_id` column moves a row into or out of the effective lineage with nothing logged. The served inputs differ: in the repro the real-user count is 1 against the full computation's 0. | `providers::policy_summary::review_tests::row_column_moves_are_seen_by_the_replay` | `changing_the_moved_row_through_policy_json_replays_exactly` |
| F4 | Low | Store open | `install_writer_guards` now skips every inventory table missing from the schema, whatever the recorded version. A version-68 store missing `mc_provider_policy_changes_v1` used to fail to open. It now opens with no guard on that table, and fails later, on the first trigger that needs the table. | `provider_log::policy_summary_migration_tests::a_latest_store_missing_an_inventory_table_refuses_to_open` (mc-store) | `an_intact_latest_store_guards_both_summary_tables` |

Informational (no test fails):

- **I1.** `INSERT OR REPLACE` into the policy parts logs the replaced row as a
  *new* row (`previous_json` NULL), because REPLACE does not fire the delete
  trigger. The replay stays exact only because a "new" row at or before the
  newest known position takes the `max_key` fallback. No shipped writer uses
  REPLACE. The behaviour is pinned by
  `upsert_keeps_the_first_copy_and_replace_logs_a_new_row` (mc-store), which
  also shows that the admission upsert (`ON CONFLICT DO UPDATE`) fires the
  update trigger and keeps the first pre-change copy.
- **I2.** `ProviderPolicyIndex::changes(cap)` builds `LIMIT {cap + 1}`. A cap at
  or above `i64::MAX` makes SQLite fail with "datatype mismatch". The production
  cap is 4,096; this is only a sharp edge for future callers.

## Minimal reproductions

The fixture is in `crates/mc-module/src/providers/policy_summary_review_tests.rs`.
Each step is an `Op`, and selectors are deterministic, so these sequences replay
exactly. A `Hook` runs `policy_summary::channel1_inputs` inside
`commit_provider_hook`. It does the same baseline-refreeze bookkeeping as
`step_transform.rs`, and first probes the replay against
`transform::channel1_inputs_from_parts` and `build` over every effective part.

- **F1:** `[Append(5683219820602439236), Hook, Namespace(14771867209009316838), Hook]`.
  `Namespace` inserts three consumed numbers under `ses_other` (no summary
  conversation lives there, so the consumed-tag trigger logs nothing). It then
  sets `mc_provider_conversations_v2.engine_namespace = 'ses_other'`. The
  replayed baseline has `turn_delta_u: 337, prose_u: 337`; the full computation
  has `0` and `0`.
  - Reachability: `host_setup` sets the namespace only when it is empty
    (`compaction.rs` around `conversation.engine_namespace = binding.session`).
    But `save_conversation_tx`'s upsert does overwrite `engine_namespace`, so
    any future caller that saves a different namespace reaches this.
  - Fix direction: put the namespace in `Settings::key`, or drop the summary
    when the namespace changes.
- **F2:** `[Append(13707904503047187660), Hook, KindFlip(8882675692618232619), Hook]`.
  The replayed summary has `baseline_end: Some((1, 0))`; a rebuild has
  `Some((1, -1))`. The served inputs at that step happen to be equal; the
  divergence is in the stored summary. The full-computation check built into
  the change (`check_against_full`) would flag it.
  - Reachability: block ids encode the kind (`{mid}#@message` for headers), and
    every shipped writer keeps the kind of a block id.
  - Fix direction: treat a change of `kind` (or `real_user`/`role` if they ever
    become mutable) like a change of `part_key`, and fall back.
- **F3:** `[Append(4091705870740682164), Hook, OrdinalColumn(14493650589465211347), Hook]`
  (the odd selector moves the header row to `lineage_id = 'detached'||rowid`).
  Replayed real-user count 1, full 0.
  - Reachability: every `UPDATE mc_provider_policy_parts_v1` in
    `provider_log.rs` sets only `policy_json`. Moves ship and install rows; they
    do not update these columns.
  - Fix direction: `AFTER UPDATE ON` (all columns), or a second trigger on
    `UPDATE OF ordinal, lineage_id, block_id` that drops the summary.
- **F4:** open a version-68 store, `DROP TABLE mc_provider_policy_changes_v1`,
  then reopen. The reopen succeeds. **Mutation evidence:** with the new `if
  !exists { continue; }` in `move_store::install_writer_guards` removed (never
  committed), the recorded test passes. So does
  `an_intact_latest_store_guards_both_summary_tables`, while
  `migration_68_steps_a_populated_v67_provider_store_and_fences_v67` fails:
  opening the version-67 store cannot create guards for tables it lacks, which
  is why the skip was added.
  - Fix direction: skip a table only when the recorded schema version predates
    that table, or only for a store opened with a shorter migration chain.

## 1. Replay exactness

**Randomized differential.** Test
`production_writes_replay_equals_full_computation_over_600_sequences` drives
600 seeded sequences of 30–50 steps; a failure is shrunk to a minimal sequence.
Each sequence starts with 3–6 admitted messages and a rebuilding hook. Each step
then mirrors a shipped store write, using the same SQL as the shipped statement:

- admission inserts of messages with headers (real-user or not), text parts
  (some tagged), tool calls and results, and results that close arcs opened by
  earlier messages;
- promotion (`served`), deactivation (`active=false`, as in burns and the
  unserved reset), queueing (`queued`) and consuming a tag number in the engine
  namespace;
- the admission re-arm upsert (`ON CONFLICT DO UPDATE`, a new tag number on an
  inactive row);
- an engine rewrite that drops the summary first and marks an arc reduced;
- protection-floor and protected-tool keep-count changes (keep counts 0–2 for
  `read`, `grep` and `bash`, so the "newest per tool" lists fill and lose
  members);
- lineage forks at an earlier ordinal, and child-lineage copies that shadow an
  ancestor row;
- cache-busting hooks.

Tool names cover hint tiers 1–3 and an excluded tool; tag tokens straddle
`AGE_RECLAIM_MIN_TOKENS`, so the "four smallest per tier" hint lists overflow
and refill. Floors of 500–6,000 tokens move the protection-window cutoff in
both directions.

Result: 600 sequences, 10,413 hooks, 4,651 replays compared, 0 mismatches, no
hook errors.

`out_of_band_writes_replay_equals_full_computation_over_600_sequences`
(recorded failing) adds writes no shipped code performs: kind flips, in-place
tag-token, tool-name, `reduced` and measurement changes, `INSERT OR REPLACE`,
deletes, namespace switches, and `ordinal`/`lineage_id` column updates. Result:
600 sequences, 10,488 hooks, 4,665 replays compared, 327 mismatching sequences.
The test shrank the first 12. Each of the 12 reduced to F1, F2 or F3 (some with
unrelated extra steps such as a `Delete` that only forced an earlier rebuild).
The other 315 were not shrunk individually. In-place tag-token, tool-name,
`reduced` and measurement changes, REPLACE and deletes never appeared in a
minimal sequence on their own: they go through `policy_json` and are logged, or
they drop the summary or take a fallback.

**Non-vacuity of the probe.** `differential_detects_a_tampered_summary` raises
the stored summary's real-user total by one. It shows that the hook still
replays it, and that both the probe ("replayed inputs: users") and the
served-inputs check ("served inputs: users") report the difference.

**Bounds and fallbacks.** `change_log_cap_replays_at_4096_and_rebuilds_at_4097`
logs exactly 4,096 changes and checks that the hook replays them and matches the
full computation. It then logs 4,097, checks that the hook rebuilds, and checks
that the next hook replays again because saving the rebuilt summary cleared the
log.

**Trigger coverage, by reading.** The summary reads only `policy_json`, the
`ordinal`, `lineage_id` and `block_id` columns, the conversation's
`engine_namespace` and the consumed-tag table.

- Every shipped write to `mc_provider_policy_parts_v1` sets only `policy_json`:
  the admission upsert, the engine rewrite (which drops the summary first),
  promotion, deactivation in `remove_policy_tx`, the unserved reset, queueing in
  `queue_provider_drops` and the baseline restatement.
- Inserts into the consumed-tag table use `ON CONFLICT DO NOTHING`, which fires
  no trigger when the number is already consumed. No shipped code deletes from
  that table.
- Conversation deletes and part deletes drop the summary.

So F1 and F3 are the only uncovered inputs.

**Not driven.** These were not exercised by the differential:

- `engine_policy.coverage` changes (they are in the key, so they rebuild);
- rows in the legacy empty lineage;
- `real_user` or `role` changes;
- the hook's own answer and burn writes (after `save_policy_summary_tx`, they
  are ordinary logged changes relative to the saved summary);
- the full host pipeline. The differential calls the store and
  `channel1_inputs` directly; the change's own 720-pass corpus covers the
  pipeline.

## 2. Crash and concurrency

- **A summary is never half-built on disk.** `save_policy_summary_tx` runs one
  upsert followed by a change-log delete inside the hook's fenced transaction,
  after `restate_baseline_measurements_tx`. The answer insert, burns and
  conversation update come after it in the same transaction.
  `a_hook_failing_after_the_summary_write_rolls_the_summary_back` makes the
  write fail after the summary was saved (an answer tag that does not advance
  the high water). It checks that the previous summary and its change log are
  intact and that the next hook replays exactly.
- **A malformed summary is ignored.** It is treated as absent, deserialized with
  `.ok()` and rebuilt. See `an_unparsable_summary_is_rebuilt_not_replayed`.
- **Two conversations sharing the tables and the engine namespace.**
  `consuming_a_shared_tag_replays_both_conversations_exactly` runs two
  conversations of one session (`opencode` and `pi`) in one store. Consuming a
  shared tag number logs one change for each conversation, and both replays
  match.
- **Change log while no summary exists.** It records nothing: every trigger is
  conditioned on a summary row. This is asserted in
  `migration_68_steps_a_populated_v67_provider_store_and_fences_v67`.
- **4,096 overflow.** See section 1.
- **Not checked:** a real process kill during a hook, and several processes
  writing concurrently. The store's single fenced writer connection serializes
  writes; that was not exercised beyond in-process transactions.

## 3. Migration 68

- **Step-through.**
  `migration_68_steps_a_populated_v67_provider_store_and_fences_v67` opens a
  store with the chain up to 67. It populates it through public APIs
  (`save_provider_conversation`, `admit_provider_pass`, `commit_provider_hook`),
  then reopens it with the full chain. It asserts that:
  - the store reports version 68;
  - every provider conversation, lineage, message and policy row is
    byte-identical;
  - both tables, all five triggers and all five indexes exist, and no summary
    exists;
  - writes log nothing until a hook stores a summary, after which the first
    pre-change copy is logged once, even across a later consume of the same
    tag;
  - deleting a part drops the summary and its log.

  This is a single-step check at the 67→68 boundary only, not the full
  per-version `populateForVersion` replay described in
  `docs/armed-store-migration-replay-report.md`.
- **Downgrade and older binary.** The same test reopens the version-68 store
  with the version-67 chain. The open is refused with
  `StoreAheadOfBinary { db_version: 68, binary_max: 67 }` and the store file is
  byte-identical, so an older ck-mc never runs with these triggers installed.
  There is no down-migration. Rolling back means restoring both store files
  from one backup, as for every fenced migration.
- **Move inventory.** Both new tables are `LocalReset`. A move discards their
  rows at the source and does not ship them (`ship_tables` keeps only `Ship`
  tables). At the destination no summary exists, so installing the policy and
  consumed-tag rows logs nothing, and the first hook rebuilds the summary.
  `fresh_migrations_classify_every_table_column_and_primary_key` still checks
  inventory and schema parity. The move path itself was established by reading
  (`move_store.rs` `discard_tables`, `move_snapshot.rs` `ship_tables`), not by
  running a move.
- **Writer guards:** see F4.

## 4. `last_answer_json` receipt

The step answer stored on the conversation row now keeps the whole answer
except `compaction`, which is reduced to `compaction_id` and `version`
(`answer_receipt`). The readers of `last_answer_json` or the record's
`last_answer` are:

- `host_step`'s not-applied check, which reads `request_id`;
- the legacy record `status()` path, which reads `request_id`;
- the store load and save, and the v1-record migration, which pass the raw
  string through;
- the conformance test
  `kill_mid_request_retry_skips_reserved_version_preserves_cursor_and_fences_stale`,
  which reads `answer` and `compaction.version`, and compares
  `compaction.replacement`;
- `providers/tests.rs`, which reads `request_id`.

There are no TypeScript readers. Full-shape rows written before this change
still carry `request_id` at the top level, so old rows read the same way. The
conformance test passes on Linux:
`cargo test -p mc-module --features drive-fault --test broca_conformance kill_mid_request_retry`
ran 1 test and it passed. I did not trace which write path supplies the
`last_answer` that test reads. A step now loads one view by version
(`load_provider_view`); a missing row gives the same "recorded provider view is
missing" transient as before.

## 5. Map rewrites

These were reviewed by reading; no test was added.

- `active_anthropic_turn_mids` keeps a mid only if no occurrence at or before
  the last real user turn exists. That equals the old `position` (first
  occurrence) `> user`, including duplicate mids.
- In `reasoning_budget_cutoff`, `first_index` and `natives` use
  `entry().or_insert` (first match wins, as `position` and `find` did), and
  `merged` uses `strip_prefix` on the same key format the old `==` compared.
  The prose `ratio` is hoisted unchanged, and `kept` is copied on write
  (`Cow`) only where the old code mutated its clone.
- The change's own `set_form_matches_the_per_mid_predicate` compares the set
  form with the per-mid predicate.
- Ties do not arise: the maps are keyed by mid, and no ordering among equal keys
  is consumed.

## 6. TypeScript `publishMessages`

`opencode-adapter-publication-review.test.ts` keeps the previous recursive copy
verbatim as a reference. It compares every published copy for prototypes, own
keys in order (including an own `__proto__` key), array holes and exact values.
The fixtures cover:

- an own `toJSON` method (never called, never copied) and `toJSON` as data
  (kept);
- `JSON.parse` `__proto__` keys at three depths;
- sparse arrays and an array with an extra property (both copies drop it);
- `undefined` values and elements (kept);
- a Date, a Map, a Set and a class instance (each becomes a plain object of its
  own enumerable fields, as before);
- `null` and falsy elements;
- nested tool state;
- a null-prototype message.

It also checks that the source mapping is preserved and that deep mutation of a
copy leaves the source untouched. Shared references and cycles behave the same
by reading: both versions duplicate shared references and overflow the stack
on a cycle.

**Mutation evidence:** with the `__proto__` branch disabled (never committed),
"every fixture publishes the same shape the reference copy produced" and "an
own __proto__ key stays data and never changes the copy's prototype" failed,
and the mutation test passed.

The model fallback that walks back from the newest message returns the same
first model as the old reverse/map/find.

## Gates run (Linux, `ck-motor`, Cargo 1.99.0, Bun 1.4.2)

- `cargo test -p mc-module --lib`: 1,869 passed, 28 ignored. The 28 are 24
  already ignored plus 4 recorded failing from this review.
- `cargo test -p mc-store`: 317 passed, 6 ignored (5 plus 1 recorded failing).
- `cargo test -p mc-module --lib policy_summary::review_tests -- --include-ignored`:
  every passing partner passed, and the recorded-failing tests failed for the
  reasons above.
- `cargo test -p mc-module --features drive-fault --test broca_conformance kill_mid_request_retry`:
  1 passed.
- `bun test src/hooks/magic-context/host-runner`: 359 passed across 8 files.
- `bun run typecheck` (tsc 5.9.3): exit 0.
- `cargo fmt --check -p mc-module -p mc-store`: clean.
- `cargo clippy -p mc-module -p mc-store --tests -- -D warnings` (clippy
  0.1.99): clean.
- `biome check` (2.5.1) on the new TS test: clean. The package-wide
  `bun run lint` fails on pre-existing errors in unrelated files (for example
  `memory/lifecycle-applier.ts`).

## Not checked

- Live or real-host runs, and the performance numbers in
  `provider-pipeline-performance-gate.md`. Nothing was re-measured.
- `pure-replay-differential.ts --provider-pipeline` and the signed-thinking
  golden capture. The full plugin `bun test` was not run; only the host-runner
  directory was.
- Real process crashes and multi-process writers.
- A full per-version step-through migration replay.
- The move paths, which were established by reading and not executed.

## Follow-up: findings closed

The four findings and I1 were closed after this review. The recorded-failing
tests are no longer ignored and pass; the out-of-band differential
(`out_of_band_writes_replay_equals_full_computation_over_600_sequences`) now
reports 600 sequences, 10,488 hooks, 4,004 replays compared and 0 mismatches.
The production differential is unchanged at 0 mismatches over 4,651 replays.

- **F1.** The summary key includes the conversation's engine namespace, and
  migration 68's `mc_provider_conversations_policy_namespace_change` trigger
  drops the summary whenever `engine_namespace` changes. The key alone was not
  enough: the out-of-band differential found switches away and back
  (`[Namespace, Namespace]`), where numbers consumed in the original namespace
  while the conversation was elsewhere were never logged.
- **F2.** A change between `header` and a non-header kind falls back to a
  rebuild, like a change of position.
- **F3.** `mc_provider_policy_parts_change_move` drops the summary when a policy
  row's `conv_key`, `lineage_id`, `ordinal` or `block_id` changes. The summary
  reads those columns and `policy_json` of a part (the change trigger already
  logs `policy_json`), the conversation's `engine_namespace` (F1), the lineage
  rows (their ids and cuts are in the key) and the consumed-tag table. Releasing
  or renumbering a consumed tag now also drops the namespace's summaries
  (`releasing_or_renumbering_a_consumed_tag_drops_the_namespace_summary`).
- **F4.** `install_writer_guards` skips a missing inventory table only when the
  store's recorded version is below the first migration whose SQL creates it
  (`migration_creating_table`). Every guarded session table must resolve to a
  migration (`every_guarded_inventory_table_names_its_creating_migration`).
- **I1.** `no_shipped_writer_replaces_policy_rows` scans the non-test Rust and
  SQL sources and fails if any writes policy rows with `REPLACE`.

The three replay tests (`namespace_switch_is_seen_by_the_replay`,
`kind_flip_is_seen_by_the_replay`, `row_column_moves_are_seen_by_the_replay`)
used to require that their short sequence replay at least once. With the fixes
the hook after each write rebuilds instead, so they now assert that this hook
rebuilds and matches the full computation, and that a later logged change
replays exactly. `row_column_moves_are_seen_by_the_replay` covers both the
`lineage_id` and the `ordinal` move.
