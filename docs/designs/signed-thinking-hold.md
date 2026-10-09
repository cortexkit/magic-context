# Holding edits before kept signed thinking: one admission check

## Status and scope

**Revision 2.** This is a fix design for review before implementation. Revision 1 (commit
`6668dd20`) was reviewed by an Athena panel; both seats that returned asked for changes while
keeping the core rule. This revision answers that review; the mapping from each finding to
its answer is in the last section, "Changes from r1".

It is based on the audit in
[`signed-thinking-prefix-edits-audit.md`](../reports/signed-thinking-prefix-edits-audit.md),
the live strict-mode report `docs/reports/live-thinking-arc-removal.md` (branch commit
`2811017c`, not in this base),
[`user-append-into-served-carrier.md`](../reports/user-append-into-served-carrier.md) and
[`skeleton-retirement.md`](skeleton-retirement.md).

No product code changes in this delivery. The three audit suites are extended so that
`MC_AUDIT_STRICT=1` asserts the whole contract this design requires (section 11). Without the
variable they stay green and pin what the code does today. `ARCHITECTURE.md` and
`STRUCTURE.md` are untouched: section 10 proposes the replacement wording for the
architecture invariant this design contradicts, for the operator to apply.

**What is guaranteed, and what is not.** The guarantee is scoped to Magic Context's own
edits: no edit that Magic Context makes to a request lands before a kept current-turn signed
thinking block. Edits made by the host or by a replay path that bypasses admission are
outside it (section 9). Section 9 says, for each, whether it is detected and recovered or
explicitly out of scope; none is promised as automatic.

**Decision in one paragraph.** Every first-application edit, in every runtime, asks one
question before it changes the request: *does the earliest position this edit touches come
before the last thinking block the current turn keeps?* If it does, the edit is **held**. A
held edit is not applied, not persisted as served or frozen, and does not use up the trigger
that offered it. Work withheld from a pass that was independently authorized to bust is
released on the first pass of the next turn. When the boundary cannot be resolved, the check
fails closed and holds. TypeScript (OpenCode 1, OpenCode 2 and Pi) and the Rust module
(OpenCode 1 Rust mode and Claude Code) each get one implementation of this check, with the
same coordinate and the same verdicts on a shared corpus. The tag-target protection from the
issue 630 fix (`protectNewTagMutations`, `freezeM0M1`) is re-expressed on the same check
only with its whole existing wrapper, a retained-thinking predicate at least as wide as
today's, and the forced `freezeM0M1` flag still OR'd in (section 3).

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

Admission is a binding-safety check only. It does not replace tool pairing, the
latest-assistant protections or the serializer's own validity rules, which stay in force. An
admitted edit after the boundary must still keep every tool arc whole (section 3,
"Coordinate"), and nothing here licenses changes to the newest assistant's own content.

## 2. What still edits today

These are the audit's findings, plus three results from the tests extended for this design
(section 11). "Exposed" means a strict-binding 400 mid-loop, or silent reasoning loss on
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
- **Rust release gap, now explained.** When a lane is held mid-loop, the queued drop, the
  armed `/ctx-flush` refresh, caveman and the image strip have still not landed after the
  next user turn, although the work is still queued or armed. The control lands them when
  the pressure first arrives at a new user turn. r1 left the cause open; this revision
  established it by reading the persisted triggers on every pass of the audit run
  (`MC_AUDIT_DEBUG=1`, and the new trigger assertions in section 11). There are two
  latches, and both spend a trigger on a pass that applied nothing:
  - **The force-band episode** (`DropFull`, `Caveman`, `Image`, and `Wall95` in OpenCode Rust
    mode). The held pass itself leaves `has_prior_emergency_drop` false. The *next* tool-loop
    pass sets it. `refresh_trailing_blank_decisions` (`transform.rs:15889-15962`, called at
    `:7282-7289`) records the newest assistant's trailing-blank decision as a frozen unit
    `strip:trailing_blank_strip:<mid>` on every pass, defer passes included, for the
    `opencode-aisdk` profile on Anthropic. The force latch at `:7341-7357` counts any new
    `strip:` unit that is not `_keep` and not `SYSTEM_STRIP_PENDING` as applied reclaim, so
    this bookkeeping unit spends the episode. At the next user turn `force_episode_available`
    (`:5280`) is false, the pass is a defer, and the latch re-arms only after usage falls 5
    points below the band (`:5728-5742`). Claude Code is not affected: the trailing-blank
    refresh returns early for that profile, and its triggers survive to the next turn (where
    the bust then fails on finding 4).
  - **The `/ctx-flush` arm** (`Flush`, both profiles). The held pass is itself a SOFT
    `explicit_flush` pass: `soft_refresh_pending` makes `independent_rebuild` true
    (`:5285-5295`), so the plan is a provider-prefix mutation (`:5800-5807`) whose only work
    the thinking exemption then declines. Because it is a mutation pass, `soft_refresh_pending`
    is cleared (`:6002-6004`). The response even reports `prefix_bust_permitted=true` while
    no byte changed. Nothing is armed at the next turn.

  TS keeps the request alive through `pendingMaterializationSessions`
  (`transform-postprocess-phase.ts:2232-2238, 2848-2856`), and Pi releases the same lanes,
  but both lose the `/ctx-flush` release across a process restart (section 4).

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
that carries the content, plus where in that message the edit falls. Three coordinates
exist:

```text
EditCoord =
  | Prefix                      // m[0]/m[1], their trim of raw history, anything rendered
                                // before the first raw message
  | Message { id, block }       // an edit inside one raw message; block = the index of the
                                // first touched part, or Whole for the whole message
  | Append { after_id }         // new content inserted after message after_id
```

**The frame array and the id function, per host.** The frame, every coordinate and every
lane's candidates are computed on one array with one id function. Mixing id spaces is a
defect, not a fallback.

| Host | Frame array | Id function | Not an id |
|---|---|---|---|
| OpenCode 1 TS, OpenCode 2 | the transform's `messages` (`MessageLike[]`), the array `protectNewTagMutations` already receives | `info.id` | a missing or empty `info.id` |
| Pi / OMP | the context handler's `workingMessages` (Pi `AgentMessage[]`), index-aligned with `mutationView` as at `context-handler.ts:6204-6215` | `resolvePiStableId` tiers 1 and 2 only: reference identity, then the position-aligned real entry id (`read-session-pi.ts:124-139`) | tier 3 `pi-msg-${index}-…` ids (`:140-143`), which drift when the array shifts; the empty string; todo anchors built from `responseId` or `pi-ts-${timestamp}` (`pi-todo-inject.ts:81-91`) |
| Rust module | `req.messages` | `mid` | none: every message has a `mid` |

Pi's transcript view folds a run of `toolResult` messages into the user message that follows
it, or gives a trailing run a `synth-user-${entryId}` id (`transcript-pi.ts:215-231,
498-548`). Those transcript ids are never coordinates. A lane that finds its candidate in the
transcript maps it back to every `workingMessages` entry the transcript message folds, and
uses the earliest. A todo anchor is translated to its entry id before admission; an anchor
that cannot be translated is unresolved and holds.

**Tool arcs are compound.** A tool call and its result are one arc, and a parallel batch
(every call one assistant message makes, plus all their results) is one compound coordinate
at its earliest position, normally the first call in the assistant message. Any edit that
removes, rewrites or shortens a call or a result of the batch uses that coordinate. A tail
reduction therefore lands on a batch only when the whole batch is after the boundary, and it
can never remove one result while keeping its call: Anthropic rejects an unanswered
`tool_use` whatever the binding says, and Pi already treats an output without its call as an
orphan (`issue-586-pi-responses-orphans.test.ts:46-72`). The occurrences differ per host:
OpenCode keeps call and result in one tool part, which serializes as a `tool_use` in the
assistant message and a `tool_result` in the next user carrier; Pi and the Rust codec keep
each result as its own message keyed by call id (`codec/pi.rs:231-253, 267-303`). The
coordinate is the same in all three.

The boundary is the last retained thinking block of the current turn, written down as
`Boundary { message_id, anchor }`, where the anchor is that block's normalized signature
(below). A signature is byte-stable through replay, cloning and re-serialization. A part
index is not, because a replayed strip earlier in the same message can shift it. The frame
also records `tail`, the set of message ids strictly after `message_id`.

