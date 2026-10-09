# Provider historian: adversarial cache review

## Scope and independent review

Reviewed the M5 diff against its starting HEAD: `providers/historian.rs` (new),
`providers/mod.rs`, `providers/step_transform.rs`, `mc-module/src/lib.rs`, and
`mc-store/src/provider_log.rs`. Independent read-only review was performed by
Sidekick request `sk_worker_00000000-0000-4200-98dd-ab40ec1e48c8`; it inspected the
uncommitted diff, the reviewed D3.8 specification, and the existing compaction
and publication paths. It supplied risk candidates and test recipes, not a
correctness verdict, and did not execute tests. The implementation author ran
and adjudicated the checks below. No blocking candidate remains undisposed.

The parent authorized the store-file extension after finding that ordinary
provider appends lacked `mc_block_identities` rows required by the existing
publication CAS. The permission was identity-only persistence, idempotent replay,
conflict refusal, and no full frozen-state commit. That is the implementation
used here; neither `publish_historian_chunk` nor its predicates were changed.

The parent also clarified the oracle's loosely worded `hi'`: **newest is the
input-log high-water, not the selected chunk end**. Existing protected-tail
boundaries and historian token budgets remain authoritative. Tests compare the
exact cause and selected range produced by the existing full-request preparer
on the same complete input, and explicitly exclude protected-tail ordinals from
published compartments.

## Mechanism and cache surface

- Only a persisted `pass_complete` barrier schedules background work. Opening a
  synchronized pass or processing a non-final hook clears the previous barrier.
  Chain changes retain an evaluation-due flag until a completed barrier consumes
  it, including the unchanged-watermark state-sync request with no append.
- Message-log reads and decoding occur without the conversation lock. The worker
  rechecks lineage, synchronized chain, barrier generation and final ordinal
  before accepting the snapshot. Another worker cannot consume the same barrier
  twice. Trigger tokenization, rules and assembly do not hold the hook lock.
- The trigger uses the existing `prepare_historian_fire` and assembler. Its inputs
  are the stored model chain, complete immutable raw ingest, and synchronized
  `provider_pass.historian_inputs`: usage, geometry, execute threshold, model
  budgets/variants, output/timeout limits, recovery flag and reclaim-ride flag.
  A new pass omitting those optional inputs receives ordinary missing-input
  defaults, not stale pressure from the preceding pass. The host adapter must
  send the same resolved inputs as its full-request lane when available.
- Debounce counts the last real user and ingested tool-result blocks, not live
  hook answers. Replay does not add tool results; a lineage change resets cadence.
- Fires use the existing pending/claim/complete lifecycle and CAS. Existing
  compaction reads the namespace's durable historian phase for its VETO. Restart
  adoption receives the provider-log fence instead of requiring a nonexistent
  full-request snapshot generation.
- The extra publication fence holds the provider lock while checking ancestry
  and executing the unchanged CAS. A cut inside the selected source refuses even
  before the engine's revert epoch changes. The publication floor is the first
  unprocessed ordinal, so a cut retaining `floor - 1` is valid. Concurrent
  admission refuses publication as a local race, without a model cooldown.
- Selected identities come directly from the same codec ingress and engine
  projection as compaction. They are inserted just before run launch under the
  provider lock: the store cannot derive them during ingest without depending
  on the module's host codec. The batch refuses conflicts before inserting any
  row, inserts only missing identities, and invalidates the disposable
  `mc_cache_state_digest` comparison memo. It changes no frozen units, sections,
  served fingerprints, cache metadata or row version. An external SQLite
  `PRAGMA data_version` check proves identical replay makes no database write.

## Independent findings and dispositions

1. **Same-user pressure crossing could be missed immediately.** D3.8 explicitly
   declares once-per-user / every-25-tool-results debounce rather than today's
   per-pass check. The oracle is about the first permitted evaluation at or after
   the crossing, not an immediate evaluation of every assistant append.
   `same_user_pressure_crossing_waits_for_debounce_then_matches_oracle` starts
   below the full-request trigger, crosses it during the same user turn, proves
   that the full-request control fires, then checks exact cause/range equality
   on the next 25-result evaluation using its complete newer log. Disposed as the
   specified debounce, not an untested threshold change.
2. **State sync marked complete, followed by hooks, could evaluate early.** That
   recipe contradicts the same-pass flag's contract: state sync carries
   `pass_complete` only when there are no hooked appends; otherwise the final
   hook owns it. The module does not predict future hooks after a caller declares
   a pass finished. The valid forced-interleaving recipe is defended by
   `state_sync_and_partial_hooks_wait_for_complete_ingest_and_stored_chain`:
   synchronize through 78, force evaluation, ingest message 79 with a non-final
   hook, force evaluation again, then ingest 80 with the barrier. Both premature
   evaluations defer; the final one sees all 80 messages and the stored chain.
   Removing the barrier turns precisely that test red. Host flag placement
   remains an adapter contract, not a new M5 authorization mechanism.
3. **Publication ancestry edges and contention lacked proof.** Added
   `publication_fence_accepts_surviving_cuts_and_refuses_busy_admission` and the
   below-range descent test. The accepted-cut recipe initially failed at the
   inclusive last selected ordinal, exposing an off-by-one comparison to the
   exclusive publication floor. Fixed the production comparison to `floor - 1`;
   cuts at and above the selected end now publish, a cut just below refuses, and
   a held admission lock produces no write and no model cooldown.
4. **Identity replay/digest proof was incomplete.** Strengthened
   `identity_upsert_is_idempotent_and_conflicting_batch_is_atomic`: check the memo
   exists before insertion and is deleted afterward; check external database
   data-version stability on replay; check that a conflicting batch did not
   insert its other row; compare cache state/version before and after conflict.
   The ordinary-append claim test proves the newly admitted source is actually
   publishable, not merely that an identity helper returned a count.
5. **In-flight coverage was not a complete pass-class differential.** The new
   test compares an 80%-usage queued-drop step with the real full-request engine,
   checks the pending drop is not first-applied, kills the in-memory firing task,
   reopens the database, checks the same VETO, and adopts/publishes the host report
   through the existing CAS. The full-request control was aligned with the
   provider's render identity so an unrelated HARD identity change did not
   masquerade as a VETO failure. The complete module suite, including existing
   provider compaction/review tests, also passes. No compaction permission or
   producer code was changed.
6. **Comment clarity.** Rewrote the flagged explanations of snapshot versus
   database fences, synchronized input contents, digest invalidation, admission
   contention, shared worker ownership, snapshot revalidation, retained codec
   representation, selected identities, and restart persistence. Comments now
   explain the reason without depending on task labels or review numbers.

A further implementation failure was caught by the real claim/CAS test: a JSON
round trip of decoded conversation blocks changed their retained native content
fingerprints, conflicting with bootstrap identities. Installing decoded ingress
directly, as `Codec::prepare_request` does for compaction, fixed that failure.
The oracle also uses that real codec entry point instead of reproducing the
round-trip mistake as its expected value.

## Pass-class assessment

| Class | Cache behavior and evidence |
| --- | --- |
| defer | Hook answers never await trigger work; a deliberately blocked preparer cannot block a later hook. Publication on a warmed below-threshold pass answers `noop` and creates no view row. |
| execute | Existing compaction remains the sole permission owner. Full module/provider suites cover its threshold and force-band paths; M5 adds no view-writing path. |
| fold | Claim completion publishes compartments by existing CAS, not a replacement. Any later fold still requires the existing engine opportunity. Protected tail is excluded from the published source. |
| revert | The ancestry fence rejects source cuts before engine recut, and accepts cuts retaining the selected range. A restored mutation proves the existing engine epoch alone is insufficient. |
| restart | Durable phase still vetoes first drop application with no in-memory task. A parked report is reoffered, claimed and adopted without a full-request snapshot cache. |
| exit | No exit handler, route selection or served-array assembly changed. Historian publication still has no direct view output; pending runs retain their original namespace/CAS and provider ancestry fence. Host exit behavior remains in the adapter slice and existing provider lifecycle tests. |

This is correctness coverage, not a live-host performance or full-campaign corpus
claim. Background log scans are still history-sized; the timing assertion uses
80 messages and a blocked preparer. Live 7.5k-session performance/cutover and the
cross-host served-array corpus remain the campaign's later gates.

## Restored mutation proofs

Each mutation was applied only after staging the live implementation and proving
`git diff --stat` empty. Each red command selected exactly one named test and
checked its exit 101 explicitly. A separate unaffected control then ran against
that same applied mutation and stayed green (named below). **No other test
failed**; tests beyond those two were not run by the paired command.
Restoration used `git checkout -- <path> && touch <path>` and again produced an
empty unstaged diff. All mutations carried `NON-VACUITY BREAK`; none remains.

| Control | Exact red test (`providers::historian::tests::` prefix) | Unaffected green control (same prefix) | Applied / restored diff | Failure |
| --- | --- | --- | --- | --- |
| Skip the identity INSERT for selected ordinary append `m4` | `ordinary_append_publishes_via_claim_cas_without_nonopportunity_view` | `identity_upsert_is_idempotent_and_conflicting_batch_is_atomic` | `provider_log.rs`: 2 insertions / empty | Existing CAS: `selected historian message m4 changed after firing`; 0 passed, 1 failed. |
| Treat an open pass's frontier as a completed barrier | `state_sync_and_partial_hooks_wait_for_complete_ingest_and_stored_chain` | `debounce_counts_ingested_tool_results_not_replayed_hooks` | `historian.rs`: 3 insertions, 4 deletions / empty | First premature evaluation was not `None`; 0 passed, 1 failed. |
| Ignore a cut inside the selected source range | `descent_during_run_refuses_publication_before_engine_revert_epoch_changes` | `publication_fence_accepts_surviving_cuts_and_refuses_busy_admission` | `historian.rs`: 2 insertions, 1 deletion / empty | Stale run completed and stored 2 compartments instead of 1; 0 passed, 1 failed. |

## Verification

All build/test commands requested Linux and used a Linux guard; no local fallback.
Cargo invocations were serialized. Cargo version: **1.99.0 (5f94df478 2026-08-27)**.

- `cargo check -p mc-module -p mc-store --locked --all-targets`: passed, two changed
  crate targets and their tests/integration targets checked.
- `cargo test -p mc-module -p mc-store --locked --lib -- --test-threads=4`: passed.
  Module: **1785 passed, 25 ignored** of 1810; store: **290 passed, 5 ignored** of
  295. This final restored run includes all **11** new historian tests.
- After the paired mutation controls were restored, repeated the all-targets
  check and `cargo test -p mc-module --locked --lib providers::historian::tests
  -- --nocapture`: **11 passed**, zero failures; final formatting check passed.
- `cargo fmt --all`: applied locally; final `cargo fmt --all -- --check` and
  `git diff --check`: passed.
- `npm run build`: passed for all three build packages (Bun 1.4.2, npm 11.19.0).
- `npm run typecheck`: passed for all four packages; TypeScript **5.9.3**.
- `npm run lint`: exit 0; checked **1286 + 248 + 135 + 6** files. Existing warning
  diagnostics were not edited.
- `npm run test`: plugin **7621 passed, 7 skipped, 1 failed** of 7629. Unrelated
  environment failure: `Node WASM Transformers fixture > builds with real fs and
  persists a model for offline reuse` cannot resolve `onnxruntime-web/webgpu`
  from the remote temporary bundle. This stopped the root test chain.
- Ran the remaining package test scripts separately: Pi **1634 passed, 3 skipped**
  of 1637; CLI main suite **612 passed, 2 skipped** of 614, then its isolated
  repair-db subprocess **9 passed, 1 failed**. The unrelated failure is
  `doctor repair-db > backs up and salvages readable rows from a genuinely
  corrupted SQLite page`: replaying `.recover` output rejects reserved
  `sqlite_sequence`. Retina **27 passed** of 27.
- Repository test scripts ran their frozen installs: 1010 installs / 1251 packages,
  **no changes**. No package manifest or lockfile changed.
- AFT inspection remained partial: the checkout call graph was unavailable and
  the final `lib.rs` diagnostic request timed out. Other scoped files reported
  zero Rust diagnostics. The authoritative remote all-targets check and full
  library suites above passed.

Neither unrelated TypeScript/environment test failure was changed or hidden.
The narrow Rust behavior gates are green; the two baseline/environment failures
must still be considered before any repository-wide release gate is declared green.

## Follow-up independent review fixes

Review commit `34d20b2dda07c93478119dbe5a67f639aaa601e0` was cherry-picked as
`2bf5df6aa6`. Its report and all review tests are kept unchanged. The review's
200-session experiment found zero mismatches across 163 publications and 117
reopens, but exposed the recovery and reminder cases listed in `m5-review.md`.
The earlier disposition of recovery as complete is superseded by these fixes.

### F1: do not consume an unfinished evaluation

The accepted barrier is an in-process duplicate-exclusion marker, not completion
of the trigger. Its transaction now leaves `historian_evaluation_due=true` and
does not advance cadence before the existing decision recorder runs. After that
outcome, cadence is committed against the same barrier generation. A FireReady
outcome also stores `historian_launch_pending`, because a recorded decision is
not yet a durable run. This preserves retry intent if the process dies either
before trigger preparation or after returning FireReady but before task launch.
It does not replace the existing non-Idle run recovery.

Verification (Linux guard, Cargo 1.99.0): the unchanged
`review_m5_crash_before_launch_retries_completed_barrier` and
`review_m5_two_concurrent_evaluations_launch_only_one` each passed; the new
`prepared_but_unlaunched_fire_retries_after_restart` passed. All-targets checking
passed. A paired mutation restores early cadence consumption and clears retry
intent before the cancellation seam: the crash review test alone fails, while
the concurrent-evaluation control stays green. Staging preceded mutation;
checkout plus touch restores an empty unstaged diff. Comment review found no
unclear new comments. No review assertion or test was edited.

Before cost optimization, the unchanged `review_m5_20000_message_scan_cost`
passed and measured: payload load 21.675 ms, frontier 5.318 ms, first evaluation
3581.929 ms, debounced evaluation 674.588 ms, same-runtime 1 ms timer 674.763 ms;
payload 3,855,571 bytes. Its structural history scan is 20,000 payload rows plus
20,000 ordinal rows. These are debug-build measurements, not a release SLA.

### F2: retry publication refusals without a model cooldown

Prepared provider runs carry a completion observer into the existing firing
driver, including direct/static launches used by the unchanged review tests.
The observer settles only its own launch generation. An error returning the
namespace to Idle without an active model backoff sets a separate durable
`historian_run_retry_due` marker; the next completed pass bypasses debounce.
Successful completion clears the matching launch intent. A small store
transaction reloads current counters before editing those fields, and never
waits for the provider admission lock which the report publisher collided with.
An older completion cannot clear a newer launch or synchronized input.

Paid output is **not retained for republishing by this fix**. The existing live
host driver calls `finish_historian_pending_run` immediately after receiving its
report, before validation/publication; the rejected run then returns to Idle.
Its queue row and matching publication predicate no longer exist. The existing
parked-report adoption API protects reports across restart, but cannot adopt a
report already consumed by this live path. This fix permits a fresh run on the
next pass, which can incur another model call. Retaining paid output would need
an explicit durable report/source-identity cache and fresh validation/CAS policy
in that shared lifecycle, rather than replaying a stale publication predicate.
No hidden output cache or claim-lane fork was added.

Verification (Linux guard, Cargo 1.99.0): unchanged
`review_m5_publication_contention_retries_next_complete_pass` passed; the existing
surviving-cut/contention control passed; new
`old_run_completion_preserves_newer_launch_and_sync_inputs` passed; module/store
all-targets checking passed. The mutation clears launch intent but neutralizes
run-retry marking: the unchanged contention-retry test alone turns red, while
the surviving-cut/contention control stays green. Staging, nonempty mutation
diff and empty checkout/touch restoration are recorded. Comment review's three
clarity suggestions were resolved. Review tests remain unedited.
