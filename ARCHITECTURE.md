# Architecture

Magic Context manages the context window of long-running coding-agent sessions. It keeps a session inside the model's window without losing its history, and it does so while keeping the provider's prompt cache stable, because on a long session the cached prefix is most of the cost.

It runs in several hosts and shares one implementation of the core behaviour:

- **OpenCode 1.x and 2.x**, as the npm plugin `@cortexkit/opencode-magic-context` (`packages/plugin`). The 1.x and 2.x hosts have different plugin APIs; each has a thin adapter over the same core.
- **Pi and OMP**, as `@cortexkit/pi-magic-context` (`packages/pi-plugin`), which imports the core from the OpenCode package.
- **The Rust module `ck-mc`** (`crates/`), a module of the subconscious daemon (subc). It runs the transform and historian for sessions that live in a runner rather than a host with the plugin (mode 3, see "Where the transform runs"). In 0.49.x releases it also runs the experimental Rust transform mode and serves Claude Code through the Thalamus proxy.

All hosts and all projects on a machine share one SQLite database, `~/.local/share/cortexkit/magic-context/context.db`. Session-scoped tables carry a `harness` column; project-scoped tables (memories, git commits) are shared across hosts. The Rust module keeps its own store, `store.db`, which moves in step with `context.db` (see Storage).

Paths below are relative to `packages/plugin/` unless they name another package.

## How a session is managed

Magic Context rewrites the message array and system prompt the host is about to send, on every model call. The transform itself makes no model calls; summarisation and maintenance run in hidden child sessions.

- **Tags and reduction.** Every message part and tool output gets a `§N§` tag. The agent marks what it no longer needs with `ctx_reduce`; marked items are removed later, on a pass that is already rebuilding the cached prefix. A dropped text part becomes a `[dropped §N§]` placeholder. A dropped tool call either keeps its real arguments with a placeholder result (one of the newest 20 tool calls, with a small input) or is removed together with its result, leaving nothing (see Drop under Terms). Nothing is lost: `ctx_expand` recovers any original from the raw history.
- **History.** The historian reads older raw history in chunks and writes *compartments*: summaries of a stretch of work, each with four detail tiers, an importance score, facts and events. A deterministic renderer picks one tier per compartment from its age, importance and the current budget, or omits the compartment once it is old enough to be archived, so history degrades gracefully as it ages.
- **The head of the prompt.** Compartments, memories, project docs and the user profile are rendered into two synthetic user messages at the start of the conversation: `m[0]`, a frozen baseline, and `m[1]`, the delta since `m[0]` was last rebuilt. The protected section below defines exactly when each may change.
- **Knowledge.** Project memories (`ctx_memory`), notes and smart notes (`ctx_note`), unified search over memories, history, git commits and notes (`ctx_search`), and raw recovery (`ctx_expand`).
- **Maintenance.** The dreamer runs scheduled background tasks: verifying memories against code, curating and classifying them, and the other tasks listed under Dreamer.
- **Pressure.** Reduction normally rides a bust that happens anyway. Near the limit a force band (about 85%) applies queued work and runs emergency reclaim; at a provider-proven 95% with nothing folded, the turn is refused rather than sent over the limit.

## Terms

