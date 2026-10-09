# Independent correctness review: fast-Rust M4

## Scope and verdict

Reviewed delivered tip **`b0ed31bc85ed9f85ae3ef821d310d37c4e049e63`**, the four
commits above `91401c96aa`. This is a review-only change: no fixes, no skipped
regressions, and no compatibility shims. The only edit to an implementation file
is the three-line test-module declaration in `providers/compaction.rs`.

**Six reproducible findings: three blocking and three should-fix.** The new
review suite runs eight tests: six fail at their behavioral assertions and two
controls pass. The controls include 32 handler-versus-engine comparisons.

Authority read:

- Folded campaign document, `owner-loop-round-0.md`: D1, D2.4–D2.8,
  D3.1–D3.10, A1–A10, and M4.
- The requested `origin/train/agent-move` copy of
  `.cortexkit/alfonso/drafts/host-runner-contract-extensions.md`, particularly
  D2–D4 and P1–P2.
- `ARCHITECTURE.md`'s protected cache-stability section.
- The supplied approved TTL ruling: admitted host engine scheduling uses
  `never`; the host's explicit `cold` signal owns idle expiry. This is not
  treated as a defect or mistaken for permission to change other lanes' TTLs.

All stores used by the added tests are `open_for_test` databases under fresh
`tempfile::tempdir()` paths. **No live store or live host configuration was
opened, read, written, or migrated.**

## Findings

### 1. Blocking: final-page gap refusal occurs after promotion and burning

**Test:** `final_history_gap_refuses_before_promote_and_burn`.

**Input sequence:** Setup; hold pending, tagged answers for `m1@1` and `m3@3`,
with ordinal 2 missing. Send a final sparse status with `newest=3`,
`served_through_ordinal=3`, and
`unserved_subjects=[{subject_mid:"m1",hook:"pre_user"}]`.

**Expected:** `history_unreadable`, `history_gap_from=2`, before either answer
changes state. Neither pending allocation should enter `mc_tags` and the refused
call should not advance the served watermark.

**Actual:** The answer correctly names gap 2, but `m1` is already **burned**,
`m3` is already **live**, tag 2 is in `mc_tags`, and the conversation watermark
is already 3. Captured assertion:

```text
a refused gap must leave both answers pending; ... watermark=Some(3)
  left: ["burned", "live"]
 right: ["pending", "pending"]
```

**Cause:** `host_step` calls `commit_provider_status` before checking the held
frontier against `newest`. `commit_provider_delta` bounds acknowledgement by
`MAX(ordinal)`, not completeness; promotion and burning have committed before
`incomplete` produces the refusal. The conflict case rolls back correctly, but
the gap case does not have the same transaction fence.

**Clauses:** M4's held-history refusal requirement; D1.6/D4 status admission;
D2.7/A10 gap recovery; the review brief's explicit requirement to refuse gaps
before any promote or burn. P1's newest-held bound does not by itself establish
that every earlier ordinal is held.

### 2. Blocking: the first historian publication differs from the real full-request engine

**Test:** `first_historian_publication_matches_the_real_full_request_engine`.

**Input sequence:** Empty-history full-request bootstrap with messages 1–3;
verify a settled `SOFT+` pass. Switch/bootstrap the host lane and acknowledge its
view. Publish the first compartment, **at sequence 0**, covering ordinal 1.
Send a 1%-usage step with no cold/flush/model signal. A separate temporary store
runs the real full-request engine through the same empty-history/publication
sequence, with a recent response timestamp so TTL is not a competing cause.

**Expected:** Agreement with the real full-request result required by A3 and the
skip oracle. The full engine returns `HARD` and `prefix_bust_permitted=true`;
the host must not hide that fold behind a `noop`.

**Actual:** Host answers `{"answer":"noop","request_id":"after-publish"}`.
The test fails only after asserting the oracle really returned `HARD` with
permission.

```text
full-request engine HARD-folded its first publication, but host returned ...
  left: String("noop")
 right: "compaction_message"
```

