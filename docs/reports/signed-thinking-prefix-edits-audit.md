# Can Magic Context edit history before a kept signed thinking block?

Audit of every mutation lane, for every runtime, on Anthropic routes with prefix-bound signed thinking (Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5). The base is master `736d43d7`, and every result below comes from tests committed with this report. No product code was changed.

## Answer in one paragraph

**Yes.** On every runtime, some lanes still land an edit before a kept signed thinking block while the current assistant turn holds signed thinking. The issue 630 fix closed the lanes that act through **tag targets**: ctx_reduce drops (full removal and skeleton), age reclaim and heuristic cleanup, supersession and dedup, emergency drops at 85% and 95%, `/ctx-flush` drains and caveman compression. It also froze the ordinary HARD fold in TypeScript and Pi. It did not close the lanes that act outside tag targets:

- the stale ctx_reduce strip;
- the processed-image strip;
- placeholder (frozen-sentinel) neutralization;
- the synthetic-todo anchor move;
- an m[0]/m[1] re-render whose cache was cleared or whose coverage moved.

On a strict-binding account each of these produces `Invalid signature in thinking block … bound to a different conversation`. Recovery cannot repair the rejection inside the turn, because the edit is frozen and replayed on every later pass and the current turn's thinking may not be removed. A subagent run therefore fails outright. A primary session fails until the user sends a new message.

## Who sees it

- **Accounts created on or after 2026-08-31** get the 400 by default.
- **Older accounts** get the 400 only when a request sets `thinking.block_binding.prefix_mismatch_behavior: "error"`. Nothing in Magic Context or OpenCode sets it (see Headers below).
- **Our own sessions**, on an older OAuth account, do not see the 400. `anthropic-thinking-binding.md:17,138` measured that this account silently drops the invalidated blocks, so we lose reasoning without seeing an error.
- The live strict-mode evidence in `docs/reports/live-thinking-arc-removal.md` (branch commit `2811017c`, not in this base) agrees with the rule this audit's mock enforces. Removing any arc, signed or unsigned, before a kept signed block was rejected. This included an unsigned arc inside the current turn. Stripping only the older-turn thinking did not repair a request whose current-turn thinking was kept.

## Findings, ranked by user impact

1. **Stale ctx_reduce strip: OpenCode 1 TS mode and OpenCode 2, primary and subagent.**
   - **Trigger.** The agent's fourth ctx_reduce call in a session ages the first one out. ctx_reduce keeps its newest 3 (`protected-tools-policy.ts:2-5`). Any later cache-busting pass then sentinel-strips that first call.
   - **Code.** `dropStaleReduceCalls`, `transform-postprocess-phase.ts:3034-3060`, detects on `isCacheBustingPass` with no active-turn check.
   - **Why it ranks first.** A subagent busts on every execute pass at 65% or more, which is the issue 630 route (`rideSignals.subagentExecute`, `transform-postprocess-phase.ts:2249`). Long subagent loops call ctx_reduce routinely, and the stripped call usually sits before the loop's thinking.
   - **Effect.** The subagent dies with the 400 and has no later user turn to recover in.
   - **Not exposed elsewhere.**
     - Pi strips stale calls through tag targets (`heuristic-cleanup-pi.ts:510-555`, `canDrop()`), which are protected.
     - The Rust module guards this strip with `active_thinking_prefix_edit_ids` (`transform.rs:14173-14186`).
2. **Synthetic todo anchor move: all runtimes, primary sessions.**
   - **Trigger.** On a busting pass the todo state changes, as it does after every real `todowrite`. The synthetic pair is then re-injected into the latest assistant, and its old anchor, earlier in history, loses the pair:
     - TS: `applyTodoSynthesis`, `transform-postprocess-phase.ts:403-447`;
     - Pi: `injectSyntheticTodowriteForPi`, `pi-todo-inject.ts:244+`;
     - Rust: `todo_injection_pending`, `transform.rs:5592-5609`.
   - **Effect.** The old anchor is an edit before every kept current-turn block. TS and Pi need a bust to ride: the 85% force band, the 95% wall or `/ctx-flush`. The Rust module prices the todo change as its own `SOFT` (`m1_delta`) pass once usage reaches the execute threshold.
   - **Why it ranks high.** It needs no unusual state, only a todo update plus pressure in a long loop.