- **Pass:** one run of the transform. It runs once per model request, so once per step of a turn.
- **Prefix:** the part of the request the provider has cached, in request order: tool definitions, system prompt, `m[0]`, `m[1]`, then the older messages. Changing any byte in it makes the provider read everything after that byte again at full price.
- **Rebuild (bust):** a pass that changes bytes inside the cached prefix. Every reduction lands on a rebuild; appending at the end of the request is the only change a non-rebuilding pass makes. A bust has one of three levels, named by how far into the prefix it may change bytes: **SOFT+** changes only the conversation after `m[1]`, **SOFT** also re-renders `m[1]`, and **HARD** re-renders `m[0]` (see Pass taxonomy).
- **Defer pass (cache hit):** a pass that busts nothing. It replays every earlier decision byte for byte and only appends new messages.
- **Rebuild permission:** the single per-pass answer to "may this pass rebuild?". Every lane asks the same permission (invariant 4).
- **Ride:** a reduction landing on a pass that is already rebuilding for another reason, instead of causing a rebuild of its own.
- **Lane:** one kind of reduction, such as queued drops, routine heuristics, reasoning clearing, the emergency tool drop or a history refresh.
- **Execute threshold:** the context usage at which the scheduler says "execute" (`execute_threshold_percentage`, default 65%, per model or as tokens).
- **Execute pass:** a pass whose scheduler decision is "execute": usage is at or above the execute threshold. When the provider reports no usage, the local count of the last request served stands in for the reading, for this decision only; on the first pass after a restart, a saved reading at or above the threshold for the same model and limit decides it. An expired provider cache is not a reason to execute. For a subagent an execute pass is a rebuild permission. For a primary session it is one only when no summary can come (no historian run in progress or waiting to publish, and the historian not allowed to start) and either the queued `ctx_reduce` drops are worth at least 2% of the usable window or this is the third execute pass in a row that held them (invariant 3). Otherwise its work rides the next bust. The scheduler's "defer" decision is not a defer pass: a pass the scheduler defers can still bust, for example when a fold is due.
- **Pressure episode:** the run of passes from when usage reaches the execute threshold until it falls back below it.
- **Force band:** usage at or above `max(85%, execute threshold + 2)`. Queued work applies and the tiered emergency tool drop runs. A reading that only a local count put there (the first pass after a restart, or a provider that reports no usage) counts as force-band pressure only at 95%: below that it takes no force ride, runs no emergency drop and lifts no signed-thinking hold, while the execute pass's own bounded rebuild stays available.
- **Emergency (95%):** usage at or above 95%, or a provider overflow error. A primary session waits for its historian, and a request that still cannot fit is refused rather than sent.
- **Tag:** the number `§N§` given to each message part. `ctx_reduce` names tags.
- **Drop:** removing a tagged part's content. A text part becomes `[dropped §N§]`. A tool call among the newest 20 with a small input keeps its real arguments and its result becomes `[dropped §N§]` (attachments are stripped too); any other dropped tool call is removed together with its result. A call stays as such a skeleton when removing it is impossible: its result ends the request, the host cannot remove it, or it sits next to native reasoning on Anthropic. Duplicate tool outputs that heuristics drop are always removed whole. The choice is made once and replayed on every later pass (`apply-operations.ts`). `ctx_expand` brings the original back. A **queued drop** is what `ctx_reduce` records; it lands on the next rebuild.
- **Historian:** the hidden child session that summarizes older raw history into **compartments** (summaries of a stretch of messages). **Publication** stores new compartments and changes nothing in the request by itself.
- **`m[0]` / `m[1]`:** the two synthetic user messages at the start of the request: `m[0]` is the frozen baseline (docs, profile, memories, history), and `m[1]` is everything added since `m[0]` was last rebuilt.
- **History refresh (SOFT):** a rebuild that re-renders `m[1]` with newly published summaries while `m[0]` stays byte-identical.
- **Fold (HARD):** a rebuild that re-renders `m[0]`: `m[1]` merges into a new baseline, summaries are re-tiered by age, and `m[1]` resets. It happens when the provider cache is already lost because the bytes in front of the messages changed (model or system-prompt change), or `m[0]`'s own content must change (see the `mustMaterialize` triggers).
- **Cut:** the point before which raw messages are no longer sent, because summaries in `m[0]`/`m[1]` cover them. It moves on a history refresh or a fold, never on a defer pass. On OpenCode 1 a compaction marker in the host's store also stops the host loading those messages.
- **Primary session / subagent:** a primary session is one a person works in (a top-level OpenCode or Pi session, or a head session hosted by a runner in mode 3; see Where the transform runs). A subagent is a session another agent started (an OpenCode child session, a mode-3 worker or reader).
- **Signed thinking, prefix-bound model:** Anthropic thinking blocks carry signatures bound to the bytes before them. On prefix-bound models (Fable 5.1 and 5.2, Mythos 5.1 and 5.2, Opus 5.5, Sonnet 5.5, Haiku 5.5; the list is `PREFIX_BOUND_THINKING_MODELS` in `overflow-detection.ts`) any edit before a kept block invalidates it, including any change to the request's tool list (a tool added, removed, renamed, or with a new description or schema). A **hold** is a pass that deliberately does not rebuild, to keep that thinking right after heavy reasoning.

## Code map

