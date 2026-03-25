# Architecture

**Analysis Date:** 2026-03-23

## Pattern Overview

**Overall:** OpenCode Plugin — Event-driven Hook Pipeline with SQLite-backed State Machine

**Key Characteristics:**
- The entire system is an OpenCode plugin registered via `@opencode-ai/plugin`; it intercepts and transforms LLM conversation messages on every turn
- All mutable state is persisted in a single SQLite database (`context.db`); in-memory Maps supplement DB for hot-path reads and cross-hook coordination
- The core design constraint is **LLM provider cache preservation**: mutations are queued and deferred until the cache prefix is provably stale (TTL expired or context threshold crossed)
- Subagent (child) sessions run in **reduced mode** — full feature set is skipped; only tagging and structural cleanup run
- Background historian agent runs as a child OpenCode session to summarize conversation history into compartments

---

## Layers

**Plugin Entry Layer:**
- Purpose: Registers all OpenCode hooks and exposes tools; wires dependencies
- Location: `src/index.ts`, `src/plugin/`
- Contains: Plugin factory, tool registry, event adapter, session hook factory
- Depends on: All inner layers
- Used by: OpenCode runtime (external)

**Hook Orchestration Layer:**
- Purpose: Manages per-session state, composes the transform pipeline, and dispatches hook invocations
- Location: `src/hooks/magic-context/hook.ts`, `src/hooks/magic-context/`
- Contains: `createMagicContextHook()` factory, event handler, command handler, nudger, transform coordinator, system-prompt hash detector, text complete handler
- Depends on: Feature layer, shared utilities
- Used by: Plugin entry layer

**Transform Pipeline Layer:**
- Purpose: Rewrites the in-flight message array before it is sent to the LLM provider
- Location: `src/hooks/magic-context/transform.ts`, `src/hooks/magic-context/transform-*.ts`
- Contains: Phase 1 setup (`transform.ts`), Phase 2 post-process (`transform-postprocess-phase.ts`), compartment phase (`transform-compartment-phase.ts`), operations (`transform-operations.ts`)
- Depends on: Feature layer (storage, scheduler, tagger), internal hook utilities
- Used by: Hook orchestration layer

**Feature Layer:**
- Purpose: Domain logic — scheduling, tagging, storage schemas, compartment summaries, memory system, dreamer, sidekick
- Location: `src/features/magic-context/`
- Contains: `Tagger`, `Scheduler`, `ContextDatabase` (SQLite), compartment storage, notes storage, memory subsystem, dreamer subsystem, sidekick client
- Depends on: Shared utilities, `bun:sqlite`
- Used by: Hook orchestration layer, transform pipeline, tools layer

**Tools Layer:**
- Purpose: Agent-callable tools exposed to the LLM; each tool writes to the DB and returns structured text
- Location: `src/tools/`
- Contains: `ctx_reduce`, `ctx_expand`, `ctx_note`, `ctx_recall`, `ctx_memory`, `look-at`
- Depends on: Feature layer (storage, range-parser, memory)
- Used by: Plugin entry layer (via tool registry); invoked by LLM at runtime

**Config Layer:**
- Purpose: Load and validate plugin configuration from JSONC files; merge user-global and project-level configs
- Location: `src/config/`
- Contains: `loadPluginConfig()`, `MagicContextConfigSchema` (Zod), agent-override schema
- Depends on: `zod`, shared JSONC parser
- Used by: Plugin entry layer at initialization

**Shared Utilities Layer:**
- Purpose: Cross-cutting helpers with no domain dependencies
- Location: `src/shared/`
- Contains: Logger, error message formatter, data-path resolver, model suggestion retry, system directive, OpenCode config dir helpers, JSONC parser

**Agents Layer:**
- Purpose: Define agent-facing constants and prompts
- Location: `src/agents/`
- Contains: `HISTORIAN_AGENT` constant (`historian.ts`), `COMPARTMENT_AGENT_SYSTEM_PROMPT` (`magic-context-prompt.ts`)

