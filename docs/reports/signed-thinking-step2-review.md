# Independent cache review: signed-thinking hold, Rust step 2

Reviewed candidate: `15a40f6a103d717492321d498933ea84385b2ff3`.
Comparison baseline: `192f6346b139fff93764c561c91dba4be0f8c3a8`.
Only this report and review tests are changed; no engine, schema, architecture or design changes.

## Recommendation: **no merge as described**

The four advertised OpenCode Rust-mode trigger lanes work in the exercised cases, including persisted parking, all-held replay, and a single release bust. The subagent replan is justified. However, the claim that Claude Code remains unchanged behind the profile gate is false for two cache-relevant metadata paths. Two new tests pass against the baseline engine and fail against the candidate engine. Either extend the profile gate or explicitly approve the narrower gate and its changed Claude Code behavior before merging. These are compatibility/scope findings, **not evidence of a newly introduced provider 400**: keeping guidance and overlays unchanged may be safer than their old behavior, but it is not the advertised gated rollout.

Nor is this slice a complete implementation of Held passes. HARD coverage, todo and placeholder edits still violate the full held-prefix rule in the existing strict audit. Those are baseline defects assigned to later rollout steps, not new regressions blamed on step 2.

## Contract used

I read the protected `ARCHITECTURE.md:48-108`, including invariants 1–4, and the approved amendment in `docs/designs/signed-thinking-hold.md:1302-1381`. Provider validity is the exception to draining an already-dead prefix: a held prefix replays, a parked trigger is not standing permission, and the first boundary-free pass carries its original permission. Infinite tool loops do not create a new safe release point merely by accumulating more passes.

The step-2 fence is `docs/designs/signed-thinking-hold.md:1697-1703`; the explanation at `:1740-1751` says the gate keeps Claude Code exactly as it is today. The commit-state requirements at `:552-593` explicitly include guidance and pending overlay coordinates. Later coverage, companion strip, full release obligations and served-prefix-record work are not implemented by this slice.

## Findings with baseline-green, candidate-red tests

### 1. Claude Code guidance adoption is outside the profile gate

`crates/mc-module/src/transform.rs:5356-5358` gates trigger holds off for `ClaudeCodeAnthropic`, but `:6277-6280` now guards guidance-date adoption with prefix admission without that profile gate. A Claude Code flush still reports a mutation pass, consumes `soft_refresh_pending`, and writes no parking record, yet no longer adopts its guidance date while current-turn thinking is kept. Previously the same flush adopted it.

Reproduction/test: `step2_review_claude_code_gate_preserves_guidance_adoption` in `crates/mc-module/tests/signed_thinking_prefix_audit.rs`. Bootstrap the existing Claude Code tool-loop fixture, arm a flush, set `ctx.guidance_date = "2026-09-02"`, and transform. The existing flush/parking gate assertions pass; the baseline-date assertion fails only on the candidate:

```text
Claude Code guidance behavior changed despite the profile gate
left: ""
right: "2026-09-02"
```

This field feeds subsequent system-prompt guidance, so it is not merely a trace counter. The test intentionally pins the excluded profile's old behavior, not the final hold design's behavior.

### 2. Claude Code pending-overlay drain is also outside the profile gate

The new admission-filtered clears at `transform.rs:6103-6105` and `:6171-6173` likewise apply to Claude Code. Seed a previously served block in both pending lists, enable auto-search so the hint-list drain is exercised, and run the same held flush. The baseline empties those lists; the candidate keeps them although it still consumes the flush and does not park it.

Reproduction/test: `step2_review_claude_code_gate_preserves_pending_overlay_drain`:

```text
Claude Code pending overlays changed despite the profile gate:
tags={"step-1#0"}, hints={"step-1#0"}
```

These lists suppress tag/hint rendering on their blocks, so retaining them changes later replay/render eligibility. I am not claiming that this fixture's current wire changes or that a new 400 has been demonstrated. The demonstrated defect is incomplete profile isolation of the metadata behavior promised unchanged by this slice.

Both new tests were appended to the **baseline test fixture** and run against the baseline product sources: **2 passed, 0 failed**. Against the candidate: **both fail**, while the four independent positive probes pass. No existing assertion was deleted or inverted in this review.

## Verdict by requested area

### 1. Non-prefix-bound and no-thinking sessions — **observed wire compatibility passes; universal claim not established**

