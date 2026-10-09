# M4 correctness review, round 3

## Verdict and scope

Reviewed **`f3642a74dfcf4b95dd8745df74a914ffa4a3daa8`**, including the messages of
`ef6caa37`, `4b512a2b`, `64dbbf2f`, `f3642a74` and
`docs/reports/cache-review-m4.md`. Those artifacts describe the prior acknowledgement,
cache-shape, first-publication and transport-adoption fixes, the shared exact-plan
permission helper, temporal overlay restoration, and sixteen concrete trigger
regressions. The frozen head consists of baseline **m0** and pending history delta
**m1**; **HARD** refolds that baseline, **SOFT** refreshes the delta, and **SOFT+**
replays the frozen prefix. **Do not accept the invariant yet.** Four
findings remain: two independent ways to swallow an upgrade rebuild, premature
non-final bootstrap execution, and a stale shape summary after recomp reset.
Five new regressions fail at their behavioral assertions. Product code is
unchanged, existing tests and their expectations are unchanged, and no shim,
manifest, lockfile, schema, or live database was changed.

All databases are fresh `open_for_test` fixtures under `tempfile::tempdir()`.
This review commit adds only this report and the failing regressions in the existing
`providers/compaction_review_tests.rs`. Passing investigative probes are preserved
as reproducible source in the appendix rather than added to the production source
tree. Citations to product code refer to the reviewed base, not the temporary
investigative test insertions.

## Findings

### 1. Blocking: metadata preflight skips a module-render upgrade

**Test:** `r3_upgrade_epoch_cannot_be_skipped_by_host_preflight`.

**Minimal input:** Three raw messages `m1@1`, `m2@2`, `m3@3`. Publish sequence 0
covering m1 with `BASE`, bootstrap HARD, publish sequence 1 covering m2 with
`DELTA`, run at 75% to establish a SOFT m1 delta, then settle at 1%. Adopt and
acknowledge the same view in the host lane. Model, provider, system identity,
compartments, memory revision, and protection floor remain unchanged. The stored
render identity carries `mre:4:mre2` instead of the running build's
`mre:4:mre3`, representing a namespace materialized by the preceding render
format. Send a new 1%-usage status with no prefix signal.

The fixture changes only that versioned identity scalar; the frozen BASE/DELTA
strings deliberately need no format conversion. This is enough to test a real
upgrade trigger: an old render identity is not a corrupt frozen shape. A separate
store receives the same history and scalar change and runs the real full-request
`transform_with_projection` entry point.

**Expected:** Full engine HARD, permission true, DELTA folded into m0. The host
must serve exactly that native replacement, not preserve its old m0/m1 split.

**Actual:** `{"answer":"noop","request_id":"after-upgrade"}`. The host serves:

```text
m0: <session-history> ... BASE ... </session-history>
m1: <session-history-since><new-compartments> ... DELTA ... </new-compartments>...
```

The full engine serves:

```text
m0: <session-history> ... BASE ... DELTA ... </session-history>
m1: <session-history-since>(no new content since last materialization)...
```

The surviving raw message m3 is identical in the host and full-engine outputs.
The test compares the whole serialized native replacement, not
just the action or a digest. These are the first directed byte-mismatch inputs;
the randomized corpus below did not generate module-format upgrades.

**Cause:** `can_skip_host_step` checks model and work flags
(`providers/compaction.rs:363-372`), while `skip_facts` supplies
`render_config_changed` from **model alone** (`transform.rs:2316`). It never
checks the versioned render identity that the full engine builds at
`transform.rs:4524-4543`, including module/profile/tagger/prompt epochs
(`transform.rs:8283-8324`, `compartment_coverage.rs:103-132`). The real engine's
identity comparison (`transform.rs:8326-8352`) and classifier epoch branch
(`mc-core/src/lib.rs:131-134`) are therefore not reached on this host pass.

### 2. Blocking: transport-adoption exemption also exempts independent upgrades

**Tests:** `r3_pipeline_switch_does_not_exempt_module_render_epoch` and
`r3_upgrade_identity_change_is_not_transport_adoption`.

**Minimal inputs:**

1. The identical three-message BASE/m1-DELTA, old-`mre2` fixture in finding 1,
   but status includes `prefix_rebuilding:{reason:"pipeline_switch"}`. This
   explicitly bypasses the skip fast path and forces the host engine to run.
2. Two separate fresh engine stores with the same three messages and BASE/DELTA
   SOFT split. Change actual `TransformRequest.upgrade_state` from `old-release`
   to `new-release` at 1%. Run one through `kind="transform"`, the other through
   `kind="compaction.host"`; other request inputs remain identical. This second
   test isolates the exemption without relying on the classifier preflight.

**Expected:** Both independent upgrade changes still cause HARD. A pipeline
switch may waive the transport-plan serialization difference, not a release or
render-format change. In input 1, native m0/m1 bytes must match the full-request
HARD described above.

**Actual:** Input 1 returns noop and preserves the old split, despite actually
running the engine. Input 2's full request is HARD, while the host-kind engine is
**SOFT+**, with no permission.

**Cause:** The override at `transform.rs:8356-8361` suppresses *every* changed
render identity for HOST_PASS when model/provider/system match. It neither
compares `last_upgrade_state` nor preserves independently changed epoch fields.
`compaction::run` retains HOST_PASS for a pipeline switch at epoch zero
(`transform.rs:2563-2575`); transport adoption and module upgrade are consequently
collapsed into the same exemption. Fixing finding 1's metadata facts alone would
not fix this independently exercised engine path.

The request-level test isolates the engine's transport exception by changing
only request kind between two otherwise identical upgrade sequences. Provider
status has no upgrade-state field, and none was invented. The old-module-epoch
case is the end-to-end host handler reproduction.

### 3. Should-fix: a non-final bootstrap page executes when hooks already cover history

**Test:** `r3_nonfinal_bootstrap_with_hook_complete_history_waits_without_engine`.

**Input:** Fresh Setup; pending hook answers have durably ingested all of m1–m3.
Send `messages:[]`, `newest:{ordinal:3,mid:"m3"}`, `more:true`, and
`prefix_rebuilding:{reason:"pipeline_switch"}`. No final page has arrived.

**Expected:** `wait`, no engine cache-row write, and all hook answers still
pending. Bootstrap paging is not complete merely because another ingress route
has already filled the held message frontier.

**Actual:** `compaction_message`, version 3, range `[1,4)`, empty synthetic head
plus the raw three-message tail. The assertion fails on answer class before the
no-engine assertion. The intermediate-page store admission still leaves hooks
pending, so this view lacks the pending hook tag overlay as well.

