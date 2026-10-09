# M3 correctness review, round two

## Verdict and scope

**Do not accept M3's hook/full-engine byte parity or exactly-once drop replay yet.** At base `b0685e44e299fe610bdf79b44cd73fe96598fd00`, four independently executable regressions remain: stale exact-plan permission, HARD reminder output-count bytes, model-switch reminder calibration, and resurrection of a consumed drop on hook replay. This delivery changes no product code. It adds this report and four **unignored, intentionally failing** tests in `crates/mc-module/src/providers/step_transform_review_tests.rs`.

M3 is the host step-transform slice: the host asks a hook to modify each newly arriving message instead of running the complete request transform. Its acceptance rule is identical served bytes on the same pass, no new temporal prefix on a defer, and no later change to an already served message. In this report **HARD** means an engine-authorized prefix rebuild; **defer** means replaying the frozen prefix. Synchronizing an exact plan means sending that engine decision in `state_sync.provider_pass.exact_pass_plan` for the identified new messages.

I read `cache-review-m3.md` and the M3 commit messages from `8cfe8e60` through `b0685e44`, including `085ecbca`'s requirement that only the current exact engine plan permits temporal mutation, and `1ba7a92a`'s addition of a missing provider-table DROP to a synthetic migration fixture. Tests use temporary SQLite stores and the real OpenCode codec, hook dispatcher and full-request engine. No live store or user configuration was opened.

The expressly deferred late-HARD temporal view and bounded-summary performance work are **not findings**:

- **Late HARD temporal covering view:** `providers::step_transform::parity_tests::late_hard_view_covers_new_users_and_renders_full_engine_temporal_marker` is explicitly ignored with the expected-failure dependency on M4 `64dbbf2f93a7099c94b4a7b1dfa3d6b19be09c22`. M4 is the compaction-view slice: when permission arrives too late for a hook, its covering replacement must supply the withheld temporal marker. Running it with `--ignored --exact` still fails at `late HARD must produce a view`, after its full-engine marker positive control. The label and commit pin are clear.
- **History-sized metadata projection:** `bounded_policy_summary_does_not_return_the_entire_known_metadata_lineage` is explicitly ignored pending stage-two bounded summaries; running it still fails with `returned 50040 retained metadata parts`. `measure_alf_sized_full_metadata_walk_per_hook_and_three_hook_pass` is separately labelled a manual correctness-stage measurement with the performance/enablement gate closed. These named tests pin the acknowledged history walk; I did not rerun the timing benchmark or claim bounded performance.

## Findings

Test names in this section are under `providers::step_transform::review_tests`.

### 1. A previous pass's exact HARD authorizes a new, unsynchronized user's temporal mutation — blocking

**Test:** `r2_temporal_plan_must_belong_to_the_current_hook_pass`.

**Minimal input:** temporal awareness enabled; user `u1@1`, text `first`, created `1000`; synchronize an exact HARD containing only `u1`, hook it and acknowledge it. Warm both engine namespaces on that one-message request. Then append/hook `u2@2`, text `second`, created `301000`, in lineage `L`, **without synchronizing an exact plan for u2**. The independent engine selects `SOFT+` (defer) on `[u1,u2]`.

- Expected: `§2§ second`.
- Actual: `§2§ <!-- +5m -->\nsecond`.
- Cause: `crates/mc-module/src/providers/step_transform.rs:734-737` reads the retained `pass_context.exact_pass_plan`, and `:758-764` checks only the lineage, not whether the current subject belongs to that exact pass. The old pass's `appended_ids` contains only `u1`. Membership is checked for the reminder carrier at `:801-803`, but not for temporal permission. Pass context persists after the earlier answer.
- Contract: invoking the shared predicate with a **stale** exact plan is not an exact plan for this pass. No current exact plan must mean defer. This is an early hook-permission defect, not the deliberately open late-HARD covering-view defect.

### 2. The host uses defer baseline membership on an exact HARD, changing reminder bytes — blocking

**Test:** `r2_three_tool_appends_use_full_pass_protection_and_carrier`.

