# Codebase Structure

A monorepo of TypeScript packages (`packages/`) and Rust crates (`crates/`). This file is a map; to find a specific symbol or file, search the code rather than this document.

## Workspace

```text
crates/
  mc-core/        cache-stability transform and classification logic
  mc-store/       the module's durable SQLite store (schema, migrations, CAS transitions)
  mc-tokenizer/   token estimator
  mc-module/      the subc module (ck-mc): transform, historian, tool facades
packages/
  plugin/         OpenCode plugin and the shared TypeScript core (@cortexkit/opencode-magic-context)
  pi-plugin/      Pi and OMP plugin (@cortexkit/pi-magic-context)
  cli/            setup, doctor and migration CLI (@cortexkit/magic-context)
  dashboard/      Tauri desktop dashboard
  docs/           documentation site (docs.cortexkit.io/magic-context), deployed by hand
  e2e-tests/      end-to-end suites against real OpenCode 1, OpenCode 2, Pi, OMP and Rust stacks
  retina-local-fs/ local file and git checks for smart-note conditions
scripts/          release, version sync, CI gates, diagnostics (context dumps; cache-bust analysis is in packages/plugin/scripts/)
docs/             public documentation (internal references: ignored .cortexkit/internal-docs/)
```

## `packages/plugin/src`

- `index.ts`: entry point. Keep it free of named exports; OpenCode's legacy loader calls every exported function.
- `plugin/`: OpenCode 1 adapters (hooks, tool registry, RPC handlers, dream timer).
- `v2/`: OpenCode 2 adapters (context and compaction hooks, store reader, hidden completions, fold ownership, TUI seam). Built separately to `dist/v2/server.js`.
- `hooks/magic-context/`: the transform and everything that runs inside a pass. `transform.ts` orchestrates; `transform-postprocess-phase.ts` holds the mutation gates; `inject-compartments.ts` renders `m[0]`/`m[1]`.
- `features/magic-context/`: services, grouped by area: storage and migrations, `dreamer/`, `memory/`, `mural/`, `smart-notes/`, `user-memory/`, `git-commits/`, search and indexes.
- `tools/`: one directory per agent tool.
- `config/`: schema (`schema/magic-context.ts`), loader, profiles, project trust boundary.
- `shared/`: small utilities used by several subsystems, including the logger and the SQLite backend selector.
- `tui/`: OpenCode sidebar and dialogs, shipped as source through the `./tui` export.
- `agents/`: hidden agent names, prompt helpers and their host registrations.

## Other packages

- `packages/pi-plugin/src`: the Pi context handler (`context-handler.ts`), Pi-specific commands, dreamer and subagent runners, Pi pressure and LKG handling. Parity with OpenCode is tracked in `PARITY.md`.
- `packages/cli/src`: `commands/` (setup, doctor, migrate) and `adapters/` per host.
- `packages/dashboard`: `src/` (Solid frontend) and `src-tauri/src/` (Rust backend: database readers, commands, log parser).
- `crates/mc-module/src`: `lib.rs` routes requests; `transform.rs`, `historian.rs`, `injection.rs`, `boundary.rs` mirror the TypeScript runtime.

## Where to add new code

- **Transform behaviour:** `src/hooks/magic-context/`, wired through `hook.ts`. Mirror it in `packages/pi-plugin/src/` and, if the Rust module runs it, in `crates/mc-module/src/`.
- **A service:** `src/features/magic-context/<area>/`.
- **An agent tool:** `src/tools/<name>/`, registered in `src/plugin/tool-registry.ts`, with the Pi and Rust facades.
- **A slash command:** defined in `src/shared/builtin-commands.ts`, handled in `src/hooks/magic-context/command-handler.ts` (OpenCode 1) and registered with OpenCode 2 in `src/v2/hooks/commands.ts`; Pi's commands are in `packages/pi-plugin/src/commands/`.
- **An RPC endpoint:** handler in `src/plugin/rpc-handlers.ts`, types in `src/shared/rpc-types.ts`, consumed from `src/tui/data/`.
- **A migration:** a new entry in `migrations.ts`, `LATEST_SUPPORTED_VERSION` bumped in `storage-db.ts`, the fresh schema and `ensureColumn()` updated, a `migrations-v<N>.test.ts`, and session-scoped tables added to `SESSION_SCOPED_TABLES`.
- **A hidden agent:** its name in `src/agents/`, its prompt next to the owning feature, registration in `src/agents/hidden-agent-registrations.ts` (which `src/index.ts` calls).
- **A CLI command:** `packages/cli/src/commands/`, wired from `packages/cli/src/index.ts`.
- **Shared utilities:** `src/shared/`, only when at least two subsystems use them.

## Conventions

- Files are kebab-case; `index.ts` only for entry points and barrels.
- Tests sit next to the code as `*.test.ts`; migration tests are `migrations-v<N>.test.ts`; end-to-end scenarios go in `packages/e2e-tests/tests/` and are registered in `mode-manifest.json`.
- Tests never touch the live database: test preloads point the data and config directories at temporary paths.