**Cause:** `host_step` defines incompleteness only as `frontier <= newest`
(`providers/compaction.rs:1010-1016`), then considers `more` only *inside* that
incomplete arm (`1099-1106`). When the frontier is already 4, `more:true` takes
the engine arm (`1108-1143`). The store's correct intermediate-page admission
policy is not a handler-level bootstrap execution fence.

Severity is should-fix: the exercised failure is a premature bootstrap response,
not an unobserved later trigger. The fixture does not claim that hooks' durable
bytes are unreadable or that a final sparse page must always be rejected.

### 4. Should-fix: recomp resets payloads but retains the retired shape summary

**Test:** `r3_recomp_reset_summary_agrees_with_full_core`.

**Input:** Full-request HARD initializes an ordinary m0/m1 head. Call the real
`reset_session_for_recomp("s", current_row_version)`, then independently load
both the full core and `load_compaction_trigger_core`.

**Expected:** Empty core, empty shape summary, empty boundary, and uninitialized
metadata. The summary must describe the new cache state rather than the retired
head.

**Actual:** Full core `frozen_units=[]`, metadata uninitialized, boundary empty;
metadata accessor returns frozen keys **`["m0","m1"]`**. Exact assertion:

```text
reset summary retains retired head keys
  left: ["m0", "m1"]
 right: []
```

**Cause:** Recomp makes a full codec rewrite without a previously loaded section
base to diff against
(`mc-store/src/lib.rs:12763-12775`). `write_cache_state_tx` reads the old index,
then clears session section rows *before* calling `write_sections`
(`17013-17035`). Encoding the empty state then performs no frozen upsert or
deletion (`cache_codec.rs:930-946`), so `wrote_frozen=false` and the new index
clones the **old** shape (`cache_codec.rs:1008-1012`). The small-row accessor
trusts that shape (`mc-store/src/lib.rs:8685-8701`).

This is a violated summary/reset claim, **not a demonstrated unsafe skip after
recomp**: the reset also clears `initialized`, and the existing uninitialized
fast-path fence forces the next engine bootstrap. No current byte mismatch is
claimed for this finding.

## Round-2 fixes, tested with variations

The eight original tests in `providers/compaction_review_tests.rs:185-593`,
documented in `cache-review-m4.md`, passed unchanged at the base. The
following additional probes do not simply rerun their exact fixtures:

| Requested variation | Actual probe and result |
| --- | --- |
| Late acknowledgement of a rejected view | Structural rejection on a 75% retry opportunity, reopen the store/handler, then acknowledge the old version. Old row stays `not_applied`; passed. |
| Non-final bootstrap with hook-complete history | Fresh Setup plus all three held hook messages, sparse `more:true` page; finding 3. |
| Upgrade rebuild versus switch exemption | Actual request upgrade-state and persisted previous module-render epoch, each compared with full-request execution; findings 1–2. Ordinary no-upgrade adoption control remains green. |
| Reissuing rejected compaction at a new version | Nonstructural `superseded` rejection on 75% opportunity: larger version, identical replacement bytes; passed. Combined probe also exercises structural rejection and restart. |
| Lost repair answer replay | Bootstrap a published head with a live tag and queued drop, remove m1 through the actual codec writer, produce a repair without acknowledgement, reopen, then issue a new below-threshold request without an explicit rejection. Larger version and byte-identical repair replay; passed. |
| Recomp clears summary | Real reset API, independently compare full core with metadata accessor; finding 4. |

## Sixteen trigger tests: concrete inputs and mutation proof

All sixteen named `host_tests::real_state_trigger_*` tests drive actual requests
and store state through `real_state_trigger_comparison`
(`providers/compaction.rs:2074-2272`). Except bootstrap, they first require a clean
settled namespace to be skip-eligible, mutate a real input, invoke the shared
handler preflight, then run the full-request engine. They are not the nearby
synthetic six-boolean truth-table test.

| Suffix | Concrete state/request | Expected engine result |
| --- | --- | --- |
| bootstrap | Absent initialized namespace | HARD |
| legacy_migration | Persist one legacy `baseline` unit | HARD/migration |
| cached_m1_repair | Persist removal of only m1 | HARD |
| unknown_shape_refusal | Persist unknown frozen unit | Error, unit retained |
| model_identity | Change request model | HARD |
| first_publication | Publish sequence 0 after empty bootstrap | HARD |
| reconcile_rematerialization | Actual boundary-removing revert, then recut surviving history | HARD |
| soft_m1_delta | Publish later compartment and cross execute threshold | SOFT |
| soft_reduction | Queue actual agent drop and arm durable refresh | SOFT |
| durable_flush | Pending publication and actual durable refresh | SOFT |
| idle_expiry | Host cold signal, oracle clock/response crosses TTL | HARD |
| external_revision | Rewrite existing compartment content | HARD |
| project_memory_epoch | Change project-state epoch | HARD |
| protection_snapshot_survives_preflight | Remove effective snapshot and change observed floor tuple; preflight before engine | HARD |
| force_band | Pending history with request usage 85% | Permission true |
| emergency_band | Pending history with request usage 95% | Permission true |

Three separate **NON-VACUITY BREAK** mutations deliberately disabled classifier
behavior to prove the matching tests can detect its loss. They changed the real classifier in
`crates/mc-core/src/lib.rs`. Each full sixteen-test run produced **15 green,
exactly the matching test red**:

| Mutated branch | Sole failure | Failure evidence |
| --- | --- | --- |
| Legacy `MigrateHard` -> `Reject("legacy mutant")` | `real_state_trigger_legacy_migration` | Full engine returned `UnknownShape("legacy mutant")` |
| Cached-m1 `Hard` -> `Reject("cached-m1 mutant")` | `real_state_trigger_cached_m1_repair` | Full engine returned `UnknownShape("cached-m1 mutant")` |
| Unknown shape `Reject` -> `Defer` | `real_state_trigger_unknown_shape_refusal` | `preflight skipped a concrete unknown_shape trigger` |

For each mutation: stage the live file, confirm empty unstaged diff, mutate,
record `1 file changed, 2 insertions(+), 1 deletion(-)`, run the guarded Linux
suite, restore using `git checkout -- <path> && touch <path>`, and confirm empty
unstaged diff. All other fifteen names above stayed green on each successful
mutant run. One first cached-m1 attempt failed compilation of a new review
fixture (`ProviderSessionKey` is not `PartialEq`); it is **not** mutation proof.
The fixture was corrected, and the actual 15/1 mutant execution is the evidence.