| Layer | Where | Role |
|---|---|---|
| Entry | `src/index.ts` | Load config, register hooks, tools, hidden agents, RPC server and dream timer. Default-exports both host shapes (`{ id, server }` for 1.x, `setup` for 2.x). |
| OpenCode 1 adapter | `src/plugin/` | Hook wrappers, tool registry, RPC handlers, dream-timer lifecycle, Rust-mode tool routing. |
| OpenCode 2 adapter | `src/v2/` | Context and compaction hooks, store reader, hidden-completion executor, fold ownership, TUI seam. |
| Runtime | `src/hooks/magic-context/` | The transform, its postprocess phase, history rendering, nudges, strip-and-replay, the Rust-mode adapter. |
| Services | `src/features/magic-context/` | Storage and migrations, tagger, scheduler, memory, dreamer, search and indexes, overflow detection. |
| Tools | `src/tools/` | `ctx_reduce`, `ctx_expand`, `ctx_note`, `ctx_memory`, `ctx_search`. |
| Shared | `src/shared/`, `src/config/` | Logger, SQLite backend, RPC, config schema and loader, prompt surfaces, window geometry. |
| Pi | `packages/pi-plugin/src/` | Pi and OMP hooks over the shared core. Deliberate differences are listed in `packages/pi-plugin/PARITY.md`. |
| Rust | `crates/mc-core`, `mc-store`, `mc-module`, `mc-tokenizer` | Transform and classification, the module store, the subc module and historian, the token estimator. |
| CLI | `packages/cli/` | `npx @cortexkit/magic-context` setup, doctor and migrations. |
| Dashboard | `packages/dashboard/` | Tauri desktop app: config editor, sessions, cache diagnostics, memories. |

`STRUCTURE.md` has the directory map and where to add new code.

## Where the transform runs

- **In the host (OpenCode 1 and 2, Pi, OMP):** the TypeScript transform in `transform.ts` and `transform-postprocess-phase.ts`. This is the reference implementation. Every other path must behave the way it does, lane for lane (see Session modes).
- **Rust transform mode (0.49.x releases only):** with `transform_mode: "rust"` (experimental; OpenCode 1 only, and only when subc is configured at user level; otherwise it falls back to TypeScript), the TypeScript layer becomes a coordinator: it syncs state to the module, sends each pass over subc, and serves the module's output. If the module fails, it replays the last known good output for the session (`lkg-slot.ts`, `lkg-replay.ts`) so the cached prefix survives the fault, and refuses the turn rather than send an unmanaged prompt when it cannot. 0.50.0 removes this mode.
- **Mode 3 (0.50.0 onward; not in 0.49.x releases):** the session lives in an llm-runner instead of a host with the plugin. An llm-runner implements the `llm-runner/v1` contract and can run any session shape, head or worker. THALAMUS is the llm-runner for every harness we don't maintain (OpenCode, Pi, Claude Code); Broca is the llm-runner we fully own and control. Which runner hosts which shape today is an operational limit, not part of the design. The runner reaches ck-mc only through the published contracts (llm-runner, compaction-provider, step-transform-provider): Setup and notices, views it fetches and applies, `compaction.ride` (the runner reporting, before a request, that the request rewrites the provider cache anyway or would not fit, so held work lands in that rebuild), and the `pre_user` hook. All Magic Context policy lives in ck-mc; none runs in the runner. A session's preset decides its mode: `head` is a primary session, `worker` and `reader` are subagents. ck-mc must implement the Session modes table lane for lane, with the TypeScript transform as its specification. A lane TypeScript has and ck-mc lacks is a bug, never a design choice. This ck-mc lives on the mode-3 line (branch `mode3-clean`), not in this branch's `crates/`; that line's own ARCHITECTURE.md describes it.

<!-- mc:protected START — hand-authored cache-stability core. The dreamer's maintain-docs task MUST NOT edit, reword, reorder, trim, or drop anything between mc:protected START and mc:protected END; carry it forward byte-for-byte on any rewrite. The protection applies only to the dreamer: the agent working on Magic Context, or a human, edits this region deliberately whenever the code it describes changes. -->

## Transform pass mechanics

