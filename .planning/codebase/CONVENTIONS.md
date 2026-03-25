# Coding Conventions

**Analysis Date:** 2026-03-25

## Naming Patterns

**Files:**
- kebab-case for all source files: `range-parser.ts`, `storage-meta.ts`, `event-handler.ts`
- Compound feature files split by responsibility: `storage.ts` (barrel), `storage-db.ts`, `storage-tags.ts`, `storage-ops.ts`, `storage-meta.ts`
- Test files co-located with source: `range-parser.test.ts` beside `range-parser.ts`
- Multi-word compound names use hyphens, not underscores or dots: `magic-context.ts`, `transform-compartment-phase.ts`
- Dots in test file names for variant tests: `apply-operations.tool-drop.test.ts`

**Functions:**
- camelCase for all functions: `parseRangeString`, `createScheduler`, `getOrCreateSessionMeta`
- Factory functions prefixed with `create`: `createScheduler`, `createTransform`, `createEventHandler`, `createSessionHooks`, `createTagger`
- Boolean-returning functions prefixed with `is`/`has`: `isDatabasePersisted`, `hasPendingOps`, `isSubagent`
- Getters prefixed with `get`: `getTagsBySession`, `getOrCreateSessionMeta`, `getSessionNotes`
- Setters/writers prefixed with `set`/`insert`/`update`/`add`/`save`: `setPersistedNudgePlacement`, `insertTag`, `updateTagStatus`, `addSessionNote`
- Resolvers prefixed with `resolve`: `resolveSessionId`, `resolveCacheTtl`, `resolveModelKey`

**Variables:**
- camelCase for all variables: `sessionId`, `contextUsageMap`, `lastNudgeTokens`
- Constants in SCREAMING_SNAKE_CASE when module-level: `TTL_PATTERN`, `FLUSH_INTERVAL_MS`, `CONTEXT_USAGE_TTL_MS`, `DREAMER_AGENT`
- Underscore prefix for intentionally unused destructured variables: `_enabled`, `_schedule`, `_max`
- Numeric literals with `_` separators for readability: `20_000`, `300_000`, `172_000`

**Types/Interfaces:**
- PascalCase for all types, interfaces, and classes: `TagEntry`, `SessionMeta`, `ContextUsage`, `Scheduler`
- Schema objects suffixed with `Schema`: `MagicContextConfigSchema`, `DreamerConfigSchema`
- Zod-inferred types use `z.infer<typeof XxxSchema>`: `type DreamingTask = z.infer<typeof DreamingTaskSchema>`
- Interface names describe the shape (no `I` prefix): `EventHandlerDeps`, `SchedulerConfig`

**Constants:**
- `as const` assertions for enum-like arrays: `DREAMER_TASKS = [...] as const`
- Exported constants for shared magic values: `DEFAULT_NUDGE_INTERVAL_TOKENS`, `DEFAULT_COMPARTMENT_TOKEN_BUDGET`

## Code Style

**Formatting (Biome):**
- Indent: 4 spaces (not tabs)
- Line width: 100 characters
- Quote style: double quotes (`"`)
- Trailing commas: always (in function params, arrays, objects)
- Semicolons: always required
- Config file: `biome.json`

**Linting:**
- `useConst`: error — never use `let` when `const` suffices
- `noNonNullAssertion`: warn (off in test files) — prefer optional chaining
- `noExplicitAny`: warn (off in test files) — use proper types
- `noForEach`: off — `.forEach()` is allowed
- `noAssignInExpressions`: off

## Import Organization

**Order (Biome auto-organizes):**
1. External/third-party packages: `import { z } from "zod"`, `import { Database } from "bun:sqlite"`
2. Node built-ins with `node:` prefix: `import * as fs from "node:fs"`, `import { join } from "node:path"`
3. Internal relative imports: `import { log } from "../../shared/logger"`

