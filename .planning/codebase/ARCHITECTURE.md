# Architecture

**Analysis Date:** 2026-03-25

## Pattern Overview

**Overall:** Plugin-driven orchestration. `src/index.ts` exports a single `Plugin` factory that wires all subsystems — hooks, tools, commands, and hidden agents — into OpenCode's plugin API (`@opencode-ai/plugin`).

**Key Characteristics:**
- Thin adapter layer in `src/plugin/` delegates all business logic to `src/hooks/magic-context/` and `src/features/magic-context/`.
- SQLite-backed durable state (`src/features/magic-context/storage-db.ts`) stores tags, pending ops, compartments, memories, dream state, and per-session metadata.
- Three hidden sub-agents (dreamer, historian, sidekick) are spawned as child sessions via the OpenCode `client.session` API; they are never exposed in the main conversation.
- The plugin **self-disables** when OpenCode's built-in auto-compaction is active (detected in `src/shared/opencode-compaction-detector.ts`).

## Layers

**Plugin bootstrap:**
- Purpose: Register the plugin, load config, wire agents, hooks, commands, and tools.
- Location: `src/index.ts`
- Contains: Plugin factory, config mutation, hidden agent registration, feature-flag guard.
- Depends on: `src/config/index.ts`, `src/plugin/`, `src/features/builtin-commands/commands.ts`, `src/shared/model-requirements.ts`.
- Used by: Build output `dist/index.js`, OpenCode plugin loader.

**Plugin adapters:**
- Purpose: Keep OpenCode-facing hook wrappers minimal and delegate real work inward.
- Location: `src/plugin/event.ts`, `src/plugin/messages-transform.ts`, `src/plugin/tool-registry.ts`, `src/plugin/hooks/create-session-hooks.ts`
- Contains: Hook wrappers, tool registration, per-session hook construction, schema normalization.
- Depends on: `src/hooks/magic-context/`, `src/tools/`, `src/features/magic-context/`.
- Used by: `src/index.ts`.

**Magic-context runtime:**
- Purpose: Execute the message-transform pipeline, lifecycle event handling, nudging, compartment management, command handling, and historian coordination.
- Location: `src/hooks/magic-context/`
- Contains: `hook.ts` (composition root), `transform.ts` (pipeline entry), `transform-postprocess-phase.ts` (mutation phase), `event-handler.ts`, `command-handler.ts`, compartment runners, nudger, note-nudger, send helpers.
- Depends on: `src/features/magic-context/`, `src/shared/`, `src/agents/magic-context-prompt.ts`.
- Used by: `src/plugin/hooks/create-session-hooks.ts`, `src/plugin/event.ts`.

**Core feature services:**
- Purpose: Encapsulate reusable, stateful services behind narrow APIs.
- Location: `src/features/magic-context/`
- Contains: Storage access (storage.ts, storage-db.ts, storage-*.ts), tagger, scheduler, compaction handler, memory system (`memory/`), dreamer queue/runner/scheduler/lease (`dreamer/`), sidekick runner (`sidekick/`), built-in command definitions (`builtin-commands/`).
- Depends on: `src/shared/`, `bun:sqlite`.
- Used by: `src/hooks/magic-context/`, `src/plugin/tool-registry.ts`, `src/index.ts`.

**Tool surface:**
- Purpose: Expose agent-facing tools with validated argument schemas and storage-backed execution.
- Location: `src/tools/ctx-reduce/`, `src/tools/ctx-expand/`, `src/tools/ctx-note/`, `src/tools/ctx-memory/`, `src/tools/look-at/`
- Contains: Tool definitions using `@opencode-ai/plugin`'s `tool()` helper, argument schemas, action gating, user-facing result formatting.
- Depends on: `src/features/magic-context/`, `src/hooks/magic-context/read-session-chunk.ts`.
- Used by: `src/plugin/tool-registry.ts`.

