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

### F3 source checkpoint: engine-owned rebuild reminders

The parent authorized the additional narrow `transform.rs` gate change after
confirming that provider compaction requests bypassed the private engine nudge
decision. Blame and `git log -L` identify `ef6caa376aa4c67fe08706f4d2fbf08a94a3fc3c`
as the commit refining the host exclusion; its predecessor already skipped the
OpenCode provider step so hook reminders would not be generated twice. The new
protection is to remove retained hook Channel-1 Appends from engine input, not to
duplicate the post-drop decision in a provider. Newly retained operations get an
ownership note; returned wire operations and ordinary served bytes are unchanged.
Legacy note-less post_tool Appends are recognized as the old Channel-1 form.

The chronology caveat matters. The new regression runs actual low-pressure model
calls through 60 and through 80 before the force rebuild, and also covers a first
serve through 80 after the warmed three-message prefix:

- First serve through 60: the hook and full engine emit no reminder on m60;
  defer through 80 replays those bytes; force rebuild still matches with none.
- First serve through 80: the hook's served entry has one earlier reminder.
  The full engine also creates one reminder (its singular `1 spent tool output`
  wording matters), saves its exact bytes and keeps them on the force rebuild.
  Merely stripping the hook Append initially failed this chronology: the provider
  omitted the engine's historical reminder. A pending-reconciliation scalar now
  forces one engine observation even on a compaction step that ultimately answers
  noop. It saves the engine-owned reminder without changing the host record's
  earlier hook bytes; the later priced replacement matches the full engine.

Linux runs passed the unchanged five-case
`review_m5_veto_drop_and_age_heuristic_matrix_matches_full_engine` and new
`chronology_hook_bytes_replay_on_defer_and_rebuild_matches_full_engine` (one test
with both histories). Both source arrays contain at most one reminder, and the
whole force replacement is compared as canonical native bytes. The original
review file is not edited. Comment-review suggestions were resolved.

**Checkpoint only:** the runner drained again before all-targets checking and
full-engine vector/differential gates. Remaining mutation and broader gates are
not yet claimed. The parent requested an explicitly unverified source checkpoint
while MOTOR updates the runner; final verification/disposition follows below.

### Cost source work and runner incident

Debounce now consults scalar raw-ingest watermarks (latest real user, tool-result
count, lineage and ordinal high-water) before any message-log SELECT. New
contiguous admissions advance those facts from the already-decoded new messages;
replays do not advance counts. Gaps, descents and legacy missing summaries take
one cold reconstruction from a completed log. Payload load/decode and
projection/tokenization/assembly are dispatched through `spawn_blocking`, with
barrier/chain/lineage revalidation before accepting the blocking snapshot.

The initial cached-frontier prerequisite was wrong: `cursor_frontier` had been
maintained by compaction steps, but not ordinary hook/pass admission. Trusting
that old scalar caused preparation to return before the unchanged F1 test's
notification seam, so its unbounded wait hung until MOTOR's 30-minute job limit.
No passing result is claimed for job `01a120f7-8ddc-7748-95de-3acf0299fcd8`.
Admission now maintains the complete frontier in the same transaction: existing
prefixes extend via indexed point probes; changed lineage and legacy unknown
cursors take a cold ordinal scan. This is a correctness prerequisite, not a
replacement of the test's notification or expectation. The corrected isolated
F1 test ran one test and passed in **0.75 s**, under `timeout 600`; no local
fallback or overlapping unknown Cargo process was used. MOTOR confirmed the old
job terminated. An accidentally queued wider job was cancelled before tests,
then verification resumed one exact review test at a time as requested.

Corrected bounded review checks (fully qualified names, one background job at a
time, `timeout 600`, collected with `bash_watch`): F1 **0.75 s**, F2 **6.11 s**,
F3's five-case matrix **15.17 s**; each ran exactly one test and passed. Build
startup is excluded from those harness timings. No single test took minutes.
Review test blob remains exactly `3c6540c814a2a64db6868b4b1da8a7fccc53e881`, matching
the cherry-picked review commit; the independent report also has no diff.

