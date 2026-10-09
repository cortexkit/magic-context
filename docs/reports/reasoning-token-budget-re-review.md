# Reasoning token budget: adversarial re-review

## Candidate, comparison and verdict

Reviewed **42cf8bb21fa4755004ac8349b6bbf4345bccfa8d**, including the seven first-round witnesses and the follow-up in `reasoning-token-budget-implementation.md`. This isolated review branch was advanced from the prepared master checkout to that exact candidate **before adding tests**. Master at review start was **41eedb38821dba886ce8ea1c65963eab54bf52f3**; their merge-base is **a33c2d87db6ce31d2a18265fbc83411a985130d1**. I used both `master...42cf8bb21f` (feature changes) and `42cf8bb21f^..42cf8bb21f` (the fixes); master-only work is not attributed to this change.

**Not safe to merge as-is.** The budget-only active-turn fix is correctly scoped, and the old TS/Pi witnesses now pass. However, unconditional absorption is still false for Rust's pre-unit legacy adoption path. More importantly, the fix changes an existing, legitimate partial-strip upgrade guarantee into an all-block removal on ordinary replay. The corresponding Rust change also widens a partial merged strip to the whole message, even for new decisions. These are not requests to pull issue 630's merged/proactive first-selection work into this branch.

This delivery contains only this report and regression tests. Product code is unchanged. New failing TS/Pi assertions are intentionally committed without repair. Rust runtime evidence is qualified separately below: the empty-summary witness passed, but the other requested filters and the two new Rust assertions have no captured runtime result.

Severity: **blocker** violates signed replay or unpriced byte stability; **should-fix** is a reproducible retention/scope regression; **note** is bounded adapter parity without evidence of a real provider rejection.

## Disposition of the seven original findings

### 1. Blocker — active Anthropic turn: closed for budget selection

The original TS and Pi tests named `review: issue 630 leaves all thinking in the active Anthropic turn unchanged` (Pi adds `in Pi`) pass unchanged. `active-anthropic-turn.ts:14-37` finds the last real user request, ignoring synthetic/context and tool-result carriers. The cutoff exempts every later assistant at `reasoning-budget.ts:212-219`; Pi does the same at `reasoning-replay-pi.ts:210-219`. Live postprocess explicitly supplies the route at `transform-postprocess-phase.ts:2603-2606`, so plaintext or empty thinking need not contain a signature to be recognized as Anthropic. The scalar cutoff is capped below the first protected tag, rather than relying on a single newest-assistant guard in removal.

Rust's isolated `transform/active_anthropic_turn.rs:3-31` checks the request's route/model and CK user boundary. The exemption is in `reasoning_budget.rs:49-53`, with defensive selection checks in `transform.rs:13809`, `:13983` and `reasoning_clear.rs:156`. There is no primary/subagent exception in the predicate. Rust runtime verification is not inferred from TS tests.

The boundary test `the Anthropic budget boundary ignores synthesized context and tool-result user carriers` also passes, including a real follow-up that closes the old turn. **Fresh merged and proactive/recovery strips are still outside this protection by deliberate scope.** The first review's demand to coordinate all lanes belongs to parallel issue 630, not an additional 620 fix. Frozen replay must not start withholding removals merely because the turn is now active.

### 2. Blocker — absorbing removals: only partially closed

The two original TS replay witnesses pass: `review: a saved removal never restores signed thinking when its message becomes exempt` and `review: a frozen merged-assistant strip never restores thinking on a host subset`. Whole-id replay no longer checks the latest assistant (`reasoning-removal.ts:199-216`), and exact merged-part replay no longer checks that exemption (`strip-content.ts:925-936`). With unchanged source blocks and ids, those removals remain absent when visibility changes. Existing provider/protected-payload guards remain; this is not a license to change provider metadata or stable ids after selection.

For **durable Rust units**, `active_reasoning_clear` and the native-mid reader now ignore suspension flags (`reasoning_clear.rs:196-202`, `:231-239`). Refresh clears the old reset rule, never creates a keep (`:29-44`). Age/merged removals override render exemptions (`transform.rs:14003-14025`), and those mids exclude conflicting native keeps (`:6985-7014`). The narrow original witness exercises durable-unit replay before and after refresh, not legacy adoption.

