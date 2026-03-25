# Codebase Structure

**Analysis Date:** 2026-03-23

## Directory Layout

```
opencode-magic-context/
├── src/                        # All TypeScript source
│   ├── index.ts                # Plugin entry point (OpenCode plugin factory)
│   ├── agents/                 # Agent identifiers and system prompts
│   ├── config/                 # Config loading and schema validation
│   │   ├── index.ts            # loadPluginConfig() — merges user + project configs
│   │   └── schema/             # Zod schemas: magic-context.ts, agent-overrides.ts
│   ├── features/               # Domain logic, storage, and subsystems
│   │   └── magic-context/
│   │       ├── dreamer/        # Background memory consolidation/decay tasks
│   │       ├── memory/         # Cross-session memory: embeddings, FTS, storage
│   │       ├── sidekick/       # External LLM sidecar for prompt augmentation
│   │       ├── storage.ts      # Re-export barrel for all storage modules
│   │       ├── storage-db.ts   # SQLite database open/init/schema
│   │       ├── storage-meta.ts # Session metadata persistence
│   │       ├── storage-tags.ts # Tag CRUD operations
│   │       ├── storage-ops.ts  # Pending operations (drop queue)
│   │       ├── storage-notes.ts# Session notes persistence
│   │       ├── storage-source.ts# Source content snapshots
│   │       ├── compartment-storage.ts # Compartment/fact persistence
│   │       ├── tagger.ts       # §N§ tag counter and assignment tracking
│   │       ├── scheduler.ts    # Execute vs. defer decision logic
│   │       ├── range-parser.ts # Parse "3-5,12" drop ranges
│   │       ├── defaults.ts     # Default configuration constants
│   │       ├── types.ts        # Core TypeScript interfaces
│   │       └── compaction.ts   # OpenCode built-in compaction event handler
│   ├── hooks/                  # OpenCode hook implementations
│   │   └── magic-context/
│   │       ├── hook.ts         # createMagicContextHook() — main factory
│   │       ├── hook-handlers.ts# Thin wrappers for individual hook slots
│   │       ├── transform.ts    # createTransform() — Phase 1 of message pipeline
│   │       ├── transform-postprocess-phase.ts  # Phase 2 post-mutations
│   │       ├── transform-compartment-phase.ts  # Historian trigger + compartment
│   │       ├── transform-operations.ts         # tagMessages, stripNoise, applyFlushed
│   │       ├── transform-context-state.ts      # Load usage, resolve scheduler
│   │       ├── transform-message-helpers.ts    # Find sessionId, find user message
│   │       ├── transform-stage-logger.ts       # Timing log helpers
│   │       ├── apply-operations.ts             # applyPendingOperations()
│   │       ├── heuristic-cleanup.ts            # Auto-drop old tools/images/reasoning
│   │       ├── inject-compartments.ts          # Prepare + render <session-history>
│   │       ├── compartment-runner.ts           # Historian sub-agent session orchestration
│   │       ├── compartment-runner-*.ts         # Compartment runner sub-modules
│   │       ├── compartment-trigger.ts          # When to start historian
│   │       ├── compartment-parser.ts           # Parse historian XML output
│   │       ├── compartment-prompt.ts           # Historian agent system prompt
│   │       ├── nudger.ts                       # Nudge decision logic (bands/intervals)
│   │       ├── nudge-injection.ts              # Inject nudge text into anchor message
│   │       ├── nudge-placement-store.ts        # Track anchor messageId (hybrid mem+DB)
│   │       ├── nudge-bands.ts                  # Band thresholds (far/near/urgent/critical)
│   │       ├── apply-context-nudge.ts          # Apply nudge to message content
│   │       ├── event-handler.ts                # OpenCode lifecycle events
│   │       ├── event-payloads.ts               # Event payload parsing
│   │       ├── event-resolvers.ts              # Model key/context limit/TTL resolvers
│   │       ├── command-handler.ts              # /ctx-status, /ctx-flush, /ctx-recomp, /ctx-aug
│   │       ├── system-prompt-hash.ts           # Detect system prompt changes → flush
│   │       ├── drop-stale-reduce-calls.ts      # Remove stale ctx_reduce pairs
│   │       ├── strip-content.ts                # Strip cleared reasoning blocks
│   │       ├── strip-structural-noise.ts       # Strip empty parts, orphaned tools
│   │       ├── system-injection-stripper.ts    # Strip old injected content
│   │       ├── tag-messages.ts                 # Tag assignment for messages
│   │       ├── tag-content-primitives.ts       # Low-level tag text insertion
│   │       ├── tag-part-guards.ts              # Type guards for message parts
│   │       ├── tag-id-fallback.ts              # Fallback tag ID extraction
│   │       ├── tool-drop-target.ts             # Drop target for tool parts
│   │       ├── read-session-chunk.ts           # Read history for historian
│   │       ├── read-session-db.ts              # Read session from DB
│   │       ├── read-session-raw.ts             # Read raw session messages
│   │       ├── read-session-formatting.ts      # Format session for historian
│   │       ├── send-session-notification.ts    # Send ignored messages to session
│   │       ├── execute-flush.ts                # Force-flush pending ops
│   │       ├── execute-status.ts               # Build /ctx-status output
│   │       ├── format-bytes.ts                 # Human-readable byte sizes
│   │       └── text-complete.ts                # Autocomplete hook (minimal)
│   ├── plugin/                 # Plugin wiring adapters
│   │   ├── event.ts            # createEventHandler() adapter
│   │   ├── messages-transform.ts # createMessagesTransformHandler() adapter
│   │   ├── tool-registry.ts    # createToolRegistry() — register all tools
│   │   ├── normalize-tool-arg-schemas.ts # Fix JSON Schema arg descriptions
│   │   ├── types.ts            # PluginContext type alias
│   │   └── hooks/
│   │       ├── create-session-hooks.ts   # Initialize Tagger, Scheduler, CompactionHandler
│   │       └── create-tag-content-resolver.ts
│   ├── shared/                 # Cross-cutting utilities
│   │   ├── data-path.ts        # XDG data dir resolution
│   │   ├── error-message.ts    # Normalize errors to strings
│   │   ├── format-bytes.ts     # Byte formatter
│   │   ├── internal-initiator-marker.ts
│   │   ├── jsonc-parser.ts     # JSONC config file parser
│   │   ├── logger.ts           # log() function
│   │   ├── model-suggestion-retry.ts
│   │   ├── normalize-sdk-response.ts
│   │   ├── opencode-compaction-detector.ts # Detect OpenCode's built-in compaction
│   │   ├── opencode-config-dir.ts
│   │   ├── opencode-config-dir-types.ts
│   │   ├── record-type-guard.ts
│   │   └── system-directive.ts
│   └── tools/                  # LLM-callable tools
│       ├── index.ts            # Re-export barrel
│       ├── ctx-reduce/         # ctx_reduce: queue tag drops
│       ├── ctx-expand/         # ctx_expand: restore compartment detail
│       ├── ctx-note/           # ctx_note: write/read session notes
│       ├── ctx-recall/         # ctx_recall: semantic search over memories
│       ├── ctx-memory/         # ctx_memory: CRUD for cross-session memories
│       └── look-at/            # look-at: extract content from assistant messages
├── dist/                       # Compiled output (mirrors src/ structure)
├── docs/                       # Design documents
│   ├── MAGIC-CONTEXT-DESIGN.md
│   └── MEMORY-DESIGN.md
├── scripts/                    # Utility scripts
│   └── context-dump/
├── ARCHITECTURE.md             # Detailed transform pipeline documentation
├── CONFIGURATION.md            # User-facing config reference
├── README.md
├── package.json
├── tsconfig.json               # Main TS config (src/ → dist/)
├── tsconfig.scripts.json       # Separate TS config for scripts/
└── biome.json                  # Linter/formatter config
```