### The retained-thinking predicate and signature extraction, per host

**Retained** is decided exactly as today, so the set is never narrower than the one issue 630
protects: a part is retained when its type is in `THINKING_TYPES` (`reasoning`, `thinking`,
`redacted_thinking`, `latest-assistant-turn.ts:12`), it is in the current turn, and it
survives the persisted binding-recovery, merged-reasoning, cleared-reasoning and
reasoning-removal decisions (`latest-assistant-turn.ts:124-168`). The turn-level gate stays
`hasActiveAnthropicThinkingTurn` (`:50-71`). A signature is **not** required for a part to be
retained, and redacted thinking is never read as empty plaintext. In Pi the existing
exclusions at `context-handler.ts:6211-6229` (frozen binding entries, cleared-through tags,
except redacted parts) stay as they are. In Rust, retained means a `CkKind::Reasoning` or
`CkKind::RedactedReasoning` block in a protected turn after `replay_reasoning_clear` and
`remove_frozen_historical_reasoning`, as `active_thinking_prefix_edit_ids` computes it today
(`transform.rs:16768-16810`).

**The anchor** is extracted from the retained part by one normalizer per host:

| Host | Signed block | Redacted block |
|---|---|---|
| OpenCode (TS) | `metadata.anthropic.signature`, where the audit fixtures and live captures put it; `part.signature` as well. The TS extractor already exists as `replayableOriginal` (`latest-thinking-recovery.ts:71-87`) | `part.data`, or `metadata.anthropic.redactedData` (same function) |
| Pi (TS) | `thinkingSignature` on a `type: "thinking"` part | a `type: "thinking"` part with `redacted: true`; the data is `thinkingSignature`, else `thinking` (`codec/pi.rs:206-227`) |
| Rust | `CkKind::Reasoning.signature`, decoded from OpenCode by `find_signature` (the first nested `signature` key in the part metadata, `codec/opencode.rs:114-142, 1594-1605`) and from Pi as above | `CkKind::RedactedReasoning.data` (`codec/opencode.rs:1585-1592` for OpenCode) |

One OpenCode assistant can keep two signed parts with tool calls after both, so the scan
looks at every retained part, not the first per message, and records the *last* one's own
anchor.

### Verdict

```text
admit(coord):
  if not prefix_bound or frame is None:              Admit
  Prefix:                                            Hold
  Message { id } with id in tail:                    Admit
  Message { id == boundary.message_id, block }:      Admit only if the anchor is resolved and
                                                     block sits after the part whose anchor
                                                     matches, searching from the end of this
                                                     message; no anchor, no match, or
                                                     Whole -> Hold
  Message { id } otherwise, or no stable id:         Hold
  Append { after_id }:                               Admit if after_id is the boundary
                                                     message (with a resolved id) or in
                                                     tail; else Hold
```

**Fail closed.** The frame is `None` only when the current turn has no retained thinking part
at all. When the scan stops at a retained part whose message has no stable id (per the table
above), or from which no anchor can be extracted, the frame is still a boundary, marked
*unresolved*, and the verdicts above hold everything that is not provably after it: the
`tail` messages the scan passed over keep their ids and stay admissible, while the boundary
message and everything before it are held. An unsigned retained part has no anchor, so it is
an unresolved boundary: today it is protected as any other thinking part, and it stays
protected. An anchor that is found more than once in the boundary message is matched from the
end, which is the part the backward scan stopped on; an anchor that is not found holds the
whole message. Every unresolved frame is logged with its reason.

A message with no stable id is held, not guessed. Every replay-backed lane already refuses
to detect such messages (`drop-stale-reduce-calls.ts:109-111`;
`strip-placeholders-pi.ts:137-149`), so this changes nothing for them.

### Frame construction (once per pass)

The frame is built once per pass, before the first first-application edit, from a view in
which the persisted thinking decisions have been reproduced. It does not move any
established stripping earlier in the pipeline: like `retainedActiveThinkingParts` today it
works on copies (`latest-assistant-turn.ts:135-160`), so replay order, which Pi persists
because it affects non-thinking rendering (`provider-error-recovery-pi.ts:330-350`), is
unchanged.

One reverse scan from the end of the array does both jobs that r1 gave to two helpers. It
visits messages from the last one backwards, and for each message it checks, in this order:

1. Is it a real user message by the `isInActiveAnthropicTurn` rule (not synthetic, not a
   `synth-user-` id, not made only of synthetic, ignored or tool-result parts,
   `active-anthropic-turn.ts:17-36`)? Then the turn starts after it: stop with
   `boundary = None`.
2. Does it hold a retained thinking part? Then stop: that message is the boundary, its last
   retained part is the anchor, and either may be unresolved as above.
3. Otherwise add its id to `tail` and continue.

The scan stops at the first of the two, so it visits the messages after the last retained
block and nothing more when the turn has thinking. When it has none, the scan walks back to
the last real user message, which is the length of the current turn. Section 12 gives the
cost.

**Replay is not order-independent, and the frame does not pretend it is.** r1 claimed no
replay removes current-turn thinking. That is false for already-frozen decisions: an exact
frozen merged-reasoning omission replays without consulting active-turn protection
(`strip-content.ts:930-956`), and Pi's frozen binding omissions skip active entries only
while restoring (`provider-error-recovery-pi.ts:207-211, 256-271`). Those are authoritative
legacy replay of bytes already served, not new removals, and they stay as they are. The
frame reproduces them on its copy, so a part they remove is not retained and cannot be the
boundary. The rule this design adds is narrower: no lane may *newly* remove current-turn
thinking (section 5, "Thinking removals").

### Interfaces

TypeScript, one module shared by OpenCode 1, OpenCode 2 and Pi (for example
`packages/plugin/src/hooks/magic-context/edit-admission.ts`, which Pi imports as it imports
`latest-assistant-turn.ts` today):

```ts
type EditCoord =
    | { kind: "prefix" }
    | { kind: "message"; id: string | undefined; block: number | "whole" }
    | { kind: "append"; afterId: string };

type Frame =
    | { kind: "none" }                                   // no retained thinking in the turn
    | {
          kind: "boundary";
          messageId: string | undefined;                 // undefined: unresolved, fail closed
          anchor: string | undefined;                    // undefined: unresolved, fail closed
          tail: ReadonlySet<string>;
      };

interface EditAdmission {
    readonly frame: Frame;
    /** Pure: answers and records nothing. */
    admit(coord: EditCoord): boolean;   // false = held
}

function createEditAdmission(args: {
    messages: readonly MessageLike[];      // the host's frame array (table above)
    stableId: (message: MessageLike, index: number) => string | undefined;
    prefixBound: boolean;
    isRetainedThinking: (message: MessageLike, part: unknown) => boolean;
    anchorOf: (part: unknown) => string | undefined;
}): EditAdmission;
```

Rust, in `crates/mc-module/src/` next to the active-turn helpers:

```rust
pub(crate) enum EditCoord<'a> { Prefix, Message { mid: &'a str, block: BlockPos }, Append { after_mid: &'a str } }
pub(crate) enum Frame { None, Boundary { mid: Option<String>, anchor: Option<String>, tail: HashSet<String> } }
pub(crate) struct EditAdmission { frame: Frame }
impl EditAdmission {
    pub(crate) fn new(core: &CoreState, req: &TransformRequest) -> Self;
    pub(crate) fn admit(&self, coord: EditCoord<'_>) -> bool;   // pure
}
```

`admit` is a pure query. It does not record holds, and it never creates a release
obligation (section 4, rule 4). The existing `onFirstApplication(message, partIndex)`
callbacks become the admission point. They are already threaded through
`dropStaleReduceCalls`, `stripProcessedImages`, the placeholder and system-injected strips
(`strip-content.ts:65,180,1010`), and Pi's image and placeholder strips
(`strip-processed-images-pi.ts:49`, `strip-placeholders-pi.ts:123`). The difference is that
they are now asked *before* the mutation and return a verdict. Today they record *after* the
mutation (`transform-postprocess-phase.ts:2440-2446`, Pi `context-handler.ts:5618`). Each
lane, not `admit`, reports what it actually withheld, so telemetry and obligations come from
work that was attempted.