**Coverage limit:** The sixteen cover classifier rules 1–5, unknown-shape rejection,
and both SOFT delta sources in rule 7, with repeated clean-baseline rule-8 defers.
They do **not** drive rule 6, reconcile-clearing with the boundary returned, or
exhaust the negative rule-7/rule-8 combinations (missing boundary, pending delta
without opportunity, coalesced m1+reduction). No syntactic classifier branch lacks
an existing core test: `reconcile_boundary_present_defers_to_clear`,
`pending_delta_without_bust_opportunity_defers`, `m1_and_reduction_coalesce_into_one_soft`,
and `boundary_absent_reduction_defers_never_soft` cover those predicates, but with
synthetic inputs. Nor do the sixteen establish completeness of upstream identity
facts: both upgrade regressions escape their model-only identity fixture.

## Randomized host/full-engine comparison

`r3_randomized_host_full_engine_240_passes` uses deterministic xorshift seed
**`0x4d345233`**, thirty independently prepared pairs of temporary stores, random
4–10-message histories with completed tool calls/results and timestamp gaps,
followed by eight state transitions per pair: **240 evaluated passes**, plus
thirty independent bootstrap comparisons. Host evaluation calls the real
`provider_step` handler. The oracle admits hook tags without invoking the host
engine, bootstraps and executes via `transform_with_projection(kind="transform")`,
and renders native bytes through the codec. No classifier booleans determine the
expected output. On noop the comparison uses the host's last acknowledged served
replacement, not an absent answer object.

Each whole replacement JSON serialization is compared byte-for-byte. The corpus
uses fixed complete working ranges so no synthetic raw-tail splice can hide an
append mismatch; the separate temporal probe exercises appends through newest+1.
Only tag numbers not already queued are requested, avoiding invalid requeue of
consumed hook tags. Successful output:

```text
random seed=0x4d345233 passes=240 event counts=[24, 32, 34, 35, 37, 32, 22, 24] mismatches=0
```

Events in that order: quiet, later publication, queued drop, durable flush,
explicit host cold/full-engine TTL expiration, memory insertion, project-memory
epoch change, existing-compartment rewrite. Usage is randomly selected from
1%, 74.999%, 75%, 84.999%, 85%, 95%. The random temporal histories include idle
gaps; engine tag minting and host hook tag allocation are kept independently
observable by seeding actual hook tags in both stores.

**Every byte mismatch found:** none in this random corpus; the two directed
previous-module-epoch comparisons both fail with the minimal three-message
BASE/DELTA split in findings 1–2. The raw-tail bytes remain identical and only
m0/m1 differ, as shown there. Random project epochs are not module-format epochs;
the zero mismatch count is not a claim to have defended upgrades. The initial
investigative random run stopped on an invalid repeated drop request; that run
was discarded, not counted as 240 comparisons or classified as a product defect.

## `skip_facts` side-effect audit

**The corrected protection lookup holds.** The additional repeat-peek probe
calls actual `skip_facts` ten times with a changed floor and an absent effective
snapshot. Every call requires HARD facts, unchanged metadata row version, and
the old process tuple still reporting changed. The following real full engine
remains HARD. Temporarily replacing the peek with the consuming recorder made
exactly `r3_repeated_skip_facts_does_not_consume_snapshot_observation` red on the
still-changed assertion; restored probe passes. The three classifier mutants
above are independent of this fourth audit mutation.

Audited reachable calls, not just the top-level name:

- `load_compaction_trigger_core`: small-row read, small-core decode, index-shape
  reconstruction only (`mc-store/src/lib.rs:8677-8703`). No chunk decode or
  full-decode counter increment.
- `load_meta`: small-row read plus `has_context_domain` and the global profile
  version SELECT (`8646-8671`, `12521-12531`). The context-domain RwLock is read;
  no domain is installed or swapped by this call (`7719-7737`).
- `m1_revision_signal_parts_for_pass`: passes **no timing sink**; `Instant` and
  hashing are local (`m1_compose.rs:207-225`, `241-305`).
- `load_m1_revision_snapshot`: reads membership, memory and mutation heads,
  publication sequence, notes, global profile, project epoch and history revision
  (`mc-store/src/lib.rs:12544-12649`). Callback contains SELECTs; history-revision
  lookup does not create or advance a revision.
- `workspace_fingerprint_for_membership`: hash of the already-read membership;
  no process fingerprint cache insertion (`14518-14522`).
- `has_compartments`: SELECT EXISTS (`11934`); no publication acknowledgement.
- `tag_cache_namespace`: atomic **load**, not namespace allocation (`7675`).
- Shape predicates, `classify`, `can_skip_classified`, exact-plan evaluator: pure
  metadata evaluations (`transform.rs:2268-2275`, `2311-2327`, `2845-2853`).
- `pre_snapshot_inputs_would_change`: `OnceLock::get`, mutex lookup and copy,
  not `get_or_init`/insert (`protection_window.rs:203-216`). The recorder's
  insert remains in `pre_snapshot_inputs_changed` (`221-232`).
- `context_read` (`mc-store/src/lib.rs:7741-7763`) invokes a read transaction.
  Both concrete production/test domains use a reader mutex and deferred read
  transaction, not the fenced writer (`single_store_reads.rs:86-100`,
  `mc-store/src/single_store_domain.rs:132-146`). SQLite statement/page caching
  and lock acquisition are mechanical caches, not consumed rebuild observations.

No other lifecycle latch, process observation insertion, pending-work clear,
policy counter mutation or decode counter was found on the success path. This
is a scoped audit of repository implementations, not a guarantee that an
arbitrary third-party `ContextDomain::read` implementation cannot misbehave.
The **facts are incomplete for upgrades** (finding 1), which is distinct from
reading them consuming an observation. The stale recomp summary (finding 4)
also does not make `skip_facts` itself a writer.

## Temporal overlay and exact-plan permission

`r3_temporal_fold_boundary_restart_hard_soft_and_defer` passes both HARD and SOFT
cases. It bootstraps messages 1–2, admits late user/assistant/user messages 3–5
with two-hour and one-hour gaps, proves a low-usage defer does not create new
markers, closes/reopens both stores/handlers, then publishes the compartment
ending at **assistant m2**. The two-hour gap therefore crosses the next HARD
fold boundary between the folded assistant and the surviving user m3. The SOFT
variant refreshes m1 instead. Full-request native output and host replacement
are identical through range `[1,6)`, each `<!-- +2h -->` and `<!-- +1h -->`
appears exactly once, and a subsequent acknowledged defer neither duplicates
nor removes persisted markers. "None on a defer" here means **no newly adopted
candidate**, not erasing markers already in the frozen served view. The unchanged
late-HARD/SOFT regression at `providers/compaction.rs:2552-2737` also remains green.

