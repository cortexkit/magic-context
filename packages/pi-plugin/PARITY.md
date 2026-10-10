# Pi ↔ OpenCode: Intentional Divergences

This document records **deliberate** differences between the Pi plugin
(`packages/pi-plugin/`) and the OpenCode plugin (`packages/plugin/src/hooks/magic-context/`).

**For auditors (human, Oracle, or council):** the items below are NOT bugs. They
are architectural consequences of how Pi differs from OpenCode. Do not flag them
as parity gaps. If you believe one is wrong, argue against the *rationale* here —
don't just report "Pi differs from OpenCode."

The two implementations share a single SQLite DB (`cortexkit/magic-context`) and
the same `packages/plugin/src` core (storage, decay rendering, tag-transcript,
search). They must produce the **same effective behavior** (cache stability,
overflow protection, decay tiers), but the *mechanism* differs where the host
runtimes differ. "Same effective behavior, different mechanism" is the rule.

---

## 1. Pi has no native subagents → no reduced-mode (`fullFeatureMode`) gate

**OpenCode:** users spawn native subagents (via `task()`), which share the
plugin process and reach `experimental.chat.messages.transform`. OpenCode gates
historian / m[0]m[1] injection / nudges / auto-search behind `fullFeatureMode`
(i.e. `!isSubagent`), and detects subagents via OpenCode's `session.parent_id`.

**Pi:** Pi has **no native subagent concept**. The subagents Magic Context itself
spawns (historian and dreamer) each run as a **separate `pi --print` process**
loading only the lean `subagent-entry.js`, whose recursion guard **never wires
`pi.on("context")`** (see `subagent-entry.ts` header). A Magic Context subagent
therefore *cannot* reach the context-handler pipeline at all.
`@gotgenes/pi-subagents`, however, can initialize a child session inside the same
process. The full extension uses Pi's public child-session lifecycle events plus
process-shared `AsyncLocalStorage` to suppress only the child while allowing
unrelated same-process sessions to initialize normally.

**Consequence:** `is_subagent` is **never written `true`** for any Pi session
that reaches the context-handler pipeline. Separate child processes load the lean
entry, while in-process child initialization is suppressed before the normal
context pipeline is registered.
There is nothing to gate, so Pi does NOT need OpenCode's `fullFeatureMode`
reduced-mode enforcement in `context-handler.ts`. The vestigial `!isSubagent`
checks that exist in the Pi context handler are harmless (always take the
non-subagent branch); they are not the enforcement OpenCode has and adding that
gate would be dead code.

> Recurring false positive: blind councils pattern-match OpenCode's subagent
> gate onto Pi and report "reduced mode not enforced." It does not apply.

---

## 2. Placeholder stripping: Pi REMOVES (splices); OpenCode NEUTRALIZES (sentinel)

**OpenCode** (`strip-content.ts`): replaces a placeholder-only message's parts
with a single empty-text **sentinel**, leaving the message in the array so the
array length / structure stays stable for proxy caches. Safe to run discovery on
any execute pass.

**Pi** (`strip-placeholders-pi.ts`): Pi rebuilds `AgentMessage[]` from JSONL every
pass, so there is no need to preserve array structure — it **splices** the
message out entirely.

**Consequence:** Pi gates placeholder *discovery* to **history-refresh passes
only** (`args.isCacheBusting`), NOT the broader `shouldApplyPendingOps ||
shouldRunHeuristics` OpenCode uses. A freshly-dropped tool stub renders as
`[dropped §N§]`, which `isDroppedOnlyText` matches — so discovering on the *same
execute pass that created the drop* would splice out the just-dropped turn and
collapse it. Discovery is therefore deferred to the next refresh boundary;
replay still runs every pass. (This was learned the hard way — broadening the
gate to `executedWorkThisPass` caused a turn-collapse regression.)

Both harnesses **never neutralize/remove user-role messages** — they anchor turn
boundaries. In Pi's raw array tool results carry role `"toolResult"`; the
synthetic-user folds live only in the transcript *view* (never written back), so
only genuine prompts are user-role in the stripped array.

Pi has no `makeSentinel` empty-text-part wire path; the empty-part-sentinel
provider gate is OpenCode-only by construction.

---

## 3. No `session.deleted` event → `session_before_switch` is reversible

**OpenCode:** `session.deleted` is terminal — the session is gone. OpenCode's
handler clears both in-memory maps AND durable per-session DB state.

**Pi:** Pi has no `session.deleted`. The closest event is
`session_before_switch`, which fires when the user switches *away* — but the
session can be switched back. So the Pi switch handler clears **only in-memory
maps** (the actual per-swap leak) and must **NOT** clear durable DB caches
(`cached_m0_*`, boundary). Clearing the durable m[0] cache on switch would force
a full re-materialization (cache bust) on switch-back. The DB cache is bounded
(one `session_meta` row) and self-invalidates via epoch/version/docs-hash.

`clearSession()` (full durable cleanup) only runs where Pi has a genuine terminal
signal; it is intentionally NOT wired to `session_before_switch`.

---

## 4. Pi owns compaction via `session_before_compact`

**Pi** cancels native Pi compaction (`session_before_compact` → `{cancel:true}`)
and owns the boundary itself: Magic Context stages a native compaction marker
(`pending_pi_compaction_marker_state`) and drains it on the next materializing
pass so `getBranch()` returns the compacted tail. The **wire/context trim**
(`trimPiMessagesToBoundary`) runs every injection pass **independent** of the
native JSONL marker — so even if the marker lags (e.g. a crash window), the
model-visible context is still trimmed. OpenCode uses its own
deferred-compaction-marker mechanism (`compaction-marker.ts`); the two are
mechanism-parallel, not identical.

---

## 5. Pi rebuilds `AgentMessage[]` from JSONL every pass

**Consequence:** Pi does not need OpenCode's in-place sentinel persistence for
array-shape stability. Byte-stability across defer passes is achieved by
replaying persisted state (tags, dropped-status, `stripped_placeholder_ids`,
note/sticky anchors, caveman depth, `source_contents`) deterministically each
pass. The transcript adapter's `commit()` writes part-level mutations back into
the source array for dirty indices only.

---

## 6. Transient UI: Pi uses `ctx.ui.notify` toasts and RPC dialogs

**OpenCode:** TUI dialogs (upgrade prompt, `/ctx-status`, `/ctx-recomp`, `/ctx-embed`, `/ctx-flush`) via RPC,
with an ignored-message fallback for Desktop/Web. Notification drain is
**session-scoped** (a notification tagged for one session never surfaces in
another) because one process can serve multiple sessions and TUI port discovery
is newest-pid-wins.

**Pi:** command status is appended as a model-invisible custom entry. Interactive
terminals render that entry through the registered entry renderer. In Pi RPC
mode, each command uses its live `ctx`: `ctx.ui.notify` presents short progress
as toasts. RPC hosts that execute the `ctx.ui.custom` component factory (such as
pi-web) present detailed results as dialogs; hosts where `custom` resolves without
executing the factory receive the same details through a notification fallback.
A context captured by `session_start` cannot be reused because pi-web can host
multiple sessions in one process. The upgrade reminder passes
`deliveryPersists=false` on Pi, so a missed toast does not honor the old explicit-
dismissal stamp. Both harnesses persist the 24-hour reminder cooldown and three-
delivery cap, preventing repeated startup toasts while `/ctx-status` still reports
compartments that need upgrading.

---

## 6b. `/ctx-status` is one view, built from one shared model

`/ctx-status` takes no arguments on either harness and has no diagnostics mode:
the summary/diagnostics split, the OpenCode dialog's `[ ] Diagnostics` checkbox
and Pi's `[D]` toggle were all removed on 2026-09-20.

**Shared:** `packages/plugin/src/shared/status-view.ts` owns the content — the
title, the pressure headline, the window-derivation line, the coloured category
breakdown, the `Hygiene` row, the seven sections (Tags, Reductions, Pending
Queue, Context Details, Cache TTL, History Compression, Memory) in that order,
and the warning block. Both harnesses build their view from it, so a row cannot
exist on one and be missing on the other. Colours travel as semantic tones that
each host resolves against its own theme; only the category palette is fixed
hex, because it identifies a category across the status view and the sidebar.

