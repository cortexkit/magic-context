# Independent correctness review of fast-Rust M3

## Scope and verdict

Reviewed `91401c96aa..ad1c0d99e329a1c0ad5802e0bf5a27a8a7693767` (14 files), against the folded campaign's D1–D3, A1–A10 and M3, the ruled D1–D4/P1–P4 ledger in `origin/train/agent-move:.cortexkit/alfonso/drafts/host-runner-contract-extensions.md`, and ARCHITECTURE.md's protected cache rules.

**Do not sign off M3's byte/cadence/barrier acceptance yet.** This review supplies eleven failing regression tests: nine blocking findings and two should-fix findings. Implementation fixes are deliberately absent. Only test-module declarations were added to existing implementation files.

`transform.declare` and `transform.hook` are real routed method strings in `providers/mod.rs`, not missing source-file paths. No compatibility shim was invented. The report and three review-test files are explicitly requested new files.

The byte tests use OpenCode ingest decoded by the real codec and the real full-request transform on temporary stores. The full engine is driven through its initial transition before comparing accepted output. The protection and oldest-tag tests deliberately isolate the Channel-1 policy boundary: their independent oracles are the real from-scratch hygiene walk and the engine reminder renderer with a nonempty oldest-tag selection. They are not complete host-pass differential tests.

## Findings

Test names below are exact function names within `providers::step_transform::review_tests`, unless another target is named.

### 1. Temporal history loses the previous message's created-time fallback — blocking

- **Test:** `review_temporal_gap_uses_previous_created_time_when_no_completion_exists`.
- **Input sequence:** two authored users, `u1@1` created at 1,000 ms, then `u2@2` created at 301,000 ms; neither has a completion timestamp. Enable temporal awareness and hook both in order.
- **Expected:** full engine serves `§2§ <!-- +5m -->\nsecond`.
- **Actual:** hook serves `§2§ second`.
- **Cause:** `timestamp_temporal_marks` advances its time basis on every message and uses `completed_at_ms.unwrap_or(created_at_ms)`. The host hook persists only a completion timestamp in `last_response_at_ms`. A previous user, or an assistant without a completion timestamp, therefore cannot supply that basis.
- **Clause:** M3's temporal-byte acceptance; D4 temporal lane; A3 byte identity. This is not a declared difference.

### 2. The Channel-1 aggregate does not account for protection — blocking

- **Test:** `review_channel1_aggregate_respects_the_engine_protected_token_window`.
- **Input sequence:** establish a held `read` call/result arc, output `"spent payload ".repeat(30000)`, with its result tag inside the protected window; evaluate reminder policy while a fresh tool carrier is available.
- **Expected:** the engine's from-scratch hygiene measurement has `U = 0` and `T >= CHANNEL1_MIN_TOKENS`; `decide_channel1` does not fire.
- **Actual:** the host aggregate counts that entire protected arc as reclaimable and emits an append.
- **Cause:** admission metrics add all targeted text and tool tokens to `reclaimable_tokens`. `host_channel1` never receives a protection projection, coverage, calibration, frozen reductions or post-reduce grace. Sharing `decide_channel1` does not make its different baseline equivalent.
- **Clause:** M3 Channel-1 cadence/byte acceptance; A3; D3.2's cadence accounting. The test isolates an established protected-tag state, not the engine's separate first-mint behavior.

### 3. Channel-1 always drops the oldest-reclaimable hint — blocking

- **Test:** `review_channel1_reminder_keeps_the_engine_oldest_tag_hint`.
- **Input sequence:** a firing baseline with `T = 100000`, `U = 30000`, four tool outputs and an eligible oldest tag `§1§ read`.
- **Expected:** the full engine's rendered reminder includes `oldest reclaimable: §1§ read.`.
- **Actual:** the same reminder lacks that line.
- **Cause:** `host_channel1` passes `&[]` to `build_channel1_reminder` unconditionally. The full path computes `oldest_reclaimable_hint` from eligible, unqueued tags.
- **Clause:** M3's requirement that Channel-1 bytes match today's engine, and A3. The existing cadence test compares both sides with an empty hint list and cannot detect this omission.

### 4. Disabled auto-search still appends a user hint — blocking

- **Test:** `review_disabled_auto_search_produces_no_hint_like_full_engine`.
- **Input sequence:** bind with `config.auto_search.enabled = false`; freeze a plan also carrying `auto_search_enabled: false`; seed a matching memory and two unrelated candidates; hook `rust ownership borrowing` with zero length/score thresholds.
- **Expected:** full request with auto-search disabled contains no `<ctx-search-hint>`.
- **Actual:** the hook appends the hint (`true` versus `false` in the assertion).
- **Cause:** `host_user_hint` builds a request with the default enabled flag and does not consult the binding's auto-search enable switch. It calls the helper whose caller normally owns that gate.
- **Clause:** M3 hint-byte acceptance; D4's existing auto-search behavior; A3. This reproducer disables both the trusted binding setting and the plan setting, so it does not depend solely on an interpretation of an opaque plan parameter.