**Minimal input:** warm a single baseline user; neutral model, protection floor `16000`, history budget `2000000`; in one pass append three completed `read` tool messages `a@2,b@3,c@4`, each output `"spent payload ".repeat(30000)`, input `{}`. Change the engine render config to force HARD and synchronize exact HARD before hooking the three results. The first two carrier-negative comparisons pass.

- Expected reminder on `c`: `2 spent tool outputs (~180k tokens) are still unstamped. Call ctx_reduce now, before your next tool call, on every output you've already used.`
- Actual reminder on `c`: `spent tool outputs (~180k tokens) are still unstamped. Call ctx_reduce now, before your next tool call, on every output you've already used.`
- Both have the same `<system-reminder>` delimiters and `oldest reclaimable: §2§ read · §3§ read · §4§ read.` line. The omitted `2 ` is a byte mismatch, not an equivalent rendering.
- Cause: `crates/mc-module/src/transform.rs:11004-11015` unconditionally passes `cache_busting=false` to `refresh_tail_hygiene_baseline_calibrated` in the host policy projector. The full engine's bust refresh at `:6788-6813` freezes the prefix **before the newest message**, leaving the newest tool in the turn delta (`crates/mc-module/src/tail_hygiene.rs:835-869`). The count renderer counts `baseline_parts`, not every output contributing actionable/reclaimable token mass (`crates/mc-module/src/transform.rs:13567-13573`). The hook does not select this refresh mode from the synchronized exact plan and reconstructs different baseline membership. Its carrier selection is correct in this reproducer.

### 3. A model-switch HARD uses the old frozen calibration in the hook — blocking

**Test:** `r2_model_switch_reminder_uses_the_exact_pass_calibration`.

**Minimal input:** warm one baseline user with no model key; protection `16000`, history budget `2000000`. Switch the binding and engine request to `anthropic/claude-fable-5-1`; append one completed `read` result `a@2`, output `"spent payload ".repeat(20000)`, input `{}`; synchronize exact HARD. The full engine's `prefix_bust_permitted` positive control is true.

- Expected suffix:
  ```text
  <system-reminder>
  spent tool outputs (~62k tokens) are still unstamped. Call ctx_reduce now, before your next tool call, on every output you've already used.
  oldest reclaimable: §2§ read.
  </system-reminder>
  ```
- Actual: **no reminder**. The neutral host projection remains below the Channel-1 floor.
- Cause: `crates/mc-module/src/providers/step_transform.rs:804` projects `ctx.counters["engine_policy"]`; `crates/mc-module/src/transform.rs:10864-10870` reads its prior frozen calibration. Its unconditional non-bust refresh also explicitly retains previous baseline ratios (`crates/mc-module/src/tail_hygiene.rs:907-930`). The full engine adopts `DecisionCalibration::for_model(req.model_key)` on a pass authorized to rebuild prefix bytes (`crates/mc-module/src/transform.rs:5233-5251`) and uses those ratios in its bust refresh (`:6792-6810`). Updating the binding's model key and giving the hook the correct exact HARD does not make that adoption happen in the projector.
- Other sampled switches produce the inverse failure: a hook emits a reminder that the engine omits. Stable, pre-frozen non-neutral calibration passing is insufficient evidence for switch parity.

### 4. Replay can make an atomically consumed provider drop queueable again — blocking

**Test:** `r2_replayed_served_hook_does_not_resurrect_a_consumed_drop`.

**Minimal input:** hook user `u1@1` (`first`) to mint tag 1; hook `u2@2` with `served_through_ordinal=1` to promote u1. Queue tag 1 through `provider_host_reduce`; place the matching `u1#0` engine drop in the conversation's `engine_namespace`; successfully call `commit_with_consumed_drops` (the wrapper of `commit_transform`). Both queues drain and `provider_answer_tag_known(1)` becomes false. Replay the original u1 hook with the same acknowledged frontier, then attempt to queue tag 1 again.