3. **HARD fold after a historian publication: Rust module (OpenCode 1 Rust mode and Claude Code), primary sessions.**
   - **Trigger.** Mid-loop, a compartment covering the older turn lands. The module serves a `coverage_fold`: m[1] is re-rendered and the covered raw messages are trimmed, although `prefix_materialization_enabled` is false for a protected signed prefix (`transform.rs:5208-5211`).
   - **Effect.** The historian publishes in the background as context grows, so this hits ordinary long Rust-mode sessions.
   - **Modelling caveat.** The test publishes through `McStore::replace_compartments`, not the producer's `publish_historian_chunk` (`mc-store/src/lib.rs:13561`). Both change the compartment set the transform reads.
   - **TypeScript and Pi hold the same trigger**, through `freezeM0M1` (`transform.ts:1160-1165`, `transform-postprocess-phase.ts:2029-2031`) and Pi's `protectedSignedPrefix` (`context-handler.ts:5572-5573,5924-5932`).
4. **Claude Code through ck-mc: older-turn thinking is never stripped on a bust (pending owner confirmation).**
   - **Code.** For prefix-bound models the `claude-code-anthropic` profile has no reasoning removal (`reasoning_clear_cutoff_with_tags`, `transform.rs:16911`, returns `None`). This repository has no Claude Code host step that freezes thinking on a bust, as OpenCode's Rust-mode host does.
   - **Effect in the test.** Every control bust at a new user turn returns the 400: the drop, `/ctx-flush`, the 95% wall, the fold, todo, caveman, the image strip and the placeholder.
   - **Open question.** If the Claude Code client replays earlier-turn thinking, every Magic Context bust on a strict account fails on this route, not only mid loop. Whether it does, and whether the gateway (Thalamus) strips anything, needs the gateway owner. `anthropic-thinking-binding.md:170` already records that Thalamus sends no binding controls.
5. **Placeholder neutralization ("frozen-sentinel first application").**
   - **Where.** TS on primary and subagent; Pi on primary, on a history refresh; the Rust module on primary.
   - **Trigger.** A message that holds only `[dropped §N§]` placeholders is neutralized on its first busting pass:
     - TS: `stripDroppedPlaceholderMessages`, `transform-postprocess-phase.ts:3284-3289`, no active-turn check;
     - Pi: `stripPiDroppedPlaceholderMessages`, discovery gated on history refresh, `strip-placeholders-pi.ts:139-149`;
     - Rust: `transform.rs:14187-14194`, which checks only that the message itself is not in the active turn, not whether it sits before kept thinking.
   - **Impact: low.** Such messages come from history written with compaction off or by older builds. TS `stripSystemInjectedMessages` (`:3294-3299`) is the same unguarded detect block, but it was not driven in a test.
6. **m[0]/m[1] re-render after a recomp or boundary repair clears the cached pair: TS (OpenCode 1 TS mode and OpenCode 2), primary.**
   - **Trigger.** `clearCachedM0M1` runs inside:
     - recomp promotion (`compartment-runner-recomp.ts:137`, `compartment-storage.ts:~701,743`);
     - history-boundary repair (`history-boundary-repair.ts:146,241`);
     - the store-generation rebase (`store-generation-rebase.ts:965`).
   - **Effect.** The next pass, **even a defer pass**, has no frozen pair to replay and re-renders m[0]/m[1], which trims raw history.
   - **Impact: medium-low.** It needs a `/ctx-recomp` or a host revert during a running loop, but it bypasses every bust gate.
7. **Processed-image strip: TS, primary.**
   - **Trigger.** TS reads the drop watermark at pass start (`transform.ts:2453`). A drop applied at a turn start therefore leaves an answered screenshot unstripped. The next mid-loop bust strips it (`transform-postprocess-phase.ts:3068-3086`).
   - **Not exposed in Pi or the Rust module.** Both strip on the same pass that advances the watermark, and the active-turn hold keeps that pass's drop.