**Cause:** The fast path ignores first-fold state. More importantly, the
compaction wrapper selects `kind="compaction.step"`, whose existing
`first_fold_due` branch deliberately suppresses an empty-boundary first fold on
a scheduler defer. The delivered fast-path differential calls `execute_host`,
so its supposed full-engine oracle already includes this different policy.
Merely changing the boolean predicate would not reconcile that oracle.

**Clauses:** A3's below-threshold historian-publication corpus and exhaustive
list of declared differences; A7/D3.7's real-engine skip oracle; D1's one-engine
contract. This is **not** explained by the approved TTL change.

**Spec tension to resolve explicitly:** D2.5 and the architecture's general
ride-only rule say publications do not originate busts, but the real
full-request engine has a deliberate eager **first**-publication exception
(`first_compartment_published_after_empty_bootstrap_hard_folds_and_mints_boundary`).
The review preserves that behavior in the oracle rather than silently blessing
a fourth A3 difference. If the owner prefers the new policy, the A3 exception
list and the legacy first-fold contract need an explicit ruling.

### 3. Blocking: bootstrap from SOFT+ refolds the served head instead of preserving its bytes

**Test:** `soft_plus_pipeline_switch_preserves_the_full_request_head_bytes`.

**Input sequence:** Full engine first folds compartment 0 covering message 1
into m0. Append compartment 1 covering message 2. A 75%-usage pass returns
`SOFT`, placing `DELTA-HISTORY` in m1 without changing m0. A low-usage pass is
asserted to be `SOFT+`. Setup then receives the same raw window, and the final
bootstrap page carries `prefix_rebuilding:{reason:"pipeline_switch"}`.

**Expected:** The first host view is byte-identical to the last full-request
SOFT+ output. The expected native replacement is rendered from that actual
engine response, not synthesized from the new pipeline's state.

**Actual:** Bootstrap moves `DELTA-HISTORY` from m1 into m0 and resets m1 to the
empty-since-materialization placeholder. The surviving `m3` bytes remain the
same, but both synthetic head messages change:

```text
expected m0: BASELINE-HISTORY
expected m1: <new-compartments> ... DELTA-HISTORY ... </new-compartments>
actual   m0: BASELINE-HISTORY ... DELTA-HISTORY
actual   m1: (no new content since last materialization)
```

**Cause:** The pipeline-switch rebuild increments the compaction rebuild epoch
and changes render identity (`params` plus `|broca-compaction:<epoch>`), driving
a HARD fold on the reused full-request namespace. Reusing the namespace and tag
numbers is insufficient to preserve its frozen m0/m1 split.

**Clauses:** D2.7 bootstrap step 3; A3(c), which promises equality for a switch
from SOFT+; A10's first-view bootstrap oracle; D3.5's frozen head bytes.

### 4. Should-fix: the fast path hides a supported cached-m1 repair and its queued drop

**Test:** `missing_cached_m1_repair_cannot_be_skipped`.

**Input sequence:** Bootstrap and acknowledge a head with a folded baseline and
a live tag for message 2; retain message 3 as the newest tail. Seed the
engine-supported legacy `cached_m1_missing` shape by removing only the `m1`
frozen unit, keeping initialized metadata and m0. Queue the message-2 tag for
reduction. Send a below-threshold status without a prefix signal.

**Expected:** The real engine's supported cached-head repair runs, and the
queued drop rides its HARD permission. The regression bypasses only the skip
predicate after observing the handler result, using the same host template,
setup, lineage, and status; it verifies that the engine produces a replacement.

**Actual:** Handler returns `noop`; directly executing the engine with those
inputs produces a replacement. Captured failing assertion:

```text
host fast path hid a real cached_m1_missing HARD repair
  left: String("noop")
 right: "compaction_message"
```

**Cause:** `forced_work` reads only meta flags. It cannot see the cached-head
shape, even though the real engine treats that shape as an independent rebuild
opportunity. The six-boolean predicate table proves the boolean function's
truth table, not completeness of the facts supplied to it.