The existing library gate passes, including `pure_passthrough_defer_round_trips_tail_byte_identical`, `four_pure_defer_passes_preserve_served_bytes_and_durable_drop_state`, all four `differential_goldens` tests, the caveman oracle, and `r2_review_720_pass_differential_with_new_seeds_and_real_reduce`. This exercises ordinary replay, mutation/fold and pressure behavior, rather than only a signed-thinking mock.

I separately captured the original Rust audit on both revisions, for `claude-opus-4-6` (non-prefix-bound) and `claude-opus-5-5`, in default and strict golden modes, with **separate Cargo target directories per revision**. For the non-prefix-bound class, all **1,412 baseline pass files** have counterparts, with **zero wire-byte changes and zero `bustedThisPass` changes**. The candidate has 180 additional files from new fixtures; they are not evidence of baseline equivalence. This corpus includes defer, flush, HARD and force/wall scenarios; it does not prove every possible session or every decision-reason string/order.

The no-thinking bookkeeping control `force_latch_ignores_bookkeeping_without_thinking` also passes. Importantly, its latch behavior is intentionally **not** identical to the old engine: `transform.rs:7582-7586` excludes trailing-blank bookkeeping even outside thinking turns, as expressly required at design `:590-593`. Thus “unchanged” cannot mean identical internal trigger state. The original baseline inventory has no matching no-thinking-only fixture for that new control. I did not manufacture a test demanding restoration of that approved bug.

The step-1 comparator passes for the Rust subset: **1,634 eligible/common wire files compared**. Of the entire prefix-bound common inventory (including ineligible passes), 10 wire files and 36 bust flags differ; these are the release/replan cases, not rejected-class changes. The comparator filters prefix-bound eligibility, so its green result must not be read as proof about all held or release passes. Its rejected-class exception list would also allow some force-latch changes; none were needed in this actual Rust comparison.

The full five-host `scripts/signed-thinking-differential.sh 192f6346` could not complete: direct execution hit the exported worktree's read-only `.git/worktrees`, and a self-contained clone then failed `bun install --frozen-lockfile` with registry `DNSResolveFailed` (1,002 packages). The Rust-only capture/comparison above is a narrower fallback, not a claimed full-harness pass.

### 2. Held passes — **pass for the four changed trigger lanes; fail for the full design, as before**

`DropFull`, `Flush`, `Caveman` and `Image` now hold their wire edits, report no bust, leave their original triggers available, and land at the next real user turn. The existing `held_flush_keeps_commit_state` checks calibration, protection floor, guidance, execute watermark and pending-coordinate preservation. The new `step2_review_parked_lanes_replay_and_release_after_store_reopen` adds three identical-input passes, three further signed tool-loop steps, store reopen, valid release of each lane's own work, and an immediate repeat that **does not bust again**.

The boundary is computed after replaying frozen reasoning removals (`edit_admission_for_request`, `transform.rs:17629-17707`), rather than equating raw historical reasoning with kept current-turn reasoning. The all-held loop repeats selection as Defer before the bust-derived metadata writes (`:5501-5503`, `:5843-5862`). That is the right direction.

The full “nothing before kept thinking changes” statement remains false: `MC_AUDIT_STRICT=1 cargo test -p mc-module --test signed_thinking_prefix_audit` fails at `opencode_rust_mode::primary_mid_loop`, first on **HardFold**, and the default diagnostic run shows **HardFold, Todo and Placeholder** change non-thinking bytes before kept thinking. The same strict test name fails at the baseline. These are documented later-slice gaps; removing them from the merge description is necessary if the description sounds like general prefix safety. The fixture's prefix-record validation field is still a constant, not a tested head/summary/cut record (`signed_thinking_prefix_audit.rs:379-381`).

### 3. Parking and liveness — **conditional pass; waiting forever without a safe boundary is deliberate**