The temporary engine-variant probe passes for real **MigrateHard, Reject, Soft,
and marker-only Hard** inputs, not manufactured plans alone. It compares
`pass_plan_permits_prefix_mutation` against the engine response permission;
Reject is independently verified to error without permission. Existing
`public_pass_plan_permission_matches_full_engine_defer_and_hard` covers real
ordinary HARD and Defer. Existing marker-only adapter test also requires an
unchanged served replacement and no answer. The marker-keeps-prefix computation
excludes legacy/invalid/missing-m1 shapes (`transform.rs:5287-5303`), so
`MigrateHard + frozen-prefix marker` is not a reachable engine combination.
All five plan variants and the reachable frozen-prefix marker case agree with
the engine. No permission-helper or temporal-overlay defect was reproduced.

## Execution record

Every Cargo test/check/Clippy command requested `runon:"linux"`, ran as a
background tool task, and was joined with `bash_watch`. Every command starts with:

```sh
test "$(uname -s)" = Linux || { echo 'REFUSE: Linux guard'; exit 97; }
uname -s
cargo --version
```

All executed Cargo jobs reported **Linux** on `ck-motor`; no `runner_draining`
response or Mac fallback occurred in this review. Cargo is
`1.99.0 (5f94df478 2026-08-27)`, rustc is
`1.99.0 (b940084d7 2026-09-28)`, local rustfmt is
`1.10.0-stable (b940084d7e 2026-09-28)`.

- Base `cargo test -p mc-module --lib providers::compaction:: -- --test-threads=1 --nocapture`:
  **44 passed**, including all eight prior review regressions and sixteen triggers.
- Three classifier mutant runs: **15 passed / 1 precisely named failure each**,
  as tabulated above; all mutations restored with empty unstaged diff.
- Investigative `cargo test -p mc-module --lib r3_ -- --test-threads=1 --nocapture`:
  **6 passed / 5 intended assertion failures**. Before the final oracle refinement,
  the random test was already 240/0. The independent-bootstrap rerun is recorded
  below. No new test is ignored or marked should-panic.
- Repeat-peek consuming mutant: **one named failure**; restored rerun recorded below.

- Final `cargo test -p mc-module --lib providers::compaction:: -- --test-threads=1 --nocapture`:
  **49 tests, 44 passed / exactly the five new regressions failed**, exit 101.
  No baseline regression changed result.
- Independent-bootstrap `r3_randomized_host_full_engine_240_passes` rerun:
  **one test passed, 240 transitions plus 30 bootstrap comparisons, zero mismatches**.
- Restored `r3_repeated_skip_facts_does_not_consume_snapshot_observation`:
  **one test passed** after the consuming mutant was removed.
- `cargo check -p mc-module --lib`: library and dependencies checked, exit 0.
- `cargo clippy -p mc-module --lib --tests -- -D warnings`: passed. A final
  `--message-format=json` capture confirmed **two mc_module compiler targets**
  (library and library-test), `build-finished.success=true`, **zero diagnostics**,
  exit 0. Clippy is `0.1.99 (b940084d7e 2026-09-28)`.
- `cargo fmt --all --check`: silent success, exit 0; Linux rustfmt is
  `1.10.0-stable (b940084d7e 2026-09-28)`.
- Scoped diagnostic inspection initially reported analyzer warm-up gaps. The
  retry returned authoritative results for the one changed Rust file:
  **zero errors, warnings, info and hints**. Call-graph categories remain unavailable;
  compilation and strict Clippy are the authoritative type/lint gates.
- `cargo test -p mc-core --lib tests:: -- --test-threads=1`: **22 passed**
  (14 classifier predicates plus eight decay controls), including the core-only
  branch/combination coverage listed above.
- `cargo test -p mc-module --lib transform::tests::compaction_adapter_tests -- --test-threads=1`:
  **12 passed**, including real HARD/Defer permission and marker-frozen-prefix controls.
- JavaScript typecheck/build/tests skipped: no JavaScript, packaging or generated
  output changed; the user supplied a successful pre-worktree `bun run build`.

The exact passing control source follows below.
Two read-only research-worker requests (for the fixture map and then the
preflight/permission audit) timed out at 120 seconds; no result was used.
Source audit, execution and conclusions were performed directly instead. The
later prose/comment review completed; unclear wording was clarified.

## Appendix: passing investigative probes

These probes ran in the review worktree and are not left in product files. To reproduce, append the first Rust block to `crates/mc-module/src/providers/compaction_review_tests.rs` (which already contains the shared fixture and `r3_native`), and insert the second inside `transform::tests::compaction_adapter_tests`, next to its existing permission test. Run the guarded `cargo test -p mc-module --lib r3_ -- --test-threads=1 --nocapture`. Expect the five committed regressions to fail and these six probes to pass.

<details>
<summary>Exact provider probes, including the independently bootstrapped 240-pass oracle</summary>