## Directory Purposes

**`src/agents/`:**
- Purpose: Agent-related constants and system prompts
- Contains: `historian.ts` (exports `HISTORIAN_AGENT = "historian"`), `magic-context-prompt.ts` (exports `COMPARTMENT_AGENT_SYSTEM_PROMPT`)

**`src/config/`:**
- Purpose: Plugin configuration loading and validation
- Contains: Zod schema for all config options, JSONC file loader, user+project config merging
- Key files: `src/config/index.ts` (public API), `src/config/schema/magic-context.ts` (full schema + defaults)

**`src/features/magic-context/`:**
- Purpose: All domain logic that doesn't depend on OpenCode's hook API; pure functions and DB operations
- Contains: SQLite schema and CRUD functions, `Tagger`, `Scheduler`, memory system, dreamer, sidekick, types
- Key files: `storage-db.ts` (DB init + path), `tagger.ts`, `scheduler.ts`, `storage.ts` (re-export barrel)

**`src/features/magic-context/memory/`:**
- Purpose: Cross-session vector memory: embedding, FTS search, storage, and memory promotion from session facts
- Key files: `embedding-provider.ts` (interface), `embedding-local.ts` (HuggingFace), `embedding-openai.ts`, `storage-memory.ts` (CRUD), `promotion.ts` (fact→memory), `storage-memory-fts.ts` (FTS5 search)