8. **Code-read only, not tested: Rust-mode host strip after a frozen release.**
   - `applyRustModeThinkingStrips` (`transform-postprocess-phase.ts:1041-1066`) suppresses the module-bust strip during an active turn.
   - A frozen-replay release still computes `stripFrom` from `frozenReleaseLastServed`. It then freezes reasoning with `protectedThinkingMessages`, which `rust-mode-transform.ts:4254-4256` passes only while restoring.
   - After a park or last-known-good replay in a thinking turn, current-turn thinking could be stripped, giving the "latest assistant … cannot be modified" 400.

## What the issue 630 fix withholds, exactly

On prefix-bound models the fix withholds the following:

- **Edits before kept active-turn thinking.** `protectNewTagMutations` (`latest-assistant-turn.ts:74-122`) disables any new tag mutation whose parts sit before the last retained active-turn thinking part, or that would drop such a part. It is applied at `transform-postprocess-phase.ts:2015-2020` and Pi `context-handler.ts:6235`.
- **Every tag lane.** That covers pending ops, heuristic cleanup and emergency selection, tool reclaim and supersession, and caveman (`caveman-cleanup.ts:159,177`).
- **The queued work itself.** A held drop keeps its queue entry and keeps the materialization request pending until a real user message (`:2234-2238,2850-2856`).
- **The m[0]/m[1] fold and soft refresh, through `freezeM0M1`.** In Rust the same protection feeds selection (`transform.rs:5409`), caveman (`:8865`) and the system-injection and stale-reduce strip units (`:14093-14186`). `prefix_materialization_enabled` is false under a protected signed prefix (`:5208-5211`).

It does **not** withhold lanes that edit without a tag target: findings 1, 2, 5, 6 and 7 in TS; 2 and 5 in Pi; 2, 3 and 5 in Rust. The TS postprocess records these as `firstApplicationEdits.beforeNewerThinking` (`transform-postprocess-phase.ts:2433-2446,4091-4134`). It then calls `freezeReasoningOnBustingPass` (`:529-587`, called at `:4136-4159`), which strips only unprotected, older-turn thinking and keeps the current turn. The result is exactly the request the live test showed is still rejected.

## Per runtime and lane

**Columns:**

- **(i) mid-turn** says whether the lane can land while the current turn holds signed thinking (P = primary mid loop, S = subagent run).
- **(ii) reasoning handling** is what happens to thinking on that pass.
- **(iii) strict** is the validity of the resulting request.

**Lane result terms:**

- "Held" means the test served unchanged bytes and kept any queue entry, and the control at a new user turn landed the same edit validly.
- "n/a" means the lane does not run there.
- "Not exercised" means the Rust fixture's control did not land the lane, so the code is cited instead.

**Reasoning handling, per runtime:**

- **OpenCode 1 TS mode and OpenCode 2** (`createTransform`, v1 and v2 stores): `freezeReasoningOnBustingPass` strips older-turn thinking only, and the current turn is kept.
- **Pi and OMP:** `applyPiProactiveThinkingStrip` (`provider-error-recovery-pi.ts:307-357`) excludes the active turn.
- **OpenCode 1 Rust mode:** the module strips nothing. The host's `applyRustModeThinkingStrips` freezes all reasoning on a module bust only outside an active turn.
- **Claude Code:** nothing strips (finding 4).

