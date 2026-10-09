# Holding edits before kept signed thinking: one admission check

## Status and scope

**Revision 4.** This is a fix design for review before implementation. Revisions 1 to 3
(commits `6668dd20`, `c06844f9` and `69d1395a`) were each reviewed by an Athena panel. The
third review accepted the core of r3's served prefix record (head and cut as one unit,
written after the trim, first kept id plus digest), the managed-mode failure path, the
`TransformCommit` table and the persistence discipline. It found three gaps that block
implementation: where the current turn's id comes from, the compaction-off failure path, and
the compaction-marker summary. This revision closes them and the smaller findings; the
mapping is in "Changes from r3", and the earlier mappings are kept below it.

It is based on the audit in
[`signed-thinking-prefix-edits-audit.md`](../reports/signed-thinking-prefix-edits-audit.md),
the live strict-mode report `docs/reports/live-thinking-arc-removal.md` (branch commit
`2811017c`, not in this base),
[`user-append-into-served-carrier.md`](../reports/user-append-into-served-carrier.md) and
[`skeleton-retirement.md`](skeleton-retirement.md).

No product code changes in this delivery. The audit suites are extended so that
`MC_AUDIT_STRICT=1` asserts the whole contract this design requires (section 11). Without the
variable they stay green and pin what the code does today. `ARCHITECTURE.md` and
`STRUCTURE.md` are untouched: section 10 proposes the replacement wording for the two
architecture invariants this design contradicts, for the operator to apply.

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
released on the first pass of the next turn; a held trigger authorizes no later pass of the
same turn. When the boundary cannot be resolved, the check fails closed and holds. The
prefix (m[0]/m[1], the compaction-marker summary when one is served, and the cut of raw
history) is recorded as one unit after it is served, and every pass that does not newly
change it replays that record, head, summary and cut together (section 7). TypeScript (OpenCode 1, OpenCode 2 and Pi) and the Rust module
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
| 6b | **Prefix cut moved on replay by a compartment rewrite that keeps the cached pair (new in r3)** | exposed P, and at a new user turn on a defer pass | exposed P, and at a new user turn | not exposed (own frozen render) |
| 6c | **Compaction-marker summary retired by a bust (new in r4)** | exposed P | n/a (Pi's transform serves no marker summary) | OpenCode Rust mode: the host runs the same reconcile on `prefix_bust_permitted` (code-read); Claude Code: n/a |
| 7 | Processed-image strip | exposed P | held | held |
| 8 | Rust-mode host strip after a frozen release | code-read only | n/a | n/a |
| 9 | **Temporal-marker first application (new, code-read)** | likely exposed P | gap | gap |
| 10 | **Older-turn thinking stripped on a pass that applied nothing (new in r4)** | valid, but bytes change on every held primary lane | valid, but bytes change on the held `/ctx-flush`, HARD fold and 95% wall passes | not tested |
| — | **Release of held work at the next turn (new)** | releases | releases | **does not release** drop, flush, caveman, image |

The three results new in r2, then the one new in r3:

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
    is cleared (`:6002-6004`: the clear runs whenever `prefix_replay_must_be_preserved` is
    false, which is `!is_provider_prefix_mutation_pass`, `:5827`). The response even reports
    `prefix_bust_permitted=true` while no byte changed. Nothing is armed at the next turn.

  TS keeps the request alive through `pendingMaterializationSessions`
  (`transform-postprocess-phase.ts:2232-2238, 2848-2856`), and Pi releases the same lanes,
  but both lose the `/ctx-flush` release across a process restart (section 4).
- **Finding 6b (r3): the cut is re-derived on every replay.** Not every compartment writer
  clears the cached pair (section 7 lists them). The new tests rewrite the served boundary
  row with `replaceAllCompartments` so that it ends part-way through its message, and offer
  no bust. The pair stays complete, the next defer pass replays it, and the replay re-reads
  the partial-end decision from the live row: OpenCode now serves the boundary message it
  had cut, and Pi serves the whole window, because a partial end turns its trim off
  (`inject-compartments-pi.ts:174-200, 2726-2737`). Both are rejected with `PREFIX_ERROR`
  mid-loop, and also on a defer pass at the start of a new user turn, where the previous
  turn's signed blocks are still sent and nothing strips them.

The two results new in r4:

- **Finding 6c: the compaction-marker summary is retired under kept thinking.**
  `reconcileMarkerRepresentation` (`transform-postprocess-phase.ts:1331-1418`) inserts the
  summary message directly after the synthetic head, before every raw message. When the
  persisted marker state is cleared it keeps serving the cleared marker on non-busting
  passes, and the first pass with `isCacheBustingPass` retires it
  (`retireDeferredClearedCompactionMarkerState`, `:1342-1350`). The new test sets a marker at
  a turn-start `/ctx-flush`, clears it mid-loop (as `message.removed` of the summary or
  boundary message does, `event-handler.ts:1187-1199`), then offers a `/ctx-flush`. The only
  change outside thinking is the summary's removal, and it is rejected with `PREFIX_ERROR` in
  OpenCode 1 and OpenCode 2.
- **Finding 10: a pass that applied nothing still strips older-turn thinking.** A new
  assertion compares every thinking block of the held pass with the pass before it. In
  OpenCode every held primary lane removes the previous turn's three blocks: the strip
  (`freezeReasoningOnBustingPass`) is gated on `prefixEditBesidesReasoningTrim`
  (`transform-postprocess-phase.ts:4114-4141`), an OR that includes `firstRenderBust`,
  `materializationRequested`, `emergency` and `pendingOpsDidMutate`, not only on an admitted
  edit. The same pass also runs the merged-reasoning strip (`:3828-3866`), which removes the
  later blocks of an assistant run, a middle removal by its own comment (`:3854-3857`).
  With the proactive strip turned off, the held `/ctx-flush` pass is rejected with
  `MIDDLE_ERROR` (checked by mutation for this revision), so the proactive strip is what
  makes that removal valid today. In Pi the held `/ctx-flush`, HARD fold and 95% wall passes
  strip the previous turn's blocks: `applyPiProactiveThinkingStrip` runs on
  `cacheBustingPass` (`context-handler.ts:3820-3841`). Every request stays valid, but the
  bytes change on a pass that changed nothing else, and after the served prefix record ships
  that change can break the record's digest (section 5, row 10).

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

### Turn identity

One feature needs the current turn's id on a pass with a boundary: the served prefix
record's turn check (section 7). Parking does not (section 4), and admission does not.

**Definition.** The turn is the stable id of the last real user message by the
`isInActiveAnthropicTurn` rule (`active-anthropic-turn.ts:8-39`), which is where the frame's
scan stops on a pass with no boundary. On a pass with a boundary the scan stops at the
boundary, so the id comes from continuing the same reverse scan from the boundary to that
user message, with the same predicate. That walk is the turn's length *T* and runs only on
passes that validate a record (OpenCode TS and Pi). The frame's own cost and its guard are
unchanged (section 12).

**Why the existing per-pass ids are not reused.** TS already computes
`currentTurnId = findLastUserMessageId(messages)` on every pass (`transform.ts:847`), passes
it to `runPostTransformPhase` (`:2743`), and uses it for `lastHeuristicsTurnId`
(`transform-postprocess-phase.ts:2857-2858`). Pi computes the same value with
`findLatestUserMessageIdPi` (`context-handler.ts:5802-5814`, `:8127-8140`). Both select a user
message with meaningful text (`hasMeaningfulUserText`, `read-session-formatting.ts:35-52`:
ignored parts, system reminders, the OMO initiator marker and system directives do not
count). The frame selects by flags (not synthetic, no `synth-user-` id, not made only of
synthetic, ignored or tool-result parts). The two disagree: a user message whose only text
is a system reminder starts a turn for the frame but not for `currentTurnId`, and a
message flagged synthetic that carries real text does the reverse. A record stamped with
one rule and checked with the other would refuse every pass of such a turn. The record
therefore uses the frame's rule on both sides. Because the walk has the same cost as
`findLastUserMessageId`, an implementation may compute both ids in one walk, as long as
each keeps its own predicate.

**Rust.** The module keeps no per-pass turn id. `in_active_anthropic_turn` finds the turn
start inside each call (`rposition` over `req.messages`, skipping synthetic and
tool-result-only user messages, `transform/active_anthropic_turn.rs:17-31`). Rust has no
served prefix record (section 7) and parks without an id, so this design needs none there.
The Claude Code strip's domain (section 6) is minted on a pass with no boundary, because an
edit before kept completed-turn thinking is before any current-turn block too, so its
user-message `mid` is the one the frame's scan stopped at.

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
   names the two latches that spend a trigger today. A trigger kept this way is **parked**,
   not standing (below).
4. **Released at the turn boundary, only for real obligations.** See "Release obligations"
   below.

### Parked triggers are not a standing permission

Keeping a held trigger alive must not turn it into a bust permission for every later pass of
the turn. In Rust, a kept `soft_refresh_pending` makes `independent_rebuild` true
(`transform.rs:5294`) and a kept force episode makes `force_episode_available` true (`:5280`),
so every later loop pass would compute `pass_already_busting` (`:5302`) and open selection and
the strip and caveman planners to admitted work after the boundary. One `/ctx-flush` would
then price a tail edit on every step of a long loop. TS and Pi have the same problem through
the standing permissions listed below.

The rule: **a trigger whose authorized work was held is parked, and a parked trigger is
armed only on a pass whose frame has no boundary.** It is not spent, and no pass with a
boundary treats it as armed when it decides whether it busts. The release request (below) is
the parking record: it lists the triggers it carries and their reasons, and no turn id.
None is needed. Once the current turn keeps a thinking block, every later pass of the turn
has a boundary until the next real user message, whose first pass has none. A pass with no
boundary in the middle of a turn happens only when no current-turn thinking is retained (for
example after a binding recovery removed it), and then the held work is valid there for the
same reason. On the first pass with no boundary the parked triggers are armed again and
carry their original permission ("Release obligations"). Three consequences:

- A force episode is spent by the reclaim that lands on its first pass, as today; if every
  reclaim on that pass was held, the episode is parked, not spent and not reused. Either way
  one force episode authorizes at most one pass in the turn. An episode that ends below the
  band clears its request ("Release obligations"), so a later crossing is a new episode.
- The 95% wall is not a parked trigger. It is live pressure, re-evaluated on every pass from
  usage as it is today, so each pass at the wall may land admitted tail reductions
  (section 8). A trigger the record does not carry (a first `/ctx-flush`, a first crossing of
  the force band) authorizes its own pass as usual.
- A `/ctx-flush` issued while a flush is parked joins the parked one and waits with it. The
  arm is one flag in every runtime (Rust `soft_refresh_pending`; TS and Pi set membership), so
  the two cannot be told apart, and the second asks for the same work, which is held for the
  same reason. r3 said such a flush authorized its own pass; no runtime could have
  distinguished it.

**The standing permissions in TS and Pi.** Each of these is a parked trigger under the rule
above. Each stays set (nothing drains it), and none makes a pass with a boundary a busting
pass:

| Permission | TS today | Pi today | Under a boundary |
|---|---|---|---|
| First render | `firstRenderBust = m0M1EnabledForFold && !completeCachedPrefixAvailable` (`transform-postprocess-phase.ts:2064`) feeds `rideSignals.hardFold` (`:2250`), pending-op reads (`:2228`), heuristics (`:2278`) and the proactive strip (`:4115`). It is not gated by `freezeM0M1`, unlike `idleExpiryRebuild` (`:2247`), `foldDueDecision` (`:2032-2033`) and `softRefreshOpportunity` (`:2073-2074`). After a clearing writer mid-loop every later loop pass busts | `firstRenderBust` (`context-handler.ts:5892-5897`) feeds `hardFold` (`:6039`), not gated by `protectedSignedPrefix` | false: the served prefix record is the render (section 7). The first pass with no boundary renders and busts |
| m[0] drift watcher | `checkM0MutationDriftAndSignal` runs on any busting pass (`:3645-3658`) and adds the session to `pendingMaterializationSessions` and `historyRefreshSessions` when the mutation id differs from `cachedM0MaxMutationId` (`:4421-4440`). Under the freeze the cached id never advances, so it signals again on every busting pass | none (no drift watcher in the Pi context handler) | does not signal; the mutation is a HARD that `mustMaterialize` sees on the first pass with no boundary |
| Held execute | an execute whose pending op is `thinkingDropProtected` adds `pendingMaterializationSessions` (`:2234-2238`); the drain waits for `!freezeM0M1` and no protected op (`:2850-2856`), so every later pass is an explicit flush (`materializationRequested`, `:1980`; `rideSignals.explicitFlush`, `:2255`) | the signal is consumed only when no pending op is protected (`:6452-6459`, `:6796-6801`), and `hasPendingMaterializeSignal` feeds `explicitFlush` on every pass (`:6033`, `:6044-6045`) | kept, not drained, and not counted as `explicitFlush` or `materializationRequested` |

The `claude-code-anthropic` profile writes no parking record until rollout step 8; there its
force episodes and the flush arm behave as today (section 13).

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
| `overlays.rewrite_temporal_marks` | when true, every computed mark is upserted into `mc_temporal_marks` with its marker text replaced, instead of inserting only marks beyond the frontier (`mc-store/src/lib.rs:10845-10851, 11020-11048`); it also forces the decision-write version bump | the overlay computation; cleared on a defer (`transform.rs:5833`) and kept on any mutation pass | **false** unless every mark it would rewrite is at an admitted coordinate. A pass downgraded to a defer clears it, as a defer does today |
| `overlays.max_seen_ordinal` | `mc_overlay_frontiers`, by `MAX` | the same overlay computation (`:11762-11785`) | **must not pass** a held mark or hint. A later insertion only lands at an ordinal above the previous frontier, so advancing it over withheld work loses that work for good |
| `meta.soft_refresh_pending` | meta blob | cleared at `transform.rs:6002-6004` on any mutation pass | **unchanged** while its work is held |
| `meta.guidance_date` | meta blob; read back by `guidance_date_for_session` (`lib.rs:9778-9790`) as the date line of the system-prompt guidance (`:9727`) | adopted from `ctx.guidance_date` on any bust pass (`transform.rs:6005-6009`) | **unchanged** on a pass with a boundary: the date line is in the system prompt, before every message, so it is a `Prefix` coordinate and is never admitted while a boundary exists. The first pass with no boundary adopts it |
| `meta.pending_tag_block_ids`, `meta.pending_user_hint_block_ids` | meta blob | filled on a replay-preserving pass with the tag mints and hints whose block was already served (`transform.rs:5838-5851`, `:5885-5895`); a block in either list renders without its tag or hint (`tag_overlay_state`, `:10962-10988`). Both are cleared on any mutation pass (`:5836-5837`, `:5903-5905`), which renders them, and both must be empty for the replay-preservation condition (`:5992-5993`) | an id leaves its list only when its block is at an admitted coordinate and its tag or hint is served on this pass; every other id stays, so its block keeps rendering as it was served |
| `meta.has_prior_emergency_drop`, `last_emergency_input_sample` | meta blob | set at `:7341-7357` when a force-band pass mints a qualifying unit | set only by a unit that changed served bytes for an admitted coordinate; never by a bookkeeping unit |
| todo state and anchor | meta (`set_todo_state`) | bust-only capture (`:6010-6023`, `injection.rs:199-221`) | **unchanged** when the todo move is held |
| coverage, m[1] revision, `deferred_execute_state` | meta blob | the plan (`:5285-5303, 5581-5610`) | **unchanged** when the fold or refresh is held |
| emergency drain latch (`meta.emergency_drain_active`, `emergency_drain_entered_at_ms`) | meta blob, by `apply_scheduler_meta` (`transform.rs:8663-8675`); read back by `latch_from_meta` (`:8655-8661`) into the scheduler (`:5071`) | `advance_drain_latch` (`scheduler.rs:617`) from usage and time, and the disarm on a trusted final-wire measurement under the provider-proven limit (`transform.rs:5080-5092`) | **committed as computed.** It is pressure state, not a trigger: no applied or held work enters or leaves it, so a held pass cannot spend it. r2 listed it with the fold state as "unchanged"; that would have frozen its hysteresis and its time limit instead |
| release request (new) | meta blob | section 4, "Release obligations" | written when an obligation is withheld |
| `memory_revision`, `compartment_max_seq` | nothing (destructured as `_`, `:10668-10688`) | — | no rule needed |
| `scheduler_observation` | appended to `mc_pass_trace_history` as `scheduler` and `interesting` entries (`mc-store/src/lib.rs:10729-10742, 10952-10960`) | `pass_scheduler_observation` (`transform.rs:2778-2790`, called at `:7527-7533`): the scheduler arm and `drain_latch_active`, a copy of the latch row above | **observation, committed unchanged.** Its latch field copies the meta latch the same pass computes, and it is read back only by the trace loaders `load_pass_scheduler_history` and its siblings (`lib.rs:9163-9270`), whose callers are tests and incident queries; no eligibility decision reads it. So it needs no split: the rule that matters is on the meta row above |
| `first_divergence`, the scheduler counters, `project_root` | `mc_pass_trace`, `mc_transform_session_roots` (`:10917-10973`) | the pass trace | **observation, allowed**: they do not change request bytes |
| identity adoption (`last_provider_id`, `last_model_key`, system hash), ingress meta, block-identity and served-fingerprint maps | meta, row tables (`:10827-10838`) | `apply_ingress_meta`, identity adoption (`transform.rs:5718-5726`) | **observation, allowed**: they describe what was served, which is unchanged |

The structural fix is in the planner, not the store. When admission holds every edit a
mutation plan would make, the plan is downgraded to a defer before
`is_provider_prefix_mutation_pass` is computed, so the soft-refresh clear, todo capture,
overlay commit and `prefix_bust_permitted` all see a pass that changed nothing. That is not
early enough on its own: `pass_already_busting` is fixed at `transform.rs:5302`, before
selection, and already drives calibration adoption and the transition-hygiene units
(`:5312-5322, 5694-5708`), the floor snapshot as `FloorPass::CacheBust` (`:5383-5387`) and the
`has_prior_drop` mask (`:5465`). The planner therefore either computes the flag after
admission, or recomputes it and redoes those decisions as a defer when the downgrade fires;
either way an all-held pass makes none of those writes. Parked triggers (above) do not set
the flag at all. When some edits are admitted (a mixed pass), the pass stays a mutation pass,
and the rows above marked "unchanged" are filtered to the admitted coordinates. The force latch at `:7341-7357` counts
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
recorded request as its trigger, armed again: the request carries the original trigger's one
bust permission forward, so that pass busts for the original reason and every lane drains
into it under the ordinary rules. It is not a ride, which by definition waits for some other
permission. On the `claude-code-anthropic` profile this release is off until the
completed-turn strip ships (section 13).

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
in-memory sets. In Rust it is a field of the module meta committed with the transform. The
migration, fence and clone and repair rules for it are under "Persisted state" below.

**Telemetry.** Each lane that withholds work logs its lane, its coordinate and the boundary
message id once per pass, and adds to a per-session `held_edits` counter in the existing pass
metrics. A session where reclamation is continuously held (the subagent case, section 8) must
be visible without reading logs.

### Persisted state

This design adds two pieces of persisted state: the release request (above) and the served
prefix record (section 7). In TS and Pi both are nullable columns on `session_meta` in
`context.db`: `held_release` and `served_prefix`. They are columns, not tables, so neither
needs a `SESSION_SCOPED_TABLES` entry (`storage-session-tables.ts:16`); an implementation that
moves either into its own per-session table must register that table there, with a `harness`
column (`docs/architecture/storage.md:42, 50`).

- **One host migration, numbered at slice time.** This base is at version 95
  (`storage-db.ts:164`). The migration takes the next free `context.db` version after the
  migration branch's v97 and whatever lands after it, and adds both columns in the first
  rollout step, before any code reads them, so the machine-wide restart happens once. It
  follows `docs/architecture/storage.md:36-46`: a `migrations-v<N>.test.ts`,
  `LATEST_SUPPORTED_VERSION` bumped to the same number, the fresh-install schema in
  `storage-db.ts`, `ensureColumn` calls, both dists rebuilt with `bun run build:dists`, and every
  host restarted. A host left on the old build fails closed at its fence, as for any migration.
- **Rust, `store.db`.** The module's release request is a field of the module meta, which
  decodes with serde defaults. An older module build would load a blob that carries the field
  and drop it on its next commit, losing the obligation without a trace. The slice that adds
  the field therefore also adds an `mc-store` migration, so that an older binary refuses the
  newer store (`STORE_AHEAD_OF_BINARY_REFUSAL_REASON` and `StoreAheadOfBinary`,
  `mc-store/src/lib.rs:3268-3274, 6034-6042`), and it ships
  together with the host migration: `context.db` and `store.db` are one consistency unit
  (`storage.md:53`).
- **`clearCachedM0M1` clears neither column** (`storage-meta-shared.ts:575-618`).
- **Clone.** Two writers copy `session_meta`, and both must write the new columns NULL.
  - The core clone (`storage-clone.ts:711-756`) writes the destination's row itself, remaps
    message ids, and nulls the cached pair. Its `INSERT ... ON CONFLICT DO UPDATE`
    (`:720-736`) updates only the columns it lists, so a column it does not list keeps the
    destination row's existing value on a conflict. Both new columns are therefore listed
    and set to NULL explicitly, in the insert and in the update.
  - The `PRAGMA table_info(session_meta)` walk that follows (`:757-771`) is not a generic
    copy: it only checks for `trailing_blank_decisions` and writes the filtered replay
    document. The generic copy its comment refers to is the clone script's
    `copyContextMeta` (`packages/plugin/scripts/clone-session.ts:1050-1089`). It copies every
    `session_meta` column except `session_id`, `trailing_blank_decisions` and the retired
    ones (`:122`), and resets only the columns `contextMetaReset` names (`:1044-1048`): the
    `cached_m0_*` columns and `cached_m1_bytes` to NULL, and `RESET_META_COLUMNS` (`:124`) to
    0 or the empty string. Unless `contextMetaReset` returns NULL for `served_prefix` and
    `held_release` too, it copies the source's values over the core clone's NULLs.

  `served_prefix` describes a request the destination never served, and its digest covers
  the source's ids; a clone continued mid-turn with kept thinking therefore refuses until a
  real user message (section 7), which is also where it would render its own head. A leaked
  record would only fail validation, but a leaked `held_release` would make the clone's next
  turn bust for the source's triggers. The queued drops the clone copies (`pending_ops`,
  `storage-clone.ts:651-657`) carry their own trigger.
