# Applied-boundary validator: master consequence and train verification

## Revisions and conclusion

- Reproduced source: `master` / `origin/master` at **52ad4484860fc925a37f6da8f27da77defbbf692**. A `git archive` of that exact revision was built inside the task worktree. Only a full-engine test was added to the archived `transform.rs`; production code was not changed for the reproduction.
- Merged train: **f09ff1a0cf297883406ead255aa6fc5c22f17125**, automatically merged into the T1 branch with no conflicts.

**This is a live full-request Rust-engine fix, not just a provider-bootstrap fix.** On the normal trimmed-history case, the old comparison falsely enters the durable pending-rewrite safety path. It does **not** immediately force an extra HARD. The module instead emits live-tail-only pass-through bytes, drops its two composed prefix frames, and latches an alarm that ordinary subsequent passes cannot clear. OpenCode's LKG guard normally prevents those changed module bytes from reaching the model, but it freezes the old host representation and postpones progress. Without an admissible LKG, the host can refuse the turn. The fixed comparison keeps the ordinary SOFT+ path and frozen bytes without entering that recovery machinery.

## Exact first-pass branch sequence on master

The following line references are to `crates/mc-module/src/transform.rs` at the pinned master revision, not to the later train's line numbers.

1. `resolve_boundary_state` first looks for the stored boundary block in the live input. Marker trimming has removed it, so the live-boundary arm does not apply (`10022-10039`). The declared boundary ID, coverage ordinal, and first remaining ordinal are otherwise correct.
2. The old validator loads compartments and chooses their newest sequence. A newly published, still-unapplied compartment is newer than the compartment reflected in the cached prefix. Its endpoint differs from the declared applied boundary. The function returns **`BoundaryState::Absent` plus `TrimMismatch { predicate: "tail_compartment", ... }`** (`10064-10102`).
3. The transform computes `boundary_present = false` and performs its absent-boundary lineage-shape check (`4525-4553`). A stored boundary/coverage or existing pending rewrite makes `needs_lineage_check` true. There is a durable row and durable lineage.
4. `surviving_revert_prefix_seq` is a **prefix** check: it uses `take_while` over chronological compartments, not a search for any later endpoint (`10130-10142`). The old applied compartment's endpoint was trimmed out. Thus the first compartment fails even if the new publication's endpoint is in the live tail, and the result is `-1`.
5. For the ordinary session in this reproduction, `anchor_block_id` is absent. Therefore `pending_rewrite_absent_shape && anchor_block_id.is_none()` takes the early safety arm (`4562`). This is not an explicit lineage-switch request or a descended-lineage materialization.
6. On the first trip, the engine copies the core unchanged, records `PendingRewriteState`, its shape fingerprint, and `pending_rewrite_last_failure`; records the live-tail served fingerprint; commits those metadata/alarm changes; and returns `pending_passthrough_result` (`4667-4784`). The initial ambiguity flag is false. This is the durable alarm, **not** a destructive truncate or immediate ambiguity-threshold refusal.
7. `pending_passthrough_result` sets action/decision to **`PASSTHROUGH`**, materialize reason to **`pending_rewrite`**, boundary state to `Absent`, reclaim permission to false, and scheduler observation to `Defer` (`10236-10288`). Its messages contain only the live input, possibly with already-held overlays. **No composed m0/m1 frames lead this array.**
8. This return occurs before the ordinary identity/seam enforcement and planner path. In this scenario, it does **not reach `reconcile_hard_due`, select HARD/MigrateHard, execute an extra compaction, or return a transform error/refusal.** In the later planner, `reconcile_hard_due` is a separate condition based on `loaded.core.reconcile_pending && !boundary_present`; the reproduction's `reconcile_pending` was false and remained false. A generic conclusion that an absent boundary necessarily forces HARD would be wrong here.

For a session with a completed lineage anchor, the `anchor_block_id.is_none()` condition is different; the conclusion above is specifically the ordinary marker-trimmed session requested, not an assertion that every absent-boundary shape has the same outcome.

## Subsequent passes and recovery