**Configuration and shared utilities:**
- Purpose: Centralize config parsing, defaults, path resolution, logging, and SDK normalization.
- Location: `src/config/`, `src/shared/`
- Contains: Zod schemas (`src/config/schema/magic-context.ts`), config merging (`src/config/index.ts`), data-path helpers, buffered file logger, JSONC parsing, model helpers, SDK response normalization.
- Depends on: Node built-ins, Zod.
- Used by: All other layers.

## Data Flow

### Plugin Startup

1. `src/index.ts` calls `loadPluginConfig(ctx.directory)` — merges user-level config (`~/.config/opencode/magic-context.jsonc`), project-root config (`magic-context.jsonc`), and `.opencode/magic-context.*`.
2. Calls `isOpenCodeAutoCompactionEnabled()` — if OpenCode's own compaction is on, `pluginConfig.enabled` is forced to `false`.
3. `createSessionHooks()` in `src/plugin/hooks/create-session-hooks.ts` builds the `Tagger`, `Scheduler`, and `CompactionHandler`, then calls `createMagicContextHook()` which opens the SQLite database and returns all hook handlers (or `null` if storage is unavailable).
4. `createToolRegistry()` in `src/plugin/tool-registry.ts` independently opens the same SQLite database, resolves project identity, initializes embeddings, and returns gated tool definitions.
5. `src/index.ts` returns the assembled plugin object containing `tool`, `event`, `config`, and all hook handler keys.
6. The `config` hook mutates the OpenCode config to inject hidden agent definitions (dreamer, historian, sidekick) and built-in slash commands.

### Session Message-Transform Pipeline

1. OpenCode calls `experimental.chat.messages.transform` → `src/plugin/messages-transform.ts` → `createTransform()` in `src/hooks/magic-context/transform.ts`.
2. `createTransform()` extracts the session ID from the message array and reads `SessionMeta` from SQLite.
3. `tagMessages()` in `src/hooks/magic-context/transform-operations.ts` assigns incremental `§N§` tag numbers to untagged messages and writes them to the `tags` table.
4. `getTagsBySession()` loads the current tag state; `applyFlushedStatuses()` applies any pending `ctx-flush` op.
5. `stripStructuralNoise()` and `stripClearedReasoning()` prune rendering artifacts from the message array.
6. `runCompartmentPhase()` in `src/hooks/magic-context/transform-compartment-phase.ts` decides whether to start/await a historian agent run (injecting `<compartment>` blocks into the session history).
7. `runPostTransformPhase()` in `src/hooks/magic-context/transform-postprocess-phase.ts` applies pending drop/compact operations, heuristic cleanup, nudge placement, and memory injection.

### Event Lifecycle

1. OpenCode emits `session.created`, `session.deleted`, `message.updated`, and `assistant.message.completed` events.
2. `src/plugin/event.ts` forwards them to `createEventHandler()` in `src/hooks/magic-context/event-handler.ts`.
3. `session.created` writes initial `SessionMeta` (subagent flag, cache TTL, model key).
4. `session.deleted` clears tags and session state from SQLite.
5. `message.updated` records context usage (token counts, percentage), checks compaction state, and evaluates whether a historian compartment run should start. After event handling, `runDreamQueueInBackground()` checks the dreamer schedule.
6. `assistant.message.completed` records the last-response time.

### Memory and Search Flow

1. Agent calls `ctx_memory` tool in `src/tools/ctx-memory/tools.ts` with `action` = `write`, `delete`, `search`, `list`, `update`, `merge`, or `archive`.
2. Write operations hash content with `computeNormalizedHash()`, UPSERT into the `memories` SQLite table, and trigger FTS sync via SQL triggers defined in `src/features/magic-context/storage-db.ts`.
3. If embedding is enabled, `embedText()` in `src/features/magic-context/memory/embedding.ts` generates a vector (local via `@huggingface/transformers`, or OpenAI API), stored in `memory_embeddings`.
4. Search merges BM25 FTS scores from `searchMemoriesFTS()` and cosine similarity from `loadAllEmbeddings()` + `cosineSimilarity()` with configurable weights (70% semantic, 30% FTS).
5. Active memories are injected into the session history as a `<project-memory>` XML block by `renderMemoryBlock()` in `src/hooks/magic-context/inject-compartments.ts`.

