# Testing Patterns

**Analysis Date:** 2026-03-25

## Test Framework

**Runner:**
- Bun's built-in test runner (`bun:test`)
- No separate config file — tests auto-discovered by Bun
- TypeScript tested directly (no transpile step needed)

**Assertion Library:**
- Bun's built-in `expect` (Jest-compatible API)

**Run Commands:**
```bash
bun test                # Run all tests
bun test --watch        # Watch mode
bun test --coverage     # Coverage report
bun test src/features/magic-context/range-parser.test.ts  # Single file
```

## Test File Organization

**Location:** Co-located with source files — test file lives beside the module it tests:
```
src/
├── features/magic-context/
│   ├── range-parser.ts
│   ├── range-parser.test.ts         ← co-located
│   ├── storage.ts
│   ├── storage.test.ts              ← tests barrel exports
│   ├── storage-tags.ts
│   ├── storage-tags.test.ts
│   ├── scheduler.ts
│   └── scheduler.test.ts
├── hooks/magic-context/
│   ├── transform.ts
│   ├── transform.test.ts            ← integration-style test
│   ├── compartment-runner.ts
│   └── compartment-runner.test.ts
├── tools/ctx-reduce/
│   ├── tools.ts
│   └── tools.test.ts
└── shared/
    ├── opencode-compaction-detector.ts
    └── opencode-compaction-detector.test.ts
```

**Naming:**
- `{module-name}.test.ts` for standard tests
- `{module-name}.{variant}.test.ts` for specific behavior variants: `apply-operations.tool-drop.test.ts`

## Test Structure

**Suite Organization:**
```typescript
import { describe, expect, it } from "bun:test";
import { parseRangeString } from "./range-parser";

describe("parseRangeString", () => {
    it("parses a single number", () => {
        //#given
        const input = "5";
        //#when
        const result = parseRangeString(input);
        //#then
        expect(result).toEqual([5]);
    });
});
```

**Given/When/Then comments:**
Tests consistently use inline `//#{given|when|then}` section comments:
```typescript
it("handles tags and pending-ops CRUD with session scoping", () => {
    //#given
    const db = makeMemoryDatabase();
    const sessionId = "ses-1";
    //#when
    updateTagStatus(db, sessionId, tagA, "dropped");
    //#then
    expect(oneTag?.status).toBe("dropped");
});
```

**Combined when/then for throw assertions:**
```typescript
it("throws on empty string", () => {
    //#given
    const input = "";
    //#when + #then
    expect(() => parseRangeString(input)).toThrow();
});
```

**Patterns:**
- `afterEach` for cleanup (database close, env var restore, temp dir removal)
- `beforeEach` for fresh state (new in-memory DB per test)
- Helper functions defined at file-top for shared setup logic (not fixtures)

## Mocking

**Framework:** `bun:test` built-in `mock`

**Module mocking pattern (for ESM modules with side effects):**
```typescript
// Must be called BEFORE importing the module that uses the mocked dep
mock.module("../../features/magic-context/memory/embedding", () => ({
    embedText: async (text: string) => { ... },
    isEmbeddingEnabled: () => true,
}));

// Dynamic import AFTER mock.module setup
const { createCtxMemoryTools } = await import("./tools");
```
See `src/tools/ctx-memory/tools.test.ts` for this pattern.

**Function mocking:**
```typescript
const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
// Later change behavior mid-test:
shouldExecute.mockImplementation(() => "execute");
```

**What to Mock:**
- External AI/embedding calls: always mock (heavy, non-deterministic)
- `Scheduler.shouldExecute` when testing transform logic in isolation
- `nudger` function when testing nudge-injection behavior
- Module-level side effects using `mock.module()`

**What NOT to Mock:**
- SQLite DB — use real in-memory `Database(":memory:")` instead
- File system for temp dirs — use real `mkdtempSync` + cleanup in `afterEach`
- Internal utility functions — test through real implementations

## Test Database Pattern

