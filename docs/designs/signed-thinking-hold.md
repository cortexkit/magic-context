# Holding edits before kept signed thinking: one admission check

## Status and scope

This is a fix design for review before implementation. It is based on the audit in
[`signed-thinking-prefix-edits-audit.md`](../reports/signed-thinking-prefix-edits-audit.md),
the live strict-mode report `docs/reports/live-thinking-arc-removal.md` (branch commit
`2811017c`, not in this base) and [`skeleton-retirement.md`](skeleton-retirement.md). The
base is the audit branch `56933980`, which is master `736d43d7` plus the audit and its tests.

No product code changes in this delivery. The three audit suites are extended so that
`MC_AUDIT_STRICT=1` asserts the whole contract this design requires (section 9). Without the
variable they stay green and pin what the code does today. `ARCHITECTURE.md` and
`STRUCTURE.md` are untouched.

**Decision in one paragraph.** Every first-application edit, in every runtime, asks one
question before it changes the request: *does the earliest position this edit touches come
before the last signed thinking block the current turn keeps?* If it does, the edit is
**held**. A held edit is not applied, not persisted as served or frozen, and does not use up
the trigger that offered it. It is retried on the first pass of the next turn. TypeScript
(OpenCode 1, OpenCode 2 and Pi) and the Rust module (OpenCode 1 Rust mode and Claude Code)
each get one implementation of this check, with the same coordinate and the same verdicts on
a shared corpus. The tag-target protection from the issue 630 fix (`protectNewTagMutations`,
`freezeM0M1`) is re-expressed on top of the same check, so there is one definition of
"before kept thinking" instead of two.

## 1. The rule

On prefix-bound models (Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5, matched by
`isPrefixBoundThinkingModel` in TS and `is_prefix_bound_thinking_model`,
`crates/mc-module/src/transform.rs:14240-14257`), each signed thinking block is bound to the
exact request prefix that came before it when the provider produced it. These are the only
valid changes to a request that keeps such a block:

- removing thinking blocks from the start of the sequence, from the end, or all of them;
- appending content at the end.

Anything else that changes content before a kept block invalidates that block and every
later one. That includes tool calls, tool results, text, the first user message and the
injected m[0]/m[1] pair. The live report found no exception for content that has no thinking
of its own. Deleting an unsigned tool arc inside the current turn was rejected, and so was
deleting a whole older signed arc. Stripping all older-turn thinking did not repair an older
arc's deletion while the current turn's blocks were kept, because those blocks were signed
over the deleted bytes. Current-turn thinking itself may never be removed or changed.

Two consequences shape the design:

1. **Only current-turn blocks can block an edit.** Older-turn blocks may be removed. When an
   admitted edit lands before a kept older-turn block, the runtime must remove *all*
   older-turn thinking on that pass. It must not remove only the blocks after the edit. A
   partial strip is a removal from the end, which is valid only until the next response
   adds a current-turn block. From then on the removed blocks sit in the middle of the
   sequence (`MIDDLE_ERROR` in the mock; the October 8 live test rejected a middle-block
   removal). The
   OpenCode hosts already strip all of it (`freezeReasoningOnBustingPass`,
   `transform-postprocess-phase.ts:529-587`). Claude Code does not (section 6).
2. **The boundary is the last kept current-turn block.** An edit at or after the position
   just after that block is in no kept block's prefix. This is the "append at the end" case:
   the next response is signed over the edited bytes, and later passes replay the edit.

## 2. What still edits today

These are the audit's findings, plus three results from the tests extended for this design
(section 9). "Exposed" means a strict-binding 400 mid-loop, or silent reasoning loss on
older accounts.

| # | Lane | TS (OC1, OC2) | Pi / OMP | Rust module (OC1 Rust mode, Claude Code) |
|---|---|---|---|---|
| 1 | Stale ctx_reduce strip | exposed P, S | held (tag target) | guarded by `active_thinking_prefix_edit_ids` |
| 2 | Synthetic todo anchor move | exposed P | exposed P | exposed P |
| 3 | Coverage fold after a historian publication | held (`freezeM0M1`) | held | exposed P |
| 4 | Claude Code: no older-turn strip on a bust | n/a | n/a | every bust at a new user turn → 400 |
| 5 | Placeholder / system-injected neutralization | exposed P, S | exposed P | exposed P |
| 6 | m[0]/m[1] re-render after `clearCachedM0M1` | exposed P, even on defer | **exposed P (new)** | **not exposed (new)** |
| 7 | Processed-image strip | exposed P | held | held |
| 8 | Rust-mode host strip after a frozen release | code-read only | n/a | n/a |
| 9 | **Temporal-marker first application (new, code-read)** | likely exposed P | gap | gap |
| — | **Release of held work at the next turn (new)** | releases | releases | **does not release** drop, flush, caveman, image |

The three new results:

- **Pi, finding 6.** The new Pi lane "m[0]/m[1] re-render after a recomp clears the cached
  pair" calls `replaceAllCompartmentState` and offers no bust. The next pass lands the new
  compartment mid-loop and is rejected with `PREFIX_ERROR`, as in TS. Its control at a new
  user turn lands validly.
- **Rust, finding 6.** The new Rust lane `Recomp` makes the same compartment rewrite with no
  ride. The module renders nothing new, either mid-loop or at a new user turn. Rust is not
  exposed: it keeps its own frozen render and has no cache clear.
- **Rust release gap.** When a lane is held mid-loop, the queued drop, the armed `/ctx-flush`
  refresh, caveman and the image strip have still not landed after the next user turn,
  although the same 85% pressure or armed refresh is still in place. The control lands them
  when the pressure first arrives at a new user turn. Two facts were observed: the held pass
  reports `prefix_bust_permitted=false`, and so does the first pass of the next turn. Which
  latch withholds the release was not established. Candidates are the force-episode latch
  (`transform.rs:5280,5728-5742,7341-7357`) and the soft-refresh arm. TS keeps the request
  alive through `pendingMaterializationSessions` (`transform-postprocess-phase.ts:2232-2238,
  2848-2856`). Pi releases the same lanes.

**Finding 9 (code-read, not tested).** The experimental temporal-awareness lane freezes a
marker decision per user message on a busting pass (`transform-postprocess-phase.ts:2300-2316`).
`freezeTemporalDecisions` upgrades a NULL row ("seen, unmarked") to a marker
(`features/magic-context/temporal-decisions.ts:118-135`). The current turn's user message is
recorded NULL when the turn starts. A mid-loop bust can then prepend a marker to it, which is
an edit before every current-turn block. Today this pass is only accounted for afterwards, as
`recordFirstApplicationWireEdit(true)` (`:2438`). It needs a test; it is in the lane table
below.

## 3. The admission check

### Coordinate

The protection map in `protectNewTagMutations` (`latest-assistant-turn.ts:73-122`) keys
positions by part-object identity. A replayed skeleton clone is a new object, so its position
is unknown and it falls through as `Infinity`, which counts as "after". The Rust twin
(`active_thinking_prefix_edit_ids`, `transform.rs:16766-16815`) uses block ids
(`mid#index`), which survive replay but cost a clone per message.

The admission check uses a **served-occurrence coordinate**: the stable id of the message
that carries the content (OpenCode `info.id`, Pi entry id, Rust `mid`), plus where in that
message the edit falls. Three coordinates exist:

```text
EditCoord =
  | Prefix                      // m[0]/m[1], their trim of raw history, anything rendered
                                // before the first raw message
  | Message { id, block }       // an edit inside one raw message; block = the index of the
                                // first touched part, or Whole for the whole message
  | Append { after_id }         // new content inserted after message after_id
```

The boundary is the last retained thinking block of the current turn, written down as
`Boundary { message_id, anchor }`. The anchor is that block's signature, or the `data` of a
`redacted_thinking` block. A signature is byte-stable through replay, cloning and
re-serialization. A part index is not, because a replayed strip earlier in the same message
can shift it. The frame also records `tail`, the set of message ids strictly after
`message_id`.

### Verdict

```text
admit(coord):
  if not prefix_bound or boundary is None:          Admit
  Prefix:                                           Hold
  Message { id } with id in tail:                   Admit
  Message { id == boundary.message_id, block }:     Admit only if block sits after the
                                                    anchor part (found by signature in
                                                    this one message); Whole → Hold
  Message { id } otherwise, or a message with no stable id:   Hold
  Append { after_id }:                              Admit if after_id is the boundary
                                                    message or in tail; else Hold
```

A message with no stable id is held, not guessed. Every replay-backed lane already refuses
to detect such messages (`drop-stale-reduce-calls.ts:109-111`;
`strip-placeholders-pi.ts:137-149`), so this changes nothing for them.

### Frame construction (once per pass)

The frame is built once per pass, after the persisted decisions that remove thinking have
been applied and before the first first-application edit:

1. Find the start of the current turn with the existing single definition: TS
   `latestAssistantTurnStart` (binary search over `isInActiveAnthropicTurn`,
   `latest-assistant-turn.ts:32-43`), Rust `protected_thinking_turn_mids` /
   `active_turn_route_request`, Pi through the same shared helper.
2. Scan **backwards from the end** to that start, and stop at the first retained thinking
   block. "Retained" means signed (a signature, or redacted data), non-empty, and not
   removed by a persisted binding-recovery, merged-reasoning or reasoning-clearing decision.
   It is the predicate `retainedActiveThinkingParts` applies today
   (`latest-assistant-turn.ts:124-168`), but evaluated only for messages the scan visits.
   Messages passed over before the stop go into `tail`.
3. No retained block in the turn means `boundary = None`, and everything is admitted. Older
   turns are then handled by the companion strip rule (section 1, point 1).