### Dreamer Background Flow

1. Each `message.updated` event calls `runDreamQueueInBackground()` in `src/hooks/magic-context/hook.ts`, which checks the cron-style schedule at most once per hour.
2. `checkScheduleAndEnqueue()` in `src/features/magic-context/dreamer/scheduler.ts` adds a `dream_queue` entry if the schedule fires.
3. `processDreamQueue()` in `src/features/magic-context/dreamer/runner.ts` dequeues the entry, acquires a cooperative SQLite lease (`src/features/magic-context/dreamer/lease.ts`), then iterates over configured `tasks`.
4. Each task creates a child OpenCode session (`client.session.create`), sends a task prompt to the `dreamer` hidden agent, waits for completion, extracts the assistant response, then deletes the child session.
5. On completion `setDreamState(db, "last_dream_at", ...)` records the timestamp.

### Command Augmentation Flow

1. OpenCode calls `command.execute.before` with the command name.
2. `src/plugin/messages-transform.ts` delegates to `createMagicContextCommandHandler()` in `src/hooks/magic-context/command-handler.ts`.
3. `/ctx-status` → `executeStatus()` returns a markdown status report.
4. `/ctx-flush` → `executeFlush()` marks the session as flushed.
5. `/ctx-recomp` → `executeContextRecomp()` runs the historian synchronously.
6. `/ctx-aug` → `runSidekick()` spawns a child session, searches memories, and re-injects the augmented prompt as a real user message.
7. `/ctx-dream` → `enqueueDream()` then `processDreamQueue()`.
8. All handlers throw a sentinel error prefixed with `__CONTEXT_MANAGEMENT_` to stop OpenCode's default command fallthrough.

## Key Abstractions

**Magic Context hook (`createMagicContextHook`):**
- Purpose: Own all per-instance runtime state (in-memory maps, db handle, sub-handlers) and return the full hook handler object.
- Location: `src/hooks/magic-context/hook.ts`
- Pattern: Composition root; returns `null` on storage failure (fail-closed).

**Tool registry (`createToolRegistry`):**
- Purpose: Gate tool availability by `pluginConfig.enabled` and storage readiness; expose `ctx_reduce`, `ctx_expand`, `ctx_note`, and optionally `ctx_memory`.
- Location: `src/plugin/tool-registry.ts`
- Pattern: Registry builder with conditional feature exposure and schema normalization.

**SQLite database (`openDatabase`):**
- Purpose: Single shared `context.db` opened under `~/.local/share/opencode/storage/plugin/magic-context/context.db` with WAL mode and a 5s busy timeout.
- Location: `src/features/magic-context/storage-db.ts`
- Pattern: Module-level singleton map (`Map<string, Database>`); falls back to `:memory:` on filesystem error, tracked via `WeakMap<Database, boolean>`.
- Tables: `tags`, `pending_ops`, `source_contents`, `compartments`, `recomp_compartments`, `recomp_facts`, `session_facts`, `session_notes`, `memories`, `memory_embeddings`, `dream_state`, `session_meta`, `memories_fts` (virtual FTS5).

**Tagger (`createTagger`):**
- Purpose: Assign monotonically increasing `§N§` tag numbers to messages per session, backed by the `tags` table and `session_meta.counter`.
- Location: `src/features/magic-context/tagger.ts`
- Pattern: Stateful object initialized from SQLite on each transform call.

**Scheduler (`createScheduler`):**
- Purpose: Decide whether to run pending ops based on context usage percentage vs. the configured `execute_threshold_percentage`.
- Location: `src/features/magic-context/scheduler.ts`
- Pattern: Pure decision function; no side effects.

**Compartment runner:**
- Purpose: Spawn the historian hidden agent to compress old session history into `<compartment>` summaries stored in SQLite.
- Location: `src/hooks/magic-context/compartment-runner.ts`, `compartment-runner-incremental.ts`, `compartment-runner-recomp.ts`
- Pattern: In-flight promise registry (`Map<string, Promise<void>>`) ensures only one historian run per session at a time.

