# Retiring old tool skeletons on an existing prefix rebuild

## Status and scope

This design addresses retained tool arguments that accumulate after drops in long
subagent loops, as reported in **issue 643**. Source analysis and synthetic
measurements use repository base `531d1adc876ee6f2d173ac318dd9a509400eb564`, before
any retirement implementation. This is not an implementation or
an assertion that Anthropic accepts arbitrary signed-thinking edits. No product
code, architecture document, live context store, host database or configuration
is changed or opened for this work.

**Decision:** retire old newest-20 anchor skeletons only on a pass whose existing,
shared prefix-rebuild permission is already true. Retirement never creates a
cache-bust opportunity. Keep conversation-end skeletons and native-thinking
skeletons separate; neither is evidence that the newest-20 rule is safe to relax.

The issue 643 reporter (@dhaern), using Magic Context 0.46.1 with OpenCode 1.18.35,
reported 111 sessions, 5,531 skeleton tags, 2,037 tags without recorded
reasoning tokens, and approximately 165k maximum retained argument tokens. These
are reported observations, not a dataset available to this design. The synthetic
experiment below tests mechanisms and attribution, not their prevalence in
that installation.

## 1. What is retained today, and what zero reasoning means

The shared new-drop chooser returns a mode to persist. It keeps a call's real
arguments for a small input in the newest-20 window, an explicit `keepSkeleton`,
or `cannotRemove()`; otherwise it attempts full removal and freezes a skeleton
if that attempt would strand the end. See
`packages/plugin/src/hooks/magic-context/apply-operations.ts:73–115,374–387,451–509`.
“Small” means at most 1,024 UTF-8 bytes of **string values recursively**, not
serialized JSON size (`tool-input-size.ts:11–40` in the same directory).
The newest-20 set counts tool tags of **any status**, not only active results.

| Source | Trigger and provenance | Retirement rule |
| --- | --- | --- |
| (a) Recent anchor | Small input and newest-20 at the original drop | Can retire once outside the current newest-20 set and all safety checks pass |
| (b) End separator | Removing this pair would currently leave an assistant-terminated request | Keep the current end guard unchanged; a former-end skeleton can retire once the guard is false |
| (c) Native-reasoning arc | A lane requires a tool skeleton because the owner contains `thinking`, `reasoning` or `redacted_thinking` | Exclude thinking-attached rows from this rollout, even with zero recorded reasoning tokens |

The interpretation of (b) is explicit: retention is not permanent provenance
protection. The existing `ToolMutationBatch.wouldStrandConversationEnd`
(`tool-drop-target.ts:354–377`) evaluates the newest meaningful message, ignoring
blank pending assistant shells and already scheduled removals. The `drop()`
fallback freezes that skeleton even after newer turns follow
(`tool-drop-target.ts:495–511`). Retirement may now reconsider it, but only on
an existing rebuilding opportunity. Several removals in one batch must leave
at least one required closing result, not each independently inspect the raw end.

These are **overlapping reasons**, not three persisted enum values today.
For new attribution, record an origin mask (`recent_anchor`, `conversation_end`,
`native_reasoning`, with `structural_adapter`/`unknown` when needed); mandatory
reasoning/end protection wins over the optional anchor in an exclusive report.
This metadata is diagnostic only. Safety must inspect the current wire and
native parts, never trust an origin label or numeric reasoning estimate.

There is also a lane distinction. Emergency cleanup passes
`requiresToolArcSkeleton` to `keepSkeleton`
(`heuristic-cleanup.ts:139–151,198–203`), and legacy conversion uses it
(`apply-operations.ts:225–264`). Ordinary queued drops pass only window membership,
after rejecting `thinkingDropProtected` (`apply-operations.ts:403–407,451–458`).
Pi's shared transcript also puts the native-arc requirement into `cannotRemove`
(`packages/plugin/src/shared/tag-transcript.ts:1149–1157`). Do not infer that
all skeletons beside thinking were created by precisely the same branch.
The three-source inventory is in
[`reclaim-lanes-provider-matrix.md`](../reports/reclaim-lanes-provider-matrix.md),
lines 94–109; its older line numbers and provider observations are not a substitute
for the current turn-protection checks.

### Re-check of the 2,037 / 5,531 observation

The reported fraction is about **36.83%**. It does **not** imply that 36.83% of
skeleton owners lack native thinking, nor that this fraction is all retireable:

- (a) and (b) work with no thinking at all. They alone produce zero-reasoning
  skeleton tags.
- Tool-tag reasoning estimates describe the **preceding thought group**, not a
  reliable ownership assertion for the tool's assistant message. Parallel tools
  can repeat the estimate. Only message tags prove their own reasoning-group
  ownership (`packages/plugin/src/features/magic-context/storage-tags.ts:705–731`).
- The tagger counts nonempty `thinking` or `text`, excluding `[cleared]`
  (`tag-messages.ts:379–393`). A `redacted_thinking` part can contain only opaque
  data and still require an arc skeleton while contributing zero visible tokens.
- Existing-row token backfill is best-effort and NULL is not numeric zero
  (`packages/plugin/src/features/magic-context/tagger.ts:551–573`). A query must
  report `reasoning_token_count IS NULL` separately from `= 0`; older byte-based
  `reasoning_byte_size` is not the native-part discriminator either.

The experiment deliberately reproduces those two control totals with known
origins, including native redacted owners that have zero counts. It proves that
these mechanisms can produce the observation; **it does not identify the
reporter's particular 2,037 rows**. Neither the reporter's database nor a sanitized
owner transcript was supplied. No live store was opened. Attribution of those
actual rows would require an offline, sanitized export joining each tag to its
owner's original part types and original drop-lane evidence. Tags alone cannot
recover the original cause. The design therefore does not use “zero reasoning”
as its migration predicate.

## 2. Retirement contract

### One permission, not a new scheduler or pressure trigger