**Clauses:** D3.7/A7; protected architecture's `cached_m1_missing` HARD trigger
and drain-into-the-known-bust invariant. The engine already has a regression
for this repair (`cached_m1_missing_hard_advisory_drains_pending_drop_on_defer`).

Severity is should-fix because this fixture is a supported legacy/repair state,
not the normal newly created head. A missing empty m1 with no queued change can
repair byte-identically and legitimately return no replacement; this test
intentionally supplies work whose application changes served bytes.

### 5. Should-fix: structural rejection never enters the terminal store state

**Test:** `structural_rejected_view_cannot_be_acknowledged_on_a_later_pass`.

**Input sequence:** Produce view V without acknowledging it. Send
`last_not_applied` naming V with `reason:"structural"`. Then send a later/stale
`last_applied` naming that same V.

**Expected:** V is recorded `not_applied` on rejection, and the later
acknowledgement cannot turn it into an applied view.

**Actual:** The row remains `produced` after rejection, then becomes `applied`
on the later acknowledgement:

```text
  left: ["produced", "applied"]
 right: ["not_applied", "not_applied"]
```

**Cause:** `host_step` uses `last_not_applied` for engine retry decisions but
never calls `set_provider_view_state(...,"not_applied")` for it. Therefore the
new metadata-only store guard refusing `not_applied -> applied` is not reached
on the actual structural-rejection path.

**Clauses:** D1's retained acknowledgement/structural-check rules;
D3.1's view application states and D3.5's applied-view boundary; the delivered
metadata acknowledgement API's explicit rejected/invalidated transition rule.
A7's stable applied-prefix requirement cannot rely on a guard that is bypassed.

### 6. Should-fix: acknowledgement ignores compaction identity

**Test:** `acknowledgement_with_a_foreign_compaction_id_cannot_apply_a_view`.

**Input sequence:** Produce V. Send `last_applied` with V's numeric version but
`compaction_id:"foreign-conversation"`.

**Expected:** Reject or ignore the mismatched acknowledgement without marking
V applied. The test allows either response policy; it observes only the durable
view state.

**Actual:** The held row changes from `produced` to `applied`.

```text
the id/version acknowledgement pair must identify the held compaction
  left: "applied"
 right: "produced"
```

**Cause:** `status` extracts only `/last_applied/version`; `host_step` compares
only that number with `setup.produced.version`. The supplied compaction id is
never compared to the held compaction id before the metadata write.

**Clauses:** D1's unchanged compaction identity/version/structural rules;
D2.1's `{compaction_id,version}` view identity; D3.3's view commit semantics.
This is an acknowledgement-validation defect, not cross-session access: the
conversation key remains correctly route-bound.

## Checks that held

### Independent controls

- `pressure_flush_model_and_cold_match_the_real_engine_with_queued_drops_and_historian_veto`
  **passes**. Runs **32 comparisons**: usage 74,999 / 75,000 / 84,999 / 85,000
  in a 100,000-token window, with a configured 75% execute threshold, crossed
  with no event / durable flush / model change / explicit cold and historian
  idle / awaiting producer. Every case contains a live queued drop and a later
  publication after a boundary has already been minted. Handler answer class,
  native replacement bytes when present, and remaining provider queue equal
  real engine execution in a separately prepared temporary store. The expected
  result is not computed from `can_skip_engine` or manually asserted input
  booleans. This checks the fast path, not all differences between the
  compaction wrapper and full-request mode; finding 2 supplies the separate
  full-request oracle where that distinction matters.
- `module_ahead_descent_after_restart_burns_stranded_tags_without_rewriting_the_view`
  **passes**. A reopened module refuses a conflicting ordinal before burning a
  stranded allocation or its queued drop. Descending through the last committed
  ordinal burns that allocation and discards its queue, keeps the previous view's
  serialized bytes unchanged at the boundary, and renders the replacement id
  rather than the abandoned id on the next meaningful cold rebuild. No stranded
  tag renders and no runner callback occurs.