- Expected: the consumed number stays ineligible; requeue refuses; provider pending drops stay empty.
- Actual: the replay's rendered text remains `§1§ first`, **but requeue returns `Ok(())` and pending drops are `[1]`**.
- Cause: consumption marks `consumed=true` only in existing answer rows (`crates/mc-store/src/provider_log.rs:393-434`). `provider_answer_tag_known` accepts any pending/live answer with the number and no consumed flag (`:831`). Repeated hooks burn pending answers, not the previously served live answer (`:739-758`), and unconditionally insert another answer row (`:990`, `:1027-1029`). Tag selection reuses the existing policy part's number (`crates/mc-module/src/providers/step_transform.rs:740`), so the new row reintroduces tag 1 without its consumed bit.
- The engine/provider **transaction is atomic**; that property passed. The missing property is a durable consumed-number/replay fence after the atomic commit. The existing atomic-consumption test repeats consumption and requeue, but does not interpose a hook replay that creates a new answer row.

## Nine earlier blocking fixes: independent variations

The unchanged original hook suite ran first: **26 passed, four explicitly ignored**, including the worker's original three corpus variants. The old module review controls remain green in the final tree: nine passed alongside only the four new failures.

I then ran temporary test-only fixture/input variations, restoring them before delivery so the committed old assertions remain untouched:

| Original finding | Variation and observation |
|---|---|
| 1: timestamp fallback | Changed the predecessor from an authored user to assistant text without completion, retaining the five-minute gap and full-engine byte oracle. Passed. New-seed corpus also varies completion presence and user/assistant predecessors. |
| 2: protected Channel-1 accounting | New seeds vary large/small tool arcs, siblings, protection membership and frozen calibration; queued releases also pass. Two tool appends with neutral calibration passed. **Exact HARD with three tools and model-switch adoption fail more broadly**, as findings 2–3 document. |
| 3: oldest hint | Varied the direct reminder fixture to three eligible hints (`read`, `ctx_reduce`, `bash`) instead of one, preserving the independently rendered expected string. Passed; randomized metadata also carries `ctx_reduce` tool names. |
| 4: disabled search | Enabled the binding while leaving the frozen plan disabled, unlike the old both-disabled fixture. Full-engine disabled-search comparison passed. The corpus independently toggles binding/request search while the plan lacks a disable flag. |
| 5: physical user tail | Three newly appended matching users; compared the **middle** user against the engine and positively asserted a hint on the third. Passed. |
| 6: rendered-memory exclusion | Changed frozen memory budget from 8000 to 9000 on both sides; confirmed ID 1 in the rendered head before comparing the newly appended user. Passed. New seeds cover zero/head-visible budgets and search toggles. |
| 7: independent sibling drops | Three text tags contributing 10,20,30; queued the **last** tag twice and repeated the request. Expected text mass 60, reclaimable mass 30, queue `[3]`; passed. |
| 8: inherited burned cadence | Three same-turn answers instead of two; duplicate burns of the earlier firing answer, with two surviving non-firing successors and the next carrier at ordinal 4. Positive fire/surviving-mass controls and expected next reminder passed. |
| 10: no-change restart | Changed generation 1→2 to 1→5 and changed the unchanged-watermark shortcut to false, testing the computed no-change route. The retry still resends synchronized chain inputs; passed. |

The two earlier should-fix controls also passed: the busy-sync refusal remains side-effect-free, and completed receipt adoption still closes the current pass when the receipt shadow sequence changes from 1 to 9.

## Random differential: 768 passes, 47,084 message comparisons

### Ordinary append/defer and queued-release corpus

The `drive_overlay_corpus` driver in `step_transform_parity_tests.rs`, which compares hook-rendered codec output against full-engine output, was temporarily rerun with **new seeds** `0x81ac0023`, `0x519e72a0`, `0x9c340162`, `0xa107d891` and **60 passes per seed**. The mixed assistant/text/tool message now uses `ctx_reduce` instead of `bash`; the queued variant invokes the real `provider_host_reduce` adapter rather than queueing directly. The three variants are ordinary, queued tool/sibling releases, and stable non-neutral calibration.