Use the same already-computed per-pass authorization as queued drops and
heuristic cleanup: `hasReclaimRide(rideSignals)`
(`packages/plugin/src/hooks/magic-context/cache-busting-signals.ts:35–59`;
`transform-postprocess-phase.ts:2247–2288`). This is the rule of
**ARCHITECTURE.md invariant 4, line 83**. Do not duplicate its expression in the
retirement lane, set a refresh flag because old skeletons exist, or convert a
scheduler label into permission. Permission permits a mutation; it does not
require manufacturing a bust when there is no work.

| Pass opportunity | Qualifies exactly when |
| --- | --- |
| Execute | The existing shared permission is true. Subagent execute is already an explicit shared ride (`subagentExecute`). A primary scheduler `execute` alone is not a ride: it needs an admitted fold, flush, force, or actually published-history refresh. |
| HARD fold/refold | A real admitted rebuild grants the hard-fold ride. `mustMaterialize`, a due fold, or a HARD label with byte-identical served prefix is insufficient. |
| `/ctx-flush` | The existing explicit-flush/materialization signal grants the ride; retirement lands in the subsequent transform, not in the command reply. |
| Force band | The existing derived force-band signal grants the ride (85% at the normal default), including a scheduler-defer pass if it is an actual shared force ride. Do not hard-code a second threshold. |
| Published history / other existing rides | Follow the same permission as every other mutation lane; do not narrow retirement to four duplicated labels and miss an admitted published-history rebuild. |
| Ordinary defer / frozen SOFT+ | No permission, no mode transition, no candidate-driven prefix refresh, no retry of a new retirement. Replay previously committed modes only. |

Here “never on a defer” means **never on an ordinary non-busting defer**. The
scheduler may say `defer` on a legitimate HARD/flush/force/published-history ride;
excluding such passes would contradict the single-permission rule. This is also
why an execute label without the permission is a negative test case.
An executed fold must actually lose the served prefix
(`apply-operations.ts:151–183`; `fold-execution-gate.ts:1–3`). `/ctx-flush` requests
refresh/materialization (`hook.ts:1025–1031`); its DB-only pending-drop marking
(`execute-flush.ts:10–31`) does not itself establish the final wire representation.

### Candidate selection and frozen transition

On an authorized pass, after new tool tags and the current latest-turn protection
are known, consider visible, complete, already-dropped tool arcs with
`drop_mode IN ('skeleton_real','skeleton_stripped')`. Include the stripped variant:
its attachments are gone but its input survives. Exclude legacy `truncated`
markers and `edit_marker*` from this transition; keep their existing conversion
contracts. Do not retire active results or reopen compacted tags.

For each candidate:

1. It is **not** in the current newest-20 tool-tag set (any status). Compute the
   set once per pass from the canonical session tool ordering, not per tool name,
   active-only filtering, or incoming-array length. Pin the same ordering in Rust
   and adapters with a shared fixture.
2. Its real owner/native-part evidence is available, and it is not a
   thinking-attached arc: an owner containing a native `thinking`, `reasoning`, or
   `redacted_thinking` part is excluded from retirement. Missing/ambiguous owners
   remain unchanged for a later safe opportunity, not a DB-only guessed removal.
3. The shared current-turn protection permits the removal and any required later
   signed-thinking strip. The end and structural-adapter guards allow removal.
4. The whole call/result pair can actually be removed from this served payload.
   Respect prior removals in the batch and preserve unrelated reasoning-only rows.

**Persist `skeleton_real → full` (or `skeleton_stripped → full`) as a new, one-way
transition of the existing `tags.drop_mode`, not a new rendering alias.** Keep
`status='dropped'`, identity, original input sizes and token counts. This uses the
existing full replay path; no dynamic “if old then full” branch is allowed in
`applyFlushedStatuses` (`apply-operations.ts:549–600`). Do not decide again on a
restart, re-expansion, different provider, or configuration change. Compaction can
make the row unreachable, but cannot resurrect the call.

Selection, successful pair removal, persisted mode and associated reasoning-strip
state must be committed as one coherent representation decision using the
runtime's existing write-admission/version fence. TS pending application already
acquires an immediate writer before changing wire bytes
(`apply-operations.ts:338–353,476–529`). Plan against a disposable representation,
acquire admission, revalidate rows, and install the winner; DB rollback alone
cannot undo in-memory mutations. Rust must commit its selected mode and strip
state with its transform CAS, not mirror-write a second authority from the host.
If admission fails, serve the prior frozen representation and retry only on a
later authorized pass. Emit retire-count/retained-input delta only after commit.

### Upgrade

Schema support or diagnostic-origin backfill must not alter provider bytes.
Existing real/stripped skeleton rows are eligible at the **next qualifying pass**
under the same current-wire guards, even if they have no origin label. Do not
wait for another `ctx_reduce`, an age-sweep token minimum, or a new pending op.
Never rewrite all drop modes during startup/migration or on ordinary defer.
The current full replay calls `drop()`, which still has an end fallback. If a
later host rewind or partial source reconstruction would make replay of a frozen
full removal structurally invalid, do not silently resurrect that skeleton:
retain a valid prior representation or fail admission until the source is coherent.
This replay failure must not become a fresh retirement decision on a defer.
The diagnostic origin label records why a skeleton was first kept; it is not a
retirement whitelist. An old former-end row is retireable when the
current end guard is false, while a newly labelled anchor with native thinking
is still excluded. A retired row disappears from subsequent candidate scans.

### Signed thinking after an (a)/(former-b) removal

Re-use the full-removal **pipeline**, not just a `drop()` call. The tool target
marks all occurrences and clears its associated visible reasoning
(`tool-drop-target.ts:495–511`); that local `[cleared]` edit alone is not a
signature-validity proof. A removed call/input or result changes the prefix of
later signed blocks even if the retired call itself had no thinking.

The existing prefix-binding handling is:

- TS `freezeReasoningOnBustingPass` persists stable assistant IDs in the
  binding-recovery set before stripping, excludes the protected current turn,
  and replays those IDs on subsequent defers and LKG replays
  (`transform-postprocess-phase.ts:529–586`). Its ordinary TS caller reacts to
  non-reasoning prefix edits and fails the pass on strip-persistence failure
  (`:4130–4158`); it conservatively freezes all remaining unprotected reasoning,
  not a new hand-rolled subset per retired tool.
