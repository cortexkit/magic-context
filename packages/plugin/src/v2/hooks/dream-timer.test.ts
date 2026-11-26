import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import * as configLoader from "../../config";
import { MagicContextConfigSchema } from "../../config/schema/magic-context";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import { resetCtxReduceRegisteredGloballyForTest } from "../../hooks/magic-context/ctx-reduce-availability";
import { setBootQuietPeriodForTests } from "../../plugin/boot-quiet";
import {
    _getDreamTimerStateForTests,
    _resetDreamTimerForTests,
    _setDreamTimerStagesForTests,
} from "../../plugin/dream-timer";
import { _resetHarnessForTesting } from "../../shared/harness";
import * as logger from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import { setup } from "../server";
import { V2StoreReader } from "../store-reader";
import { registerContext } from "./context";
import { findV2DreamParentSession } from "./dream-timer";
import * as storageGate from "./storage-gate";
import type { V2Context } from "./types";

/**
 * OpenCode 2 calls only `setup`, never the OpenCode 1 `server` function that
 * registers the dream schedule timer. These tests pin that the v2 lane
 * registers its project with the process-wide timer and that a context's
 * cleanup (what OpenCode 2 runs when a location shuts down) takes it off again.
 */

const directories: string[] = [];
const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
    for (const dispose of disposers.splice(0)) await dispose().catch(() => {});
    _resetDreamTimerForTests();
    closeDatabase();
    resetCtxReduceRegisteredGloballyForTest();
    _resetHarnessForTesting();
    for (const dir of directories.splice(0)) cleanupTestTempDir(dir);
});

function projectDirectory(): string {
    const { dir } = createTestTempDir("mc-v2-dream-timer-");
    directories.push(dir);
    return dir;
}

function fakeHost(directory: string): V2Context {
    return {
        location: { directory },
        agent: { transform: async () => {}, reload: async () => {} },
        model: { list: () => [] },
        storage: { get: async () => undefined, set: async () => {} },
        event: { subscribe: async function* () {} },
        tool: { hook: async () => {} },
        session: {
            remove: async () => {},
            compact: async () => {},
            interrupt: async () => ({ interrupted: true }),
            hook: async () => {},
            get: async () => ({ location: { directory } }),
        },
    } as unknown as V2Context;
}

/** A configuration with the dreamer on, and nothing else that starts background work. */
function mockConfig(dreamer: { disable: boolean }, gitIndexing = false) {
    const config = MagicContextConfigSchema.parse({
        auto_update: false,
        historian: { disable: true },
        dreamer,
        memory: { enabled: false, git_commit_indexing: { enabled: gitIndexing } },
        embedding: { provider: "off" },
    });
    const detailed = configLoader.loadPluginConfigDetailed(projectDirectory(), false);
    const load = spyOn(configLoader, "loadPluginConfigDetailed").mockReturnValue({
        ...detailed,
        config,
    });
    // Storage opens at boot, so the dreamer's carrier is wired during setup.
    const db = openDatabase();
    if (!db) throw new Error("throwaway test store unavailable");
    const probe = spyOn(storageGate, "probeV2StorageAtBoot").mockResolvedValue(db);
    disposers.push(async () => {
        load.mockRestore();
        probe.mockRestore();
    });
    return config;
}

