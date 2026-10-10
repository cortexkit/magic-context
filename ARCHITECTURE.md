# Architecture

Magic Context manages the context window of long-running coding-agent sessions. It keeps a session inside the model's window without losing its history, and it does so while keeping the provider's prompt cache stable, because on a long session the cached prefix is most of the cost.

It runs in several hosts and shares one implementation of the core behaviour:

- **OpenCode 1.x and 2.x**, as the npm plugin `@cortexkit/opencode-magic-context` (`packages/plugin`). The 1.x and 2.x hosts have different plugin APIs; each has a thin adapter over the same core.
- **Pi and OMP**, as `@cortexkit/pi-magic-context` (`packages/pi-plugin`), which imports the core from the OpenCode package.
- **The Rust module `ck-mc`** (`crates/`), a module of the subconscious daemon (subc). It runs the transform and historian when a project opts into Rust transform mode, and it serves Claude Code through the Thalamus proxy.

All hosts and all projects on a machine share one SQLite database, `~/.local/share/cortexkit/magic-context/context.db`. Session-scoped tables carry a `harness` column; project-scoped tables (memories, git commits) are shared across hosts. The Rust module keeps its own store, `store.db`, which moves in step with `context.db` (see Storage).

Paths below are relative to `packages/plugin/` unless they name another package.

## How a session is managed

Magic Context rewrites the message array and system prompt the host is about to send, on every model call. The transform itself makes no model calls; summarisation and maintenance run in hidden child sessions.

- **Tags and reduction.** Every message part and tool output gets a `§N§` tag. The agent marks what it no longer needs with `ctx_reduce`; marked items are removed later, on a pass that is already rebuilding the cached prefix, and leave a `[dropped §N§]` placeholder. Nothing is lost: `ctx_expand` recovers any original from the raw history.
- **History.** The historian reads older raw history in chunks and writes *compartments*: summaries of a stretch of work, each with four detail tiers, an importance score, facts and events. A deterministic renderer picks one tier per compartment from its age, importance and the current budget, so history degrades gracefully as it ages.
- **The head of the prompt.** Compartments, memories, project docs and the user profile are rendered into two synthetic user messages at the start of the conversation: `m[0]`, a frozen baseline, and `m[1]`, the delta since `m[0]` was last rebuilt. The protected section below defines exactly when each may change.
- **Knowledge.** Project memories (`ctx_memory`), notes and smart notes (`ctx_note`), unified search over memories, history, git commits and notes (`ctx_search`), and raw recovery (`ctx_expand`).
- **Maintenance.** The dreamer runs scheduled background tasks: verifying memories against code, curating and classifying them, and the other tasks listed under Dreamer.
- **Pressure.** Reduction normally rides a bust that happens anyway. Near the limit a force band (about 85%) applies queued work and runs emergency reclaim; at a provider-proven 95% with nothing folded, the turn is refused rather than sent over the limit.

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

## Transform modes

The transform runs in TypeScript by default. With `transform_mode: "rust"` (experimental; OpenCode 1 only, and only when subc is configured at user level; otherwise it falls back to TypeScript), the TypeScript layer becomes a coordinator: it syncs state to the module, sends each pass over subc, and serves the module's output. If the module fails, it replays the last known good output for the session (`lkg-slot.ts`, `lkg-replay.ts`) so the cached prefix survives the fault, and refuses the turn rather than send an unmanaged prompt when it cannot.

<!-- mc:protected START — hand-authored cache-stability core. The dreamer's maintain-docs task MUST NOT edit, reword, reorder, trim, or drop anything between mc:protected START and mc:protected END; carry it forward byte-for-byte on any rewrite. Only a human edits this region, deliberately. -->

## Transform pass mechanics

This is the heart of the system and the part most easily gotten wrong. A "transform pass" is one invocation of `experimental.chat.messages.transform` (`src/hooks/magic-context/transform.ts`), wrapped defensively in `src/plugin/messages-transform.ts` (transient `SQLITE_BUSY` → return messages unmodified so the prompt loop always proceeds). OpenCode fires it once per LLM round-trip (per step within a turn).

