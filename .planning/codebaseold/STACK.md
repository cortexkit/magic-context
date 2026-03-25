# Technology Stack

**Analysis Date:** 2026-03-23

## Languages

**Primary:**
- TypeScript 5.8+ — All source code in `src/**/*.ts`

**Secondary:**
- JavaScript (.mjs) — Scripts in `scripts/**/*.mjs`

## Runtime

**Environment:**
- Bun 1.3.11 — Primary runtime, bundler, and test runner
- Node.js 22.19.0 — Available in environment; Bun is the development target

**Package Manager:**
- Bun
- Lockfile: `bun.lock` (present, gitignored — not committed)

## Frameworks

**Core:**
- `@opencode-ai/plugin` ^1.2.26 — Plugin host interface; defines the `Plugin` type and `ToolDefinition` API that the entire codebase is built around

**Testing:**
- `bun:test` (built-in) — Bun's native test runner; no additional test framework needed

**Build/Dev:**
- `bun build` — Bundles `src/index.ts` to `dist/` targeting `bun` runtime with ESM format
- `tsc` (TypeScript 5.8+) — Emits type declarations only (`--emitDeclarationOnly`); not used for JS transpilation
- Biome 2.4.7 — Unified linter + formatter (replaces ESLint + Prettier)

## Key Dependencies

**Critical:**
- `@opencode-ai/plugin` ^1.2.26 — Host plugin API; defines how hooks, tools, events, and message transforms are registered with OpenCode
- `@opencode-ai/sdk` (peer/indirect via types) — OpenCode SDK for `createOpencodeClient`, `Event`, `Message`, `Part`, `AgentConfig` types
- `@huggingface/transformers` ^3.5.1 — Local ML inference (WASM-based); used for running the `Xenova/all-MiniLM-L6-v2` sentence embedding model in-process. Declared as external in the build to avoid bundling
- `zod` ^4.1.8 — Schema validation and config parsing throughout `src/config/`
- `ai-tokenizer` ^1.0.6 — Token counting for context budget calculations

**Infrastructure:**
- `bun:sqlite` (built-in) — Bun native SQLite binding for all persistent storage; no ORM

## Configuration

**Environment:**
- No `.env` file in use — the plugin is configured via `magic-context.jsonc` at project root, `.opencode/magic-context.jsonc`, or `~/.config/opencode/magic-context.jsonc`
- Plugin config is loaded at startup by `src/config/index.ts` via `loadPluginConfig(ctx.directory)`
- Optional env-style values (embedding API key, sidekick API key) are set in `magic-context.jsonc`, not environment variables

**Build:**
- `tsconfig.json` — Main TS config; targets ESNext, moduleResolution bundler, emits declarations only to `dist/`
- `tsconfig.scripts.json` — Extends main config; adds `scripts/` to include, no emit
- `biome.json` — Linter + formatter config (4-space indent, 100 char line width, double quotes, trailing commas, semicolons always)

## Platform Requirements

**Development:**
- Bun 1.3.x or later
- macOS/Linux (path handling uses `node:os`, `node:path`)

**Production:**
- Published to npm as `@cortexkit/magic-context-opencode`
- Consumed as a plugin by OpenCode (`@opencode-ai/plugin` host)
- Distributed from `dist/` (ESM, with `.d.ts` type declarations)
- `@huggingface/transformers` is an external peer dep (not bundled) — consumers must install it separately if using local embeddings

---

*Stack analysis: 2026-03-23*