**In-memory SQLite for isolation:**
```typescript
function makeMemoryDatabase(): Database {
    const db = new Database(":memory:");
    db.run(`
        CREATE TABLE IF NOT EXISTS tags ( ... );
        CREATE TABLE IF NOT EXISTS pending_ops ( ... );
    `);
    return db;
}
```

Files using this pattern:
- `src/features/magic-context/storage.test.ts`
- `src/tools/ctx-reduce/tools.test.ts`
- `src/tools/ctx-note/tools.test.ts`
- `src/tools/ctx-memory/tools.test.ts`

**Temp directory for file-backed DB tests:**
```typescript
const tempDirs: string[] = [];
afterEach(() => {
    closeDatabase();
    process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
});

function useTempDataHome(prefix: string): void {
    process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), prefix));
}
```

This pattern is used in `src/features/magic-context/storage.test.ts` and `src/hooks/magic-context/transform.test.ts`.

## Fixtures and Factories

**No separate fixture files** — test data is created inline via factory helpers at the top of each test file:
```typescript
function createTestDb(): Database { ... }
function seedTags(db, tags): void { ... }
const toolContext = (sessionID = "ses-1") => ({ sessionID }) as never;
```

**Location:** Factory helpers defined at the top of each test file (no shared fixture directory).

## Coverage

**Requirements:** No enforced coverage threshold detected (no coverage config in `package.json` or `biome.json`).

**View Coverage:**
```bash
bun test --coverage
```

## Test Types

**Unit Tests:**
- Pure function tests: `range-parser.test.ts`, `nudger.test.ts`, `compartment-parser.test.ts`
- Scope: single function or module in total isolation
- Mocks: only external deps (embeddings, scheduler decisions)

**Integration Tests (DB-coupled):**
- Storage layer: `storage.test.ts`, `storage-tags.test.ts`, `storage-ops.test.ts`, `storage-meta.test.ts`
- Tool implementations: `tools/ctx-reduce/tools.test.ts`, `tools/ctx-note/tools.test.ts`, `tools/ctx-memory/tools.test.ts`
- Full transform pipeline: `hooks/magic-context/transform.test.ts` (uses real DB, mocks only scheduler/nudger)
- Scope: module + real SQLite in-memory DB

**E2E Tests:** Not present — no browser/CLI-level testing infrastructure detected.

## Common Patterns

**Async Testing:**
```typescript
it("executes asynchronously", async () => {
    //#when
    await transform({}, { messages });
    //#then
    expect(messages).toHaveLength(1);
});
```
All async tests use `async/await` — no Promise chains or `.resolves`/`.rejects` matchers observed.

**Error Testing:**
```typescript
// Synchronous throw:
expect(() => parseRangeString("abc")).toThrow();
// With message:
expect(() => parseRangeString("1-10000")).toThrow(
    'Range "1-10000" exceeds maximum size of 1000 elements (got 10000)',
);
```

**Verifying DB state after operation:**
```typescript
//#when
await transform({}, { messages: secondPass });
//#then
expect(getTagById(db, "ses-1", 1)?.status).toBe("dropped");
expect(getPendingOps(db, "ses-1")).toHaveLength(0);
```

**Testing null/undefined returns:**
```typescript
expect(getPersistedNudgePlacement(db, sessionId)).toBeNull();
expect(getTagsBySession(db, sessionId)).toEqual([]);
```

## TypeScript in Tests

**`tsconfig.json` excludes test files** from compilation (`"exclude": ["src/**/*.test.ts"]`) — tests are run directly by Bun without tsc.

**`tsconfig.scripts.json`** covers `scripts/` — checked separately via `bun run typecheck`.

**Biome overrides for test files** (`**/__tests__/**`, `**/*.test.ts`):
- `noExplicitAny`: off — `as never`, `as unknown as Database` casts freely used
- `noNonNullAssertion`: off — non-null assertions (`!`) acceptable in tests

---

*Testing analysis: 2026-03-25*