- Rust-mode host postprocessing first replays saved strips, then runs the same
  mechanism on a bust or from the first changed served message on a frozen-release
  path (`:984–1070,599–630`). The `moduleReasoningTrimOnly` oldest-thinking-prefix
  exception is **not** applicable to tool-arc retirement: it changes tool bytes.
- Pi freezes entry IDs plus the end-of-pipeline strip-order marker before removing
  thinking, and skips all messages in the latest assistant turn
  (`packages/pi-plugin/src/provider-error-recovery-pi.ts:282–357`). It too requires
  the caller to withhold edits that would invalidate protected thinking.

Retirement must feed the existing prefix-edit tracking and persistence/failure
path. If the removed call precedes protected signed thinking in the latest turn,
**withhold the retirement**, even on a force/flush/execute ride: permission is
necessary, not a bypass of provider validity. The current TS pipeline identifies
retained thinking and protects new mutations / freezes m[0]/m[1]
(`transform-postprocess-phase.ts:2005–2031`). This is the issue 630 correctness
constraint, not a new blanket delay of every tool loop. A non-thinking loop can
retire old calls normally. Do not preserve invalid later signatures merely because
the retirement's own owner lacks a thinking part; do not remove current-turn
thinking to make the edited prefix appear valid.

### Runtime contract and implementation map

All four surfaces must consume the same normalized retirement inputs and produce
the same final pair-removal decision. This is a rollout requirement, **not a claim
that their native-reasoning policies already agree**.

| Surface | Current authority and required change |
| --- | --- |
| OpenCode 1, TS | Shared `apply-operations.ts` and `ToolMutationBatch`. Add the authorized old-skeleton transition before final replay/capture, using canonical owner identity; preserve the persisted adoption of the sweep that prunes only owners emptied by tool removal, not unrelated reasoning-only rows. |
| OpenCode 2, TS | `packages/plugin/src/v2/hooks/context.ts:1520–1527,1774–1785` uses the same `createTransform`. No independent v2 aging policy. Provider projection and current-turn detection must be tested at the actual v2 wire boundary. |
| Pi | Shared chooser, Pi transcript targets and `context-handler.ts:6033–6053` shared ride. `native-replay-state-pi.ts:194–227` freezes structural removal before touching either half. Advance that native removal record together with the tag mode; never serve `full` metadata while the native skeleton still replays. Preserve end-of-pipeline thinking-strip order. |
| Rust module, ck-mc | `selection.rs` groups whole arcs and decides shapes; `transform.rs` owns durable frozen reductions and CAS. Use `pass_already_busting`, already derived from `supersession_ride_available` (`transform.rs:5270–5303`), not `PassClass::Execute` or `decision=HARD` alone. Both OpenCode hosts' Rust mode must use the module winner, not rerun TS retirement over it. Host first applications must consult the response's exact `prefix_bust_permitted` boolean (`transform.rs:1665,7674`), never reconstruct it from response labels. |

Rust currently excludes reasoning-plus-tool-only owners and separately retains
reasoning-adjacency separators (`selection.rs:507–600`), unlike a blanket native
owner rule. It resolves recent small inputs/end guards at `:1850–1877` and excludes
ordinary re-decisions of frozen blocks in `expand_arc` (`:891–931`). Frozen units
are immutable within an epoch; replacing their payload via ordinary selection
would produce `ReductionConflict` (`transform.rs:2090–2094,2146–2148`). Therefore
retirement needs an **explicit authorized transition of the effective frozen unit
set**, not removal of the generic conflict guard. The existing HARD-only legacy
conversion (`transform.rs:9621–9665`) is the structural precedent, but retirement
must also support permitted execute/flush/force/SOFT refresh rides. Preserve old
result reductions while making both halves structurally absent, commit the new
`drop` kind, and do not classify that tool-byte edit as `reasoning_trim_only`.

Use one shared golden corpus with equivalent tag/arc owner keys, any-status
recency, raw native part types, current-turn boundary, attachments, existing
modes, and the already-computed permission. Rust's currently narrower reasoning
eligibility does not authorize retiring thinking-attached skeletons in this
rollout. The common retirement exclusion must include native owners and required
reasoning separators. Non-Anthropic provider-specific policies already resolving
the requirement away remain separate from age: TS clears the flag only for
resolved non-Anthropic-family routes and keeps it for unknown providers
(`transform.ts:2280–2290`); Pi has adapter-level controls. Do not introduce a new
route exemption as part of this design.

## 3. Can (c) be reclaimed on Anthropic?

**Not in this rollout. Whole oldest arcs plus their thinking remain excluded
until the exact edit has passed a live test.** Memory #23609's rules are supplied
in the brief and partially verified by the repository's live report; the memory
service itself was not available through file reads. The relevant evidence is
[`live-thinking-trim-opus-5-5.md`](../reports/live-thinking-trim-opus-5-5.md),
especially lines 5–73, not the older quota-blocked table at the end.

The recorded Opus 5.5 seed had six signed blocks, six assistant messages bearing
them, 521 total messages and 167 call/result pairs. With strict
`prefix_mismatch_behavior: "error"` and common transport settings, eight requests
were reached. The unchanged control returned 200; removing the **oldest one
thinking block only**, keeping the later five identical, returned 200. Suffix and
all-thinking removal also returned 200. Removing a middle block, editing an older
tool result, and re-rendering the first user text each returned 400 with
signature-binding errors (`live-thinking-trim-opus-5-5.md:13–36,38–53`).

Limits matter:

- The successful prefix trim removed a thinking block, **not its tool call/result
  or a whole assistant arc**. Removing a gap-free prefix of *thinking blocks*
  is not the same operation as changing the old tool-bearing message prefix.