### Delivered tests rerun, and relevant code inspected

- All **17 delivered M4 host tests pass**: sparse held-history gaps (including a
  forged cursor), byte-conflict refusal before promotion/burn, lineage boundary
  and inner-cut handling, setup nonmutation, first ordinal 4,000, paging
  `more`/`wait` without runner reads or scan-lock wait, bootstrap restart/reentry,
  tag overlay identity/no double tags/no raw-fallback mint, coverage, queued-drop
  consumption, configured TTL retention, and dual-opt-in admission.
  Finding 1 attacks the missing gap-side-effect assertion, not the already
  passing conflict case.
- The **49 existing provider tests** selected by `providers::` pass, including
  owned-Broca codec, hook outcomes, unsent-view retry, wait/ready durability,
  restart, budgets, and authored signed-reasoning rejection.
- All **11 S2 compaction-adapter tests pass**, including defer, execute, retry,
  complete tool arcs, frozen noop, worker/reader, and signed-thinking handling.
- All **16 provider-log tests pass**. In particular, the shared-store injected
  transaction-abort test proves that engine/provider queue deletion, policy
  counters, and engine CAS roll back together; repeat consumption/requeue checks
  also pass. The namespace-index test observes no non-provider byte or provider
  row changes. The P1 tests cover upper bounds, monotonicity, absence without
  promotion, and same-transaction descent clamps. View byte freezing and the
  metadata-state guard itself pass; findings 5–6 concern handler wiring into it.
- Read the M4 engine/store diff. Tag-mint and Channel 1 suppression are gated by
  both compaction pass kind and OpenCode profile; normal full-request and
  owned-Broca tagging are not put on that gate. Frozen native replacement and
  coverage are serialized together in a view row and included in immutable
  version comparisons. No replacement/coverage rewrite was found in the
  exercised valid retry/acknowledgement/descent paths.

## TTL, fences, and coverage limits

The local `execute_host` override does not change plan params, the common
`producer_context` policy builder, or the full-request context. Setup does not
run that engine at all. The delivered TTL test preserves `10m` in Setup and in
the shared builder; the controls exercise an actual cold fold. No `never` leak
into Setup/Broca/full-request policy was found.

**A missed cold signal can leave idle expiry unapplied indefinitely** until
another genuine opportunity occurs. That follows directly from the approved
sole-host-idle-authority rule, not from a second hidden module TTL timer. M4 has
no way to recover that observation. The future host adapter must test its cold
signal across restart/timeout; this review does not claim those H4 host tests
exist or silently add a fallback contrary to the ruling.

The host's durable issued-request fence and apply-once logic are H slices, not
implemented by this review. Numeric latest-produced matching prevents some old
acknowledgements, but it does not excuse findings 5–6. No claim is made here of
real-host kill coverage at every S3 cut or of 7.5k-message end-to-end bootstrap
performance. Existing in-process paging/restart controls were run; the full
host differential campaign remains T1/H4 work.

## Reproduction and verification record

Rust tests/checks ran on the remote Linux builder, serially. Tool versions:
`cargo 1.99.0 (5f94df478 2026-08-27)`,
`rustc 1.99.0 (b940084d7 2026-09-28)`,
`clippy 0.1.99 (b940084d7e 2026-09-28)`;
local formatter `rustfmt 1.10.0-stable (b940084d7e 2026-09-28)`.

Final review reproduction (implementation unchanged):

```sh
cargo test -p mc-module --lib compaction_review_tests -- --test-threads=1 --nocapture
```

```text
acknowledgement_with_a_foreign_compaction_id_cannot_apply_a_view ... FAILED
final_history_gap_refuses_before_promote_and_burn ... FAILED
first_historian_publication_matches_the_real_full_request_engine ... FAILED
missing_cached_m1_repair_cannot_be_skipped ... FAILED
module_ahead_descent_after_restart_burns_stranded_tags_without_rewriting_the_view ... ok
pressure_flush_model_and_cold_match_the_real_engine_with_queued_drops_and_historian_veto ... ok
soft_plus_pipeline_switch_preserves_the_full_request_head_bytes ... FAILED
structural_rejected_view_cannot_be_acknowledged_on_a_later_pass ... FAILED

test result: FAILED. 2 passed; 6 failed; 0 ignored
```