This is the heart of the system and the part most easily gotten wrong. A **transform pass** is one decision about what the model sees on its next request: which reductions apply, what `m[0]`/`m[1]` hold, and whether the cached prefix may change. The rules below (taxonomy, gates, invariants) are the same for every implementation; how a pass runs differs:
- **In a host with the plugin (OpenCode 1 and 2, Pi, OMP):** the host hands the plugin the whole message array before every model request, so once per step of a turn (OpenCode: `experimental.chat.messages.transform`, wrapped in `src/plugin/messages-transform.ts`; Pi: the `context` event). The pass rewrites that array in place. The host rebuilds the array from its own store each time, so every pass replays every earlier decision byte for byte and then decides whether anything new may apply. If the database is busy, the wrapper replays the last good request or refuses the turn; it never sends an unmanaged one.
- **Mode 3 (ck-mc behind an llm-runner):** the runner holds the conversation and renders every request itself; ck-mc never receives or walks the whole array per step. It hears about new messages through notices, reads only messages it hasn't seen, keeps its own index of the rest, and publishes a **view**: edits keyed by message and part identity (the history head, drops, placeholders, replacements) that the runner applies to every request until a newer view replaces it. A pass runs on a Setup, a notice or a ride, not on every step. A step that gets no new view is a defer pass by construction, because the runner re-applies the same view; a bust is a new view that changes bytes the previous one served.

### In-host pass lifecycle (TypeScript, in order)
1. Resolve usage + scheduler decision (`execute` vs `defer`).
2. Emergency overflow recovery if ≥95%.
3. Compartment trigger check (off the in-memory `args.messages` tail — no `opencode.db` read steady-state); fire the historian async if eligible.
4. Prepare compartment injection (decide m[0]/m[1] materialization).
5. Tag messages; replay dropped-status, caveman, reasoning, placeholder, image strips.
6. Compartment phase: inject the `<session-history>` (m[0]/m[1]) into `message[0]`.
7. **Postprocess** (`transform-postprocess-phase.ts`): the mutation gates — pending-op drain, heuristic cleanup, nudges, synthetic-todowrite, auto-search.

### Pass taxonomy (every pass is exactly one)
SOFT+, SOFT and HARD are the three levels of cache bust; each name says how far into the cached prefix the pass may change bytes. Every reduction lane with work lands on a bust of any level; the levels differ only in what changes besides the conversation.
- **Defer (`cache_hit`):** no bust. m[0], m[1] and every earlier message replay byte-identical; earlier drops and strips replay, nothing new applies, and only new messages are appended. The steady state — most passes are this.
- **SOFT+ (conversation bust):** m[0] AND m[1] replay byte-identical, so `tools + system + m[0] + m[1]` stays cached and the cache busts at the first changed message after them. New reductions land in the conversation: queued `ctx_reduce` drops, heuristic drops, smart drops (tool output a later call superseded, when `smart_drops` is on), reasoning clearing, the force-band emergency drop. Examples: invariant 3's execute pass, a force-band or `/ctx-flush` pass when m[1] has nothing new, every subagent execute pass.
- **SOFT (m[1] bust):** m[1] re-renders (new compartments / memories / user-profile surface as deltas) while m[0] stays byte-identical, and every SOFT+ reduction lands with it. `tools + system + m[0]` stays cached; the cache busts at the m[1] breakpoint. Driven by an execute pass, `/ctx-flush`, or a pass that consumes a history publication held since an earlier pass, when m[1] has new content.
- **HARD (m[0] fold):** `mustMaterialize` fires → m[0] re-materializes, folding m[1] into the new decayed baseline and resetting m[1] to a placeholder. The whole prefix rebuilds — but "for free" because the provider cache key was already dead (see HARD triggers in "m[0]/m[1] cache layout"). **Decay re-tiering happens ONLY on a HARD fold** — a SOFT pass must never re-tier (that would change m[0] bytes).

