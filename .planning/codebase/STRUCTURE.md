# Codebase Structure

**Analysis Date:** 2026-03-25

## Directory Layout

```
[project-root]/
├── src/                         # Plugin source code (TypeScript)
│   ├── index.ts                 # Plugin entry point — wires everything together
│   ├── agents/                  # Hidden agent identifiers and prompt text
│   ├── cli/                     # CLI utilities (unused at runtime)
│   ├── config/                  # Config loader and Zod schemas
│   │   └── schema/              # Individual schema files
│   ├── features/                # Stateful feature services
│   │   ├── builtin-commands/    # Slash command definitions
│   │   └── magic-context/       # Core subsystems
│   │       ├── dreamer/         # Background maintenance agent subsystem
│   │       ├── memory/          # Cross-session memory store and embeddings
│   │       └── sidekick/        # Prompt-augmentation agent subsystem
│   ├── hooks/                   # Hook implementations
│   │   ├── auto-slash-command/  # Auto-slash-command hook helpers
│   │   └── magic-context/       # Main runtime hook — transform, events, commands
│   ├── plugin/                  # OpenCode plugin adapter layer
│   │   └── hooks/               # Per-session hook factory
│   ├── shared/                  # Cross-feature utilities
│   └── tools/                   # Agent-facing tool definitions
│       ├── ctx-expand/          # ctx_expand tool
│       ├── ctx-memory/          # ctx_memory tool
│       ├── ctx-note/            # ctx_note tool
│       ├── ctx-reduce/          # ctx_reduce tool
│       └── look-at/             # Internal message extractor utility
├── scripts/                     # Local maintenance and debug scripts
│   └── context-dump/            # Dump scripts
├── docs/                        # Subsystem design references
├── dist/                        # Build output (`bun run build`)
├── .github/workflows/           # CI and release automation
├── biome.json                   # Linting and formatting config
├── tsconfig.json                # TypeScript config (src/)
├── tsconfig.scripts.json        # TypeScript config (scripts/)
├── package.json                 # Package metadata and Bun scripts
├── ARCHITECTURE.md              # Architecture reference (root)
├── STRUCTURE.md                 # Structure reference (root)
├── CONFIGURATION.md             # Config key reference for magic-context.jsonc
└── README.md                    # Package overview and usage guide
```

## Directory Purposes

**`src/`:**
- Purpose: All runtime, tool, config, and integration code.
- Contains: TypeScript source files and co-located `*.test.ts` files.
- Key files: `src/index.ts`, `src/plugin/tool-registry.ts`, `src/hooks/magic-context/hook.ts`

**`src/agents/`:**
- Purpose: Define hidden-agent identifiers and shared prompt helpers. Keep agent identity isolated from wiring.
- Contains: Agent-name string constants and prompt-building functions.
- Key files:
  - `src/agents/dreamer.ts` — exports `DREAMER_AGENT = "dreamer"`
  - `src/agents/historian.ts` — exports `HISTORIAN_AGENT`
  - `src/agents/sidekick.ts` — exports `SIDEKICK_AGENT`
  - `src/agents/magic-context-prompt.ts` — system prompt for the historian/compartment agent

**`src/config/`:**
- Purpose: Parse and validate plugin configuration from JSONC files.
- Contains: Config loader, re-exports, and Zod schemas.
- Key files:
  - `src/config/index.ts` — `loadPluginConfig(directory)` merges user + project configs
  - `src/config/schema/magic-context.ts` — `MagicContextConfigSchema` with all defaults
  - `src/config/schema/agent-overrides.ts` — per-agent model override schema
  - `src/config/schema.ts` — barrel re-export

**`src/plugin/`:**
- Purpose: Thin adapters from OpenCode plugin interfaces to internal services.
- Contains: Hook wrappers, tool registry setup, plugin context type, schema normalization.
- Key files:
  - `src/plugin/tool-registry.ts` — `createToolRegistry()` gates and exposes tools
  - `src/plugin/messages-transform.ts` — `createMessagesTransformHandler()` delegates to the magic-context hook
  - `src/plugin/event.ts` — `createEventHandler()` thin passthrough
  - `src/plugin/hooks/create-session-hooks.ts` — `createSessionHooks()` instantiates tagger, scheduler, compaction handler, and the main hook
  - `src/plugin/hooks/create-tag-content-resolver.ts` — helper for resolving tag content from storage
  - `src/plugin/normalize-tool-arg-schemas.ts` — patches `.describe()` text into JSON Schema
  - `src/plugin/types.ts` — `PluginContext` type alias