**Style:**
- Named imports preferred over default imports for internal modules
- Default imports only for external packages where appropriate: `import plugin from "./index"`
- `import type` used for type-only imports: `import type { Scheduler } from "./scheduler"`
- Barrel files (`index.ts`) re-export from sub-modules using explicit named exports
- No wildcard (`*`) imports in source (only acceptable in scripts)
- Node built-ins always use `node:` prefix: `node:fs`, `node:path`, `node:os`
- Bun-specific modules use `bun:` prefix: `bun:sqlite`, `bun:test`

## TypeScript Patterns

**Strictness:**
- Full `strict: true` mode (all strict checks enabled)
- `isolatedModules: true` — each file must be independently compilable
- `target: ESNext`, `module: ESNext`
- `moduleResolution: bundler`

**Type patterns:**
- `interface` for object shapes and dependency injection: `EventHandlerDeps`, `Scheduler`
- `type` for unions, intersections, and Zod inferred types: `SchedulerDecision = "execute" | "defer"`
- `ReturnType<typeof fn>` for inferring complex return types: `ReturnType<typeof createCompactionHandler>`
- `as const` assertions on arrays and objects to narrow literal types
- Avoid `any` in source — use `unknown` for untyped external data

**Zod schemas:**
- All config/user-facing schemas use Zod v4 (`zod ^4`)
- Schema constant named `XxxSchema`, inferred type `type Xxx = z.infer<typeof XxxSchema>`
- Schema file: `src/config/schema/magic-context.ts`

## Error Handling

**Patterns:**
- Functions that can fail throw `Error` with descriptive messages including the invalid value: `throw new Error(\`Invalid cache TTL format: ${ttl}\`)`
- Catch blocks swallow errors only when intentional and documented with a comment: `// Intentional: logging must never throw`
- Try/catch at call site for recoverable errors; log + fallback to default (see `createScheduler` in `src/features/magic-context/scheduler.ts`)
- Storage functions propagate DB errors naturally — callers are responsible for wrapping
- No custom error classes observed — plain `Error` objects used throughout

## Logging

**Framework:** Custom file-based logger at `src/shared/logger.ts`

**Patterns:**
- Never use `console.log` in source code — use `log()` or `sessionLog()`
- `log(message, data?)` — general plugin-level logging
- `sessionLog(sessionId, message, data?)` — session-scoped logging, auto-prefixes with `[magic-context][{sessionId}]`
- Logger suppressed in test env (`NODE_ENV === "test"`)
- Logs written to `os.tmpdir()/magic-context.log`

## Comments

**When to Comment:**
- JSDoc on public-facing utility functions with non-obvious behavior (see `parseRangeString` in `src/features/magic-context/range-parser.ts`)
- Inline comments explaining *why* not *what* for non-obvious logic: `// Intentional: logging must never throw`
- Comment inline on test cases that document architectural invariants/ordering requirements
- Schema fields documented with JSDoc inline comments: `/** Enable dreamer (default: false) */`
- No block comments in implementation; JSDoc only on exported symbols

## Function Design

**Size:** Functions kept small; complex operations decomposed into sub-files (e.g., `transform.ts` delegates to `transform-compartment-phase.ts`, `transform-operations.ts`, `transform-postprocess-phase.ts`)

**Parameters:** Dependency injection via single options object for functions with 3+ dependencies: `createTransform({ tagger, scheduler, db, nudger, ... })`

**Return Values:**
- Functions return typed values or `void`; no implicit `undefined` returns
- Optional values typed as `T | null` (not `T | undefined`) when null is a meaningful "not found" result

## Module Design

**Exports:**
- Barrel pattern used heavily: `src/features/magic-context/storage.ts` re-exports from `storage-db.ts`, `storage-tags.ts`, `storage-ops.ts`, etc.
- `src/hooks/magic-context/index.ts` as the module entry point
- Only export what is needed externally; internal helpers are unexported

**Barrel Files:**
- Explicit named re-exports (not `export * from`): each barrel lists every exported symbol
- Type-only re-exports use `export type`: `export { type ContextDatabase, ... } from "./storage-db"`

---

*Convention analysis: 2026-03-25*