### Tag targets on the same check, without losing issue 630

`protectNewTagMutations` keeps its whole output contract, unchanged: a target that may not
mutate gets `thinkingDropProtected: true`, `thinkingRewriteProtected` set to whether it is a
prefix edit, `canDrop: () => false`, every mutator (`drop`, `truncate`, `skeletonReal`,
`skeletonStripped`, `editMarker`, `editMarkerStripped`) returning `"incomplete"`, and
`setContent` refused for a prefix edit and otherwise allowed only with `keepReasoning: true`
(`latest-assistant-turn.ts:104-119`). `dropsThinking` stays exactly as it is, including on
models that are not prefix-bound: a target whose `dropReasoningParts` would drop any retained
part, either of two signed parts in one message included, is protected (`:98-99`).

What changes is only the `prefixEdit` test: each `mutationParts` entry (or the target's
message) maps to `Message { id, block }` in the host's id space and asks `admit`, instead of
comparing part-identity ordinals. Because the retained predicate is today's, an unsigned or
unresolvable retained part makes an unresolved boundary, and every tag target in or before
its message stays protected, which is at least today's protection. `freezeM0M1` stays
`args.freezeM0M1 || !admit(Prefix)` (today `args.freezeM0M1 || (activeThinkingTurn &&
prefixBound)`, `transform-postprocess-phase.ts:2029-2031`): the forced flag remains OR'd in.

The re-expression ships only after parity is shown: the corpus (section 11) carries every
issue 630 fixture, the strict tag lanes stay green with production signature shapes
(`metadata.anthropic.signature` for OpenCode, `thinkingSignature` and `redacted` for Pi), and
a parity test runs the old and new `prefixEdit` side by side over the audit fixtures and
asserts the new one protects a superset. Until then the old map stays and admission is added
beside it. The same applies in Pi (`context-handler.ts:6199-6243`). In Rust,
`active_thinking_prefix_edit_ids` and its consumers (selection exemptions at
`transform.rs:5409-5413`, the strip units at `:14113-14186`) ask the frame instead of
building their own ordinal walk, under the same parity test.

## 4. What "held" means

A held edit obeys four rules. The first three are what already makes a held tag drop safe
in TS today. The fourth is what the Rust release gap and the restart gap are missing.

1. **Not applied.** The lane leaves the request bytes exactly as replay produced them. A
   compound edit is admitted or held as a unit, using the earliest coordinate it touches.
   The todo move is one case: it removes the pair at the old anchor and inserts it at the
   latest assistant, and applying only half would duplicate or lose the `todowrite` pair. A
   tool arc, and a parallel batch, is the other (section 3).
2. **Not persisted as served.** Nothing that a later pass replays is written: no frozen id
   (`addStaleReduceStrippedIds`, `addProcessedImageStrippedIds`, the placeholder delta), no
   todo state, call id or anchor (including the clear of an old anchor), no m[0]/m[1] cache,
   no Rust frozen unit and no served-derived Rust field in the CAS commit (the table below).
   The pass also does not call `recordFirstApplicationAt`, so
   `firstApplicationEdits.beforeNewerThinking` stays false and `freezeReasoningOnBustingPass`
   strips nothing because of the held work. If nothing is admitted, a later defer replays
   exactly the bytes of the held pass, which are the bytes sent before it.
3. **Trigger not consumed.** A held pass, and every later pass of the same turn that applies
   nothing, leaves every trigger as it found it: queued pending ops and agent drops,
   `pendingMaterializationSessions`, `historyRefreshSessions`, Pi's pending-materialization
   and history-refresh signals, the Rust soft-refresh arm, the force-episode latch
   (`has_prior_emergency_drop`), the todo state difference and an unrendered compartment
   publication. TS already does this for ops (`:2848-2856`). Rust does not, and section 2
   names the two latches that spend a trigger today.
4. **Released at the turn boundary, only for real obligations.** See "Release obligations"
   below.

### Rust: what a held pass may commit

CAS makes a commit atomic; it does not make it correct. `commit_transform` persists whatever
the planner hands it (`mc-store/src/lib.rs:10663-11105`). The fields of `TransformCommit`
(`:5269-5299`), their producers, and the rule for a pass on which admission held work:

| Field | What the commit writes | Producer | On a held pass |
|---|---|---|---|
| `core` frozen units and sections | `mc_cache_state` core blob and section rows (`:10853-10906`) | the plan's strip, reduction, caveman, coverage and render steps | **unchanged** except units for admitted coordinates. Bookkeeping units such as `strip:trailing_blank_*` (`transform.rs:15889-15962`) may still be written, but must not count as reclaim (below) |
| `consumed_drop_ids` | deletes `pending_agent_drops` rows (`:11101-11105`) | `consumed_pending_drop_ids` (`transform.rs:7461-7467, 9401-9451`): newly frozen targets, or targets proven obsolete | **never** a held target. Retiring a target proven obsolete (covered, already frozen, structurally unappliable) is allowed, because it does not depend on the hold |
| `first_applied_command_ids` | sets `mc_reduce_command_ledger.first_applied_at_ms` (`:11091-11099`) | `first_applied_pending_command_ids` (`transform.rs:9375-9398`), only targets frozen this pass | unchanged for held targets (already true: it needs an application) |
| `overlays.temporal_marks`, `tag_mints`, `user_hint`, `channel1_append` | `mc_tags`, temporal marks, `mc_user_hints`, `mc_channel1_appends` (`:10976-11089`) | `compute_active_overlay_decisions` (`transform.rs:11552-11802`), `maybe_decide_live_user_hint` (`:5874-5905`) | **none** whose position is held. Today they are discarded only when the pass is not a mutation pass (`:5823-5835`); a SOFT pass whose work was all held (the flush case) currently commits them |
| `overlays.max_seen_ordinal` | `mc_overlay_frontiers`, by `MAX` | the same overlay computation (`:11762-11785`) | **must not pass** a held mark or hint. A later insertion only lands at an ordinal above the previous frontier, so advancing it over withheld work loses that work for good |
| `meta.soft_refresh_pending` | meta blob | cleared at `transform.rs:6002-6004` on any mutation pass | **unchanged** while its work is held |
| `meta.has_prior_emergency_drop`, `last_emergency_input_sample` | meta blob | set at `:7341-7357` when a force-band pass mints a qualifying unit | set only by a unit that changed served bytes for an admitted coordinate; never by a bookkeeping unit |
| todo state and anchor | meta (`set_todo_state`) | bust-only capture (`:6010-6023`, `injection.rs:199-221`) | **unchanged** when the todo move is held |
| coverage, m[1] revision, `deferred_execute_state`, drain latch | meta blob | the plan (`:5285-5303, 5581-5610`) | **unchanged** when the fold or refresh is held |
| release request (new) | meta blob | section 4, "Release obligations" | written when an obligation is withheld |
| `memory_revision`, `compartment_max_seq` | nothing (destructured as `_`, `:10668-10688`) | — | no rule needed |
| `first_divergence`, `scheduler_observation` and counters, `project_root` | `mc_pass_trace`, its history, `mc_transform_session_roots` (`:10917-10973`) | the pass trace | **observation, allowed**: they do not change request bytes |
| identity adoption (`last_provider_id`, `last_model_key`, system hash), ingress meta, block-identity and served-fingerprint maps | meta, row tables (`:10827-10838`) | `apply_ingress_meta`, identity adoption (`transform.rs:5718-5726`) | **observation, allowed**: they describe what was served, which is unchanged |

The structural fix is in the planner, not the store. When admission holds every edit a
mutation plan would make, the plan is downgraded to a defer before
`is_provider_prefix_mutation_pass` is computed, so the soft-refresh clear, todo capture,
overlay commit and `prefix_bust_permitted` all see a pass that changed nothing. When some
edits are admitted (a mixed pass), the pass stays a mutation pass, and the rows above marked
"unchanged" are filtered to the admitted coordinates. The force latch at `:7341-7357` counts
only units for admitted reclaim, and excludes the trailing-blank bookkeeping units
regardless of thinking: outside a thinking turn the same unit spends the episode on any
force-band pass that applies nothing, for example one the historian veto holds.