- Tool-input edits and edit-plus-strip recovery were not reached; restoration
  could not be tested because accepted responses produced no new signed block.
  Sonnet had no specimen. Responses ended at `max_tokens` with 64 output tokens;
  200 is request acceptance, not a completed continuation (`live-thinking-trim-opus-5-5.md:24,58–62`).
- No redacted blocks or Vertex/Bedrock/Copilot routes were in that seed. Accepting
  `[cleared]` on Anthropic-direct did not validate those other routes or justify
  removing current-turn thinking (`live-thinking-trim-opus-5-5.md:7,13,36,58–62`).

**Normal session, older completed turns:** a whole oldest-turn/arc prefix is a
plausible future reclamation unit if it is gap-free, both halves and all its
thinking leave together, no surviving protected signature depends on changed
tool bytes, and the latest assistant turn is untouched. The existing live result
does not establish that this unit is accepted while later signatures are retained.
Merely starting at the oldest arc does not repair those later prefix bindings.
An implementation must test actual whole-arc/whole-turn removal, not extrapolate
from thinking-only trimming. The smallest rule currently supported for reasoning
itself is the existing gap-free oldest **thinking-only** prefix policy; that does
not reclaim (c)'s arguments.

**Subagent's single long turn:** all tool-loop steps since its one real prompt are
the latest assistant turn; tool-result user-role exchanges do not start a new
human turn. Removing any of its thinking, even a numerically old prefix, violates
the issue 630 unchanged-turn contract. The same applies to a primary in a long
current tool loop. Keep (c), and withhold any otherwise-(a) retirement whose
invalidation cone reaches those protected signed blocks. A live test accepting
one direct OAuth request would not by itself justify a cross-route exception.

A future opt-in investigation should independently test: completed older arcs vs
current-turn arcs; whole oldest one/two arcs; gap-free thinking-only control;
whole-turn removal; middle-gap negative control; an earlier input edit; earlier
result edit; those edits with all invalidated **unprotected** later thinking
stripped; latest-turn rejection; and a resumed continuation producing a fresh
signed response. Require strict binding errors rather than silent `drop_block`,
an unchanged accepted control, and explicit per-route results. Stop on quota or
missing signed seed. None of those additional live calls was made for this note.

## 4. Protected tools and the `ctx_reduce` reply

`protected_tools` protects newest **active** results per normalized tool name,
with defaults `todowrite: 1` and `ctx_reduce: 3`. Inactive dropped/compacted rows
are not keep-count exemplars (`packages/plugin/src/features/magic-context/reclaim-protection.ts:34–50`;
`crates/mc-module/src/selection.rs:301–303,935–967`). Retirement does not select an
active result, so it does not consume or rotate those keep slots, make a pending
protected request immediate, or change a user's counts. Counts of zero and custom
names must keep their existing meaning. Keep the raw-result protection separate
from the newest-20 **all-status** skeleton window and from current-turn protection.

A protected queued request stays held until newer eligible results displace it,
then its first drop rides the same permission. The reply already distinguishes
held from immediate tags (`crates/mc-module/src/lib.rs:7801–7839`;
`packages/plugin/src/tools/ctx-reduce/tools.ts:157–177`). Acknowledgement is not a
promise that all original input tokens vanished: the first drop can still be a
skeleton. Retirement is automatic later maintenance of an **already applied**
drop, needs no new self-stamp or pending op, and must not rewrite an older
`ctx_reduce` reply or count that operation as newly accepted again.

Any future reclaim estimate should distinguish first-drop output savings from
later input retirement, and should never promise recovery of (c)'s retained floor.
No status/nudge/API reply change is included here; the reporter's proposed
visibility work is separate. Verify the built-in newest-three reply exemplars and
self-stamp filtering remain intact as well as configured larger keep counts.

## 5. Synthetic context.db measurement

### Method and isolation

The executable appendix opens **one fresh explicit-path `context.db`** through
production `openDatabase`, creating schema version 95. HOME/XDG data/config roots
point into the disposable measurement directory; `OPENCODE_DB` is unset. The
production opener's explicit path avoids legacy-store migration
(`packages/plugin/src/features/magic-context/storage-db.ts:2616–2694`). No host
adapter, live session, live database, recorded specimen, vault or model endpoint
is used. SQLite fixture provenance lives in a separate `measurement_arcs` table;
it is not proposed product schema. The script and generated DB were scratch
artifacts, not committed product files.

The 111 single-prompt tool loops contain 9,971 tool tags and are explicitly marked
`is_subagent=1` in `session_meta`. Seventy no-thinking loops
create 20 recent anchors (23 in the first), then one large-input end skeleton.
Thirty native-thinking loops create 80 skeletons each, ten create 65, and one
creates 1,008. Every loop appends 40 later active calls, aging every measured
skeleton outside the newest 20. Native owners include 564 opaque redacted parts;
the remainder have visible synthetic thinking. The repeat counts are fixed,
not sampled from the reporter's data. Thus **5,531 and 2,037 are deliberately
matched control totals**, not recovered empirical counts or fitted percentiles.

Targets and metadata come from production `tagMessages`. The exported
`applyNewToolDrop` exercises actual (a)/(b) branches. For (c) it receives the
production target's `requiresToolArcSkeleton` via `keepSkeleton:true`, after 40
newer tags exist, mirroring the emergency/legacy requirement. The driver persists
the returned mode/status explicitly; it is **not** an end-to-end emergency planner
or a new retirement implementation. It invokes actual `applyFlushedStatuses`
after aging, checks every rendered argument against its original input, checks
every result placeholder, and verifies a second replay is byte-identical.

Counts use the production tokenizer, with `preloadTokenizer()` required to return
true (no byte-ratio fallback). Each stored `input_token_count` is checked against
`estimateTokens(JSON.stringify(input))`, matching production extraction
(`tag-messages.ts:395–450,955–1005`). These are input-payload estimates, not
Anthropic billing, tool schema tokens, output tokens, or signed/opaque reasoning
token counts. Synthetic signatures are deliberately invalid placeholders; this
experiment cannot establish provider acceptance.