- **Rust single-store repair** (`single_store_repair.rs`). `SESSION_META_RESETS` (`:58-86`)
  mirrors `clearCachedM0M1` and must not gain either column: resetting `served_prefix` would
  delete the only replayable prefix while a turn is held, and resetting `held_release` would
  drop an obligation. The repair also clears the cached pair, which in TS turns on
  `firstRenderBust`; under a boundary that permission is parked and the record replays
  ("Parked triggers" above). Its `compartment_delete` mutation row with a NULL target
  (`:828-834`) raises the session's m[0] mutation id, so in TS it is a HARD: `mustMaterialize`
  is not consulted under the freeze (`transform-postprocess-phase.ts:2032-2033`), and the drift
  watcher's signal is parked (above). The host folds on the first pass with no boundary. The
  repair's code needs no change for that, because admission runs in the host; its comment
  does ("the host folds on its next pass with no kept current-turn thinking").

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
| 6, 6b m[0]/m[1] re-render, and the cut of raw history | `injectM0M1` (`inject-compartments.ts:3944-4252`): the hold short-circuits before `mustMaterialize` and before every fresh-render path (`renderFreshM0NonPersisted` on contention or under `allowFreshContentionFallback`, `:4024-4126`; the drift backstop refold, `:4131-4189`; the legacy re-anchor, `:696-759`), and replaces the cached-pair replay and its trim (`prepareCachedM0M1Replay` and `trimToPreparedPrefix`, `:3803-3933`); the outer `freezeM0M1` (`transform.ts:1155-1181`) | the Pi cached-prefix path (`context-handler.ts:5924-5930`) and its trim (`inject-compartments-pi.ts:2726-2737`) | not exposed; keep the `Recomp` test as a guard | `Prefix` | replay the served prefix record, head, summary and cut together, with the result contract of `prepareCachedM0M1Replay` (below); a pass that cannot validate it refuses locally, that pass only, except in compaction-off mode (section 7) |
| 6c Compaction-marker summary: its retirement, apply and move | `reconcileMarkerRepresentation` (`transform-postprocess-phase.ts:1331-1418`) at the TS-mode call (`:3508-3522`, retiring when `deferredClearedMarkerRetires`, `:3497-3501`) and at the Rust-mode call (`:1177-1186`, with `applyRustModeDeferredCompactionMarker` at `:1161-1176`, both on `cacheBustingPass`, which is the module's `prefix_bust_permitted`, `rust-mode-transform.ts:3992, 4298, 4346`); the TS marker drain behind `historyWasConsumedThisPass` (`:3383-3405`) | n/a: Pi's transform serves no marker summary | n/a: the module renders no summary; the OpenCode Rust-mode host does, as in the TS column | `Prefix` | serve the recorded summary, or its recorded absence; retire, apply or move nothing. `prefix_bust_permitted` is not permission for this lane: it can be true on a mixed pass |
| 7 Processed-image strip | `stripProcessedImages` detect (`:3068-3086`) | `strip-processed-images-pi.ts:111` (held today only because its drop is held) | `processed_image` units `transform.rs:14207-14235` | `Message{id, first image part}` | skip; id not persisted |
| 8 Rust-mode host strip | `applyRustModeThinkingStrips` (`:983-1070`) | n/a | n/a | thinking removal, not a content edit (below) | never remove current-turn thinking |
| 9 Temporal markers | `freezeTemporalDecisions` on a bust (`:2300-2316`) | gap: whether Pi renders temporal markers was not checked | overlay temporal marks (`transform.rs:11666-11759`), and the frontier rule in section 4 | `Message{user message id, first text part}` | keep the NULL row; the marker is not inserted; the frontier does not pass it |
| 10 Proactive older-turn thinking strip | `freezeReasoningOnBustingPass` (`transform-postprocess-phase.ts:4135-4159`), today gated on `prefixEditBesidesReasoningTrim` (`:4114-4134`), an OR that includes `firstRenderBust`, `materializationRequested`, `emergency` and `pendingOpsDidMutate`, so it fires on passes whose edits were all held (section 2, finding 10) | `applyPiProactiveThinkingStrip` (`provider-error-recovery-pi.ts:282-350`), called with `cacheBustingPass` (`context-handler.ts:3820-3841`) | the Claude Code strip (section 6) | companion removal, below | does not run unless an admitted edit landed before kept older-turn thinking on this pass; a pass with a boundary never has one, so it never runs there |
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
rule either case holds the edit instead. Two triggers the strip must not have: a bust
permission alone (Pi's `cacheBustingPass`, TS's `prefixEditBesidesReasoningTrim`; on a pass
where every edit was held, stripping changes bytes for nothing and, once the record ships, can
break the digest of a reasoning-bearing first kept message, which would turn one held pass
into refusals for the rest of the turn), and an execute label, TTL expiry or a tail edit
after the boundary. The trigger is an admitted edit before kept older-turn thinking, which is
what OpenCode's `firstApplicationEdits.beforeNewerThinking` records when an admitted lane
sets it. The merged-reasoning strip (`transform-postprocess-phase.ts:3828-3866`) is a middle
removal that today sets `beforeNewerThinking` itself (`:3857`) and relies on that strip to be
valid; on a pass with a boundary it is held like the strip, and on a pass with no boundary it
lands only together with the strip. A removal from the start, such as `keep_reasoning_tokens`
clearing the oldest run, is valid alone and is unchanged.

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
  thinking block the request carries.
- **Its domain is frozen when it is minted.** The unit records the turn it was minted in (the
  `mid` of the real user message that started that turn) and covers exactly the assistant
  messages before that message. Replay removes every thinking block inside that domain, not
  a closed set of ids, so a block the client surfaces later in an already-covered turn is
  removed too. It never extends to turns completed after the mint: when turn N+1 starts, turn
  N's blocks were all produced after the mint (an edit before a kept turn-N block is held, so
  the mint happened before turn N had any) and were signed over the stripped bytes, so they
  stay valid as they are, and removing them would be a fresh edit with no authorization.
  Extending the strip to later turns needs a new admitted edit before kept completed-turn
  thinking, which mints a new unit with its own domain.
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