On another ordinary pass with the same trimmed input and unapplied newest publication, the false trim mismatch recurs. Because `pending_rewrite` is already present, master takes the existing-alarm arm (`4564-4664`): it returns the same live-tail-only PASSTHROUGH, leaves the core and planner state alone, and writes only if its served fingerprint changed. In the reproduction, the second alarm pass made no additional row-version or core-version change. It did not increment the absent-request counter merely for the identical repeat.

A later boundary-present pass can mark the alarm for clearing; ordinary plan commit then clears it and records the trip count. Restoring a valid applied-boundary comparison is precisely what prevents the publication from being interpreted as this missing-lineage event. An explicit lineage descent, changed input shape, genuine revert, or recovery/fail-closed condition is separate behavior and should not be inferred from this publication alone.

## Exact observable reproduction

Command, run on Linux with Cargo 1.99.0:

```text
cargo test --locked -p mc-module --lib \
  transform::tests::master_unapplied_publication_trim_observable_effect \
  -- --exact --nocapture
```

Result: **one passed test, zero failures** against the archived master source. The test deliberately asserts and prints the old erroneous behavior; it is not a test pretending master already has the fix.

Fixture: use master's existing `declared_trim_fixture`, select `opencode-aisdk`, record applied compartment sequence 0, settle two passes, then append compartment sequence 1 covering the next live message. The declared trim and live input are unchanged.

Observed output:

```text
before_action: SOFT+
before_messages: [synthetic session-history, synthetic session-history-since, user tail]
after_action: PASSTHROUGH
after_materialize_reason: pending_rewrite
boundary_state: Absent
trim_mismatch.predicate: tail_compartment
trim_mismatch.detail: tail compartment ended at id "c#0" ordinal 1,
  not declared id "b#0" bare "b" ordinal 0
after_messages: [user tail]
prefix_bust_permitted: false
pending_rewrite: { absent_request_count: 1, armed_at_ms: 0,
  absent_shape_fingerprint: c7984ad33bdd292e9d63b4f5f7b6e3e200964042ddf1a4e67ac77aaa78348c39 }
ambiguity_alarm: false
reconcile_pending: false
core_version: 2
row_version: 4
repeat_action: PASSTHROUGH
repeat_messages: [user tail]
repeat_core_version: 2
repeat_row_version: 4
```

The run emitted these exact WARN messages:

```text
mc-module: first_divergence session=decl {"index":0,"block_id_old":"mc_m0#0","block_id_new":"c#0","kind":"removed","approx_token_depth":0}
mc-module: armed pending_rewrite for decl fingerprint c7984ad33bdd292e9d63b4f5f7b6e3e200964042ddf1a4e67ac77aaa78348c39 ambiguous=false
mc-module: pending_rewrite raw pass-through for decl fingerprint c7984ad33bdd292e9d63b4f5f7b6e3e200964042ddf1a4e67ac77aaa78348c39
```

The current fixed regression, `declared_trim_after_unapplied_publication_preserves_full_engine_bytes`, instead requires `DeclaredTrimValidated`, `SOFT+`, `prefix_bust_permitted = false`, exact before/after CK bytes, and no pending-rewrite alarm. It passed within the merged full module suite.

### Minimal reproduction body to add inside master's transform tests module

This uses only existing master test helpers and the real full transform:

```rust
#[test]
fn master_unapplied_publication_trim_observable_effect() {
    let (_dir, store, mut request, ctx) = declared_trim_fixture();
    request.serializer_profile = "opencode-aisdk".into();
    let mut loaded = store.load("decl").unwrap();
    loaded.meta.coverage_compartment_seq = Some(0);
    store.commit("decl", loaded.row_version, &loaded.core, &loaded.meta).unwrap();
    transform_with_projection(&store, &request, &ctx).unwrap();
    let before = transform_with_projection(&store, &request, &ctx).unwrap();
    let mut rows = store.load_compartments("decl").unwrap();
    rows.push(comp(1, 1, 1, "c", "unapplied publication"));
    store.replace_compartments("decl", &rows).unwrap();
    let after = transform_with_projection(&store, &request, &ctx).unwrap();
    assert_eq!(before.response.action, "SOFT+");
    assert_eq!(after.boundary_state, BoundaryState::Absent);
    assert_eq!(after.trim_mismatch.unwrap().predicate, "tail_compartment");
    assert_eq!(after.response.action, "PASSTHROUGH");
    assert_eq!(after.response.materialize_reason.as_deref(), Some("pending_rewrite"));
    assert!(!after.response.prefix_bust_permitted);
    assert_ne!(serde_json::to_vec(&before.response.ck_messages).unwrap(),
               serde_json::to_vec(&after.response.ck_messages).unwrap());
    assert!(store.load("decl").unwrap().meta.pending_rewrite.is_some());
}
```