### Mixed passes

A pass can land an admitted tail reduction while an earlier obligation stays held: at the
95% wall the newest tool results are after the boundary, the queued older drop is not. The
rule is that landing *something* never settles an obligation that was not met:

- the force episode is spent only by the reclaim that landed; a held obligation's release
  request survives the pass;
- the release request records the obligations it carries, and is cleared per obligation when
  that obligation's work lands or is cancelled, not when the pass lands anything;
- a queued drop that was held stays in the queue (TS `pending_ops`, Rust
  `pending_agent_drops`).

The new mixed-pass tests (section 11) pin this for TS and Pi. Pi passes today; TS fails only
because it does not yet land the tail reduction (section 8). Rust has no such lane yet
because its 95% wall lands nothing mid-loop in this fixture.

### Release obligations

An **obligation** exists only when two things are both true on a pass: an independent
trigger authorized it to bust (a queued drop riding a permitted bust, an armed `/ctx-flush`,
an available force-band episode, the 95% wall, a HARD fold, or a due coverage fold), and a
lane attempted eligible work for that trigger and admission withheld it. Only then is a
release request recorded, carrying the trigger's original reason. Three consequences:

- **Admission queries never create one.** `admit` is pure. `protectNewTagMutations` visits
  every tag target whether or not an operation will try to mutate it; protecting a target no
  operation attempted records nothing. The caller that executes the authorized operations
  records the obligation from the ones that came back held.
- **Opportunistic discovery stays ride-only.** The stale-reduce strip, placeholder and
  system-injected strips, the image strip, the todo move and temporal markers never create a
  request of their own. They wait for the next permitted bust, as they do outside a thinking
  turn. A forced turn-start bust is paid only for work the user or the pressure model asked
  for.
- **The request is cleared by its own work.** It is cleared when the obligation's work lands
  or is explicitly cancelled (for example the agent's drop is withdrawn, or the pressure
  episode ends below the band), and it keeps its original reason until then, so the
  release pass is priced and logged as that reason.

The first pass with no boundary (normally the first pass after a real user message) treats a
recorded request as a ride.

**Durability.** r1 proposed to reuse TS `pendingMaterializationSessions` and Pi
`signalPiPendingMaterialization`. Both are process memory: the TS sets are fields of the
plugin's live session state (`live-session-state.ts:11-39`), and Pi's signal only adds to an
in-memory set (`context-handler.ts:908-914`) that `clearContextHandlerSession` drops
(`:8257-8266`). The new restart tests (section 11) prove the consequence: a `/ctx-flush` held
mid-loop is lost when the process restarts before the next user turn, in OpenCode 1, OpenCode 2
and Pi alike. A queued drop, the force band and a published compartment survive, because
their triggers are in the database (`pending_ops`, `storage-ops.ts:14-33`, usage, and the
compartment rows). So the release request is **persisted**: a nullable `held_release` column
on `session_meta` in TS and Pi (reason plus the obligations it carries), written in the same
transaction as the pass's other session writes, and read by the transform alongside the
in-memory sets. In Rust it is a field of the module meta committed with the transform.

**Telemetry.** Each lane that withholds work logs its lane, its coordinate and the boundary
message id once per pass, and adds to a per-session `held_edits` counter in the existing pass
metrics. A session where reclamation is continuously held (the subagent case, section 8) must
be visible without reading logs.

## 5. Where each lane calls it

`admit(coord)` is called immediately before the mutation, inside the lane's existing
first-application branch. Replay branches never call it. Every row uses the host's frame
array and id function from section 3; a lane that works on Pi's transcript view maps its
candidate back to `workingMessages` entry ids first.

| Lane | TS call site (OC1, OC2) | Pi call site | Rust call site | Coordinate | On hold |
|---|---|---|---|---|---|
| Tag targets: drops, skeletons, reclaim, dedup, emergency, flush drains, caveman | `protectNewTagMutations` at `transform-postprocess-phase.ts:2015-2020`, re-expressed on `admit` | same helper, `context-handler.ts:6235` | selection exemptions `transform.rs:5409-5413`, caveman `:8865` | `Message{owner id, part index}` per mutation part; a tool part or result uses its arc's compound coordinate | unchanged: op stays queued; a release request only for an operation an authorized bust attempted (section 4) |
| 1 Stale ctx_reduce strip | `dropStaleReduceCalls` detect branch (`drop-stale-reduce-calls.ts:139-160`), via `onFirstApplication` | tag target (already above) | `stale_reduce` unit, `transform.rs:14173-14186,14197-14206` | `Message{id, first reduce part}` | skip; id not pushed to `newlyStrippedIds` |
| 2 Synthetic todo move | `applyTodoSynthesis`, bust branch (`:403-447`), asked before the `part === null` clear (`:414-416`) and before any anchor write | `injectSyntheticTodowriteForPi` bust branch (`pi-todo-inject.ts:259-299`), asked before the `part === null` clear (`:261-265`), the re-anchor (`:285-293`) and the clear on a missing anchor (`:294-296`); the anchor's `responseId` / `pi-ts-` id is translated to its entry id first | todo capture/advance on a bust (`injection.rs:199-241,278-305`; pending at `transform.rs:5590-5609`) | earliest of `Message{old anchor, Whole}` and `Append{new anchor}`; a removal alone is `Message{old anchor, Whole}` | serve the persisted pair at the persisted anchor (the defer path); write, clear or move nothing; keep the state difference |
| 3 Coverage fold | already held by `freezeM0M1` (`:2029-2031`) | held by `protectedSignedPrefix` (`context-handler.ts:5572-5573,5924-5930`) | `coverage_fold_due` / `system_absorb_hard_due` (`transform.rs:5285-5295,5641,17179-17213`) | `Prefix` | no fold, no meta advance; publication stays pending; release request (the fold was due) |
| 5 Placeholder and system-injected | `stripDroppedPlaceholderMessages`, `stripSystemInjectedMessages` detect (`:3238-3299`) | `stripPiDroppedPlaceholderMessages` detect (`strip-placeholders-pi.ts:178-213`) | `placeholder` unit `transform.rs:14187-14194`; `system_injected*` units `:14113-14148` | `Message{id, Whole}` or `{id, block}` | skip; not added to the persisted delta |
| 6 m[0]/m[1] re-render | `injectM0M1` with no cached pair (`:3090-3115`), and the outer `freezeM0M1` (`transform.ts:1155-1181`) | Pi cached-prefix path (`context-handler.ts:5924-5930`) | not exposed; keep the `Recomp` test as a guard | `Prefix` | serve the validated replay manifest, else refuse locally (section 7) |
| 7 Processed-image strip | `stripProcessedImages` detect (`:3068-3086`) | `strip-processed-images-pi.ts:111` (held today only because its drop is held) | `processed_image` units `transform.rs:14207-14235` | `Message{id, first image part}` | skip; id not persisted |
| 8 Rust-mode host strip | `applyRustModeThinkingStrips` (`:983-1070`) | n/a | n/a | thinking removal, not a content edit (below) | never remove current-turn thinking |
| 9 Temporal markers | `freezeTemporalDecisions` on a bust (`:2300-2316`) | gap: whether Pi renders temporal markers was not checked | overlay temporal marks (`transform.rs:11666-11759`), and the frontier rule in section 4 | `Message{user message id, first text part}` | keep the NULL row; the marker is not inserted; the frontier does not pass it |
| 10 Pi proactive older-turn thinking strip | n/a (OpenCode strips with `freezeReasoningOnBustingPass`, already gated on `firstApplicationEdits.beforeNewerThinking`) | `applyPiProactiveThinkingStrip` (`provider-error-recovery-pi.ts:282-350`), today gated only on `cacheBustingPass` and the model | the Claude Code strip (section 6) | companion removal, below | does not run unless an admitted edit landed before kept older-turn thinking on this pass |
| 11 Tail reductions at the 95% wall | the emergency selection, via the tag-target row | Pi's newest-result drop, via the tag-target row | `Emergency95` selection | the compound arc coordinate (section 3) | the arc is kept whole |

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