### Results (Bun 1.4.2, Linux, 44,365 checked assertions)

| Original source | Skeleton tags | Retained input tokens | Zero/NULL-recorded reasoning tags | Input tokens outside newest 20 |
| --- | ---: | ---: | ---: | ---: |
| (a) Recent small-input anchor | 1,403 | 51,911 | 1,403 | 51,911 |
| (b) Former request-end separator | 70 | 28,350 | 70 | 28,350 |
| (c) Native-thinking requirement | 4,058 | 665,512 | 564 | 665,512 |
| **Total** | **5,531** | **745,773** | **2,037** | **745,773** |

The largest loop retains **165,312** argument tokens in 1,008 skeletons, close to
the reporter's magnitude by construction. Nearest-rank p50/p75/p90 here are
1,145 / 13,120 / 13,120, deliberately **not** a reproduction of the reporter's
0 / ~4.5k / ~24k percentiles. Source (c) accounts for about 89.24% of synthetic
retained input. Initial retirement under the proposed guards could remove
**80,261** input tokens (10.76%) from (a) plus aged former-(b); (c)'s **665,512**
remain. This is a candidate-savings calculation, not measured post-implementation
reclaim or cache-cost savings. No latest signed turn blocks the no-thinking
sessions; all end skeletons now have later results, so the current end guard is
false. In a real mixed session the signed-thinking veto may reduce savings further.

Of the deliberately matched 2,037 zero/NULL-reasoning tags, 1,473 arise without
native thinking via (a)/(b) and 564 have native redacted owners via (c). All fixture
token thunks are fresh; a separate SQL count found **0 NULL reasoning counts**,
so NULL backfill is not the explanation here. This is a
concrete counterexample to classifying those reported zero-count tags as
thinking-free, but not an estimate of the reporter's split.

The aggregation joins `(session_id,tag_number)` rather than global tag number,
and counts each tool input once; it does not multiply preceding reasoning across
parallel tags. The appendix contains the exact executed queries and generator.

## 6. Implementation acceptance and mutation controls

These are **future implementation gates**, not passing retirement tests in this
change. Current regression anchors include
`real-or-absent-tool-drop.test.ts` (small/large/end/byte-stable replay),
`tool-drop-target.test.ts` (blank trailing assistant and batched removals),
`transform-operations.test.ts` (preceding-reasoning metadata), Rust
`skeleton_window_keeps_call_shell_older_full_drops`,
`window_drop_keeps_the_call_whose_result_ends_the_request`, and
`legacy_skeletons_convert_to_real_or_absent` in `selection.rs`. Extend rather than
invert their byte-frozen claims: the intentional contract change is **only** an
old skeleton transitioning on an already-authorized pass. Plain replay tests keep
their original meaning.

### Required behavior cases

- **Recency:** 19/20/21 boundaries, more than 20 skeletons accumulated by
  incremental drops, active/dropped/compacted tags mixed, non-tool tags between
  calls, duplicate provider call IDs in different owners, and identical ordering
  across serialized adapters. Newest 20 real arguments remain byte-identical;
  older small skeletons retire. Test stripped media skeletons too.
- **Permission matrix:** each real execute/subagent-execute, prefix-losing HARD,
  explicit flush, force-episode and published-history ride lands retirement in
  that pass even with no pending ops. Ordinary defer, execute-only primary,
  advisory-only fold, byte-preserving HARD, and latched force below its actual
  authorization preserve modes and exact provider bytes. Force admission follows
  the shared producer signal, not a bare percentage comparison.
- **Durability:** hash exact provider request bodies for repeated ordinary defers
  before and after retirement, with tail growth; repeat after process restart and
  a fresh host reconstruction. Failed writer admission/CAS and failed strip-state
  persistence must retain a coherent prior representation. A winner persists
  `full`, no future raw host reload restores its call, and no orphan result is sent.
- **End/structure:** trailing blank shell, separate tool-role result, embedded
  OpenCode completed tool part, parallel final results, multiple removals together,
  absent/incomplete pair, unremovable adapter, and unrelated reasoning-only rows.
  An old former-end skeleton can retire; the last necessary closing result cannot.
- **Thinking:** native visible/redacted owners with **zero**, positive and NULL
  metadata stay excluded; an (a) call before later signed blocks goes through the
  existing strip path, with the strip decision frozen. If those later blocks are
  in the latest assistant turn, hold the edit. Test both primary and single-prompt
  subagent; a later *real* user prompt ends protection, a tool-result exchange does
  not. The same native reasoning separator must survive in all runtimes.
- **Protection/ack:** defaults, custom counts above 20, zero overrides, normalized
  names, held queued drops, rotation, historian requests and `ctx_reduce` self
  stamps. Retirement neither changes active keep slots nor mutates old replies.
- **Runtime parity:** run a shared corpus through OpenCode 1 TS, OpenCode 2 TS,
  Pi, and ck-mc selection **and durable transform**. Compare modes, surviving arc
  IDs, exact real-input bytes, reason-strip IDs and bust permission, then run
  OpenCode 1/2 Rust host projection cases. Selector-only success is insufficient:
  frozen Rust conflicts and Pi native-removal replay occur after selection.

### Signed-thinking request acceptance gate

Extend the mock provider, not an assertion that merely examines tag counts.
`packages/e2e-tests/src/mock-provider/latest-turn-thinking.ts` already distinguishes
real user turns and validates current-turn thinking; use the real host harnesses
in `tests/latest-turn-thinking.test.ts` and
`tests/opencode2/latest-turn-thinking-recovery.test.ts`.
Add a strict prefix-binding validator enforcing the supplied memory #23609 rules,
whose signatures bind to an independently recorded
prior conversation prefix: gap-free oldest **thinking-only** removal is accepted,
a middle gap / older tool input or result edit with retained later signatures is
rejected, and changing/removing latest-turn thinking is rejected. Fake signatures
computed from the already-transformed request would make this test vacuous.

