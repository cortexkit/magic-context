import { describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../features/magic-context/storage";
import { startDreamScheduleTimer } from "./dream-timer";

/**
 * Regression coverage for the schema-fence / null-DB crash:
 *
 * When the on-disk cache schema is newer than this binary supports (e.g. a
 * stale OpenCode/Pi process still running an older dist after another process
 * migrated the shared DB forward), openDatabase() fails closed by returning a
 * typed-null instead of a live handle. The dream-timer used to drive that null
 * straight into `db.transaction(...)` inside embedding registration, producing
 * a confusing `null is not an object (evaluating 'db.transaction')` TypeError
 * on every 15-minute tick. The timer must instead skip gracefully.
 */
describe("schema-fence null-DB contract", () => {
    test("openDatabase returns falsy (never throws) when DB schema exceeds supported version", () => {
        const dir = mkdtempSync(join(tmpdir(), "mc-fence-"));
        const dbPath = join(dir, "context.db");
        try {
            // First open migrates the fresh DB to the current LATEST schema.
            const healthy = openDatabase({ dbPath });
            expect(healthy).toBeTruthy();

            // Re-open pretending this binary only supports schema v0 — any real
            // schema version (>=1) is "newer than supported", so the fence trips.
            // The contract the dream-timer relies on: this returns falsy, it
            // does NOT throw.
            let fenced: unknown;
            expect(() => {
                fenced = openDatabase({ dbPath, latestSupportedVersion: 0 });
            }).not.toThrow();
            expect(fenced).toBeFalsy();

            // A binary that DOES support the schema still opens normally.
            const supported = openDatabase({ dbPath, latestSupportedVersion: 999 });
            expect(supported).toBeTruthy();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("dream-timer registration cleanup", () => {
    test("stale same-directory cleanup preserves the replacement registration", async () => {
        const directory = mkdtempSync(join(tmpdir(), "mc-dream-timer-cleanup-"));
        const timerHandle = {
            unref: mock(() => {}),
        } as unknown as ReturnType<typeof setInterval>;
        const setIntervalSpy = spyOn(globalThis, "setInterval").mockImplementation(
            (() => timerHandle) as typeof setInterval,
        );
        const clearIntervalSpy = spyOn(globalThis, "clearInterval").mockImplementation(
            (() => undefined) as typeof clearInterval,
        );
        const base = {
            directory,
            projectIdentity: "git:dream-timer-cleanup",
            harness: "pi" as const,
            client: {} as never,
            ensureRegistered: async () => undefined,
        };
        let cleanupReplacement: (() => void) | undefined;

        try {
            const cleanupStale = await startDreamScheduleTimer({ ...base });
            cleanupReplacement = await startDreamScheduleTimer({ ...base });
            expect(cleanupStale).toBeFunction();
            expect(cleanupReplacement).toBeFunction();

            cleanupStale?.();
            expect(clearIntervalSpy).not.toHaveBeenCalled();

            cleanupReplacement?.();
            expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
        } finally {
            cleanupReplacement?.();
            setIntervalSpy.mockRestore();
            clearIntervalSpy.mockRestore();
            rmSync(directory, { recursive: true, force: true });
        }
    });

    test("stops the singleton when a tick removes the last dead directory", async () => {
        const directory = mkdtempSync(join(tmpdir(), "mc-dream-timer-dead-dir-"));
        const timerHandle = {
            unref: mock(() => {}),
        } as unknown as ReturnType<typeof setInterval>;
        const singletonStartupHandle = {
            unref: mock(() => {}),
        } as unknown as ReturnType<typeof setTimeout>;
        const projectStartupHandle = {
            unref: mock(() => {}),
        } as unknown as ReturnType<typeof setTimeout>;
        const startupHandles = [singletonStartupHandle, projectStartupHandle];
        let startupIndex = 0;
        const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(
            (() => startupHandles[startupIndex++] ?? projectStartupHandle) as typeof setTimeout,
        );
        const clearTimeoutSpy = spyOn(globalThis, "clearTimeout").mockImplementation(
            (() => undefined) as typeof clearTimeout,
        );
        let intervalCallback: (() => void) | undefined;
        const setIntervalSpy = spyOn(globalThis, "setInterval").mockImplementation(((
            callback: () => void,
        ) => {
            intervalCallback = callback;
            return timerHandle;
        }) as typeof setInterval);
        const clearIntervalSpy = spyOn(globalThis, "clearInterval").mockImplementation(
            (() => undefined) as typeof clearInterval,
        );
        let cleanupStale: (() => void) | undefined;
        let cleanup: (() => void) | undefined;

        try {
            const registration = {
                directory,
                projectIdentity: "git:dream-timer-dead-dir",
                harness: "pi" as const,
                client: {} as never,
                dreamerConfig: { disable: false } as never,
                ensureRegistered: async () => undefined,
            };
            cleanupStale = await startDreamScheduleTimer({ ...registration });
            cleanup = await startDreamScheduleTimer({ ...registration });
            rmSync(directory, { recursive: true, force: true });
            intervalCallback?.();
            for (let attempt = 0; attempt < 20; attempt += 1) {
                if (clearIntervalSpy.mock.calls.length > 0) break;
                await Promise.resolve();
            }

            expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
            expect(clearTimeoutSpy).toHaveBeenCalledWith(projectStartupHandle);
            expect(clearTimeoutSpy).toHaveBeenCalledWith(singletonStartupHandle);
        } finally {
            cleanupStale?.();
            cleanup?.();
            setTimeoutSpy.mockRestore();
            clearTimeoutSpy.mockRestore();
            setIntervalSpy.mockRestore();
            clearIntervalSpy.mockRestore();
            rmSync(directory, { recursive: true, force: true });
        }
    });
});

/**
 * Static guard: every openDatabase()/openTimerDatabaseOrNull() result in the
 * dream-timer must be null-checked before use, and sweepProject must not carry
 * an `openDatabase()` default param (which would re-introduce an unguarded
 * null). These assertions fail loudly if the guards are ever removed.
 */
describe("dream-timer null-DB guards (static)", () => {
    const source = readFileSync(join(import.meta.dir, "dream-timer.ts"), "utf8");

    test("defines the guarded open helper and uses it at both entry points", () => {
        expect(source).toContain("function openTimerDatabaseOrNull(");
        expect(source).toContain('openTimerDatabaseOrNull("schedule timer registration")');
        expect(source).toContain('openTimerDatabaseOrNull("maintenance tick")');
    });

    test("guards every guarded-open result with an early return", () => {
        // Count only INVOCATIONS (string-arg call sites), not the function
        // definition. Each must be backed by an `if (!db) return;` guard.
        const callSites = source.match(/openTimerDatabaseOrNull\("/g) ?? [];
        expect(callSites.length).toBeGreaterThanOrEqual(2);
        const guards = source.match(/if \(!db\) return;/g) ?? [];
        expect(guards.length).toBeGreaterThanOrEqual(callSites.length);
    });

    test("sweepProject has no unguarded openDatabase() default param", () => {
        expect(source).not.toContain("db: Database = openDatabase()");
    });

    test("openTimerDatabaseOrNull catches a FATAL openDatabase() throw and degrades to null", () => {
        // openDatabase() returns typed-null on the schema fence but THROWS on a
        // fatal open (corrupt/unwritable DB). openTimerDatabaseOrNull must catch
        // that throw too, so a fatal open can't escape the awaited startup
        // registration in index.ts and abort the whole plugin load.
        const helper = source.slice(
            source.indexOf("function openTimerDatabaseOrNull("),
            source.indexOf("const registeredProjects"),
        );
        expect(helper).toContain("try {");
        expect(helper).toContain("catch");
        expect(helper).toContain("storage fatal");
    });
});

describe("dream-timer startup is fail-open at the index.ts call site (static)", () => {
    // The awaited startDreamScheduleTimer(...) in index.ts runs BEFORE the hooks
    // are returned from server(). If it throws, the transform/compaction pipeline
    // never registers and every session's context balloons. The call must be
    // wrapped so any throw is logged and swallowed.
    const indexSource = readFileSync(join(import.meta.dir, "../index.ts"), "utf8");

    test("await startDreamScheduleTimer is wrapped in try/catch", () => {
        const callIdx = indexSource.indexOf("await startDreamScheduleTimer(");
        expect(callIdx).toBeGreaterThan(0);
        // The 200 chars before the call must contain a `try {`, and the call must
        // be followed (within a small window) by a `catch`.
        const before = indexSource.slice(Math.max(0, callIdx - 200), callIdx);
        const after = indexSource.slice(callIdx, callIdx + 300);
        expect(before).toContain("try {");
        expect(after).toContain("catch");
    });
});

describe("dream-timer message-history maintenance (static)", () => {
    const source = readFileSync(join(import.meta.dir, "dream-timer.ts"), "utf8");

    test("runs durable cleanup retries and the orphan sweep from the global tick", () => {
        const tick = source.slice(
            source.indexOf("function runTick("),
            source.indexOf("function startupJitterMs("),
        );
        expect(tick).toContain("runMessageHistoryMaintenance(db)");
        expect(tick).toContain("retryPendingSessionCleanups(db)");
        expect(tick).toContain("sweepOrphanedOpenCodeMessageIndexes(db, openOpenCodeDb)");
    });
});

describe("dream-timer historian child maintenance (static)", () => {
    const source = readFileSync(join(import.meta.dir, "dream-timer.ts"), "utf8");

    test("runs the historian sweep before the dreamer-enabled guard", () => {
        const historianSweep = source.indexOf("sweepOrphanedHistorianChildren(reg)");
        const dreamerGuard = source.indexOf("if (!dreamingEnabled || !dreamerConfig)");

        expect(historianSweep).toBeGreaterThan(0);
        expect(dreamerGuard).toBeGreaterThan(historianSweep);
        expect(source).toContain("reg.historianChildSweep !== undefined");
    });
});

describe("dream-timer git commit backlog drain (static)", () => {
    const source = readFileSync(join(import.meta.dir, "dream-timer.ts"), "utf8");

    test("sweepGitCommits invokes coordinated backlog drain after the index sweep", () => {
        expect(source).toContain("drainCommitBacklogForProject");
        expect(source).toContain("memorySnapshot?.gitCommitEnabled");
        expect(source).toContain("backlogDrained");
    });
});

describe("dream-timer dead-directory guard (static)", () => {
    const source = readFileSync(join(import.meta.dir, "dream-timer.ts"), "utf8");

    test("sweepProject skips + unregisters when the directory is gone", () => {
        expect(source).toContain("directoryStillExists(reg.directory)");
        expect(source).toContain("registeredProjects.delete(reg.directory)");
    });

    test("only a dir: identity GCs its schedule rows (git: is shared, must not)", () => {
        // The GC call must be gated behind the dir:-prefix check so a single dead
        // worktree never deletes a shared git: project's schedule.
        const gcIdx = source.indexOf("deleteTaskScheduleRowsForProject(db, reg.projectIdentity)");
        const guardIdx = source.indexOf('reg.projectIdentity.startsWith("dir:")');
        expect(guardIdx).toBeGreaterThan(0);
        expect(gcIdx).toBeGreaterThan(guardIdx);
    });
});
