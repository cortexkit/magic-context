# Latest assistant-turn thinking: issue 630

## Diagnosis recorded before the product changes

The issue body was read in full. The last visible child request is at 76.0%, `decision=execute`, TTL 5m. All the visible `final representation` counts are zero; the excerpt stops before the post-`ctx_reduce` transform. There are no visible pending-operation lines. **The excerpt alone does not identify a drop or prove that a pending operation ran.** The error is a latest-turn immutability error, not the newer prefix-binding error (`bound to a different conversation`).

The hypothesis is supported by the current provider documentation, retrieved 2026-10-07:

- https://platform.claude.com/docs/en/build-with-claude/thinking#thinking-with-tool-use: “A tool-use loop is one assistant turn.”
- https://platform.claude.com/docs/en/build-with-claude/thinking#preserving-thinking-blocks: tool results are user messages but continue the same turn. Pass every thinking block back complete and unmodified. The latest turn's consecutive thinking sequence must match the original responses, including redacted thinking.
- https://platform.claude.com/docs/en/build-with-claude/preserved-thinking#what-counts-as-an-edit: shortening a tool result or editing a tool-use input invalidates every later prefix-bound signed block. Removing a middle thinking block also invalidates later blocks.

The native matrix in `packages/e2e-tests/src/live-providers/thinking-matrix-live.ts:114-145` deliberately finishes tool rounds and adds real user text before testing history trimming. It is **not** evidence for editing a single uninterrupted subagent turn. `docs/reports/anthropic-open-tool-round-thinking.md` records accepted removals on Fable 5.1 and Opus 5.5 on one OAuth account. That limited, model/account-specific evidence does not override the documented rule or establish permission on Vertex Sonnet 5. The older proactive strip comments incorrectly generalized it to every open turn.

### Failing-first real-host experiment

`packages/e2e-tests/tests/latest-turn-thinking.test.ts` launches OpenCode **1.18.30**, with the real `task` tool creating a child, and a Messages mock whose expected thinking comes from its **responses**, not the client's replay. Negative controls reject edited, missing, reordered, and wholly removed thinking and redacted-thinking blocks across tool results. A new real user message releases the turn. Each host uses a unique root under `$TMPDIR/magic-context/issue-630/`, with all XDG homes, HOME, OPENCODE_DB and MAGIC_CONTEXT_STORAGE_DIR contained there; `lsof -p <pid> -Fn` proves database containment. No live stores or config were accessed or migrated.

On base master `f364d4c04203e68063433d5da03eb5b1929bf947`, the worker emits four signed responses, then `ctx_reduce(drop: 2)`. The next transform drains pending work (`ride=subagentExecute`; `ride=force+subagentExecute` in force), strips **two** reasoning parts, and the enforcing provider rejects request five before the matcher executes. Both real-host tests fail with expected seven worker passes, actual four. Captured pre-fix artifacts are under `$TMPDIR/magic-context/issue-630/proof-master-{76,85}/`.

Exact baseline operations:

- `packages/plugin/src/hooks/magic-context/strip-content.ts:506-589`, `planMergedAssistantReasoningStrip`: keeps at most one thinking block in an assistant run, exempts only one latest host message, schedules the other blocks for removal. `stripReasoningFromMergedAssistants` applies that plan, via `finalizeMessageRepresentation` (`transform-postprocess-phase.ts:1815-1822`). This is the operation observed removing two blocks in the reproduction. Interleaved thinking returned by the provider is not malformed and must not be normalized inside its active turn.
- `tag-messages.ts:920` text target `setContent` neutralizes the message's associated reasoning; tool drops can erase the separating arc and cause the merged strip.
- `freezeReasoningOnBustingPass` (`transform-postprocess-phase.ts:546-578`) freezes all assistants, including open-turn thinking, after a prefix edit on prefix-bound models. Reactive recovery uses the same invalid assumption. Sonnet 5 in the issue is not in that newer prefix-bound model gate, so this is a second hazard, not the observed cause of the Sonnet reproduction.

The tag `v0.45.0` resolves to `73163f47ac2e1b079d7aa0b789035e99c99a7a66`. It was archived **inside this worktree**, built against the installed worktree dependencies, and launched via its package entry with schema preparation disabled (the released plugin initializes only the throwaway store). At execute the released child holds the queued operation: `pending ops held — reason=no originating cache-bust opportunity; scheduler=execute`. All thinking remains intact. This confirms that issue 619's execute-ride change exposes a previously held operation on master. It does **not** reproduce the original report at execute on this shorter fixture. The release's 85% boundary is tested separately, rounding usage upward to enter rather than approach force. Initial runs rounded below 85%, and are not counted as force evidence. Boot attempts using the raw dist entry did not register tools; the package entry is required for release reproduction.

## Chosen safety rule

Never change or remove thinking in the Anthropic-family active assistant turn. Tool-result-only user messages do not release it. Metadata-only host assistant shells are not a turn boundary. This applies to canonical Anthropic, custom Anthropic/Vertex routes, Claude on Bedrock and the merged-assistant serializer, not just primary/subagent status or a particular model version.