### Pass lifecycle (in order)
1. Resolve usage + scheduler decision (`execute` vs `defer`).
2. Emergency overflow recovery if ≥95%.
3. Compartment trigger check (off the in-memory `args.messages` tail — no `opencode.db` read steady-state); fire the historian async if eligible.
4. Prepare compartment injection (decide m[0]/m[1] materialization).
5. Tag messages; replay dropped-status, caveman, reasoning, placeholder, image strips.
6. Compartment phase: inject the `<session-history>` (m[0]/m[1]) into `message[0]`.
7. **Postprocess** (`transform-postprocess-phase.ts`): the mutation gates — pending-op drain, heuristic cleanup, nudges, synthetic-todowrite, auto-search.

### Pass taxonomy (every pass is exactly one)
- **SOFT+ (defer / `cache_hit`):** nothing new. m[0] AND m[1] replay byte-identical; the entire `system + m[0] + m[1]` prefix stays cached. Only the conversation tail moves (where `ctx_reduce`/age drops land, themselves replayed deterministically). The steady state — most passes are this.
- **SOFT (cache-busting):** m[1] re-renders (new compartments / memories / user-profile surface as deltas) while m[0] stays byte-identical. `system + m[0]` stays cached; the cache busts at the m[1] breakpoint. Driven by an execute pass, `/ctx-flush`, or a deferred-history drain.
- **HARD (m[0] fold):** `mustMaterialize` fires → m[0] re-materializes, folding m[1] into the new decayed baseline and resetting m[1] to a placeholder. The whole prefix rebuilds — but "for free" because the provider cache key was already dead (see HARD triggers in "m[0]/m[1] cache layout"). **Decay re-tiering happens ONLY on a HARD fold** — a SOFT pass must never re-tier (that would change m[0] bytes).
- **Held (prefix-bound thinking only):** while the current turn keeps a signed thinking block, a pass replays the served prefix record (head, compaction summary and cut) byte-identically whatever SOFT or HARD trigger is pending, edits after the last kept thinking block may land, and the pending trigger waits for the first pass that keeps no current-turn thinking (the edit-admission module, `edit-admission.ts`).

### The mutation gates (the part to get right)
Pending-op drain and heuristic cleanup are each gated by the same shape in `transform-postprocess-phase.ts`:
```
shouldApplyPendingOps / shouldRunHeuristics =
  (execute || materializationRequested || forceMaterialization || foldExecutedThisPass) // BUST clause: did a HARD fold land this pass?
  && (!compartmentRunning || emergencyBypassCompartmentGate)                            // VETO clause: is the historian mid-run?
```
- **BUST clause** — only mutate (drop tools, run heuristics) on a pass that is *already* busting the prefix, so the mutation rides that one bust instead of causing its own. `foldExecutedThisPass` is true only after off-wire fold pre-execution reports that m[0] actually materialized; a `mustMaterialize` advisory by itself never opens mutation gates.
- **VETO clause — `compartmentRunning`** — block mutation while the historian is summarizing the tail, so we don't change the bytes it's reading mid-run. Bypassed by `emergencyBypassCompartmentGate`.
- **`emergencyBypassCompartmentGate`** bypasses the veto when `forceMaterialization` (≥85%) **OR `foldExecutedThisPass`** — i.e. a hard fold drains pending ops + runs heuristics even while the historian runs, because the prefix is busting regardless (see "drain into the known bust" invariant). This is safe per the disjoint-DB model below; both harness twins use the shared executed-fold predicate.