**`src/features/magic-context/dreamer/`:**
- Purpose: Background tasks that consolidate and decay memories over time (runs between sessions)
- Key files: `runner.ts` (lease-protected orchestrator), `task-consolidate.ts`, `task-decay.ts`, `lease.ts`

**`src/features/magic-context/sidekick/`:**
- Purpose: Optional external LLM sidecar that augments user prompts with project memory context before they reach the main model
- Key files: `agent.ts` (run sidekick), `client.ts` (OpenAI-compatible HTTP client)

**`src/hooks/magic-context/`:**
- Purpose: OpenCode hook implementations — the transform pipeline, event handler, nudger, command handler, and all supporting functions
- Contains: ~90 TypeScript files comprising the full feature implementation
- Key files: `hook.ts` (factory), `transform.ts` (Phase 1), `transform-postprocess-phase.ts` (Phase 2), `event-handler.ts`, `compartment-runner.ts`

**`src/plugin/`:**
- Purpose: Thin adapter wiring between the OpenCode plugin API and the hook implementations
- Key files: `tool-registry.ts` (register all LLM tools), `hooks/create-session-hooks.ts` (create Tagger/Scheduler/CompactionHandler and wire to hook factory)

**`src/tools/`:**
- Purpose: LLM-callable tool definitions (each subdirectory = one tool)
- Tool contract: Each tool has `constants.ts` (description string), `types.ts` (arg interfaces), `tools.ts` (factory returning `ToolDefinition`), `index.ts` (re-export)

**`src/shared/`:**
- Purpose: Utilities with zero domain dependencies; safe to import from any layer

---

## Key File Locations

**Entry Points:**
- `src/index.ts`: Plugin factory — everything starts here
- `src/plugin/hooks/create-session-hooks.ts`: Creates Tagger, Scheduler, CompactionHandler
- `src/hooks/magic-context/hook.ts`: `createMagicContextHook()` — creates all hook handlers and shared state

**Configuration:**
- `src/config/index.ts`: `loadPluginConfig()` — reads `.opencode/magic-context.json` or `magic-context.jsonc`
- `src/config/schema/magic-context.ts`: Full Zod schema + default values for all config options