Other checks:

- `cargo test -p mc-module --lib providers::compaction::host_tests -- --test-threads=1`:
  **17 passed** at the delivered baseline.
- `cargo test -p mc-module --lib providers:: -- --test-threads=1 --nocapture`:
  all **49 pre-existing tests passed**, plus the pressure control. At that run
  the new restart control still had an overstrong assertion that a byte-identical
  cold pass must produce a view. The fixture was corrected to publish real
  changed history before requesting its rebuild, and the exact control was
  rerun (**1 passed**). The final eight-test run above has only the six stated
  contract failures; the fixture failure is not a finding.
- `cargo test -p mc-module --lib transform::tests::compaction_adapter_tests -- --test-threads=1`:
  **11 passed**.
- `cargo test -p mc-store --lib provider_log -- --test-threads=1`: **16 passed**.
- `cargo clippy -p mc-module --lib --tests -- -D warnings`: baseline lint failure
  in the delivered `host_tests::hook_answer` helper, 8 arguments / limit 7.
  No implementation edit was made to suppress it.
- `cargo clippy -p mc-module --lib --tests -- -D warnings -A clippy::too_many_arguments`:
  **passed** the package's lib/test typecheck and remaining lints.
- `cargo fmt --all --check`: **passed**.
- Scoped `aft_inspect`: authoritative diagnostics for the new test file,
  **0 errors / 0 warnings**; graph categories unavailable in this worktree.

The known 96-versus-97 context-schema pin failure in `move_inventory` is not a
finding. The full workspace suite was not rerun for this review; the relevant
S2, provider, and store targets above were selected instead. No package manifest,
lockfile, generated artifact, or schema file was changed.

## Implementation response and resolution verification

This section records the implementation follow-up, not a second independent review.
The original report and regression expectations above are preserved. At review commit
`ed08506cb2411e2093c5712e36aadac1b6c61329`, the worker reproduced all six named
failures and both passing controls before editing implementation code.

- **Final-page gaps:** `commit_provider_status_page` validates the admitted page's
  contiguous frontier inside the same rollback transaction as ordinal/byte conflicts,
  before acknowledgement, burns or promotion. A refused final page commits nothing,
  including its new messages. Intermediate pages admit bytes without acknowledgement.
  A new store regression also checks the conversation, pending answers and tag rows
  are unchanged, and that conflicts still take precedence over the gap check.
- **First publication:** host engine runs now have an internal host pass kind, rather
  than the Broca `compaction.step` first-fold suppression. The owner's ruling preserves
  the real full-request engine's eager first-publication HARD, including sequence zero;
  no fourth A3 exception is introduced. The 40-case oracle now calls the real
  `transform_with_projection` full-request entry point in a separately prepared store.
- **SOFT+ switching:** a pipeline switch does not increment the rebuild epoch. Normal
  host adoption preserves the namespace's observed provider/system/upgrade inputs and
  does not change render identity merely to adopt provider-plan serialization. Explicit
  cold/flush/revert rebuilds still use the normal identity-change lane. The original
  split-m0/m1 review regression and an additional nonempty provider/system-identity
  regression pass.
- **Cached-head repair and fast path:** the metadata preflight invokes the existing
  concrete shape predicates and `mc_core::classify`. A bounded, serde-defaulted shape
  summary is recorded in `section_index` only on writes already changing frozen chunks.
  Missing legacy summaries always run the engine. The accessor reads only the small row,
  never chunk payloads. Shape/classifier HARD and SOFT trigger cases are enumerated.
  Content-dependent replay repairs and document inputs conservatively run the engine.
  A produced cached-head repair remains outstanding until acknowledgement, so a lost
  repair answer can still be reproduced after its engine state has committed.