```rust
#[tokio::test]
async fn r3_rejected_reissue_and_late_ack_after_restart() {
    for structural in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let (h, b, s, _k, _) = fixture(dir.path());
        response(h.provider_setup(b.clone(), &setup_request()).await);
        let mut boot = step("boot", vec![message(1), message(2), message(3)], 3);
        boot["prefix_rebuilding"] = json!({"reason":"pipeline_switch"});
        let v = response(h.provider_step(b.clone(), &boot).await);
        let version = v["compaction"]["version"].as_u64().unwrap();
        let mut rejected = step("reject", vec![], 3);
        rejected["last_not_applied"] = json!({"compaction_id":v["compaction"]["compaction_id"],"version":version,"reason":if structural {"structural"} else {"superseded"}});
        rejected["estimate"]["request_tokens"] = json!(75000);
        let retry = response(h.provider_step(b.clone(), &rejected).await);
        if !structural {
            assert_eq!(retry["answer"], "compaction_message");
            assert!(retry["compaction"]["version"].as_u64().unwrap() > version);
            assert_eq!(
                retry["compaction"]["replacement"],
                v["compaction"]["replacement"]
            );
        }
        drop(h);
        drop(s);
        let (h, b2, s, k2, _) = fixture(dir.path());
        let mut late = step("late", vec![], 3);
        late["last_applied"] =
            json!({"compaction_id":v["compaction"]["compaction_id"],"version":version});
        let _ = h.provider_step(b2, &late).await;
        let old = s
            .load_provider_views(&k2.store_key())
            .unwrap()
            .into_iter()
            .find(|r| r.version == version)
            .unwrap();
        if structural {
            assert_eq!(old.state, "not_applied");
        }
    }
}

#[tokio::test]
async fn r3_lost_repair_replays_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let (h, b, s, k, _) = fixture(dir.path());
    response(h.provider_setup(b.clone(), &setup_request()).await);
    publication(&s, 0, 1, "BASE");
    pending_hook(&s, &k, 2);
    let mut boot = step("boot", vec![message(1), message(3)], 3);
    boot["served_through_ordinal"] = json!(3);
    boot["prefix_rebuilding"] = json!({"reason":"pipeline_switch"});
    let v = response(h.provider_step(b.clone(), &boot).await);
    let mut ack = step("ack", vec![], 3);
    ack["last_applied"] = v["compaction"].clone();
    response(h.provider_step(b.clone(), &ack).await);
    let mut state = s.load("s").unwrap();
    state.core.frozen_units.retain(|u| u.key != "m1");
    s.commit("s", state.row_version, &state.core, &state.meta)
        .unwrap();
    s.queue_provider_drops(&k.store_key(), &[1]).unwrap();
    let repair = response(
        h.provider_step(b.clone(), &step("lost-repair", vec![], 3))
            .await,
    );
    assert_eq!(repair["answer"], "compaction_message");
    drop(h);
    drop(s);
    let (h, b, _s, _, _) = fixture(dir.path());
    let replay = response(h.provider_step(b, &step("retry-repair", vec![], 3)).await);
    assert_eq!(replay["answer"], "compaction_message");
    assert_eq!(
        replay["compaction"]["replacement"],
        repair["compaction"]["replacement"]
    );
    assert!(
        replay["compaction"]["version"].as_u64().unwrap()
            > repair["compaction"]["version"].as_u64().unwrap()
    );
}

fn r3_hook_entry(store: &McStore, key: &Key, entry: &Value) {
    let mut req = engine_request(1000);
    let status_entry = serde_json::from_value(entry.clone()).unwrap();
    Codec::OpencodeAiSdk
        .prepare_request(&mut req, &[status_entry])
        .unwrap();
    let message = ProviderMessage {
        ordinal: entry["ordinal"].as_u64().unwrap(),
        mid: entry["mid"].as_str().unwrap().into(),
        message_bytes: serde_json::to_vec(&entry["message"]).unwrap(),
    };
    let tool = entry["message"]["parts"][0]["type"] == "tool";
    store
        .commit_provider_hook(
            &key.store_key(),
            ProviderHookRequest {
                lineage: &root(),
                message: Some(&message),
                served_through_ordinal: None,
                unserved_subjects: &[],
                repeat_subject: None,
            },
            |ctx| {
                Ok((
                    ProviderHookWrite {
                        answer: Some(ProviderHookAnswer {
                            subject: ProviderSubject {
                                subject_mid: message.mid.clone(),
                                hook: if tool {
                                    "post_tool"
                                } else if entry["message"]["info"]["role"] == "assistant" {
                                    "post_assistant"
                                } else {
                                    "pre_user"
                                }
                                .into(),
                                subject_part: if tool {
                                    entry["message"]["parts"][0]["id"].as_str().unwrap()
                                } else {
                                    ""
                                }
                                .into(),
                            },
                            ordinal: message.ordinal,
                            ops_json: "[]".into(),
                            tags: req.messages[0]
                                .ck
                                .content
                                .iter()
                                .enumerate()
                                .map(|(i, block)| ProviderAnswerTag {
                                    number: ctx.tag_high_water + 1 + i as i64,
                                    block_id: format!("{}#{i}", message.mid),
                                    kind: match block.kind {
                                        crate::ck_wire::CkKind::ToolCall { .. } => "tool_call",
                                        crate::ck_wire::CkKind::ToolResult { .. } => "tool_result",
                                        _ => "message",
                                    }
                                    .into(),
                                    source: serde_json::to_string(block).unwrap(),
                                    token_count: 2,
                                    created_at_ms: 1,
                                })
                                .collect(),
                        }),
                        counters: ctx.counters.clone(),
                    },
                    (),
                ))
            },
        )
        .unwrap();
}

#[tokio::test]
async fn r3_randomized_host_full_engine_240_passes() {
    let mut rng = 0x4d34_5233_u64;
    let mut draw = || {
        rng ^= rng << 13;
        rng ^= rng >> 7;
        rng ^= rng << 17;
        rng
    };
    let mut mismatches = Vec::new();
    let mut events = [0usize; 8];
    let mut passes = 0;
    for case in 0..30 {
        let ad = tempfile::tempdir().unwrap();
        let od = tempfile::tempdir().unwrap();
        let (h, mut b, s, k, _) = fixture(ad.path());
        let (oh, mut ob, os, ok, _) = fixture(od.path());
        b.config.memory_enabled = true;
        ob.config.memory_enabled = true;
        let w = h.provider_work(&s, b.clone(), k.clone()).unwrap();
        let ow = oh.provider_work(&os, ob.clone(), ok.clone()).unwrap();
        let n = 4 + draw() % 7;
        let mut time = 1000_i64;
        let mut entries = Vec::new();
        for ordinal in 1..=n {
            time += if draw() % 3 == 0 { 3_600_000 } else { 1000 };
            let mut entry = message(ordinal);
            entry["message"]["info"]["time"]["created"] = json!(time);
            if ordinal % 2 == 0 {
                entry["message"]["info"]["role"] = json!("assistant");
                entry["message"]["info"]["time"]["completed"] = json!(time + 100);
                if draw() % 2 == 0 {
                    entry["message"]["parts"] = json!([{"id":format!("p{ordinal}"),"type":"tool","callID":format!("call-{ordinal}"),"tool":"read","state":{"status":"completed","input":{"path":"fixture.txt"},"output":format!("result case {case} ordinal {ordinal}"),"time":{"start":time,"end":time+100}}}]);
                }
            }
            entries.push(entry);
        }
        for (hh, bb, ss, kk) in [(&h, &b, &s, &k), (&oh, &ob, &os, &ok)] {
            response(hh.provider_setup(bb.clone(), &setup_request()).await);
            publication(ss, 0, 1, "BASE");
            for entry in &entries {
                r3_hook_entry(ss, kk, entry);
            }
        }
        let mut boot = step("boot", vec![], n);
        boot["served_through_ordinal"] = json!(n);
        boot["prefix_rebuilding"] = json!({"reason":"pipeline_switch"});
        let initial = response(h.provider_step(b.clone(), &boot).await);
        os.commit_provider_status_page(
            &ok.store_key(),
            mc_store::provider_records::ProviderStatusPage {
                lineage: &root(),
                messages: &[],
                served: Some(n),
                unserved: &[],
                newest: Some(n),
                more: false,
            },
        )
        .unwrap();
        let mut applied = initial["compaction"].clone();
        let mut req = engine_request(1000);
        req.tool_present = true;
        req.render_config = format!("{}|broca-compaction:0", setup_request()["params"]);
        let decoded = entries
            .iter()
            .cloned()
            .map(|v| serde_json::from_value(v).unwrap())
            .collect::<Vec<_>>();
        Codec::OpencodeAiSdk
            .prepare_request(&mut req, &decoded)
            .unwrap();
        let mut ctx = producer_context(&ow, "fixture", 100000, false);
        ctx.observed_last_response_at_ms = Some(ctx.now_ms);
        let oracle_boot = transform::transform_with_projection(&os, &req, &ctx).unwrap();
        assert_eq!(
            initial["compaction"]["replacement"],
            r3_native(&oracle_boot, &req, n),
            "initial full-request oracle differs: case={case}"
        );
        let mut epoch = 0;
        let mut sequence = 0;
        let mut trace = Vec::new();
        let mut queued = std::collections::HashSet::new();
        for pass in 0..8 {
            let event = (draw() % 8) as usize;
            events[event] += 1;
            let tokens = [1000, 74999, 75000, 84999, 85000, 95000][(draw() % 6) as usize];
            let mut params = step(&format!("case-{case}-pass-{pass}"), vec![], n);
            params["last_applied"] = applied.clone();
            params["served_through_ordinal"] = json!(n);
            params["estimate"]["request_tokens"] = json!(tokens);
            match event {
                0 => {}
                1 => {
                    if sequence < n as i64 - 2 {
                        sequence += 1;
                        let ordinal = sequence as u64 + 1;
                        for store in [&s, &os] {
                            publication(
                                store,
                                sequence,
                                ordinal,
                                &format!("HISTORY-{case}-{pass}"),
                            );
                        }
                    }
                }
                2 => {
                    let tags = s
                        .load_tags_for_session("s")
                        .unwrap()
                        .into_iter()
                        .filter(|t| !queued.contains(&t.tag_number))
                        .collect::<Vec<_>>();
                    if !tags.is_empty() {
                        let tag = &tags[(draw() as usize) % tags.len()];
                        queued.insert(tag.tag_number);
                        s.queue_provider_drops(&k.store_key(), &[tag.tag_number])
                            .unwrap();
                        os.append_pending_agent_drops("s", &[tag.block_id.clone()], 1)
                            .unwrap();
                    }
                }
                3 => {
                    for store in [&s, &os] {
                        store.arm_soft_refresh("s").unwrap();
                    }
                }
                4 => {
                    params["prefix_rebuilding"] = json!({"reason":"cold"});
                    epoch += 1;
                    req.render_config =
                        format!("{}|broca-compaction:{epoch}", setup_request()["params"]);
                    ctx.now_ms += 300002;
                    ctx.observed_last_response_at_ms = Some(ctx.now_ms - 300001);
                }
                5 => {
                    let content = format!("MEMORY-{case}-{pass}");
                    for (store, work) in [(&s, &w), (&os, &ow)] {
                        store
                            .insert_memory(mc_store::InsertMemoryInput {
                                project_path: &work.project_path,
                                route_project_root: None,
                                category: "architecture",
                                content: &content,
                                source_session_id: Some("s"),
                                source_type: Some("historian"),
                                importance: Some(50),
                                expires_at: None,
                                metadata_json: None,
                                now_ms: 1,
                            })
                            .unwrap();
                    }
                }
                6 => {
                    for (store, work) in [(&s, &w), (&os, &ow)] {
                        store
                            .set_project_memory_epoch_for_test(
                                &work.project_path,
                                (pass + 1) as i64,
                            )
                            .unwrap();
                    }
                }
                7 => {
                    for store in [&s, &os] {
                        let mut c = store.load_compartments("s").unwrap();
                        c[0].content = format!("EDIT-{pass}");
                        c[0].p1 = Some(c[0].content.clone());
                        store.replace_compartments("s", &c).unwrap();
                    }
                }
                _ => unreachable!(),
            }
            req.usage.as_mut().unwrap().current_total_input_tokens = tokens;
            let expected = transform::transform_with_projection(&os, &req, &ctx).unwrap();
            ctx.observed_last_response_at_ms = Some(ctx.now_ms);
            let actual = response(h.provider_step(b.clone(), &params).await);
            if actual["answer"] == "compaction_message" {
                applied = actual["compaction"].clone();
            }
            let want = r3_native(&expected, &req, n);
            trace.push(format!(
                "event={event} tokens={tokens} engine={}",
                expected.response.action
            ));
            if applied["replacement"].to_string() != want.to_string() {
                mismatches.push(format!(
                    "case={case} pass={pass} n={n} trace={trace:?}\nexpected={want}\nactual={}",
                    applied["replacement"]
                ));
            }
            passes += 1;
        }
    }
    println!(
        "random seed=0x4d345233 passes={passes} event counts={events:?} mismatches={}",
        mismatches.len()
    );
    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}

#[tokio::test]
async fn r3_temporal_fold_boundary_restart_hard_soft_and_defer() {
    for hard in [true, false] {
        let ad = tempfile::tempdir().unwrap();
        let od = tempfile::tempdir().unwrap();
        let entries = (1..=5)
            .map(|i| {
                let mut e = message(i);
                let t = [1000, 2000, 7_203_000, 7_204_000, 10_805_000][i as usize - 1];
                e["message"]["info"]["time"]["created"] = json!(t);
                if i % 2 == 0 {
                    e["message"]["info"]["role"] = json!("assistant");
                    e["message"]["info"]["time"]["completed"] = json!(t + 1000);
                }
                e
            })
            .collect::<Vec<_>>();
        let (h, b, s, k, _) = fixture(ad.path());
        let (oh, ob, os, ok, _) = fixture(od.path());
        for (hh, bb, ss, kk) in [(&h, &b, &s, &k), (&oh, &ob, &os, &ok)] {
            response(hh.provider_setup(bb.clone(), &setup_request()).await);
            publication(ss, 0, 1, "BASE");
            for e in &entries[..2] {
                r3_hook_entry(ss, kk, e);
            }
        }
        let mut boot = step("boot", vec![], 2);
        boot["served_through_ordinal"] = json!(2);
        boot["prefix_rebuilding"] = json!({"reason":"pipeline_switch"});
        let initial = response(h.provider_step(b.clone(), &boot).await);
        response(oh.provider_step(ob.clone(), &boot).await);
        for (ss, kk) in [(&s, &k), (&os, &ok)] {
            for e in &entries[2..] {
                r3_hook_entry(ss, kk, e);
            }
        }
        let mut defer = step("defer", vec![], 5);
        defer["served_through_ordinal"] = json!(5);
        defer["last_applied"] = initial["compaction"].clone();
        assert_eq!(
            response(h.provider_step(b.clone(), &defer).await)["answer"],
            "noop"
        );
        os.commit_provider_status_page(
            &ok.store_key(),
            mc_store::provider_records::ProviderStatusPage {
                lineage: &root(),
                messages: &[],
                served: Some(5),
                unserved: &[],
                newest: Some(5),
                more: false,
            },
        )
        .unwrap();
        let ow = oh.provider_work(&os, ob, ok).unwrap();
        let mut req = engine_request(1000);
        req.tool_present = true;
        req.render_config = format!("{}|broca-compaction:0", setup_request()["params"]);
        let decoded = entries
            .iter()
            .cloned()
            .map(|v| serde_json::from_value(v).unwrap())
            .collect::<Vec<_>>();
        Codec::OpencodeAiSdk
            .prepare_request(&mut req, &decoded)
            .unwrap();
        let mut ctx = producer_context(&ow, "fixture", 100000, false);
        ctx.observed_last_response_at_ms = Some(ctx.now_ms);
        let full_defer = transform::transform_with_projection(&os, &req, &ctx).unwrap();
        assert_eq!(full_defer.response.action, "SOFT+");
        assert!(!r3_native(&full_defer, &req, 5)
            .to_string()
            .contains("<!-- +"));
        assert!(s
            .load_temporal_marks("s")
            .unwrap()
            .iter()
            .all(|m| m.marker_text.is_empty()));
        drop(h);
        drop(s);
        drop(oh);
        drop(os);
        let (h, b, s, _, _) = fixture(ad.path());
        let (oh, ob, os, ok, _) = fixture(od.path());
        let ow = oh.provider_work(&os, ob, ok).unwrap();
        let mut ctx = producer_context(&ow, "fixture", 100000, false);
        ctx.observed_last_response_at_ms = Some(ctx.now_ms);
        for ss in [&s, &os] {
            publication(ss, 1, 2, "DELTA");
        }
        let mut rebuild = step("rebuild", vec![], 5);
        rebuild["served_through_ordinal"] = json!(5);
        if hard {
            rebuild["prefix_rebuilding"] = json!({"reason":"cold"});
            req.render_config = format!("{}|broca-compaction:1", setup_request()["params"]);
            ctx.now_ms += 300002;
            ctx.observed_last_response_at_ms = Some(ctx.now_ms - 300001);
        } else {
            rebuild["estimate"]["request_tokens"] = json!(75000);
            req.usage.as_mut().unwrap().current_total_input_tokens = 75000;
        }
        let full = transform::transform_with_projection(&os, &req, &ctx).unwrap();
        assert_eq!(full.response.action, if hard { "HARD" } else { "SOFT" });
        let actual = response(h.provider_step(b.clone(), &rebuild).await);
        assert_eq!(
            actual["compaction"]["replacement"],
            r3_native(&full, &req, 5)
        );
        assert_eq!(actual["compaction"]["range"]["to"], 6);
        let text = actual["compaction"]["replacement"].to_string();
        assert_eq!(text.matches("<!-- +2h -->").count(), 1);
        assert_eq!(text.matches("<!-- +1h -->").count(), 1);
        let mut settled = step("settled", vec![], 5);
        settled["last_applied"] = actual["compaction"].clone();
        assert_eq!(
            response(h.provider_step(b, &settled).await)["answer"],
            "noop"
        );
        assert_eq!(
            s.load_temporal_marks("s")
                .unwrap()
                .iter()
                .filter(|m| !m.marker_text.is_empty())
                .count(),
            2
        );
    }
}

#[test]
fn r3_repeated_skip_facts_does_not_consume_snapshot_observation() {
    let dir = tempfile::tempdir().unwrap();
    let (h, b, s, k, _) = fixture(dir.path());
    let mut w = h.provider_work(&s, b, k).unwrap();
    publication(&s, 0, 1, "BASE");
    full_engine(&s, &w, 1000);
    full_engine(&s, &w, 1000);
    let mut meta = s.load_meta("s").unwrap();
    meta.meta.protected_tokens_effective = None;
    s.commit_meta("s", meta.row_version, &meta.meta).unwrap();
    crate::protection_window::pre_snapshot_inputs_changed(s.tag_cache_namespace(), "s", 0, 100000);
    w.binding.config.protected_tokens_user = Some(4000);
    let before = s.load_meta("s").unwrap().row_version;
    let mut ctx = producer_context(&w, "fixture", 100000, false);
    ctx.observed_last_response_at_ms = Some(ctx.now_ms);
    for _ in 0..10 {
        let facts = transform::compaction::skip_facts(&s, "s", &ctx, "fixture", 100000)
            .unwrap()
            .unwrap();
        assert!(facts.hard_fold_requested);
        assert!(!transform::compaction::can_skip_classified(&facts));
        assert!(crate::protection_window::pre_snapshot_inputs_would_change(
            s.tag_cache_namespace(),
            "s",
            4000,
            100000
        ));
        assert_eq!(s.load_meta("s").unwrap().row_version, before);
    }
    let engine = transform::transform_with_projection(&s, &engine_request(1000), &ctx).unwrap();
    assert_eq!(engine.response.action, "HARD");
}

```

