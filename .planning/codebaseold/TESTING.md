# Testing Patterns

**Analysis Date:** 2026-03-23

## Test Framework

**Runner:** Bun test (`bun:test`) — built into Bun runtime, no separate install needed
- Config: No separate config file — uses `bun test` CLI directly
- Test files discovered: `**/*.test.ts`

**Assertion Library:** `bun:test` built-in `expect` (Jest-compatible API)

**Run Commands:**
```bash
bun test                    # Run all tests
bun test --watch            # Watch mode
bun test src/features/      # Run tests in a specific directory
bun test path/to/file.test.ts  # Run a single test file
```

No coverage command configured in `package.json`.

## Test File Organization

**Location:** Co-located with source files in the same directory

**Naming:** `<module-name>.test.ts` alongside `<module-name>.ts`

**Examples:**
```
src/features/magic-context/
  range-parser.ts
  range-parser.test.ts
  tagger.ts
  tagger.test.ts
  scheduler.ts
  scheduler.test.ts

src/hooks/magic-context/
  hook.ts
  hook.test.ts
  transform.ts
  transform.test.ts

src/tools/ctx-reduce/
  tools.ts
  tools.test.ts
  constants.ts
  constants.test.ts
```

**Total test files:** 48 test files across the codebase (as of analysis date)

## Test File Header

All test files open with a Bun type reference directive:
```typescript
/// <reference types="bun-types" />
```

## Test Structure

**Suite Organization:**
```typescript
import { beforeEach, describe, expect, it, mock } from "bun:test";

describe("createTagger", () => {
    let tagger: ReturnType<typeof createTagger>;

    beforeEach(() => {
        tagger = createTagger();
    });

    describe("assignTag", () => {
        it("assigns sequential tags starting from 1", () => {
            //#given
            const sessionId = "session-1";

            //#when
            const tag = tagger.assignTag(sessionId, "msg-1", "message", 100, db);

            //#then
            expect(tag).toBe(1);
        });
    });
});
```

**Given/When/Then comments:** Tests use inline `//# given`, `//#when`, `//#then` comments to structure test body — this is the house style for unit tests

**Nested describes:** Feature suites use nested `describe` blocks to group related scenarios, often using `#given <condition>` naming for grouping:
```typescript
describe("#given promotable facts", () => { ... });
describe("#given duplicate detection", () => { ... });
describe("#given error handling", () => { ... });
```

## Mocking

**Framework:** `mock()` and `spyOn()` from `bun:test`

**Patterns:**
```typescript
import { mock, spyOn } from "bun:test";

// Simple stub
const assignTag = mock(() => 1);
const getTag = mock(() => undefined);

// Spy on module function
const spy = spyOn(someModule, "someFunction");
spy.mockReturnValue(expectedValue);
```

**Mock objects:** Dependencies are constructed as plain objects with `mock()` stubs for each method:
```typescript
const tagger: Tagger = {
    assignTag: mock(() => 1),
    getTag: mock(() => undefined),
    resetCounter: mock(() => {}),
    // ...all interface methods mocked
};
```

**Assertion on mocks:**
```typescript
expect(db.transaction).toHaveBeenCalledTimes(1);
expect(promptMocks.showToast).toHaveBeenCalledTimes(1);
const callArg = promptMocks.prompt?.mock.calls[0]?.[0];
expect(callArg).toEqual(expect.objectContaining({ ... }));
```

**What to Mock:**
- External I/O: database calls, filesystem operations, network requests
- Plugin client interfaces (`prompt`, `promptAsync`, `showToast`)
- Bun:sqlite `Database` — use `mock-database.ts` helper or real in-memory database

**What NOT to Mock:**
- Pure computation functions (parse, format, transform utilities)
- In-memory Bun SQLite databases (`:memory:` databases used directly in integration tests)

## Fixtures and Factories

**Test data builders:** Factory functions used to create test fixtures with sensible defaults and optional overrides:
```typescript
function createSessionMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
    return {
        sessionId: "ses-1",
        lastResponseTime: BASE_TIME,
        cacheTtl: "5m",
        counter: 0,
        ...overrides,
    };
}
```

**Mock database adapter:** `src/features/magic-context/mock-database.ts` provides a `toDatabase<T>()` cast helper used when a mock object needs to satisfy the `bun:sqlite Database` type:
```typescript
import { toDatabase } from "./mock-database";
// Usage:
tagger.assignTag(sessionId, "msg-1", "message", 100, toDatabase(mockDb));
```

**In-memory SQLite:** Integration tests create real Bun SQLite databases in-memory with full schema:
```typescript
import { Database } from "bun:sqlite";

function createTestDb(): Database {
    const db = new Database(":memory:");
    db.run(`CREATE TABLE tags (...); CREATE TABLE session_meta (...);`);
    return db;
}
```

**Location:** Factory functions defined locally within each test file — no shared fixtures directory

## Cleanup Patterns

**Temp directory management:** Tests that need filesystem I/O use `mkdtempSync` and clean up in `afterEach`:
```typescript
const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    closeDatabase();
    process.env.XDG_DATA_HOME = originalXdgDataHome;

    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
});
```

**Environment variable isolation:** Tests that manipulate `process.env` save original values and restore in `afterEach`

**Database teardown:** `closeDatabase()` called in `afterEach` to reset singleton database state between tests

## Coverage

**Requirements:** Not configured — no coverage threshold enforced
**Coverage command:** Not defined in `package.json` scripts

## Test Types

**Unit Tests:** The dominant pattern — pure functions and classes tested in isolation with mocked dependencies. See `src/features/magic-context/range-parser.test.ts`, `src/features/magic-context/tagger.test.ts`

**Integration Tests:** Tests that use real in-memory SQLite databases and multiple interacting modules together. See `src/tools/ctx-reduce/tools.test.ts`, `src/hooks/magic-context/compartment-runner.test.ts`

**E2E Tests:** Not used

## Common Patterns

**Async Testing:**
```typescript
it("sends a notification for ctx-status and throws the sentinel", async () => {
    await expect(
        hook["command.execute.before"]!({ command: "ctx-status", sessionID: "ses-status" }, {}),
    ).rejects.toThrow("__CONTEXT_MANAGEMENT_CTX-STATUS_HANDLED__");
});
```

**Error Testing:**
```typescript
it("throws on invalid input", () => {
    expect(() => parseRangeString("")).toThrow("Range string must not be empty");
});

// For async errors:
await expect(asyncFn()).rejects.toThrow("expected error message");
```

**Partial object matching:**
```typescript
expect(callArg).toEqual(
    expect.objectContaining({
        path: { id: "ses-status" },
        body: expect.objectContaining({
            noReply: true,
        }),
    }),
);
```

**Testing sentinel throws:** Some commands signal handled state by throwing a sentinel string. Tests assert the specific sentinel:
```typescript
).rejects.toThrow("__CONTEXT_MANAGEMENT_CTX-STATUS_HANDLED__");
```

**Numeric separators in test data:** Large numbers use underscore separators for readability:
```typescript
tokens: { input: 170_000, output: 10 }
```

---

*Testing analysis: 2026-03-23*
