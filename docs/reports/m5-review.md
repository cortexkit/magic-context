# M5 correctness review

## Verdict and scope

**Do not accept M5's crash/race recovery as complete.** The chunk-selection and
publication differential passed, but two regression tests demonstrate that the
provider's persisted debounce can suppress recovery of unfinished work. A separate
force-band comparison also finds an inherited native-reminder byte mismatch. No
product code is changed by this review. The only source edit outside the new test
file is an `include!` inside the existing `#[cfg(test)]` module.

Reviewed `41b3f67b51a3bb5840a8cdb059109f4ba7ef23f2` against `51e7b1f5`, after
reading `docs/reports/adversarial-cache-review-m5.md`. H4 supplying the same
resolved scalar policy is an assumption, not something this review implements.
The host claim runner is used for provider fault injection; the existing full
engine's runner/restart tests supplement it.

## Findings

### F1 — A pre-launch crash durably consumes the only permitted evaluation

**Severity: medium (correctness / restart liveness).** History summarization can
remain absent throughout the rest of the same user turn, even after pressure
crossed the trigger. This is not a permanent `in_flight` wedge: the durable phase
is still Idle. A new real user or 25 additional tool results can eventually
unblock evaluation.

- **Input:** 80 alternating user/assistant messages, 800 repeated words per
  message, ordinals 1–80 in lineage `L`; model chain `test/model`; usage
  45,000/50,000. A completed pass is prepared. Abort the evaluator after it saves
  cadence/barrier bookkeeping, before trigger preparation or run launch. Reopen
  the database, submit another completed pass with no append and the same inputs.
- **Expected:** unfinished evaluation is retried. The full engine's
  `prepare_historian_fire` on exactly these messages still returns `FireReady`.
- **Actual:** the provider returns `None`; no claim is offered and no compartment
  is published. The regression fails with
  `a crash after consuming the barrier but before launch must not lose the pending evaluation; actual=None`.
- **Cause:** `crates/mc-module/src/providers/historian.rs:293` marks the barrier
  evaluated, and `:326-332` clears `historian_evaluation_due` and persists the
  user/tool cadence **before** `prepare_historian_fire` at `:350`. On the next
  barrier `:286-299` finds unchanged cadence; recovery at `:257-260` only applies
  to a non-Idle durable phase. No durable phase was established before this crash.
- **Failing test:**
  `providers::historian::tests::review_m5_crash_before_launch_retries_completed_barrier`.
  It checks the full-engine positive control before asserting the provider retry.
  The abort seam is after the production bookkeeping save; it is not an artificial
  change to the trigger or database.

### F2 — Publication contention discards the report and suppresses the promised immediate retry

**Severity: medium (correctness / paid-work loss).** An ordinary overlapping
provider admission can lose a paid historian result and leave the entire
same-user interval without published history. The historian veto is released,
so this is a lost-retry defect, not an infinite non-Idle wedge.

- **Input:** the same complete 80-message input as F1. Launch the real host run,
  claim it, hold the provider admission lock, and complete the claim with valid
  XML covering the selected range. Wait for the firing task to finish, release
  the lock, then submit another completed pass with no new user/tool result.
- **Expected:** the lock collision may refuse publication, but the no-cooldown
  local-race recovery must permit another evaluation on the next completed pass.
  The full engine remains `FireReady` on this unchanged, still-unpublished input.
- **Actual:** publication refuses with `provider admission in progress`; the
  durable phase is Idle, backoff is absent, and compartments are empty. The next
  provider evaluation nevertheless returns `None`.
- **Cause:** `providers/historian.rs:73-76` rejects lock contention; the shared
  publication path releases the matching run without cooldown
  (`crates/mc-module/src/historian.rs:926-939`). The provider has already consumed
  cadence (`providers/historian.rs:293,326-332`). Its scheduler only sets retry-due
  on **preparation** errors (`:145-153,158-169`); run failures are logged without a
  provider retry callback (`crates/mc-module/src/lib.rs:7539-7553`). The next pass
  is then suppressed by `providers/historian.rs:286-299`.
- **Failing test:**
  `providers::historian::tests::review_m5_publication_contention_retries_next_complete_pass`.
  It first proves that the intended fence refusal occurred, there is no model
  cooldown, and the full-engine positive control can fire; only the missing
  provider retry is the final failing assertion.

### F3 — A retained hook reminder survives a force rebuild that the full request does not emit

**Severity: low (native-byte parity); inherited path, not established as an M5
regression.** The actual age/drop gates agree with the full engine, but the served
force-band replacement contains an extra 182-byte reminder. It occurs with and
without a running historian.