Result: **720 passes, 46,980 per-message comparisons, zero byte mismatches** (each variant: 240 passes, 15,660 comparisons). Messages are independently decoded from the actual hook-rendered native parts and compared to the full engine's current pass output; old served messages are retained, not regenerated from the expected output. Cases cover one to three appends, user and assistant text, completed tools, tag imitation stripping, Unicode, large/small outputs, queued drops, hints, reminders, timestamp gaps, completions and frozen calibration. For these *new* seeds the earlier digest artifact, which contains only the worker's four seeds captured from the full engine before helper extraction, was deliberately not consulted; no replacement pre-extraction reference was manufactured.

### Exact rebuild/model-switch companion

A separate deterministic generator (`0x3e9bc027`, the same 64-bit xorshift recurrence) exercised **48 independent HARD passes, 104 new-message comparisons**. Each case has fresh independent host/full stores warmed twice on one baseline user with the old model; it changes `render_config` to force a real rebuild, switches to the new model, then synchronizes **exact HARD** before hooks. It varies one to four completed `read`, `bash` and `ctx_reduce` tools and payload sizes. This tests early, exactly planned hook answers, **not** M4's late-HARD view. It compares only actual hook-emitted new messages, not a replacement copied from the oracle.

It collected **29 mismatching messages**; the collector's successful process exit is **not a passing parity verdict**. Every mismatch is on the last tool carrier; all earlier tools match. The following ledger enumerates all 29, including missing/extra reminders. The two minimized HARD tests above reproduce the baseline-membership and calibration causes without needing the random generator.

Reproducer recipe for any row: warm a baseline user twice with the `old` model in both independent namespaces; bind the host to `new`; append the listed tools as individual assistant messages starting at ordinal 2, each with `{}` input and `"spent payload ".repeat(repeats)` output; sync exact HARD with the ordered IDs and physical tail; set the full request's model to `new` and change its render config; run hooks in order and compare the last result with the real full transform. Temporal awareness is on for even case numbers; created time is `ordinal * 301000`, no completion. Memory budget is zero, floor 16000 and history budget 2000000. The corpus request has geometry soft/hard/wall 4000000/6000000/8000000. Auto-search is off.

Legend: N = no model; F = `anthropic/claude-fable-5-1`; G = `openai/gpt-4.1`. Reminder `S(n,k)` has the `still unstamped / Call ctx_reduce now` sentence, `H(n,k)` the `Housekeeping / Stamp each output` sentence, and `R(n,k)` the `reclaimable / Make a ctx_reduce pass now` sentence. `n=—` means the count is omitted; k is the printed approximate thousands of tokens. `none` means no reminder. Where both sides emit a reminder, delimiters and oldest-tag lines match within each row; the differences shown are the entire differing reminder content. Each tool name is in request order; `reduce` abbreviates `ctx_reduce`.

