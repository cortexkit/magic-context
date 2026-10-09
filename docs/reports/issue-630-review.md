# Issue 630 adversarial review

## Verdict: **not safe to merge**

The active-turn protection fixes the demonstrated tool-loop stripping, but the delivery has four reproducible contract gaps. This review changes **only tests and this report**, not product code. Eight new assertions fail on the delivery; the three other new controls pass. In particular, the new 95% refusal rejects primary sessions that current master serves without changing their bytes, and Pi does not successfully restore rejected legacy thinking in either replay order.

### Provenance and safety

- Reviewed delivery: `2727994a166fc534dc15a5dcd9842eab57ec24b7`, including its ten commits and `docs/reports/issue-630-latest-turn-thinking.md`. Reviewed the progression from the WIP/reclaimed prototypes through selective deferral, OC2 recovery arming, and the final Rust native-keep change; did not treat the report's superseded provisional results as final gates.
- Current master: `30f43e7f03bdd485f5f5f750590efeac3af2ac99`. This review branch starts at the delivery tip, as requested. Master was archived **inside this worktree** for the baseline differentials, using its own product sources and fixture files. The temporary archive was removed after testing.
- Issue 620 comparison: `1da27807d5` on `alfonso/task/bg_1aa2a2de119894ed-issue-620-implement-keep-reasoning-tokens-10k-de`.
- Live-store rule: **never open, read, write or migrate the live stores (`~/.local/share/opencode/*.db`, `~/.local/share/cortexkit/magic-context/{context,store}.db`, `~/.config/opencode/*`, `~/.config/cortexkit/*`).** No real OpenCode/Pi host or daemon was launched in this review. Package unit suites used throwaway `HOME`/XDG roots and did not export `OPENCODE_DB`; fixtures use in-memory or temporary databases. Thus this review makes no new real-host/lsof containment claim. A remote lsof attempt was unavailable (`/proc/mounts` absent); it is not counted as proof. An initial nonportable `/private/tmp` setup failed on Linux and is not counted as a verification gate; subsequent scripts used `/tmp` with `set -e`.
- Rust gates requested Linux with 1,800,000 ms timeouts. They ran one heavy build at a time, with blocking waits as required by the worker guide; the runner occasionally fell back to macOS after the remote compile queue timed out. These were unit filters, not locally launched host binaries.

## Findings

### 1. P1 — the 95% check is a refusal policy expansion, not merely fail-closed protection of a held edit

**Trigger:** an Anthropic turn retains a signed block, reported usage is 95%, and no reduction occurs. Neither a queued unsafe edit nor evidence that the outgoing request exceeds the window is required.

- TS: `packages/plugin/src/hooks/magic-context/transform-postprocess-phase.ts:4172-4179`.
- Rust: `crates/mc-module/src/transform.rs:7408-7413` (the `usage_percentage >= 95.0` / retained-thinking / no-applied-reduction condition).
- Contrast Pi: `packages/pi-plugin/src/context-handler.ts:7471-7479` additionally requires a pending operation whose target is thinking-drop-protected.

**Failing tests committed:**

- `review issue630 v1 95 percent without unsafe work still serves a fitting unchanged turn`
- `review issue630 v2 95 percent without unsafe work still serves a fitting unchanged turn`
- `transform::tests::review_issue630_rust_primary_95_without_unsafe_work_still_serves`
- `transform::tests::review_issue630_rust_subagent_95_without_unsafe_work_still_serves`

The first two are in `packages/plugin/src/hooks/magic-context/issue-630-review.test.ts`; the latter two are in the Rust transform test module. The fixture has just one signed response and no pending operation. It is not a middle-thinking removal or the reported merged-strip bug. The baseline package tests assert unchanged served JSON, rather than merely a successful call.