- **Input:** the 80-message corpus above, replacing message 2 with a `read` result
  containing `"old payload "` repeated 3,000 times, and messages 40, 50 and 60
  with newer, small read results. Both state copies receive the same raw ingest,
  hook/tag allocation history, retained compartment and historical execute
  watermark 3. Confirm serving through ordinal 80, queue `m3#0`, and request
  90,000/100,000 usage. Run once with a real pending historian and once without.
- **Expected:** the current complete-array full-request transform's native
  replacement is byte-identical to the provider replacement. Both sides consume
  the queued drop and drop the old tool result; these positive controls pass.
- **Actual:** native JSON first differs at byte **226,317**; actual **309,124**
  bytes versus expected **308,942** bytes. Message 60 retains
  `\\n\\n<system-reminder>\\nspent tool outputs (~60k tokens) are still unstamped. Call ctx_reduce now, before your next tool call, ...`,
  whereas the reference ends that tool output at the original `fresh payload`.
  Both the active and inactive controls have the same difference.
- **Cause:** `providers/step_transform.rs:164-179` constructs a channel-1 reminder
  as a hook Append, and `:856-863,887-893` retains it in the non-tag operations.
  `providers/compaction.rs:213-272` replays those saved operations before invoking
  the force-band transform at `:520`. The complete-array reference evaluates its
  outgoing bytes after current-pass drops and does not emit that reminder. No
  reminder reconciliation is performed when replaying the earlier hook answer.
  `transform.rs`, `providers/compaction.rs`, and `providers/codec_opencode.rs` have
  **no M5 diff**; M5's step-transform diff does not change this reminder producer.
- **Failing test:**
  `providers::historian::tests::review_m5_veto_drop_and_age_heuristic_matrix_matches_full_engine`.
  It completes all five cases and the two genuine mutation-positive controls
  before failing with the two byte diffs. It does not fail because age selection
  was never exercised.

This is a batched-ingest/current-complete-input differential. It does **not** prove
that a full-request lane with an additional historical model call at message 60
would lack a previously served reminder. Review that chronology before treating
this inherited mismatch as a live-host regression or a new priced cache bust.
The report and test preserve the observed difference rather than silently
normalizing away the reminder.

## Equivalence experiment

`review_m5_randomized_200_complete_inputs_and_publications` uses fixed-seed
xorshift (`0x51e7b1f541b3f67b`) over **200 independent sessions**. Each contains
20–119 messages with alternating real user/assistant roles and independently
randomized body lengths. It varies 40k/50k/100k context limits, 20/60/80/90/99%
usage, reclaim-ride availability, and output limits. Every input is admitted in
two slices; every third session reopens its database before evaluation. Some
published sessions reopen it again afterward.

The reference calls the existing full-request `prepare_historian_fire`, using
`Codec::prepare_request` on the **same complete immutable raw input**, not the
provider's log reconstruction or its cadence counters. Each comparison includes
fire/refusal signature and selected interval, the selected raw-message bytes and
chunk fingerprint. Actual publications and reference publications both run the
real claim/complete/validation/CAS lifecycle. The reference admits codec-derived
selected identities through an ordinary engine-state commit, not the new
provider identity helper. Published rows are compared as canonical JSON with
**only `created_at` normalized**, including endpoints, dates, narrative tiers,
importance, episode type and legacy flag. Selected ends and published sources
are checked against the protected-tail boundary.

Observed: **163 firings/publications, 117 database reopens, zero decision,
chunk-byte or compartment-byte mismatches**. `newest` is not treated as the chunk
end anywhere in the oracle. A mismatch emits first differing byte, both lengths,
and surrounding actual/expected bytes.

Limits: this is a randomized text-session differential, not a 200-session live
host campaign. Tool cadence, ancestry cuts, claims and identity races have
separate deterministic tests. It does not prove H4's scalar resolution or
provider-adapter flag placement. It does not fuzz every serializer or model.

## Served bytes and mutation gates

`review_m5_served_native_bytes_fire_next_and_published_pass` warms a three-message
prefix, ingests and serves all remaining hooks, then compares the **whole native
OpenCode message array** (canonical JSON bytes) with full-engine transform plus
native rendering on the same raw log. Each of these passes compares the served
native-array bytes against the independently rendered full-engine array:

1. the completed pass whose background evaluation selects a historian chunk;
2. the following pass with a real claimed/pending historian;
3. the low-pressure pass after successful publication.

The provider answers `noop` on these defer passes; their retained view plus live
hook bytes match the full engine. Publication alone produces no view/bust.
Ordinary bootstrap hooks are run before warming so the provider and full engine
share real tag allocation history. Early fixtures with missing bootstrap hooks
or missing served acknowledgements produced `§1§` versus `§4§` and `[dropped]`
versus `[dropped §2§]` differences. Those compared different tag-allocation or
promotion states and were corrected, not promoted to M5 findings.