The corrected isolated unchanged cost test passed in **14.10 s** (one test,
`timeout 600`). Its post-fix debug measurements were: direct payload API
**16.072 ms**, direct frontier API **4.562 ms**, first evaluation **3871.009 ms**,
scheduled debounced evaluation **0.735 ms**, and same-runtime 1 ms timer
**1.928 ms**. Compare the pre-fix **674.588 ms** debounce / **674.763 ms** timer.
The review's printed 20,000 payload/20,000 ordinal row fields describe its two
explicit standalone API probes; the evaluator now uses the transactionally
maintained scalar frontier, and the skipped path calls neither history API.
A separate counter/timer regression checks actual returned payload-row counts
and first-evaluation executor responsiveness, rather than inferring success from
elapsed time or reusing the review's descriptive row fields.

The counter/timer regression passed: **20,000** payload rows on the first
non-debounced evaluation, **zero** payload and ordinal rows on both an unchanged
pass and same-user assistant appends, with the first-evaluation 1 ms timer firing
in **11.397 ms** rather than waiting for CPU work. It completed in **12.43 s**.
Cached-frontier gap-fill/replay/descent regression passed in **0.14 s**; chronology
passed again in **4.19 s**. Strict Clippy found a let-and-return in the original
M5 identity helper; it was mechanically simplified without changing persistence.

Strict Clippy now passes for both changed crates and all targets, with
`-D warnings` (Cargo 1.99.0). The two additional M5-only warnings were resolved
without lint suppressions: publication guards are grouped for reattachment, and
the existing tuple test signature has a type alias. Runtime behavior and all
review assertions remain unchanged.

The cost mutation bypasses the pre-history debounce while leaving late cadence
checks intact. The zero-row regression fails with **20,000 actual payload rows
instead of 0**; the cached-frontier gap/replay/descent control stays green. Applied
`historian.rs` diff: 2 insertions / 1 deletion; checkout plus touch restores an
empty unstaged diff. This proves the row assertion observes a real message-log
SELECT, not a constant or timing-only proxy. Counter instrumentation is test-only.

### F3 mutation coverage and full-request differential

The parent accepted separate controls after the actual experiment:

1. Restoring retained hook Append replay reddens the **unchanged review matrix**
   at byte 226,317, reproducing both 182-byte force-band extras (309,124 versus
   308,942 bytes). Only that selected test fails; the full-engine first-serve /
   priced-pass / frozen-byte replay control stays green.
2. Restoring **only** the engine's former host skip leaves the batched matrix
   green: its first force observation applies drops and expects no new reminder.
   The real chronology regression instead reddens, with zero rebuilt reminders
   versus the full engine's one retained reminder (308,942 versus 309,158 bytes).
   This is the positive history case missing from the matrix. The parent explicitly
   corrected the earlier condition naming the matrix for this gate proof.

Both mutations have nonempty applied diffs (2 insertions / 1 deletion) and empty
checkout/touch restorations. The gate-only matrix result is recorded as
**undefended**, not misreported red; the chronology is a reddened control reaching
that same `transform.rs`/module target. All **14** existing `channel1_` vectors
passed under the restored old gate, including the full-engine first-serve,
compliance grace/refire and superseded-copy byte assertions. They are rerun under
the new gate to complete the full-request differential. No original vector or
review test was rewritten. Only provider host kinds change which decision owns
their reminders; the full-request condition is unchanged.

F3 final narrow verification is green after restoration: all **14** existing
Channel-1 vectors passed under the new gate (same assertions as the old-gate run),
the two-chronology regression passed, and the **whole unchanged 10-test independent
M5 review suite** passed in **173.26 s**. It reproduced **200 sessions / 163
publications / 117 reopens / zero decision, chunk and compartment-byte
mismatches**, all four crash/claim/report/publish boundaries, and the whole-native
served-array fire/next/published comparisons. All-target strict Clippy and final
format checking passed. The broader provider/historian/store, drive-fault and
conformance gates remain separately recorded below; the unverified F3 checkpoint
is now backed by the finding-specific byte, chronology and mutation checks.