## 7. The served prefix: head, summary and cut replayed as one unit (findings 6, 6b and 6c)

The prefix is everything Magic Context puts before raw history plus where raw history
starts: the m[0] text, the mural block, the m[1] text, the compaction-marker summary when one
is served, and the cut. Three paths change it under kept current-turn thinking today.

- **A cleared pair is re-rendered (finding 6).** `clearCachedM0M1` runs inside recomp
  promotion (`compartment-runner-recomp.ts:125-143`), history-boundary repair
  (`history-boundary-repair.ts:139-147,233-252`), the store-generation rebase
  (`store-generation-rebase.ts:965`) and the compartment-state writers
  (`compartment-storage.ts:421,456,495,701,743`). The next pass has no complete pair, so it
  renders a new one and trims raw history to match, even on a defer pass.
- **A kept pair is replayed with a re-derived cut (finding 6b, new in r3).** r2 claimed that
  every compartment writer clears the pair in the same transaction. That is false.
  `appendCompartments` (`compartment-storage.ts:395-405`) clears nothing, and neither does
  `replaceAllCompartments` (`:369-388`), which deletes and reinserts every row and only queues
  a `recomp_boundary_change` mutation. The Rust fold upsert rewrites an occupied sequence in
  place, `end_block_index` included, and queues a `compartment_delete` mutation
  (`mc-store/src/context_writes.rs:176-207`, from `apply_fold_tx` at `:288-302`), and
  `replace_compartments_from_first_sequence` leaves `session_meta` alone on purpose
  (`mc-module/src/host_store.rs:1134-1140`). Meanwhile every replay re-derives the cut:
  `trimToPreparedPrefix` asks `isPartialCompartmentEnd`, a live query on `end_block_index`
  (`compartment-storage.ts:948-960`), in both of its branches (`inject-compartments.ts:3868-3873,
  3885-3889`), and Pi passes the same live answer as `preserveBoundary`
  (`inject-compartments-pi.ts:2726-2737`), which turns its trim off altogether (`:174-200`).
  A writer's mutation is a HARD trigger, which the boundary holds, so the pair is replayed
  under a cut that may have flipped. When the boundary id is absent the trim status is
  `refused` and the whole window is served (`classifyAbsentBoundary`, `:3706-3747`). The new
  audit tests show the flipped cut rejected mid-loop, and on a defer pass at a new user turn,
  in OpenCode 1, OpenCode 2 and Pi (section 2).
- **The compaction-marker summary is retired, applied or moved (finding 6c, new in r4).**
  `reconcileMarkerRepresentation` runs after injection on every pass and inserts the summary
  message right after the synthetic head (`transform-postprocess-phase.ts:1409-1416`). It
  builds the summary from the persisted marker state, or from a cleared marker that defer
  passes keep serving, and on a busting pass it retires a cleared marker
  (`:1342-1350`). A marker is cleared by `message.removed` of its boundary or summary message
  and by `session.compacted` (`event-handler.ts:1187-1199, 1234-1238`), by the OpenCode
  Rust-mode coordinate rebase for recorded boundaries (`transform.ts:808-820`), and by the
  compaction-off transition, where the reconcile is off. The TS marker drain moves the marker
  on a pass that consumed history (`:3383-3405`). The summary's bytes also carry its tag
  number when `ctx_reduce` is callable (`:1394-1397`).