But `legacy_reasoning_exemption_changed` still explicitly prices **restoration** (`reasoning_clear.rs:270-304`, `transform.rs:5087-5095`). `new_reasoning_clear_units` rejects an already-cleared legacy mid when it becomes newest or an anchor (`reasoning_clear.rs:150-158`). A priced pass then retires the legacy evidence (`transform.rs:6976-6983`) and the native-keep lane can serve the original response. Thus there is a concrete path outside the fixed durable-unit predicate. **R1 below disproves the universal claim.** The original blocker is not fully closed just because its narrower witness has a new unconditional predicate.

### 3. Should-fix — per-step attribution: closed in live selection

`review: stored tool estimates charge each assistant's own reasoning exactly once` and its Pi control pass. The trigger was not only one displaced tool tag: parallel tools repeat preceding-thinking estimates, and mixed message/tool tags have different owners. Live costing now ignores the stored map entirely and estimates the actual kept parts of the assistant being priced (`reasoning-budget.ts:220-246`). Consequently none of those tag topologies can shift a tool estimate onto another step in this adapter. The DB helper excludes tool tags and deduplicates message-group estimates with `max`, not `sum` (`storage-tags.ts:705-730`).

The unused `textEstimateByMessageId` argument is now misleading but not a live double charge. DB-only compartment projections still have byte-based fallback logic (`compartment-trigger.ts:254-266`); this is not evidence that they know a tool-only step's reported provider cost. Do not describe that fallback as identical to host-message selection.

### 4. Should-fix — fallback/inline calibration: closed

`review: bust selection applies frozen prose calibration to unstored thinking estimates` passes. Its historical-context adjustment is reasonable: a test of historical removal must not simultaneously assert that active-turn steps are removable. The expectation and frozen model calibration remain intact.

Postprocess now supplies the frozen ratio (`transform-postprocess-phase.ts:2601`), which applies once to live typed plaintext and once to the separate inline group (`reasoning-budget.ts:242`, `:246`). Stored values are already calibrated, but are no longer consumed by this live adapter, so they cannot apply the ratio a second time. The new boundary control `re-review control: exact merged parts charge the retained sibling with calibration exactly once` passes: the exact calibrated cost fits, one token less does not, a grossly inflated pre-calibrated DB map is ignored, and costing leaves the input array byte-identical.

### 5. Should-fix — frozen merged-part budget accounting: closed for exact TS decisions

`review: merged-assistant frozen strips cost zero on the next budget rebuild` passes. Postprocess passes persisted merged decisions before selection (`transform-postprocess-phase.ts:2602`). A private parts-array copy replays their exact selection before checking reasoning presence or charging reported/text costs (`reasoning-budget.ts:221-235`); it does not mutate the served array during costing. An entirely stripped step is zero even if its old report is 20,000. The new boundary control also proves that an unstripped sibling is neither free nor charged twice.

A positive report on a partially retained group still prices the step using its original report, not a block-by-block apportionment. That is the documented per-step reported-count proxy (`docs/designs/reasoning-token-budget.md:102-106`), not a newly demonstrated calibration bug. No live billing measurement was made. The bare-id and Rust whole-message replay changes are different defects, R2/R3 below; zero costing is not a justification for deleting a previously kept sibling.

### 6. Should-fix — Rust provider aliases: source fix closes the trigger; runtime unavailable

`config.rs:278-283` now uses `tool_catalog::model_key_candidates`, not the literal-provider TTL resolver. The shared candidate generator (`tool_catalog.rs:932-970`) covers canonical/native spellings at every exact/base/wildcard specificity, before default. This addresses both the alias collision (OpenAI 250 versus Codex 500) and a canonical-only Google wildcard (750). The TS control still passes. The exact original Rust filter and its execution status are in the Rust gate ledger below; a source inspection is not a passing Rust test.

### 7. Note — empty ordinary summary with positive reported usage: Rust source fixed; Pi edge remains

Rust now records declared typed-part presence (`reasoning_budget.rs:61-76`), does not return early for an empty body alone (`:103-105`), and reads positive reported usage before text fallback (`:106-122`). The original TS control still returns cutoff 2 for three 100-token steps at budget 200. The exact original Rust filter and execution status are below.

