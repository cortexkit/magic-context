# Coding Conventions

**Analysis Date:** 2026-03-23

## Naming Patterns

**Files:**
- kebab-case for all source files: `range-parser.ts`, `storage-meta.ts`, `transform-operations.ts`
- Test files co-located with source, suffixed `.test.ts`: `range-parser.test.ts`
- Barrel files named `index.ts`, re-export all module exports
- Type-only files named `types.ts` per module
- Constants files named `constants.ts` per module

**Functions:**
- camelCase for functions: `createTagger`, `parseRangeString`, `getOrCreateSessionMeta`
- Factory functions prefixed with `create`: `createTagger()`, `createScheduler()`, `createCtxNoteTools()`
- Boolean-returning functions prefixed with `is`/`has`: `isDatabasePersisted()`, `hasPendingOps()`
- Async functions named for their action without `async` prefix in name: `execute`, `promote`, `runCompartmentPhase`

**Variables:**
- camelCase for locals and module-level vars
- `const` enforced by biome linter (`useConst: "error"`) — no `let` unless mutation is required
- Numeric literals use underscore separators for readability: `170_000`, `10_000`, `300_000`

**Types/Interfaces:**
- PascalCase for all interfaces, types, enums: `TagEntry`, `SessionMeta`, `ContextUsage`
- Interface names NOT prefixed with `I`
- `interface` preferred for object shapes; `type` used for unions and function signatures
- Dependency injection objects typed as interfaces with `Deps` suffix: `CtxNoteToolDeps`, `CtxReduceToolDeps`, `MagicContextDeps`

**Constants:**
- UPPER_SNAKE_CASE for module-level exported constants: `CTX_REDUCE_DESCRIPTION`, `DEFAULT_PROTECTED_TAGS`, `DEFAULT_NUDGE_INTERVAL_TOKENS`
- Values in `constants.ts` file per tool/feature module

## Code Style

**Formatter:** Biome (`biome.json`)

**Key settings:**
- Indent: 4 spaces (`indentStyle: "space"`, `indentWidth: 4`)
- Line width: 100 characters
- Quotes: double (`"quoteStyle": "double"`)
- Trailing commas: always (`"trailingCommas": "all"`)
- Semicolons: always (`"semicolons": "always"`)

**Linting:** Biome linter with recommended rules enabled

**Key rules:**
- `useConst: "error"` — always prefer `const`
- `noNonNullAssertion: "warn"` — avoid `!` non-null assertions (relaxed in test files)
- `noExplicitAny: "warn"` — avoid `any` (relaxed in test files via override)
- `noForEach: "off"` — `forEach` is allowed (rule disabled)
- `noAssignInExpressions: "off"` — assignment in expressions allowed
- `noTemplateCurlyInString: "off"` — template literals in strings allowed

## Import Organization

**Order** (biome handles auto-sorting):
1. External packages: `@opencode-ai/plugin`, `bun:sqlite`, `bun:test`
2. Node built-ins with `node:` prefix: `node:fs`, `node:path`, `node:os`
3. Internal paths (relative): `../../features/magic-context/storage`, `./types`

**Import style:**
- `import type { ... }` used for type-only imports — enforced practice throughout codebase
- Named imports preferred over default imports for internal modules
- Default import only for entry point plugin export: `export default plugin`

**Path aliases:** None — all imports use relative paths

**Examples:**
```typescript
import type { Database } from "bun:sqlite";
import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import { mkdtempSync, rmSync } from "node:fs";
import { parseRangeString } from "../../features/magic-context/range-parser";
import type { CtxReduceArgs } from "./types";
```

## Error Handling

**Patterns:**
- Tool `execute()` functions return error strings on failure rather than throwing: `return "Error: 'content' is required when action is 'write'."` — this surfaces to the AI as tool output
- Internal/utility functions throw `Error` instances with descriptive messages
- `getErrorMessage(error: unknown): string` utility in `src/shared/error-message.ts` used to safely extract message from caught errors: `(error as Error).message` or `String(error)`
- Bare `catch {}` (empty catch) used when error is explicitly intentional to swallow (e.g., log write failures)
- `catch (error)` used when error must be logged or re-surfaced: `log("error during X", getErrorMessage(error))`
- Operations that must be atomic use `bun:sqlite` transactions; transaction rollback is the cleanup mechanism

**Example pattern:**
```typescript
try {
    dropIds = parseRangeString(args.drop);
} catch (e) {
    return `Error: Invalid range syntax. ${(e as Error).message}`;
}
```

## Logging

**Framework:** Custom `log()` in `src/shared/logger.ts`

**Behavior:**
- Logs to `$TMPDIR/magic-context.log` via synchronous `appendFileSync` (intentional for ordering)
- Silent in test environments (`process.env.NODE_ENV === "test"` suppresses all output)
- Swallows I/O errors silently — log failure never propagates to caller

**Pattern:**
```typescript
import { log } from "../../shared/logger";

log("message description", optionalDataObject);
```

**What to log:** Unexpected errors, transform timing, significant state changes. No debug spam.

## Comments

**When to Comment:**
- Non-obvious design decisions get inline comments explaining WHY, not what
- Comments reference audit findings by number: `// See audit finding #4`
- Performance trade-off decisions documented inline with reasoning and measurement data

**JSDoc:** Used sparingly — only for public utility functions with complex parameters or throws
```typescript
/**
 * Parses a range string into a sorted, deduplicated array of integers.
 * @throws {Error} on empty string, non-numeric input, reversed ranges, or ranges exceeding 1000 elements
 */
export function parseRangeString(input: string): number[] { ... }
```

## Function Design

**Size:** Small focused functions — each file tends to export a single `createX()` factory or set of pure utility functions

**Parameters:** Dependencies passed via an explicit `Deps` interface object to factory functions — avoids module-level singletons and enables testability:
```typescript
export interface CtxNoteToolDeps {
    db: Database;
}
function createCtxNoteTool(deps: CtxNoteToolDeps): ToolDefinition { ... }
```

**Return Values:** Functions return plain data types; no `Result<T>` monad — errors thrown or returned as strings depending on context

## Module Design

**Exports:**
- Each feature module has an `index.ts` that re-exports everything: `export * from "./constants"`, `export * from "./tools"`, `export * from "./types"`
- Functions exported from implementation file, re-exported through barrel
- Private helpers not exported (unexported functions in module file)

**Barrel Files:**
- Every `src/tools/<name>/` directory has `index.ts` barrel
- `src/tools/index.ts` aggregates all tool sub-modules
- `src/features/magic-context/storage.ts` is a mega-barrel aggregating all storage sub-modules

## TypeScript Configuration

- **Strict mode:** `"strict": true` — all strict checks enabled
- **Target:** ESNext with ES2022 lib
- **Module resolution:** `"bundler"` (modern Bun-compatible)
- **`isolatedModules: true`** — each file must be independently compilable (enforces `import type` for type-only imports)
- Test files excluded from declaration emit (excluded in `tsconfig.json`)

---

*Convention analysis: 2026-03-23*