**Core Pipeline:**
- `src/hooks/magic-context/transform.ts`: Phase 1 entry point for message transform
- `src/hooks/magic-context/transform-postprocess-phase.ts`: Phase 2 — mutations, cleanup, injection, nudge
- `src/hooks/magic-context/transform-operations.ts`: `tagMessages()`, `stripStructuralNoise()`, `applyFlushedStatuses()`
- `src/hooks/magic-context/apply-operations.ts`: `applyPendingOperations()` — executes queued drops

**Storage:**
- `src/features/magic-context/storage-db.ts`: SQLite schema, `openDatabase()`, DB path resolution
- `src/features/magic-context/storage.ts`: Re-export barrel for all DB operations
- DB location at runtime: `~/.local/share/opencode/storage/plugin/magic-context/context.db`

**Testing:**
- `src/features/magic-context/*.test.ts`: Unit tests for domain logic (storage, scheduler, tagger, range-parser)
- `src/hooks/magic-context/*.test.ts`: Integration-level tests for hook behaviors (transform, nudger, compartment runner)

---

## Naming Conventions

**Files:**
- Kebab-case for all source files: `storage-db.ts`, `apply-operations.ts`
- `*.test.ts` suffix for test files, co-located with source
- `index.ts` as barrel/re-export for each tool subdirectory
- `storage-{area}.ts` for SQLite storage modules (e.g., `storage-tags.ts`, `storage-meta.ts`)
- `transform-{concern}.ts` for transform pipeline sub-modules

**Directories:**
- Kebab-case: `magic-context/`, `ctx-reduce/`, `dreamer/`
- Feature grouped under `features/magic-context/`; hook implementations under `hooks/magic-context/`

---

## Where to Add New Code

**New OpenCode hook behavior:**
- Primary code: `src/hooks/magic-context/` — add new `{feature}.ts` file
- Wire into hook: register in `src/hooks/magic-context/hook.ts` → `createMagicContextHook()`
- If it needs per-session state, add to the in-memory Maps in `hook.ts`

**New LLM-callable tool:**
- Create directory: `src/tools/ctx-{name}/`
- Files: `constants.ts` (description), `types.ts` (arg types), `tools.ts` (factory), `index.ts` (barrel)
- Register: add to `src/plugin/tool-registry.ts` → `createToolRegistry()`
- Re-export: add to `src/tools/index.ts`

**New storage table:**
- Schema: add `CREATE TABLE IF NOT EXISTS` to `src/features/magic-context/storage-db.ts` → `initializeDatabase()`
- Add migrations via `ensureColumn()` for additive changes to existing tables
- Create `storage-{area}.ts` in `src/features/magic-context/` with typed CRUD functions
- Re-export from `src/features/magic-context/storage.ts`

**New transform pipeline step:**
- For Phase 1 (before mutations): add to `src/hooks/magic-context/transform.ts`
- For Phase 2 (after mutations): add to `src/hooks/magic-context/transform-postprocess-phase.ts`
- Extract complex logic to its own `src/hooks/magic-context/{step}.ts` file

**New config option:**
- Schema: add to `src/config/schema/magic-context.ts` Zod schema
- Type: add to `MagicContextDeps.config` interface in `src/hooks/magic-context/hook.ts`
- Wire: pass through `src/plugin/hooks/create-session-hooks.ts`

**Shared utilities:**
- Domain-free helpers → `src/shared/`
- Memory subsystem helpers → `src/features/magic-context/memory/`

---

## Special Directories

**`dist/`:**
- Purpose: Compiled JavaScript output from `bun build`; mirrors `src/` structure
- Generated: Yes (`bun run build`)
- Committed: Yes (for npm publication)

**`.opencode/`:**
- Purpose: Project-level plugin config for the local development environment
- Generated: No
- Committed: No (gitignored)

**`.planning/`:**
- Purpose: GSD planning documents
- Generated: Partially
- Committed: Selectively

**`scripts/context-dump/`:**
- Purpose: Utility scripts for development/debugging; compiled with separate `tsconfig.scripts.json`
- Generated: No

---

*Structure analysis: 2026-03-23*