**`src/hooks/`:**
- Purpose: Hold hook implementations and hook-specific helpers.
- Contains: The `magic-context` runtime (the largest module) and auxiliary hooks.
- Key files in `src/hooks/magic-context/`:
  - `hook.ts` — `createMagicContextHook()` composition root; owns all in-memory per-instance state
  - `hook-handlers.ts` — individual hook handler factories composed by `hook.ts`
  - `transform.ts` — `createTransform()` pipeline entry; orchestrates tagging, compartment phase, postprocess phase
  - `transform-postprocess-phase.ts` — applies pending ops, heuristic cleanup, nudges, memory injection
  - `transform-compartment-phase.ts` — decides when to start/await compartment runs
  - `transform-operations.ts` — `tagMessages()`, `applyFlushedStatuses()`, `stripStructuralNoise()`, `applyPendingOperations()`
  - `event-handler.ts` — `createEventHandler()` processes session/message lifecycle events
  - `command-handler.ts` — `createMagicContextCommandHandler()` handles all `/ctx-*` commands
  - `compartment-runner.ts` — promise registry; `startCompartmentAgent()`, `executeContextRecomp()`
  - `compartment-runner-incremental.ts` — incremental historian run (spawns child session)
  - `compartment-runner-recomp.ts` — `/ctx-recomp` full recomputation pass
  - `compartment-runner-historian.ts` — shared historian prompt and runner logic
  - `inject-compartments.ts` — `prepareCompartmentInjection()`, `renderMemoryBlock()`
  - `nudger.ts` — `createNudger()` computes context-pressure nudge text
  - `note-nudger.ts` — session-note nudge triggered by events (e.g., commit detection)
  - `nudge-injection.ts` — appends nudge text to assistant messages
  - `nudge-placement-store.ts` — SQLite-backed nudge anchor persistence
  - `heuristic-cleanup.ts` — drops old tool outputs and clears reasoning by age
  - `apply-operations.ts` — applies drop/compact ops to the message array
  - `read-session-chunk.ts` — reads raw session messages via OpenCode SDK (used by `ctx_expand`)
  - `system-prompt-hash.ts` — detects system-prompt changes that invalidate anchors
  - `send-session-notification.ts` — sends hidden or user-visible session messages
- Key file in `src/hooks/auto-slash-command/`:
  - `constants.ts` — shared constant for the auto-slash-command hook

**`src/features/magic-context/`:**
- Purpose: Reusable stateful services for all magic-context functionality.
- Contains: Storage, tagger, scheduler, compaction, memory, dreamer, sidekick, compartment storage.
- Key files:
  - `storage-db.ts` — `openDatabase()`, `initializeDatabase()`, `isDatabasePersisted()` — creates and caches the shared SQLite database
  - `storage.ts` — high-level CRUD helpers over all tables (tags, pending ops, session meta, compartments, notes)
  - `storage-tags.ts` — tag-specific queries
  - `storage-ops.ts` — pending-op queries
  - `storage-meta.ts` — session-meta queries
  - `storage-meta-persisted.ts`, `storage-meta-session.ts`, `storage-meta-shared.ts` — meta sub-modules
  - `storage-source.ts` — source-content queries
  - `storage-notes.ts` — session-notes queries
  - `compartment-storage.ts` — compartment and session-fact queries, `buildCompartmentBlock()`
  - `tagger.ts` — `createTagger()` — in-memory + SQLite tag assignment
  - `scheduler.ts` — `createScheduler()` — decides when to execute pending ops
  - `compaction.ts` — `createCompactionHandler()` — marks tags as compacted on external compaction
  - `range-parser.ts` — parses `"3-5,1,2,9"` range strings (used by `ctx_reduce`)
  - `defaults.ts` — `DEFAULT_PROTECTED_TAGS`
  - `types.ts` — shared types (`TagEntry`, `SessionMeta`, `ContextUsage`, `SchedulerDecision`)
  - `mock-database.ts` — test helper for in-memory databases
- Dreamer subsystem (`src/features/magic-context/dreamer/`):
  - `runner.ts` — `runDream()`, `processDreamQueue()` — orchestrate child-session task runs
  - `scheduler.ts` — `checkScheduleAndEnqueue()` — cron-style schedule evaluation
  - `queue.ts` — `enqueueNext()`, `dequeueNext()`, `clearStaleEntries()`
  - `lease.ts` — `acquireLease()`, `renewLease()`, `releaseLease()` — cooperative SQLite lock
  - `storage-dream-state.ts` — `getDreamState()`, `setDreamState()`
  - `task-prompts.ts` — `buildDreamTaskPrompt()`, `DREAMER_SYSTEM_PROMPT`
  - `index.ts` — barrel re-export