**Measured differential:** the same two TS fixtures and two Rust fixtures **all pass on current master**. All four refuse on the delivery (`ANTHROPIC_LATEST_TURN_FULL` / `Err(AnthropicLatestTurnFull)`). The Pi no-held-work control passes at 95%. A reading of 95,000/100,000 alone still leaves 5,000 tokens before that denominator; it is not a provider overflow receipt or a measurement of the final request. The synthetic fixture deliberately separates usage evidence from the small final request, as the supplied tests do.

The supplied held-drop tests pass at execute/force (76% and 85%), retain their queue, refuse at 95%, and release after a real user. That proves the chosen guard, not its necessity. It is correct to refuse an **unsafe edit**; it is not necessary to refuse sending the unchanged, fitting turn solely because the edit was held. Do not generalize that fixture into a universal 95%-usage refusal. Preserve the existing final-wire fit/overflow refusal policy and hold unsafe edits separately.

### 2. P1 — Pi recovery loses or re-removes the available original

**Trigger:** persisted `binding_mismatch:a` omitted an active-turn block; the provider rejects that omission; Pi's next context pass is supposed to restore it.

- Legacy start order: `packages/pi-plugin/src/context-handler.ts:2664-2674` applies frozen strips **before** `prepareLatestThinkingRecovery` at `:5474`. The raw original existed in the incoming context but was already deleted when the recovery check inspected it.
- End order: `context-handler.ts:3782-3792` applies `applyPiThinkingBindingRecovery` **after** `runPipeline` restored originals at `:7470`. `packages/pi-plugin/src/provider-error-recovery-pi.ts:254-257` still unconditionally strips every frozen entry, including an active entry being restored.

**Failing tests committed** in `packages/pi-plugin/src/issue-630-review.test.ts`:

- `review issue630 Pi start legacy strip order restores the rejected active turn` — throws `[missing-original:a]`, despite supplying the signed raw original.
- `review issue630 Pi end legacy strip order restores the rejected active turn` — returns a request missing `signed-2`; `signed-3` remains. That next provider call repeats the rejected omission.

Both use explicit branch entry ids and the real registered Pi context handler, not just the pure flag helper. Before arming, both verify the legacy omission, so the test really reaches the frozen replay path. The fix must capture/check originals before start-order replay, and exclude restored active entries from end-order replay. Keep older-turn frozen omissions intact.

This is not an unbounded-loop proof: after a second rejected restoration the shared state machine quarantines the turn. It is a failed restore-once-and-retry implementation, followed by refusal rather than successful recovery.

### 3. P2 — the first recovery arm is not tied to the rejected user turn

**Trigger:** the rejection is armed, a different real user message arrives before the first recovery pass, then that new turn has signed thinking.

- `packages/plugin/src/hooks/magic-context/latest-thinking-recovery.ts:26-37` records only the unanchored `latest_thinking_original` sentinel initially.
- `:103-127` discovers and persists the anchor from the **next pass**, not the rejected request. The anchor mismatch check works only after an anchored attempt already exists.

**Failing test committed:** `review issue630 recovery cannot bind a rejection to a later real user turn`, in the plugin review test file. `prepareLatestThinkingRecovery` returns `restore:true` for `next-u`, even though the 400 preceded that real user message.

The test proves wrong-turn restoration authorization, not an observed real-provider resurrection. A delayed error/resume can nevertheless make the override protect/replay thinking from a turn other than the rejected one, including bypassing that turn's frozen omissions. Record the rejected request's stable user anchor when arming, or carry an equivalent request identity; do not assign it to whichever turn happens to rebuild next. This shared helper affects TS, the Rust adapter, Pi and OC2's event arming.

### 4. P1 — Rust omits TS's explicit Anthropic-metadata route evidence

**Trigger:** a custom route uses provider `custom`, model `renamed`, and its OpenCode reasoning blocks carry `metadata.anthropic.signature`. The TS delivery already has this exact family-inference control.