| Case | Old→new | Tools | Repeats | Expected | Actual |
|---:|---|---|---:|---|---|
| 3 | F→G | read,bash,reduce | 30000 | S(2,101) | S(—,186) |
| 6 | F→G | bash,read | 10000 | none | S(—,62) |
| 7 | N→F | read,read | 30000 | S(1,186) | S(—,120) |
| 9 | F→N | bash,reduce,bash | 30000 | S(1,120) | S(—,186) |
| 13 | N→F | read,read | 20000 | S(1,124) | S(—,80) |
| 15 | F→F | bash,reduce,bash,bash | 20000 | S(2,186) | S(—,186) |
| 17 | F→G | bash,read | 20000 | S(1,67) | S(—,124) |
| 18 | F→N | read,bash,read | 20000 | S(2,120) | S(—,186) |
| 19 | G→N | bash,reduce,reduce | 30000 | H(1,60) | H(—,50) |
| 20 | F→G | bash,reduce,bash,read | 20000 | S(2,101) | S(—,186) |
| 22 | N→G | reduce,read,bash | 30000 | S(1,101) | S(—,120) |
| 23 | G→F | read | 20000 | S(—,62) | none |
| 24 | F→N | read,bash,bash | 30000 | S(2,180) | S(—,279) |
| 26 | F→N | reduce,reduce,read | 20000 | H(—,40) | H(—,62) |
| 27 | F→N | read,read | 10000 | none | S(—,62) |
| 28 | F→G | bash | 20000 | none | S(—,62) |
| 29 | N→G | reduce,bash,read,read | 30000 | S(2,151) | S(—,180) |
| 31 | N→F | read,reduce,reduce | 20000 | H(1,62) | H(—,40) |
| 33 | N→N | reduce,bash,read | 30000 | S(1,120) | S(—,120) |
| 35 | F→G | read | 30000 | none | S(—,93) |
| 36 | G→N | reduce,bash,reduce,bash | 20000 | R(1,80) | R(—,67) |
| 37 | G→N | read,read,bash | 30000 | S(2,180) | S(—,151) |
| 38 | F→N | bash | 20000 | none | S(—,62) |
| 42 | N→N | bash,read,bash | 10000 | S(2,60) | S(—,60) |
| 43 | G→N | read,bash,reduce | 10000 | S(2,40) | none |
| 44 | F→G | read,bash,read,bash | 30000 | S(3,202) | S(—,372) |
| 45 | N→F | reduce,read,bash | 20000 | S(1,124) | S(—,80) |
| 46 | G→G | bash,bash,read | 20000 | S(2,101) | S(—,101) |
| 47 | G→F | reduce,read,reduce | 10000 | H(1,31) | none |

## Exact-plan audit

- **Temporal prepend:** the only host temporal emission is `crates/mc-module/src/providers/step_transform.rs:758-773`. It invokes `pass_plan_permits_prefix_mutation` at `:737`, using the parsed `exact_pass_plan` and frozen-prefix marker flag. Fresh pass contexts obey the predicate, but finding 1 shows that merely calling it does not establish that the plan belongs to the current hook.
- A temporary **eight-row byte matrix** exercised absent plan, Defer, HARD, marker-HARD/frozen-prefix, Soft, MigrateHard, Reject, and Soft with frozen-prefix flag. Every row also supplied `prefix_mutation_permitted=true`, cautious `preflight_candidate="hard"` and `skip_facts={hard:true}`. All eight matched the independent engine's corresponding permitted-HARD or withheld-defer bytes. Those candidate/boolean/skip fields are not decoded into `ProviderPassInput` or copied into the stored permission context (`:40-55`, `:366-374`). No candidate-as-permission path was found.
- **First-serve tag prepend** (`:775-779`) and **assistant imitation cleanup** (`:746-756`) are not gated by the prefix-bust predicate. They transform newly arriving blocks, not previously served prefix bytes; the full engine also tags/cleans these on ordinary defers. The independent 46,980-comparison corpus covers these paths. Treating every new tag as a prefix-cache rewrite would contradict the full-engine oracle.
- **Hint append** (`:790-799`) has its own physical-tail, search-enable and rendered-memory gates (`:656-689`, `:870-874`), not temporal permission. **Reminder append** (`:123-168`, `:812-820`) uses cadence/carrier eligibility. These may first-serve on a defer; findings 2–3 concern their different HARD input projection, not an unauthorized defer temporal prepend.
- The separate non-OpenCode legacy provider path (`:1104-1145`) has assistant cleanup, tool tags and cadence operations but no temporal prepend. The existing owned-Broca golden control passed. No hidden temporal/preflight bypass was found there.

## Migration63 fixture correction and policy_json

`git show 1ba7a92a -- crates/mc-store` changes exactly one fixture line: it adds `DROP TABLE mc_provider_policy_parts_v1` to `cache_codec/tests.rs:rewind_to_62`. No production migration SQL or test assertion is changed. The fixture already drops **the entire hook-answer table** (`:1031`), including its `policy_json` column; it removes every `mc_cache` stamp >=63 (`:1049`). Leaving the policy-parts table behind did not describe a real v62 database and predictably collided with migration66's CREATE TABLE.