`review_m5_veto_drop_and_age_heuristic_matrix_matches_full_engine` uses an old
`read` tool output, three newer read results (the window always protects at least
three tool results), a prior execute watermark at ordinal
3, and a separately queued text drop. The watermark is seeded identically on both
sides: age reclaim only drops tool results that an earlier execute already
observed; the later pass must independently authorize a prefix rebuild. Protection
is explicitly set to zero on both sides; the three newer results satisfy the
structural protection minimum without protecting the old candidate.
It compares ordinary defer, 80%-usage active/inactive passes, and 90%-usage
force-band active/inactive passes. Both state copies use matching hook histories;
served acknowledgements promote the allocated tags before the comparison (the
provider acknowledges through the actual step, the reference through the store's
normal status transaction). The active provider state comes from an actual
host run, not a fabricated phase. It checks pending-drop consumption, native
replacement bytes when there is a replacement, and a positive force-band control
that must really drop the old tool and consume the queued drop. Those mutation
controls pass on both sides. The native-byte assertion nevertheless fails on both
force passes because of the retained hook reminder documented in F3.

The 80% no-op is **not by itself proof of an effective historian veto**: the
inactive control also defers for lack of an originating rebuild. This matters
when interpreting the worker's earlier 80% queued-drop test. The force controls
are included specifically to show that eligible mutations execute when the
shared engine grants a real ride. The narrow matrix does not cover every cleanup policy, reminders appended by
hooks with a host-supplied exact execution plan, mutation bypasses on hard prefix
folds, exit handling, or the 95% emergency backstop. Those remain broader campaign
coverage. The existing provider/full
engine compaction tests supplement the narrow matrix.

## Crash and race matrix

`review_m5_provider_crash_claim_report_publish_matrix` exercises provider-log
restart adoption at four durable boundaries:

| Crash boundary | Observation |
| --- | --- |
| Queued, before a claimant owns the run | Same run ID is reoffered; one publication; Idle afterward. |
| Claimed, during the host run | A replacement claimant takes the expired lease; the old token's late report is refused as `superseded_token`; one publication. |
| Valid report received, before publish | A report parked across restart is adopted while checking source lineage and selected-message fingerprints; one publication. |
| After successful publish | Restart preserves the single publication, with no queued run and no stuck veto. |

The lease takeover uses the store's supplied clock at the exact lease deadline;
no wall-clock sleeps are used. `review_m5_two_concurrent_evaluations_launch_only_one`
parks the first evaluator after it consumes the barrier, runs a second evaluator
while the first is still outstanding, then releases the first. Exactly one is
`FireReady`. Existing M5 tests also exercise a descent through the selected range,
a surviving cut at its inclusive end, and admission contention at publication.
The pre-launch crash finding covers the earlier, **pre-durable-run** gap these
successful restart cases do not reach; the lost-publication finding extends
contention beyond mere rejection to next-pass liveness.

This is task cancellation/database reopen, not OS power-loss or SQLite fault
injection at every transaction instruction. Existing full-engine historian tests
cover producer reattachment and Publishing-phase recovery, but do not replace a
provider-specific before-launch crash test.

## Identity rows and replay

- Identity rows are **not written at raw ingest** at this revision. The 80-message
  ingest control finds zero identity rows. They are admitted for the selected
  range just before run launch (`providers/historian.rs:369-387`), as the worker's
  report correctly explains, despite the brief's shorthand “at ingest.”
- The 200-session publication differential exercises real CAS with those derived
  rows, not fabricated host fingerprints. The non-provider full-request control
  has no provider namespace and persists exactly the ordinary codec projection;
  a second identical transform leaves its identity vectors unchanged. M5's diff
  introduces no new non-provider identity-write call.
- `identity_upsert_is_idempotent_and_conflicting_batch_is_atomic` checks a separate
  SQLite connection's `PRAGMA data_version`: identical **identity upsert** replay
  makes no database write, and a conflicting batch inserts none of its other rows.
- `review_m5_identity_conflict_is_atomic_and_background_retries` additionally
  injects a preexisting conflicting selected vector. Direct preparation returns
  an error, no other selected identities are inserted, no run starts, and the
  scheduled path leaves `historian_evaluation_due=true`. The scheduled conflict
  is surfaced in a background warning, not in the already-returned hook reply;
  it is not propagated as a synchronous host error.
- A replay of the **ingest transaction itself** is not write-free:
  `review_m5_ingest_identity_scope_and_replay_writes` records external
  `data_version` **2 → 3** for `commit_provider_status` with the same held bytes.
  Stored messages remain byte-identical. This is distinct from identity-upsert
  replay and belongs to the pre-M5 status/counter write path; it is not called a
  new M5 identity defect. The unconditional conversation/counter save is in
  `crates/mc-store/src/provider_log.rs:1115-1213`.