</details>

<details>
<summary>Exact probe comparing migration, rejection, SOFT and frozen-prefix HARD permission with real engine execution</summary>

```rust
        #[test]
        fn r3_exact_permission_engine_variants() {
            for variant in ["migrate", "reject", "soft", "marker"] {
                let dir = tempfile::tempdir().unwrap();
                let store = store(dir.path());
                let request = req(
                    "ses",
                    "cfg0",
                    vec![
                        item("a", 0, "first"),
                        item("b", 1, "second"),
                        item("tail", 2, "tail"),
                    ],
                );
                store
                    .replace_compartments("ses", &[comp(1, 0, 0, "a", "BASELINE")])
                    .unwrap();
                let mut st = status(&request.messages);
                let mut state = State::new("compact".into(), Preset::Head);
                adapter::setup(&store, &request, &context(), &st, &mut state).unwrap();
                let plan = match variant {
                    "migrate" | "reject" => {
                        let mut loaded = store.load("ses").unwrap();
                        loaded.core.frozen_units = vec![FrozenUnit {
                            key: if variant == "migrate" {
                                "baseline"
                            } else {
                                "unknown"
                            }
                            .into(),
                            kind: "synthesized-region".into(),
                            frozen_payload: "OLD".into(),
                            durability_class: mc_core::DurabilityClass::Lineage,
                            reset_rule: String::new(),
                        }];
                        loaded.core.pending_changes.clear();
                        store
                            .commit("ses", loaded.row_version, &loaded.core, &loaded.meta)
                            .unwrap();
                        if variant == "migrate" {
                            PassPlan::MigrateHard
                        } else {
                            PassPlan::Reject("unknown frozen-set shape")
                        }
                    }
                    "soft" => {
                        store
                            .replace_compartments(
                                "ses",
                                &[comp(1, 0, 0, "a", "BASELINE"), comp(2, 1, 1, "b", "DELTA")],
                            )
                            .unwrap();
                        st.previous_usage = Some(PreviousUsage {
                            input_tokens: Some(66000),
                            cached_input_tokens: Some(0),
                            cache_write_tokens: None,
                        });
                        PassPlan::Soft
                    }
                    "marker" => {
                        let mut loaded = store.load("ses").unwrap();
                        loaded.meta.project_memory_epoch_pending = true;
                        store
                            .commit("ses", loaded.row_version, &loaded.core, &loaded.meta)
                            .unwrap();
                        PassPlan::Hard
                    }
                    _ => unreachable!(),
                };
                let result = adapter::step(&store, &request, &context(), &st, &mut state);
                if variant == "reject" {
                    assert!(matches!(result, Err(TransformError::UnknownShape(_))));
                    assert!(!pass_plan_permits_prefix_mutation(&plan, false));
                } else {
                    let full = result.unwrap();
                    assert_eq!(
                        full.engine.response.action,
                        if variant == "soft" { "SOFT" } else { "HARD" }
                    );
                    assert_eq!(
                        pass_plan_permits_prefix_mutation(&plan, variant == "marker"),
                        full.engine.response.prefix_bust_permitted,
                        "variant={variant}"
                    );
                }
            }
        }

```