### Load-bearing invariants (memorize these)
1. **A HARD bust means the prefix is already gone → drain EVERYTHING into it. Never "defer" a hard bust.** This pass IS the fold; there is no later fold to wait for. Deferring the drain only produces a second, avoidable bust ~one turn later. (The `compartmentRunning` veto must therefore yield to a hard fold — the fold-exec bypass.) *The one exception is provider validity: on a prefix-bound thinking model whose current turn keeps signed thinking, the fold, a first render included, is a prefix edit; the pass replays the served prefix, opens no drain that only the fold would open, and lands only edits after the kept thinking. A HARD trigger that persists in state (a published compartment, a queued mutation, a cleared cache) folds on the first pass that keeps no current-turn thinking, and everything eligible drains into it. A HARD that only time makes true (TTL expiry, cache eviction) is not observed while thinking is kept and is not carried over.*
2. **A defer (SOFT+) pass must replay byte-identical.** Any first-application of a strip/drop on a defer pass changes tail bytes and busts the whole prefix after it. Watermark-gated strips (placeholders, images, stale-`ctx_reduce`) use a **frozen-id replay** pattern: detect-and-freeze the affected ids only on cache-busting passes, replay the frozen set on every pass. There is exactly ONE drop placeholder string, `[dropped §N§]`, a pure function of tag id — never re-derive bytes from mutated content (that caused repeated cache catastrophes).
3. **Deferred work rides the next bust cycle; it never forces its own.** Historian publishes, compaction-marker moves, and queued drops accumulate while m[1] replays frozen, and materialize together on the next genuine bust (execute / hard fold / flush). A historian publish does NOT bust the cache — between busts every pass is `cache_hit`.
4. **Automatic reclaim is ride-only, and every lane shares ONE bust permission.** Age sweeps, heuristic cleanup, supersession and duplicate dedup never originate a bust: they land only on a pass that is already busting for another reason (a fold or refold, a published-history refresh into m[1], `/ctx-flush`, or the ≥85% force band). Queued agent `ctx_reduce` drops ride that same permission and never originate a bust: marking a message queues it, and the drop lands on the next bust cycle. A single per-pass permission decides whether the pass busts, and every mutation lane — reductions, m[1] refresh, heuristics, synthetic todo, sentinel first-application — consults that same permission; a veto that applies to one lane and not another is a defect (the 2026-09-07 ALF split bust: the age sweep bypassed the historian veto that held the m[1] refresh, so one threshold crossing became two priced busts). Cache cost is never a reason for mid-turn deferral: a tool loop is not a reason to hold an execute (the OpenCode detector never engaged and Pi's only measurable effect was withholding drops for hours on steered marathons), and Anthropic's incremental tool-loop caching makes a held mutation cost strictly more than one applied at first eligibility. **Provider validity is the one exception.** On prefix-bound thinking models (the ones `isPrefixBoundThinkingModel` and `is_prefix_bound_thinking_model` match) every kept signed thinking block is bound to the bytes before it. So every first-application edit, in every lane, asks the one admission check of `docs/designs/signed-thinking-hold.md` before it mutates, and an edit that lands before the last kept current-turn thinking block is held: not applied, not persisted, and its trigger not spent. Bust permission authorizes spending cache; it never authorizes invalidating a signature. There is still one permission per pass, and the validity check is one predicate applied the same way to every coordinate. By outcome it splits a pass: the prefix lanes (m[1] refresh, fold) always sit before the boundary and are held, while edits after the boundary land, so one trigger can price a tail bust now and a prefix bust at the next turn. That split is accepted for provider validity alone; any other difference between lanes is still the defect above. A trigger whose authorized work was held is parked: no pass that keeps current-turn thinking treats it as armed, and the first pass that keeps none (normally the first pass of the next turn) carries its original permission forward, so that pass busts for the original reason and every lane drains into it. Held opportunistic work carries no permission; it waits for the next permitted bust, as it does everywhere else.

### Disjoint-DB safety model
Mutating while the historian runs is safe because the two databases are disjoint on the read/write side:
- The historian reads **raw** OpenCode messages from **`opencode.db`** (read-only) for its chunk.
- Drops + heuristics mutate **`context.db`** (`tags` / `pending_ops`) and the in-memory outgoing wire only.
- The historian's in-flight snapshot is validated by `computeRawRangeFingerprint`, which hashes **raw content only** (ids, part types, content lengths) — never tag/drop state — so a concurrent drop can't invalidate it.
- Its post-publish `queueDropsForCompartmentalizedMessages` is idempotent against already-dropped tags.

## m[0]/m[1] cache layout

The compacted history renders into TWO synthetic `user`-role message slots at the head, so the large stable prefix survives steady-state work. `inject-compartments.ts` (`renderM0` / `renderM1` / `materializeM0` / `mustMaterialize`), mirrored in `inject-compartments-pi.ts`. Both slots prepend with `synthetic: true` parts so they don't count toward OpenCode's title-generation gate.

- **m[0] — cumulative baseline (frozen, like `system[0]`).** Holds `<project-docs>` (root `ARCHITECTURE.md` + `STRUCTURE.md`), baseline `<user-profile>`, and the decay-rendered compartment history as of the last materialization. Does NOT change on routine turns.
- **m[1] — volatile delta.** Holds everything added since the last m[0] materialization: new user-profile additions, new memories (via the `maxMemoryId` watermark), `<memory-updates>` supersede deltas, and the newest compartments at full tier. Renders a minimal placeholder when empty (never fully empty — Anthropic cache-breakpoint structure).

**`mustMaterialize` (HARD fold) triggers — organized around the bust taxonomy** so the trigger list and the m[0]/m[1] contract can never silently disagree:
- *Provider-side cache eviction* (the cache is already dead, so folding is free): model/provider change (`cachedM0ModelKey`), system-prompt-hash change (`cachedM0SystemHash`), idle > TTL (`cacheExpired`, self-consuming via `lastResponseTime > cachedM0MaterializedAt`).
- *Genuine m[0] content change* (baseline bytes differ): first render, `cached_m1_missing`, `project_memory_epoch` change (dashboard / external mutation), pending m[0] mutations (`max_mutation_id` — structural compartment delete/merge/recomp), upgrade-state change.
- **Deliberately NOT triggers** (these are m[1] deltas — triggering would bust m[0] on routine background work and defeat the design): **new compartment sequence**, `project_user_profile_version`, `maxMemoryId`, **project-docs-hash change** (docs edits fold in on the next natural hard bust, never on their own), and **tool-set-hash change** (process-global, false positives).
- **Pressure backstop refold:** on a cache-busting pass, if no natural HARD bust has arrived but m[1] has grown large — gated by the m[1]/m[0] size ratio (with a small-m[0] floor) OR an absolute m[1] token cap (~20% of history budget) OR a large memory-mutation count.
- `applyMarkersToState` updates ALL `state.cachedM0*` fields post-materialize (guards against an infinite re-materialize loop). `/ctx-flush` is SOFT (drives m[1] refresh + heuristics, not an m[0] fold).

**Memory mutations route through m[1], not the epoch.** In-session `ctx_memory` mutations do NOT bump `project_memory_epoch`: additive writes surface via the `maxMemoryId` watermark; non-additive (`update`/`archive`/`merge`) record a `memory_mutation_log` row rendered as a `<memory-updates>` delta. Both reconcile into m[0] on the next natural hard bust. The epoch is bumped only by **dashboard** mutations (an external editor can't otherwise signal a running session).

<!-- mc:protected END -->

## Historian

1. **Trigger** (`compartment-trigger.ts`): fires on pressure relative to the execute threshold, on commit clusters, and on the size of the unsummarised tail, reading only the in-memory message tail.
2. **Boundary** (`protected-tail-boundary.ts`): decides which prefix of the raw history is eligible, keeping the live tail and never splitting a tool call from its result.
3. **Produce** (`compartment-runner-incremental.ts`): runs the historian model on the chunk with a bounded prompt (seed examples, recent compartments, the memory block) and checks the prompt fits the model's window before sending.
4. **Validate and publish**: ordinals must be increasing and non-overlapping; the last compartment is discarded when it has no lookahead and re-read next time. Publishing stores compartments, promotes facts to memories, and queues drops for the summarised messages. It never forces a bust; the new history appears on the next pass that rebuilds the prefix.
5. **Render** (`decay-render.ts`, `decay-curve.ts`): one tier per compartment, from age, importance and budget pressure.

`/ctx-recomp` rebuilds compartments from raw history; `/ctx-wrapup` compacts older history on demand while keeping the newest messages raw.

## Memory and search

Memories are project-scoped facts in five categories (project rules, architecture, constraints, config values, naming). They are stored with full-text and vector indexes; embeddings are plain SQLite blobs compared in memory. Agents write through `ctx_memory`; additions reach the prompt through `m[1]` and fold into `m[0]` on the next natural rebuild. Workspaces let projects share selected categories read-only.

`ctx_search` queries memories, the raw-message index, indexed git commits, compartment summaries and notes in one call, with optional date bounds, and hides results the session can already see.

## Dreamer

A process-wide timer checks each task's cron schedule and runs due tasks in their own child sessions, one at a time per conflict domain (all memory-changing tasks share one lease). Tasks: map memories to the files that back them, verify them against code, curate, classify, learn from user friction (retrospective), maintain docs, promote and refresh primers, evaluate smart notes, review user memories, compress memory cues for the mural (the mural itself is rendered on demand, not by a dreamer task). Background writes never force a cache bust; they appear on the next natural rebuild. A failed task retries; a run's failure class and provider error are recorded and shown in `/ctx-status`.

## Storage

- Schema migrations live in `src/features/magic-context/migrations.ts`. `LATEST_SUPPORTED_VERSION` in `storage-db.ts` is the schema fence and must equal the newest migration; a binary whose fence is below the database refuses to open it.
- Because every host shares `context.db`, a migration lands together with a rebuild of both plugin dists and a restart of every host (`bun run build:dists`). A host left on an older fence fails closed.
- New session-scoped tables go in `SESSION_SCOPED_TABLES` (`storage-session-tables.ts`) so session deletion and the orphan sweep clean them.
- SQLite parameters are bound as spread arguments, never an array (`node:sqlite` reads an array as named parameters).
- `context.db` and the Rust `store.db` form one consistency unit; restore both from the same backup or neither.

## Session modes

| Feature | Primary sessions | Subagents | Compaction off |
|---|---|---|---|
| Tags and `ctx_reduce` | yes, when the tool is available | yes, when the tool is available | no |
| Historian, compartments, `m[0]`/`m[1]` history | yes | no | additive `m[0]`/`m[1]` only, no history |
| Nudges | yes | yes | no |
| Heuristic drops | once per turn | every execute pass | no |
| Force band and 95% refusal | yes | overflow path only | no |

Compaction off (`compaction.enabled: false`, user config, restart required) keeps memories, docs, notes, search and expand, and leaves context management to the host.

## Failure handling

- **Fail closed on storage.** If storage cannot be opened or migrated, the transform refuses loudly on every pass instead of letting the prompt grow unmanaged (`fail_closed_blocking`).
- **Fail open per turn.** Ordinary per-turn handlers log and continue. A busy database (`SQLITE_BUSY`) never lets a turn through unmanaged while compaction is on: the turn being sent retries the lock briefly, then replays the last good request, and otherwise refuses the turn. Background work tries once and picks up again on its next run.
- **Provider limits.** Context-overflow errors are parsed and the learned limit is persisted for later passes.
- **Hidden agents** have step caps and are aborted on timeout.

## Further reading

Subsystem detail lives in `docs/architecture/`: the Rust module and its protocol, the OpenCode 2 adapter, Pi specifics, tagging and reclaim lanes, nudges, calibration, embeddings, the dreamer's tasks, storage and migration history.