Assert the mock actually receives and **accepts the final request after old
non-thinking skeleton retirement**, with every invalidated unprotected later
block stripped and no protected block changed. Capture at least one resumed tool
round and its next request; compare defers against the accepted representation.
Also include an accepted negative-protection scenario where retirement is held
because the latest turn has signed thinking. Mock acceptance proves the designed
policy and serialized request agree, not Anthropic service acceptance of removing
thinking-attached tool arcs.

### Named, independent mutation controls

Add these named tests and corresponding mutation catalogue entries during
implementation. Run one mutation at a time for each applicable runtime. A red
result must name **only** the expected test; record all passing/skipped siblings
as well as failures. Existing nearby controls in `mutations.toml:29–116,117–133`
guard single bust permission, queued drops and frozen host replay, but do not
replace retirement-specific controls.

| Planned test name (runtime-prefixed in each suite) | Deliberate control break | What must go red |
| --- | --- | --- |
| `retirement ordinary defer preserves provider bytes and modes` | Ignore shared permission for retirement | Growing-tail non-busting defer changes an old skeleton |
| `retirement real rebuild drains old anchors without pending ops` | Neutralize retirement planner / require a fresh pending op | Qualifying pass still has old real arguments |
| `retirement keeps newest twenty any-status calls` | Use 19, or count active rows only | Boundary skeleton wrongly removed |
| `retirement replays full after restart and fresh raw input` | Do not persist transition, or restore original skeleton mode | Restart resurrects call/input |
| `retirement preserves the current end separator` | Bypass the current end/whole-batch guard | Request ends on assistant or loses the last parallel closing result |
| `retirement excludes redacted owners with zero reasoning metadata` | Classify native protection using numeric reasoning count | Redacted/native pair wrongly removed |
| `retirement request strips invalidated later signed blocks` | Skip the full-removal binding strip | Strict mock rejects the resulting request |
| `retirement holds edits before latest signed assistant turn` | Remove latest-turn invalidation veto | Strict mock reports modified thinking in primary/subagent loop |
| `retirement CAS loser preserves the prior representation` | Serve proposed bytes after rejected persistence | Loser bytes disagree with durable replay |
| `retirement parity includes Rust frozen transitions and Pi native removal` | Suppress one durable runtime transition only | Shared golden disagreement after reconstruction |

For each control: stage **only** the files to be mutated so the index contains the
verified implementation; confirm empty `git diff --stat`; mark the mutation with
`NON-VACUITY BREAK`; capture a non-empty diff stat; run the named test; restore
with `git checkout -- <path> && touch <path>`; capture an empty diff stat; rerun
its clean gate. Never stash or check out an unstaged implementation. Do not commit
a break. If a supposedly defended control survives, report it as undefended and
require a second reddened control reaching that same runtime target before
trusting its suite. These are a plan; no product mutation was performed here.

## 7. Cost and rollout bounds

Let H be all persisted session tags, V the visible messages/parts, S the remaining
visible real/stripped skeleton candidates, and R the successful retirements.

- Ordinary non-busting defer adds **no retirement candidate scan or retokenization**;
  replay remains the existing frozen-mode work. Tail growth alone does not price
  a transition.
- A qualifying pass computes newest 20 once. TS already has an indexed descending
  any-status tool lookup (`storage-tags.ts:2448–2474`). The existing general
  `(session_id,tag_number)` index may walk non-tool rows; do not call that a
  constant-time guarantee. A tool-only partial ordering index can bound it to K=20
  rows plus index seek if profiling warrants it.
- Add a partial retirement-candidate index on `(session_id,tag_number)` restricted
  to dropped tool rows in the two skeleton modes, or extend the already-scoped
  dropped-tag lookup to this predicate. Fetch only visible owner keys and relevant
  rows. Do not reload all tags with `getTagsBySession` inside an immediate writer;
  pending application already avoids that history-sized lock hold
  (`apply-operations.ts:338–353`). Rust can maintain a skeleton-kind subset of its
  already-loaded frozen units rather than a second complete history traversal.
- Incremental candidate filtering is O(S + K), with O(R) mode writes and set updates
  (plus indexed lookup costs); token deltas use persisted counts, not re-tokenizing
  arguments. **It is not O(R) overall**: excluded (c), still-recent and temporarily
  protected skeletons can be reconsidered on later authorized passes. Persisted
  diagnostic origins cannot safely shortcut current-wire checks.
- Build an owner/native-part map and closing-result state once from the existing
  pass traversal. Do not re-scan V for every candidate. Applying removals/finalizing
  the wire and existing signed-thinking strip/capture can still cost O(V), or the
  affected suffix length, and the base transform may already load substantial
  frozen history. This design removes an extra O(H) DB scan, not the entire
  transform's dependence on visible history. Benchmark no-candidate, many-(a),
  many-blocked-(c), sparse-owner and concurrent-writer fixtures separately.
- After commit, retired rows leave the candidate index; repeated work scales with
  the **remaining skeleton set**, not all historical dropped tags. Database
  metadata size does not shrink merely because input leaves the wire.

The cache claim is about **permission and representation stability**, not zero
CPU, zero input billing, or a freshly measured provider cache saving. A transition
shares one already-authorized prefix rewrite with the other lanes; defers replay
its persisted result without another rewrite. A writer/strip failure must not
produce a second accidental first application on a frozen defer.

Review this design before product changes. Implement shared TS/Pi and Rust
contracts together or gate rollout until the parity corpus passes. Do not expose
a setting that silently enables current-turn (c) removal. The synthetic largest
loop remains at a thinking-attached floor after (a) retirement; this proposal must
not be advertised as recovering that 165k until the live whole-arc question is
actually settled.

## Verification of this design-only delivery

- **Bun 1.4.2:** `bun skeleton-retirement-evidence/measure.ts` completed with
  **44,365 checked assertions**, 111 marked subagent sessions and schema 95.
  The final driver is reproduced verbatim below; results above are its captured
  output. An initial reporting query used the wrong schema-version table name;
  switching to production `getPersistedSchemaVersion` fixed that scratch-only
  failure before the final measurement.