The frame does not depend on replay order. Its inputs are message ids and a signature,
and no replay can remove current-turn thinking (all such lanes exclude the active turn). A
replay that runs after the frame is built may still remove or rewrite parts elsewhere; that
changes nothing the frame records.

### Interfaces

TypeScript, one module shared by OpenCode 1, OpenCode 2 and Pi (for example
`packages/plugin/src/hooks/magic-context/edit-admission.ts`, which Pi imports as it imports
`latest-assistant-turn.ts` today):

```ts
type EditCoord =
    | { kind: "prefix" }
    | { kind: "message"; id: string | undefined; block: number | "whole" }
    | { kind: "append"; afterId: string };

interface EditAdmission {
    readonly boundary: { messageId: string; anchor: string } | null;
    admit(lane: HoldLane, coord: EditCoord): boolean;   // false = held
    readonly held: ReadonlyArray<{ lane: HoldLane; coord: EditCoord }>;
}

function createEditAdmission(args: {
    messages: readonly MessageLike[];      // after persisted thinking removals
    prefixBound: boolean;
    isRetainedThinking: (message: MessageLike, part: unknown) => boolean;
}): EditAdmission;
```

Rust, in `crates/mc-module/src/` next to the active-turn helpers:

```rust
pub(crate) enum EditCoord<'a> { Prefix, Message { mid: &'a str, block: BlockPos }, Append { after_mid: &'a str } }
pub(crate) struct EditAdmission { boundary: Option<Boundary>, tail: HashSet<String>, held: RefCell<Vec<HeldEdit>> }
impl EditAdmission {
    pub(crate) fn new(core: &CoreState, req: &TransformRequest) -> Self;
    pub(crate) fn admit(&self, lane: HoldLane, coord: EditCoord<'_>) -> bool;
}
```

`admit` records every hold, both for telemetry and for the release request (section 4). The
existing `onFirstApplication(message, partIndex)` callbacks become the admission point. They
are already threaded through `dropStaleReduceCalls`, `stripProcessedImages`, the placeholder
and system-injected strips (`strip-content.ts:65,180,1010`), and Pi's image and placeholder
strips (`strip-processed-images-pi.ts:49`, `strip-placeholders-pi.ts:123`). The difference is
that they are now asked *before* the mutation and return a verdict. Today they record *after*
the mutation (`transform-postprocess-phase.ts:2440-2446`, Pi `context-handler.ts:5618`).

### Tag targets on the same check