Execution checks:

- `migration_63_moves_every_shape_and_the_codec_reads_it_back`, `migration_63_moves_pass_trace_histories_into_ring_rows`, `a_failed_migration_63_guard_leaves_the_store_at_62` and the pinned SQL check all passed in the full store run.
- `v65_blob_round_trips_messages_answers_views_pending_drops_and_empty_lineages` passed, including its query/assertion that migrated answer `policy_json` values are exactly `{}`. Migration66's legacy INSERT omits this new column and receives its default.
- A temporary `r2_rewind62_recreates_both_v66_policy_json_columns` test asserted that both provider tables are absent immediately after rewind and that reopening through `McStore::open_for_test` recreates **both** `mc_provider_hook_answers_v1.policy_json` and `mc_provider_policy_parts_v1.policy_json`. Passed.

Thus the fixture correction does not hide a failure to recreate either policy column on the supported forward migration. It is **not a production downgrade implementation** or a test of opening an older binary against a newer database. Nor does it certify an already-stamped, older *unreleased* v66 layout that predates the policy amendment: the first report explicitly calls this an unreleased-v66 amendment. No schema shim or production downgrade fix was introduced or assumed.

## Crash, replay and atomic drop consumption

A temporary store test, `provider_log::review_tests::r2_crash_after_hook_commit_then_replay_consumes_drop_once_by_namespace`, used a real child test process. Its provider key had session `host-session`, but `engine_namespace="engine:r2"`, preventing a session-name proxy from proving the namespace join.

It promoted/queued tag 1, then the child committed another hook answer and terminated with `process::exit(91)` **without dropping the store and before the engine commit**. The parent reopened the store, confirmed queue/version preservation, replayed that pending hook, and confirmed only one pending answer and tool mass 100 (80 target +20 survivor). An injected SQLite abort before the engine drop DELETE preserved both queues, the version and mass. A successful retry drained both queues and left survivor mass 20; repeated consumption of the same ID twice did not subtract it again. This control passed in the 285-pass store run. It is a durable post-hook/pre-engine process-exit test, not a claim of SIGKILL coverage at every module fault point.

The namespace consumption join and engine DELETE are inside the same CAS transaction (`mc-store/src/lib.rs:11160-11181`). The existing `provider_drop_consumption_is_atomic_with_engine_commit_and_never_requeues` and non-provider namespace control also passed. **Finding 4 is the additional replay-after-success boundary those passing controls omit.**

## Verification record

Every Rust `test`, `check` and `clippy` command ran remotely with `runon: linux`, prefixed by `test "$(uname -s)" = Linux || exit 97`; output explicitly reported **Linux**. No `runner_draining` response or Mac fallback occurred. Heavy Rust commands were run one at a time and awaited to avoid saturating the shared build server. No foreground polling loop was used.

Tools: cargo `1.99.0 (5f94df478 2026-08-27)`, rustc `1.99.0 (b940084d7 2026-09-28)`, clippy `0.1.99 (b940084d7e 2026-09-28)`, rustfmt `1.10.0-stable (b940084d7e 2026-09-28)`, Bun `1.4.2 (744846f84)`.