</details>

## Implementation follow-up (not an independent re-review)

The implementation worker reproduced all five new regressions unchanged before
editing product code. Each finding is committed separately.

### Non-final execution fence

`r3_nonfinal_bootstrap_with_hook_complete_history_waits_without_engine` is now
green. Every `more:true` page returns `wait` immediately after admission and cursor
recording, before view acknowledgements or engine evaluation, regardless of held
frontier completeness. The existing paging/lock-release control remains green.

### Recomp shape reset

`r3_recomp_reset_summary_agrees_with_full_core` is now green. A codec write with a
cleared base is a full rewrite, even when the new frozen set is empty and an outer
reset already deleted the old chunks. It writes the new shape rather than copying
the retired index's shape. A debug assertion checks every known full-write summary
against the encoded core. The new write-path test independently compares the stored
summary with a loaded full core after bootstrap, append, scalar update, recomp,
empty rewrite and rebootstrap. All 35 codec tests pass, with the one pre-existing
profile benchmark ignored; package compilation passes. Existing chunk/hash and
unchanged-write controls remain green.

### Independent upgrade identity and metadata preflight

The two engine-path upgrade tests are green without changing their expectations.
The HOST_PASS exception now requires identical model, provider, system and upgrade
state **and** identical decoded epoch fields. Only an opaque transport-plan base
string may differ. Length-prefixed epoch decoding accepts only a complete suffix,
so a delimiter inside a plan or an encoded field value cannot become an epoch.
The ordinary SOFT+ adoption controls remain green. During adoption the head retains
its advertised tagger surface; rendering live host tags is a separate overlay lane,
not a reason to invent a tagger epoch solely because the transport changed.