`protectNewTagMutations` keeps its output contract: a target that may not mutate gets
`thinkingDropProtected` and `canDrop: () => false`. What changes is how it decides. It maps
each `mutationParts` entry (or the target's message) to `Message { id: owner.info.id, block:
index }` and asks `admit`. `dropsThinking` stays as it is (a target that would drop a
retained part). The same applies in Pi (`context-handler.ts:6199-6243`). In Rust,
`active_thinking_prefix_edit_ids` and its consumers (selection exemptions at
`transform.rs:5409-5413`, the strip units at `:14113-14186`) ask the frame instead of
building their own ordinal walk.

## 4. What "held" means

A held edit obeys four rules. The first three are what already makes a held tag drop safe
today. The fourth is what the Rust release gap is missing.

1. **Not applied.** The lane leaves the request bytes exactly as replay produced them. A
   compound edit is admitted or held as a unit, using the earliest coordinate it touches.
   The todo move is the case that matters: it removes the pair at the old anchor and inserts
   it at the latest assistant, and applying only half would duplicate or lose the
   `todowrite` pair.
2. **Not persisted as served.** Nothing that a later pass replays is written: no frozen id
   (`addStaleReduceStrippedIds`, `addProcessedImageStrippedIds`, the placeholder delta), no
   todo state, call id or anchor, no m[0]/m[1] cache, no Rust frozen unit and no Rust meta
   advance in the CAS commit. The pass also does not call `recordFirstApplicationAt`, so
   `firstApplicationEdits.beforeNewerThinking` stays false and `freezeReasoningOnBustingPass`
   strips nothing because of the held work. If nothing is admitted, a later defer replays
   exactly the bytes of the held pass, which are the bytes sent before it.
3. **Trigger not consumed.** A held pass must leave every trigger as it found it: queued
   pending ops and agent drops, `pendingMaterializationSessions`, `historyRefreshSessions`,
   the Rust soft-refresh arm, the force-episode latch (`has_prior_emergency_drop`), the todo
   state difference and an unrendered compartment publication. TS already does this for
   ops (`:2848-2856`). The Rust latch is set only when something was applied (`:7339-7357`),
   but the release gap shows that something else is still spent; finding it is the first
   implementation task in Rust.
4. **Released at the turn boundary.** A hold from an *obligation* lane records a durable
   release request: a queued drop, `/ctx-flush`, the 85% force band, the 95% wall, a HARD
   fold, or a coverage fold. The first pass with `boundary = None` (normally the first pass
   after a real user message) treats that request as a ride and clears it once the work
   lands. TS reuses `pendingMaterializationSessions`, Pi reuses
   `signalPiPendingMaterialization`, and Rust gets a meta flag committed with the transform.
   *Opportunistic* lanes (stale-reduce strip, placeholder and system-injected strips, image
   strip, todo move, temporal markers) never create a ride of their own. They wait for the
   next permitted bust, as they do outside a thinking turn today. A forced turn-start bust
   is paid only for work the user or the pressure model asked for.

**Telemetry.** Each held edit logs its lane, its coordinate and the boundary message id once
per pass, and adds to a per-session `held_edits` counter in the existing pass metrics. A
session where reclamation is continuously held (the subagent case, section 8) must be
visible without reading logs.

## 5. Where each lane calls it

`admit(lane, coord)` is called immediately before the mutation, inside the lane's existing
first-application branch. Replay branches never call it.

| Lane | TS call site (OC1, OC2) | Pi call site | Rust call site | Coordinate | On hold |
|---|---|---|---|---|---|
| Tag targets: drops, skeletons, reclaim, dedup, emergency, flush drains, caveman | `protectNewTagMutations` at `transform-postprocess-phase.ts:2015-2020`, re-expressed on `admit` | same helper, `context-handler.ts:6235` | selection exemptions `transform.rs:5409-5413`, caveman `:8865` | `Message{owner id, part index}` per mutation part | unchanged: op stays queued, release request (obligation) |
| 1 Stale ctx_reduce strip | `dropStaleReduceCalls` detect branch (`drop-stale-reduce-calls.ts:139-160`), via `onFirstApplication` | tag target (already above) | `stale_reduce` unit, `transform.rs:14173-14186,14197-14206` | `Message{id, first reduce part}` | skip; id not pushed to `newlyStrippedIds` |
| 2 Synthetic todo move | `applyTodoSynthesis`, bust branch (`:332-447`) | `injectSyntheticTodowriteForPi` bust branch (`pi-todo-inject.ts:244-318`) | todo capture/advance on a bust (`injection.rs:199-241,278-305`; pending at `transform.rs:5590-5609`) | earliest of `Message{old anchor, Whole}` and `Append{new anchor}` | serve the persisted pair at the persisted anchor (the defer path); keep the state difference |
| 3 Coverage fold | already held by `freezeM0M1` (`:2029-2031`) | held by `protectedSignedPrefix` (`context-handler.ts:5572-5573,5924-5930`) | `coverage_fold_due` / `system_absorb_hard_due` (`transform.rs:5285-5295,5641,17179-17213`) | `Prefix` | no fold, no meta advance; publication stays pending; release request |
| 5 Placeholder and system-injected | `stripDroppedPlaceholderMessages`, `stripSystemInjectedMessages` detect (`:3238-3299`) | `stripPiDroppedPlaceholderMessages` detect (`strip-placeholders-pi.ts:178-213`) | `placeholder` unit `transform.rs:14187-14194`; `system_injected*` units `:14113-14148` | `Message{id, Whole}` or `{id, block}` | skip; not added to the persisted delta |
| 6 m[0]/m[1] re-render | `injectM0M1` with no cached pair (`:3090-3115`), and the outer `freezeM0M1` (`transform.ts:1155-1181`) | Pi cached-prefix path (`context-handler.ts:5924-5930`) | not exposed; keep the `Recomp` test as a guard | `Prefix` | serve the last-served pair (section 7) |
| 7 Processed-image strip | `stripProcessedImages` detect (`:3068-3086`) | `strip-processed-images-pi.ts:111` (held today only because its drop is held) | `processed_image` units `transform.rs:14207-14235` | `Message{id, first image part}` | skip; id not persisted |
| 8 Rust-mode host strip | `applyRustModeThinkingStrips` (`:983-1070`) | n/a | n/a | thinking removal, not a content edit (below) | never remove current-turn thinking |
| 9 Temporal markers | `freezeTemporalDecisions` on a bust (`:2300-2316`) | gap: whether Pi renders temporal markers was not checked | gap: same | `Message{user message id, first text part}` | keep the NULL row; the marker is not inserted |

**Thinking removals: a companion check, not admission.** Merged-reasoning stripping, binding
recovery, reasoning clearing and the bust-time freezes remove thinking; they do not edit
content. They need one rule, `mayRemoveThinking(messageId) = message is not in the current
turn`, plus the "all older-turn thinking" requirement from section 1. Finding 8 breaks the
first half. A frozen-release pass computes `stripFrom` from `frozenReleaseLastServed`, but
`rust-mode-transform.ts:4246-4256` passes `protectedThinkingMessages` only while thinking
recovery is restoring. The fix is to always pass the current-turn set, on every path that
can strip, and to assert it in `applyRustModeThinkingStrips`. This needs a host-level test
in the Rust-mode transform tests: park or last-known-good replay, then release, in a
thinking turn.

## 6. Claude Code (finding 4)

**What THALAMUS found** (gateway source and 1,164 captured request bodies):

- The Claude Code client resends earlier turns' signed thinking. 598 of 631 requests with
  earlier-turn assistant messages carry it.
- After ck-mc's transform, 390 of 590 such bodies carry fewer earlier-turn signed blocks, and
  121 carry none.
- The production gateway (`aaf1550`) never alters thinking and sends no binding control.
- The gateway's master branch (stage 7, not deployed) sets `drop_block` plus the
  `thinking-binding-controls-2026-08-01` beta, on Fable 5.1 and Opus 5.5 (adaptive or
  enabled) and on Sonnet 5.5 and Haiku 5.5 (adaptive only).
- A 400 on a rewritten body is returned to Claude Code as a 503, which it retries about 12
  times over about 3 minutes (each retry is a fresh transform) before it fails the turn. A
  bare 400 is terminal.

**Fold or strip? From ck-mc's code, for prefix-bound models it is fold, not strip.** The
module has two ways to remove thinking in this profile, and neither runs here:

- `reasoning_age` strip units for Claude Code need `cc_reasoning_cutoff`
  (`transform.rs:14151-14171`). That comes from `reasoning_clear_cutoff_with_tags`, which
  returns `None` for prefix-bound models (`:16908-16913`).
- The merged-assistant residual strip is off for `ClaudeCodeAnthropic`
  (`healing.rs:150-156`).

For Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5, a body with fewer earlier-turn signed
blocks therefore lost them because their messages left the array: a compartment fold
trimmed them into m[1]. For other models, which the captures may include, `reasoning_age`
does strip whole blocks on a bust. **THALAMUS should split the 390 and 121 by `model_key` to
confirm.** For prefix-bound models the 269 bodies that keep *some* earlier-turn blocks after
a fold changed their prefix are each a strict-binding 400 today, or silent loss under
`drop_block`. The `claude_code::control_at_new_user_turn` audit test reproduces exactly this.

**Recommendation: yes, ck-mc strips all completed-turn thinking on such a bust, even after
`drop_block` deploys.** The condition is: the profile is `claude-code-anthropic`, the model
is prefix-bound, and an admitted edit (including a fold) lands before a kept completed-turn
signed block. The strip removes the thinking blocks of every assistant message outside the
current turn. It is minted as a frozen strip unit in the same CAS commit as the edit that
required it, and replayed on every later pass, because the client resends those blocks on
every request. Reasons:

- **It is the only valid request.** A partial strip turns into a middle removal (section 1).
  Keeping the blocks is invalid. Removing the current turn's blocks is forbidden.
- **`drop_block` is a safety net, not the mechanism.** The production gateway sends nothing,
  so the account default decides: a 400 for accounts created on or after 2026-08-31, silent
  loss for older ones. The master branch's `drop_block` silently drops the same blocks, still
  bills their bytes as input, and depends on the gateway version and the model list. A strip
  gives the same model-visible result deterministically, with fewer input tokens and no
  dependency on the gateway.
- **The 503 retry loop makes failures expensive.** Each of about 12 retries re-runs the
  transform, which replays the frozen edit and gets the same 400. Avoiding the 400 matters
  more on this route than on OpenCode.

The OpenCode Rust-mode host keeps its own strip (`applyRustModeThinkingStrips`) for now.
Moving it into the module for both profiles would leave one owner. That is a follow-up, not
part of this fix.

**Still needs THALAMUS:**

1. the per-model split above;
2. whether the Claude Code client itself ever edits its history mid-turn, for example by
   clearing old tool results to save context. Such an edit is before kept thinking and is
   outside Magic Context's control, so admission cannot hold it;
3. whether the client already sends `context_management` (server-side clearing) itself;
4. that the gateway forwards the module's message array unchanged apart from headers and
   the stage-7 binding field.

## 7. A held m[0]/m[1] re-render (finding 6)

The problem: `clearCachedM0M1` runs inside recomp promotion
(`compartment-runner-recomp.ts:125-143`), history-boundary repair
(`history-boundary-repair.ts:139-147,233-252`), the store-generation rebase
(`store-generation-rebase.ts:965`) and several compartment writers
(`compartment-storage.ts:421,456,495,701,743`). The next pass has no complete pair, so it
renders a new one from the current compartments and trims raw history to match. This
happens even on a defer pass (TS and, per the new test, Pi).

**Decision: keep a last-served copy and replay it until the turn ends. Do not refuse.**

- **What is stored.** A `served_m0m1` record per session: the exact m[0] and m[1] bytes, the
  trim boundary as a served-occurrence coordinate (the id of the last raw message the pair
  absorbed, never an array index or an object), and the store generation it belongs to. It
  is written in the same transaction that records a pair as served. It is *not* cleared by
  `clearCachedM0M1`. It is replaced only when an admitted re-render is actually served.
- **When it is used.** The admission frame has a boundary, the cached pair is absent, and
  `admit(Prefix)` holds. The pass then serves `served_m0m1` and trims raw history up to its
  recorded message id, exactly as `prepareCachedM0M1Replay` does for a cached pair
  (`inject-compartments.ts:3905-3957`). The pass is marked contention-exhausted, as the
  frozen replay is today (`transform-postprocess-phase.ts:3090-3096`), so the refresh stays
  pending and lands on the first pass of the next turn.
- **When it cannot be used.** If the recorded trim id is not in the live array, the host
  has rewritten history under the served prefix (a revert), so the request is not a replay
  of what was sent whatever Magic Context does. Fall back to a normal render. The binding
  recovery path then handles any 400. The store-generation rebase must carry
  `served_m0m1` into the new generation unchanged, because bytes do not depend on the
  generation.

Why replay rather than refuse:

- The last-served bytes are valid by construction: the provider minted every kept block
  against them.
- The writers that clear the cache are background maintenance. A refusal would turn each of
  them into a failed request on every pass until the turn ends. A subagent would die, and
  Claude Code would retry about 12 times first.
- The cost is staleness: the improved summary from a recomp waits until the turn ends.
  Holding tag drops costs the same kind of delay.
- Storage is one pair per session, the same size as the cache it shadows.

## 8. Subagents, the force band and the 95% wall

A subagent's whole run is one turn. On a prefix-bound model the boundary is the newest
signed block, so every edit before it is held for the whole run. On strict accounts Magic
Context can reclaim nothing that precedes the newest thinking until the subagent finishes.
That is the cost of correctness, and the design states it rather than hiding it.

What still works: content **after** the boundary can be edited. That is the tool results the
model has received since its last thinking block, usually the newest and often the largest
input. Pi's 95% wall already drops the newest tool result, which the audit found valid.

**Force band (85% by default).** Hold, and do not bust. Log once per force episode that
reclamation is held by signed thinking, with the held edit count and the current usage. No
pass manufactures a bust.

**95% wall.** In order:

1. **Admitted tail reductions.** Apply emergency reductions only to coordinates the frame
   admits, which means results after the boundary. All runtimes do this, as Pi does today.
2. **End the subagent turn early, if still at or above the wall.** Append one synthetic user
   instruction at the end. Appending is valid. It tells the model that context is nearly
   exhausted and that it must stop calling tools and report what it has found. The
   instruction is frozen at its position (`Append{after_id}`) and replayed on later passes,
   like the synthetic todo pair.
3. **Refuse visibly only if the append is impossible**, for example a host that cannot carry
   a synthetic message. Refuse with a Magic Context error that names the reason, rather than
   letting the provider fail on context length.

**Why ending early is least bad.** Without it the run fails for certain, either at the
provider's context limit or by refusal, and the parent loses all of the subagent's work. A
wrap-up step turns that into a completed run with a partial report, which the parent can
continue from or re-delegate. It needs no invalid edit.

Two unknowns need a live check before this ships:

- whether the model honours the instruction promptly;
- whether a user-role text block appended after a `tool_result` is accepted mid-loop with
  kept signed thinking. The rule says appends are valid, but this shape was not in the live
  report.

### Server-side context editing (`clear_tool_uses_20250919`): assessment only

**It should be studied as the reclamation path inside signed loops, starting with
subagents.** It is the only known mechanism that reduces model-visible tool output without a
client-side edit. Per Anthropic's docs, clearing happens server-side and is not a binding
edit. The audit found that OpenCode 1.18.30 already passes `contextManagement` model options
and adds the beta header, and that Magic Context never uses it.

Unknowns a design note would have to settle, with live tests:

- whether it is supported on Vertex, Bedrock, Copilot, and OAuth subscription routes;
- whether it interacts with `block_binding` strict mode, and with `drop_block`;
- cache cost: clearing invalidates the cache from the clearing point
  (`reasoning-cleanup-per-provider.md:141`), and how often to clear (`clear_at_least`
  batching);
- whether cleared content is still billed as input, and how `usage` reports it. Magic
  Context's pressure signals read usage, so a cleared session may look smaller than its
  request bytes;
- how the server's placeholders interact with `§N§` tags, `ctx_reduce` (the agent may ask
  to drop a result the server already cleared) and Magic Context's token accounting;
- the server, not Magic Context, picks what is cleared. Magic Context cannot replay or
  predict it, so its own view of the request drifts from the model's;
- `exclude_tools`: `ctx_reduce`, `todowrite` and protected tools would need excluding;
- emitters: anthropic-auth, the Pi and OpenCode request builders, and the Claude Code
  gateway, and whether the Claude Code client already sends it.

### Should OpenCode and Pi requests set `drop_block`?

**What ANTAUTH found** (anthropic-auth main source, not a live-wire measurement):

- `applyThinkingBindingControls` covers Fable 5.1, Opus 5.5 and Sonnet 5.5; Haiku 5.5 is only
  on an unmerged candidate.
- The default `account-default` sends nothing. Only a configured `error` or `drop_block`, with
  replayable thinking and `thinking.type=adaptive`, writes the field.
- Sonnet `between_tools` gets nothing. OpenCode adds the beta only when the field exists. Pi
  applies the body controls only with its OAuth identity. API-key routes are excluded.

These citations are in the anthropic-auth repository (`core/thinking-binding.ts:51-72`,
`opencode/transform.ts:179-192,1375-1378`, `pi/convert.ts:709-714`), not in this one.
**So Magic Context must not assume `drop_block` on OpenCode or Pi.** By default the account
decides, which means a 400 on accounts created on or after 2026-08-31.

The trade-off:

- **Gain:** a defect no longer fails the turn. That matters most for subagents and for
  OpenCode 2, which does not retry a 400.
- **Cost:** the same defect becomes invisible. The model silently loses the dropped block
  and every later one, which is mid-turn reasoning in exactly the cases this design is
  about. The bytes are still sent and billed. Nothing in this repository can observe a drop,
  and whether the API reports dropped blocks is unknown.

**Recommendation.** Do not ask the owners to enable `drop_block` as a substitute for the
hold. Once the hold ships with the strict suites as a CI gate, `drop_block` is a reasonable
production safety net *if* the API reports a drop in a way Magic Context can log. Without
such a signal it should stay off on at least one canary configuration, so that defects keep
surfacing as 400s. The anthropic-auth and host owners decide this. Magic Context's job is
that its own requests are valid under `error`.

## 9. Test plan

### Acceptance: the strict audit suites

The three audit suites are the acceptance gate. This delivery extends them so that
`MC_AUDIT_STRICT=1` asserts the whole contract for **every** lane, not just validity:

1. the mid-loop bust is valid;
2. no byte outside thinking changed (Pi's 95% wall, which edits after the boundary, is the
   one documented exception);
3. the lane's edit is not served, and queued ops are still queued;
4. **defer byte identity:** an immediate repeat pass with no new response serves exactly the
   same request, including thinking. A held edit that leaked into persisted state would be
   replayed here and fail this check;
5. the loop continues validly for two more steps;
6. **release** (primary only): after the turn ends and a real user message starts the next
   one, the same state lands the lane's edit validly, with nothing re-queued or re-armed.

Without `MC_AUDIT_STRICT` the exposed lanes still assert their exact 400, and Rust's
`release_gap` lanes assert that they do not release. Today's results:

| Suite | Default | `MC_AUDIT_STRICT=1` today | Must be after the fix |
|---|---|---|---|
| OC1 TS / OC2, `packages/plugin/.../signed-thinking-prefix-audit.test.ts` | 78 pass | 64 pass, 14 fail (the audit's 14) | 78 pass |
| Pi, `packages/pi-plugin/src/signed-thinking-prefix-audit.test.ts` | 38 pass (one new lane) | 35 pass, 3 fail: m[0]/m[1] recomp (new), synthetic todo, frozen-sentinel | 38 pass |
| Rust, `crates/mc-module/tests/signed_thinking_prefix_audit.rs` | 6 pass | 3 pass, 3 fail: `opencode_rust_mode::primary_mid_loop` (first failure is the DropFull release; HardFold, Todo, Placeholder and the other release gaps follow), `claude_code::primary_mid_loop`, `claude_code::control_at_new_user_turn` | 6 pass |

The Rust functions loop over lanes and stop at the first failure. `MC_AUDIT_LANE=<Lane>` runs
one lane. After the fix, the `EXPOSED` sets, `exposed()` and `release_gap()` are deleted, and
the strict assertions become the default.

**One test fix in this delivery.** Pi's reasoning-clearing predicate looked for
`mock-signature-1` as a substring, so `mock-signature-10` matched once a run had ten
receipts. It now matches the quoted signature.

### Unit corpus for the check itself

One JSON corpus is read by both a TS test and a Rust test, with identical expected verdicts:

- no current-turn thinking (admit all);
- boundary in the last message, edit in an earlier message (hold);
- edit in the tail (admit);
- edit in the boundary message before and after the anchor part;
- a replayed skeleton clone before the boundary. This is the identity regression: it must
  hold, while today's identity map treats it as `Infinity`;
- merged consecutive assistants;
- `redacted_thinking` as the anchor;
- unsigned or empty reasoning, which is not a boundary;
- a binding-recovery-stripped block, which is not retained;
- `Prefix` (hold whenever a boundary exists);
- `Append` after the boundary and before it;
- a message without an id (hold);
- a model that is not prefix-bound (admit all).

### Mutation controls, one per lane

Each control neutralizes one admission call site, making it return "admit". It runs the
named strict test, and only that lane's tests may go red with `PREFIX_ERROR`.

| Control | Expected red (strict) |
|---|---|
| TS stale-reduce `admit` | `OpenCode 1 TS mode, primary mid tool loop > stale ctx_reduce strip`, and the subagent run test of the same name; OC2 the same |
| TS todo `admit` | `… primary mid tool loop > synthetic todo` |
| TS placeholder `admit` | `… frozen-sentinel first application` (primary and subagent) |
| TS image `admit` | `… processed image strip` |
| TS `Prefix` hold, with `served_m0m1` replay neutralized | `… m[0]/m[1] re-render after a recomp clears the cached pair` |
| TS tag-target `admit` | every held tag lane (drops, reclaim, dedup, 85%, 95%, flush, caveman), as in the audit's own proof |
| Pi todo / placeholder / prefix `admit` | `Pi/OMP, primary mid tool loop > synthetic todo` / `> frozen-sentinel first application` / `> m[0]/m[1] re-render …` |
| Rust coverage-fold `admit` | `opencode_rust_mode::primary_mid_loop` with `MC_AUDIT_LANE=HardFold`, and `claude_code::…` |
| Rust todo / placeholder `admit` | the same functions with `MC_AUDIT_LANE=Todo` / `Placeholder` |
| Rust release request removed | `opencode_rust_mode::primary_mid_loop`, `MC_AUDIT_LANE=DropFull` (release step) |
| Claude Code completed-turn strip removed | `claude_code::control_at_new_user_turn` |
| **Leak control:** persist a held id (stale reduce, image) or the held todo state | the repeat-pass byte-identity assertion of that lane |
| **Trigger control:** consume `pendingMaterializationSessions` on a held flush | `… /ctx-flush` release step |
| Temporal `admit` (after its lane is added) | the new temporal-marker lane |

Every mutation is applied and restored with the staged `git diff --stat` sequence, never a
stash, and the restored tree must show an empty diff.

### Parity gaps to close in the suites

These lanes are still missing from one or more suites:

- the temporal-marker lane (TS; Pi and Rust if they render markers);
- `stripSystemInjectedMessages` (TS) and the `system_injected*` units (Rust);
- the Rust-mode host frozen-release strip (finding 8), as a host-level test;
- the Rust lanes the fixture never prices (skeleton drop, dedup, 85% force band, stale
  reduce). Their fixture needs a pressure profile that lands them in the control first.
  Until then a held result for them proves nothing.

## 10. Cost

The check does not grow with history, and it removes two walks that do:

- **Frame:** one binary search for the turn start (existing), then a backward scan that
  stops at the first retained current-turn block. The scan covers *k* messages, where *k* is
  the number of messages after the last kept block, normally one to three, and the
  retained-ness test touches only those messages. In a subagent that has stopped producing
  thinking, *k* is bounded by the turn. Today's protection already walks the whole turn
  there, and the whole history elsewhere.
- **Each verdict:** O(1) set lookups, plus at most one scan of the parts of one message (the
  boundary message), to find the anchor by signature.
- **Removed:** the per-pass `part → ordinal` map over every part of every message
  (`latest-assistant-turn.ts:81-84`). Also removed: the whole-history copy in
  `retainedActiveThinkingParts` (`:135-154`), and Rust's per-message `clone()` plus replay
  walk in `active_thinking_prefix_edit_ids` (`transform.rs:16779-16810`). Lane scans that
  are already O(history), such as the stale-reduce and placeholder detection loops, are
  unchanged. Admission adds one call per candidate, not a scan.
- **Held state:** none new except `served_m0m1` (one pair per session) and one Rust meta
  flag. Held edits are re-detected from live state at release. Nothing accumulates per pass.

A cost guard test builds a 2,000-message history and asserts that frame construction visits
at most *k* + a small constant messages.

## 11. Rollout order

1. The shared check, its corpus and the tag-target re-expression in TS and Rust. Behaviour
   is unchanged for tag lanes, as the audit's held lanes stay green.
2. The non-tag lanes in this order: placeholder and system-injected strips, stale reduce,
   image, todo, temporal markers, then the Rust coverage fold. Each lane flips its strict
   audit test to green, with its mutation control.
3. The release request (Rust release gap).
4. `served_m0m1`, in TS and Pi.
5. The Claude Code completed-turn strip, after THALAMUS's per-model split confirms section 6.
6. Finding 8's host fix and its test.
7. Delete the `EXPOSED` / `exposed()` / `release_gap()` scaffolding and make strict the
   default.

The subagent wrap-up instruction (section 8) and server-side clearing are separate
follow-ups, each needing a live test first.

## Verification of this design delivery

- `bun test src/hooks/magic-context/signed-thinking-prefix-audit.test.ts` in
  `packages/plugin` (Bun 1.4.2, Linux): 78 pass, 0 fail. With `MC_AUDIT_STRICT=1`: 64 pass and
  14 fail, the same 14 the audit lists.
- `bun test src/signed-thinking-prefix-audit.test.ts` in `packages/pi-plugin`: 38 pass,
  0 fail. Strict: 35 pass, 3 fail (listed above).
- `cargo test -p mc-module --test signed_thinking_prefix_audit` (cargo 1.99.0, Linux):
  6 pass. Strict: 3 pass, 3 fail (listed above). `cargo fmt -p mc-module -- --check` is
  clean.
- No product code, architecture document, package manifest or lockfile changed.