**Memory store:**
- Purpose: Project-scoped durable knowledge store with FTS and optional vector search.
- Location: `src/features/magic-context/memory/storage-memory.ts`, `storage-memory-fts.ts`, `storage-memory-embeddings.ts`
- Pattern: SQLite repository with FTS5 triggers and `cosine-similarity.ts` for vector re-ranking.

**Dream queue and lease:**
- Purpose: Run at most one dreamer worker at a time with restart-safe cooperative lease lock.
- Location: `src/features/magic-context/dreamer/queue.ts`, `lease.ts`, `storage-dream-state.ts`
- Pattern: SQLite-backed FIFO queue plus expiring lease in `dream_state`.

**Hidden agents:**
- Purpose: Isolated agent identities; prompts are separate from wiring.
- Location: `src/agents/dreamer.ts`, `src/agents/historian.ts`, `src/agents/sidekick.ts`, `src/agents/magic-context-prompt.ts`
- Pattern: Named string constants plus prompt builder functions; registered via the `config` hook at startup.

## Entry Points

**Plugin entry:**
- Location: `src/index.ts`
- Triggers: OpenCode loads the package listed in `package.json` `"main"` (`dist/index.js`).
- Responsibilities: Load config, self-disable when OpenCode auto-compaction is active, build session hooks and tool registry, return the plugin object with all handler keys.

**Message-transform entry:**
- Location: `src/plugin/messages-transform.ts`
- Triggers: `experimental.chat.messages.transform` on every model call.
- Responsibilities: Delegate the mutable message array to the magic-context transform pipeline.

**Event entry:**
- Location: `src/plugin/event.ts`
- Triggers: OpenCode `event` hook for session and message lifecycle events.
- Responsibilities: Forward all events to the magic-context runtime event handler.

**Tool entry:**
- Location: `src/plugin/tool-registry.ts`
- Triggers: Plugin initialization.
- Responsibilities: Open storage, normalize argument schemas, expose the conditional tool set.

**System-prompt entry:**
- Location: `src/hooks/magic-context/system-prompt-hash.ts`
- Triggers: `experimental.chat.system.transform` on every model call.
- Responsibilities: Detect system-prompt changes that invalidate the nudge anchor.

## Error Handling

**Strategy:**
- **Fail closed on storage unavailability:** `createMagicContextHook()` returns `null` and shows a TUI toast; `createToolRegistry()` returns `{}`. Both check `isDatabasePersisted()` before proceeding.
- **Fail open inside per-turn handlers:** transform steps catch errors individually, log them, and skip the failing mutation rather than aborting the whole turn.
- **Sentinel errors for command fallthrough:** `command-handler.ts` throws errors prefixed with `__CONTEXT_MANAGEMENT_` to prevent OpenCode from running its default command execution after magic-context handles a command.

## Cross-Cutting Concerns

**Logging:** Buffered file logger at `src/shared/logger.ts`. Writes to `os.tmpdir()/magic-context.log` with 500ms flush interval; silenced in test environments (`NODE_ENV === "test"`).

**Storage path:** SQLite database at `{XDG_DATA_HOME ?? ~/.local/share}/opencode/storage/plugin/magic-context/context.db`, resolved in `src/shared/data-path.ts`.

**Config resolution order:** User config (`~/.config/opencode/magic-context.jsonc`) < project-root config (`{project}/magic-context.jsonc`) < `.opencode/` config (`{project}/.opencode/magic-context.*`). Project overrides user; `.opencode/` overrides project root.

**Sub-agent spawning:** Both dreamer (`src/features/magic-context/dreamer/runner.ts`) and sidekick (`src/features/magic-context/sidekick/agent.ts`) use `client.session.create` + `promptSyncWithModelSuggestionRetry` + `client.session.delete`. The historian compartment runner (`src/hooks/magic-context/compartment-runner-incremental.ts`) follows the same pattern.

---

*Architecture analysis: 2026-03-25*