- **Bun 1.4.2**, from `packages/plugin`:
  `bun test --timeout 30000 src/hooks/magic-context/real-or-absent-tool-drop.test.ts src/hooks/magic-context/tool-drop-target.test.ts src/hooks/magic-context/transform-operations.test.ts src/hooks/magic-context/protected-tool-holds-fixture.test.ts`
  — **51 passed, 0 failed, 230 assertions** across four selected files. The hold
  fixture file itself declares no tests; the active hold/protection suites below
  provide that coverage.
- **Bun 1.4.2**, from `packages/plugin`:
  `bun test --timeout 30000 src/hooks/magic-context/protected-tools.test.ts src/hooks/magic-context/protected-tool-holds.test.ts`
  — **15 passed, 0 failed, 68 assertions** across two files.
- **TypeScript 5.9.3:** `bun run --cwd packages/plugin typecheck` — passed (the
  three package-script compiler invocations are silent on success). This checks
  current plugin types, not a nonexistent retirement implementation.
- AFT inspection of this Markdown file was **partial**: no Markdown LSP producer
  and no ready checkout call-graph view. It is not counted as clean diagnostics.
- Product retirement tests, implementation mutation proofs, all-runtime new
  parity tests and further live signed-thinking calls are **not run**, because
  this delivery intentionally changes only a design note. Their acceptance plan
  is section 6. No manifests or lockfiles changed; no install was required. The
  prepared worktree's build had already passed before this task.

The committed note retains the measurement driver and reduced numeric evidence,
not regenerable build output or a private database. Scratch artifacts are not part
of the delivery. Comment/prose review covered this new file; shorthand citations
and native-owner exclusion wording were clarified after that review.

## Appendix: reproducible measurement driver

At the reviewed base with repository dependencies installed, save this code as
`skeleton-retirement-evidence/measure.ts` at the repository root. Use a **fresh**
directory (the driver intentionally fails if its provenance table already exists):

```sh
bun --version
# The fixed path is disposable and must not contain an existing database.
test ! -e skeleton-retirement-evidence/run/context.db
bun skeleton-retirement-evidence/measure.ts
```