- A repeated request with no new user message stays parked and byte-identical. More signed assistant steps do not grant release. The new reopen/release probe prices this for all four changed lanes.
- A subagent run is one turn. The existing subagent audits and the new inherited-delta probe retain the queued drop throughout repeated all-held execute passes. A subagent that never has a boundary-free pass can wait for its whole lifetime. The approved design acknowledges this correctness cost at `:1174-1177`; there is no timeout that makes an unsafe edit valid.
- A model switch to a non-prefix-bound model, without a new user message, makes admission boundary-free. `step2_review_model_switch_releases_parked_permission_without_new_user` verifies the flush permission drains and parking clears on that pass. It does **not** claim that old strict-model signatures remain valid on an unrelated model. A switch between prefix-bound models continues to require a safe frame by the predicate; that variant has not been independently executed here.
- Store reopen restores parking and releases it once. This is an on-disk `McStore` reopen with its old writer lease released, **not** a daemon kill/restart or live host restart.
- `step2_review_parked_force_crosses_live_95_wall_without_spending_held_work` passes at **90%, 95%, 96%, then 85%**: unchanged held wire, intact pending target and parking, unspent force latch; release still lands. The 95% arm remains live pressure, not a parked permission.
- `parked_force_cancels_when_pressure_ends` passes: leaving the band removes the force obligation; the next user turn at low pressure does not invent a bust for it. A flush, by contrast, persists until its arm clears. Cancellation is not a promise to release every queued opportunistic edit at low pressure.
- Pressure must not admit known-over frozen bytes. The unchanged host controls `REVIEW: both-over frozen recovery must refuse rather than send ten known-over requests` and `CONTROL: emergency frozen recovery must refuse rather than send ten known-over requests` pass, along with the raw-fallback limit controls. The Rust library's `claude_code_protected_results_over_limit_is_a_typed_refusal_not_passthrough` passes too. Caller usage at 95% alone is not provider-proven final-wire overflow and must not invent a refusal. These tests do not constitute a live provider-overflow-under-parking capture; that remains a coverage gap.

### 4. Subagent replanning — **pass for the reductions-only contract**

Ignoring inherited m1/HARD deltas in the child all-held check is correct. Those deltas cannot be applied by this branch: `prefix_materialization_enabled` excludes children (`transform.rs:5367`), the child overrides the prefix classifier's plan (`:5822-5833`), and its execution calls `core.step` with new reduction units only, no boundary and no queued prefix units (`:6302-6318`). It does not enter primary HARD composition. Requiring parent-prefix deltas to match would incorrectly keep a child mutation plan open for work it cannot perform.

`step2_review_subagent_inherited_delta_cannot_spend_all_held_permission` adds a compartment publication to the child fixture while a drop is held and verifies three identical served arrays, no bust, unchanged m1 revision/coverage/execute watermark, and the still-pending target. Existing issue-630 target protection remains authoritative. This is not an assertion that every already-served **tail** block is immutable: an admitted tail reduction can validly mutate such a block on its own child bust permission. Nor is this fixture a concurrent real parent/child clone drive; parent database isolation is outside this edit.

### 5. Removed `release_gap` lanes and changed assertions — **legitimate, with a narrow meaning**

The old DropFull/Flush/Caveman/Image exceptions accepted a known loss of release permission. Removing those exceptions makes the tests stronger: they now require `held == armed`, a valid release, and the lane's edit landing. The new no-bust assertion catches a falsely priced all-held pass. The commit's explanation matches the implementation and the executed next-turn results; this is not a green suite obtained by reversing a safety assertion.

The remaining default `exposed` allowances are still real defects, not safety guarantees. The Wall95 early return is also honest: comparing non-thinking bytes across a new user message cannot distinguish a wall-lane release from the message append itself. The four-lane reopen probe adds an explicit once-only-bust check missing from the original simple release assertions.

## Gates and evidence

All executable gates below ran on Linux. Tools: **cargo 1.99.0 (5f94df478 2026-08-27)**, **rustc/clippy b940084d7 (2026-09-28)**, **rustfmt 1.10.0-stable**, **Bun 1.4.2 (744846f84)**.