**The companion strip is a precondition of its edit, in every runtime.** An admitted edit
that lands before kept older-turn thinking is served only together with the strip of all
older-turn thinking, planned and durably persisted on the same pass. If the strip cannot be
completed, the edit is held as if admission had held it. Today Pi's proactive strip skips
an entry without a stable id and, when persisting the strip fails, strips nothing and lets
the reactive recovery handle the 400 (`provider-error-recovery-pi.ts:319-350`); with this
rule either case holds the edit instead. Two triggers the strip must not have: Pi's
`cacheBustingPass` alone (row 10: on a pass where every edit was held, stripping would change
bytes for nothing), and an execute label, TTL expiry or a tail edit after the boundary. The
trigger is an admitted edit before kept older-turn thinking, which is what OpenCode's
`firstApplicationEdits.beforeNewerThinking` already records.

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

**Conditions on the strip** (from the review, all required):

- It is triggered by an admitted edit before kept completed-turn thinking, never by an
  execute label, a TTL expiry or a harmless tail edit.
- It is applied to the body served on the same pass, not only on later replays.
- It is not built on the cutoff walker (`reasoning_clear_cutoff_with_tags`), which can
  remove a middle block (`transform.rs:16908-16910`). It removes every completed-turn
  thinking block the request carries, and on replay it removes every visible completed-turn
  block, not a closed set of ids, so a block the client surfaces later is removed too.
- A failed commit (`CasConflict`, `mc-store/src/lib.rs:10778-10780`) does not send a one-off
  stripped body. A fail-open pass forwards the raw request (`healing.rs:128-129`); it must not
  record the edit as frozen, so the next pass decides again.

**Still needs THALAMUS:**

1. the per-model split above;
2. whether the Claude Code client itself ever edits its history mid-turn, for example by
   clearing old tool results to save context. Such an edit is before kept thinking and is
   outside Magic Context's control, so admission cannot hold it (section 9);
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
happens even on a defer pass (TS and, per the audit test, Pi).

**Decision: replay a complete manifest of what was served, until the turn ends. Never render
a new prefix under kept current-turn signatures.** When the manifest cannot be proven to
reproduce the served request, the pass refuses locally rather than render.

### The replay manifest (`served_m0m1`)

The cached pair is not enough to replay. `prepareCachedM0M1Replay` reads the mural data URL
from its own column and changes the m[0] text depending on it
(`inject-compartments.ts:3909-3921`), and both TS and Pi decide whether the trim boundary is
a partial cut by reading the *current* compartment rows (`isPartialCompartmentEnd` at
`inject-compartments.ts:3871, 3887`; `inject-compartments-pi.ts:2733`). After a recomp the
saved text and the boundary id can both survive while the cut moves by one message. So the
manifest records every decision, as it was served, and nothing in it is re-derived from
compartments:

| Field | What it pins |
|---|---|
| `head` | the emitted head messages exactly as served: m[0] text after the mural decision, the mural image block (data URL and hash) when it was sent, m[1] text. Stored as the serialized head, not as inputs to re-render it |
| `cut` | `none` (no trim), or `{ boundary_id, mode: inclusive \| partial }`: whether the boundary message itself was dropped or kept. The mode is frozen at serve time, never read from `isPartialCompartmentEnd` later |
| `first_kept_id` | the id of the first raw message served after the cut, a cross-check that the cut lands where it did |
| `provenance` | host (`opencode-v1`, `opencode-v2`, `pi`), id space (section 3), the store generation and projection the ids were read under, and the pass that served it |

It is written in the same transaction that records a pair as served. It is *not* cleared by
`clearCachedM0M1` (`storage-meta-shared.ts:575-618` clears the pair, the mural columns and the
baseline id together). It is replaced only when a newly rendered prefix is actually served,
which happens only on a pass where `admit(Prefix)` admits.

### When it is served, and when it may not be

The admission frame has a boundary, the cached pair is absent, and `admit(Prefix)` holds.
The pass serves `head` and applies `cut` exactly as recorded, and is marked
contention-exhausted, as the frozen replay is today
(`transform-postprocess-phase.ts:3090-3096`), so the refresh stays pending and lands on the
first pass of the next turn.

Before serving, the manifest is **validated** against the live array in its own id space:
the host and id space match, `boundary_id` and `first_kept_id` are both present, and
`first_kept_id` is the message right after `boundary_id` (inclusive) or is `boundary_id`
itself (partial). Neither presence nor absence of an id is taken as proof of anything else:

- **An absent id is not a revert.** The transform documents ids that disappear from one
  pass's array and come back, at compaction seams (`transform-postprocess-phase.ts:3274-3280`).
- **A present id is not compatibility.** The OpenCode 1.x/2.x store conversion keeps ids but
  splits some rows and folds others (`store-generation-rebase.ts:704-722`); an id can survive
  while the occurrence after it changes. The generation and projection in `provenance` must
  match the running projection, or the cut must re-validate against it by `first_kept_id`.
  Bytes are carried across a generation change unchanged, but they are served only after that
  validation.

When validation fails while the boundary exists, the pass does **not** render. In order:

1. If the host keeps a compatible full-request snapshot, replay that. The OpenCode Rust-mode
   last-known-good slot is one (`lkg-persist.ts`), with its own input-id and content-digest
   fences; replaying it is still subject to section 9.
2. Otherwise refuse the pass locally with a Magic Context error that names the reason
   (`served prefix cannot be reproduced while signed thinking is kept`), and keep refusing
   until the turn boundary, where `admit(Prefix)` admits and a normal render is valid. The
   refusal is logged and counted with the held edits.

The binding-recovery path is not a fallback here: the audit established that it cannot
repair an invalidated current turn (`signed-thinking-prefix-edits-audit.md:171-179`).

### Upgrade: no cached pair and no manifest

A session upgraded to this design may have neither a complete cached pair nor a manifest.

- **Seed only from a proven served snapshot.** A complete cached pair *is* one: every
  compartment writer clears it in the same transaction as it rewrites compartments (the call
  sites above), so while it is complete, the compartment rows it was rendered from are
  unchanged and the partial-cut decision read from them is the one that was served. The first
  pass after upgrade that loads a complete pair writes the manifest from it, before anything
  can clear it. A persisted full-request snapshot whose fences validate is the other source.
- **No proven snapshot, boundary present:** use a compatible full-request replay if one
  exists, else refuse locally until the turn boundary, as above.
- **No proven snapshot, no boundary:** render normally; that pass's served prefix seeds the
  manifest.

Why replay rather than refuse by default:

- The last-served bytes are valid by construction: the provider minted every kept block
  against them.
- The writers that clear the cache are background maintenance. Refusing on each of them
  would fail every pass until the turn ends. A subagent would die, and Claude Code would
  retry about 12 times first. The refusal path above is kept for the case where replay is
  not provably the served request.
- The cost is staleness: the improved summary from a recomp waits until the turn ends.
  Holding tag drops costs the same kind of delay.
- Storage is one manifest per session, about the size of the cache it shadows. Separating
  render invalidation from the immutable served payload, instead of shadowing the cache, is
  an acceptable implementation of the same contract.

The manifest covers Magic Context's prefix only. A host edit to raw history, such as the
OpenCode late-user splice, changes bytes the manifest does not hold (section 9).
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
   admits, which means whole tool arcs (parallel batches included) after the boundary
   (section 3). All runtimes do this. Pi does it today; TS and Rust hold everything at the
   wall today, and the strict mixed-pass test requires TS to land it (section 11).
2. **Refuse visibly if still at or above the wall.** Refuse the pass with a Magic Context
   error that names the reason (reclamation held by signed thinking, the held edit count, the
   usage), rather than letting the provider fail on context length. This is the existing
   refusal at a proven 95% when nothing can be folded, now also reached when what could be
   folded is held.

**The subagent wrap-up is removed from this fix.** r1 proposed appending one synthetic user
instruction at the wall to end the subagent's run early. It is not part of this design, and
the wall refuses instead, until a live capture with kept signed thinking shows that a
mid-loop user append is accepted. The panel found no such capture, and the reasons to wait
are concrete:

- No capture shows a user text block after a `tool_result` accepted with current-turn signed
  thinking kept. OpenCode's `groupIntoBlocks` merges consecutive user and tool messages into
  one Anthropic user message (`user-append-into-served-carrier.md:35-38`), which settles role
  alternation, not binding.
- **On Pi the append is not a pure append.** Consecutive `toolResult` messages fold into the
  user message that follows them (`transcript-pi.ts:215-231`), so appending a user message
  rewrites the preceding result carrier. If it were persisted as a host user message,
  `time.created` ordering could also place it before the signed assistant, the shape of the
  OpenCode splice (section 9).
- The instruction must stay invisible to `isInActiveAnthropicTurn`, or it becomes the last
  real user message and releases every held edit under still-kept thinking.
- Nothing makes the model obey it, so a hard refusal on the next tool attempt would still be
  needed.

A later design may revisit it with that capture, as an outgoing-array-only synthetic message.

### Server-side context editing (`clear_tool_uses_20250919`): assessment only, not in this fix

Server-side clearing stays out of this fix. **It should be studied as the reclamation path
inside signed loops, starting with subagents.** It is the only known mechanism that reduces model-visible tool output without a
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

## 9. Scope: edits that do not pass through admission

Admission can hold only Magic Context's own first-application edits. Two known paths change
the bytes a kept signature was minted over without passing through it. Neither is promised
any automatic recovery.

| Path | What happens | Classification in this fix |
|---|---|---|
| **OpenCode late user message spliced into a served tool-result carrier** | OpenCode stamps a user message's `time.created` before the step's assistant is created but writes it after that step's history snapshot. Every later load sorts it before that assistant, and `groupIntoBlocks` merges it into the tool-result carrier the previous request ended with (`user-append-into-served-carrier.md:16-39, 96-107`). The assistant's thinking was signed without that text. | **Explicitly out of scope.** It is a host input change, not a Magic Context edit: the bytes it changes are raw history, outside both admission and the m[0]/m[1] manifest (section 7). The owner is OpenCode (`prompt.ts`, per the report). If it produces a binding 400, the existing binding-recovery path behaves as today, which cannot repair the current turn. This fix adds no detection; a detector that compares the live array with the last served request would be a separate design. |
| **Last-known-good replay re-exposing a double-signed assistant** | The OpenCode Rust-mode recovery ladder restores a captured served prefix and appends the current tail without the proactive older-thinking strip, which can re-expose an assistant with two signed parts that the live validator rejects (`cereb-lkg-reasoning-run-2026-09-28.md`). | **Detect and decline, which exists today; no recovery.** The LKG validator declines that shape (`lkg_anthropic_reasoning_run_invalid`) and the pass falls back to the raw request. That report's idea of stripping later reasoning in the replayed tail is not safe and is not part of this fix. LKG replay is not an admission lane, and section 7 uses a full-request snapshot only when its own fences, this validator included, pass. |