## Cost: 20,000 messages

`review_m5_20000_message_scan_cost` stores one user message and 19,999 assistant
messages, each with 12 repeated words. It measures both initial evaluation and
an unchanged-user **debounced** evaluation. Representative serialized Linux debug run:

| Measurement | Result |
| --- | ---: |
| Native message payload bytes | 3,855,571 |
| `load_provider_messages` | 20.391 ms; 20,000 payload rows returned |
| `provider_frontier` | 6.334 ms; 20,000 ordinal rows traversed |
| First evaluation, including decode/tokenization/assembly | 4,070.444 ms |
| Scheduled subsequent debounced evaluation | 702.821 ms |
| A simultaneous 1 ms timer on the same runtime | 702.995 ms |

The per-evaluation history row count is **40,000**: the payload SELECT in
`mc-store/src/provider_log.rs:542-562`, followed by the ordinal SELECT in
`:564-587`, before the debounce check. This is a structural count confirmed by
returned message count/frontier on this gap-free, single-lineage fixture, **not
an instrumented SQLite VM-step count**; small conversation/meta/ancestry reads
are additional. Database rows are not claimed to be physical disk reads.

The worker is **off the caller's awaited pass path**, but it is not background
CPU/I/O isolation. `providers/historian.rs:143-155` uses `runtime.spawn`; log reads,
JSON/codec decode and tokenization are synchronous on that executor thread
(`:214-253,348-368`). The current-thread runtime timer experiment demonstrates
starvation even on a pass which ultimately debounces. On a multi-thread runtime
other threads can run hooks, but synchronous work still occupies an executor
thread and database scans take the shared store connection. This is a measured
responsiveness/performance risk, not a promised latency-SLA failure or a claim
that every multi-thread host hook stalls for 703 ms. The debounce avoids trigger
work, **not** history-sized scan/decode work. Measurements are debug-build, not
live-host release benchmarks.

## Verification and delivery

All Cargo commands used remote Linux with the required leading
`test "$(uname -s)" = Linux || exit 90`; jobs were serialized and waited with
`bash_watch`. Cargo **1.99.0 (5f94df478 2026-08-27)**, rustc
**1.99.0 (b940084d7 2026-09-28)**, rustfmt **1.10.0-stable**.

- Baseline `cargo test -p mc-module --locked --lib providers::historian::tests -- --nocapture`:
  **11 passed**, no failures.
- `cargo fmt --all -- --check` and standalone
  `rustfmt --edition 2021 --check crates/mc-module/src/providers/m5_review_tests.rs`:
  passed (the standalone check covers the included test file explicitly).
- `cargo check -p mc-module --locked --all-targets`: passed for library, test,
  integration and binary targets.
- `cargo test -p mc-module --locked --lib -- --test-threads=4 --skip review_m5_crash_before_launch_retries_completed_barrier --skip review_m5_publication_contention_retries_next_complete_pass`:
  **1,792 passed, 1 failed, 25 ignored, 2 explicitly filtered out** of 1,820 total
  tests. The only failure is the matrix's two retained-reminder byte diffs (F3);
  its mutation-positive controls pass. This run includes the final 200-session
  comparator with all compartment fields compared, all 11 original M5
  controls plus the remaining provider/full-engine library regressions. The run
  took 1,063.62 seconds; it was not rerun wholesale after the known failure.
- The two filtered tests were separately run with their **full exact names**:
  each ran **1 test**, failed its named missing-retry assertion, and exited 101.
  F1 and F2 above contain the failure output. The shell recorded
  `green_gates_exit=101 expected_crash_exit=101 expected_race_exit=101`; no claim
  that this is a green library suite is made.
- `cargo test -p mc-store --locked --lib provider_log -- --nocapture`:
  **20 passed, 1 ignored**, zero failures.
- `cargo test -p mc-module --locked --lib tests::gate_a2 -- --nocapture`:
  **6 passed**, zero failures; includes stale-claimant takeover, late-token
  refusal, unreachable parked-run sweeping, and report adoption across restart.
- All three named regression tests remain failing by design; product code is
  not patched or their expected contracts weakened. Final isolated matrix run:
  **1 test failed**, after all five cases and both positive mutation controls
  completed; both force-pass byte diffs exactly reproduced F3. Final formatting
  and all-target checks passed. The shell recorded
  `final_check_exit=0 expected_matrix_exit=101`.
- An early short-name `--exact` invocation selected zero tests; it is explicitly
  **not** verification evidence. Subsequent runs use real nonzero filters.
- AFT inspection was partial while rust-analyzer indexed; authoritative Cargo
  checking is used instead.
- No manifests/lockfiles changed. TypeScript build/typecheck/lint are not relevant
  gates for a test-only Rust/report change and were not rerun.
