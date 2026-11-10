import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import * as messageTime from "../features/magic-context/message-time-backfill";
import {
    __getDatabaseStartupStateForTests,
    __setScheduleStartupMaintenanceOnOpenForTests,
    __waitForDatabaseStartupForTests,
    closeDatabase,
    getPersistedSchemaVersion,
    LATEST_SUPPORTED_VERSION,
    openDatabase,
    openDatabaseAsync,
} from "../features/magic-context/storage-db";
import * as warmup from "../hooks/magic-context/raw-ordinal-warmup";
import { createTestTempDir } from "./test-temp-dir";

const root = resolve(import.meta.dir, "../../../..");
const originalDataHome = process.env.XDG_DATA_HOME;

afterEach(async () => {
    await closeDatabase();
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalDataHome;
});

function preloads(packageName: string): string[] {
    return Bun.TOML.parse(readFileSync(join(root, "packages", packageName, "bunfig.toml"), "utf8"))
        .test.preload as string[];
}

test.each([
    "plugin",
    "pi-plugin",
])("%s unit preload preserves isolation and disables startup maintenance", (packageName) => {
    expect(preloads(packageName)).toEqual(["./src/test-preload.ts"]);
    const path = join(root, "packages", packageName, "src/test-preload.ts");
    const source = ts.createSourceFile(
        path,
        readFileSync(path, "utf8"),
        ts.ScriptTarget.Latest,
        true,
    );
    const statements = source.statements.map((statement) => statement.getText(source));
    // Inspect statements, not comments: a commented-out policy must fail this guard.
    expect(statements[0]).toBe(
        'await import(new URL("../test-preload.ts", import.meta.url).href);',
    );
    expect(statements.at(-1)).toBe("__setScheduleStartupMaintenanceOnOpenForTests(false);");
    const storageModule =
        packageName === "plugin"
            ? "./features/magic-context/storage-db"
            : "@magic-context/core/features/magic-context/storage-db";
    expect(statements[1]).toMatch(
        new RegExp(
            `const \\{ __setScheduleStartupMaintenanceOnOpenForTests \\} = await import\\(\\s*"${storageModule}"\\s*\\);`,
        ),
    );
});

test("CLI uses the unit policy while end-to-end tests retain the shared isolation-only preload", () => {
    expect(preloads("cli")).toEqual(["../plugin/src/test-preload.ts"]);
    expect(preloads("e2e-tests")).toEqual(["../plugin/test-preload.ts"]);
    const isolation = readFileSync(join(root, "packages/plugin/test-preload.ts"), "utf8");
    expect(isolation).not.toContain("__setScheduleStartupMaintenanceOnOpenForTests");
    expect(isolation).not.toContain("src/test-preload");
});

test.each([
    "sync",
    "async",
] as const)("default unit %s open schedules no startup job, but an opted-in open does", async (mode) => {
    process.env.XDG_DATA_HOME = createTestTempDir("mc-startup-policy-").dir;
    const worker = spyOn(warmup, "runSessionWarmupWorker").mockResolvedValue({
        ftsRowidBackfill: true,
    });
    const time = spyOn(messageTime, "startMessageTimeBackfill").mockResolvedValue();
    const open = () => (mode === "sync" ? openDatabase() : openDatabaseAsync());
    try {
        const db = (await open())!;
        expect(db).not.toBeNull();
        expect(getPersistedSchemaVersion(db)).toBe(LATEST_SUPPORTED_VERSION);
        expect(__getDatabaseStartupStateForTests(db)).toEqual({
            timerScheduled: false,
            running: null,
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(worker).not.toHaveBeenCalled();
        expect(time).not.toHaveBeenCalled();
        await closeDatabase();

        const previous = __setScheduleStartupMaintenanceOnOpenForTests(true);
        try {
            const optedIn = (await open())!;
            expect(__getDatabaseStartupStateForTests(optedIn)).toEqual({
                timerScheduled: true,
                running: null,
            });
            await __waitForDatabaseStartupForTests(optedIn);
            expect(__getDatabaseStartupStateForTests(optedIn)).toEqual({
                timerScheduled: false,
                running: expect.any(Promise),
            });
            expect(worker).toHaveBeenCalledTimes(1);
            expect(time).toHaveBeenCalledTimes(1);
        } finally {
            __setScheduleStartupMaintenanceOnOpenForTests(previous);
        }
    } finally {
        await closeDatabase();
        worker.mockRestore();
        time.mockRestore();
    }
});