`r3_upgrade_epoch_cannot_be_skipped_by_host_preflight` is also green. The preflight
constructs its versioned identity through the full engine's `m0_content_epoch_for_pass`
and `fold_m0_content_epoch` builders from metadata inputs. It compares every epoch
field, including module, compartment, serializer-profile, tagger and prompt epochs,
not only the model. The persisted mural identity is retained from metadata, exactly
as the engine uses the persisted mural for classification; no frozen payload is
loaded. The added workspace/prompt-identity reads and hashing are read-only.

A seventeenth concrete trigger, `real_state_trigger_previous_module_epoch`, first
establishes a real SOFT m1 delta and a skip-eligible SOFT+ baseline. It writes the
previous module-render epoch into the stored identity, invokes the actual metadata
preflight, and requires the following real full engine to HARD-fold. Every concrete
trigger additionally checks that preflight preserves the metadata row version and
full-decode counter. A staged `NON-VACUITY BREAK` disabling the versioned identity
comparison made exactly this seventeenth test fail (`preflight skipped a concrete
module_epoch trigger`); all prior sixteen tests stayed green. Restoring the staged
implementation left an empty unstaged diff, and all seventeen then passed on Linux.

### Third-review regression and randomized rerun record

All five committed regressions were red at `d3b3517d99` before product edits and
are now green without changing their expectations:
`r3_upgrade_epoch_cannot_be_skipped_by_host_preflight`,
`r3_pipeline_switch_does_not_exempt_module_render_epoch`,
`r3_upgrade_identity_change_is_not_transport_adoption`,
`r3_nonfinal_bootstrap_with_hook_complete_history_waits_without_engine`, and
`r3_recomp_reset_summary_agrees_with_full_core`.

The report appendix's independently bootstrapped randomized control is now also
preserved in the test file for reproducible future reruns. Its generator, event
selection, seed and real full-request oracle are unchanged; the comparison uses
serialized JSON bytes rather than allocating strings solely for comparison. The
borrowed tag-id slice avoids a Clippy-only clone. The rerun printed:

```text
random seed=0x4d345233 passes=240 event counts=[24, 32, 34, 35, 37, 32, 22, 24] mismatches=0
```

That is 240 transitions plus 30 independent bootstrap comparisons. The final
provider selection passed all 83 tests and the S2/evaluator selection passed all
13 tests on Linux. Strict package Clippy passes. The original regression bodies
and their assertions are unchanged; only the passing appendix control was appended.

Final gate record for this implementation follow-up: guarded Linux package tests
passed 83 provider tests (including all unchanged review expectations and the random
control), 9 protection tests, 13 S2/evaluator tests, 35 codec tests with one existing
ignored benchmark, 17 provider-log tests, 5 fingerprint tests and 4 digest tests.
Package library/binary compilation and strict Clippy passed. Repository build,
four-workspace typecheck and lint gates passed; Pi, CLI and Retina test gates also
passed (Retina: 27 tests). The root JavaScript test gate retained only the known
unrelated migration-v87 twin-rule failure: plugin 7308 passed, 6 skipped, 1 failed.
No package manifest, lockfile or generated output was changed.