- Memory subsystem (`src/features/magic-context/memory/`):
  - `storage-memory.ts` — `insertMemory()`, `updateMemoryContent()`, `getMemoriesByProject()`, etc.
  - `storage-memory-fts.ts` — `searchMemoriesFTS()` — BM25 full-text search
  - `storage-memory-embeddings.ts` — `saveEmbedding()`, `loadAllEmbeddings()`
  - `embedding.ts` — `embedText()`, `isEmbeddingEnabled()`, `getEmbeddingModelId()`
  - `embedding-local.ts` — local model via `@huggingface/transformers`
  - `embedding-openai.ts` — OpenAI embedding API
  - `embedding-provider.ts` — provider selector
  - `embedding-backfill.ts` — backfill script helper
  - `cosine-similarity.ts` — `cosineSimilarity()` for vector re-ranking
  - `normalize-hash.ts` — `computeNormalizedHash()` — deduplication hash for memory content
  - `project-identity.ts` — `resolveProjectIdentity()` — canonical project path key
  - `promotion.ts` — memory promotion logic (used by historian)
  - `constants.ts` — `CATEGORY_PRIORITY` ordering for memory categories
  - `types.ts` — `Memory`, `MemoryCategory`, etc.
  - `index.ts` — barrel re-export
- Sidekick subsystem (`src/features/magic-context/sidekick/`):
  - `agent.ts` — `runSidekick()`, `SIDEKICK_SYSTEM_PROMPT`
  - `index.ts` — barrel re-export
- Built-in commands (`src/features/builtin-commands/`):
  - `commands.ts` — `getMagicContextBuiltinCommands()` returns config map for `/ctx-status`, `/ctx-recomp`, `/ctx-flush`, `/ctx-aug`, `/ctx-dream`
  - `types.ts` — `BuiltinCommandConfig` type

**`src/tools/`:**
- Purpose: Agent-facing tool surface, one directory per tool.
- Contains: constants, types, implementation (`tools.ts`), and tests.
- Key files:
  - `src/tools/ctx-reduce/tools.ts` — `createCtxReduceTools()` — queues drop ops in SQLite
  - `src/tools/ctx-expand/tools.ts` — `createCtxExpandTools()` — reads a compartment range from session history
  - `src/tools/ctx-note/tools.ts` — `createCtxNoteTools()` — appends and reads session notes in SQLite
  - `src/tools/ctx-memory/tools.ts` — `createCtxMemoryTools()` — full memory CRUD + hybrid search
  - `src/tools/look-at/assistant-message-extractor.ts` — `extractLatestAssistantText()` — internal helper used by dreamer/sidekick runners
  - `src/tools/index.ts` — barrel re-export of all tool factories

**`src/shared/`:**
- Purpose: Cross-feature utilities with minimal dependencies.
- Contains: Logger, path helpers, JSONC parser, model helpers, SDK normalization, compaction detector.
- Key files:
  - `src/shared/logger.ts` — `log()`, `sessionLog()`, `getLogFilePath()` — buffered file logger
  - `src/shared/data-path.ts` — `getOpenCodeStorageDir()` — resolves `~/.local/share/opencode/storage`
  - `src/shared/jsonc-parser.ts` — `parseJsonc()`, `detectConfigFile()`, `readJsoncFile()`
  - `src/shared/model-requirements.ts` — `getAgentFallbackModels()` — fallback model lists per agent
  - `src/shared/model-suggestion-retry.ts` — `promptSyncWithModelSuggestionRetry()` — wraps `client.session.chat` with retries
  - `src/shared/normalize-sdk-response.ts` — `normalizeSDKResponse()` — handles SDK v1/v2 shape differences
  - `src/shared/opencode-compaction-detector.ts` — `isOpenCodeAutoCompactionEnabled()` — reads OpenCode config files
  - `src/shared/opencode-config-dir.ts` — `getOpenCodeConfigPaths()` — resolves platform config directories
  - `src/shared/system-directive.ts` — shared system directive text for hidden agents
  - `src/shared/internal-initiator-marker.ts` — marker constant to identify OMO-internal messages
  - `src/shared/index.ts` — barrel re-export

**`scripts/`:**
- Purpose: Local inspection and maintenance outside the plugin runtime (not shipped to `dist/`).
- Contains: Bun scripts for dumps, tails, embedding backfill, semantic-search testing, and version sync.
- Key files: `scripts/context-dump.ts`, `scripts/context-dump/`, various `scripts/*.ts` files.

