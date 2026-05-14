# Codebase Structure

> All paths below are relative to `packages/plugin/` — the published npm package.

## Key-files v6 locations

- `packages/plugin/src/features/magic-context/key-files/project-key-files.ts` — project-scoped storage helpers, version helpers, orphan GC, hashing.
- `packages/plugin/src/features/magic-context/key-files/read-history.ts` — primary-session read aggregation and range coalescing.
- `packages/plugin/src/features/magic-context/key-files/identify-key-files.ts` — Dreamer prompt, validator, and atomic commit path.
- `packages/plugin/src/features/magic-context/key-files/aft-availability.ts` — OpenCode/Pi AFT configuration detection.
- `packages/plugin/src/hooks/magic-context/key-files-block.ts` — versioned injection cache and stale-update flushing shared by OpenCode and Pi.
- `packages/dashboard/src/components/SessionViewer/SessionViewer.tsx` — read-only key-files panel in session detail.

## Directory Layout

```text
[project-root]/
├── src/                    # Plugin source code
├── scripts/                # Local maintenance and debugging scripts
├── docs/                   # Design references for major subsystems
├── dist/                   # Build output from `bun run build`
├── .github/workflows/      # CI and release automation
├── README.md               # Package overview and usage guide
├── CONFIGURATION.md        # Config reference for `magic-context.jsonc`
└── package.json            # Package metadata and Bun scripts
```

## Directory Purposes

**`src/`:**
- Purpose: Keep all runtime, tool, config, and integration code.
- Contains: TypeScript source files and co-located `*.test.ts` files.
- Key files: `src/index.ts`, `src/plugin/tool-registry.ts`, `src/hooks/magic-context/hook.ts`

**CLI (lives in a sibling package):**
- Purpose: Provide the unified, harness-aware setup/doctor wizard for OpenCode and Pi.
- Location: `packages/cli/src/` — published as `@cortexkit/magic-context`. Invoked as `npx @cortexkit/magic-context@latest <subcommand>`.
- Contains: Command implementations (`packages/cli/src/commands/`), per-harness adapters (`packages/cli/src/adapters/`), shared prompt/path utilities (`packages/cli/src/lib/`).
- History: prior to v0.16.1 each plugin shipped its own `opencode-magic-context` / `pi-magic-context` bin. Those were collapsed into the unified `magic-context` bin; this `packages/plugin/` tree no longer contains a `src/cli/` directory.

**`src/agents/`:**
- Purpose: Define hidden agent identifiers and shared agent prompt helpers.
- Contains: Agent-name constants and prompt-building helpers.
- Key files: `src/agents/dreamer.ts`, `src/agents/historian.ts` (declares `HISTORIAN_AGENT` and `HISTORIAN_EDITOR_AGENT`), `src/agents/sidekick.ts`, `src/agents/magic-context-prompt.ts`

**`src/config/`:**
- Purpose: Parse and validate plugin configuration.
- Contains: Config loaders, re-exports, and Zod schemas.
- Key files: `src/config/index.ts`, `src/config/schema/magic-context.ts`, `src/config/schema/agent-overrides.ts`

**`src/plugin/`:**
- Purpose: Adapt internal services to OpenCode plugin interfaces.
- Contains: Hook wrappers, tool registry setup, RPC handlers, dream-timer lifecycle, conflict-warning delivery, per-session hook construction.
- Key files: `src/plugin/messages-transform.ts`, `src/plugin/event.ts`, `src/plugin/tool-registry.ts`, `src/plugin/hooks/create-session-hooks.ts`, `src/plugin/rpc-handlers.ts`, `src/plugin/dream-timer.ts`, `src/plugin/conflict-warning-hook.ts`

**`src/hooks/`:**
- Purpose: Hold hook implementations and hook-specific helpers.
- Contains: The `magic-context` runtime, the auto-update checker, and small shared hook helpers like `is-anthropic-provider.ts`.
- Key files: `src/hooks/magic-context/hook.ts`, `src/hooks/magic-context/transform.ts`, `src/hooks/magic-context/transform-postprocess-phase.ts`, `src/hooks/magic-context/strip-content.ts`, `src/hooks/auto-update-checker/checker.ts`

**`src/tui/`:**
- Purpose: Render Magic Context sidebar and `/ctx-status` / `/ctx-recomp` dialogs inside OpenCode's TUI.
- Contains: TUI entrypoint, sidebar slot composition, RPC-backed data layer, type declarations.
- Key files: `src/tui/index.tsx` (registered via `./tui` export in `package.json`), `src/tui/slots/`, `src/tui/data/`, `src/tui/types/`
- Notes: Ships as raw TypeScript source, not bundled into `dist/index.js`. Loaded by OpenCode TUI via `tui.json` configuration.