| Lane | OC1 TS / OC2 | Pi / OMP | OC1 Rust mode (ck-mc) | Claude Code (ck-mc) |
|---|---|---|---|---|
| ctx_reduce drop, full | held P,S; valid | held P,S; valid | held P,S; valid | held P,S; valid |
| ctx_reduce drop, skeleton | held P,S; valid | held P,S; valid | not exercised; same selection protection (`transform.rs:5409`) | same |
| Age reclaim / heuristic cleanup | held P,S; valid | held P,S; valid | not exercised; selection protection | same |
| Supersession / dedup | held P,S; valid | held P,S; valid | not exercised; selection protection | same |
| Emergency at 85% | held P,S; valid | held P,S; valid | not exercised (no 85% bust in fixture) | same |
| Emergency at 95% | held P,S; valid | held P,S; Pi drops the newest tool result, after every kept block: valid | held P,S; valid | held P,S; valid |
| HARD fold (historian publication) | held P (freezeM0M1); valid | held P; valid | **lands P → 400** (finding 3) | **lands P → 400** |
| m[0]/m[1] re-render after cache clear | **lands P, even on defer → 400** (finding 6) | not tested | not tested | not tested |
| `/ctx-flush` | held P; valid | held P; valid | held P (bust priced, drop kept); valid | held P; valid |
| Synthetic todo | **lands P → 400**; n/a S | **lands P → 400**; n/a S | **lands P → 400** | **lands P → 400** |
| Caveman | held P; n/a S | held P; n/a S | held P; valid | held P; valid |
| Reasoning clearing (`keep_reasoning_tokens`; `clear_reasoning_age` is ignored, `transform.ts:466`) | lands P as an oldest contiguous run, current turn protected: **valid**; S nothing eligible | valid P | not exercised; walk is oldest-contiguous and skips the active turn (`transform.rs:14277-14354`) | no removal at all on prefix-bound models (`:16911`) |
| Image strip | **lands P → 400** (finding 7) | held: lands only with the held drop | held: lands only with the held drop | held |
| Stale ctx_reduce strip | **lands P,S → 400** (finding 1) | held P,S; valid | not exercised; guarded (`:14173-14186`) | same |
| Frozen-sentinel (placeholder) first application | **lands P,S → 400** | **lands P → 400** | **lands P → 400**; S held (strip units are primary-only) | **lands P → 400** |

Controls are in the same suites: each primary lane busting at a new user turn lands its own edit validly once every older thinking block is stripped. The brief's control is the separate test `control: bust at a new user turn` (two queued drops plus `/ctx-flush`, all thinking stripped, the loop continues validly). The exception is Claude Code, where every control busting at a new user turn is rejected (finding 4).

## Tests

- **Strict-binding mock**: `packages/plugin/src/hooks/magic-context/__tests__/strict-binding-mock.ts`.
  - Receipts are minted from each accepted request.
  - It rejects a changed prefix before a kept block, middle thinking removal, removal of current-turn thinking, and changed thinking bytes.
  - Its own rule tests are in `strict-binding-mock.test.ts`, 9 cases: shortened `tool_result`, changed `tool_use` input, a removed unsigned arc, legal start removal, middle removal, current-turn removal, changed bytes, and the new-turn control.
  - The Rust suite carries a line-for-line port.
- **OpenCode 1 TS mode / OpenCode 2**: `packages/plugin/src/hooks/magic-context/signed-thinking-prefix-audit.test.ts`.
  - It runs the real `createTransform` with the v1 and v2 stores, 78 cases.
  - OpenCode 2 is exercised at its shared transform, not through the 2.x host's draft conversion.
- **Pi / OMP**: `packages/pi-plugin/src/signed-thinking-prefix-audit.test.ts`, the real context handler, 36 cases.
- **Rust module** (OpenCode 1 Rust mode and Claude Code): `crates/mc-module/tests/signed_thinking_prefix_audit.rs`.
  - It runs the real `transform` and models the OpenCode Rust-mode host's bust-time thinking freeze (`Fixture::observe`).

**How to read them:**

- By default an exposed lane asserts its exact 400, so the suites stay green. Run `MC_AUDIT_STRICT=1` to assert strict validity everywhere.
- `MC_AUDIT_DEBUG=1` prints the first differing block. Rust also accepts `MC_AUDIT_LANE=<Lane>`.

**What `MC_AUDIT_STRICT=1` makes fail:**

- **OpenCode 1 TS mode and OpenCode 2 (14):**
  - primary mid tool loop: frozen-sentinel first application, m[0]/m[1] re-render after a recomp clears the cached pair, processed image strip, stale ctx_reduce strip, synthetic todo;
  - subagent run: frozen-sentinel first application, stale ctx_reduce strip.