- **Structural rejection:** a matching structural rejection records `not_applied`
  through the immutable view-state API. Its terminal guard refuses a later application.
- **Acknowledgement identity:** both id and version are checked against a held view
  before admission writes. A foreign/unknown acknowledgement refuses by field name.

The two original gap fixtures were updated only in their inputs, not their assertions:
resends include the bytes from the refused final page, and a partial transcript is held
through an intermediate `more` page rather than by relying on a refused page's writes.
That fixture change follows the stronger rollback contract instead of weakening it.
The review tests were not edited. The original test-helper arity warning was fixed by
bundling its target tuple, with no lint suppression.

Resolution gates on Cargo/rustc 1.99.0:

- The independent review's six failures each changed to **green**; both controls remain
  green, including the 32 pressure/flush/model/cold/historian comparisons.
- All existing provider and S2 compaction tests remain green.
- The codec round-trip, chunk diff/unchanged-write, hash, fingerprint and migration
  tests remain green. New tests compare stored chunk bytes with the old serializer,
  preserve all existing index digest fields and versions, decode a summary-bearing
  index with the old struct shape, and verify scalar updates leave legacy indexes
  and chunk bytes untouched. `SectionIndex` has no `deny_unknown_fields`.
- A staged `NON-VACUITY BREAK` adding a full-state load to the metadata accessor made
  only `shape_accessor_reads_only_header_metadata_not_frozen_chunk_payloads` fail
  (decode count 2 instead of 1); the old-reader/chunk-byte/hash control stayed green.
  The mutant was restored from the staged live state and the unstaged diff was empty.
- Strict package Clippy, including tests and without the earlier arity allowance,
  passes. The repository formatter and JavaScript gates are recorded in the delivery.

The follow-up preflight is intentionally conservative for content-dependent treatments;
this resolution claims sound skips and byte stability, not a new rebuild-time performance
measurement or completion of the future real-host corpus. A second independent review
is still required by the integration owner.

## Exact-plan and temporal follow-up

The integration owner clarified that a hook without an exact engine pass plan must
withhold an idle-gap marker. A conservative preflight candidate is not permission.
The standalone prerequisite commit `4b512a2b68d91da79af18bf9b298ca70eafd8dd1` exposes:

```rust
pub fn pass_plan_permits_prefix_mutation(
    plan: &mc_core::PassPlan,
    marker_hard_serves_frozen_prefix: bool,
) -> bool
```

The exact engine permission expression now lives in that helper. The engine calls
it before discarding temporal candidates on defer; the preflight uses its negative
result only after proving a defer. Its doc comment explicitly forbids using a
conservative candidate to authorize a hook mutation. The standalone test compares
its HARD/defer result with the full engine and covers marker-only HARD, SOFT,
migration and rejection plans.

Commit `64dbbf2f93a7099c94b4a7b1dfa3d6b19be09c22` restores host temporal candidate
computation while continuing to suppress engine tag allocation and Channel 1
cadence. The new fallback regression was red before the change: a late HARD
replacement omitted both the +2h and +1h markers. It is now green for both HARD
and SOFT against an independently prepared full-request engine. It holds all new
hook answers unmarked during a real defer, then compares the entire native
replacement through `newest + 1`, checks each marker appears once, and checks
that view rendering creates no extra tags.

### Concrete rebuild-trigger evidence map

These are actual store/request mutations, not merely synthetic classifier booleans.
Each test invokes the same metadata-only skip function as the handler, then invokes
the real full-request engine. Non-bootstrap cases first prove the clean baseline
is skip-eligible. The existing independent comparison controls remain unchanged.