The original Rust filter passed on Linux (one test), closing the original **TS/Rust** discrepancy; it does not establish three-host parity. Pi still discards an empty unsigned ordinary thinking part before consulting positive usage. R4 supplies a captured failing Pi witness. This is an inherited edge in the initial budget adapter, not a regression introduced by the follow-up's active-turn changes.

## Remaining/new findings and committed witnesses

### R1. Blocker — Rust legacy re-exemption still resurrects signed blocks

**Trigger:** load the repository's pre-fix fixture DB, where `already` was served cleared but has no durable clear unit; before adoption, omit `old` and `multipart-user`, making `already` the newest assistant. No source mutation, provider change, or id reuse is needed.

**Path:** `reasoning_clear.rs:272-304` recognizes this exemption change, `transform.rs:5087-5095` prices it, `reasoning_clear.rs:155-158` skips the clear, and `transform.rs:6976-6983` retires the legacy arm on that priced pass. The unchanged baseline test `reasoning_clear_legacy_reexemption_prices_restoration_before_unit_adoption` still positively asserts `thinking-already` comes back (`reasoning_clear_gate_tests.rs`, originally lines 568-595 at 42cf8bb21f).

**Committed witness:** `re_review_legacy_reexemption_never_restores_an_already_served_signed_block` in `reasoning_clear_gate_tests.rs`. It first proves the recorded pre-upgrade native bytes omit `thinking-already`, uses the same real fixture/codec/native attachment path, then requires it to remain absent. Source predicts failure: `legacy re-exemption restored the original signed thinking-already block`. Runtime status is in the ledger; no captured red is claimed unless it ran.

**Required fix:** preserve the observed legacy removal on re-exemption as well as durable-unit removals. A priced restoration is still a restoration under the supplied signed-block rule. Do not silently invert the old legacy test without documenting this contract change.

### R2. Blocker — upgrading a bare partial merged id first-strips a kept sibling on replay

**Trigger:** canonical Anthropic history with a single historical assistant `[signed thinking A, text, signed thinking B]` and a pre-existing bare frozen merged id. Before upgrade, its stable output is `[A, text, empty sentinel]`. The session never set `keep_reasoning_tokens`, the layout did not change, and no rebuild permission is supplied. Replay after the fix serves `[empty sentinel, text, empty sentinel]` instead.

**Location:** `strip-content.ts:938-957` now removes *every* reasoning block for bare ids, rather than replaying the old partial layout. Final representation invokes this frozen replay independently of new-detection permission (`transform-postprocess-phase.ts:1820-1827`, `:3661-3667`). A frozen message id proves some block was removed; it does not prove its first block was removed.

**Captured failing test:** `re-review: a legacy partial merged strip preserves its already-served first block on upgrade` in the new OpenCode re-review file. Expected `kept first` plus `sig-first`; received an empty text sentinel for that block. The second block remains a sentinel in both representations, so this assertion does not ask to restore anything.

**Required fix:** retain the prior representation until an already-priced migration/first selection can freeze sufficient part-level evidence, while preventing resurrection of the actually removed blocks. Conservatively removing more signed bytes can prevent resurrection, but silently changes a defer prefix and is not cache-neutral. This matters for sessions omitting the new key.

### R3. Should-fix — Rust merged replay now removes the first block its planner kept

**Trigger:** an older first-in-run assistant with two interleaved signed reasoning blocks, followed by a real later user request and a newer assistant; enough budget to keep all reasoning. On a priced pass, the existing merged planner selects only the second block. The new replay treats its bare message flag as an all-reasoning removal, deleting the first block too.

**Location:** `new_merged_reasoning_strip_units` still uses the partial serializer rule (`transform.rs:15111-15119`, `:15619-15635`), but `remove_frozen_historical_reasoning` now treats `strip:merged_reasoning:<mid>` as a whole-message removal (`:14009-14020`), before serializer residual replay (`:16145-16167`). This widens fresh merged stripping as well as old replay, despite the stated decision to leave that lane's selection policy unchanged. The cost adapter's zero-for-the-whole-mid behavior then conceals the removed sibling rather than fixing partial accounting.