- Rust family test: `crates/mc-module/src/transform/active_anthropic_turn.rs:4-15` checks route/model strings only.
- Removal selection: `crates/mc-module/src/transform.rs:13973-13983` therefore selects the older active assistant's reasoning as an ordinary age removal.
- TS recognizes the signature metadata at `packages/plugin/src/hooks/magic-context/latest-assistant-turn.ts:60-66`; its supplied `tool results and request shells do not end thinking on Anthropic-family serializers` test passes for `custom`/`renamed`.

**Failing test committed:** `transform::tests::review_issue630_rust_metadata_route_keeps_all_active_thinking`. It decodes genuine OpenCode-shaped parts through the codec, then runs the production removal selector. Actual selected set: `{"a1"}`. Expected: empty, because both signed responses follow the same real user request. This is an uncovered existing stripping lane, not a new 95% symptom. The issue-620 predicate is byte-identical, so reconciling the two branches must fix the shared inference rather than introduce a second boundary helper.

## Exact pinned-byte audit (hard check 1)

`compact_projection_multi_pass_served_bytes_match_baseline` hashes **CK plus native output**, not only the eventual Anthropic HTTP body. Actual current master and the neutralized active-turn mutant both produce the old pass-3 hash; the delivery produces the new one.

| Pass | Current master bytes/hash | Delivery bytes/hash | Permission |
| --- | --- | --- | --- |
| 0 | 1407 / `44e6c96d…` | identical | HARD initial render |
| 1 | 2093 / `48be7560…` | identical | SOFT+ |
| 2 | 3293 / `0545fea1…` | identical | SOFT+ |
| 3 | 5450 / `b7405b3032dd3b08e721edc579173ac316385a80d626f7937173a9b084cbe217` | 6030 / `bc265068c217dc390b2e46cb9696a23ac576694c8f914daad3e2df383c5e7c3e` | HARD: `priced-config-change` |
| 4 | 6218 / `cb4609b3…` | 6890 / `b368b9a8…` | HARD: historian publication |

The pass-3 delta is exactly **+580 UTF-8 bytes**:

1. In CK `step-1.content[0]` and `step-2.content[0]`, the 34-byte bare empty text block becomes the original 311-byte signed reasoning block: **+277 each**. The restored `kind` has `type:"reasoning"`, `text:"adaptive step N\n雪"`, `signature:"signature-N"`. Its restored extras are `_cortexkit_codec:{blockIndex:0,nativeIndex:0,decodedFingerprint:…}` plus `opencode.metadata.anthropic.signature`. The fingerprints are `210d750442b75dd1f6c64773390da4a0813a960c8d9ce3daeddd3d6d33271e1e` and `1ce25cbe665d60384091f443667cdc2d9edc224266dc73ed8192f22b194fc400`.
2. In native `step-1.parts[0]` and `step-2.parts[0]`, the old 78-byte `{metadata:{anthropic:{signature:"signature-N"}},text:"",type:"text"}` becomes the 103-byte original reasoning part with `text:"adaptive step N\n雪"` and `type:"reasoning"`: **+25 each**. Metadata is unchanged.
3. Native keeps retain the **whole original vector**, not just thinking. `step-1` tool output loses `§3§ ` and its text loses `§4§ `; `step-2` loses `§5§ ` / `§6§ ` respectively: **−6 bytes each**, total **−24**. Their remaining strings are exactly `done N\n"quoted"` and `answer N`.
4. No other pass-3 fields change: `2×277 + 2×25 − 4×6 = 580`.

Thus the report's explanation is incomplete if read as “only thinking bytes changed”: the native tag prefixes change too. However, **this pinned hash change is not a defer-pass upgrade blocker**. It occurs on a priced HARD pass inside one uninterrupted thinking turn and corrects an invalid old representation. The two unpriced passes retain all three old pins byte-for-byte. The native-keep release itself remains behind `is_provider_prefix_mutation_pass` (`transform.rs:6980`); new merged-strip choices remain rebuild-gated.