The expected expensive individual test was also bounded and timed separately:
`review_m5_randomized_200_complete_inputs_and_publications` passed in **132.50 s**,
with exactly 200 sessions, 163 publications, 117 reopens and zero mismatches.
This is finite repeated database/codec/claim/CAS work, unlike the earlier F1
notification hang. Its duration was reported to the parent before broader gates;
the parent confirmed that cost is expected and authorized continuing.

Per-finding commits: F1 `4b137c547a`, F2 `edbeaff652`, runner-maintenance F3 source
checkpoint `ee1b63f141`, cost `f4a0d12540`, and verified F3 disposition
`3c128f5c6d`. The final broad gate record follows. No mutation remains in source.

The broad provider gate ran **147 tests** in **881.87 s**: 143 passed, 3 ignored,
and one existing assertion failed. The expensive entries were the already-existing
720-pass and randomized/adversarial parity corpora plus the 200-session review,
not the formerly hung F1 seam. The failure was
`rebuild_replacement_equals_hook_served_bytes_with_one_overlay_tag_per_block`:
a generic note-less post_tool Append `\nreminder` was incorrectly treated as
Channel 1 ownership. The legacy filter is now precise: owned notes or the actual
spent-tool-output system-reminder envelope, not every untagged Append. No old
assertion was rewritten. The failed test passed in **0.28 s**, the unchanged F3
matrix in **9.03 s**, and chronology in **4.74 s** after that fix. Comment review
found no unclear explanation. The impacted compaction and final broad gates are
rerun rather than declaring that earlier failed provider run green.

The impacted compaction rerun is green: **51 passed**, including the original
hook-served-byte assertion and all real-state/240-pass comparisons. Strict
all-target Clippy also passed after the precise legacy filter. This closes the
single failure from the earlier 147-test provider run without changing a test.

### Final broad gates (Linux, serialized)

- Historian-filtered module library: **253 passed, 2 ignored** of 255, **146.09 s**.
  This includes provider history/review tests and shared producer/restart logic.
- Full store library: **290 passed, 5 ignored** of 295, **18.84 s**.
- The impacted compaction suite and strict all-target Clippy are green as above;
  remaining full drive-fault library and conformance jobs run separately.

- Required full module library with `--features drive-fault -- --test-threads=4`:
  **1808 passed, 25 ignored** of **1833**, **870.76 s**. This final restored snapshot
  includes all provider, parity and independent review assertions, closing the
  earlier default provider run's single generic-Append failure. Six existing
  drive-fault-only `Atomic::fetch_update` deprecation warnings were emitted by
  Rust 1.99; they do not occur in the strict default-feature all-target Clippy gate
  and were not refactored outside the assigned behavior.

- Explicit conformance gate: **2 passed** (codec plus commons tool-provider suite),
  **0.33 s**. The role suite runs every advertised case supported by this module.
- Final strict `cargo clippy --locked -p mc-module -p mc-store --all-targets -- -D
  warnings`: passed. `cargo fmt --all -- --check` and standalone unchanged-review
  `rustfmt --edition 2021 --check .../m5_review_tests.rs`: passed; rustfmt
  **1.10.0-stable**, Cargo/rustc **1.99.0**.
- Every final build/test gate used a Linux uname guard, ran one Cargo invocation
  at a time, and was collected with `bash_watch`. Runner drains and the cancelled
  unknown/hung job are documented, not counted as passes. No local build/test
  fallback was used; local Cargo use was formatting only.

All three independent failing tests now pass unchanged. F1, F2, replay-filtering,
engine-gate chronology and zero-row debounce have staged/restored mutation
controls with named red and unaffected green tests. The remaining cost is the
first eligible history reconstruction/assembly, not per-debounced-pass work;
bounded retained summaries remain later-stage work. Paid-report reuse after a
live publication refusal is still explicitly not implemented as explained in F2.
No manifests, lockfiles, review assertions or independent review report changed.
