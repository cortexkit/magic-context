import { expect, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
    seedRetainedSession,
    snapshotSessionRows,
} from "../features/magic-context/session-retention.fixture";
import { closeDatabase, openDatabase } from "../features/magic-context/storage";
import { _resetHarnessForTesting, getHarness, setHarness } from "../shared/harness";
import * as logger from "../shared/logger";
import { resetOpenCodeDbPathStateForTesting } from "../shared/opencode-db-path";
import { Database } from "../shared/sqlite";
import { cleanupTestTempDir, createTestTempDir } from "../shared/test-temp-dir";
import * as bootQuiet from "./boot-quiet";
import {
    _isDreamTimerTickInFlightForTests,
    _resetDreamTimerForTests,
    startDreamScheduleTimer,
} from "./dream-timer";

for (const harness of ["opencode", "opencode2"] as const) {
    test(`${harness} startup and background passes retain every shared-store row for another instance's idle session`, async () => {
        const previousHarness = getHarness();
        const previousEnv = {
            XDG_DATA_HOME: process.env.XDG_DATA_HOME,
            OPENCODE_DB: process.env.OPENCODE_DB,
        };
        const dir = createTestTempDir("mc-shared-store-retention-").dir;
        mkdirSync(join(dir, "opencode"));
        process.env.XDG_DATA_HOME = dir;
        process.env.OPENCODE_DB = join(
            dir,
            "opencode",
            harness === "opencode" ? "opencode.db" : "opencode2.db",
        );
        resetOpenCodeDbPathStateForTesting();
        _resetHarnessForTesting();
        setHarness(harness);
        _resetDreamTimerForTests();
        closeDatabase();
        const local = new Database(process.env.OPENCODE_DB);
        const peer = new Database(join(dir, "opencode", "peer.db"));
        const sessionTable = harness === "opencode" ? "session" : "session_v2";
        const messageTable = harness === "opencode" ? "message" : "session_message";
        for (const host of [local, peer]) {
            host.exec(`CREATE TABLE ${sessionTable}(id TEXT PRIMARY KEY);
                CREATE TABLE ${messageTable}(id TEXT PRIMARY KEY, session_id TEXT, data TEXT);`);
        }
        local.prepare(`INSERT INTO ${sessionTable} VALUES ('ses-local')`).run();
        const sessionId = "ses-peer-idle";
        peer.prepare(`INSERT INTO ${sessionTable} VALUES (?)`).run(sessionId);
        peer.prepare(`INSERT INTO ${messageTable} VALUES ('m1', ?, ?)`).run(
            sessionId,
            JSON.stringify({ role: "user", content: "Peer raw history" }),
        );
        const db = openDatabase();
        seedRetainedSession(db, sessionId, Date.now() - 25 * 60 * 60 * 1000);
        const before = snapshotSessionRows(db, sessionId);
        const rawBefore = peer.prepare(`SELECT * FROM ${messageTable}`).all();
        expect(before.compartments).toHaveLength(40);
        expect(before.source_contents).toHaveLength(1);
        expect(
            local.prepare(`SELECT id FROM ${sessionTable} WHERE id = ?`).get(sessionId),
        ).toBeNull();
        expect(
            peer.prepare(`SELECT id FROM ${sessionTable} WHERE id = ?`).get(sessionId),
        ).not.toBeNull();

        const startup: (() => void)[] = [];
        const quiet = spyOn(bootQuiet, "scheduleAfterBootQuiet").mockImplementation((task) => {
            startup.push(task);
            return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
        });
        let background: (() => void) | undefined;
        const interval = spyOn(globalThis, "setInterval").mockImplementation(((
            task: () => void,
        ) => {
            background = task;
            return { unref() {} } as unknown as ReturnType<typeof setInterval>;
        }) as typeof setInterval);
        const log = spyOn(logger, "log");
        let stop: (() => void) | undefined;
        const waitForTick = async () => {
            const deadline = performance.now() + 10_000;
            while (_isDreamTimerTickInFlightForTests() && performance.now() < deadline)
                await Bun.sleep(5);
            expect(_isDreamTimerTickInFlightForTests()).toBe(false);
            expect(
                log.mock.calls.filter(([message]) => String(message).includes("failed:")),
            ).toEqual([]);
        };
        try {
            stop = await startDreamScheduleTimer({
                directory: dir,
                projectIdentity: "git:shared-store-retention",
                harness,
                ensureRegistered: async () => {},
            });
            expect(startup).toHaveLength(1);
            startup.shift()!();
            await waitForTick();
            expect(snapshotSessionRows(db, sessionId)).toEqual(before);
            expect(background).toBeDefined();
            background!();
            await waitForTick();
            expect(snapshotSessionRows(db, sessionId)).toEqual(before);
            expect(peer.prepare(`SELECT * FROM ${messageTable}`).all()).toEqual(rawBefore);
        } finally {
            stop?.();
            _resetDreamTimerForTests();
            quiet.mockRestore();
            interval.mockRestore();
            log.mockRestore();
            closeDatabase();
            local.close();
            peer.close();
            _resetHarnessForTesting();
            setHarness(previousHarness);
            for (const [key, value] of Object.entries(previousEnv)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
            resetOpenCodeDbPathStateForTesting();
            cleanupTestTempDir(dir);
        }
    });
}