describe("OpenCode 2 dream schedule timer registration", () => {
    test("setup registers the project with the schedule timer and its cleanup unregisters it", async () => {
        mockConfig({ disable: false });
        const directory = projectDirectory();
        expect(_getDreamTimerStateForTests()).toEqual({ active: false, directories: [] });

        const dispose = await setup(fakeHost(directory));
        expect(_getDreamTimerStateForTests()).toEqual({ active: true, directories: [directory] });

        await dispose();
        expect(_getDreamTimerStateForTests()).toEqual({ active: false, directories: [] });
    });

    test("a disabled dreamer still registers independent maintenance", async () => {
        mockConfig({ disable: true });
        const directory = projectDirectory();
        const dispose = await setup(fakeHost(directory));
        disposers.unshift(dispose);
        expect(_getDreamTimerStateForTests()).toEqual({ active: true, directories: [directory] });
    });

    for (const [dreamerDisabled, bootGitEnabled] of [
        [true, true],
        [false, true],
        [true, false],
    ]) {
        const name = bootGitEnabled
            ? `git sweep indexes commits exactly once with dreamer ${dreamerDisabled ? "disabled" : "enabled"}`
            : "live git indexing starts after boot with dreamer disabled and embeddings off";
        test(name, async () => {
            const config = mockConfig({ disable: dreamerDisabled }, bootGitEnabled);
            const directory = projectDirectory();
            const commitMessage = `independent commit indexing ${directory}`;
            for (const args of [
                ["init", "--quiet"],
                [
                    "-c",
                    "user.name=Test",
                    "-c",
                    "user.email=test@example.invalid",
                    "commit",
                    "--quiet",
                    "--allow-empty",
                    "-m",
                    commitMessage,
                ],
            ]) {
                const result = Bun.spawnSync(["git", "-C", directory, ...args], {
                    windowsHide: true,
                });
                if (result.exitCode !== 0) throw new Error(result.stderr.toString());
            }
            setBootQuietPeriodForTests(0);
            const restoreStages = _setDreamTimerStagesForTests({
                runMessageHistoryMaintenance: async () => {},
            });
            disposers.push(async () => restoreStages());
            const logs = spyOn(logger, "log");
            disposers.push(async () => logs.mockRestore());
            const duties = await registerContext(fakeHost(directory));
            config.memory.git_commit_indexing.enabled = true;
            disposers.unshift(async () => {
                await duties?.dispose();
            });
            const db = openDatabase()!;
            const deadline = Date.now() + 10000;
            let count = 0;
            while (Date.now() < deadline) {
                count = (
                    db
                        .prepare("SELECT count(*) AS n FROM git_commits WHERE message = ?")
                        .get(commitMessage) as { n: number }
                ).n;
                if (count > 0) break;
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            expect(count, logs.mock.calls.map((args) => args.join(" ")).join("\n")).toBe(1);
            expect(
                logs.mock.calls.filter(([line]) =>
                    String(line).includes("[git-commits] sweep starting"),
                ).length,
            ).toBe(1);
            expect(_getDreamTimerStateForTests()).toEqual({
                active: true,
                directories: [directory],
            });
        }, 15000);
    }

    test("several contexts share one timer, and each cleanup removes only its own project", async () => {
        mockConfig({ disable: false });
        const first = projectDirectory();
        const second = projectDirectory();
        const intervals = spyOn(globalThis, "setInterval");
        disposers.push(async () => intervals.mockRestore());

        const firstContext = await registerContext(fakeHost(first));
        const secondContext = await registerContext(fakeHost(second));
        // Two projects on the timer, but only one interval in the process.
        expect(_getDreamTimerStateForTests()).toEqual({
            active: true,
            directories: [first, second],
        });
        const dreamTimerIntervals = intervals.mock.calls.filter(
            ([, ms]) => ms === 15 * 60 * 1000,
        ).length;
        expect(dreamTimerIntervals).toBe(1);

        await firstContext?.dispose();
        expect(_getDreamTimerStateForTests()).toEqual({ active: true, directories: [second] });

        await secondContext?.dispose();
        expect(_getDreamTimerStateForTests()).toEqual({ active: false, directories: [] });
    });

    test("a location rebuilt in place keeps the replacement's registration when the old one is disposed", async () => {
        mockConfig({ disable: false });
        const directory = projectDirectory();

        const previous = await registerContext(fakeHost(directory));
        const replacement = await registerContext(fakeHost(directory));
        expect(_getDreamTimerStateForTests()).toEqual({ active: true, directories: [directory] });

        // The old location's cleanup runs after its replacement registered.
        await previous?.dispose();
        expect(_getDreamTimerStateForTests()).toEqual({ active: true, directories: [directory] });

        await replacement?.dispose();
        expect(_getDreamTimerStateForTests()).toEqual({ active: false, directories: [] });
    });
});

/** The OpenCode 2 session table, as far as the parent lookup reads it. */
function createV2Store(
    rows: Array<{
        id: string;
        directory: string;
        parent_id?: string;
        metadata?: string;
        time_updated: number;
        time_archived?: number;
    }>,
): string {
    const dir = projectDirectory();
    const path = join(dir, "opencode.db");
    const db = new Database(path);
    db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT NOT NULL,
            parent_id TEXT, metadata TEXT, time_updated INTEGER NOT NULL, time_archived INTEGER);
        CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL);`);
    const insert = db.prepare(
        "INSERT INTO session_v2 (id, directory, parent_id, metadata, time_updated, time_archived) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const row of rows)
        insert.run(
            row.id,
            row.directory,
            row.parent_id ?? null,
            row.metadata ?? null,
            row.time_updated,
            row.time_archived ?? null,
        );
    db.close();
    return path;
}

describe("OpenCode 2 timer parent lookup", () => {
    test("picks the latest top-level user session in this directory only", () => {
        const path = createV2Store([
            { id: "ses-old", directory: "/work/app", time_updated: 1 },
            { id: "ses-latest", directory: "/work/app", time_updated: 5 },
            { id: "ses-child", directory: "/work/app", parent_id: "ses-old", time_updated: 9 },
            {
                id: "ses-hidden",
                directory: "/work/app",
                metadata: JSON.stringify({ magic_context: "hidden-run", role: "dreamer" }),
                time_updated: 9,
            },
            {
                id: "ses-holder",
                directory: "/work/app",
                metadata: JSON.stringify({ magic_context: "background-holder" }),
                time_updated: 10,
            },
            { id: "ses-archived", directory: "/work/app", time_updated: 9, time_archived: 9 },
            { id: "ses-sibling", directory: "/work/app-worktree", time_updated: 9 },
        ]);
        expect(findV2DreamParentSession(() => new V2StoreReader(path), "/work/app")).toBe(
            "ses-latest",
        );
    });

    test("finds nothing in a directory without a user session, and nothing when the store cannot be read", () => {
        const path = createV2Store([
            { id: "ses-sibling", directory: "/work/app-worktree", time_updated: 9 },
        ]);
        expect(
            findV2DreamParentSession(() => new V2StoreReader(path), "/work/app"),
        ).toBeUndefined();
        expect(
            findV2DreamParentSession(() => {
                throw new Error("store missing");
            }, "/work/app"),
        ).toBeUndefined();
    });

    // Issue 669: OpenCode 2 on Windows stores a session's directory with forward
    // slashes while the plugin's location uses backslashes. An exact comparison
    // found no parent, logged "no OpenCode 2 session in <dir> to parent a
    // timer-started dream run", and every task needing a child was skipped.
    test("finds the reporter's Windows session stored with forward slashes from a backslash location", () => {
        const path = createV2Store([
            {
                id: "ses_003d66de0ffehWx8sGUHOvz6wx",
                directory: "D:/coding/siac/wt/migracion-asincrona",
                time_updated: 5,
            },
            {
                id: "ses_f25830a8bffeSKtIB5Ja0MVb1v",
                directory: "D:/coding/siac/wt/migracion-asincrona",
                parent_id: "ses_003d66de0ffehWx8sGUHOvz6wx",
                time_updated: 9,
            },
            {
                id: "ses_f2b9cb3bcffewuQTM25cxU0TH1",
                directory: "D:/coding/siac/wt/notificaciones-pui",
                time_updated: 9,
            },
        ]);
        const logged: string[] = [];
        const logSpy = spyOn(logger, "log").mockImplementation((...args: unknown[]) => {
            logged.push(args.map(String).join(" "));
        });
        try {
            expect(
                findV2DreamParentSession(
                    () => new V2StoreReader(path),
                    "D:\\coding\\siac\\wt\\migracion-asincrona",
                ),
            ).toBe("ses_003d66de0ffehWx8sGUHOvz6wx");
        } finally {
            logSpy.mockRestore();
        }
        expect(
            logged.filter((line) => line.includes("to parent a timer-started dream run")),
        ).toEqual([]);
    });

    for (const [label, location] of [
        ["forward slashes against backslashes", "C:\\Users\\dev\\work\\app"],
        ["drive-letter case", "c:/Users/dev/work/app"],
        ["a trailing slash", "C:/Users/dev/work/app/"],
        ["a trailing backslash", "C:\\Users\\dev\\work\\app\\"],
        ["a `.` and a `..` segment", "C:\\Users\\dev\\.\\work\\tmp\\..\\app"],
    ] as const) {
        test(`a Windows location spelled with ${label} finds its own session`, () => {
            const path = createV2Store([
                { id: "ses-own", directory: "C:/Users/dev/work/app", time_updated: 1 },
                { id: "ses-other", directory: "C:/Users/dev/work/app-worktree", time_updated: 9 },
            ]);
            expect(findV2DreamParentSession(() => new V2StoreReader(path), location)).toBe(
                "ses-own",
            );
        });
    }

    test("a genuinely different Windows directory is still refused", () => {
        const path = createV2Store([
            { id: "ses-sibling", directory: "C:/Users/dev/work/app-worktree", time_updated: 9 },
            { id: "ses-parent-dir", directory: "C:/Users/dev/work", time_updated: 9 },
            { id: "ses-other-drive", directory: "D:/Users/dev/work/app", time_updated: 9 },
        ]);
        expect(
            findV2DreamParentSession(() => new V2StoreReader(path), "C:\\Users\\dev\\work\\app"),
        ).toBeUndefined();
    });

    test("the newest matching root wins even when it is past the first page of roots", () => {
        const rows = Array.from({ length: 1200 }, (_, index) => ({
            id: `ses-other-${String(index).padStart(4, "0")}`,
            directory: "/work/other",
            time_updated: 10_000 + index,
        }));
        const path = createV2Store([
            ...rows,
            { id: "ses-own-old", directory: "/work/app", time_updated: 1 },
            { id: "ses-own-new", directory: "/work/app/", time_updated: 2 },
        ]);
        expect(findV2DreamParentSession(() => new V2StoreReader(path), "/work/app")).toBe(
            "ses-own-new",
        );
    });
});