**`src/features/`:**
- Purpose: Group reusable subsystem logic by feature.
- Contains: Magic-context services (storage, scheduler, tagger, search, message-index, overflow detection, compaction markers), dreamer runtime, sidekick support, memory system, user-memory pipeline, key-files pinning, git-commit indexer, tool-definition token measurement, schema migrations, built-in commands.
- Key subdirs: `src/features/magic-context/dreamer/`, `src/features/magic-context/memory/`, `src/features/magic-context/sidekick/`, `src/features/magic-context/user-memory/`, `src/features/magic-context/key-files/`, `src/features/magic-context/git-commits/`, `src/features/builtin-commands/`
- Key files: `src/features/magic-context/storage-db.ts`, `src/features/magic-context/storage.ts` (barrel), `src/features/magic-context/migrations.ts`, `src/features/magic-context/message-index.ts`, `src/features/magic-context/search.ts`, `src/features/magic-context/overflow-detection.ts`, `src/features/magic-context/dreamer/runner.ts`, `src/features/magic-context/memory/storage-memory.ts`, `src/features/magic-context/user-memory/storage-user-memory.ts`, `src/features/builtin-commands/commands.ts`

**`src/tools/`:**
- Purpose: Define the agent-facing tool surface.
- Contains: One directory per tool with constants, types, implementation, and tests. Five tools: `ctx-reduce`, `ctx-expand`, `ctx-note`, `ctx-memory`, `ctx-search`.
- Key files: `src/tools/ctx-reduce/tools.ts`, `src/tools/ctx-expand/tools.ts`, `src/tools/ctx-note/tools.ts`, `src/tools/ctx-memory/tools.ts`, `src/tools/ctx-search/tools.ts`

**`src/shared/`:**
- Purpose: Keep cross-feature utilities small and dependency-light.
- Contains: Logging, path helpers, JSONC parsing, model helpers, runtime-detected SQLite backend, Electron native-binding resolver, harness identification, RPC server/client/types/utils/notifications, conflict detection & fixer, OpenCode compaction detector, fallback chain resolver, models.dev cache, tag-transcript primitive shared with Pi, model-suggestion-retry helper, subagent runner (Pi-only).
- Key files: `src/shared/logger.ts`, `src/shared/data-path.ts`, `src/shared/jsonc-parser.ts`, `src/shared/sqlite.ts`, `src/shared/native-binding.ts`, `src/shared/rpc-server.ts`, `src/shared/rpc-client.ts`, `src/shared/conflict-detector.ts`, `src/shared/model-suggestion-retry.ts`, `src/shared/resolve-fallbacks.ts`, `src/shared/harness.ts`, `src/shared/tag-transcript.ts`

**`scripts/`:**
- Purpose: Support local inspection and maintenance outside the plugin runtime.
- Contains: Bun scripts for dumps, tails, embedding backfill, semantic-search testing, schema generation, calibration, benchmarking, and version sync.
- Key files: `scripts/context-dump.ts`, `scripts/tail-view.ts`, `scripts/backfill-embeddings.ts`, `scripts/build-schema.ts`, `scripts/benchmark-tag-queries.ts`, `scripts/benchmark-message-fts.ts`

**`docs/`:**
- Purpose: Keep longer-lived subsystem design references and animation assets separate from root operational docs.
- Contains: `MEMORY-DESIGN.md` (memory subsystem design notes), plus `animation*/` subdirectories holding Remotion projects and renders for the README animation, and `archive/` for retired design documents.
- Key files: `docs/MEMORY-DESIGN.md`, `docs/animation/`

## Key File Locations

**Entry Points:**
- `src/index.ts`: Register the plugin, hidden agents (`historian`, `historian-editor`, `dreamer`, `sidekick`), hooks, commands, tools, RPC server, dream-schedule timer, and the auto-update checker.
- `src/tui/index.tsx`: Register TUI command-palette entries and the sidebar slot for OpenCode TUI.
- `packages/cli/src/index.ts`: Unified setup/doctor/migrate entry for the separate `@cortexkit/magic-context` package.

**Configuration:**
- `src/config/index.ts`: Load and merge config files with field-level fallback for invalid leaves; collect warnings rather than disable the plugin.
- `src/config/schema/magic-context.ts`: Define defaults and schema rules.
- `src/config/schema/agent-overrides.ts`: Define overridable built-in agents.
- `assets/magic-context.schema.json`: Generated JSON schema, kept in sync via `scripts/build-schema.ts` and `scripts/release.sh`.