No column records the cut that was served. `materializeM0` and `softRefreshCachedM1` commit
the pair and `cached_m0_last_baseline_end_message_id` in their own transactions
(`inject-compartments.ts:2448-2801`, `:3253-3337`, the soft refresh rewriting the baseline id
at `:3293-3313`), and `injectM0M1` trims only afterwards (`:3944-3957, 4230-4238`), where the
cut is applied, refused, found before the window or not needed.

**Decision.** The served prefix, head, summary and cut, is one replay unit. The unit a pass
served is recorded at the end of that pass, and every pass that does not newly change the
prefix replays the record: the head and summary bytes as stored, and raw history cut at the
recorded first kept message. Nothing in a replay is read from compartments, from the cache
columns, from the baseline id or from the marker state. While the current turn keeps signed
thinking no pass changes the prefix, and a pass that cannot reproduce the record refuses
locally. That refusal covers that pass only. Compaction-off mode never refuses; it has its
own rule below.

### The record (`served_prefix`)

| Field | What it pins |
|---|---|
| `head` | the head messages exactly as served: the m[0] text after the mural decision, the mural block (data URL and hash) when it was sent, the m[1] text. Stored as serialized messages, not as inputs to re-render them, so whatever rendered them is covered |
| `summary` | the compaction-marker summary message exactly as served (its id, and its bytes with the tag prefix if one was rendered), or `none` when the pass served no summary |
| `first_kept` | the first host raw message served after the head and the summary: its stable id (section 3's id function for the host) and a digest of that message exactly as the pass returned it to the host. The trim runs inside `injectM0M1` (`transform-postprocess-phase.ts:3090-3123`), before the reconcile inserts the summary (`:3508-3522`), so the summary is never `first_kept`. `none` if no raw message was served |
| `cut_mode` | `none`, `inclusive` or `partial`, with the id the cut was made at. Kept for logs only: a replay cuts at `first_kept` and never reads this field |
| `turn` | the stable id of the real user message that started the turn in which the record was written, by the rule of section 3, "Turn identity" |
| `provenance` | host (`opencode-v1`, `opencode-v2`, `pi`), id space, store generation and projection, and the pass |

**Written after the cut is decided.** At the end of every pass that serves a head and whose
frame has no boundary (whether it rendered, soft-refreshed, folded or replayed), as the last
step before the array goes back to the host, and only when the record differs from what the
pass served, `turn` included. That makes it at most one small write at the start of each
turn plus one per prefix change. It is not written inside `materializeM0`'s or
`softRefreshCachedM1`'s transaction, which run before the cut is known, and it is never
written on a pass with a boundary, where nothing may differ. In managed mode a pass whose
record write fails is not served: the write throws, and the wrapper replays a fenced
last-known-good request or refuses (`messages-transform.ts:449-604` for OpenCode, TS and Rust
mode alike; `context-handler.ts:4193-4287` for Pi), as a Rust pass fails on a CAS conflict.
No request ever carries a unit the record does not hold. Compaction-off mode is different
(below).

**Replayed on every pass that does not change the prefix.** On a pass with a boundary,
always. On a pass with no boundary, whenever the pass would otherwise replay the cached pair
(a defer, or a bust that leaves m[0]/m[1] alone); the cached pair and the record normally hold
the same head, since both are written for the same serve. The replay prepends `head`, places
`summary` right after it (or no summary), and removes every raw message before `first_kept`.
Id-less rows the host renders between persisted messages (OpenCode 2's instruction rows) are
kept or removed with their neighbours, as `trimToPreparedPrefix` does today (`:3845-3850`).
On a pass with a boundary the hold short-circuits `injectM0M1` before `mustMaterialize`, so
the fresh-render paths, the drift backstop and the legacy re-anchor (section 5, row 6) never
run, and it covers the `preparedPrefix` branch at the top of `injectM0M1`
(`inject-compartments.ts:3945-3958`). A pass with no boundary that renders, refreshes or folds
the head is a prefix change: it is admitted, its served unit is recorded, and it is served
only together with the strip of all older-turn thinking (section 5, companion strip).

**The replay reports itself as not consumed.** It returns the result contract of
`prepareCachedM0M1Replay` (`inject-compartments.ts:3922-3932`):
`materializationContentionRetryExhausted: true` and decision `cache_hit`.
`historyWasConsumedThisPass` requires that flag to be false
(`transform-postprocess-phase.ts:3383-3395`), and the marker drain and the deferred-history
drain hang off it (`:3397-3405`, `:3524-3530`). A replay that reported consumption would move
the marker under kept thinking.

**Marker retirement, apply and move are `Prefix` edits.** On a pass with a boundary the
reconcile serves the recorded summary, or none, and does not retire a cleared marker; the TS
marker drain, `applyRustModeDeferredCompactionMarker` and the retirement in the Rust-mode
reconcile are held (section 5, row 6c), and the marker state they would have changed waits
for the first pass with no boundary, which serves and records the result. In OpenCode Rust
mode the module's frozen render covers m[0]/m[1] and the cut, but the host inserts the
summary after the module returns, so the Rust-mode host keeps a `served_prefix` record with
only the `summary`, `turn` and `provenance` fields and replays the summary from it the same
way.

**Validated on every replay, at the end of the pass.** The record validates when its host and
id space match; on a pass with a boundary, its `turn` is the current turn (section 3, "Turn
identity"); the live array contains `first_kept.id`; and the digest of that message as this
pass returns it equals `first_kept.digest`. The digest is taken at the end because on a pass
with a boundary every lane before the boundary only replays, so the first kept message's
returned bytes equal those of the pass that wrote the record unless something changed them.
Whatever changed them, sending them would invalidate the kept blocks.

**A record whose `first_kept` is `none` never validates on a pass with a boundary.** `none`
means the writing pass removed every raw message it had, and the record does not say which
ones; a replay could neither keep the raw history after the cut (some of it was cut) nor
remove all of it (the boundary's own message is raw history after the cut). Such a pass is a
local refusal in managed mode and takes the fallback in compaction-off mode. Whether `none`
can be written at all is not settled by the trim alone: the id-lookup branch of
`trimToPreparedPrefix` removes everything up to and including the boundary when the cut is
inclusive (`inject-compartments.ts:3883-3891`), which empties the array only if the boundary
is the newest message. The design does not depend on that being unreachable.

### Why this is enough, and why it is not smaller

Three facts carry the guarantee.

1. **The record is the unit the kept blocks were signed over.** The first pass of a turn has
   no boundary (the frame's scan stops at the real user message), so it writes or confirms
   the record with that turn. A pass with a boundary never writes. So when a kept current-turn
   block is produced, the record holds the unit of the newest pass with no boundary in the
   same turn, which is the request that produced the turn's first kept block, and every later
   request of the turn replays it. This assumes what every host does: the request sent is the
   array the newest transform pass returned (a retry runs the transform again).
2. **The replay reproduces that request up to and including the first kept message.** The head
   is the stored bytes. The cut is identified by the first kept occurrence, by id and by the
   digest of its served bytes, and everything before it is removed. Raw history after it is
   outside the record: Magic Context's edits there are governed by admission, and the host's
   by section 9.
3. **No writer can move it.** A replay reads nothing that a compartment writer, a cache clear,
   a soft refresh, a baseline-id update or a marker-state writer touches, so clearing and
   non-clearing writers alike only affect the next prefix change, which waits for a pass with
   no boundary.

Why each part is needed:

- **Head and cut together.** Freezing only the cut and taking the head from the cache fails
  on a clear or a soft refresh. Freezing only the head is r2's defect.
- **A digest, not ids.** In partial mode the first kept message *is* the cut message, so an
  adjacency check compares an id with itself. The store-generation conversion keeps ids while
  it splits or folds rows (`store-generation-rebase.ts:704-722`), so an id can survive while
  its occurrence changes. `capturePrefixTrimSourceOrder` (`inject-compartments.ts:3764-3801`)
  proves the order of ids, not their content, so it stays the trim's own guard, and a
  mismatch it reports under a boundary is a local refusal, never "serve the whole window".
- **Written on every serve with no boundary.** Writing only on a render, as r2 did, misses
  the soft refresh (new m[1] bytes and a new baseline id, `:3293-3313`) and every cut decided
  on a replay.

The record is smaller than r2's manifest: no adjacency rules, no re-validation across a store
generation (the digest covers it) and no seeding from the cached pair. It grew in one way:
it is written on every serve with no boundary, not only on renders. A smaller construction
that holds the same guarantee was not found: dropping the digest loses the partial-mode and
rebase cases above, and dropping the turn stamp would let a record from an earlier turn, or
one left behind by an upgrade, pass validation.

### Refusal is decided per pass

In this section "a pass with a boundary" means `admit(Prefix)` is false: the model is
prefix-bound and the frame has a boundary, which is today's `freezeM0M1` condition. A
thinking turn on a model that is not prefix-bound never replays the record and never refuses.

A managed pass with a boundary whose record does not validate refuses locally with a Magic
Context error that names the reason (`served prefix cannot be reproduced while signed thinking
is kept`, and which check failed). It is raised as a degraded pass (`failPass`,
`transform-postprocess-phase.ts:1897-1907`, which throws `DegradedPassRefusalError`; Pi's
`PiDegradedPassError`), never as `EmergencyFailClosedError`, which the OpenCode wrapper
rethrows without trying a replay (`messages-transform.ts:428-429`). So the wrapper first
tries a compatible full-request snapshot whose own fences validate: the last-known-good slot
(`lkg-persist.ts`) that OpenCode keeps in TS and Rust mode alike, or Pi's LKG coordinator
(`context-handler.ts:4200-4247`). Either is still subject to section 9. Without one, the turn
is refused (`messages-transform.ts:578-585`; Pi `:4279-4287`). The binding-recovery path is
not a fallback: it cannot repair an invalidated current turn
(`signed-thinking-prefix-edits-audit.md:171-179`).

Nothing about a refusal is persisted, and nothing is latched. The next pass validates again
and replays as soon as it can, for example when an id that was missing at a compaction seam
(`transform-postprocess-phase.ts:3274-3280`) is back. A sticky refusal would turn a one-pass
seam into the loss of the rest of the turn. A refusal is logged and counted with the held
edits.

A pass with **no** boundary whose record does not validate is not refused: no current-turn
block is kept, so the pass may change the prefix. It is served as a prefix change: cut at
`first_kept.id` when that id is present, otherwise by today's decision (including serving the
window when the trim is refused), and in either case with the strip of all older-turn
thinking, and its unit is recorded.

**Policy cost.** On accounts that silently drop invalidated blocks (created before
2026-08-31), a refused pass is a failure where today the turn is served with reasoning
silently lost. That trade is deliberate: the alternative sends bytes the kept blocks were not
signed over. A primary session recovers at its next real user message, whose first pass has
no boundary and renders normally. With compaction on, subagents have no head
(`inject-compartments.ts:3975`; Pi gives them no m[0]/m[1]), so they never reach this
refusal. Compaction-off lifts that skip, so a compaction-off subagent has a head and follows
the compaction-off rule, which never refuses.

### Compaction-off mode: replay, never refuse

Compaction-off still serves a head and never cuts:

- the injection gate includes the mode (`m0M1EnabledForFold`,
  `transform-postprocess-phase.ts:1989-1992`), memory, docs and the user profile render
  through the zero-compartment path (`:3119-3122`), and the subagent skip is lifted
  (`inject-compartments.ts:3975`);
- there is no cut: compartment preparation is skipped (`transform.ts:2133-2146`) and
  `trimToPreparedPrefix` returns `not-attempted` (`inject-compartments.ts:3812`);
- there is no marker summary (the reconcile is gated off, `transform-postprocess-phase.ts:3503-3522`)
  and no proactive strip (`:4137`).

Its wrapper does not fail closed. On a fail-closed error, `EmergencyFailClosedError`
included, and on every other failure, OpenCode restores the raw input and returns it
(`messages-transform.ts:428-436, 449-453, 606-610`). Pi falls through to its own messages on a
non-transient failure (`context-handler.ts:4279-4294`) and refuses only a transient storage
failure (`:4264`). A managed-mode refusal there would therefore send the raw request without
the head that every kept block was signed after, which is certainly invalid. So:

- **The record is written as in managed mode**, at the end of a pass with no boundary. It
  holds `head`, `turn` and `provenance`; `summary` is always `none` and `first_kept` is the
  first raw message of the host's array.
- **A pass with a boundary never refuses for the prefix.** It serves the first of:
  1. the record, when it validates;
  2. the complete cached pair, as `freezeM0M1` replays it today; with no cut there is
     nothing to re-derive;
  3. a render, as today.

  Items 2 and 3 are best effort, not guaranteed valid. Each is logged as
  `served_prefix_unverified` and counted with the held edits.
- **A failed record write does not fail the pass.** A thrown error would become raw
  passthrough. The pass is served as computed, the previous record stays, and the failure is
  logged and counted. A later pass with a boundary whose record then fails its turn or digest
  check takes item 2. The cached pair holds the head the failed write tried to record:
  `materializeM0` and `softRefreshCachedM1` commit it before the pass serves it
  (`inject-compartments.ts:2448-2801`, `:3253-3337`). A failed write therefore degrades that
  turn to today's behaviour, never to raw passthrough.
- **Pi compaction-off has no thinking freeze today.** `runCompactionOffPipeline`
  (`context-handler.ts:5489-5510`) calls `injectM0M1Pi` without a prepared prefix, so
  `mustMaterializePi` (`inject-compartments-pi.ts:2765`) decides as on any pass, and a HARD
  re-renders the head under kept thinking (code-read, not yet tested). The same three-step
  replay applies there. Its own prepared-prefix replay (`prepareCachedM0M1PiReplay`, as
  `context-handler.ts:5924-5930` uses it) is item 2.

Host edits to raw history in this mode, such as OpenCode's own native compaction, are
section 9's class.

### Upgrade, clone and repair

There is no seeding from the cached pair: its premise was the false claim above. A session
with no record for the current turn (upgraded, cloned, or with a record from an earlier
turn) behaves as any record that does not validate. With no boundary, the pass renders or
replays as today and records its unit. With a boundary, every managed pass of that turn
refuses (or replays a fenced snapshot; compaction-off takes its fallback), because only a pass with no boundary can write the record,
and the session recovers at its next real user message. This is per-pass revalidation whose
outcome lasts for the rest of that turn, not a latch. It is bounded: the migration that adds
the column restarts every host ("Persisted state", section 4), which ends the turns in flight,
so it reaches only a turn resumed after the restart without a real user message. The clone
and repair rules are in section 4, "Persisted state".

**Rust** is not exposed. The module serves its own frozen render, skips the m[0] mutation rows
it writes itself (`MODULE_M0_MUTATION_TARGET`, `context_writes.rs:243-250`), and has no cache
clear. The `Recomp` lane stays as a guard, and a Rust lane for an in-place fold upsert joins
it (section 11).

Why replay rather than refuse by default:

- The last-served bytes are valid by construction: the provider minted every kept block
  against them.
- The writers that move the prefix are background maintenance. Refusing on each of them would
  fail every pass until the turn ends.
- The cost is staleness: an improved summary from a recomp, or a moved cut, waits until the
  turn ends, as held tag drops do.
- Storage is one record per session, about the size of the cached pair it shadows.

The record covers Magic Context's prefix only. A host edit to raw history after the first kept
message, such as the OpenCode late-user splice, changes bytes the record does not hold
(section 9).

**The legacy `<session-history>` block needs nothing new.** It is rendered on two paths, and
neither is reachable for an OpenCode primary session in production:

- The branch at `transform-postprocess-phase.ts:3214-3236` runs only when
  `m0M1EnabledForFold` is false. `transform.ts` always passes `m0M1` (`:2805-2820`), so that
  needs both `projectPath` and `projectDirectory` empty. `projectPath` is the project
  identity, set only when memory is enabled (`:1968-1970`). `projectDirectory` is the session
  directory, which falls back to `deps.directory` (`:1098`), and OpenCode always supplies the
  plugin's directory (`hook.ts:750`, `v2/hooks/context.ts:1559`). Only a host that passes no
  directory at all, such as a test, reaches it, whatever the model.
- The fallback after a failed `injectM0M1` (`:3188-3211`) needs
  `args.pendingCompartmentInjection`. Compaction-off, the only mode that reaches it (a
  managed pass has already thrown in `failPass`, `:1897-1907`), never prepares one
  (`transform.ts:2133-2146`).

If either ever runs, its block is rendered before the first raw message, so the record
covers it as `head` bytes, like m[0]/m[1].

## 8. Subagents, the force band and the 95% wall

A subagent's whole run is one turn. On a prefix-bound model the boundary is the newest
signed block, so every edit before it is held for the whole run. On strict accounts Magic
Context can reclaim nothing that precedes the newest thinking until the subagent finishes.
That is the cost of correctness, and the design states it rather than hiding it.

What still works: content **after** the boundary can be edited. That is the tool results the
model has received since its last thinking block, usually the newest and often the largest
input. Pi's 95% wall already drops the newest tool result, which the audit found valid.

**Force band (85% by default).** Admitted reclaim (after the boundary) lands on the band's
first pass and spends the episode, as today. Reclaim the frame holds does not bust: the
episode is parked for the rest of the turn (section 4), not spent and not reused, and
released at the next turn. No pass manufactures a bust. Log once per force episode that
reclamation is held by signed thinking, with the held edit count and the current usage.

**95% wall.** In order:

1. **Admitted tail reductions.** Apply emergency reductions only to coordinates the frame
   admits, which means whole tool arcs (parallel batches included) after the boundary
   (section 3). All runtimes do this. Pi does it today; TS and Rust hold everything at the
   wall today, and the strict mixed-pass test requires TS to land it (section 11). The wall
   is live pressure, so every pass at the wall may do this.
2. **Send the request.** An admitted reduction is a valid request, and so is a pass whose
   reductions were all held: the audit sends both today and the provider accepts them. The
   hold adds no refusal of its own. The pass is refused only where `ARCHITECTURE.md` already
   refuses: at a *provider-proven* 95%, a context limit parsed from a provider overflow for
   this model (`provider_proven_limit`, `transform.rs:5080-5085`;
   `FrozenReplayOverProvenLimitRefusal`, `rust-mode-transform.ts:210`), with nothing folded
   (`ARCHITECTURE.md:24`). When that existing refusal fires on a pass whose reclaim was held,
   its message also names the held edit count, so the cause is visible. r2 refused whenever
   usage was still at or above 95% after held reclamation; that turned servable requests into
   failures and is withdrawn.

**The subagent wrap-up is removed from this fix.** r1 proposed appending one synthetic user
instruction at the wall to end the subagent's run early. It is not part of this design: the
wall sends what admission allows, as above, until a live capture with kept signed thinking
shows that a mid-loop user append is accepted. The panel found no such capture, and the
reasons to wait are concrete:

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
| **OpenCode late user message spliced into a served tool-result carrier** | OpenCode stamps a user message's `time.created` before the step's assistant is created but writes it after that step's history snapshot. Every later load sorts it before that assistant, and `groupIntoBlocks` merges it into the tool-result carrier the previous request ended with (`user-append-into-served-carrier.md:16-39, 96-107`). The assistant's thinking was signed without that text. | **Explicitly out of scope.** It is a host input change, not a Magic Context edit: the bytes it changes are raw history, outside both admission and the served prefix record (section 7). The owner is OpenCode (`prompt.ts`, per the report). If it produces a binding 400, the existing binding-recovery path behaves as today, which cannot repair the current turn. This fix adds no detection; a detector that compares the live array with the last served request would be a separate design. |
| **Last-known-good replay re-exposing a double-signed assistant** | The OpenCode Rust-mode recovery ladder restores a captured served prefix and appends the current tail without the proactive older-thinking strip, which can re-expose an assistant with two signed parts that the live validator rejects (`cereb-lkg-reasoning-run-2026-09-28.md`). | **Detect and decline, which exists today; no recovery.** The LKG validator declines that shape (`lkg_anthropic_reasoning_run_invalid`) and the pass falls back to the raw request. That report's idea of stripping later reasoning in the replayed tail is not safe and is not part of this fix. LKG replay is not an admission lane, and section 7 uses a full-request snapshot only when its own fences, this validator included, pass. |

The Claude Code client may also edit its own history mid-turn (section 6, "Still needs
THALAMUS", item 2). That is in the same class as the OpenCode splice: out of scope, and not
covered by any promise here.

## 10. Proposal: amending ARCHITECTURE.md's pass taxonomy and invariants 1 and 4

`ARCHITECTURE.md` invariant 4 ends with: *"There is no mid-turn deferral: a tool loop is not a
reason to hold an execute (…)"*, and invariant 1 says *"Never 'defer' a hard bust. This pass
IS the fold; there is no later fold to wait for."* (`ARCHITECTURE.md:80, 83`). The pass
taxonomy above them says every pass is exactly one of SOFT+, SOFT and HARD, and that on a HARD
pass *"`mustMaterialize` fires → m[0] re-materializes"* (`:63-66`). On prefix-bound models
this design holds edits inside a tool loop, the HARD fold among them, so it contradicts all
three as written, and the next editor who follows them would undo the fix. They live in the
operator-maintained protected region, so this delivery does not edit them.

**Pass taxonomy**, one bullet added after HARD:

> - **Held (prefix-bound thinking only):** while the current turn keeps a signed thinking
> block, a pass replays the served prefix record (head, compaction summary and cut)
> byte-identically whatever SOFT or HARD trigger is pending, edits after the last kept
> thinking block may land, and the pending trigger waits for the first pass that keeps no
> current-turn thinking (the edit-admission module, `edit-admission.ts`).

**Invariant 4**, proposed in full. Its bold title and first three sentences are unchanged;
the fourth ("There is no mid-turn deferral …") is reworded, and the rest is new:

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
> **Provider validity is the one exception.** On prefix-bound thinking models (the ones
> `isPrefixBoundThinkingModel` and `is_prefix_bound_thinking_model` match) every kept signed
> thinking block is bound to the bytes before it. So every first-application edit, in every
> lane, asks the one admission check of `docs/designs/signed-thinking-hold.md` before it
> mutates, and an edit that lands before the last kept current-turn thinking block is held:
> not applied, not persisted, and its trigger not spent. Bust permission authorizes spending
> cache; it never authorizes invalidating a signature. There is still one permission per pass,
> and the validity check is one predicate applied the same way to every coordinate. By
> outcome it splits a pass: the prefix lanes (m[1] refresh, fold) always sit before the
> boundary and are held, while edits after the boundary land, so one trigger can price a
> tail bust now and a prefix bust at the next turn. That split is accepted for provider
> validity alone; any other difference between lanes is still the defect above. A trigger
> whose authorized work was held is parked: no pass that keeps current-turn thinking treats it
> as armed, and the first pass that keeps none (normally the first pass of the next turn)
> carries its original permission forward, so that pass busts for the original reason and
> every lane drains into it. Held opportunistic work carries no permission; it waits for the
> next permitted bust, as it does everywhere else.

**Invariant 1**, with three sentences added at its end:

> 1. **A HARD bust means the prefix is already gone → drain EVERYTHING into it. Never "defer"
> a hard bust.** This pass IS the fold; there is no later fold to wait for. Deferring the
> drain only produces a second, avoidable bust ~one turn later. (The `compartmentRunning`
> veto must therefore yield to a hard fold — the fold-exec bypass.) *The one exception is
> provider validity: on a prefix-bound thinking model whose current turn keeps signed
> thinking, the fold, a first render included, is a prefix edit; the pass replays the served
> prefix, opens no drain that only the fold would open, and lands only edits after the kept
> thinking. A HARD trigger that persists in state (a published compartment, a queued
> mutation, a cleared cache) folds on the first pass that keeps no current-turn thinking, and
> everything eligible drains into it. A HARD that only time makes true (TTL expiry, cache
> eviction) is not observed while thinking is kept and is not carried over.*

The added sentences say three things. The fold waits, not only its drain: r2 qualified only
the drain, and a reader following the unamended "this pass IS the fold" would fold under kept
signatures again. A first render waits too, because TS's `firstRenderBust` opens the drains
today without consulting the freeze (section 4). Admitted edits after the boundary may land,
which matches invariant 4; r3's "waits, with its drain" contradicted it. r3 also said a TTL or
eviction HARD pays a second fold at the next turn. That is withdrawn: the hold short-circuits
before `mustMaterialize`, TS computes neither `foldDueDecision` nor `idleExpiryRebuild` under
the freeze (`transform-postprocess-phase.ts:2032-2033, 2247`), and the TTL condition consumes
itself, so such a HARD is never observed or recorded under kept thinking, and the next turn
decides from the cache state it then finds. Only HARD triggers that persist in state carry
over. The released fold is a real HARD, so everything eligible drains into it then,
including opportunistic work; nothing opportunistic originates a bust of its own.

## 11. Test plan

### Acceptance: the strict audit suites

The three audit suites are the acceptance gate. Under `MC_AUDIT_STRICT=1` they assert the
whole contract for **every** lane, not just validity:

1. the mid-loop bust is valid, which now includes tool pairing (below);
2. nothing before the last kept thinking block changed; outside the 95% wall lanes, no byte
   outside thinking changed at all. At the 95% wall the newest tool results after that block
   may be reduced, in every runtime (`beforeLastThinking` in the shared mock). **New in r4:**
   no thinking block changed either (`thinkingBlocks` in the shared mock), except in the
   `keep_reasoning_tokens` lane, whose removal from the start is the lane's own work;
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

**Added in r2:**

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

**Added in r3:**

- **The cut moved on replay** (OpenCode 1, OpenCode 2, Pi; finding 6b). The first turn is
  folded at the start of the second, so the cached pair is served with an inclusive cut
  through the first turn's summary message. Then `replaceAllCompartments` rewrites that
  compartment so that it ends part-way through the message, without clearing the pair, and
  no bust is offered. Two tests, each in every host:
  `prefix cut moved by a compartment rewrite that keeps the cached pair: mid tool loop` and
  `…: defer pass at a new user turn`. By default both pin today's result: the cut moves and
  the request is rejected with `PREFIX_ERROR`. Strict requires the defer pass to be valid,
  not to move the cut, to change no byte outside thinking, and (mid-loop) to repeat
  byte-identically, continue validly and stay valid at the next turn. The rewrite is
  ride-only, so landing it at the next turn is not required. These are separate tests, not
  lanes in the generic loop, because the generic control ("the edit lands validly at a new
  user turn") is the wrong bar here: at a new user turn the defer pass must replay the
  recorded cut too.

**Added in r4:**

- **No thinking change on a held pass** (item 2 above; OpenCode 1, OpenCode 2 and Pi). Every
  held lane compares all thinking blocks with the pass before it. By default it pins today:
  in OpenCode every held primary lane strips the previous turn's blocks, and no subagent lane
  does (a subagent has no previous turn); in Pi the held `/ctx-flush`, HARD fold and 95% wall
  lanes do (`STRIPS_THINKING_WHEN_HELD`). Strict requires no change. The new mock unit test
  `thinkingBlocks sees a valid removal of older-turn thinking that the other views ignore`
  shows that `withoutThinking` and `beforeLastThinking` cannot see this change, which is why
  the earlier suites passed these lanes.
- **The compaction-marker summary retired by a bust** (OpenCode 1 and OpenCode 2; finding 6c):
  `compaction-marker summary retired by a bust: mid tool loop`. A marker is served from a
  turn-start `/ctx-flush`, cleared mid-loop, kept on the wire by a defer pass, and then a
  `/ctx-flush` is offered. By default it pins today's result: the summary is removed and the
  request is rejected with `PREFIX_ERROR`. Strict requires the pass to be valid, to keep the
  summary, to change no byte outside thinking, to repeat byte-identically, to continue
  validly, and to stay valid at the next turn. Pi has no lane: its transform serves no
  summary.

Without `MC_AUDIT_STRICT` the exposed lanes still assert their exact 400, Rust's
`release_gap` lanes assert that they do not release, and the restart gap and the TS tail
requirement are pinned. Today's results:

| Suite | Default | `MC_AUDIT_STRICT=1` today | Must be after the fix |
|---|---|---|---|
| OC1 TS / OC2, `packages/plugin/.../signed-thinking-prefix-audit.test.ts` | 94 pass | 52 pass, 42 fail, 21 in each host: the audit's 7 exposed lanes, the 9 held primary lanes that passed before (every one but `keep_reasoning_tokens`, on the new thinking assertion), `release survives a restart: /ctx-flush`, the mixed pass, the two cut tests and the marker test | 94 pass |
| Pi, `packages/pi-plugin/src/signed-thinking-prefix-audit.test.ts` | 45 pass | 36 pass, 9 fail: m[0]/m[1] recomp, synthetic todo, frozen-sentinel, `/ctx-flush`, HARD fold and 95% wall (thinking changed), `release survives a restart: /ctx-flush`, the two cut tests | 45 pass |
| Rust, `crates/mc-module/tests/signed_thinking_prefix_audit.rs` | 6 pass | 3 pass, 3 fail: `opencode_rust_mode::primary_mid_loop` (first failure is now the DropFull trigger assertion), `claude_code::primary_mid_loop`, `claude_code::control_at_new_user_turn` | 6 pass |
| Mock, `packages/plugin/.../__tests__/strict-binding-mock.test.ts` | 12 pass | (no strict mode) | 12 pass |

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

### Served prefix record, parking, persisted state and release cases

These need the implementation; each is written with the slice that makes it pass.

- the record replayed byte-identically, with a mural-bearing head, a partial cut and an
  inclusive cut, after each kind of writer: a clearing writer (recomp promotion), a
  non-clearing rewrite (`replaceAllCompartments`, and the Rust fold upsert on a TS-served
  session), and a soft refresh earlier in the turn (the record holds the refreshed m[1]);
- the record is written after the trim: a pass whose trim is `refused` or finds the boundary
  before the window records what it actually served, and a later replay serves exactly that;
- a store-generation rebase that keeps the first kept id but changes its row: the digest fails
  and the pass refuses, it does not render;
- **per-pass refusal**: a compaction seam where the first kept id is absent for one pass
  refuses that pass only, never renders, and the next pass replays when the id is back;
- a record from an earlier turn, and no record at all (upgrade, clone): refuses at a
  boundary on every pass of that turn; renders and records with no boundary; the next real
  user message recovers;
- a record write that fails: the pass is not served;
- a defer pass with no boundary whose record no longer validates: served with the strip of
  all older-turn thinking and recorded;
- Rust single-store repair during a held turn: the record survives, the next pass replays it,
  and the fold lands on the first pass of the next turn; a Rust lane for an in-place fold
  upsert next to `Recomp` (not exposed today; a guard);
- clone of a session with both columns set: both are NULL in the destination;
- an older `mc-store` binary opening a store migrated by the release-request slice refuses
  (`store_ahead_of_binary`);
- **parking**: a `/ctx-flush` and a force episode held mid-loop authorize no later pass of the
  turn (no admitted tail edit lands on the following loop passes because of them), and both
  release at the next turn; at the 95% wall each pass may still land admitted tail reductions;
  a second `/ctx-flush` while one is parked joins it;
- **TS and Pi standing permissions** (section 4): after a clearing writer mid-loop
  (`firstRenderBust`), after a writer's mutation row (the drift watcher, TS) and after a held
  execute, no later loop pass of the turn is a busting pass: no admitted tail edit lands
  because of them, and the drift watcher does not re-add the session on each pass; each
  releases at the next turn;
- **the record's turn** (section 3): a user message whose only text is a system reminder,
  and a synthetic user message with real text, each inside a held turn: the record still
  validates on every later pass of that turn, because writer and checker use the frame's
  rule; and a record left from an earlier turn whose head and first kept message are
  unchanged still refuses at a boundary;
- **the summary in the record**: a marker cleared mid-loop keeps its summary through every
  later pass of the turn and through a marker move offered then, the replay reports itself
  as not consumed (no marker drain, no deferred-history drain), and the first pass of the
  next turn retires or moves it; in OpenCode Rust mode the same with `prefix_bust_permitted`
  true on a mixed pass;
- **`first_kept = none`**: a record with no first kept message refuses at a boundary
  (managed) and takes the fallback (compaction-off);
- **compaction-off** (OpenCode 1, OpenCode 2 and Pi, primary and subagent): a head served
  before kept thinking, then a record that does not validate: the pass serves the cached
  pair, never the raw input; a failed record write serves the pass as computed and the next
  pass serves the same head; a HARD under kept thinking in Pi compaction-off does not
  re-render the head;
- **clone script**: `copyContextMeta` leaves both columns NULL when the source has them set;
- the Claude Code strip replayed at turn N+1 leaves turn N's thinking in place, and still
  removes a block the client surfaces later inside the strip's own domain;
- with the `claude-code-anthropic` gate on (rollout steps 2 and 4), a held `/ctx-flush` is
  cleared as today and no release request is written, so nothing busts at the next turn;
- a CAS conflict on a pass that recorded a release request (TS/Pi write and Rust commit), and
  a restart between the held pass and the release, in Rust as well;
- an idle session whose tag targets are protected but which has no queued operation: no
  release request, no bust at the next turn;
- a held Rust pass commits `rewrite_temporal_marks = false` and the drain latch as computed.

### Mutation controls, one per lane

Each control neutralizes one admission call site, making it return "admit", or removes one
guard. It runs the named strict test, and only that test may go red.

| Control | Expected red (strict) |
|---|---|
| TS stale-reduce `admit` | `OpenCode 1 TS mode, primary mid tool loop > stale ctx_reduce strip`, and the subagent run test of the same name; OC2 the same |
| TS todo `admit` | `… primary mid tool loop > synthetic todo` |
| TS placeholder `admit` | `… frozen-sentinel first application` (primary and subagent) |
| TS image `admit` | `… processed image strip` |
| TS `Prefix` hold, with the record replay neutralized | `… m[0]/m[1] re-render after a recomp clears the cached pair` |
| TS/Pi record replay re-reads the cut from compartments | `… prefix cut moved by a compartment rewrite that keeps the cached pair: mid tool loop` and `…: defer pass at a new user turn` |
| TS tag-target `admit` | every held tag lane (drops, reclaim, dedup, 85%, 95%, flush, caveman), as in the audit's own proof |
| TS/Pi arc coordinate reduced to the result alone | the mixed-pass test, on `ORPHAN_ERROR` once the tail reduction removes a result |
| Pi todo / placeholder / prefix `admit` | `Pi/OMP, primary mid tool loop > synthetic todo` / `> frozen-sentinel first application` / `> m[0]/m[1] re-render …` |
| Pi proactive strip on `cacheBustingPass` alone | `Pi/OMP, primary mid tool loop > /ctx-flush`, `> HARD fold after historian publication` and `> emergency 95% wall`, on the r4 thinking assertion. r3 doubted this control could discriminate; the new assertion answers it, because those three lanes strip today |
| TS proactive strip on `prefixEditBesidesReasoningTrim` | every held OpenCode primary lane but `keep_reasoning_tokens`, on the thinking assertion |
| TS merged-reasoning strip not held on a pass with a boundary | the same lanes, on `MIDDLE_ERROR` once the proactive strip is gated |
| Marker retirement not held (TS mode) | `… compaction-marker summary retired by a bust: mid tool loop` |
| Record replay reports itself as consumed | the summary-in-the-record case above (the marker drain moves the summary) |
| `firstRenderBust` not parked under a boundary | the standing-permissions case above |
| Compaction-off refusal routed to the wrapper | the compaction-off case above (raw input served without the head) |
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
| **Parking control:** let a parked trigger authorize a later pass of the same turn | the parking case above |
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
  Until then a held result for them proves nothing;
- compaction-off lanes (all three hosts): the suites run only managed mode, so the
  compaction-off failure path, and Pi compaction-off's missing freeze, have no audit lane
  yet. Each needs a fixture with the mode on and a way to fail one pass;
- the marker lane in OpenCode Rust mode, which needs the Rust-mode host test harness.

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
- **Held state:** the served prefix record (one per session, about the size of the cached pair
  it shadows, rewritten at most once per turn plus once per prefix change) and the release
  request (one column in TS and Pi, one meta field in Rust). Held edits are re-detected from
  live state at release. Nothing accumulates per pass. Validating the record costs one id
  lookup and one digest of one message per pass.

- **Turn identity** (section 3) is not part of the frame. It is one walk of at most *T* + 1
  visits with the frame's predicate, only on passes that validate a served prefix record
  (OpenCode TS and Pi, managed and compaction-off), the same order as `findLastUserMessageId`
  and `findLatestUserMessageIdPi`, which run on every pass today. Parking needs no walk.

The frame's cost guard counts every message visit, including those inside helper
predicates, on a 2,000-message history. It covers the frame alone: it asserts at most
*k* + 2 visits when the turn has retained thinking and at most *T* + 2 when it has none, and it
fails if any helper the frame calls rescans the turn. A second guard asserts at most *T* + 2
visits for the turn-identity walk.

## 13. Rollout order

0. Passive storage, before anything reads it: one `context.db` migration adding
   `served_prefix` and `held_release` to `session_meta`, the release-request field in the
   module meta with its `mc-store` migration, fences bumped, both dists rebuilt, every host
   restarted (section 4, "Persisted state"). Numbered at slice time.
1. The shared check and its corpus in TS and Rust, beside the existing issue 630 protection,
   which keeps deciding tag targets. Parity test.
2. Rust triggers: the force latch ignores bookkeeping units, a plan whose edits are all held
   is downgraded to a defer (with `pass_already_busting` decided after admission), and held
   triggers are parked. The new `TransformCommit` rows (guidance date, pending tag and hint
   lists) land here. Flips the Rust trigger assertions. **Not on the
   `claude-code-anthropic` profile until step 8:** there the held `/ctx-flush` is still
   cleared as today, and the gate covers parking too: that profile writes no parking record,
   so its force episodes and flush arm behave as today.

   **Step 2b**, TS and Pi parking: `firstRenderBust`, the TS drift watcher and the held
   execute signal are parked under a boundary (section 4); a pass with a boundary gets no
   ride from them. It ships before step 3, so the lanes step 3 admits cannot ride a standing
   permission. Its tests are the parking and standing-permission cases (section 11). The
   `claude-code-anthropic` profile is not affected: it runs in the Rust module.
3. The non-tag lanes in this order: placeholder and system-injected strips, stale reduce,
   image, todo (with the anchor clears), temporal markers and the overlay frontier, then the
   Rust coverage fold. Each lane flips its strict audit test to green, with its mutation
   control.
4. Release obligations, recorded only from withheld authorized work into the columns of
   step 0. Flips the restart and Rust release assertions. **Not on the
   `claude-code-anthropic` profile until step 8:** that profile writes no release request.
5. Compound tool-arc coordinates, and admitted tail reductions at the 95% wall in TS and
   Rust. Flips the TS mixed-pass test. The Rust half ships with a Rust fixture that lands a
   reduction at the wall (section 11, parity gaps); until then it has no test that can fail.
6. The served prefix record in TS and Pi: written after the trim, replayed head, summary and
   cut together with the `prepareCachedM0M1Replay` result contract, validated per pass with
   the turn identity of section 3, local per-pass refusal as a degraded pass. Marker
   retirement, apply and move held under a boundary, in TS mode and in the OpenCode Rust-mode
   host (which records the summary only). Compaction-off replays and never refuses, in all
   three hosts, which gives Pi compaction-off its first freeze. Flips the m[0]/m[1] recomp
   lanes, the cut tests and the marker test.
7. The proactive older-turn strip gated on an admitted edit in OpenCode (re-gating
   `prefixEditBesidesReasoningTrim`) and in Pi (`cacheBustingPass`), the merged-reasoning
   strip held on a pass with a boundary, and the companion-strip precondition in every
   runtime. Flips the thinking assertion of the held lanes. It ships with or before step 6
   in each host, so a stripped first kept message cannot break a new record's digest.
8. The Claude Code completed-turn strip, with its domain frozen at mint, after THALAMUS's
   per-model split confirms section 6. Removes the profile gate of steps 2 and 4.
9. Finding 8's host fix and its test.
10. Retire the identity map and Rust's ordinal walk in favour of the check, once the parity
    test is green.
11. Delete the `EXPOSED` / `exposed()` / `release_gap()` / `RESTART_GAP` scaffolding and make
    strict the default.

**Why the Claude Code profile is gated out of steps 2 and 4 rather than step 8 landing
first.** On `claude-code-anthropic` every bust at a new user turn is a 400 until the
completed-turn strip exists (finding 4), and the gateway turns that 400 into a 503 that the
client retries about 12 times. Today a held `/ctx-flush` is silently lost on that profile;
step 2 would keep it and step 4 would release it at the next turn, turning a silent loss
into a failed turn. Step 8 waits on an external confirmation (THALAMUS's per-model split), and
ordering everything behind it would hold back validity fixes for every other profile. The
gate is one profile condition in two places, it keeps Claude Code exactly as it is today,
and step 8 removes it in the same change that makes the release valid. What the gate does
not change: Claude Code's held drops and force episodes already survive to the next turn and
fail there today, and step 3 moves the Rust coverage fold's failure from mid-loop to the
next turn's start; both are one failure in place of one, until step 8.

The subagent wrap-up instruction is not a follow-up of this fix; it may be revisited only
after a live capture (section 8). Server-side clearing is a separate study.

## Verification of this design delivery

Run locally on macOS for r4 (Bun 1.4.2, TypeScript 5.9.3, Biome 2.5.1):

- `bun test src/hooks/magic-context/signed-thinking-prefix-audit.test.ts
  src/hooks/magic-context/__tests__/strict-binding-mock.test.ts` in `packages/plugin`:
  106 pass, 0 fail (94 audit, 12 mock). With `MC_AUDIT_STRICT=1` the audit file gives 52 pass
  and 42 fail, as listed in section 11.
- `bun test src/signed-thinking-prefix-audit.test.ts` in `packages/pi-plugin`: 45 pass,
  0 fail. Strict: 36 pass, 9 fail (section 11).
- The Rust suite is unchanged since r2; its results stand (6 pass; strict 3 pass, 3 fail).
- `bun run typecheck` in `packages/plugin` and `packages/pi-plugin`: exit 0. `biome check` on
  the four changed test files: no diagnostics.
- Finding 10's diagnosis was checked by mutation and restored: with the OpenCode proactive
  strip turned off, the held `/ctx-flush` pass is rejected with `MIDDLE_ERROR`, and the
  session's `merged_reasoning_stripped_ids` gains `step-3` and `step-4`.
- No product code, architecture document, package manifest or lockfile changed.

## Changes from r3

Each row is a finding of the third Athena review (consult
`ct_00000000-0000-489b-98dd-b7a15299ebb8`) and where this revision answers it. The review
accepted as sound: the served prefix record's core (head and cut as one unit, written after
the trim, first kept id plus digest), the managed-mode failure path, the `TransformCommit`
table and the persistence discipline.

| # | Finding | Answer in r4 | New mechanism? |
|---|---|---|---|
| 1 | Turn identity: the record's turn and the parking record named the message the frame's scan stopped at, which on a pass with a boundary is the thinking message | Section 3, "Turn identity": the turn is the last real user message by the `isInActiveAnthropicTurn` rule, found on a boundary pass by continuing the frame's walk. TS's `currentTurnId` (`transform.ts:847`) and Pi's (`context-handler.ts:5802-5814`) use a different predicate, which is why they are not reused. Rust needs none. Section 4: parking carries no turn id; a parked trigger is armed only on a pass whose frame has no boundary. Section 12: the *k* + 2 guard covers the frame alone, and the walk has its own *T* + 2 guard | No: one walk where TS and Pi already walk; parking loses a field |
| 2 | Compaction-off (blocker): its wrapper turns every failure into the raw input while a head is still served, so a refusal would drop the head under kept thinking | Section 7, "Compaction-off mode": no cut and no summary there; a pass with a boundary replays the record, else the cached pair, else renders, and never refuses; a failed record write serves the pass and degrades to the cached pair. Found on the way: Pi compaction-off has no thinking freeze at all today (code-read). Subagents with compaction off do have a head; r3's "never reach this refusal" is corrected | No: an ordering of today's replays |
| 3 | The compaction-marker summary (blocker): an unrecorded prefix component, retired on any busting pass, TS and Rust mode | New lane and test (finding 6c), red today in OC1 and OC2. Section 7: the record holds the summary; `first_kept` is the first host raw message after head and summary; marker retirement, apply and move are `Prefix` edits held under a boundary (section 5, row 6c); the replay keeps `prepareCachedM0M1Replay`'s not-consumed contract; the Rust-mode host records the summary alone | One field in the record |
| 4 | Three TS standing permissions (`firstRenderBust`, the drift watcher, a held execute), and no TS/Pi parking step | Section 4: a table of the three with the Pi equivalents (Pi has no drift watcher), each parked. Section 13: step 2b for TS and Pi, before step 3; the step-2 Claude Code gate covers parking | No |
| 5 | The TS proactive strip fires on an all-held pass, and row 10 misdescribed it | Measured: every held OpenCode primary lane strips the previous turn's thinking, and Pi does on three lanes (finding 10, new strict assertion). Row 10 corrected; the merged-reasoning strip, which today relies on it, is held too; step 7 covers both hosts and ships with or before step 6 | No |
| 6 | Invariant text | Section 10: the taxonomy gets a "Held" bullet; invariant 1 says the fold and a first render wait, admitted tail edits land, and a time-only HARD is not carried (r3's "second fold" withdrawn); invariant 4's parking sentence matches section 4 | No |
| 7 | `meta.guidance_date` and the pending tag and hint lists unclassified | Section 4 table: the date line is a `Prefix` coordinate and waits; an id leaves a pending list only when its block is admitted and served | No |
| 8 | Clone and repair | Section 4: the core clone's `ON CONFLICT` keeps unlisted columns, so both are listed NULL; its PRAGMA walk is not a generic copy, but the clone script's `copyContextMeta` is, and must return NULL for both. The repair list gains neither column; its NULL-target mutation row is a HARD held under a boundary | No |
| 9 | Open items: `first_kept = none`; the legacy `<session-history>` path | Section 7: `none` never validates under a boundary (refuse, or the compaction-off fallback). The legacy block is unreachable for an OpenCode session in production (both paths traced) and is covered as head bytes if it runs | No |
| — | Smaller precision points: "boundary" means `!admit(Prefix)`; the refusal's error class; the TS-mode LKG slot; the `preparedPrefix` branch | Section 7: a pass with a boundary is the prefix-bound case; the refusal is a degraded pass, so the wrapper tries LKG (TS and Rust mode alike) before refusing, never `EmergencyFailClosedError`; the hold covers the `preparedPrefix` branch of `injectM0M1` | No |

Where nothing new was needed: findings 4 to 9 close by classifying, gating or tracing code
that exists. The record grew one field (the summary), and parking lost one (the turn).
Compaction-off adds a rule, not state.

## Changes from r2

Each row is a finding of the second Athena review (consult
`ct_00000000-0000-4672-98dd-ba9da45b5978`) and where this revision answers it. The review
confirmed as closed: issue 630 parity, the Rust force-band latch diagnosis, pure and durable
release obligations, and Pi's id space.

| # | Finding | Answer in r3 |
|---|---|---|
| 1 | The upgrade seed rests on a false premise: `appendCompartments`, `replaceAllCompartments`, the Rust fold upsert and `replace_compartments_from_first_sequence` do not clear the cached pair, and `isPartialCompartmentEnd` reads the live row | Section 7: the premise is withdrawn and there is no seeding from the pair. A session without a record for the current turn refuses per pass at a boundary and recovers at the next real user message |
| 1 | A replay with the pair present re-derives the cut every pass, and a `refused` trim serves the whole window | Section 7: the record (head and cut as one unit) governs every pass that does not change the prefix, with or without a boundary, pair present or not; a `refused` trim or source-order mismatch under a boundary is a local refusal. New tests pin the moved cut in OC1, OC2 and Pi, mid-loop and at a new user turn (sections 2 and 11) |
| 1 | The manifest was written inside `materializeM0`'s transaction, before the trim decided the cut | Section 7: the record is written at the end of the pass, after the trim and every later lane; a failed write fails the pass |
| 1 | It was replaced only on a render, missing `softRefreshCachedM1` | Section 7: rewritten on every serve with no boundary whose unit differs, which covers renders, soft refreshes, folds and cuts decided on a replay |
| 1 | Id adjacency checks nothing in partial mode and cannot see split or folded rows | Section 7: the cut is identified by the first kept served occurrence, id plus digest of its returned bytes; `capturePrefixTrimSourceOrder` stays as the trim's guard, refusing instead of serving the window. Why this is enough, and why a smaller construction is not, is argued there |
| 2 | Refusal duration contradicted itself (until the turn boundary vs replay when the id returns) | Section 7, "Refusal is decided per pass": one rule, per-pass revalidation, nothing latched; the test plan matches |
| 3 | The invariant 1 amendment qualified only the drain | Section 10: the HARD fold itself waits, with its drain, for the next turn; a TTL or eviction HARD pays a second full write. Invariant 4 rewritten: one permission and one predicate, the per-coordinate split accepted by outcome for validity only, the release described as the original permission carried forward, not a ride; model names replaced by the predicates; the claim about unchanged sentences corrected |
| 4 | Steps 2 and 4 open a Claude Code window before step 8 | Section 13: the `claude-code-anthropic` profile is gated out of steps 2 and 4 until step 8, with the reason (step 8 is externally gated; the gate keeps Claude Code as it is today) |
| 5 | Persisted state without migration and fence discipline; clone and repair rules missing | Section 4, "Persisted state": both columns on `session_meta` in one migration numbered at slice time after v97, fence bump, fresh schema, `ensureColumn`, both dists, restart; no table so no `SESSION_SCOPED_TABLES` entry; an `mc-store` migration so an older module refuses the newer store; clone writes both NULL; the single-store repair reset list gains neither column, and its fold is held by the host while a boundary exists. Rollout step 0 lands the storage passively |
| 6 | `TransformCommit` split missed `rewrite_temporal_marks`, and classed `scheduler_observation` as observation although it carries drain-latch state | Section 4: a `rewrite_temporal_marks` row (false on a held pass unless every mark is admitted). `scheduler_observation` is a trace copy read only by trace loaders; the durable latch is the meta pair, which is pressure state and commits as computed, so the observation stays unchanged and r2's "drain latch unchanged" row is corrected |
| 6 | The downgrade came after `pass_already_busting` had driven meta writes | Section 4: the flag is decided after admission, or recomputed and the writes redone as a defer |
| 7 | The 95% wall refused beyond ARCHITECTURE's provider-proven refusal | Section 8: admitted reductions and fully held passes are sent; refusal only where ARCHITECTURE already refuses (provider-proven 95% with nothing folded) |
| 8 | A preserved but held trigger could become a standing bust permission | Section 4, "Parked triggers": a held trigger authorizes no later pass of the turn; the release request is the parking record; the 95% wall stays live pressure |
| 8 | The Claude Code replay strip had an unbounded domain | Section 6: the domain is frozen at mint to the turns completed then; extending it needs a new authorized edit |
| 8 | The `soft_refresh_pending` clear at `transform.rs:6002-6004` was not shown | Section 2: it runs whenever `prefix_replay_must_be_preserved` is false, i.e. on every provider-prefix mutation pass, which confirms the flush diagnosis |
| — | Unlisted fresh-render paths in `injectM0M1` | Section 5, row 6: the hold short-circuits before `mustMaterialize` and every fallback render path |
| — | The Pi proactive-strip mutation control may not discriminate; Rust step 5 has no failing test | Section 11 and section 13: the control is checked before it is relied on; the Rust half of step 5 ships with its fixture |

Where a mechanism grew: the record is written on every serve with no boundary rather than
only on renders, and it carries a digest and a turn stamp; section 7 explains why nothing
smaller holds. Parking adds no state: it reuses the release request. Everything else in this
revision removes or narrows (no seeding, no adjacency rules, no extra wall refusal).

## Changes from r1

Each item is a finding of the first Athena review (consult
`ct_00000000-0000-448f-98dd-be0494920bd0`) and where r2 answered it. Rows about the
`served_m0m1` manifest are superseded by the served prefix record ("Changes from r2").

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
| 7 | The 95% subagent wrap-up was not shown safe | Section 8: removed; the wall refuses visibly until a live capture (r3 withdraws that extra refusal, see "Changes from r2"); Pi's folding noted; server-side clearing stays out |
| 8 | The O(*k*) frame cost was wrong | Section 12: the reused helper is O(*T* log *n*); the frame is one reverse scan, and the guard counts visits inside helpers |
| 9 | `ARCHITECTURE.md` invariant 4 contradicts the hold | Section 10: exact replacement wording, plus one sentence for invariant 1, for the operator to apply |