**Committed witness:** `re_review_merged_strip_keeps_the_first_thinking_block_on_its_first_priced_pass` in `reasoning_clear_tests.rs`. It exercises `transform_with_projection`, verifies a real merged unit was minted and the second block is absent, then requires `thinking-old` to survive. Predicted failure: `merged replay also removed the first thinking block that its planner kept`. Runtime status is in the ledger.

**Required fix:** freeze/replay the actual merged-part decision instead of turning any merged flag into an age-style all-block removal. Treat replay absorption and fresh selection as separate requirements. No permission to redesign issue 630's lane is implied by this finding.

### R4. Note — Pi still ignores positive reported usage for an empty unsigned summary

**Trigger:** three ordinary typed thinking steps, each with empty plaintext, no signature/native metadata and `usage.reasoning: 100`; budget 200. TS and the repaired Rust contract select cutoff 2, while Pi selects 0.

**Location:** `reasoning-replay-pi.ts:229-248` computes no text/opaque cost and returns before reading `usage.reasoning`; `:251-259` likewise requires text or opaque presence. This is the same declared-part/report precedence edge as original finding 7, now exposed in the third host.

**Captured failing test:** `re-review: Pi charges positive reported reasoning even when its ordinary summary is empty` in the new Pi re-review file — expected 2, received 0. This is synthetic parity evidence, not a demonstrated real provider billing/rejection trace. Decide a common interpretation; do not claim universal host parity while the report precedence differs.

## Were the changed tests pinning legitimate behavior?

- `replay skips the newest assistant with replayable content, as Rust does` was changed to absorption in `reasoning-removal.test.ts:1161-1166`. Its saved ids explicitly select the newest assistant. Under the supplied absorbing contract, skipping it would restore the original signed block. Changing this expectation is a justified, documented contract correction; selection must protect active/latest steps **before** they enter the saved set.
- The exact-part replay assertion in `strip-content.test.ts:1419-1424` was similarly a genuine restoration exception: a persisted exact part must stay absent when its assistant becomes exempt. Changing that assertion is justified.
- **Not all changed expectations were restoration exceptions.** `preserves the pre-deploy bare-id partial-strip bytes` was renamed to `keeps legacy bare-id removals absorbing when no exact part selection exists` (`strip-content.test.ts:1356-1372`). Its unchanged layout had a legitimately retained first block and a removed second block. Requiring both to disappear erases a byte-preservation guarantee, not a resurrection guarantee. R2 recreates the deleted claim as a red assertion without weakening the absorption tests.
- The Rust gate suite still contains both legacy restoration and the durable suspension/re-exemption expectations (`reasoning_clear_gate_tests.rs`, originally `:358-424`, `:568-595`). The latter's expected `reasoning_exemption_repair`/restored bytes are inconsistent with the repaired durable predicate; the former describes the still-live R1 path. A green run of the three selected witnesses is not evidence that this broader suite agrees with the new contract. These tests were not rewritten in this review.

## Verification, acquisition boundary and Rust gate ledger

Live-store rule, verbatim: never open, read, write or migrate the live stores (`~/.local/share/opencode/*.db`, `~/.local/share/cortexkit/magic-context/{context,store}.db`, `~/.config/opencode/*`, `~/.config/cortexkit/*`).

No OpenCode/Pi/module host process, provider request, acquisition script or migration was launched. Tests use in-memory or repository fixture/test-temporary stores. Package commands unset `OPENCODE_DB` and use throwaway `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME`, `MAGIC_CONTEXT_STORAGE_DIR`, and `MAGIC_CONTEXT_LOG_PATH` below `${TMPDIR:-/tmp}/magic-context/bg_99e6bce36be1e9e1/`. There is no host PID for an `lsof` proof; no prior implementation-report PID is presented as this review's proof. A future host run must additionally set `OPENCODE_DB` under that root and prove its open stores with `lsof`.