| Check | Result |
|---|---|
| `cargo test --locked -p mc-module --lib providers::step_transform -- --nocapture --test-threads=4` at base | 26 passed, 4 ignored; original corpus 288 passes / 8364 comparisons. |
| Temporary new-seed `... providers::step_transform::parity_tests -- --nocapture --test-threads=4` | 7 passed, 4 ignored; three corpus variants total 720 passes / 46980 byte comparisons, no mismatch. |
| Temporary `... parity_tests::r2_ -- --nocapture --test-threads=1` | Eight permission rows matched; HARD companion collected all 29 mismatches in 48 passes /104 comparisons. Collector exit zero is not parity acceptance. |
| Temporary varied `... review_tests -- --skip ::r2_ --nocapture --test-threads=4` | 9 passed. |
| `cargo test --locked -p mc-store --lib -- --nocapture --test-threads=4` with temporary crash/sibling variations | 285 passed, 4 ignored, including process-exit/replay and all migration cases. Expected-panic inventory/transaction controls printed their intentional errors but passed. |
| Temporary migration policy-column test, `--exact --nocapture` | 1 passed. |
| Both named ignored integration gates, separately with `--exact --ignored --nocapture` | Each ran 1 test and failed for its declared open reason, not counted as findings. |
| Final `... review_tests -- --nocapture --test-threads=4` | 9 unchanged controls passed; exactly the four new named regressions failed. |
| Minimized one-tool model-switch test, `--exact --nocapture` | 1 intended failure: actual None, expected ~62k reminder. |
| `cargo check --locked -p mc-module --tests` | Passed for module library, binaries and test targets. |
| `cargo clippy --locked -p mc-module --lib --tests -- -D warnings` | Baseline failure in unchanged `mc-store/src/provider_log.rs:220`: `admit_policy_parts_tx` has 8 arguments (limit 7). No out-of-scope lint fix made. Test compilation and package check verify the changed Rust file. |
| Clippy repeated with only `-A clippy::too_many_arguments` after `-D warnings` | Seven remaining baseline diagnostics: explicit-counter loop and three cloned-ref fixtures in unchanged parity tests, two cloned-ref fixtures in the original review tests (lines 234,404), and needless update in the old hook corpus. No diagnostic names an added hunk. New clone warnings exposed during lint isolation were corrected only in the new tests. |
| `cargo fmt --check` and `git diff --check` | Passed; rustfmt version above. |
| Scoped `inspect` of changed Rust file | Partial: checkout call graph unavailable and rust-analyzer still indexing. Not treated as a clean diagnostic verdict; remote Cargo test compilation and package check are authoritative. |
| Sidekick comment review of final test/report diff | Both new Rust comments clear; report terminology clarified with the exact-plan rule and definitions of HARD, defer and the covering-view dependency. |
| `bun run --cwd packages/plugin test:serial src/hooks/magic-context/module-state-sync-review.test.ts src/hooks/magic-context/module-state-sync.test.ts` with temporary variations | 31 passed, 143 assertions; frozen install checked 1010 installs /1251 packages without manifest/lock changes. |

Only the failing regressions survive in the test tree; all passing experiment modifications were restored. No existing test expectation was inverted. The four failures are direct byte/state assertions, not silent source guards. Full workspace compilation, native daemon end-to-end fault matrices and package-wide TypeScript typechecking were not repeated for this Rust-test/report-only delivery. The prepared worktree's build was already green. Results here are M3 correctness findings, not host pipeline enablement or performance acceptance.

## Remediation of the four round-two blockers

All four committed review expectations are unchanged. The pre-fix run reached and failed exactly the four named regressions; the post-fix run reaches and passes all four. Separate commits record the fixes:

| Finding | Commit | Change and red-to-green result |
|---|---|---|
| Stale exact plan | `371cf56846` | `exact_plan_for_subject` requires the same lineage and membership in the synchronized appended IDs. `r2_temporal_plan_must_belong_to_the_current_hook_pass` changed from the unwanted five-minute prefix to the full engine's unmarked `§2§ second`. |
| HARD baseline membership | `94d54edb11` | Full engine and projector share `refresh_channel1_baseline`. A scoped exact, prefix-mutating head plan selects bust refresh; absent/stale plans, workers and marker-HARD stay on defer semantics. `r2_three_tool_appends_use_full_pass_protection_and_carrier` now produces the engine's exact `2 spent tool outputs` count on only the last carrier. |
| Model-switch calibration | `4ef3b5e72c` | State sync records the binding's pass model, and both lanes call `calibration_for_prefix_pass`: a bust adopts `for_model`, a defer retains the frozen epoch. `r2_model_switch_reminder_uses_the_exact_pass_calibration` now emits the exact ~62k reminder. A separate full-engine byte test covers the inverse switch, where the engine omits the reminder and the hook must omit it too. |
| Consumed-number replay | `a465e5bb39` | The unreleased-v66 `mc_provider_consumed_tags_v1` fence is keyed by engine namespace and tag number, not answer sequence. Consumption writes it in the engine/provider transaction. Number resolution, requeue, metadata eligibility and tag promotion consult it even after a replay inserts another answer. `r2_replayed_served_hook_does_not_resurrect_a_consumed_drop` now retains replay bytes but refuses the consumed number and leaves the queue empty. |