### 5. Earlier users in a multi-append pass incorrectly get hints — blocking

- **Test:** `review_hint_only_targets_the_physical_user_tail_of_a_multi_append_pass`.
- **Input sequence:** append `u1@1` and `u2@2` in one pass, both containing the matching prompt. Hook in order.
- **Expected:** full engine hints `u2` only; `u1` is exactly `§1§ rust ownership borrowing`. The test confirms the positive hint on `u2` before comparing `u1`.
- **Actual:** `u1` also receives the complete hint.
- **Cause:** the helper requires the target to be the physical tail of the full request. Passing a one-message request to it makes every pre-user hook appear to satisfy that predicate. No pass-tail eligibility is carried into this hook implementation.
- **Clause:** A3 (including passes with multiple appends); M3 hint parity; D2.3's ordered per-append hooks.

### 6. Hints repeat memories already rendered in the frozen head — blocking

- **Test:** `review_hint_excludes_fragments_already_rendered_in_the_memory_head`.
- **Input sequence:** seed matching and unrelated memories; warm both namespaces with a baseline and an 8,000-token memory budget; append the matching user prompt. The full-engine control confirms memory ID 1 is in the prior rendered head.
- **Expected:** full engine serves `§2§ rust ownership borrowing` without an additional hint for the already-visible memory.
- **Actual:** hook serves the same tagged text plus the memory hint.
- **Cause:** `host_user_hint` always passes an empty `rendered_memory_ids` exclusion set. The full path passes its durable rendered-memory IDs.
- **Clause:** M3's reuse-of-engine-helper byte acceptance; A3; D3.1's namespace adoption of existing full-request state.

### 7. Queueing one text tag clears its siblings' reclaimability — blocking

- **Test:** `provider_log::review_tests::review_queueing_one_text_block_keeps_its_sibling_reclaimable` (`mc-store`).
- **Input sequence:** one answered user subject with two tagged text blocks, token contributions 10 and 20; promote it, then queue only tag 1.
- **Expected:** `text_tokens = 30`, `reclaimable_tokens = 20`, pending queue `[1]`. Queueing changes eligibility, not served mass.
- **Actual:** `text_tokens` and queue are correct, but `reclaimable_tokens = 0`.
- **Cause:** `queue_provider_drops` subtracts the whole answer's `metrics.reclaimable_tokens` for any one tag, then zeroes the whole field. An answer can contain several independent text tags. Summing the similarly modified `policy_json` rows reproduces the same error and is not an independent recomputation oracle.
- **Clause:** M3's running-policy requirement and Channel-1 parity; D3.2's queue/cadence rules; A3's queued-drop corpus.

### 8. Burning an earlier answer leaves its fire in later cadence snapshots — blocking

- **Test:** `review_burning_an_earlier_answer_removes_its_inherited_cadence_effect`.
- **Input sequence:** large tool answer `a@1` fires a reminder, but the host times out after module commit. Later answer `b@2` succeeds without a reminder in the same turn. On the next tool hook `c@3`, report `a` in `unserved_subjects`.
- **Expected:** `a` burns; no surviving answer has delivered a reminder; remaining tool mass is above the Channel-1 floor, so `c` can carry the pending first reminder.
- **Actual:** `a` is burned and its token contribution removed, but `c` has no reminder. The test first confirms that only `a` fired and that surviving mass remains above the minimum.
- **Cause:** `surviving_policy_state_tx` takes the latest surviving answer's entire snapshot. `b.policy_json` inherited `a`'s last-fire state. Removing `a` does not remove that copied state from `b`.
- **Clause:** D3.2: a burned answer never shifts cadence; A9 partial failure/timeout-after-commit; M3 burn-before-cadence acceptance.

### 9. Busy state sync commits engine state before refusing the provider inputs — should-fix

- **Test:** `review_state_sync_busy_refusal_does_not_commit_half_the_sync`.
- **Input sequence:** admit a host and ingest one hook; hold its conversation lock; send a state sync with generation 0, expected sequence 0, a new historian chain and `pass_complete: true`.
- **Expected:** a busy refusal must not durably apply only part of this synchronized pass; its chain/barrier and accepted engine sync must remain coherent.
- **Actual:** the response is `transient`, chain remains `[]`, but engine row version changes from `None` to `Some(1)`.
- **Cause:** `apply_module_state_sync` commits before `sync_provider_pass_inputs` tries the conversation lock. A refusal can therefore leave the ordinary sync applied while its model-chain/barrier update is missing. Retrying now encounters advanced durable state rather than the rejected request's original state.
- **Clause:** D2.3 state sync before hook/trigger eligibility; M3 chain storage and barrier acceptance; D3.8 synchronized-input requirement. The test proves the split commit, not every downstream recovery outcome.