---

## Data Flow

**Per-Turn Message Transform Flow:**

1. OpenCode calls `experimental.chat.messages.transform` with `{ messages: unknown[] }`
2. `createMessagesTransformHandler` delegates to `createTransform` (in `hook.ts`)
3. **Phase 1** (`transform.ts`):
   - Find `sessionId` from message metadata
   - Load `sessionMeta` from SQLite (fail-open: skip on error)
   - Determine full vs. reduced mode (`isSubagent`)
   - Prepare compartment injection (read DB: compartments, facts, notes, memories)
   - Tag all messages via `Tagger` (assign `§N§` identifiers, write `tags` table)
   - Apply flushed statuses (drops already committed)
   - Strip structural noise (empty parts, orphaned tool results)
   - Strip cleared reasoning blocks
   - Compute watermark (highest dropped tag number)
   - Load context usage from in-memory map
   - Ask Scheduler: `"execute"` or `"defer"`
   - Run compartment phase (may start historian sub-agent, or await it if ≥95% usage)
4. **Phase 2** (`transform-postprocess-phase.ts`):
   - Apply pending operations (if scheduler says execute or explicit flush)
   - Apply heuristic cleanup (auto-drop old tools, deduplicate, strip images/reasoning)
   - Watermark cleanup
   - Batch finalize (single SQLite transaction for all DB writes)
   - Drop stale `ctx_reduce` calls
   - Render compartment injection (splice `<session-history>` synthetic message)
   - Strip dropped placeholder messages
   - Handle sticky turn reminders
   - Compute and apply nudge (cache-anchored)

**Agent `ctx_reduce` Drop Flow:**

1. LLM calls `ctx_reduce(drop="3-5,12")`
2. `ctx_reduce` tool handler (`src/tools/ctx-reduce/tools.ts`): parses ranges, validates tag IDs, inserts rows into `pending_ops` table
3. `tool.execute.after` hook: updates `recentReduceBySession` timestamp (suppresses nudges)
4. On next transform: scheduler decides execute/defer; if execute → `applyPendingOperations()` applies drops

**Historian (Compartment Summarization) Flow:**

1. `checkCompartmentTrigger` fires in event handler on `message.updated` events
2. If triggered: `compartmentInProgress` set to true in `session_meta`
3. `runCompartmentPhase` (in transform): reads raw history chunk, starts historian as child OpenCode session
4. Historian agent runs, produces XML compartments/facts/notes
5. `compartment-runner.ts`: parses output, calls `replaceAllCompartmentState()` atomically
6. Qualifying facts promoted to `memories` table via `promoteSessionFactsToMemory()`
7. Next transform: `prepareCompartmentInjection` reads new state, `renderCompartmentInjection` splices `<session-history>` block

**Cross-Session Memory Flow:**

1. Memories written to `memories` table (by historian promotion or explicit `ctx_memory` tool call)
2. Local embeddings computed via `@huggingface/transformers` or OpenAI embedding API
3. `ctx_recall` tool: performs FTS + cosine similarity search, returns ranked results
4. Memory block injected into `<session-history>` via `prepareCompartmentInjection` (cached in `session_meta.memoryBlockCache` between historian runs)

**State Management:**
- SQLite (`context.db`): Tags, pending ops, compartments, session facts, session notes, memories, memory embeddings, dream state, session meta
- In-memory Maps (hook closure): `contextUsageMap`, `liveModelBySession`, `variantBySession`, `recentReduceBySession`, `toolUsageSinceUserTurn`, `emergencyNudgeFired`, `flushedSessions`, `lastHeuristicsTurnId`

---

## Key Abstractions

**Tagger (`src/features/magic-context/tagger.ts`):**
- Purpose: Assigns and tracks monotonically increasing `§N§` tag numbers per session
- Maintains per-session counters and messageId→tagNumber assignment maps in memory; persists to `tags` table in SQLite
- Pattern: Factory function returning a `Tagger` interface; shared singleton across all sessions