### The mutation gates (the part to get right)
Every lane that changes bytes asks one question per pass: `reclaimRidePermitted` in `cache-busting-signals.ts`, computed in `transform-postprocess-phase.ts` as `publishedWorkDrainAllowed`:
```
permitted = prefixMutationPermitted(gate) && hasReclaimRide(rideSignals)
  prefixMutationPermitted = !signedThinkingHold || firstRender || hostCheckpointHead || emergency
  hasReclaimRide = hardFold || force || explicitFlush || publishedHistory
                || subagentExecute || executeReclaim || servedShapeRepair
```
- **Ride signals.** Each is a rebuild the pass already pays for, so a reduction riding it adds no rewrite of its own. `hardFold`: an executed fold that changed the served prefix, a first render, a rewrite of a signed prefix (including a changed tool list on a prefix-bound model), or a history head that OpenCode 2's compaction hook already replaced for a manual `/compact` (`hostCheckpointHead`, proven by the hook's own record of the change). `force`: the force band, but a reading that only a local count put there waits for the provider's next measurement unless it is at 95% or more. `explicitFlush`: `/ctx-flush`. `publishedHistory`: an m[1] refresh that changed bytes. `subagentExecute`: any subagent execute pass. `executeReclaim`: invariant 3's bounded primary execute pass (`execute-reclaim.ts`). `servedShapeRepair`: repairing the shape of an already-served request. A `mustMaterialize` advisory alone is not a ride; a fold counts only once off-wire pre-execution reports that it ran.
- **The gate.** A pass held for recent signed thinking (invariant 4's one exception) keeps its prefix unchanged; only a first render, a proven host-checkpoint head change, a changed tool list on a prefix-bound model, or emergency pressure lifts the hold (a local count only at 95%). In the first three the request's bytes before the thinking have already changed, so keeping the thinking would only invite a provider rejection. An expired provider cache does not: resending the same bytes keeps the signed thinking valid.
- **Queued `ctx_reduce` drops** apply on every permitted pass (`shouldApplyPendingOps`). **Heuristics** (`shouldRunHeuristics`) need the same permission. On a primary session a plain execute pass runs them at most once per turn, and their routine cleanup at most once per pressure episode, unless another ride already pays for the rewrite.
- **No historian veto.** An in-flight historian run never blocks the drain. Published rows are immutable input to rendering, and the historian reads the host's raw history, never tag or drop state (the disjoint-DB model below).

### Load-bearing invariants (memorize these)
1. **A HARD bust means the prefix is already gone → drain EVERYTHING into it. Never "defer" a hard bust.** This pass IS the fold; there is no later fold to wait for. Deferring the drain only produces a second, avoidable bust ~one turn later.
2. **A defer pass must replay byte-identical.** Any first-application of a strip/drop on a defer pass changes tail bytes and busts the whole prefix after it. Watermark-gated strips (placeholders, images, stale-`ctx_reduce`) use a **frozen-id replay** pattern: detect-and-freeze the affected ids only on cache-busting passes, replay the frozen set on every pass. There is exactly ONE drop placeholder string, `[dropped §N§]`, a pure function of tag id — never re-derive bytes from mutated content (that caused repeated cache catastrophes).
3. **Deferred work rides the next bust cycle; it forces its own only through one bounded exception.** Historian publishes, compaction-marker moves, and queued drops accumulate while m[1] replays frozen, and materialize together on the next genuine bust (hard fold / flush / force band). A historian publish does NOT bust the cache — between busts every pass is `cache_hit`. The exception: on a primary execute pass where no summary can come (none running, none waiting to publish, the summarizer not allowed to fire, no floor mark pending), the execute pass does its rebuild itself instead of waiting for a summary, provided enough queued work exists to justify it — queued `ctx_reduce` drops worth at least 2% of the usable window, or the third consecutive held execute pass — and that pass applies them and the usual cleanup in one rebuild. `ctx_reduce` itself never starts a rebuild: pressure causes the execute pass, and the drops only land in it. While a summary can still come, the drops hold for it. When the summarizer is blocked only by the newest real user prompt, a one-pass mark lets the next pass summarize past that prompt once, and the held drops land with that summary's rebuild.
4. **Automatic reclaim is ride-only, and every lane shares ONE bust permission.** Age sweeps, heuristic cleanup, supersession and duplicate dedup never originate a bust: they land only on a pass that is already busting for another reason (a fold or refold, a first render, a published-history refresh into m[1], `/ctx-flush`, or the force band once the provider's own reading or 95% confirms it). Queued agent `ctx_reduce` drops ride that same permission: marking a message queues it, and the drop lands on the next bust cycle. They never start a rebuild themselves; besides riding one, they land on invariant 3's execute pass, whose queued-work bound counts only what the drain can actually remove, so undroppable or protected work can never make that pass rebuild. A subagent has no summarizer, so for it every execute pass is itself a rebuild permission, and every lane with work rides it: queued `ctx_reduce` drops, routine heuristics, reasoning clearing beyond `keep_reasoning_tokens`, and from the force band the tiered emergency tool drop. Those lanes are all a subagent has, so a path that skips one of them lets the subagent grow until the window ends it. A single per-pass permission decides whether the pass busts, and every mutation lane — reductions, m[1] refresh, heuristics, synthetic todo, sentinel first-application — consults that same permission; a veto that applies to one lane and not another is a defect (the 2026-09-07 split bust on a head session: the age sweep bypassed the historian veto that held the m[1] refresh, so one threshold crossing became two priced busts). There is no mid-turn deferral: a tool loop is not a reason to hold an execute (the OpenCode detector never engaged and Pi's only measurable effect was withholding drops for hours on steered marathons), and Anthropic's incremental tool-loop caching makes a held mutation cost strictly more than one applied at first eligibility. The one exception is the bounded signed-thinking hold on prefix-bound thinking models (`signed-thinking-hold.ts`): right after heavy reasoning, and never at or above the execute threshold plus 10 points.

### Disjoint-DB safety model
Mutating while the historian runs is safe, which is why no historian veto exists, because the two databases are disjoint on the read/write side:
- The historian reads **raw** OpenCode messages from **`opencode.db`** (read-only) for its chunk.
- Drops + heuristics mutate **`context.db`** (`tags` / `pending_ops`) and the in-memory outgoing wire only.
- The historian's in-flight snapshot is validated by `computeRawRangeFingerprint`, which hashes **raw content only** (ids, part types, content lengths) — never tag/drop state — so a concurrent drop can't invalidate it.
- Its post-publish `queueDropsForCompartmentalizedMessages` is idempotent against already-dropped tags.

## m[0]/m[1] cache layout

The compacted history renders into TWO synthetic `user`-role message slots at the head, so the large stable prefix survives steady-state work. `inject-compartments.ts` (`renderM0` / `renderM1` / `materializeM0` / `mustMaterialize`), mirrored in `inject-compartments-pi.ts`. Both slots prepend with `synthetic: true` parts so they don't count toward OpenCode's title-generation gate.

- **m[0] — cumulative baseline (frozen, like `system[0]`).** Holds `<project-docs>` (root `ARCHITECTURE.md` + `STRUCTURE.md`), baseline `<user-profile>`, the decay-rendered `<session-history>`, the budgeted `<project-memory>` block, and the memory mural image (memories that did not fit the block) as of the last materialization. Does NOT change on routine turns.
- **m[1] — volatile delta.** Holds everything added since the last m[0] materialization: new user-profile additions, new memories (via the `maxMemoryId` watermark), `<memory-updates>` supersede deltas, and the newest compartments at full tier. Renders a minimal placeholder when empty (never fully empty — Anthropic cache-breakpoint structure).

**`mustMaterialize` (HARD fold) triggers — organized around the bust taxonomy** so the trigger list and the m[0]/m[1] contract can never silently disagree:
- *Provider-side cache eviction* (the cache is already dead, so folding is free): model/provider change (`cachedM0ModelKey`), system-prompt-hash change (`cachedM0SystemHash`), and on OpenCode 2 only, a change in the names or descriptions of the tools the session's own request carries (the tool list precedes the messages, so the provider cache is already lost). The fingerprint is adopted silently on a session's first pass after upgrade, schema-only differences never count, and a plugin that changes tools after Magic Context's hook is not seen (accepted limit).
- *Provider-side cache eviction, continued:* a native host compaction completed after the last fold (`host_compaction`).
- *Genuine m[0] content change* (baseline bytes differ): first render, `cached_m1_missing`, memory turned off while m[0] still carries memory-derived blocks, a compartment render-format epoch change, a change to the mural setting or the render budgets (a budget that shrank below what was rendered), a project identity change, a workspace fingerprint change or `project_memory_epoch` change (writers outside the session), pending m[0] mutations (`max_mutation_id` — structural compartment delete/merge/recomp), upgrade-state change.
- **Deliberately NOT triggers** (these are m[1] deltas — triggering would bust m[0] on routine background work and defeat the design): **new compartment sequence**, `project_user_profile_version`, `maxMemoryId`, **project-docs-hash change** (docs edits fold in on the next natural hard bust, never on their own), an **expired provider cache** (the request resends the same bytes, so signed thinking stays valid; the experimental Rust transform still folds on it), and the **process-global tool-set hash** on OpenCode 1 and Pi (process-wide, false positives).
- **Pressure backstop refold:** on a cache-busting pass, if no natural HARD bust has arrived but m[1] has grown large — gated by the m[1]/m[0] size ratio (with a small-m[0] floor) OR an absolute m[1] token cap (~20% of history budget) OR a large memory-mutation count.
- `applyMarkersToState` updates ALL `state.cachedM0*` fields post-materialize (guards against an infinite re-materialize loop). `/ctx-flush` is SOFT when m[1] has new content and SOFT+ otherwise (it drives the m[1] refresh and heuristics, never an m[0] fold).

**Memory mutations route through m[1], not the epoch.** In-session `ctx_memory` mutations do NOT bump `project_memory_epoch`: additive writes surface via the `maxMemoryId` watermark; non-additive (`update`/`archive`/`merge`) record a `memory_mutation_log` row rendered as a `<memory-updates>` delta. Both reconcile into m[0] on the next natural hard bust. The epoch is bumped only by writers outside a running session, which can't otherwise signal it: the dashboard (memory edits, workspace membership), identity merges, and the CLI's session migration.

<!-- mc:protected END -->

## Historian

1. **Trigger** (`compartment-trigger.ts`): fires on pressure relative to the execute threshold, on commit clusters, and on the size of the unsummarised tail, reading only the in-memory message tail.
2. **Boundary** (`protected-tail-boundary.ts`): decides which prefix of the raw history is eligible, keeping the live tail and never splitting a tool call from its result.
3. **Produce** (`compartment-runner-incremental.ts`): runs the historian model on the chunk with a bounded prompt (seed examples, recent compartments, the memory block) and checks the prompt fits the model's window before sending.
4. **Validate and publish**: ordinals must be increasing and non-overlapping; the last compartment is discarded when the chunk left too little lookahead past it, and its messages are read again next run. Publishing stores compartments, promotes facts to memories, and queues drops for the summarised messages. It never forces a bust; the new history appears on the next pass that rebuilds the prefix.
5. **Render** (`decay-render.ts`, `decay-curve.ts`): one tier per compartment, from age, importance and budget pressure.

`/ctx-recomp` rebuilds compartments from raw history; `/ctx-wrapup` compacts older history on demand while keeping the newest messages raw.

## Memory and search

Memories are project-scoped facts in five categories (project rules, architecture, constraints, config values, naming). They are stored with full-text and vector indexes; embeddings are plain SQLite blobs compared in memory. Agents write through `ctx_memory`; additions reach the prompt through `m[1]` and fold into `m[0]` on the next natural rebuild. Workspaces let projects share selected categories read-only (constraints only by default).

`ctx_search` queries memories, primers, notes, indexed git commits and the raw message history in one call (`search.ts`, sources `memory`, `primer`, `note`, `git_commit`, `message`), with optional date bounds and an optional reranker, and hides results the session can already see.

## Dreamer

A process-wide timer checks each task's cron schedule and runs due tasks in their own child sessions, one at a time per conflict domain: all memory-changing tasks share one lease per project, docs maintenance and smart-note evaluation have their own, and the user-memory review takes one global lease (`task-registry.ts`). Tasks: map memories to the files that back them, verify them against code (focused and broad), curate, classify, learn from user friction (retrospective), maintain docs, promote and refresh primers, evaluate smart notes, review user memories, compress memory cues for the mural (the mural itself is rendered on demand, not by a dreamer task). Background writes never force a cache bust; they appear on the next natural rebuild. A failed task retries; a run's failure class and provider error are recorded and shown in `/ctx-status`.

## Storage

- Schema migrations live in `src/features/magic-context/migrations.ts`. `LATEST_SUPPORTED_VERSION` in `storage-db.ts` is the schema fence and must equal the newest migration; a binary whose fence is below the database refuses to open it.
- Because every host shares `context.db`, a migration lands together with a rebuild of both plugin dists and a restart of every host (`bun run build:dists`). A host left on an older fence fails closed.
- New session-scoped tables go in `SESSION_SCOPED_TABLES` (`storage-session-tables.ts`) so session deletion and the orphan sweep clean them.
- SQLite parameters are bound as spread arguments, never an array (`node:sqlite` reads an array as named parameters).
- `context.db` and the Rust `store.db` form one consistency unit; restore both from the same backup or neither.

## Session modes

The TypeScript transform decides a session's mode from `sessionMeta.isSubagent` (`fullFeatureMode` is its inverse) and from `compaction.enabled`. In mode 3 the preset decides it (see Where the transform runs).

Every lane lands only on a pass with rebuild permission; the first row says where that permission comes from, and the primary and subagent columns differ mainly there. **Every rebuild** means the lane applies on each such pass. **Once per pressure episode** means a primary session applies it on its first rebuild after usage reaches the execute threshold, and after that only on a rebuild that is already paying for itself: queued drops landed, a fold or history refresh, `/ctx-flush`, or 95%.

| Lane | Primary session | Subagent | Compaction off |
|---|---|---|---|
| Tags, `§N§` prefixes, `ctx_reduce` | when the tool is callable | when the tool is callable | no |
| Rebuild permission comes from | a bust that happens anyway (fold, history refresh, `/ctx-flush`, force band), or its own execute pass when no summary can come and enough drops are queued (see Execute pass in Terms) | every execute pass | nowhere |
| Queued `ctx_reduce` drops land | every rebuild | every rebuild | no |
| Routine heuristics: dedup, supersession, injection strip (`applyHeuristicCleanup`) | once per pressure episode | every rebuild | no |
| Reasoning clearing beyond `keep_reasoning_tokens` (`[cleared]` on canonical Anthropic; removal for other providers and for prefix-bound models, oldest contiguous run only) | once per pressure episode, with the routine heuristics | every rebuild | no |
| Tiered emergency tool drop | from the force band | from the force band | no |
| Refusal of a request proven over the window | yes | yes | no |
| Historian, summaries, `m[0]`/`m[1]` history, folds, force materialization, overflow-recovery latch | yes | no | no |
| Memories, docs and user profile in `m[0]`/`m[1]` | yes | no | yes, additive only |
| Caveman compression, auto-search, note nudges | yes | no | no |
| `ctx_reduce` nudges, time markers (with `experimental.temporal_awareness`) | yes | yes | no |

Every kind of session shrinks the same way: on a pass with rebuild permission, every lane that has work lands in that one rebuild. Two things differ. The first is where the permission comes from: a primary session rebuilds on a bust that happens anyway, or on an execute pass of its own when no summary can come and enough drops are queued (see Execute pass in Terms); a subagent rebuilds on every execute pass. The second is which lanes exist: a primary session also has its historian, whose cut removes every summarized message once a history refresh or fold renders the summary. A subagent has no historian, so the lanes marked yes for it are all it has. On reasoning-heavy models most of a long subagent's context is its own past reasoning, which only reasoning clearing removes.

Compaction off (`compaction.enabled: false`, user config, restart required) keeps memories, docs, notes, search and expand, and leaves context management to the host.

## Failure handling

- **Fail closed on storage.** If storage cannot be opened or migrated, the transform refuses loudly on every pass instead of letting the prompt grow unmanaged (`fail_closed_blocking`).
- **Fail open per turn.** Ordinary per-turn handlers log and continue. A busy database (`SQLITE_BUSY`) never lets a turn through unmanaged while compaction is on: the turn being sent retries the lock briefly, then replays the last good request, and otherwise refuses the turn. Background work tries once and picks up again on its next run.
- **Provider limits.** Context-overflow errors are parsed and the learned limit is persisted for later passes.
- **Hidden agents** have step caps and are aborted on timeout.

## Further reading

Subsystem detail lives in `docs/architecture/`: the Rust module (`rust-module.md`), the OpenCode 2 adapter (`opencode-2.md`), Pi (`pi.md`), reclaim lanes (`reclaim.md`), the historian (`historian.md`), memory and search (`memory-and-search.md`), nudges, calibration, diagnostics, the dreamer's tasks and storage.