The consumed fence is must-move history: it cannot be reconstructed from potentially replayed answer rows. Its session owner is recorded for the store's ownership guard; namespace/number remain the primary key. The synthetic migration63 downgrade fixture drops the new table with the other v66 objects. Existing migration and forward-v65 round-trip assertions are preserved.

### Crash-before-commit and namespace variation

`provider_log::review_tests::r2_crash_before_commit_preserves_namespace_fence_and_applies_drop_once` runs a real child test process on a provider session `s` whose engine namespace is **`engine:r2`**. A SQLite abort before the engine drop DELETE forces the entire CAS, both queue drains, aggregate change and new consumed fence to roll back; the child exits91 without dropping the store. Reopen verifies the old version, both pending queues and the still-known number. A successful retry consumes once, later repeated IDs do not subtract again, and namespace `another-namespace` has no fence for number1. The original review's actual hook-replay test independently confirms that a new answer row cannot requeue the successfully consumed number.

### Persistent differential, including the previously missing HARD coverage

The original 288-pass corpus and its independent pre-extraction reference remain unchanged and green.

`r2_review_720_pass_differential_with_new_seeds_and_real_reduce` reproduces the review's **720 ordinary/queued/stable-calibration passes and 46,980 exact message comparisons**: seeds `0x81ac0023`, `0x519e72a0`, `0x9c340162`, `0xa107d891`, sixty passes per seed per variant, the mixed tool renamed to `ctx_reduce`, and queued work delivered through the real `provider_host_reduce` adapter. It asserts zero mismatches and the exact comparison count; it does not replace the old pre-extraction digest artifact.

The original temporary 48-HARD collector was not committed and its nineteen passing input cases were undocumented. Per the parent's explicit disposition, `r2_published_hard_failures_and_new_seeded_switch_controls_match_full_engine` re-runs **every one of the 29 published failure recipes** (79 comparisons), then adds **nineteen clearly NEW controls** from fixed seed `0x3e9bc027`. This persistent companion has 48 passes and **113 comparisons**, all exact byte assertions against independent full stores, not a mismatch collector that exits zero. Thus the re-run has **768 passes /47,093 comparisons**, not the review's original47,084: the nine-comparison difference belongs to the new, honestly labelled controls. Both missing-reminder and extra-reminder directions pass.

### Final gates and unchanged deferrals

All Cargo checks/tests used `runon: linux` and `test "$(uname -s)" = Linux || exit 97`; output confirms Linux. Heavy Cargo jobs were serialized and awaited.

- `cargo check --locked -p mc-module --tests`: passed (library, binary and test targets).
- `cargo test --locked -p mc-store --lib -- --test-threads=4`: **285 passed, five ignored**, zero failures. One ignored test is the subprocess crash helper, which the passing parent test invokes explicitly.
- `cargo test --locked -p mc-module --lib -- --test-threads=4`: **1720 passed,26 ignored**, zero failures; this includes the old288-pass corpus,720-pass reproduction,48-HARD companion and all thirteen old/new module review cases.
- Repository `npm run test`, `npm run build`, `npm run typecheck`, `npm run lint`: passed.
- `cargo fmt --all` and its check: passed.
- Strict Clippy remains the already-reviewed baseline failure at `admit_policy_parts_tx` (eight arguments versus seven). No waiver is used to label it green and no unrelated lint refactor is included.

The stage-two bounded summaries, performance/enablement gate and labelled late-HARD temporal covering-view integration dependency remain deferred exactly as the parent authorized. This delivery fixes the four round-two blockers; it does not reinterpret those deferred items as completed campaign acceptance.