The executed version additionally printed first/repeat response and durable state and enabled the WARN subscriber, producing the captured output above. No live user database or live host was opened.

## OpenCode 1's host-served bytes are a separate layer

The pinned master's plugin checks producer permission, not the textual decision alone. It recognizes a no-permission divergence involving `mc_m0#0` or `mc_m1#0`, sets `lkgRepresentationFrozen`, forces full wire, and logs **`deferred frozen-prefix divergence; replaying LKG`** (`packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:3990-4042`). The reproduced `mc_m0#0` removal satisfies that predicate even though the module decision is PASSTHROUGH rather than SOFT+.

The healthy frozen-replay arm normally serves the admitted old LKG array and logs **`lkg_frozen_replay_served`**. It preserves the module's differing native output separately as a delta basis. Therefore this reproduction proves **changed module CK/native candidate content and a needless host freeze/recovery event**, not an unconditional priced provider-byte cache bust. With a valid, fitting LKG the host-served frozen prefix can remain byte-identical. A missing, invalid, over-limit, or marker-fenced LKG can instead drive the existing fail-closed/refusal path; that is conditional and was not claimed as an observed live incident.

Relevant host logs also include `lkg_frozen_replay_released reason=...`, `rust transform failed; attempting LKG replay:`, `mc_rust_park_transition ...`, and the marker/emergency refusal logs. Those are recovery alternatives, not branches taken by the one direct full-engine test. There is no evidence of an extra HARD on the first ordinary master pass described above: the early pending-rewrite return prevents it. The fix is valuable on master because it prevents the false alarm, raw module candidate, forced-full-wire/LKG freeze and stalled publication progress while preserving the previously valid prefix.

## Merged-train verification and baseline comparison

All commands requested Linux and ran serially for Cargo.

| Gate | Merged T1 + f09 result |
|---|---|
| T1 through `pure-replay-differential.ts --provider-pipeline` | **84 passed**, both host bindings, all twelve actual module SIGKILL/reopen cuts |
| `cargo test --locked -p mc-module --lib -- --test-threads=4` | **1855 passed, 25 ignored, zero failed** (1880 tests) |
| `cargo test --locked -p mc-store -- --test-threads=4` | **314 passed, five ignored, zero failed** (319 unit tests; no doctests) |
| Build then full plugin suite in the same Linux job | **8073 passed, nine skipped, two failed** (8084 tests) |
| Exact f09 archive, build then full plugin suite | **8074 passed, nine skipped, one failed** (8084 tests) |

The old schema-95 host-store failures, move-writer progress failure and temporary-directory policy failure are gone after the train merge. The nine bundle fixtures pass when their distributions are built in the same isolated job; running the suite before that prerequisite produced missing-dist failures, not a merge regression.

The **common remaining failure** is `Node WASM Transformers fixture > builds with real fs and persists a model for offline reuse`: the generated temporary bundle cannot resolve `onnxruntime-web/webgpu`. It failed at both merged T1 and exact f09 after matching build preparation.

The merged full run additionally hit `slow embedding aborts at the deadline, freezes skip bytes, and cannot land late`. This test is **byte-identical to f09** (Git blob `b7669c04abd694e6cc540ae27c3469417616ab16`). A paired focused run of the merged and exact f09 copies passed **all eight tests, zero failures**. The train already documents the same occasional full-suite timing failure in `docs/reports/historian-drain-gate-review.md:224`. This is recorded as an unchanged timing flake, not waived or rewritten.

No conflicts required resolution, no merge-time implementation changes were needed, and no comparison checkout outside the task worktree was used.