**OpenCode:** draws it with the Solid/OpenTUI dialog component
(`src/tui/dialogs/status-dialog.tsx`), two columns when the terminal is at least
76 columns wide and one column below that.

**Pi:** draws the same model with its own line renderer, always in one column,
and fills the breakdown bar with block characters in truecolor ANSI.

Two live-run rows stay host-local because they report a run rather than status
content, and each host has only its own: OpenCode keeps the recomp/upgrade
progress block fed by its RPC progress snapshot, and Pi keeps a single `Upgrade`
row (a detached run, or compartments awaiting `/ctx-session-upgrade`) because it
has no sidebar to carry it. Pi's former `Work tokens`, `Counts`, `Historian`,
`Active profile`, `Memory importance` and `Protected tokens` lines are gone;
the protection-window value object behind the last one is unchanged and its
protected-tag count is drawn as the shared `Protected tags` row.

---

## 6a. Project-identity dubious-ownership warnings

**OpenCode:** when git refuses a repository as dubious ownership, the shared
project-identity resolver logs the fallback and the OpenCode transform/hook path
sends a one-shot session notification with the `safe.directory` command.

**Pi:** `packages/pi-plugin/src/index.ts` surfaces config warnings through the
standard `warn()` log channel and has no startup/session warning channel
equivalent to OpenCode's ignored-message fallback. Pi therefore relies on the
shared resolver's log-only dubious-ownership warning while still using the same
`dir:` fallback identity and retry cooldown.

---

## 7. Storage & process model

- Pi sessions are JSONL (`~/.pi/agent/sessions/*.jsonl`); OpenCode uses its own
  SQLite DB. Both write the *shared* Magic Context DB, tagged with a `harness`
  discriminator on session-scoped tables.
- Pi subagents spawn via `PiSubagentRunner` (`pi --print --mode json`). Large
  prompts (> ~96 KiB, e.g. a 50K-token historian chunk) are delivered via piped
  **stdin** (Pi concatenates stdin + positional) to avoid Linux `MAX_ARG_STRLEN`
  / E2BIG; the positional is omitted when piping.
- `--no-session` keeps subagent JSONL out of the user's session picker.
- In pi-web, multiple sessions can share one process. Startup maintenance runs
  once per process, while each session wires its own hooks. Dreamer registration
  is process-shared and tracks sibling ownership, so one session's shutdown cannot
  deregister another session's project timer.
- `session_shutdown` drains only that session's in-flight historian and recomp work
  and only the shutting-down extension instance's Dreamer work. Child-session
  lifecycle listeners are detached only for that extension instance.

---

## 8. Pi-only mechanisms (no OpenCode counterpart)

- **`synth-user-<realId>` folding:** Pi folds runs of `toolResult` entries into a
  synthetic user message (the toolResult→assistant transition). Tail tool-result
  runs (no following user) get a `synth-user-<firstToolResultEntryId>` id so the
  tail tool output is taggable/droppable. Consumers handle the prefix differently
  by design: compaction-boundary selection (`findFirstKeptEntryId`) **defers**
  (returns null) on a synthetic boundary; boundary trim **resolves** it to the
  underlying real entry id.
- **`pi_stable_id_scheme` (migration v25):** a one-time forced-execute cutover
  that re-keys persisted tag/drop/caveman/placeholder state from `pi-msg-<index>`
  ids to real `SessionEntry` ids. OpenCode has stable message ids natively.
- **`syntheticLeadingCount`:** anchor-GC excludes the id-less m[0]/m[1] synthetic
  prepends from its "all messages resolved" denominator. OpenCode messages all
  have intrinsic `info.id`, so it has no such id-less injected messages to exclude.
- **Dynamic `upgradeState`:** Pi derives `upgradeState` from the presence of
  legacy compartments at runtime.

---

## 8a. Transform-decision attribution binds one prompt later

**OpenCode:** `message.updated` carries the finalized assistant `messageID`, so
Magic Context can bind the in-memory transform decision to that id as soon as the
terminal token update arrives.

**Pi:** the context event's `AgentMessage` has no stable id, and at `message_end`
the assistant `SessionEntry` wrapper has not been appended yet. Pi therefore
records the transform decision in memory with a snapshot of the newest assistant
entry id seen at pass start, then resolves it at the start of the next context
pass by finding the newest assistant `SessionEntry.id` different from that
snapshot. The dashboard keys Pi cache rows on that wrapper id, so this delayed
bind is the first point where the correct durable key exists. The final turn's
decision is written on the next prompt; that is accepted telemetry behavior.

---

## 9. ctx_reduce nudges — same effect, different delivery mechanism

The ctx_reduce nudge system (Channels 1 & 2) shares ALL metric math with OpenCode
via `@magic-context/core/.../ctx-reduce-nudge` (`decideChannel1`, `computePressure`,
`shouldTriggerChannel2`, both reminder builders, `tailToolTokensFromStrings`). Only
the harness I/O differs:

- **Channel 1 (in-turn tool-output nudge).** OpenCode appends the
  `<system-reminder>` to a tool's `output.output` string in `tool.execute.after`;
  Pi appends a `TextContent` block to `toolResult.content[]` in
  `pi.on("tool_result")` (returning `{ content: [...event.content, block] }`). Both
  persist (OpenCode→DB, Pi→JSONL via `appendMessage` on `message_end`) and replay
  verbatim — "free sticky", no anchor/CAS/replay machinery. The metric baseline is
  computed at the end of the pipeline (`pi.on("context")` / OpenCode transform) and
  read in the tool hook. The cadence/band state (`last_nudge_undropped` +
  `last_nudge_level`) is shared DB state so both harnesses suppress same-band
  repetition and reset after `ctx_reduce`. Pi tool output lives in
  `toolResult.content[].text`, not OpenCode's `parts[].state.output` —
  `computeTailToolTokensPi` extracts it, then defers to the shared
  `tailToolTokensFromStrings`.