```ts
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase, closeDatabase, updateTagStatus, updateTagDropMode, getPersistedSchemaVersion, getNewestToolTagNumbers } from "../packages/plugin/src/features/magic-context/storage";
import { createTagger } from "../packages/plugin/src/features/magic-context/tagger";
import { tagMessages, type MessageLike } from "../packages/plugin/src/hooks/magic-context/transform-operations";
import { applyNewToolDrop, applyFlushedStatuses, hasSmallToolInput } from "../packages/plugin/src/hooks/magic-context/apply-operations";
import { estimateTokens, preloadTokenizer } from "../packages/plugin/src/hooks/magic-context/read-session-formatting";

const root = resolve("skeleton-retirement-evidence/run");
mkdirSync(root, { recursive: true });
process.env.HOME = root;
process.env.XDG_DATA_HOME = root;
process.env.XDG_CONFIG_HOME = root;
delete process.env.OPENCODE_DB;
assert(await preloadTokenizer(), "production tokenizer must load, not fall back");
const db = openDatabase({ dbPath: resolve(root, "context.db") });
assert(db);
const tagger = createTagger();
let checks = 1;
function check(value: unknown, label: string) { assert(value, label); checks++; }
db.exec(`CREATE TABLE measurement_arcs (
 session_id TEXT, tag_number INTEGER, source TEXT, native INTEGER,
 input_json TEXT, raw_arc TEXT, PRIMARY KEY(session_id,tag_number));`);
const put = db.prepare("INSERT INTO measurement_arcs VALUES(?,?,?,?,?,?)");
let cOrdinal = 0;
function arc(session: string, n: number, source: string): MessageLike[] {
 const id = `${session}-${n}`;
 const native = source === "c";
 const repeats = source === "b" ? 400 : native ? 159 : 32;
 const input = { command: "word ".repeat(repeats) };
 const thinking = native ? [cOrdinal++ < 564
   ? { type: "redacted_thinking", data: "synthetic-opaque" }
   : { type: "thinking", thinking: "Synthetic visible thought", signature: "synthetic-not-valid" }] : [];
 return [
  { info: { id: `${id}-a`, role: "assistant", sessionID: session }, parts: [
    ...thinking, { type: "tool-invocation", tool: "bash", callID: id, state: { input } }] },
  { info: { id: `${id}-r`, role: "tool", sessionID: session }, parts: [
    { type: "tool", tool: "bash", callID: id, state: { input, output: "synthetic result" } }] },
 ];
}
function tag(session: string, messages: MessageLike[]) {
 return tagMessages(session, messages, tagger, db, { scopedToolSweep: true });
}
function drop(session: string, n: number, source: string, raw: MessageLike[], tagged: ReturnType<typeof tag>) {
 const number = tagger.getToolTag(session, `${session}-${n}`, `${session}-${n}-a`);
 check(number !== undefined, "tool tag exists");
 const target = tagged.targets.get(number!);
 check(target !== undefined, "production target exists");
 if (source === "c") check(target!.requiresToolArcSkeleton, "native owner requires skeleton");
 check(getNewestToolTagNumbers(db, session, 20).includes(number!) === (source !== "c"), "chooser window matches actual any-status recency");
 if (source !== "c") check(hasSmallToolInput(target) === (source === "a"), "anchor is small and end fallback is large");
 const input = (raw[1].parts[0] as any).state.input;
 const rawArc = JSON.stringify(raw);
 const outcome = applyNewToolDrop(target, {
  inWindow: source !== "c", keepSkeleton: source === "c" && target!.requiresToolArcSkeleton,
 });
 check(outcome.mode === "skeleton_real" && outcome.result === "truncated", `source ${source} kept skeleton`);
 updateTagStatus(db, session, number!, "dropped");
 updateTagDropMode(db, session, number!, outcome.mode);
 put.run(session, number!, source, source === "c" ? 1 : 0, JSON.stringify(input), rawArc);
 tagged.batch.finalize();
 const row = db.query("SELECT input_token_count FROM tags WHERE session_id=? AND tag_number=?").get(session, number!) as any;
 check(row.input_token_count === estimateTokens(JSON.stringify(input)), "stored input count matches production tokenizer");
}

for (let s = 0; s < 111; s++) {
 const session = `synthetic-subagent-${String(s).padStart(3, "0")}`;
 db.prepare("INSERT INTO session_meta(session_id,is_subagent) VALUES(?,1)").run(session);
 const native = s >= 70;
 const count = native ? s === 110 ? 1008 : s < 100 ? 80 : 65 : s === 0 ? 23 : 20;
 const messages: MessageLike[] = [{ info: { id: `${session}-prompt`, role: "user", sessionID: session }, parts: [{ type: "text", text: "Synthetic subagent task" }] }];
 const rawArcs = new Map<number, MessageLike[]>();
 if (!native) {
  for (let n = 0; n <= count; n++) {
   const raw = arc(session, n, n === count ? "b" : "a");
   rawArcs.set(n, structuredClone(raw));
   messages.push(...raw);
   const tagged = tag(session, messages);
   if (n > 0) drop(session, n - 1, "a", rawArcs.get(n - 1)!, tagged);
   if (n === count) drop(session, n, "b", rawArcs.get(n)!, tagged);
  }
 } else {
  for (let n = 0; n < count; n++) {
   const raw = arc(session, n, "c");
   rawArcs.set(n, structuredClone(raw));
   messages.push(...raw);
  }
 }
 for (let n = count + (native ? 0 : 1); n < count + (native ? 0 : 1) + 40; n++) messages.push(...arc(session, n, "active"));
 const tagged = tag(session, messages);
 if (native) for (let n = 0; n < count; n++) drop(session, n, "c", rawArcs.get(n)!, tagged);
 // Replay raw host arcs after aging. Current production must not re-decide modes.
 const rawReplay: MessageLike[] = [structuredClone(messages[0])];
 for (const [n, raw] of rawArcs) rawReplay.push(...structuredClone(raw));
 rawReplay.push(...structuredClone(messages.slice(-80)));
 const fresh = tag(session, rawReplay);
 applyFlushedStatuses(session, db, fresh.targets);
 fresh.batch.finalize();
 for (const [n, raw] of rawArcs) {
  const rendered = rawReplay.flatMap(message => message.parts).find((part: any) => part.type === "tool" && part.callID === `${session}-${n}`) as any;
  const number = tagger.getToolTag(session, `${session}-${n}`, `${session}-${n}-a`);
  check(rendered && JSON.stringify(rendered.state.input) === JSON.stringify((raw[1].parts[0] as any).state.input), "actual replay retains the original input");
  check(rendered.state.output === `[dropped §${number}§]`, "actual replay renders the dropped output");
 }
 const snapshot = JSON.stringify(rawReplay);
 const replayAgain = tag(session, rawReplay);
 applyFlushedStatuses(session, db, replayAgain.targets);
 replayAgain.batch.finalize();
 check(JSON.stringify(rawReplay) === snapshot, "aged skeleton replay is byte-identical");
}
const summary = db.query(`SELECT source, COUNT(*) AS skeletons,
 SUM(t.input_token_count) AS input_tokens,
 SUM(CASE WHEN COALESCE(t.reasoning_token_count,0)=0 THEN 1 ELSE 0 END) AS no_recorded_reasoning,
 SUM(CASE WHEN m.tag_number NOT IN (SELECT tag_number FROM tags recent WHERE recent.session_id=m.session_id AND recent.type='tool' ORDER BY tag_number DESC LIMIT 20) THEN t.input_token_count ELSE 0 END) AS aged_input_tokens
 FROM measurement_arcs m JOIN tags t USING(session_id,tag_number)
 WHERE t.status='dropped' AND t.drop_mode='skeleton_real' GROUP BY source ORDER BY source`).all();
const total = db.query("SELECT COUNT(*) AS skeletons, SUM(input_token_count) AS input_tokens, SUM(CASE WHEN COALESCE(reasoning_token_count,0)=0 THEN 1 ELSE 0 END) AS no_recorded_reasoning FROM tags WHERE status='dropped' AND drop_mode='skeleton_real'").get() as any;
const sessions = db.query("SELECT COUNT(DISTINCT session_id) AS sessions, COUNT(*) AS tool_tags FROM tags WHERE type='tool'").get();
const maximum = db.query("SELECT session_id,COUNT(*) AS skeletons,SUM(input_token_count) AS input_tokens FROM tags WHERE status='dropped' GROUP BY session_id ORDER BY input_tokens DESC LIMIT 1").get();
check(total.skeletons === 5531, "fixture skeleton control total");
check(total.no_recorded_reasoning === 2037, "fixture zero-reasoning control total");
check((summary as any[]).find(row => row.source === "c").no_recorded_reasoning === 564, "opaque native reasoning still creates zero-count tags");
const perSession = (db.query("SELECT SUM(input_token_count) AS tokens FROM tags WHERE status='dropped' GROUP BY session_id ORDER BY tokens").all() as any[]).map(row => row.tokens);
const percentiles = Object.fromEntries([50,75,90].map(p => [`p${p}`, perSession[Math.ceil(p / 100 * perSession.length)-1]]));
const missing = db.query("SELECT COUNT(*) AS null_reasoning FROM tags WHERE status='dropped' AND reasoning_token_count IS NULL").get() as any;
check(missing.null_reasoning === 0, "fresh fixtures have no unknown reasoning counts");
const subagents = db.query("SELECT COUNT(*) AS sessions FROM session_meta WHERE is_subagent=1").get() as any;
check(subagents.sessions === 111, "all fixture sessions are marked subagents");
console.log(JSON.stringify({ bun: Bun.version, schema: getPersistedSchemaVersion(db), sessions, subagents, summary, total, missing, maximum, percentiles, checks }, null, 2));
closeDatabase();
```