No defer-pass byte drift was found in the tested legacy/older-turn lanes. The 68-test Rust reasoning filter includes legacy CK/native migration, subset ingress, missing/stale fingerprint, native-keep collision, merged replay after restart, and fallback-served demotion controls. TS reasoning-removal's 39 controls include persisted omission replay and legacy `[cleared]` bytes until a rebuild. Accepted legacy recovery remains unarmed. This is bounded fixture evidence, **not a claim that every possible stored session was exhaustively enumerated**. The refusal regression in finding 1 is independently blocking even though it is not a served-byte mutation.

## Recovery control 6: reachable and necessary, not redundant

Added `review issue630 recovery restores an envelope after an already frozen tool drop`. It supplies a signed original, a persisted thinking omission, and a frozen tool drop, then arms recovery. With the delivery it restores the tagged original output `§2§ spent` and its signed thinking. The control `review issue630 envelope restoration leaves historical thinking omitted` verifies restoration does not change the earlier turn.

Removing both in-pass `args.restoreLatestTurnOriginals?.()` calls (`transform-postprocess-phase.ts:1069` and `:4171`) now makes **only the envelope test fail**: actual tool output is `[dropped §2§]`, expected `§2§ spent`. The historical-thinking control stays green. Thinking-only fixtures stayed green in the worker's control 6 because protected-message replay already keeps their thinking; they did not exercise restoration of destructive non-thinking envelope edits.

The anchored normal recovery path is durable; a second rejection produces `latest_thinking_original_unavailable:<anchor>` and refuses locally. The supplied quarantine test passes. A later different real user clears an already anchored attempt. Finding 3 is the gap before that first anchoring; finding 2 prevents Pi from reaching a successful restored replay.

## Active-turn definition and issue 620 integration (hard checks 4–6)

- The two advertised files really are new at the delivery, not present on current master. `git diff` against issue 620 for just `active-anthropic-turn.ts` and `transform/active_anthropic_turn.rs` is **empty**. There are no invented compatibility shims in this review.
- `latestAssistantTurnStart` derives membership from the TS predicate; Rust `protected_thinking_turn_mids` derives it from the Rust predicate. Real user boundaries release the turn; tool-result carriers and metadata-only assistant shells do not. The supplied TS boundary test and latest-turn controls pass.
- Known definition disparity retained in both branches: TS treats a user with an empty parts list as a real boundary; Rust's vacuous `all(ToolResult)` rejects that empty row as a boundary. They also have different host synthetic/ignored representations. The custom signature-metadata mismatch is the executable finding above. Identical source between branches does **not** establish TS/Rust semantic parity.
- The predicate files merge cleanly, with one definition per language. The **branches do not merge cleanly overall**: a read-only `git merge-tree --write-tree` reports eight conflicts: Rust `transform.rs`, the E2E manifest and validator, Pi `reasoning-replay-pi.ts`, and plugin `reasoning-removal.ts`, `strip-content.ts`, `transform-index-staleness.test.ts`, and `transform-postprocess-phase.ts`. Reconcile budget-selection gates with active-turn first-selection protection; preserve frozen replay semantics, not just either side of the textual conflicts.
- Signed-history controls pass: an oldest contiguous reasoning prefix can be removed; selection stops at a retained older block rather than making a middle hole. Earlier text/output edits are withheld before retained active signatures on prefix-bound models. The supplied primary Sonnet 5 test applies safe older/output edits, while Sonnet 5.5 holds them and releases them after a real user. This is not a global “freeze all primary operations” implementation.
- OC1/OC2 share `createTransform`; the v1/v2 selective fixtures and both new 95% witnesses exercise its store-generation lanes. OC2 separately subscribes to `session.error` / `session.execution.failed` and calls `armLatestThinkingRecoveryFromError` at `packages/plugin/src/v2/hooks/context.ts:1141-1153`. The error parser/family arming unit test passes. **No actual OC2 host retry was run**; a store-generation fixture is not evidence of the live payload/event lifecycle. The delivery report's real-host evidence is OC1 only. Pi's executable recovery mismatch already defeats the claimed host parity.