- **Channel 2 (hidden ceiling nudge).** OpenCode MUST use a live-server
  `createOpencodeClient(serverUrl)` + `/session` probe to dodge the plugin
  runner-split bug (anomalyco/opencode#28202); Pi calls native
  `pi.sendMessage({ customType, content, display:false, details },
  { deliverAs:"steer", triggerTurn:true })`. **Pi has no #28202 workaround,
  live-server client, or probe** — it is single-process. **Hidden-render
  divergence (same intent, different mechanism):** OpenCode marks its promptAsync
  part `synthetic: true` (skips OC core's queued-message wrapper + the #129
  flip-bust, drops from the user-message render, still model-visible); Pi has no
  such wrapper, so `display:false` keeps the custom row out of the TUI while
  `convertToLlm` presents it to the model. Neither presents the nudge as a literal
  user turn.

  `steer` is the shared Pi/oh-my-pi (OMP) boundary contract. During a busy Pi 0.83.0 run it
  queues the custom row; the [parallel executor finishes every scheduled
  tool](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/agent/src/agent-loop.ts#L489-L554),
  then the [loop injects steering before the next model
  call](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/agent/src/agent-loop.ts#L181-L193).
  OMP 18.1.7 likewise awaits the current batch before its next model boundary
  ([interrupt classification](https://github.com/can1357/oh-my-pi/blob/c4da0d08e8275659f3e09cf381c7df7018a19025/packages/agent/src/agent-loop.ts#L2478-L2517),
  [result pairing and skip rules](https://github.com/can1357/oh-my-pi/blob/c4da0d08e8275659f3e09cf381c7df7018a19025/packages/agent/src/agent-loop.ts#L2560-L2579),
  [await and injection boundary](https://github.com/can1357/oh-my-pi/blob/c4da0d08e8275659f3e09cf381c7df7018a19025/packages/agent/src/agent-loop.ts#L2781-L2889)).
  Ordinary tools are never skipped. OMP may cancel only tools that explicitly opt
  into interruption (currently pure waits such as `hub wait`/`vibe`), and emits
  synthetic skipped results so every tool call remains paired. When idle,
  `triggerTurn:true` starts a model turn with the nudge on both [Pi](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/agent-session.ts#L1450-L1462)
  and [OMP](https://github.com/can1357/oh-my-pi/blob/c4da0d08e8275659f3e09cf381c7df7018a19025/packages/coding-agent/src/session/agent-session.ts#L7126-L7142),
  matching OpenCode's idle `promptAsync` behavior.

  Do not restore `nextTurn`: Pi stores it until the next explicit user prompt, so
  a marathon turn never sees Channel 2. OMP's [public hook
  type](https://github.com/can1357/oh-my-pi/blob/c4da0d08e8275659f3e09cf381c7df7018a19025/packages/coding-agent/src/extensibility/hooks/types.ts#L512-L532)
  exposes only `steer | followUp`, even though the [session runtime has hidden
  `nextTurn`/`aside` branches](https://github.com/can1357/oh-my-pi/blob/c4da0d08e8275659f3e09cf381c7df7018a19025/packages/coding-agent/src/session/agent-session.ts#L7019-L7073).
  Hook forwarding performs no runtime validation: an unknown busy-run value falls
  through to steer, while an idle one appends without starting a turn. That
  coercion and the hidden modes are not a supported integration surface.

  The shared `channel2_nudge_state` lease keeps its three-state
  pending→claimed→delivered path, token-bound confirm/revert, ten-minute stale
  claim reap, and one-ceiling-per-tail-cycle cap. Coverage-advancing HARD folds
  and measured U collapse still re-arm the cycle; delivery mode does not alter
  compliance grace. OpenCode emits at `message.updated` (finish=tool-calls OR
  stop). Pi calls the token-bound helper from `tool_result`, with clean-stop
  `agent_end` as fallback.

- **Removed in this redesign (both harnesses):** the rolling/iteration nudge
  (`nudger`/`injectPiNudge`/`nudge-injector.ts`) and the tool-heavy sticky reminder
  (`applyStickyTurnReminder`, `setPersistedStickyTurnReminder`, the `<instruction
  name="ctx_reduce_turn_cleanup">` text). Pi's now-removed `recordPiToolExecution`
  / `toolUsageSinceUserTurn` tracking backed only the deleted sticky reminder.
  Note-nudges and auto-search hints are UNCHANGED (still append to user messages
  via `appendReminderToUserMessageByIdPi`).

---

## 9a. Safe context limits reserve output tokens through one shared rule

**OpenCode:** model metadata supplies `limit.context`, `limit.input`, and
`limit.output`. A smaller `input` is already pre-carved; otherwise the shared
resolver subtracts output capacity (capped at 25% of context), except for the
proven separate-quota Google family.

**Pi:** the raw context comes from `ctx.getContextUsage().contextWindow` or
`ctx.model.contextWindow`, and output capacity comes from `ctx.model.maxTokens`.
Pi sends both through the same `resolveLimit` rule (including
`google-antigravity` and user `output_reserve` handling) before pressure,
history budgets, status displays, or Rust wire input uses the value. In both
harnesses an overflow-detected limit narrows the raw combined window before
output reservation, preventing a detected wire truth from being compared with
an already-reserved budget.

---

## 9b. Pi floors persisted pressure with live forward usage

**OpenCode:** pressure is refreshed per step through `message.updated` /
`step-finish`, so a tool-heavy turn sees context usage climb before the next
request is assembled. OpenCode also performs its own step-finish overflow check,
so no explicit forward floor is needed in the shared pressure path.

**Pi:** `message_end` persists `lastContextPercentage` only after the whole turn.
During a long multi-step turn that value can stay frozen while the live
`AgentMessage[]` grows. Pi therefore floors both scheduler and historian trigger
pressure with `ctx.getContextUsage().tokens`, which is recomputed from the live
message array each context pass.

The floor scales only the forward-pressure denominator (`contextLimit × 0.85`)
to compensate for Pi's estimate-token undercount. It does **not** mutate the real
context limit, and it passes the raw forward token count onward so emergency drop
planning still sees the current assembled size. The floor is monotonic: it never
lowers the persisted pressure, and missing/null forward usage preserves the old
behavior. This forward-pressure floor affects scheduler and historian decisions only.
Channel 1/2 `ctx_reduce` nudges instead consume the persisted final-tail `{U,T}`
hygiene baseline, excluding reasoning from both terms, so live pressure cannot
silently escalate their severity. Those nudges remain persisted/replayed like
the rest of Pi's sticky context hints.

Emergency drops remain cache-stable: repeated force passes on the same provider
usage sample are latched by `last_emergency_input_sample`, fresh same-turn
forward growth may force another pass, and a no-candidate force pass leaves wire
bytes unchanged.

---

## 9c. Emergency overflow termination follows each host's control surface

**OpenCode:** after the ≥95% historian attempt and emergency tool drops, it
aborts only when recovery was armed by a provider's own context-overflow rejection
and no historian fold materialized reclaim this pass. The TypeScript final-wire
estimate remains telemetry because it cannot reproduce provider framing; numeric
gating is deferred to module-side Rust accounting. Proactive model-shrink recovery
never aborts before the provider has rejected the turn. On a provider-proven abort,
OpenCode sends the actionable `/ctx-flush` or `/clear` notification and then awaits
`session.abort()`, interrupting the run before a guaranteed repeat rejection.

**Pi:** the context extension API has no turn-abort primitive. At ≥95%, Pi sends
the same loud actionable notification, waits briefly for any in-flight historian,
and applies its existing emergency drops, but must return the best-effort reduced
context to Pi. Magic Context intentionally does not invent an abort mechanism
outside Pi's extension API.

---

## 10. Cleared reasoning: historical-cleared / newest-native

When Magic Context clears an aged reasoning/thinking block, the two harnesses use
DIFFERENT mechanisms because their serializers differ. The divergence is
deliberate and source-justified. Both preserve the same scope invariant: historical
reasoning selected for clearing is removed from provider wire, while the newest
provider-visible assistant keeps its native reasoning bytes and position.

- **OpenCode** (`clearOldReasoning` + `stripClearedReasoning`, `strip-content.ts`):
  rewrites the thinking text to `[cleared]`, then — **only for canonical Anthropic**
  (`canUseEmptySentinels === providerID==="anthropic"`) — replaces the whole part
  with an empty *text* sentinel that `@ai-sdk/anthropic` drops before the wire
  (signature gone). For NON-canonical providers OpenCode now **gates the clear OFF
  entirely** (reasoning left intact), because OpenCode's non-Anthropic adapters
  forward empty parts and would otherwise leave a literal `[cleared]` (or a stale
  signature) on the wire. In Rust-native replay, a changed historical assistant
  likewise drops its native reasoning carriers while retaining every other native
  part and its text/tool order; only the newest provider-visible assistant may replay
  the complete native vector with thinking byte-identical at its native position.
  (#162 D2.)

- **Pi** (`reasoning-replay-pi.ts`): EMPTIES the thinking text (`thinking = ""`)
  and **drops the now-stale `thinkingSignature`**, with NO per-provider gate —
  EXCEPT it leaves `redacted` thinking blocks **untouched**. Every Pi serializer
  drops an *empty non-redacted* thinking block before the wire — `anthropic.ts`
  (empty thinking skipped), `openai-completions.ts` (filtered out of
  `nonEmptyThinkingBlocks`, with `reasoning_content=""` auto-filled for providers
  that require it), `amazon-bedrock.ts`/`google-shared.ts`/`mistral.ts` (empty
  thinking skipped). So no normal block and no signature reach ANY provider, which
  structurally eliminates the stale-signature mismatch and needs no gate.
  **Redacted blocks are the exception**: they serialize `redacted` BEFORE the
  empty-thinking check (`transform-messages.ts`, `anthropic.ts`), so emptying one
  + dropping its signature would put a malformed redacted block (no data, no sig)
  on the wire. They carry no plaintext to save, so Pi keeps them verbatim — safe
  and byte-stable.

Why the OLD "keep the signature" note was wrong: a `thinkingSignature` is a
cryptographic signature over the ORIGINAL thinking text, so `[cleared]` (or any
rewrite) + the original signature is a content/signature MISMATCH on canonical
Claude/Bedrock — a real 400 hazard, not a safe no-op. Both harnesses now ensure
no rewritten-with-stale-signature thinking block reaches the wire: OpenCode by
dropping the empty sentinel (canonical only) / not clearing (otherwise), Pi by
emptying so its serializers drop the block. `clearOldReasoning` only touches OLD
assistants (≥ `clear_reasoning_age` tags back); the latest assistant keeps its
real reasoning on both harnesses.

---

## 10. m[1] recompute gate uses Pi pipeline work, not history-refresh flag

OpenCode gates m[1] recompute on `isCacheBustingPass` (`shouldApplyPendingOps || shouldRunHeuristics`); Pi gates on `executedWorkThisPass || rematerialized` — same effective set, different assembly.

---

## 11b. Recomp runs detached in the background (mechanism differs, behaviour matches)

`/ctx-recomp` runs DETACHED on both harnesses — the REPL/TUI stays responsive
while the multi-pass historian recomp runs — but the mechanism differs because
the process models differ:

- **OpenCode** runs `void runManagedRecomp(...)` in its separate server process;
  the TUI client keeps accepting input and shows a live progress bar via RPC
  polling.
- **Pi** is a single-process REPL where the command handler IS the turn, so an
  inline `await` froze all input. Pi instead spawns the recomp via
  `spawnPiRecompRun` (mirroring `spawnPiHistorianRun`): the handler returns
  immediately after the ack message, the run is tracked in an in-flight map for
  `session_shutdown` drain (keyed by session id so one session does not drain
  another), and progress surfaces through `[ctx-status]`
  messages + the `recomp` status-line flag.

Because Pi's recomp runs in the background (not inside the user's turn), its
post-publish signals are the DEFERRED variants (`signalPiDeferredHistoryRefresh`
/ `signalPiDeferredMaterialization`) and the compaction marker is STAGED (pending
blob + deferred drain), never applied eagerly — exactly like the background
historian's `onPublished`. Eager signals / eager marker apply would force a
materialization (or mutate `getBranch()`) on a cache-stable transform pass,
causing an otherwise avoidable cache bust.

## 11. Work-metrics: Pi folds the in-memory wire array; OpenCode computes lazily in RPC

The TUI/status "work metrics" (new-work / total-input tokens) are a display-only
value. The two harnesses compute it from different sources, so the cost profiles
differ and the fixes differ:

- **Pi** (`context-handler.ts`) calls `computePiWorkMetrics(outputMessages)` — a
  fold over the already-in-memory wire array, bounded by the on-wire message
  count. It is cheap per pass and stays where it is.
- **OpenCode** previously called `computeOpenCodeWorkMetrics` on every transform
  pass — a window-function `json_extract` scan over EVERY assistant row of the
  session in OpenCode's DB (O(session age); ~250ms/pass at 47K rows). That was
  removed from the transform hot path. OpenCode now computes it lazily and
  incrementally in `buildSidebarSnapshot` (the only consumer) via
  `computeOpenCodeWorkMetricsIncremental` + a per-process watermark carry.

Pi does NOT need the incremental watermark machinery because its source is the
bounded wire array, not an ever-growing DB table. Do not "port" the OpenCode
lazy/incremental path to Pi — it would be solving a cost Pi does not have.

## 12. m[0] upgrade-state marker: both harnesses are dynamic (parity)

Both harnesses derive a per-session m[0] upgrade-state marker dynamically and use
it as a HARD-bust trigger so an upgraded session re-materializes m[0]. OpenCode
computes `getUpgradeState`; Pi computes `${PI_M0_UPGRADE_STATE}:${legacy|ready}`
from the presence of legacy compartments at render time
(`inject-compartments-pi.ts`), and the materialize stale-check compares it
(`current.upgradeState !== snapshotMarkers.upgradeState`).

This is **parity**, not a divergence. (Earlier revisions of this doc described
Pi's marker as a pinned constant — that is stale: the marker was made dynamic so
m[0] refolds when a recomp rebuilds a session's legacy compartments into the
current layout. Pi's detached recomp — divergence #11b — additionally re-signals
materialization through its own path.)

---

## 13. Instance-disposal cleanup: OpenCode `server.instance.disposed`, Pi `session_shutdown`

OpenCode wires the SDK `server.instance.disposed` event to an orderly per-instance
cleanup (stop the RPC server, unregister the dream-schedule timer, abort the
auto-update controller), gated on the disposed `directory` resolving to the
instance's own project identity (Desktop runs many instances per process, each
disposed independently). Pi has no `server.instance.disposed` event — it does the
equivalent teardown in its existing `session_shutdown` handler (drain in-flight
historian, etc.). Neither harness disposes the native ONNX embedding session on
teardown: forcing onnxruntime-node's destructor makes the Bun N-API exit crash
worse (tracked upstream at oven-sh/bun#30291); the OS reclaims that memory on exit.

---

## Schema-fence rejection surface

When the shared cross-harness `context.db` is migrated to a schema newer than
this binary supports, `openDatabase()` fail-closes (returns null) and the plugin
disables itself. Both harnesses log the reason. The **user-facing** surface
differs by necessity:

- **OpenCode** sends an ignored chat message via `sendSchemaFenceWarning`
  (Desktop has no visible console, so a silent disable would be invisible to the
  user). Gated on `getSchemaFenceRejection()`.
- **Pi** emits a terminal `warn()` only. Pi's fence check runs at extension
  init, before any session `ctx`/`ctx.ui` exists (it early-returns before
  registering hooks), and Pi always runs in a terminal where the log line is
  directly visible — so the OpenCode "invisible disable" failure mode does not
  apply. Adding a chat-surface warning would require deferring the fence check
  past hook registration, which contradicts fail-closed-before-any-work.

Same effective behavior (fail closed + tell the user); different delivery
because only OpenCode Desktop can hide the log.

---

## 14. Context-limit source: OpenCode reads the SDK; Pi reads its own runtime

Neither harness reads OpenCode's `models.json` (models.dev) file anymore — that
redundant read produced torn-read garbage (a 6748 "limit" for a session that had
run for hours) and let a stale on-disk copy out-vote the live auth-resolved cap
(922k vs the real Codex-OAuth 400k). Each harness now resolves the limit from its
own authoritative runtime source, then bounds it to a sane `[20k, 3M]` range
(shared `isSaneLimit`):

- **OpenCode** warms `apiCache` from the SDK `config.providers()` (OpenCode's
  fully-resolved config: models.dev + snapshot + opencode.json + auth-plugin
  caps), persisted for cold-start. `getSdkContextLimit()` returns the SDK value
  or `undefined`. When it is undefined, OpenCode's trusted resolver can use the
  sane `session_meta.last_usage_context_limit` only when
  `last_observed_model_key` matches the current model. Pi never warms `apiCache`,
  so for Pi that getter is unused.
- **Pi** resolves from its own runtime: `getContextUsage().contextWindow`,
  falling back to `ctx.model.contextWindow` (available at model-select, before
  any message). Because Pi supplies this runtime window even for models absent
  from models.dev, it does not need the OpenCode persisted-usage fallback. The
  detected-overflow limit still overrides both. This is Pi's
  equivalent of OpenCode's SDK — instant and auth-correct — so Pi does not call
  `getSdkContextLimit`/`resolveContextLimit`/`resolveTrustedContextLimit` at all.

Same effective behavior (authoritative per-harness limit, sane-bounded, overflow
override); different source because each harness exposes the resolved window
through a different API. Pi resolves that window once per trigger evaluation and
uses the same value for the trigger budget, boundary snapshot, and historian
runner stale-snapshot check; when the trigger re-resolves a scaled boundary, the
runner receives that trigger snapshot rather than the earlier probe snapshot.

---

## 15. HARD-bust tool-set hash: Removed on both harnesses

The m[0]/m[1] materialization decision (`mustMaterialize` / `mustMaterializePi`)
folds m[1] into m[0] on a HARD bust — a provider-side cache-eviction event where
the prompt cache was already dead, so folding is "free". The HARD trigger set is
identical across harnesses: model/provider change, system-prompt-hash change,
and idle>TTL.

The tool-set hash trigger was previously used to detect tool changes, but was
removed on both harnesses because the signal is process-global and produced
false-positive folds. Pi and OpenCode now both operate without this trigger.

---

## 16. Emergency-recovery disarm: Pi disarms inline; OpenCode uses a counter escape

Both harnesses face the same hazard: `needs_emergency_recovery` armed by an
overflow that the user then resolves (e.g. `/ctx-recomp`), leaving a session at
low real pressure with a non-runnable tail. The flag must not keep force-bumping
pressure to 95% forever, but it MUST stay armed for a *genuine* overflow whose
tail is one in-progress arc (the window becomes runnable once the arc closes).

- **OpenCode** keeps the flag armed and stops only the disruptive bump via a
  counter escape: `recovery_no_eligible_head_count >= RECOVERY_NO_HEAD_LIMIT (2)`
  (`transform.ts`, `protected-tail-boundary.ts`). It never auto-clears; the flag
  is cleared by a successful historian publish, a model switch, or a successful
  `/ctx-recomp` (runManagedRecomp "done").

- **Pi** does NOT increment that counter, so it disarms inline instead: inside
  `maybeFireHistorian`'s no-fire branch, when recovery is armed, no historian is
  in flight, there is no runnable compartment window, AND **real** pressure
  (`usage.percentage`, not the 95% bump) is `< FORCE_MATERIALIZATION_PERCENTAGE`
  → clear the flag. The low-pressure gate is what makes this safe: a genuine
  overflow arc sits near the limit, so it stays armed (matching OpenCode's
  intent); only a stale flag (post-recomp ~20%) disarms.

Both also clear the flag on a successful `/ctx-recomp` (OpenCode runManagedRecomp
"done"; Pi `result.published`) — the recomp IS the overflow resolution.

---

## 17. Runaway hidden-agent loop: OpenCode needs an in-config step cap; Pi relies on subprocess-kill

A weak local model (e.g. llama.cpp with poor instruction-following) can get a
hidden agent (historian/dreamer) stuck in an infinite tool-call loop
(issue #154). The protection differs because the spawn model differs:

- **OpenCode** spawns hidden agents as a child SESSION whose run loop is an
  independent **instance-scoped server fiber**. Our prompt-timeout's
  `controller.abort()` cancels only our client fetch — the fiber keeps re-calling
  the LLM, and the user's ESC only aborts the *main* session (no `parentID`
  cascade). So OpenCode needs TWO guards: (a) `steps`/`maxSteps` on the hidden
  agent config (`buildHiddenAgentConfig` in `index.ts`) so OpenCode force-
  terminates the run loop after N steps, and (b) `client.session.abort({id})` on
  timeout/external-abort (in the shared `promptWithTimeout`) to interrupt the
  server-side loop — `controller.abort()` and `session.delete` do NOT stop it.

- **Pi** spawns hidden agents as separate `pi --print` **subprocesses**
  (`PiSubagentRunner`) and **SIGTERMs the child process** on timeout/abort. Killing
  the process kills the loop — there is no detached continuation. So Pi is
  structurally bounded by `timeoutMs` without needing an in-config step cap. A
  sooner per-step cap would be a nicety (terminate before burning the full
  timeout of local compute), only if `pi --print` exposes one; the SIGTERM bound
  is sufficient for correctness.

Same effective guarantee (a runaway hidden agent cannot loop forever), different
mechanism (OpenCode: in-config step cap + server-side abort; Pi: subprocess-kill).

---

## 18. Dreamer v2 per-task model: delivered via the prompt body, applied differently

Dreamer v2 lets each task carry its own `model` (falling back to the dreamer-level
model). The scheduler's executor sets `body.model = { providerID, modelID }` on the
child-session prompt for the resolved per-task model — this is the SAME mechanism
on both harnesses (the executor is shared core). The application differs at the
client boundary:

- **OpenCode** passes `body.model` straight to `client.session.prompt`; the server
  honors it per call, so per-task models work with no extra plumbing.

- **Pi** has no server-side session model field on the prompt — the model is a
  spawn argument to `PiSubagentRunner` (`pi --print --model …`). Pi's dreamer
  client facade therefore READS `body.model` back out (`extractBodyModel`) and
  threads it into the subprocess spawn, falling back to the dreamer-level model
  when absent. Per-task `thinking_level` is currently NOT threaded per-task on Pi
  (the facade uses the dreamer-level `thinking_level`); per-task thinking is a
  deferred nicety, not a correctness gap.

Same effective behavior (each task runs on its configured model), different
application point (OpenCode: server honors `body.model`; Pi: facade reads it back
into the subprocess spawn args).

## 19. Dreamer v2 manual run: shared scheduler, harness-specific entry

`/ctx-dream` runs the v2 per-task scheduler's `runManualDream` on both harnesses
(shared core): no arg = run every enabled task whose gate passes; a task arg =
force-run that one task ignoring its gate. The only divergence is the wiring: the
OpenCode command handler calls `runManualDream` directly with a freshly-built
executor; Pi routes through `runPiDreamForProject` → the registered project's
`runManual`, reusing the same `PiSubagentRunner`-backed client facade the timer
uses. The dashboard cannot trigger a run on either harness (DB-only, no live
channel) — it reflects `task_schedule_state` read-only.

Interactive Pi runs `/ctx-dream` detached, for the same reason as recomp (§11b):
the command handler is the user's turn, so awaiting the run froze the REPL for
its whole length. The handler returns after the start message; the outcome
arrives as a later `[ctx-status]` message, and the owner-tracked manual run is
aborted and drained by `session_shutdown`. Without a UI (print mode) the command
is the whole invocation, so it still waits for the run.

---

## 19b. Processed-image stripping uses harness-specific image shapes

Both harnesses freeze ids for aged, assistant-processed image messages on
cache-busting passes and replay the frozen set on every pass. OpenCode replaces
large base64 data-URL `file` parts; Pi replaces its native `{ type: "image",
data, mimeType }` user and tool-result parts with the same empty-text sentinel.
Both persist the frozen id before changing bytes, and clone inheritance copies
`processed_image_stripped_ids`.


## 20. Pi subagents discover extensions, then fail closed with per-agent tools

Pi child agents are spawned as `pi --print --mode json --no-session` subprocesses.
They deliberately keep extension discovery **enabled** so auth/provider extensions
can register models (for example `google-antigravity/*`) and the AFT Pi extension
can register read tools. Recursion is blocked at the Magic Context entry point
instead: every child environment includes `MAGIC_CONTEXT_PI_SUBAGENT=1`, and the
full `index.ts` entry returns before registering tools, event handlers, DB work,
or timers. Children that need Magic Context's scoped `ctx_*` tools still load the
explicit lean `subagent-entry.js`; that entry is not guarded.

Because discovery is on, every child also receives an explicit registry gate:
known agents get `--tools <agent-specific allow-list>`, zero-tool agents get
`--no-tools`, and unknown agent ids fail closed to `--no-tools` with a warning.
Pi applies `--tools` during registry construction across both built-ins and
extension-registered tools, so non-listed extension tools (including write-capable
AFT tools) do not enter the child registry.

---

## 21. Refresh-primers investigation toolset includes optional AFT read tools

The open-book `refresh-primers` task runs a locked, read-only code-investigation
agent (`dreamer-primer-investigator`) that digs into the CURRENT source to ground
a primer's answer. The agent is intentionally read-only — no `write`/`edit`/
`bash` (source safety) and no `ctx_memory`/`ctx_note` (a `ctx_memory` mutation
bumps the project memory epoch and busts m[0], breaking the primers cache-neutral
contract).

The investigation TOOLSET now matches OpenCode's read-navigation intent while
staying Pi-safe:

- **OpenCode** allow-list: `read, grep, glob, aft_outline, aft_zoom, aft_search,
  ctx_search` — including AST-aware navigation (`aft_*`).
- **Pi** strict `--tools` allow-list: `read, grep, find, ls, aft_outline,
  aft_zoom, aft_search, ctx_search` — Pi's canonical read-only built-in set
  (`createReadOnlyToolDefinitions`) plus optional AFT read tools and `ctx_search`.
  If the AFT extension is not installed, Pi silently omits those unknown names
  from the registry.

The agent remains read-only and cache-neutral: no `write`/`edit`/`bash`, no
`ctx_memory`/`ctx_note`. It is in `SEARCH_ONLY_SUBAGENT_TOOL_AGENTS` (loads the
lean extension so `ctx_search` is registered) but NOT in `DREAMER_ACTION_AGENTS`
(which would add `ctx_memory`).

Origin-tag emission (the historian tagging each primer candidate with its origin
compartment) IS mirrored across both harness historian runners — that part is
true parity.

---

## 22. Dreamer map-memories / verify prompts vs Pi tool names

Shared dreamer task prompts for **map-memories** and **verify** (and related
read-only code checks) were authored against OpenCode's tool surface: they mention
names like `glob`, `aft_search`, `aft_outline`, and `aft_zoom`. On Pi those agents
run under a strict `--tools` allow-list of Pi's read-only built-ins plus optional
AFT read tools: `read`, `grep`, `find`, `ls`, `aft_outline`, `aft_zoom`, and
`aft_search` (see `dreamer-memory-mapper` in `subagent-runner.ts`). Pi still has
no `glob`; the closest built-in is `find`.

This is intentional — we do **not** fork the shared prompts per harness. The model
uses the registered read-only tools it actually has; if AFT is absent, Pi ignores
the listed-but-unregistered `aft_*` names and the task falls back to the built-ins.
That behavior is harmless for these tasks (local code read + structured manifest
output; the host applies DB writes).

Same safety pattern as §21 (refresh-primers investigator): OpenCode and Pi both
stay read-only; Pi maps `glob` to its `find`/`ls` built-ins and optionally gains
AFT navigation when the AFT extension is installed.

---

## 23. Shrinking model-switch overflow: OpenCode arms proactively; Pi is covered by the forward-pressure floor

When a session switches mid-conversation from a large-context model to a smaller
one (e.g. 512k → 272k) while carrying more history than the new model's window,
the first request on the new model would otherwise be sent oversized and rejected
("Input exceeds context window"), with recovery only arming on the next pass from
the provider error (issue #188).

- **OpenCode** needs an explicit proactive arm. Its pressure on the first pass
  after a switch reads the OLD model's low ratio (the live `contextUsageMap` and
  persisted `lastContextPercentage` were measured against the larger window), so
  no band trips. The transform's overflow block therefore arms recovery
  (flag-only) when the last-measured input exceeds the CURRENT model's trusted
  limit, so the existing bump-to-95% compacts before sending.
- **Pi** needs no such arm. Its `applyForwardPressureFloor` already computes
  `forwardTokens / (contextWindow * 0.85)` every pass, and on the first pass
  after a switch `getContextUsage()` returns `.tokens` ≈ the forward estimate
  (last OLD-model usage + trailing) while `.contextWindow` already reflects the
  NEW (smaller) model (set synchronously at `setModel`). So the floor computes
  ~130% → trips the 95% emergency band → Pi compacts before sending. Verified
  against pi-mono source (`getContextUsage` → `estimateContextTokens`; `setModel`
  sets `state.model` synchronously).

Net behavior matches (both compact before the oversized request), via different
mechanisms: OpenCode adds a targeted arm, Pi reuses its existing floor.

Narrow residual edge (not fixed, documented): if a user switches model in the
window right AFTER a compaction but BEFORE any assistant response on the new
model, Pi's `getContextUsage().tokens` is `null` (no post-compaction usage yet),
so the floor falls back to the low ratio and would not trip. The reported #188
scenario (substantial live history = many old-model assistant usages present) is
firmly outside this edge. If it ever surfaces, the clean Pi fix is
`tokens === null AND model-window-shrank-since-last-pass → arm`.

---

## 24. `ctx_memory` visibility: OpenCode omits registration; Pi enables it per session

When `memory.enabled` is false, the `<project-memory>` block is never injected,
so an agent's `ctx_memory` writes can never resurface. Both harnesses remove
`ctx_memory` guidance from the system prompt and keep the call-time memory gate,
but they control model visibility through their host-specific tool lifecycle:

- **OpenCode** omits `ctx_memory` from registration in `tool-registry.ts` when
  the launch-resolved project config disables memory. The registry and prompt
  read the same session config, so the tool is absent with its guidance.
- **Pi** registers the `ctx_memory` definition once, then calls Pi's
  `getActiveTools()` / `setActiveTools()` at every `session_start` using that
  session's resolved project config. A memory-off session removes it from the
  enabled set; a memory-on session restores it. `session_start` also covers Pi
  reloads, and its config cache is invalidated first, so a config flip applies
  to the next session without restarting Pi. A `/cd` change inside an already
  active session waits for the next session/reload; the existing call-time guard
  still refuses a stale enabled tool in the meantime.

Pi's `memoryToolEnabled` registration flag remains for the lean subagent entry
(`subagent-entry.ts`) to keep `ctx_memory` off read-only Dreamer tasks, a separate
security boundary unaffected by the main-session activation behavior.

---

## 25. Pi clone/fork and OpenCode 2 fork inherit session state; OpenCode 1 `/fork` cannot

Pi preserves JSONL entry ids when cloning a branch, so the clone-start hook can
copy compartments, tags, reductions, and deferred Pi marker state while filtering
them to the copied prefix.

OpenCode 2 records the link (`session_v2.fork_session_id`, `fork_boundary`) and
copies each parent row with its `seq`, type and creation time, re-minting the id
as `<id from the fork event>_<seq>`. On the first pass for a fork with no state,
`v2/fork-inheritance.ts` pairs the rows by `seq` and copies the parent's state up
to the boundary with the same `copySessionStateForClone` (TypeScript mode only).

OpenCode 1 re-mints every id during `/fork` and records no link to the source
session (`session.parent_id` is subagent parentage), so there is nothing to pair
the copy with and no inheritance. A fork there starts empty; the transform's
over-window check (`unmanaged-over-window.ts`) keeps its first request from going
out over the model's window.

---

## 26. Last-known-good replay is shared across harnesses

Both harnesses capture every successfully applied transform representation and
persist it in the shared schema-v81 `lkg_slots` table. A transient
`SQLITE_BUSY`/`SQLITE_LOCKED` failure replays that representation plus the raw
new tail; schema-fence, migration-guard, and storage-open failures remain loud
fail-closed startup refusals and never enter the replay lane.

OpenCode keys the validated prefix with native message ids. Pi uses the stable
`SessionEntry.id` values from its JSONL branch projection, requiring exact id
sequence and content equality through the prior pass's anchor before appending
the pristine native `AgentMessage[]` tail. Pi captures the served JSON bytes
synchronously but defers SHA-256 digests and durable persistence with
`setImmediate`, with the same synchronous next-pass re-arm after an async
capture failure. Successful SOFT+ passes refresh the slot even when they did not
perform a HARD cache bust, preventing a long-lived stale recovery prefix.

---

## Maintenance

Update this file whenever a deliberate Pi↔OpenCode divergence is introduced or
changed. Point audit/council/Oracle briefs at it so intentional divergences are
not re-reported as bugs each round.

---

## 8. Protected-tail true-raw parity is text + tool I/O only

**OpenCode:** raw session reads preserve full provider part JSON, including
reasoning/thinking and image payload metadata. The protected-tail true-raw
estimator can count those categories directly.

**Pi:** transcript shaping deliberately drops thinking parts and image payloads
before the shared protected-tail core sees the folded OpenCode-shaped messages.
Pi still preserves text and tool invocation/result I/O, so protected-tail sizing,
tool-arc fencing, and historian eligibility are parity-tested for those fields.

**Consequence:** thinking/image token parity is a known provider-shape divergence
and is deferred. Tests should assert text + tool-I/O parity and separately track
Pi's expected undercount for thinking/images rather than treating it as a silent
regression.

---

## 7. `/ctx-wrapup` progress surfaces as Pi status messages

**OpenCode:** `/ctx-wrapup` uses the shared recomp progress channel, so the TUI
sidebar can render a live **Wrapup** row with chunk counters.

**Pi:** there is no persistent sidebar row. The command appends one `ctx-status`
custom entry for the upfront estimate and one per historian chunk, then a final
summary. On runtimes with `registerEntryRenderer`, one shared renderer presents
these entries in the interactive transcript. Plain `custom` entries are excluded
from Pi's LLM context, so status progress cannot queue a steer into a streaming
turn. The drain loop, durable `wrapup_in_progress` marker, sequential historian
runs, and deferred compaction semantics are shared in intent; only the progress
surface differs.

The supported Pi floor is `@earendil-works/pi-coding-agent` 0.80.2, while the
workspace test dependency is pinned to 0.83.0. The floor exposes `appendEntry` but
not `registerEntryRenderer`, so status entries are persisted and session-logged but
invisible in its TUI. Statuses never fall back to `sendMessage`, because that would
leak progress text into model context. Newer runtimes render the same entries
through the optional renderer. The intentionally model-visible Channel-2 ceiling
nudge remains on `sendMessage` and uses the `nextTurn` queue supported at the floor.

---

## 9. Compartment date attributes require OpenCode message timestamps

**OpenCode:** when `temporal_awareness` is enabled, fresh m[0]/m[1] renders batch-read
compartment boundary timestamps from `opencode.db` and emit `start-date` / `end-date`.

**Pi:** Pi sessions are JSONL and the Pi compartment pipeline has never had a durable
boundary-timestamp lookup equivalent to OpenCode's message table. Pi therefore omits
these attributes while retaining temporal gap markers derived from Pi message data.
Cached defer passes in both harnesses continue replaying their previously rendered bytes.

---

## 26. Memory mural image: same HARD-fold contract, different message envelope

**Both harnesses** share `resolveMuralWire` (feature flag + vision gate + on-demand
deterministic PNG with text-hash change detection). The mural injects only on a
HARD m[0] materialization; defer passes replay the baked-in `<memory-mural>`
marker and image bytes without re-rendering. Restart-safe replay reloads the PNG
from `mural_manifest` when the cached m[0] text still carries the marker.

**OpenCode:** prepends a synthetic user head with a `file` part
(`mime: image/png`, `url: data:image/png;base64,…`, `synthetic: true`).

**Pi:** prepends a synthetic user entry with Pi's native image content block
(`{ type: "image", data: <raw base64>, mimeType: "image/png" }`). Pi provider
serializers rebuild the data-URL form for the wire. Same PNG bytes; different
envelope because Pi's `AgentMessage` shape has no OpenCode-style file parts.

**Vision gate:** both call `modelSupportsVision` via the shared models.dev /
SDK metadata cache. Pi-native provider prefixes (`openai-codex/…`,
`google-antigravity/…`) are translated to the canonical OpenCode form before
lookup. Pi does not warm that cache (see §14); when metadata is absent the gate
**fails closed** (text-only baseline, no throw). A Pi-only install therefore
never injects the mural image until vision metadata is available; OpenCode warms
the cache from its SDK at startup.

**Config:** both honor `mural.enabled`. The compress-cues dreamer task takes its
model from each harness's own dreamer settings
(`dreamer.<harness>.tasks.compress-cues.model`, then `dreamer.<harness>.model`);
the old shared `mural.model` is deprecated and ignored on both. No intentional per-provider image-part
blacklist today — every Pi serializer path that accepts user image content takes
raw base64 the same way.

## 27. Compaction-off mode: additive Pi transform and native Pi compaction

Both harnesses keep m[0]/m[1] memory, docs, user-profile, raw-message indexing,
search, notes, and dreamer live when `compaction.enabled=false`; both disable
historian work, history rendering/trimming, tag writes, drops, strips, caveman
replay, synthetic todowrite injection, nudge delivery, emergency recovery, and
MC marker work. Pi makes that reduced path in `context-handler.ts` before its
transcript/tag pipeline, so it writes zero new Pi tag rows and returns only the
m[0]/m[1] additive injection.

Pi's native compact hook is the host-specific part: normal mode returns
`{ cancel: true }` because Magic Context owns the compacted view; compaction-off
returns nothing, allowing Pi's threshold and overflow compaction to proceed.
Pi has no OpenCode marker rows. Its MC-owned equivalent is the durable
`pending_pi_compaction_marker_state` JSONL-drain payload plus the in-process
deferred history/materialization signals. The off transition clears both, along
with pending operations, the emergency latch, pending/claimed Channel-2 intent,
and cached m[0]/m[1] bytes. The on transition invalidates the same baseline and
signals historian catch-up when a historian is configured. This is full parity,
not an intentional divergence; only the host marker representation differs.

Pi's todowrite overlay/state capture remains registered in compaction-off mode:
it is UI state and does not write to the model wire. The synthetic todowrite
context pair that would consume that captured state is gated off.

---

## 28. Supersede deltas force-render eligible replacements omitted from m[0]

Both harnesses render a `<superseded>` pointer only when its eligible replacement
is also visible in m[1]. If the replacement predates the m[0] max-id marker but
was omitted from m[0]'s rendered subset, the delta force-renders its full memory
content under `<new-memories>`. This prevents a pointer to content the model has
not received; ordinary new memories remain budget-trimmed and the forced subset
is capped at ten entries in both harnesses.

---

## 29. Idle TTL boundary is strict in both harnesses

Both OpenCode and Pi treat `elapsed == cache_ttl` as a defer pass. The hard-fold
predicate is strict `elapsed > ttl`, so the exact boundary does not pay for a
provider-cache rebuild. Pi keeps the same comparator and parity rationale in
`context-handler.ts`.

---

## 30. Pending-operation reads are cache-stable on Pi defer passes

OpenCode reads pending operations only on an execute, explicit materialization,
force-materialization, known hard-fold, or in-flight-compartment pass. Pi now
uses the same gate: ordinary defer passes replay durable tag/drop state without
reading new `pending_ops` rows. A later eligible pass reads and applies the queued
operations normally, preserving replay bytes while avoiding an unnecessary SQL
read on every defer pass.

---

## 31. System-prompt guidance uses one provider instruction envelope on both harnesses

**OpenCode:** the host exposes `experimental.chat.system.transform` as a `string[]`,
but OpenAI-compatible serializers turn every array entry into a separate wire
message. Magic Context therefore appends its guidance inside `system[0]` with a
blank-line separator instead of adding another array entry. This keeps strict Qwen
and llama.cpp chat templates at one leading system message.

**Pi:** `before_agent_start` exposes one `systemPrompt: string`, and Pi's direct-API
serializers create one provider instruction from that string. Magic Context already
composed the host prompt and guidance with the same blank-line separator, so Pi never
had the second-system-entry defect and requires no provider-specific fix.

Same effective behavior: host identity plus Magic Context guidance is one instruction
envelope for direct OpenAI-compatible providers, including vLLM and llama.cpp.

---

## Pending parity

- Last-known-good transform capture and replay for OpenCode and rust-mode sessions is pending for Pi.

## 32. HARD-fold preflight uses the exact wire state and executed-fold gates

Pi builds one `piM0State` for both the early HARD-fold preflight and the later wire injection. The preflight used to omit `muralEnabled`, so every session with an existing `mural-enabled:1` baseline reported an advisory `render_config` fold while the real injection (which did receive `muralEnabled: true`) replayed the cache. On defer passes that false advisory opened pending-operation, heuristic, and reasoning-cleanup gates even though no fold materialized. The affected population was **Pi sessions with the opt-in mural enabled and an already-materialized m[0] baseline**; it was not every v0.37.0 Pi session and was not caused by window-geometry budget derivation.

The copied production row for session `019de471-4fdc-762d-9286-624dfad0b5fe` reproduced the discrepancy offline: the exact state (`openai-codex/gpt-5.6-sol`, mural enabled, `m15000-h27540`) returned `cache_hit`, while the old preflight shape returned `render_config` with `muralEnabled: true -> false`. `renderBudgetIdentityPi` was equal on both sides. Its compare and fold-write paths both call the same helper with the same state, so the `m15000-h27540` marker is self-consistent and cannot alternate between passes. No data migration is needed: the existing cached marker is already correct, and the next natural pass uses the exact state and exits the loop.

Both harness twins now pre-execute a due fold off-wire and feed the shared `foldExecutesThisPass(foldDue, materialized)` predicate into the BUST clause. A due-but-suppressed fold cannot authorize first-application mutations. OpenCode still drains into genuine HARD folds because its off-wire pre-execution materializes in-process; a byte-differential test compares its final injected parts with the prior one-shot fold shape. The Pi end-to-end test also checks three consecutive low-pressure requests at the serialized-prefix boundary with zero transform-decision bust rows; OpenCode's existing `cache-stability.test.ts` runs the equivalent five-turn serialized system/prefix invariant.

### Model-key and model-indexed lookup audit

| Site | Comparison / lookup discipline |
|---|---|
| Pi `readCurrentMarkersFromCompartments` and `readFrozenM0InputsPi` | Canonicalize the live Pi-native model before marker persistence. |
| Pi `mustMaterializePi` | Canonicalizes both live `hard.modelKey` and stored `cachedM0ModelKey`; aliases match, genuinely different models fold once. |
| Pi `cachedPiRowMatchesSnapshot` | Canonicalizes both cached-row and in-process snapshot keys before the soft-refresh CAS comparison. |
| OpenCode `readCurrentM0SnapshotMarkersUncached` | Canonicalizes the marker written with m[0]. |
| OpenCode `mustMaterialize` | Canonicalizes both the live hard signal and cached m[0] key. |
| OpenCode `cachedRowMatchesState` | Canonicalizes both cached-row and in-process keys. |
| `cache_ttl`, execute-threshold, prompt-surface model maps | Resolve through `modelRefLookupOrder`, whose first candidate is canonical and whose fallbacks include native aliases. Pi canonicalizes the message-end key before persisting the resolved scalar `cacheTtl`; per-pass TTL checks parse that scalar and perform no model-key comparison. |
| `last_observed_model_key` | Write paths canonicalize it and OpenCode readers canonicalize both sides. Pi's pressure writer does not populate this OpenCode usage-attribution field, so an empty value on the incident session is expected; Pi HARD-fold identity comes from `liveModelBySession`, not this column. |

Workspace fingerprints preserve the distinction between SQL `NULL` (not workspaced) and a non-empty hash. The compare normalizes only nullish values to `null`; it does not coerce `NULL` to `""`. A legacy zero-length fingerprint would therefore trigger one self-healing fold whose write stores the current `null`, not a per-pass loop.

## 33. Dropped-input refusal is registered on Pi's event bus

**OpenCode:** The adapter receives tool execution through the host tool hook and
can reject copied `§N§` drop placeholders before the shell tool runs.

**Pi / OMP:** The extension registers the equivalent refusal on Pi's event bus.
The scenario asserts the same no-execution contract, but registration and error
delivery are host-owned and therefore not byte-identical.

**Contract:** `packages/e2e-tests/tests/dropped-input-guard.test.ts` runs one
assertion set through the selected harness. The Pi-family registration carrier is
an intentional divergence; accepting or executing the placeholder is not.

## 34. Notice holding is OpenCode-only

OpenCode's assistant-message transform can hold and release notice messages in
its native run loop. Pi and OMP do not expose an equivalent notice-holding
carrier: their notices are delivered through Pi UI/event surfaces instead.

`packages/e2e-tests/tests/notice-loop-race.test.ts` therefore remains an
OpenCode-only behavior scenario, and its manifest entry names the Pi/OMP
omission explicitly rather than silently treating it as parity.

## 35. OMP provider attestation prevents whole-system byte parity

**HOST-IMPOSED, OMP 18.2.6:** the Anthropic adapter injects
`x-anthropic-billing-header` into `system[0]` and replaces its `cch` value with
an XXHash64-derived attestation of the entire outgoing body. Growing the message
tail therefore changes the system bytes even when Magic Context's contribution
is frozen. Source: [pi-ai anthropic.ts, createClaudeBillingHeader / patchCch / wrapFetchForCch](https://github.com/can1357/oh-my-pi/blob/v18.2.6/packages/ai/src/providers/anthropic.ts#L685-L759),
also shipped in `@oh-my-pi/pi-ai@18.2.6/src/providers/anthropic.ts:685-759`.
Real RPC requests reproduced changing `cch` values (`4527d`, `81d25`) with all
other system bytes unchanged.

The manifest declares OMP divergences for `cache-stability` and
`long-running-session`, rather than stripping the header or weakening their
whole-system identity assertions. The latter fails in phase 1; later OMP phases
are **not claimed verified** by that scenario. The independent OMP cache-invariant,
historian, todo, memory, and overflow scenarios remain enabled. Pi's long-session
marker assertion reads either the pending SQL marker or the applied native JSONL
marker for the exact published ordinal: Pi does not populate OpenCode's applied
marker SQL column.

## 36. OMP parity fixtures use native configuration and wire conventions

| Scenarios | Classification and correction |
| --- | --- |
| Historian success, deferred marker, emergency blocking, slow historian, overflow recovery, conflict disable | HARNESS GAP: write OMP `config.yml` and Magic Context's shared `XDG_CONFIG_HOME/cortexkit/magic-context.jsonc`; the old Pi-only filenames did not configure OMP. Real OMP historian subprocesses publish without product spawn changes. |
| Todo synthesis, memory injection | HARNESS GAP: disable OMP `tools.xdev` and `tools.intentTracing` for directly scripted tool replies, and recognize the actual `_todowrite` / `_ctx_memory` Anthropic wire names. IDs, payloads, replay bytes and memory content assertions remain intact. |
| Cache invariants, compaction off | HARNESS GAP: non-git fixture memory identities must use OMP's exposed cwd, which removes `/private` on macOS, rather than a different realpath spelling. |
| Short-context overflow | HARNESS GAP: replace exact 20-character repeated cycles with distinct same-sized records. OMP correctly rejected the old ballast as a thinking loop, so no reply mass accumulated. The real run now peaks at 93.6% of 128K, publishes historian work and drops 25 tags. |
| Window overlay reload | PRODUCT BUG on both Pi hosts: `getContextUsage().contextWindow` is configured catalog metadata, not observed provider truth. Mark it catalog-sourced in pressure, scheduler, wrap-up and status consumers so the measured overlay wins. HARNESS GAP on OMP: add its mock model cell, and restart/resume for reload because OMP RPC leaves `ExtensionCommandContext.reload` unbound/no-op. |

OMP source references, shipped in 18.2.6:
`pi-coding-agent/src/config/settings.ts:181-194` (`config.yml`),
`src/config/settings-schema.ts:4639-4646,4749-4778` (intent tracing and xd devices),
`pi-ai/src/providers/anthropic.ts:886-900` (wire tool prefix),
`pi-utils/src/dirs.ts:198-203` (`standardizeMacOSPath`), and
`pi-coding-agent/src/extensibility/extensions/runner.ts:460,711,1261` (reload handler).
The overlay test preserves exact 100K/160K denominators, the stale-before-reload
assertion, and the same session ID through the OMP restart.

## Static decision calibration

Pi history rendering and the shared canonical protected-token walk use the same static seeds as OpenCode/Rust. Provider-reported SDK usage remains unscaled. The raw/replay fit helper recounts the supplied array and requires explicit system/tool observations; the storage-failure catch currently has no complete held observations and must refuse rather than admit on serialized byte size alone. Media and unsupported message shapes cannot establish fit. Historian fit uses assembled user/system text and independently resolves each selected model's window. Provider framing and subprocess-added prompt content remain outside MC's observed representation.

Pi tail-hygiene uses the same session-frozen tools/prose ratios, provider-unit floors, cadence/grace arithmetic and reminder figures as OpenCode and Rust. The shared namespaced JSON stamps `hygieneUnitsVersion=2` on the first authorized bust, converts legacy U watermarks once and keeps defer/restart passes on the previously active unit epoch.

Calibration is static-only (`seed` or `family-fallback`). Pi no longer logs returned-array learning observations and has no P/L sample, EMA, learned provenance, runtime adaptation or learned-state persistence.

## Static calibration gate follow-up

Pi storage-error fallback has no complete held system/tool observation at its admission boundary. A small valid LKG prefix is therefore still refused rather than admitted from its byte size. Durable LKG hydration and SOFT+ refresh continue to be tested; the complete-observation mapped-contraction control separately proves that calibrated fit can admit a genuinely observed request. An already oversized byte proxy now rejects before expensive tokenization.

Historian admission reads primary/fallback windows from the live Pi/OMP model registry first and uses the cached model metadata when unavailable. A missing window sends unguarded with a once-per-model warning rather than permanently refusing; measured over-limit assembled prompts still refuse before transport. The old 1.02× source-clamping fixture intentionally refuses the assembled calibrated prompt and leaves coverage unchanged; a raw source allowance did not include all instructions/system mass. `/ctx-recomp` forwards its configured historian model to shared admission rather than relying on an unobservable agent default. Pi's actual child tool schemas and later host framing remain outside the observed system/user prompt representation; no exact provider-token claim is made for those components.

The full Pi suite initially reported 1,193 pass / 3 skip / 31 fail. The affected 344-test groups subsequently reported 340 pass / 4 fail, and the four remaining nested-historian cases passed after their mock window observations were supplied. The environment-only OMP/home and smart-note checks passed without product changes. Pi typecheck passed. No second full suite was run, as requested. Exact commands and counts are committed under `docs/reports/tokenizer-calibration-gates/`.

Tail-hygiene parity is active. Persisted `last_nudge_undropped` and `last_nudge_level.postReduceGraceBaselineU` convert once at the stamped bust; `growthThreshold` is derived from calibrated T. No SQL column, migration, sidecar or fence change was added.