| Gate | Baseline / pristine candidate / reviewed tree |
|---|---|
| `cargo test -p mc-module --lib` | Candidate **1,848 passed, 25 ignored**, 0 failed (1,873 enumerated); includes pure-replay and Rust differentials. Not rerun on baseline: no candidate library failures to classify. |
| `cargo test -p mc-module --test signed_thinking_prefix_audit -- --nocapture` | Baseline **6 pass**; pristine candidate **11 pass**; reviewed tree **15 pass, 2 intentional regression failures**. |
| Same Rust audit with `MC_AUDIT_STRICT=1` | Baseline **3 pass, 3 fail**; pristine candidate **8 pass, same 3 fail**; reviewed tree **12 pass, 5 fail** (the same 3 plus the 2 new gate regressions). |
| New Claude Code review tests against baseline engine | **2 pass**, 0 fail. |
| Rust golden capture: both model classes × both modes × both revisions | Baseline 6 tests/capture; candidate 11 tests/capture, all successful in assertion-bypassing capture mode. Inventory 1,412 → 1,592/model class. Comparator **1,634 common eligible wire files, PASS**. |
| `cargo clippy -p mc-module --all-targets -- -D warnings` | Passed on pristine and final reviewed tree; package all-targets compiler/lint diagnostics, no warnings. |
| `rustfmt --edition 2021 --check crates/mc-module/tests/signed_thinking_prefix_audit.rs` | Passed, exit 0. |
| Bun Rust-mode refusal/replay controls | **16 pass**, 0 fail, **748 expectations** across `rust-mode-frozen-review-r2.test.ts` and `rust-mode-raw-fallback-admission.test.ts`. |
| Bun signed-thinking audits, default | Candidate **142 pass**, 0 fail, **24,104 expectations** across the plugin and Pi audit files. |
| Same Bun audits with `MC_AUDIT_STRICT=1` | Candidate **112 pass, 30 fail**, **23,853 expectations**. Baseline could not load `zod` and `@cortexkit/subc-client`, including after reuse of the existing root dependency directory; **0 tests passed, 2 loader errors** in each mode. No assertion-level baseline failure-name comparison is claimed for Bun. |
| Full step-1 differential script | Incomplete for the infrastructure/install reasons above; no full-five-host golden result claimed. |

The three existing Rust strict failure names, identical at the baseline and pristine candidate, are:

```text
claude_code::control_at_new_user_turn
claude_code::primary_mid_loop
opencode_rust_mode::primary_mid_loop
```

The TypeScript/Pi strict failures are the following names under `signed prefix audit:` (the OpenCode rows apply to both `OpenCode 1 TS mode` and `OpenCode 2`). Those package sources, manifests and lockfiles have no diff between the two reviewed SHAs; that is source evidence of unchanged behavior, not a substitute for the unavailable baseline execution.

| Host/scope | Failing test suffixes |
|---|---|
| OpenCode 1/2, primary mid tool loop (10 each) | `m[0]/m[1] re-render after a recomp clears the cached pair`; `synthetic todo`; `processed image strip`; `stale ctx_reduce strip`; `frozen-sentinel first application`; `release survives a restart: /ctx-flush`; `mixed pass: a 95% tail reduction on a parallel tool arc lands while an older drop stays held`; `prefix cut moved by a compartment rewrite that keeps the cached pair: mid tool loop`; `prefix cut moved by a compartment rewrite that keeps the cached pair: defer pass at a new user turn`; `compaction-marker summary retired by a bust: mid tool loop` |
| OpenCode 1/2, subagent run (2 each) | `stale ctx_reduce strip`; `frozen-sentinel first application` |
| Pi/OMP, primary mid tool loop (6) | `m[0]/m[1] re-render after a recomp clears the cached pair`; `synthetic todo`; `frozen-sentinel first application`; `release survives a restart: /ctx-flush`; `prefix cut moved by a compartment rewrite that keeps the cached pair: mid tool loop`; `prefix cut moved by a compartment rewrite that keeps the cached pair: defer pass at a new user turn` |

The final default red run names **only**:

```text
step2_review_claude_code_gate_preserves_guidance_adoption
step2_review_claude_code_gate_preserves_pending_overlay_drain
```

For reproduction, run those two names with Cargo's `step2_review_claude_code` filter; run all six independent review probes with `step2_review`. To compare baseline and candidate captures, use pristine checkouts of the two SHAs, set `MC_AUDIT_MODEL`/`MC_AUDIT_GOLDEN` as the step-1 script does, and use **distinct `CARGO_TARGET_DIR`s per revision**. An initial shared-target scratch run incorrectly reused the six-test baseline binary for the candidate; it was rejected, not counted as evidence. The corrected capture explicitly checked the candidate's eleven-test inventory before comparing bytes. Fresh clones and installed-dependency reuse were test infrastructure only, not compatibility shims or product modifications.

AFT inspection was partial while rust-analyzer indexed and reported the integration fixture's test-only `ProducerContext` field as missing. Cargo successfully compiled the integration test and clippy all targets; those are the authoritative diagnostics. No TypeScript source was edited, so no new TypeScript typecheck was required for this report/test-only delivery.