### 10. A no-change barrier swallows a transport-generation change — blocking

- **Test:** `review no-change barrier does not swallow a module restart` (TypeScript).
- **Input sequence:** acknowledged unchanged watermarks and chain; no-append pass with `passComplete`; transport returns `connection_generation_changed` from that barrier call and updates the module generation.
- **Expected:** do not report an unchanged synchronized pass; handle the restart and resend synchronized inputs before closing the pass.
- **Actual:** returns `{status: "no_change"}` after the single obsolete-generation barrier. No retry or chain payload is sent.
- **Cause:** the new `noChange` helper ignores the call's result. The ordinary page-send branch explicitly recognizes and retries generation-change results.
- **Clause:** D2.3 state sync first; D3.8 complete synchronized inputs at the barrier; A6 module restart; M3 pass-complete acceptance.

### 11. Reusing a completed seed receipt skips this pass's barrier — should-fix

- **Test:** `review resumed completed seed still sends the current pass barrier` (TypeScript).
- **Input sequence:** force/resume a no-append sync with `passComplete: true`; inventory is valid; the content-addressed seed receipt reports `completed: true` in the current generation.
- **Expected:** reuse the seed data, but send this pass's content-free completion hint once.
- **Actual:** returns `acked` from the receipt branch with **zero** `state_sync` calls carrying `pass_complete`.
- **Cause:** receipt adoption returns before either the page-send or no-change barrier path. Seed identity contains the boolean, not a pass identity, so a previously completed seed is reusable on a later pass.
- **Clause:** ruled P4: completion is a scheduling hint, not an acknowledgement; D3.8; M3 barrier acceptance. Actual missed historian firing depends on the future M5 scheduling consumer; the current reproducible defect is the skipped hint, not a demonstrated missed model run.

## What checked out

The existing controls were rerun, not merely read:

- **Admission:** bind harness, not body harness, selects the host lane. Runner-bound declare/setup with host opt-ins refuse by field; mismatched host session refuses; both host opt-ins are required. P3 rejects empty and over-256-byte part IDs. `runner_groups()` remains `transcript_reads`. No body-field admission bypass was found in this surface.
- **Principal limit:** this pinned handler has no daemon caller-identity stamp. Its explicit pre-stamp bind trust is the accepted current direct-caller risk in the ruled D1 ledger, not proof of attested-principal enforcement. The same-session restriction is tested; future stamp enforcement still needs its own integration test.
- **Locks:** distinct conversations proceed while another is locked; same-conversation setup, step and background work wait on the same keyed lock. The map retains active/queued `Arc`s when evicting idle entries. No cross-conversation lock collision was found.
- **Promotion:** newest-held bounds and forward-only acknowledgment are enforced; only a new descent performs the transactional revert clamp. Omitted acknowledgment does not promote. Conflict validation precedes promotion/burn and failed writes roll everything back.
- **Part identity:** assistant text and two tool parts sharing a call ID retain independent answers. A retry burns just the named pending part. Distinct identical-text user mids do not collide.
- **New independent conflict control:** `review_conflict_is_side_effect_free_and_descent_burns_the_stranded_answer` passes: conflicting `y@1` does not promote stranded `x@1`; descent through 0 burns `x`; only `y`'s new tag becomes live after acknowledgment.
- **New independent restart control:** `review_pending_burns_and_unknown_subjects_are_idempotent_across_restart` passes: duplicated/unknown burns, a queued pending tag, reopening the temporary store and burning again leave zero live tags, zero queued drops and zero contributions. This does not contradict finding 8, which concerns an inherited cadence snapshot rather than subtraction idempotence.
- **Drop durability:** existing `provider_drop_consumption_is_atomic_with_engine_commit_and_never_requeues` passes. It injects transaction failure, checks queue/version preservation, then successfully consumes both engine/provider queues and checks repeated consumption. Queue consumption is transactionally attached to the engine CAS; finding 7 is eligibility accounting, not an observed split engine/provider consumption.
- **No-provider full-request path:** existing `non_provider_consumption_uses_namespace_index_and_changes_no_provider_rows_or_bytes` passes. For namespaces with no provider conversation, serialized engine state is identical and provider rows are untouched. The `transform.rs` M3 changes are visibility/documentation changes to shared helpers, not changed full-request algorithms. This is not an assertion about a provider-to-full-request exit with a retained provider row.
- **Broca:** existing declaration/hook golden, restart, observation and wait/ready controls pass. The existing simple host tag/overlay byte controls also pass; tag format and assistant imitation stripping were not found defective.
- **Unchanged sync:** the old no-change/chain-change, paging, sequence-adoption and seed-receipt controls all pass. The two new failures exercise branches those controls do not combine with `pass_complete`.