- **Pi (2):** primary frozen-sentinel first application and synthetic todo.
- **Rust:** `opencode_rust_mode::primary_mid_loop`, `claude_code::primary_mid_loop` and `claude_code::control_at_new_user_turn`.

**Proof the held results are real:** neutralizing the `prefixBound` prefix-edit check in `protectNewTagMutations` turned every held OpenCode 1 TS primary tag lane red with the binding 400. These were the drop lanes, age reclaim, dedup, 85% and 95%, `/ctx-flush` and caveman.

## Headers: does anything set the binding control?

- **This repo.** There is no `block_binding`, `prefix_mismatch_behavior` or `thinking-binding-controls` beta in product code, only in tests and e2e harnesses. The plugin's single `chat.params` hook applies only the dreamer cap (`packages/plugin/src/index.ts:934-936`).
- **OpenCode.** The 1.18.30 capture (`packages/e2e-tests/src/repro/reasoning-cleanup-per-provider.capture.json`, `docs/reports/reasoning-cleanup-per-provider.md:105-139`) shows OpenCode emits `context_management` and its beta only when model options configure them. The harness did that, so it is not a default.
- **anthropic-auth.** The previous audit (`anthropic-thinking-binding.md:19,165-167`) reports that `applyThinkingBindingControls`:
  - is gated to Fable 5.1 and OAuth;
  - defaults to `account-default`, which sends nothing;
  - is unset in the operator's config;
  - does not apply to API-key routes.

  That is the anthropic-auth repository at the time of that audit. **The anthropic-auth owner must confirm the current state.** The OpenCode and Pi hosts' own Anthropic request builders, and the Claude Code gateway's headers, also need their owners.

## Recovery after a 400

- **What arms it.**
  - OpenCode: `session.error` and `message.updated` (`event-handler.ts:365-393,589-609`), with OpenCode 2 arming from its event stream.
  - Pi: `message_end` (`provider-error-recovery-pi.ts:51-108`).
  - Either way, a binding 400 arms a flag and drops the last-known-good slot.
- **What it does.**
  - **TS** consumes the flag only when no active thinking turn exists (`transform-postprocess-phase.ts:3799-3802`; Rust-mode host `:1001-1004`). The consuming pass strips thinking from every non-active-turn assistant.
  - **Pi** strips completed assistants but never the active turn (`:199-274`).
  - A different error, "latest assistant … cannot be modified", gets a restore-once of the turn's original envelope, and a second rejection refuses locally (`latest-thinking-recovery.ts:99-183`).
- **Can it loop?** Not by itself.
  - Mid loop the flag stays armed and unconsumed. The offending edit is persisted and replayed every pass, so every resend repeats the same 400.
  - Termination depends on the host not auto-retrying a 400. The issue 630 report found that OpenCode 2.0.22 does not retry it. OpenCode 1, Pi/OMP and Claude Code retry policy is not visible in this repo.
  - **A primary session** recovers only when the user sends a new message: the next pass consumes the flag and strips all older thinking.
  - **A subagent** has no next user turn, so its run is lost.

## Server-side context editing (`clear_tool_uses_20250919`)

**Worth a separate design note**, on this evidence:

- On prefix-bound models every Magic Context reduction must now wait for the end of a thinking turn. A subagent's whole run is one turn, so on strict accounts long subagent loops get no reclamation at all until they fail or finish.
- Per Anthropic's docs, server-side clearing does not count as a binding edit. It is the only mechanism found that can shrink tool output inside a signed loop.
- **Cache cost.** `reasoning-cleanup-per-provider.md:141` notes that clearing invalidates the cache from the clearing point.
- **Plumbing exists on OpenCode 1.18.30.** The native adapter passes `contextManagement` options through and adds the beta header (`:107-139`). Magic Context registers no hook that uses it. The repo has no occurrence of `clear_tool_uses`.
- **Unknowns for the note:**
  - support on Vertex, Bedrock and Copilot;
  - how the server's placeholders interact with Magic Context's `§N§` tags and its token accounting;
  - whether the anthropic-auth and Claude Code gateway paths can emit it.