The Claude Code client may also edit its own history mid-turn (section 6, "Still needs
THALAMUS", item 2). That is in the same class as the OpenCode splice: out of scope, and not
covered by any promise here.

## 10. Proposal: replacing ARCHITECTURE.md invariant 4

`ARCHITECTURE.md` invariant 4 ends with: *"There is no mid-turn deferral: a tool loop is not a
reason to hold an execute (…)"*. On prefix-bound models this design holds edits inside a
tool loop, so it contradicts the invariant as written, and the next editor who follows the
invariant would undo the fix. The invariants live in the operator-maintained protected region,
so this delivery does not edit them. Proposed replacement for invariant 4, in full; the first
four sentences are unchanged, and the change starts at "Cache cost is never":

> 4. **Automatic reclaim is ride-only, and every lane shares ONE bust permission.** Age sweeps,
> heuristic cleanup, supersession and duplicate dedup never originate a bust: they land only on
> a pass that is already busting for another reason (a fold or refold, a published-history
> refresh into m[1], `/ctx-flush`, or the ≥85% force band). Queued agent `ctx_reduce` drops
> ride that same permission and never originate a bust: marking a message queues it, and the
> drop lands on the next bust cycle. A single per-pass permission decides whether the pass
> busts, and every mutation lane — reductions, m[1] refresh, heuristics, synthetic todo,
> sentinel first-application — consults that same permission; a veto that applies to one lane
> and not another is a defect (the 2026-09-07 ALF split bust: the age sweep bypassed the
> historian veto that held the m[1] refresh, so one threshold crossing became two priced
> busts). Cache cost is never a reason for mid-turn deferral: a tool loop is not a reason to
> hold an execute (the OpenCode detector never engaged and Pi's only measurable effect was
> withholding drops for hours on steered marathons), and Anthropic's incremental tool-loop
> caching makes a held mutation cost strictly more than one applied at first eligibility.
> **Provider validity is the one exception.** On prefix-bound thinking models (Fable 5.1,
> Opus 5.5, Sonnet 5.5, Haiku 5.5) every kept signed thinking block is bound to the bytes before
> it, so every first-application edit, in every lane, asks the one admission check of
> `docs/designs/signed-thinking-hold.md` before it mutates. An edit that lands before the last
> kept current-turn thinking block is held: not applied, not persisted, and its trigger not
> spent. Bust permission authorizes spending cache; it never authorizes invalidating a
> signature. The check is the same for every lane, so it is not a per-lane veto. Edits after
> that block, and every edit on other models, follow the rules above. Work withheld from an
> independently authorized bust is released as a ride on the first pass of the next turn;
> held opportunistic work waits for the next permitted bust, as it does everywhere else.

Invariant 1 ("drain EVERYTHING" into a HARD bust) needs the same qualification, as one added
sentence: *"On a prefix-bound thinking model, the drain still excludes edits the admission
check holds, and those are released at the next turn."*

## 11. Test plan

### Acceptance: the strict audit suites

The three audit suites are the acceptance gate. Under `MC_AUDIT_STRICT=1` they assert the
whole contract for **every** lane, not just validity:

1. the mid-loop bust is valid, which now includes tool pairing (below);
2. nothing before the last kept thinking block changed; outside the 95% wall lanes, no byte
   outside thinking changed at all. At the 95% wall the newest tool results after that block
   may be reduced, in every runtime (`beforeLastThinking` in the shared mock);
3. the lane's edit is not served, and queued ops are still queued;
4. **defer byte identity:** an immediate repeat pass with no new response serves exactly the
   same request, including thinking. A held edit that leaked into persisted state would be
   replayed here and fail this check;
5. the loop continues validly for two more steps;
6. **trigger preservation** (Rust, new): the persisted triggers after those passes equal the
   ones armed before the held pass (`soft_refresh_pending`, `has_prior_emergency_drop`,
   queued agent drops);
7. **release** (primary only): after the turn ends and a real user message starts the next
   one, the same state lands the lane's edit validly, with nothing re-queued or re-armed.

**Added in this revision:**

- **Tool pairing in the provider mock.** `StrictBindingMock.check` now rejects an unanswered
  `tool_use` or an unasked `tool_result` (`ORPHAN_ERROR`) on the request as the SDK sends it,
  with consecutive same-role messages merged. It runs on every request of the TS and Pi
  suites in both modes, and its own unit tests show a parallel batch with one result removed,
  or one call removed, going red while an in-place shortening of the newest result passes.
- **Restart lanes** (OpenCode 1, OpenCode 2, Pi): a queued drop, the 85% force band,
  `/ctx-flush` and a HARD fold are held mid-loop, the process restarts (TS: a new transform
  with empty release sets and per-session caches over the same database; Pi:
  `clearContextHandlerSession`), and the next user turn must release the work. Today
  `/ctx-flush` is lost in all three hosts (`RESTART_GAP`); the other three survive.
- **Mixed pass** (OpenCode 1, OpenCode 2, Pi): the newest step is a parallel batch of two
  reads, an older drop is queued, and usage is at 95%. The pass must be valid with pairing
  intact, change nothing before the last kept block, keep the older drop held and queued,
  land the tail reduction (strict, all runtimes), repeat byte-identically, and release the
  older drop at the next user turn. Pi passes in both modes. TS passes by default and fails
  strict only on the tail requirement, because it lands nothing at the wall today.
- **Rust trigger preservation**, item 6 above. By default it pins today's cause for each
  `release_gap` lane: `Flush` loses `soft_refresh_pending` on the held pass, and `DropFull`,
  `Caveman` and `Image` find `has_prior_emergency_drop` set by the next loop pass. A change in
  either cause turns the default suite red, so the explanation in section 2 cannot go stale
  silently. `MC_AUDIT_DEBUG=1` prints the triggers on every pass.

Without `MC_AUDIT_STRICT` the exposed lanes still assert their exact 400, Rust's
`release_gap` lanes assert that they do not release, and the restart gap and the TS tail
requirement are pinned. Today's results:

| Suite | Default | `MC_AUDIT_STRICT=1` today | Must be after the fix |
|---|---|---|---|
| OC1 TS / OC2, `packages/plugin/.../signed-thinking-prefix-audit.test.ts` | 88 pass | 70 pass, 18 fail: the audit's 14, `release survives a restart: /ctx-flush` and the mixed pass, each in OC1 and OC2 | 88 pass |
| Pi, `packages/pi-plugin/src/signed-thinking-prefix-audit.test.ts` | 43 pass | 39 pass, 4 fail: m[0]/m[1] recomp, synthetic todo, frozen-sentinel, `release survives a restart: /ctx-flush` | 43 pass |
| Rust, `crates/mc-module/tests/signed_thinking_prefix_audit.rs` | 6 pass | 3 pass, 3 fail: `opencode_rust_mode::primary_mid_loop` (first failure is now the DropFull trigger assertion), `claude_code::primary_mid_loop`, `claude_code::control_at_new_user_turn` | 6 pass |
| Mock, `packages/plugin/.../__tests__/strict-binding-mock.test.ts` | 11 pass | (no strict mode) | 11 pass |

The Rust functions loop over lanes and stop at the first failure. `MC_AUDIT_LANE=<Lane>` runs
one lane. After the fix, the `EXPOSED` sets, `exposed()`, `release_gap()` and `RESTART_GAP`
are deleted, and the strict assertions become the default.

### Serialized-wire agreement (with the implementation)

Each suite's `wire()` models its host's adapter, and the mock merges consecutive same-role
messages as the SDK does. With the admission module in place, one more assertion runs on
every first-application edit of every lane: for an admitted edit, the first differing block
between the request before and after the edit is after the last kept thinking block *on the
serialized wire*; for a held edit, no block differs. This is what proves that coordinates on
the host array match the final serialized occurrences, including OpenCode's two occurrences
per tool part, Pi's separate result messages and its transcript folding. Where the real
converter is available in the package (OpenCode's `@ai-sdk/anthropic` `groupIntoBlocks`), a
second variant runs it instead of the model. It cannot be written before the module exists,
because it compares the module's verdict with the wire.

### Unit corpus for the check itself

One JSON corpus is read by both a TS test and a Rust test, with identical expected verdicts:

- no current-turn thinking (admit all);
- boundary in the last message, edit in an earlier message (hold);
- edit in the tail (admit);
- edit in the boundary message before and after the anchor part;
- two signed parts in one OpenCode assistant with a tool after both: the anchor is the second;
  an edit between them holds;
- the same signature twice in one message: matched from the end;
- each signature representation: OpenCode `metadata.anthropic.signature`, OpenCode redacted
  (`data`, `metadata.anthropic.redactedData`), Pi `thinkingSignature`, Pi `redacted: true`,
  Rust `Reasoning.signature` and `RedactedReasoning.data`;
- an unsigned non-empty retained part: an unresolved boundary, never `None`;
- a boundary message without a stable id, including a Pi tier-3 `pi-msg-*` id: unresolved;
  the tail after it stays admissible;
- a Pi `synth-user-` transcript carrier: maps back to the entries it folds;
- a parallel batch with every call after the boundary (admit) and with the first call before
  it (hold, whichever result is targeted);
- a replayed skeleton clone before the boundary. This is the identity regression: it must
  hold, while today's identity map treats it as `Infinity`;
- merged consecutive assistants;
- a binding-recovery-stripped block and a frozen merged omission, which are not retained;
- `Prefix` (hold whenever a boundary exists);
- `Append` after the boundary and before it;
- a model that is not prefix-bound (admit all; `dropsThinking` still protects).

Issue 630 parity runs beside it: over every audit fixture, the new `prefixEdit` must protect
a superset of what the identity map protects today.

### `served_m0m1` and release cases

- upgrade with a complete cached pair (seeds the manifest); upgrade with neither (refuses at
  a boundary, renders without one);
- a mural-bearing head, a partial cut and an inclusive cut, each replayed byte-identically
  after a recomp that changes the partial-end decision;
- a store-generation rebase that keeps the boundary id but changes the following occurrence
  (refuse, not render);
- a compaction seam where the boundary id is absent for one pass (refuse that pass, never
  render; replay when it returns);
- a CAS conflict on a pass that recorded a release request (TS/Pi write and Rust commit), and
  a restart between the held pass and the release, in Rust as well;
- an idle session whose tag targets are protected but which has no queued operation: no
  release request, no bust at the next turn.

### Mutation controls, one per lane

Each control neutralizes one admission call site, making it return "admit", or removes one
guard. It runs the named strict test, and only that test may go red.

| Control | Expected red (strict) |
|---|---|
| TS stale-reduce `admit` | `OpenCode 1 TS mode, primary mid tool loop > stale ctx_reduce strip`, and the subagent run test of the same name; OC2 the same |
| TS todo `admit` | `… primary mid tool loop > synthetic todo` |
| TS placeholder `admit` | `… frozen-sentinel first application` (primary and subagent) |
| TS image `admit` | `… processed image strip` |
| TS `Prefix` hold, with `served_m0m1` replay neutralized | `… m[0]/m[1] re-render after a recomp clears the cached pair` |
| TS tag-target `admit` | every held tag lane (drops, reclaim, dedup, 85%, 95%, flush, caveman), as in the audit's own proof |
| TS/Pi arc coordinate reduced to the result alone | the mixed-pass test, on `ORPHAN_ERROR` once the tail reduction removes a result |
| Pi todo / placeholder / prefix `admit` | `Pi/OMP, primary mid tool loop > synthetic todo` / `> frozen-sentinel first application` / `> m[0]/m[1] re-render …` |
| Pi proactive strip on `cacheBustingPass` alone | the repeat-pass byte-identity assertion of the held Pi lanes that bust |
| Rust coverage-fold `admit` | `opencode_rust_mode::primary_mid_loop` with `MC_AUDIT_LANE=HardFold`, and `claude_code::…` |
| Rust todo / placeholder `admit` | the same functions with `MC_AUDIT_LANE=Todo` / `Placeholder` |
| Rust force latch counts trailing-blank units again | `opencode_rust_mode::primary_mid_loop`, `MC_AUDIT_LANE=DropFull`, trigger assertion |
| Rust all-held plan not downgraded | the same function, `MC_AUDIT_LANE=Flush`, trigger assertion |
| Rust release request removed | `opencode_rust_mode::primary_mid_loop`, `MC_AUDIT_LANE=DropFull` (release step) |
| TS/Pi release request not persisted | `release survives a restart: /ctx-flush` |
| Release request cleared because anything landed | the mixed-pass test's release step |
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
- a Rust mixed-pass lane and a Rust parallel-batch fixture: the Rust 95% wall lands nothing
  mid-loop in this fixture today, so the lane would prove nothing yet;
- the Rust lanes the fixture never prices (skeleton drop, dedup, 85% force band, stale
  reduce). Their fixture needs a pressure profile that lands them in the control first.
  Until then a held result for them proves nothing.

## 12. Cost

r1 claimed the frame costs O(*k*), *k* being the messages after the last kept block. That was
wrong for the helper it reused. `latestAssistantTurnStart` binary-searches with
`isInActiveAnthropicTurn` (`latest-assistant-turn.ts:32-43`), and every call of that
predicate scans backwards from the end of the array to the last real user message
(`active-anthropic-turn.ts:8-39`). The turn start therefore costs O(*T* log *n*) message
visits, *T* being the length of the current turn and *n* the array length. In a long tool
loop, and in a subagent whose whole run is one turn, *T* is the whole loop, not one to three
messages.

The frame in section 3 uses one reverse scan instead, which stops at whichever comes first,
the last retained thinking part or the last real user message:

- **With retained thinking in the turn:** *k* + 1 messages visited.
- **Without:** *T* + 1 messages visited, once per pass, instead of *T* per predicate call.
- **Retained-ness** reproduces the persisted removal decisions only for visited messages and,
  for merged-assistant runs, their run neighbours.
- **Each verdict:** O(1) set lookups, plus at most one scan of the parts of the boundary
  message, from the end, to find the anchor.
- **Removed once the re-expression retires them:** the per-pass `part → ordinal` map over every
  part of every message (`latest-assistant-turn.ts:81-84`), the whole-history copy in
  `retainedActiveThinkingParts` (`:135-154`), and Rust's per-message `clone()` plus replay
  walk in `active_thinking_prefix_edit_ids` (`transform.rs:16779-16810`). Until parity is
  shown they stay, so the first rollout steps add the frame's cost without removing these.
  Lane scans that are already O(history), such as the stale-reduce and placeholder detection
  loops, are unchanged. Admission adds one call per candidate, not a scan.
- **Held state:** the `served_m0m1` manifest (one per session) and the release request (one
  column in TS and Pi, one meta field in Rust). Held edits are re-detected from live state at
  release. Nothing accumulates per pass.

The cost guard counts every message visit, including those inside helper predicates, on a
2,000-message history. It asserts at most *k* + 2 visits when the turn has retained thinking
and at most *T* + 2 when it has none, and it fails if any helper it calls rescans the turn.

## 13. Rollout order

1. The shared check and its corpus in TS and Rust, beside the existing issue 630 protection,
   which keeps deciding tag targets. Parity test.
2. Rust triggers: the force latch ignores bookkeeping units, and a plan whose edits are all
   held is downgraded to a defer. Flips the Rust trigger assertions.
3. The non-tag lanes in this order: placeholder and system-injected strips, stale reduce,
   image, todo (with the anchor clears), temporal markers and the overlay frontier, then the
   Rust coverage fold. Each lane flips its strict audit test to green, with its mutation
   control.
4. Release obligations, persisted (TS and Pi column, Rust meta), recorded only from
   withheld authorized work. Flips the restart and Rust release assertions.
5. Compound tool-arc coordinates, and admitted tail reductions at the 95% wall in TS and
   Rust. Flips the TS mixed-pass test.
6. The `served_m0m1` manifest with validation, upgrade seeding and local refusal, in TS and
   Pi.
7. Pi's proactive strip gated on an admitted edit, and the companion-strip precondition in
   every runtime.
8. The Claude Code completed-turn strip, after THALAMUS's per-model split confirms section 6.
9. Finding 8's host fix and its test.
10. Retire the identity map and Rust's ordinal walk in favour of the check, once the parity
    test is green.
11. Delete the `EXPOSED` / `exposed()` / `release_gap()` / `RESTART_GAP` scaffolding and make
    strict the default.

The subagent wrap-up instruction is not a follow-up of this fix; it may be revisited only
after a live capture (section 8). Server-side clearing is a separate study.
## Verification of this design delivery

Run on Linux (Bun 1.4.2, cargo 1.99.0, TypeScript 5.9.3):

- `bun test src/hooks/magic-context/signed-thinking-prefix-audit.test.ts
  src/hooks/magic-context/__tests__/strict-binding-mock.test.ts` in `packages/plugin`:
  99 pass, 0 fail (88 audit, 11 mock). With `MC_AUDIT_STRICT=1` the audit file gives 70 pass
  and 18 fail, as listed in section 11.
- `bun test src/signed-thinking-prefix-audit.test.ts` in `packages/pi-plugin`: 43 pass,
  0 fail. Strict: 39 pass, 4 fail (section 11).
- `cargo test -p mc-module --test signed_thinking_prefix_audit`: 6 pass. Strict: 3 pass,
  3 fail (section 11). `cargo fmt -p mc-module -- --check` is clean.
- `bun run typecheck` in `packages/plugin` and `packages/pi-plugin`: exit 0. `biome check`
  on the four changed TypeScript files: no diagnostics.
- No product code, architecture document, package manifest or lockfile changed.

## Changes from r1

Each item is a finding of the Athena review (consult `ct_00000000-0000-448f-98dd-be0494920bd0`)
and where this revision answers it.

| # | Finding | Answer in r2 |
|---|---|---|
| 1 | `served_m0m1` re-rendered a new prefix under kept signatures when the trim id was missing, and treated a surviving id as proof | Section 7: no render while a boundary exists. A missing id is not a revert (compaction seams), a present id is not compatibility (store conversion); the manifest is validated and otherwise the pass replays a fenced full request or refuses locally |
| 1 | The record lacked mural data and the live partial-cut decision | Section 7: a complete replay manifest (emitted head with mural, explicit `none` / inclusive / partial cut frozen at serve time, first kept id, provenance); nothing re-derived from compartments |
| 1 | No upgrade path without a cached pair or a record | Section 7, "Upgrade": seed only from a complete cached pair or a fenced full-request snapshot; otherwise replay or refuse until the turn boundary |
| 2 | A signature-only predicate would regress issue 630 | Section 3: retained stays today's any-thinking-type predicate; per-host anchor extraction for OpenCode, Pi and Rust; unresolved ids or anchors fail closed and never give `boundary = None` |
| 2 | Keep the whole wrapper and the forced `freezeM0M1` | Section 3, "Tag targets": every mutator override, `thinkingRewriteProtected`, `keepReasoning`, `dropsThinking` on all models, `args.freezeM0M1 \|\| !admit(Prefix)`; retirement only after a parity test (rollout step 10) |
| 3 | Rust `commit_transform` persists whatever the planner supplies | Section 4: every `TransformCommit` field with its producer, split into served-derived fields that stay unchanged and observation fields that may commit; the overlay frontier rule |
| 3 | The Rust release-gap latch was unknown | Section 2: found. The force latch counts the trailing-blank bookkeeping unit as reclaim on the next loop pass; the flush arm is cleared by a held pass that is still planned as a SOFT bust. Pinned by the new trigger assertion (section 11) |
| 3 | Mixed passes | Section 4, "Mixed passes", and new mixed-pass tests in TS and Pi |
| 3 | Pi's proactive strip and the todo bust path wrote without an admission hook | Section 5, rows 2 and 10, and the companion-strip precondition |
| 4 | Admission queries could create release obligations | Section 4, "Release obligations": `admit` is pure; only withheld work of an authorized bust records one, with its reason; opportunistic lanes stay ride-only |
| 4 | Restart durability of the TS and Pi signals unproven | Section 4: they are process memory, and the new restart tests show `/ctx-flush` is lost in OpenCode 1, OpenCode 2 and Pi; the release request is persisted |
| 5 | Parallel tool arcs could be orphaned by a tail reduction | Section 3: a batch is one compound coordinate at its earliest position; the provider mock now rejects orphans |
| 5 | Pi's frame array and id space were not named | Section 3: `workingMessages` with `resolvePiStableId` tiers 1-2; `pi-msg-*`, empty ids and transcript `synth-user-` ids are not coordinates |
| 5 | No proof that coordinates match the serialized wire | Section 11, "Serialized-wire agreement", plus `beforeLastThinking` and pairing on the wire now |
| 6 | Host-side splice and LKG replay are outside admission | Section 9: the OpenCode late-user splice is out of scope; LKG is detect-and-decline with no recovery; nothing automatic is promised |
| 7 | The 95% subagent wrap-up was not shown safe | Section 8: removed; the wall refuses visibly until a live capture; Pi's folding noted; server-side clearing stays out |
| 8 | The O(*k*) frame cost was wrong | Section 12: the reused helper is O(*T* log *n*); the frame is one reverse scan, and the guard counts visits inside helpers |
| 9 | `ARCHITECTURE.md` invariant 4 contradicts the hold | Section 10: exact replacement wording, plus one sentence for invariant 1, for the operator to apply |