**`docs/`:**
- Purpose: Long-lived subsystem design references.
- Contains: Design documents that describe intent and decisions.
- Key files: `docs/MAGIC-CONTEXT-DESIGN.md`, `docs/MEMORY-DESIGN.md`.

**`dist/`:**
- Purpose: Bun build output — the file OpenCode actually loads.
- Contains: Flat tree mirroring `src/` but compiled to ESM; `index.js` and `index.d.ts` are the published entry points.
- Generated: Yes. Not committed to git.

## Key File Locations

**Entry Points:**
- `src/index.ts` — plugin factory, self-disable guard, hidden agent + command registration.

**Configuration:**
- `src/config/index.ts` — `loadPluginConfig(directory)` — three-tier merge (user → project root → `.opencode/`).
- `src/config/schema/magic-context.ts` — all config keys with defaults and Zod schema.

**Core Logic:**
- `src/hooks/magic-context/hook.ts` — composition root, owns all runtime state.
- `src/hooks/magic-context/transform.ts` — per-turn message transform pipeline.
- `src/hooks/magic-context/transform-postprocess-phase.ts` — mutation phase (drop ops, nudges, memory).
- `src/features/magic-context/storage-db.ts` — SQLite schema definition and database singleton.
- `src/features/magic-context/storage.ts` — high-level storage API.

**Tests:**
- Co-located with source as `src/**/*.test.ts`.
- Examples: `src/hooks/magic-context/hook.test.ts`, `src/tools/ctx-memory/tools.test.ts`, `src/features/magic-context/storage-db.test.ts`, `src/features/magic-context/tagger.test.ts`.

## Naming Conventions

**Files:** kebab-case for multi-word modules; `index.ts` for barrel exports or package entry.
- Examples: `transform-postprocess-phase.ts`, `storage-memory-embeddings.ts`, `compartment-runner-incremental.ts`

**Directories:** Group by feature first, then by tool or subsystem name.
- Examples: `src/features/magic-context/dreamer/`, `src/tools/ctx-memory/`, `src/hooks/magic-context/`

**Modules with tests:** test file is always `[module-name].test.ts` beside the implementation.

## Where to Add New Code

**New OpenCode hook adapter:**
- Add the adapter file in `src/plugin/`.
- Keep runtime logic in `src/hooks/magic-context/`.
- Wire it through the returned object in `src/index.ts`.

**New transform step or event helper:**
- Add under `src/hooks/magic-context/`.
- Wire through `src/hooks/magic-context/hook.ts` (for stateful steps) or `transform.ts`/`transform-postprocess-phase.ts` (for pipeline steps).

**New agent-facing tool:**
- Create `src/tools/[tool-name]/` with `constants.ts`, `types.ts`, `tools.ts`, `index.ts`.
- Export the factory from `src/tools/index.ts`.
- Register in `src/plugin/tool-registry.ts`.

**New built-in slash command:**
- Add the command entry in `src/features/builtin-commands/commands.ts`.
- Handle execution in `src/hooks/magic-context/command-handler.ts`.

**New feature service:**
- Multi-file features: add a subdirectory under `src/features/magic-context/[feature-area]/` with an `index.ts` barrel.
- Single-file features: add as `src/features/magic-context/[feature-name].ts`.

**New hidden agent:**
- Add `src/agents/[agent-name].ts` with the agent ID constant.
- Add the system prompt near the owning feature (e.g., `src/features/magic-context/[feature]/task-prompts.ts`).
- Register in `src/index.ts` inside the `config` hook using `buildHiddenAgentConfig()`.

**New shared utility:**
- Add to `src/shared/` only when at least two distinct subsystems need it.
- Export from `src/shared/index.ts` if broadly used.

**Tests:**
- Add a co-located `*.test.ts` file beside the implementation file being changed.
- Use `src/features/magic-context/mock-database.ts` for any test needing an in-memory SQLite database.

## Special Directories

**`dist/`:**
- Purpose: Compiled ESM output consumed by OpenCode.
- Generated: Yes (`bun run build`).
- Committed: No.

**`scripts/`:**
- Purpose: Developer scripts for local debugging and maintenance.
- Generated: No (hand-written).
- Committed: Yes.
- Not included in npm `files`; never shipped to users.

**`.opencode/`:**
- Purpose: Local OpenCode configuration and plugin state dumps.
- Generated: Partially (dumps by scripts, `node_modules` by OpenCode internals).
- Committed: No (`.gitignore`d except possibly JSONC config files if manually added).

**`.planning/`:**
- Purpose: GSD planning artifacts (phase plans, codebase analysis docs).
- Generated: Yes (by planning tools).
- Committed: Optional per project conventions.

---

*Structure analysis: 2026-03-25*