| Test suffix (`real_state_trigger_`) | Real input/state change | Engine result |
| --- | --- | --- |
| `bootstrap` | No initialized namespace row | HARD |
| `legacy_migration` | Replace frozen head with a legacy `baseline` unit | HARD |
| `cached_m1_repair` | Remove only frozen m1 through the codec writer | HARD |
| `unknown_shape_refusal` | Persist an unrecognized frozen head | Reject; unknown unit retained |
| `model_identity` | Change the actual request model | HARD |
| `first_publication` | Publish sequence-zero history after empty bootstrap | HARD |
| `reconcile_rematerialization` | Revert away the boundary, then recut surviving history | HARD |
| `soft_m1_delta` | Publish later history and cross execute threshold | SOFT |
| `soft_reduction` | Queue a live block reduction and arm durable refresh | SOFT |
| `durable_flush` | Arm durable refresh with pending published history | SOFT |
| `idle_expiry` | Explicit host cold signal and real oracle response/TTL expiry | HARD |
| `external_revision` | Rewrite the existing compartment body | HARD |
| `project_memory_epoch` | Change the actual project-state epoch | HARD |
| `protection_snapshot_survives_preflight` | Remove the floor snapshot and change the observed floor tuple | HARD after preflight |
| `force_band` | Cross force pressure with pending history | Mutation permitted |
| `emergency_band` | Cross emergency pressure with pending history | Mutation permitted |

### `skip_facts` side-effect audit

The concrete protection case exposed a real defect in the earlier preflight:
`pre_snapshot_inputs_changed` records the tuple, so inspecting it could consume the
change before the engine evaluated it. The owner authorized a read-only peek.
`pre_snapshot_inputs_would_change` now reads without inserting; both peek and engine
recorder share one private tuple comparison, including the absent-entry semantics.
The engine retains sole ownership of recording. The regression runs preflight first
and requires the following full engine pass to remain HARD.

Every other call in `skip_facts` was inspected:

- `load_compaction_trigger_core`: reads the small cache row/index and decodes only
  header metadata. It does not read chunks, increment full-decode counters or write.
- `load_meta`: reads the small row and, when installed, the user-profile version.
  `user_profile_version` is a SELECT through `context_read`; it does not update state.
- `m1_revision_signal_parts_for_pass`: reads a single context snapshot and hashes
  the returned watermarks locally. Its timing measurement is local; no timing sink
  is supplied by preflight.
- `load_m1_revision_snapshot`: reads workspace membership, memory/mutation/note/profile
  watermarks, project epoch and compartment-history revision. Its callbacks contain
  SELECTs only. `compartment_history_revision_tx` also only checks table presence and
  reads revision fields; it does not create or refresh a revision.
- `workspace_fingerprint_for_membership`: hashes already-read membership; no cache
  insert, database write or lifecycle observation.
- `has_compartments`: a SELECT EXISTS, including correct sequence-zero handling.
- `tag_cache_namespace`: an atomic load of the store's existing identity, not a new
  identity allocation.
- Shape predicates and `mc_core::classify`: pure evaluation of the supplied metadata.
- `pre_snapshot_inputs_would_change`: read-only cache lookup; the corrected call no
  longer records or consumes a cache, latch, counter or pending rebuild observation.

No other state-recording or consuming call was found in the preflight. Cargo run
location and the final trigger/mutation results are recorded in the delivery.

### Follow-up verification outcome

The protection preflight regression was proven non-vacuous by staging the live
implementation, temporarily restoring the old consuming call with the explicit
`NON-VACUITY BREAK` marker, and running all 16 concrete trigger tests. Exactly
`real_state_trigger_protection_snapshot_survives_preflight` failed: the full engine
returned SOFT+ instead of the required HARD. The other 15 trigger tests stayed green.
Restoring the staged implementation left an empty unstaged diff. The restored
Linux suite is green: 76 provider tests, 9 protection-window tests, 12 S2/evaluator
tests, 17 provider-log tests and 34 codec tests (plus one existing ignored profile
benchmark), with package compilation and strict Clippy passing.

One initial 16-trigger test command requested Linux but was automatically executed
on macOS when the runner replied `runner_draining`. Later attempts used a uname
guard and performed no local Cargo work. Background retries during the runner swap
were watched before results were reported; the final mutation proof and final Rust
gates executed on Linux after service resumed. No throttled local fallback was
needed after the owner imposed the remote-only policy.