## Verification and mutation ledger

Tools: Bun **1.4.2**, TypeScript **5.9.3**, Cargo **1.99.0**, rustfmt **1.10.0-stable**, Biome **2.5.1**.

- Delivery unit review suites: **3 passing controls / 8 expected failing witnesses** (TS 2/3, Pi 1/2, Rust 0/3). Failures are deliberately retained; no production fix or old test expectation was changed.
- Combined thinking/boundary/provider recovery unit run: **31 pass / 5 fail / 126 assertions**, 36 tests in 7 files; the five failures are the same TS/Pi review witnesses. Final separate runs after type-only fixture cleanup reproduce TS 2/3 and Pi 1/2.
- `bun test packages/plugin/src/hooks/magic-context/transform.test.ts -t 'Anthropic task|primary claude'`: **4 pass / 38 assertions**.
- `bun test packages/plugin/src/hooks/magic-context/reasoning-removal.test.ts`: **39 pass / 110 assertions**.
- `cargo test -p mc-module --lib reasoning -- --nocapture`: **68 pass**.
- `cargo test -p mc-module --lib latest_thinking -- --nocapture`: **2 pass** after restoring mutants.
- `cargo test -p mc-module --lib compact_projection_multi_pass_served_bytes_match_baseline`: **1 pass** after restoring mutants; archived-master equivalent also **1 pass**, with the old pins above.
- Archived-master 95% witnesses: **2 TS pass / 2 assertions**, **2 Rust pass**; their product-source snapshots were current master, not a proxy import of the delivery.
- Both repository package `typecheck` scripts pass. Their configs exclude tests, so additionally checked the two new review test files with temporary configs extending each package's config (no exclusions; Pi adds installed `node`/`bun` types). Both narrow `tsc --noEmit` checks pass. Temporary configs were removed. Fixed fixture excess-property typing, not product behavior.
- Narrow installed Biome checks: **1 plugin file + 1 Pi file**, no diagnostics. `cargo fmt --check`: pass. `aft_inspect`: partial/unavailable analysis (no authoritative files; Biome analyzer unavailable); not represented as a clean diagnostic gate.
- Full package/workspace suites, packaging rebuilds, and new real-host runs skipped: this is a test/report-only review with targeted executable counterexamples; the reviewed delivery is not being certified as a product release.

All mutations used a staged live state, an empty unstaged diff before mutation, a nonempty diff while applied, and `git checkout -- <path> && touch <path>` followed by an empty diff after restoration. Mutants carried `NON-VACUITY BREAK` and were never committed.

| Control | Named red test / unaffected control | Applied / restored diff |
| --- | --- | --- |
| Release native keeps on priced passes as before | `tests::compact_projection_multi_pass_served_bytes_match_baseline` alone red; intermediate pass-3 hash `91e16dc0…`, 5846 bytes. CK is still protected, so this alone does **not** recover the old pin. | `transform.rs`: 1 file, +3/−6; then empty |
| Neutralize `protected_thinking_turn_mids` | Same sole red test; **old pinned `b7405b30…`**, 5450 bytes, recovered exactly. | `transform.rs`: 1 file, +3/−18; then empty |
| Omit both in-pass restoration calls | `review issue630 recovery restores an envelope after an already frozen tool drop` red; `review issue630 envelope restoration leaves historical thinking omitted` green. | `transform-postprocess-phase.ts`: 1 file, +2/−2; then empty |

**Merge recommendation:** fix findings 1 and 2 before any merge; tie recovery to the rejected request/turn and make custom Anthropic route inference consistent while reconciling issue 620. Then rerun the committed red witnesses and an isolated actual OC2 recovery test. The old pinned hash on its own is not grounds to reject the correct priced-pass thinking protection, nor grounds to bless the unrelated 95% refusal.
