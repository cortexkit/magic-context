# Codebase Structure

A monorepo of TypeScript packages (`packages/`) and Rust crates (`crates/`). This file is a map; to find a specific symbol or file, search the code rather than this document.

## Workspace

```text
crates/
  mc-module/      the subc module (ck-mc): compaction provider for llm-runners, summarizer, tools, app reads, move-in
  mc-mock-runner/ a scriptable llm-runner stand-in for ck-mc's scenario and wire tests
  mc-tokenizer/   fallback token estimator for models the shared tokenizer crate doesn't know
crates_old/       the 0.49.x Rust module (mc-core, mc-store, mc-module, mc-tokenizer); kept for reference, not built
packages/
  plugin/         OpenCode plugin and the shared TypeScript core (@cortexkit/opencode-magic-context)
  pi-plugin/      Pi and OMP plugin (@cortexkit/pi-magic-context)
  cli/            setup, doctor and migration CLI (@cortexkit/magic-context)
  dashboard/      Tauri desktop dashboard
  docs/           documentation site (docs.cortexkit.io/magic-context), deployed by hand
  e2e-tests/      end-to-end suites against real OpenCode 1, OpenCode 2, Pi and OMP hosts (CI runs the TypeScript mode)
  retina-local-fs/ local file and git checks for smart-note conditions
scripts/          release, version sync, CI gates, ck-mc placement, diagnostics (context dumps; cache-bust analysis is in packages/plugin/scripts/)
docs/             public documentation (internal references: ignored .cortexkit/internal-docs/)
```

## `packages/plugin/src`

- `index.ts`: entry point. Keep it free of named exports; OpenCode's legacy loader calls every exported function.
- `plugin/`: OpenCode 1 adapters (hooks, tool registry, RPC handlers, dream timer).
- `v2/`: OpenCode 2 adapters (context and compaction hooks, store reader, hidden completions, fold ownership, TUI seam). Built separately to `dist/v2/server.js`.
- `hooks/magic-context/`: the transform and everything that runs inside a pass. `transform.ts` orchestrates; `transform-postprocess-phase.ts` runs the mutation lanes, and `pass-mutation-decision.ts` holds their one permission; `inject-compartments.ts` renders `m[0]`/`m[1]`.
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
- `crates/mc-module/src`: `lib.rs` (crate overview and terms), `module.rs` (one worker per session, in order), `session.rs` (Setup, notices, rides, views), `pass.rs` and `lanes.rs` (the pass decision and reduction lanes), `view_builder.rs`, `summary/head.rs` (the history head, `m[0]`/`m[1]`), `summary/` (summarizer trigger, runs and two-pass turn two), `injection.rs` (the injected-text strip lane), `index.rs` (the transcript index), `store.rs` (`mode3.db`), `context_db.rs` (the shared `context.db`), `move_in/` and `rekey/` (offline moves), `app_read/` and `context_read/` (reads for the apps and Colliculus). Tests: `crates/mc-module/tests/` (scenarios against `mc-mock-runner`, real-wire tests through `scripts/wire-gate.sh`).

## Where to add new code

- **Transform behaviour:** `src/hooks/magic-context/`, wired through `hook.ts`. Mirror it in `packages/pi-plugin/src/` and in ck-mc (`crates/mc-module/src/`, usually `lanes.rs` or `pass.rs`) for runner sessions; a change to the pass decision regenerates the decision table (`gen-pass-decision-table.ts`).
- **A service:** `src/features/magic-context/<area>/`.
- **An agent tool:** `src/tools/<name>/`, registered in `src/plugin/tool-registry.ts`, with the Pi tool in `packages/pi-plugin/src/tools/` and ck-mc's catalog entry (`crates/mc-module/src/catalog.rs`).
- **A slash command:** defined in `src/shared/builtin-commands.ts`, handled in `src/hooks/magic-context/command-handler.ts` (OpenCode 1) and registered with OpenCode 2 in `src/v2/hooks/commands.ts`; Pi's commands are in `packages/pi-plugin/src/commands/`. ck-mc serves no slash commands.
- **An RPC endpoint:** handler in `src/plugin/rpc-handlers.ts`, types in `src/shared/rpc-types.ts`, consumed from `src/tui/data/`.
- **A migration:** a new entry in `migrations.ts`, `LATEST_SUPPORTED_VERSION` bumped in `storage-db.ts`, the fresh schema and `ensureColumn()` updated, a `migrations-v<N>.test.ts`, and session-scoped tables added to `SESSION_SCOPED_TABLES`.
- **A hidden agent:** its name in `src/agents/`, its prompt next to the owning feature, registration in `src/agents/hidden-agent-registrations.ts` (which `src/index.ts` calls).
- **A CLI command:** `packages/cli/src/commands/`, wired from `packages/cli/src/index.ts`.
- **Shared utilities:** `src/shared/`, only when at least two subsystems use them.

## Conventions

- Files are kebab-case; `index.ts` only for entry points and barrels.
- Tests sit next to the code as `*.test.ts`; migration tests are `migrations-v<N>.test.ts`; end-to-end scenarios go in `packages/e2e-tests/tests/` and are registered in `mode-manifest.json`.
- Tests never touch the live database: test preloads point the data and config directories at temporary paths.