## Pass classes, ownership boundaries and limitations

- **Defer/ordinary append:** the hint, timestamp and Channel-1 findings affect first-serve bytes without needing a rebuild. Whole-message physical-tail eligibility is lost by the one-message helper call. A host record can freeze those wrong bytes permanently even though it preserves its own prefix perfectly.
- **Execute/fold:** the same wrong first-serve ops must be replayed on rebuilds, so matching a helper's template is insufficient for A3. Full engine execute/fold decisions themselves were not modified by this review.
- **Revert/conflict descent:** newest bounds, clamp, pending suffix burns and side-effect-free conflicts passed. The new cadence-snapshot failure is an additional burn-policy problem, not a failed ordinal clamp.
- **Restart:** store burn replay passes; state-sync transport restart is finding 10. Process-kill tests at all six fault points were not run; no live process/store was used.
- **Exit:** the host exit adapter and complete provider replacement rendering are later-slice work. No end-to-end exit byte identity is claimed here.
- **Gated wait:** `compaction.rs` at this tip still has the old incomplete-history scan/ready branch, without the answer-observation `more`/final-page gate; `execute` still uses the old codec/template. This is the work explicitly assigned to M4 (D3.3/D3.4/D3.7/D3.9), not a new M3-diff regression. Likewise actual off-path historian scheduling/VETO belongs to M5. **The M3 tip alone must not be treated as an enabled, complete host provider pipeline.** Existing runner wait/ready controls passed, but host no-scan final-page behavior has not yet been delivered and is not certified by those tests.

No live stores or config paths were opened, read, written or migrated. Rust fixtures use temporary `store.db` files; TypeScript uses an in-memory context DB and redirects data/log paths to temporary directories. No ARCHITECTURE, STRUCTURE, schema, manifests or lockfiles were changed.

## Reproduction and verification

Rust ran on the remote Linux worker with **cargo 1.99.0 (5f94df478 2026-08-27)** and **rustc 1.99.0 (b940084d7 2026-09-28)**. TypeScript tests used **Bun 1.4.2 (744846f84)**; typechecking used **TypeScript 5.9.3**.

| Command | Result |
|---|---|
| `cargo test -p mc-module --lib providers::step_transform::review_tests -- --nocapture` | Eight tests at the combined run: seven intended failures, independent conflict control passed. |
| `cargo test -p mc-module --lib providers::step_transform::review_tests::review_burning_an_earlier_answer_removes_its_inherited_cadence_effect -- --exact --nocapture` | Additional ninth test: intended cadence failure after all positive controls reached. |
| `cargo test -p mc-module --lib providers:: -- --skip providers::step_transform::review_tests` | 43 passed. |
| `cargo test -p mc-store --lib provider_log:: -- --nocapture` | 17 tests: 16 passed; only the new sibling-reclaimability test failed (`0` versus `20`). |
| `bun run --cwd packages/plugin test:serial src/hooks/magic-context/module-state-sync.test.ts src/hooks/magic-context/module-state-sync-review.test.ts` | 29 tests, 133 assertions: 27 old controls passed; the two review barrier tests failed as described. The script's frozen install checked 1,010 installs / 1,251 packages without changes. |
| `bun run --cwd packages/plugin typecheck` | Passed (three configured tsc projects). |
| `cargo fmt --check` | Passed with rustfmt 1.10.0-stable (b940084d7e 2026-09-28). |
| Package-local `node_modules/.bin/biome check src/hooks/magic-context/module-state-sync-review.test.ts` | Passed with Biome 2.5.1; one file checked, no fixes. |
| Installed `tsc -p packages/plugin/tsconfig.m3-review.tmp.json` | Passed: one review test and imports, using a temporary config extending the package config and including tests, which the normal config excludes. Temporary config removed after checking. |

The named failures are ordinary output/state assertions, intentionally committed red for the fixing owner; none is ignored or inverted to endorse M3's behavior. Intermediate fixture-control failures were corrected before accepting findings (candidate-pool selectivity, initial versus established protection, and warming the rendered memory head).

`move_inventory`'s known 96-versus-97 schema-pin failures are excluded from these package-scoped behavior runs and are not findings. A full workspace suite and full build were not rerun: this review changes only tests, module declarations and documentation, and the worktree arrived with the build already green. Scoped inspection remained partial (unavailable checkout call graph/Biome diagnostics and Rust analyzer check in progress); authoritative Rust compilation and tsc checks succeeded. New Rust files are rustfmt-formatted; the new TypeScript file is checked using the installed package-local Biome 2.5.1.