**Core Logic:**
- `src/hooks/magic-context/transform.ts`: Run the turn transform; orchestrate tagging, replay paths, prepareCompartmentInjection, and downstream postprocess hand-off.
- `src/hooks/magic-context/transform-postprocess-phase.ts`: Apply pending ops, heuristic cleanup, deferred-note nudges, **synthetic-todowrite injection (B7)**, and auto-search hints.
- `src/hooks/magic-context/hook.ts`: Compose runtime services.
- `src/hooks/magic-context/strip-content.ts`: Strip and replay reasoning, inline thinking, structural noise, dropped placeholders, merged-assistant reasoning, processed images, and system-injected messages.
- `src/hooks/magic-context/caveman.ts`: Experimental age-tier text compression for primary sessions with `ctx_reduce_enabled=false`.
- `src/hooks/magic-context/todo-view.ts`: Build the deterministic synthetic todowrite tool part and compute its hash-based `call_id`.
- `src/features/magic-context/storage-db.ts`: Create durable storage; run versioned migrations; resolve runtime SQLite backend.
- `src/features/magic-context/storage-meta-persisted.ts`: Read and write per-session persisted scalars and JSON blobs.
- `src/features/magic-context/migrations.ts`: Versioned schema migrations v1–v13.
- `src/features/magic-context/message-index.ts`: FTS-backed raw-message index for `ctx_search`.
- `src/features/magic-context/search.ts`: Unified retrieval over memories, raw messages, and git commits.

**Tests:** Co-locate tests with source as `src/**/*.test.ts`, for example `src/hooks/magic-context/hook.test.ts`, `src/tools/ctx-memory/tools.test.ts`, and `src/features/magic-context/migrations-v11.test.ts`. End-to-end coverage lives in the separate `packages/e2e-tests/` workspace.

## Naming Conventions

**Files:** Use kebab-case for multiword module files and reserve `index.ts` for barrel exports or package entry modules: `transform-postprocess-phase.ts`, `storage-memory.ts`, `compartment-runner-historian.ts`, `index.ts`.

**Test co-location:** Test files use the `.test.ts` suffix and sit next to the source they cover. Migration tests use a `migrations-v<N>.test.ts` convention.

**Directories:** Group by feature first, then by tool or subsystem name: `src/features/magic-context/dreamer/`, `src/features/magic-context/key-files/`, `src/tools/ctx-memory/`, `src/hooks/magic-context/`.

## Where to Add New Code

**New CLI command:** add it in `packages/cli/src/commands/` (the unified `@cortexkit/magic-context` package) and wire it from `packages/cli/src/index.ts`.

**New OpenCode hook adapter:** add the adapter in `src/plugin/` and keep the runtime logic in `src/hooks/magic-context/`.

**New magic-context transform or event helper:** add it under `src/hooks/magic-context/` and wire it through `src/hooks/magic-context/hook.ts`.

**New tool:** add `src/tools/[tool-name]/`, export it from the tool entry, and register it in `src/plugin/tool-registry.ts`. Remember to wire conditional schema narrowing for primary-vs-dreamer-only actions inside `tools.ts` if the tool has restricted actions.

**New built-in slash command:** add the command definition in `src/features/builtin-commands/commands.ts` and handle execution in `src/hooks/magic-context/command-handler.ts`. If the command needs a native TUI dialog, also push a notification via `pushNotification()` in `src/plugin/rpc-handlers.ts` and consume it in `src/tui/index.tsx`.

**New feature service:** add it under `src/features/magic-context/[feature-area]/` (preferred for cohesive subsystems like the message index, git-commits, key-files, user-memory) or as a focused single-file module under `src/features/magic-context/` when it stays small.

**New hidden agent:** add the agent constant in `src/agents/[agent-name].ts`, add prompt text near the owning feature (e.g. `src/features/magic-context/dreamer/task-prompts.ts`, `src/hooks/magic-context/compartment-prompt.ts`), and register it from `src/index.ts` via `buildHiddenAgentConfig`.

**New schema migration:** add a new versioned entry in `src/features/magic-context/migrations.ts` (next version number after the current highest) and add a co-located `migrations-v<N>.test.ts`. Update the fresh-DB schema in `src/features/magic-context/storage-db.ts` so new installs start at the latest shape without needing migration replay. Add `ensureColumn()` calls in `storage-db.ts` initialization for new columns so upgraded DBs catch up reliably even if a migration row is lost.

**New RPC endpoint:** register the handler in `src/plugin/rpc-handlers.ts`, declare types in `src/shared/rpc-types.ts`, and consume from TUI via `src/tui/data/` modules.

**Shared utility:** add it in `src/shared/` only when at least two subsystems use it. Cross-runtime utilities (Bun/Node/Electron) belong here so the SQLite backend selector and harness identification stay in one place.

**Tests:** add a co-located `*.test.ts` file beside the implementation you change. For end-to-end coverage across OpenCode/Pi sessions, add scenarios under `packages/e2e-tests/tests/`.
