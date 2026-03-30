# Codebase Structure

> All paths below are relative to `packages/plugin/` — the published npm package.

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

**`src/cli/`:**
- Purpose: Provide the interactive setup wizard exposed as the `opencode-magic-context` CLI binary.
- Contains: Setup orchestration, config-path detection, OpenCode integration helpers, and prompt utilities.
- Key files: `src/cli/index.ts`, `src/cli/setup.ts`, `src/cli/config-paths.ts`, `src/cli/opencode-helpers.ts`

**`src/agents/`:**
- Purpose: Define hidden agent identifiers and shared agent prompt helpers.
- Contains: Agent-name constants and prompt-building helpers.
- Key files: `src/agents/dreamer.ts`, `src/agents/historian.ts`, `src/agents/sidekick.ts`, `src/agents/magic-context-prompt.ts`

**`src/config/`:**
- Purpose: Parse and validate plugin configuration.
- Contains: Config loaders, re-exports, and Zod schemas.
- Key files: `src/config/index.ts`, `src/config/schema/magic-context.ts`, `src/config/schema/agent-overrides.ts`

**`src/plugin/`:**
- Purpose: Adapt internal services to OpenCode plugin interfaces.
- Contains: Hook wrappers, tool registry setup, and plugin context typing.
- Key files: `src/plugin/messages-transform.ts`, `src/plugin/event.ts`, `src/plugin/tool-registry.ts`, `src/plugin/hooks/create-session-hooks.ts`

**`src/hooks/`:**
- Purpose: Hold hook implementations and hook-specific helpers.
- Contains: The `magic-context` runtime and auxiliary hook logic.
- Key files: `src/hooks/magic-context/hook.ts`, `src/hooks/magic-context/transform.ts`, `src/hooks/magic-context/strip-content.ts`, `src/hooks/auto-slash-command/constants.ts`

**`src/features/`:**
- Purpose: Group reusable subsystem logic by feature.
- Contains: Magic-context services, dreamer runtime, sidekick support, storage, scheduler, tagger, and built-in commands.
- Key files: `src/features/magic-context/storage-db.ts`, `src/features/magic-context/storage-meta-persisted.ts`, `src/features/magic-context/dreamer/runner.ts`, `src/features/magic-context/memory/storage-memory.ts`, `src/features/builtin-commands/commands.ts`

**`src/tools/`:**
- Purpose: Define the agent-facing tool surface.
- Contains: One directory per tool with constants, types, implementation, and tests.
- Key files: `src/tools/ctx-reduce/tools.ts`, `src/tools/ctx-expand/tools.ts`, `src/tools/ctx-note/tools.ts`, `src/tools/ctx-memory/tools.ts`

**`src/shared/`:**
- Purpose: Keep cross-feature utilities small and dependency-light.
- Contains: Logging, path helpers, JSONC parsing, model helpers, and SDK normalization.
- Key files: `src/shared/logger.ts`, `src/shared/data-path.ts`, `src/shared/jsonc-parser.ts`

**`scripts/`:**
- Purpose: Support local inspection and maintenance outside the plugin runtime.
- Contains: Bun scripts for dumps, tails, embedding backfill, semantic-search testing, and version sync.
- Key files: `scripts/context-dump.ts`, `scripts/tail-view.ts`, `scripts/backfill-embeddings.ts`

**`docs/`:**
- Purpose: Keep longer-lived subsystem design references separate from root operational docs.
- Contains: Design documents for magic context and memory.
- Key files: `docs/MAGIC-CONTEXT-DESIGN.md`, `docs/MEMORY-DESIGN.md`

## Key File Locations

**Entry Points:** `src/index.ts`: Register the plugin, hidden agents, hooks, tools, and commands. `src/cli/index.ts`: CLI binary entry for `bunx @cortexkit/opencode-magic-context setup`.

**Configuration:** `src/config/index.ts`: Load and merge config files; `src/config/schema/magic-context.ts`: define defaults and schema rules.

**Core Logic:** `src/hooks/magic-context/transform.ts`: run the turn transform; `src/hooks/magic-context/hook.ts`: compose runtime services; `src/hooks/magic-context/strip-content.ts`: strip and replay reasoning, inline thinking, and placeholder messages; `src/features/magic-context/storage-db.ts`: create durable storage; `src/features/magic-context/storage-meta-persisted.ts`: read and write per-session persisted scalars and JSON blobs.

**Tests:** co-locate tests with source as `src/**/*.test.ts`, for example `src/hooks/magic-context/hook.test.ts` and `src/tools/ctx-memory/tools.test.ts`.

## Naming Conventions

**Files:** Use kebab-case for multiword module files and reserve `index.ts` for barrel exports or package entry modules: `transform-postprocess-phase.ts`, `storage-memory.ts`, `index.ts`.

**Directories:** Group by feature first, then by tool or subsystem name: `src/features/magic-context/dreamer/`, `src/tools/ctx-memory/`, `src/hooks/magic-context/`.

## Where to Add New Code

**New CLI command:** add it in `src/cli/setup.ts` or a new module under `src/cli/`, then wire it from `src/cli/index.ts`.

**New OpenCode hook adapter:** add the adapter in `src/plugin/` and keep the runtime logic in `src/hooks/magic-context/`.

**New magic-context transform or event helper:** add it under `src/hooks/magic-context/` and wire it through `src/hooks/magic-context/hook.ts`.

**New tool:** add `src/tools/[tool-name]/`, export it from `src/tools/index.ts` when appropriate, and register it in `src/plugin/tool-registry.ts`.

**New built-in slash command:** add the command definition in `src/features/builtin-commands/commands.ts` and handle execution in `src/hooks/magic-context/command-handler.ts`.

**New feature service:** add it under `src/features/magic-context/[feature-area]/` or as a focused module in `src/features/magic-context/` when it stays single-file.

**New hidden agent:** add the agent constant in `src/agents/[agent-name].ts`, add prompt text near the owning feature, and register it from `src/index.ts`.

**Shared utility:** add it in `src/shared/` only when at least two subsystems use it.

**Tests:** add a co-located `*.test.ts` file beside the implementation you change.