- Bun **1.4.2**, TypeScript **5.9.3**. Original witnesses plus active-turn and changed replay controls: **134 passed, 0 failed, 3,791 assertions**, six files. Command: `BUN_JSC_useOMGJIT=0 bun test --timeout 30000 packages/plugin/src/hooks/magic-context/reasoning-token-budget-review.test.ts packages/plugin/src/hooks/magic-context/reasoning-removal.test.ts packages/plugin/src/hooks/magic-context/active-anthropic-turn.test.ts packages/plugin/src/hooks/magic-context/strip-content.test.ts packages/pi-plugin/src/reasoning-token-budget-review.test.ts packages/pi-plugin/src/reasoning-replay-pi.test.ts`.
- New TS/Pi re-review files: **1 passed, 2 intentionally failed, 6 assertions**, three tests. Only R2 and R4 fail; the calibration/exact-sibling/input-immutability boundary control passes.
- `bun run --cwd packages/plugin typecheck` and `bun run --cwd packages/pi-plugin typecheck` pass (three and two `tsc` invocations respectively). No product bundling or full package test run is needed for this tests/report-only delivery; the prepared build belongs to the initially prepared master base, not proof of the reviewed candidate.
- Biome **2.5.1** checks the two new TS files with their package-local installed command/config. AFT inspection is **PARTIAL** (checkout graph unavailable; Biome producer unavailable), so authoritative local TypeScript/Biome commands, not an empty diagnostic count, supply TS verification.
- Rustfmt **1.10.0-stable** parses both modified include files. Read-only formatting checks expose existing mixed-edition formatting differences in unchanged assertions; unrelated reformatting is not committed. This is syntax/formatting evidence, not a Rust typecheck.
- The first Linux Bun attempt lacked `zod`/`@cortexkit/subc-client`: **60 pass, 4 import errors**, not witness outcomes. Authoritative Bun/typecheck gates use the prepared local installation; no manifest/lockfile/install change was made.

Rust uses Cargo **1.99.0**, rustc **1.99.0**, `CARGO_BUILD_JOBS=2`, preserved compiler/cache homes, and isolated application roots. All requested attempts were sequential background commands with 30-minute timeouts, explicitly watched before proceeding. **I could not obtain runtime results for the first two witnesses.** The ledger is:

| Exact command (all append `-- --nocapture`) | Result |
| --- | --- |
| `cargo test -p mc-module --lib review_reasoning_clear_never_restores_a_frozen_block_on_exemption_change` | Initial Linux attempt failed during `libsqlite3-sys` bindings-copy permission setup (exit 101, zero tests). Local retry timed out after 30 minutes (exit 124, zero tests), repeatedly queued behind all six occupied compile slots. A final Linux retry, after the third witness established a writable target, ended with `remote outcome_unknown; never rerun`. **No runtime pass/failure can be claimed.** |
| `cargo test -p mc-module --lib review_reasoning_budget_aliases_follow_the_shared_canonical_first_lookup` | Local attempt timed out after 30 minutes (exit 124, zero tests), again waiting behind the six shared compile slots. **Not executed.** |
| `cargo test -p mc-module --lib review_reasoning_budget_reported_count_survives_an_empty_summary` | Linux with a fresh writable `CARGO_TARGET_DIR=/tmp/magic-context/bg_99e6bce36be1e9e1/cargo-target` completed in 66 seconds, compiling the final test sources. **1 passed, 0 failed, 1,679 filtered out**, exit 0. |

The fresh Linux target avoided the original bindings-copy permission failure; it did not bypass the test. After the final absorption attempt lost its outcome, a remote process-status query itself lost transport (`subc transport: timed out after 120s`). That query supplied no proof of completion, so the outcome-unknown command was not repeated and no further remote builds/tests were launched. A `runon:linux` plus `sandbox:host` attempt was refused before dispatch and is not a test result. There are no concurrently launched local Rust builds or unattended local tasks.

The two new Rust witnesses **compiled in the successful third-filter run but were not executed**. R1/R3 are source-derived failures, not captured red results. Their assertions follow real transform/native fixture paths and deliberately oppose the live legacy-restoration claim and the newly broadened merged removal respectively. They still require explicit execution before claiming the review's Rust regression gates have run.

Merge gates also need `cargo test -p mc-module --lib re_review_ -- --nocapture` and the existing `reasoning_clear_` suite, reconciling obsolete restoration expectations explicitly rather than treating a filter-only green result as full coverage. Full live acceptance, historical billing replay, interactive doctor/dashboard runs and issue 630 integration are outside this report's execution scope.