Conservatively defer drops affecting a thinking-bearing active turn, retain the queue and active tag status, and retry after the next real user message. Do not speculatively shorten results while relying on stripping later signatures. For prefix-bound routes, earlier prefix edits also need deferral while active thinking is protected. Force does not waive this invariant. Holding an unsafe edit never refuses a turn on its own: the unchanged turn is sent when it fits, and the existing final-wire fit and overflow refusal rules decide alone, so a turn refuses only when the outgoing request is proven over the window. An earlier 95%-usage refusal (`ANTHROPIC_LATEST_TURN_FULL`) was removed after review.

Primary sessions with completed turns followed by a real user message have no protected active thinking span. Their existing transform bytes must remain identical. No storage migration, host-history rewrite, or change to the force threshold is warranted.

## Implementation and final verification

**Rule as implemented.** An edit is deferred only if applying it would alter or remove a thinking or redacted-thinking block inside the active Anthropic turn: directly, or on a prefix-bound model (Fable 5.1, Opus 5.5, Sonnet 5.5) because an earlier edit would invalidate the later signed blocks. On other Anthropic models (Sonnet 5, the reporter's model) older-turn and active-turn output edits that leave thinking byte-identical still apply on the same pass. Deferred edits keep their queue entry and active tag status and apply on the first rebuilding pass after the next real user message. Magic Context's own `[cleared]` reasoning placeholders are not protected thinking (Rust).

**Active turn.** One definition shared with the reasoning-budget branch for issue 620: `isInActiveAnthropicTurn` (`packages/plugin/src/hooks/magic-context/active-anthropic-turn.ts`) and `in_active_anthropic_turn` (`crates/mc-module/src/transform/active_anthropic_turn.rs`) are copied verbatim from that branch. `latestAssistantTurnStart` and Rust `protected_thinking_turn_mids` derive from them. Upstream detail kept as-is: the TS predicate treats a user message with an empty parts list as a real request, while the Rust one does not.

**Hosts.** OpenCode 1 and 2 share `createTransform` (defer). OpenCode 2 now arms the restore-once recovery from its session event stream (`armLatestThinkingRecoveryFromError`), as OpenCode 1 already did from `session.error`. Arming binds recovery to the real user message that started the rejected turn (`latest_thinking_original_armed:<id>`, recorded from the last pass); only a pass of that same turn restores, and a later real user message disarms it. Pi uses the shared protection and its own recovery; its start- and end-of-pass frozen replay skips the active turn while recovery covers it. In Rust, a priced pass no longer releases `native_reasoning_keep` for active-turn messages, and a custom provider/model name is treated as Anthropic when a reasoning part carries `metadata.anthropic`, as in TypeScript.

**OpenCode 2.0.22 (`tests/opencode2/latest-turn-thinking-recovery.test.ts`).** The rejection arms from the real host's event stream, bound to the turn's user message. That host has no same-turn resubmission (re-prompting the same user message id reaches no provider, and it does not retry the 400); its resume path is a new user-role message, which ends the turn, so recovery disarms without restoring and the provider accepts the continued session. The restore itself is proven on real OpenCode 1.18 and in the Pi and plugin unit gates.

**Real-host evidence (OpenCode 1.18.35, the reporter's version, `npm pack opencode-darwin-arm64@1.18.35`, throwaway roots proven with `lsof -p <pid> -Fn`).** `tests/latest-turn-thinking.test.ts`, 7 pass / 106 assertions. Failing first on base `f364d4c0` (archived and bundled inside this worktree, loaded through its package entry):

- subagent at 76%: request five arrives with every thinking block removed, the enforcing provider rejects it, and the worker stops at 4 of 7 passes;
- primary long tool loop at 85%: the host fails with the exact issue error, `thinking or redacted_thinking blocks in the latest assistant message cannot be modified`.

The primary at 76% on base never applies the drop (`no originating cache-bust opportunity`), so it fails only the release assertion. It is not counted as thinking evidence. `cat` through the host bash tool intermittently returns `(no output)` on 1.18.35. That is a host fixture flake, seen on both base and fixed runs.

**Mutation proofs:** see the delivery record. Neutralizing the Rust protection reproduces the old pinned hash for pass 3 of `compact_projection_multi_pass_served_bytes_match_baseline` (`b7405b30…`). That confirms the old bytes came from releasing active-turn thinking. Skipping the in-pass `restoreLatestTurnOriginals` call is not detected by any test, because the recovery flag already stops legacy replay from stripping the active turn. Forcing `prepareLatestThinkingRecovery` to `restore:false` turns the host retry back into the provider 400.

## Delivery status

The selective protection replaces the earlier global hold. Gates and changed legacy tests are listed in the delivery record and commit messages.

### Parent decisions

1. Preserve already-frozen legacy wire decisions unchanged; do not restore thinking merely because the raw host history still has it. Restore only after the provider's specific latest-thinking-modified rejection. If originals are unavailable, refuse locally rather than repeat a 400. The provisional implementation records this using the existing recovery column, without a schema migration. A second rejected restoration is quarantined. Restoration currently replays the original current-turn envelope as well as thinking, so truncations cannot invalidate restored blocks.
2. Use selective protection, not a global primary hold: block direct thinking changes and edits that require stripping later active-turn signatures. Older safe operations, including a gap-free oldest thinking trim, must keep existing primary behavior. This decision is **not yet implemented correctly** in the provisional patch.

### Additional real-host evidence

On OpenCode 1.18.30, the enforcing-mock accepted-legacy test passes. Its provider-side legacy receipt is explicitly seeded from known previously returned blocks 1 and 4 (and the next returned block 5), modeling the recorded first-party OAuth acceptance; it is not computed from the client's replay. It then enforces every new thinking response. Frozen legacy blocks remain omitted, and the retained thinking prefix is byte-identical.

The rejected-legacy test also passes: a throwaway-store fixture seeds previously recorded strips for two actual host assistant ids; the enforcing provider rejects the next request once. The error is durably learned. Re-sending the same real user message **with its original message id and text-part ids**, not adding a new user turn, restores signed blocks 2 and 3 and finishes the worker's tool loop. Empty prompt parts are not a valid OpenCode continuation: the host rejects them with `Your message hadn't finished arriving`; that attempted driver is not counted as recovery evidence. Latest successful rejected-turn proof root: `$TMPDIR/magic-context/issue-630/opencode-e2e-70gvV5`; durable artifacts are in its sibling timestamped proof directory. All host database files were checked with `lsof`; no local Rust host binary was launched.

### Earlier provisional-patch verification (superseded by the delivery record)

- Bun 1.4.2, TypeScript 5.9.3, Biome 2.5.1, Cargo 1.99.0, rustfmt 1.10.0-stable.
- Both production package typechecks passed after adding recovery.
- New real-host execute/force suite passed (3 tests including the negative control, 40 assertions) before the recovery addition. The accepted-legacy and rejected-legacy host tests each subsequently passed individually. They still need one final combined run after selective protection is corrected.
- Recovery unit suite: 5 passing tests, including missing originals and repeated-rejection local refusal. The focused plugin run was 28 pass / 1 fail (the old index-staleness fixture still asserted clearing within an uninterrupted thinking turn); its input was subsequently given an explicit real-user boundary, but that edit has not been reverified.
- Focused Pi provider/recovery suite: 17 pass / 0 fail; Pi typecheck passed.
- Full plugin run: 7290 pass / 6 skip / 7 fail. Full Pi run: 1604 pass / 3 skip / 8 fail. These were before the final legacy-replay correction; they are not green delivery gates. HOME fixture failures must be retested under a canonical realpath throwaway HOME. No assertion in those unrelated fixtures was changed.
- Full Rust module library run: 1634 pass / 15 fail / 22 ignored. After reverting unconditional legacy thinking restoration, the narrower reasoning run improved to 60 pass / 8 fail. Remaining failures: `adapter_reasoning_goldens_reach_the_module_strip_contract`, `merged_reasoning_transition_waits_for_bust_then_replays_after_restart`, `reasoning_clear_exempt_at_cutoff_waits_for_bust_and_replays_after_restart`, `reasoning_clear_merged_assistant_whitespace_sentinels_replay_one_wire_shape`, `reasoning_clear_pre_fix_database_migrates_ck_and_incremental_wire_without_bust`, `reasoning_clear_reexemption_and_native_keep_collision_change_only_on_priced_passes`, `reasoning_cutoff_batches_on_one_fold_and_survives_restart`, and `subagent_merged_reasoning_first_applies_only_on_execute_and_replays_on_defer`. Some assert faulty new active-turn removals; others are legitimate older-turn/cached-byte controls. Do not invert all of their assertions. First fix selective protection, then classify and rerun the remaining failures.
- The two new Rust latest-turn queue/95%-refusal and merged-strip tests passed. All Rust evidence here is `cargo test`, which is unaffected by the remote build/target-copy warning. No end-to-end evidence used a locally launched `ck-mc` or `ckdev-mc` binary.
- Both package lint scripts passed with only existing warnings before the recovery addition; final lint, build, fresh diagnostics and mutation proofs remain unfinished.
- Mode-manifest TypeScript validation passed after registering the new test. E2E-wide tsc reports existing errors in unrelated probes, Rust harness typing, OpenCode 2 tests, retina imports and a command-handler readonly field. No narrow final E2E typecheck was completed.

### Test contract changes already made

- The old TypeScript text-drop test claimed that dropping the latest assistant's text may clear its thinking. It now verifies deferral and keeps its original clearing claim after a real user closes the turn.
- Pi's old multi-assistant recovery fixture ended in an open tool round yet expected all thinking removed. It now explicitly ends with a real user, retaining its completed-history repair/replay assertions. A fresh-thinking test additionally proves a bust alone does not release thinking, but a real user does.
- The TypeScript index-staleness fixture was given a real-user boundary before testing historical cleanup, preserving its original pruning/clearing assertions. That final fixture change needs verification.

No production migration or change to ARCHITECTURE.md/STRUCTURE.md was made.