**Scheduler (`src/features/magic-context/scheduler.ts`):**
- Purpose: Decides each turn whether to execute queued drop operations ("execute") or hold them ("defer")
- Pattern: Interface with single `shouldExecute()` method; decision based on context usage percentage vs. threshold AND elapsed time vs. cache TTL

**ContextDatabase (`src/features/magic-context/storage-db.ts`):**
- Purpose: Single SQLite database handle; opened once at plugin init, shared across all hook callbacks
- Path: `~/.local/share/opencode/storage/plugin/magic-context/context.db`
- Pattern: Module-level Map cache keyed by DB path; falls back to `:memory:` if disk unavailable (disables plugin)

**NudgePlacementStore (`src/hooks/magic-context/nudge-placement-store.ts`):**
- Purpose: Tracks which assistant message carries the nudge text (the "anchor") to prevent cache-busting re-placement
- Pattern: Hybrid in-memory + DB store; reads from memory first, writes to both

**PreparedCompartmentInjection:**
- Purpose: Immutable snapshot of all compartment/fact/note/memory data, prepared in Phase 1 before mutations, rendered in Phase 2 after mutations
- Pattern: Two-phase commit — prepare early, render late

**EmbeddingProvider (`src/features/magic-context/memory/embedding-provider.ts`):**
- Purpose: Interface for generating vector embeddings from text
- Implementations: `embedding-local.ts` (HuggingFace Transformers, local WASM), `embedding-openai.ts` (OpenAI API)
- Pattern: Strategy interface selected at initialization

---

## Entry Points

**Plugin Entry (`src/index.ts`):**
- Triggers: OpenCode loads `dist/index.js` as plugin
- Responsibilities: Load config, detect auto-compaction conflict, initialize session hooks + tool registry, register all OpenCode hook slots

**Messages Transform (`src/plugin/messages-transform.ts`):**
- Triggers: Every LLM turn before messages are sent to provider
- Responsibilities: Delegate to `createTransform` (full pipeline)

**Event Handler (`src/plugin/event.ts` → `src/hooks/magic-context/event-handler.ts`):**
- Triggers: `session.created`, `message.updated`, `session.compacted`, `session.deleted`
- Responsibilities: Track context usage, fire compartment triggers, manage session lifecycle state

**Command Handler (`src/hooks/magic-context/command-handler.ts`):**
- Triggers: User runs `/ctx-status`, `/ctx-flush`, `/ctx-recomp`, `/ctx-aug`
- Responsibilities: Status display, force-flush pending ops, trigger recompaction, run sidekick augmentation

---

## Error Handling

**Strategy:** Fail-open for transform pipeline (errors in session meta load → skip transform entirely rather than block chat); fail-closed for storage init (non-persistent DB → disable plugin and show toast)

**Patterns:**
- `try/catch` with `log()` for non-critical transform steps; pipeline continues without the failing step
- Storage layer disables itself if DB is non-persistent; `isDatabasePersisted()` checked at startup
- `getErrorMessage()` utility (`src/shared/error-message.ts`) normalizes all error types to strings
- Historian runs have configurable timeout (`historian_timeout_ms`); timeout cancels the historian session gracefully

---

## Cross-Cutting Concerns

**Logging:** `src/shared/logger.ts` — `log()` function, delegates to `console.log`; all log lines prefixed with `[magic-context]`

**Validation:** Zod schemas for all config inputs (`src/config/schema/magic-context.ts`); `parseRangeString` validates tag range inputs for `ctx_reduce`

**Authentication:** Not applicable — plugin runs as local process within OpenCode; OpenAI embedding API key is optional and user-configured

**Cache Preservation:** Architectural-level concern woven through all mutation decisions; scheduler, nudge anchoring, compartment injection, deferred writes all designed around LLM provider cache TTL semantics

**Subagent Detection:** `isSubagent` flag set in `session_meta` on `session.created` event; used to gate full-feature-mode transforms

---

*Architecture analysis: 2026-03-23*
