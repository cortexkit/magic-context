# Technology Stack

**Analysis Date:** 2026-03-25

## Languages

**Primary:**
- TypeScript 5.8+ — all source code in `src/`, targeting ESNext with strict mode enabled

**Secondary:**
- JavaScript (`.mjs`) — build utility scripts in `scripts/` (e.g., `scripts/version-sync.mjs`)

## Runtime

**Environment:**
- Bun ≥ 1.0 (current dev installation: 1.3.11)
- No Node.js engine constraint declared; Bun is the required runtime
- ESM-only package (`"type": "module"` in `package.json`)

**Package Manager:**
- Bun (lockfile: `bun.lock` — committed)

## Frameworks

**Core:**
- `@opencode-ai/plugin` ^1.2.26 — OpenCode plugin SDK; defines the `Plugin` type, `ToolDefinition`, event hooks, and the agent config injection APIs
- `@opencode-ai/sdk` (transitive, imported via type-only imports) — provides `Message`, `Part`, `Event`, `AgentConfig` types used throughout the plugin

**Build:**
- Bun's native bundler (`bun build`) — bundles `src/index.ts` to `dist/` targeting Bun, ESM format
- TypeScript compiler (`tsc`) — used only for declaration emit (`--emitDeclarationOnly`); no transpilation
- Two tsconfig files: `tsconfig.json` (src, declaration-only) and `tsconfig.scripts.json` (scripts dir)

**Testing:**
- Bun's built-in test runner (`bun test`) — test files follow `*.test.ts` naming, co-located with source

**Linting / Formatting:**
- Biome 2.4.7 (`@biomejs/biome`) — single tool for both lint and format
- Config: `biome.json`

## Key Dependencies

**Critical:**
- `@opencode-ai/plugin` ^1.2.26 — the entire plugin surface area (tools, hooks, events, config injection) is built on this SDK; breaking changes here would require significant rework
- `@huggingface/transformers` ^3.5.1 — runs local ML inference for semantic embeddings (`Xenova/all-MiniLM-L6-v2`); loaded dynamically and marked `--external` in the build (not bundled)
- `zod` ^4.1.8 — schema validation for all config parsing (`src/config/schema/`), runtime type coercion and defaults
- `ai-tokenizer` ^1.0.6 — token counting for context budget calculations (nudge thresholds, compartment budgets)

**Infrastructure:**
- `bun:sqlite` (built-in Bun API) — SQLite database accessed via Bun's native binding; no external SQLite npm package needed
- `node:fs`, `node:path`, `node:os` — standard Node-compatible APIs used for filesystem paths and home directory resolution

## Configuration

**Environment:**
- No `.env` file required by the plugin itself — all user-facing config is in `magic-context.jsonc`
- Config is loaded from three locations in priority order:
  1. `<project-root>/magic-context.jsonc`
  2. `<project-root>/.opencode/magic-context.jsonc`
  3. `~/.config/opencode/magic-context.jsonc`
- Parsed with a custom JSONC parser (`src/shared/jsonc-parser.ts`) that strips comments
- Validated and defaulted with Zod in `src/config/schema/magic-context.ts`

**Build:**
- `tsconfig.json` — `rootDir: src`, `outDir: dist`, `lib: ES2022`, `moduleResolution: bundler`
- `tsconfig.scripts.json` — covers `scripts/` directory separately
- Build output is `dist/index.js` (ESM bundle) + `dist/index.d.ts` (declarations)
- External dependencies excluded from bundle: `@huggingface/transformers`, `@opencode-ai/plugin`

## Platform Requirements

**Development:**
- Bun ≥ 1.0 (required for `bun:sqlite`, native bundler, test runner)
- No browser support — server/agent runtime only

**Production:**
- Deployed as an npm package (`@cortexkit/magic-context-opencode`)
- Consumed by OpenCode as a plugin; OpenCode must be running on a Bun-compatible runtime
- SQLite database stored locally at `~/.local/share/opencode/storage/plugin/magic-context/context.db`
- Respects `XDG_DATA_HOME` for alternative storage locations

## Biome Configuration Summary (`biome.json`)

- Indent: 4 spaces
- Line width: 100
- Quotes: double
- Trailing commas: all
- Semicolons: always
- `noNonNullAssertion`: warn (off in tests)
- `noExplicitAny`: warn (off in tests)
- `useConst`: error
- `noForEach`: off
- VCS integration enabled (respects `.gitignore`)
- Files covered: `src/**/*.ts`, `scripts/**/*.mjs`

---

*Stack analysis: 2026-03-25*
