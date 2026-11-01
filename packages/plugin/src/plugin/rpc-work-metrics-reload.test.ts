import { expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../features/magic-context/migrations";
import { initializeDatabase, LATEST_SUPPORTED_VERSION } from "../features/magic-context/storage-db";
import { computeOpenCodeWorkMetrics } from "../features/magic-context/work-metrics";
import {
    closeReadOnlySessionDb,
    withReadOnlySessionDb,
} from "../hooks/magic-context/read-session-db";
import { _resetHarnessForTesting, setHarness } from "../shared/harness";
import { Database } from "../shared/sqlite";
import { createTestTempDirFromPath } from "../shared/test-temp-dir";
import { buildSidebarSnapshot } from "./rpc-handlers";

const sessionId = "usage-reload";
const agents = [null, "build", "plan", "__proto__"];

function usage(index: number, input?: number, output?: number): string {
    const prompt = input ?? [100, 200, 0, 0, 80, 120][Math.floor((index - 1) / 4) % 6];
    return JSON.stringify({
        role: "assistant",
        agent: agents[(index - 1) % agents.length],
        tokens: {
            input: prompt,
            output: output ?? index % 11,
            cache: { read: prompt ? 20 : 0, write: prompt ? 10 : 0 },
        },
    });
}

function observeUsageReads() {
    return withReadOnlySessionDb((host) => {
        const prepare = host.prepare.bind(host);
        const rowsRead: number[] = [];
        const plans: string[] = [];
        const spy = spyOn(host, "prepare").mockImplementation((sql: string) => {
            const statement = prepare(sql);
            if (!sql.includes("FROM newer")) return statement;
            return {
                all: (...params: unknown[]) => {
                    const rows = statement.all(...params);
                    rowsRead.push(rows.length);
                    plans.push(
                        ...(
                            prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
                                detail: string;
                            }>
                        ).map((row) => row.detail),
                    );
                    return rows;
                },
            } as typeof statement;
        });
        return { rowsRead, plans, restore: () => spy.mockRestore() };
    }, "v2");
}

function observeSessionWrites(db: Database) {
    const prepare = db.prepare.bind(db);
    const exec = db.exec.bind(db);
    let updates = 0;
    let writeTransactions = 0;
    const prepareSpy = spyOn(db, "prepare").mockImplementation((sql: string) => {
        const statement = prepare(sql);
        if (!/^\s*UPDATE\s+session_meta\b/i.test(sql)) return statement;
        return {
            run: (...params: unknown[]) => {
                updates++;
                return statement.run(...params);
            },
        } as typeof statement;
    });
    const execSpy = spyOn(db, "exec").mockImplementation((sql: string) => {
        if (/^\s*BEGIN\s+(?:IMMEDIATE|EXCLUSIVE)\b/i.test(sql)) writeTransactions++;
        return exec(sql);
    });
    return {
        counts: () => ({ updates, writeTransactions }),
        reset: () => {
            updates = 0;
            writeTransactions = 0;
        },
        restore: () => {
            prepareSpy.mockRestore();
            execSpy.mockRestore();
        },
    };
}

for (const count of [1_000, 40_000]) {
    test(`OpenCode 2 fresh RPC module resumes persisted usage carry at ${count} assistant rows`, async () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "rpc-usage-reload-"));
        const previousPath = process.env.OPENCODE_DB;
        const hostPath = join(root, "opencode.db");
        const contextPath = join(root, "context.db");
        const host = new Database(hostPath);
        host.exec("PRAGMA journal_mode = WAL");
        const oracle = new Database(":memory:");
        let db = new Database(contextPath);
        let observed: ReturnType<typeof observeUsageReads> | undefined;
        let writes: ReturnType<typeof observeSessionWrites> | undefined;
        try {
            closeReadOnlySessionDb();
            _resetHarnessForTesting();
            setHarness("opencode2");
            process.env.OPENCODE_DB = hostPath;
            initializeDatabase(db);
            runMigrations(db);
            expect(LATEST_SUPPORTED_VERSION).toBe(95);
            const calibration = { magicContextTokenizerCalibration: { hygieneUnitsVersion: 2 } };
            db.prepare(
                "INSERT INTO session_meta (session_id, deferred_execute_state) VALUES (?, ?)",
            ).run(sessionId, JSON.stringify(calibration));
            host.exec(`CREATE TABLE session_message (
                id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
                time_created INTEGER, data TEXT);
                CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message(session_id, seq);
                CREATE INDEX session_message_session_type_seq_idx ON session_message(session_id, type, seq);`);
            oracle.exec(
                "CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)",
            );
            const insert = (index: number, data: string) => {
                host.prepare("INSERT INTO session_message VALUES (?, ?, 'assistant', ?, ?, ?)").run(
                    `m${index}`,
                    sessionId,
                    index,
                    count - index,
                    data,
                );
                // The independent window-function oracle uses v1 timestamps;
                // mirror v2 sequence order, not its deliberately reversed clock.
                oracle
                    .prepare("INSERT INTO message VALUES (?, ?, ?, ?)")
                    .run(`m${index}`, sessionId, index, data);
            };
            host.transaction(() => {
                for (let index = 1; index <= count; index++) insert(index, usage(index));
            })();

            observed = observeUsageReads();
            const before = buildSidebarSnapshot(db, sessionId, root);
            expect(before).toMatchObject(computeOpenCodeWorkMetrics(oracle, sessionId));
            expect(observed.rowsRead).toEqual([count]);
            observed.restore();
            observed = undefined;
            closeReadOnlySessionDb();
            db.close();
            db = new Database(contextPath);

            // A distinct module instance has none of the previous RPC module's maps.
            const reloaded = await import(`./rpc-handlers.ts?usage-reload=${count}`);
            expect(reloaded.buildSidebarSnapshot).not.toBe(buildSidebarSnapshot);
            observed = observeUsageReads();
            writes = observeSessionWrites(db);
            const after = reloaded.buildSidebarSnapshot(db, sessionId, root);
            expect(after).toMatchObject({
                newWorkTokens: before.newWorkTokens,
                totalInputTokens: before.totalInputTokens,
            });
            expect(observed.rowsRead).toEqual([1]);
            expect(writes.counts()).toEqual({ updates: 0, writeTransactions: 0 });
            expect(reloaded.buildSidebarSnapshot(db, sessionId, root)).toMatchObject({
                newWorkTokens: before.newWorkTokens,
                totalInputTokens: before.totalInputTokens,
            });
            expect(observed.rowsRead).toEqual([1, 1]);
            expect(writes.counts()).toEqual({ updates: 0, writeTransactions: 0 });
            console.log(
                `ISSUE_825_RELOAD assistantRows=${count} initialRows=${count} reloadRows=${observed.rowsRead[0]} idleUpdates=${writes.counts().updates} idleWriteTransactions=${writes.counts().writeTransactions}`,
            );

            // The held-back row can finish streaming after the module reload.
            const finalUsage = usage(count, 333, 77);
            host.prepare("UPDATE session_message SET data = ? WHERE id = ?").run(
                finalUsage,
                `m${count}`,
            );
            oracle.prepare("UPDATE message SET data = ? WHERE id = ?").run(finalUsage, `m${count}`);
            // Resume through a fresh host connection after each simulated restart,
            // discarding the old reader's SQLite snapshot along with its handle.
            observed.restore();
            closeReadOnlySessionDb();
            observed = observeUsageReads();
            expect(reloaded.buildSidebarSnapshot(db, sessionId, root)).toMatchObject(
                computeOpenCodeWorkMetrics(oracle, sessionId),
            );
            expect(observed.rowsRead).toEqual([1]);
            expect(writes.counts()).toEqual({ updates: 1, writeTransactions: 1 });
            writes.reset();
            host.transaction(() => insert(count + 1, usage(count + 1, 444, 88))).immediate();
            observed.restore();
            closeReadOnlySessionDb();
            observed = observeUsageReads();
            expect(reloaded.buildSidebarSnapshot(db, sessionId, root)).toMatchObject(
                computeOpenCodeWorkMetrics(oracle, sessionId),
            );
            expect(observed.rowsRead).toEqual([2]);
            expect(writes.counts()).toEqual({ updates: 1, writeTransactions: 1 });
            expect(observed.plans.some((plan) => /SEARCH session_message.*seq>\?/.test(plan))).toBe(
                true,
            );
            expect(observed.plans.some((plan) => /SCAN session_message/.test(plan))).toBe(false);
            const rootState = JSON.parse(
                db
                    .prepare("SELECT deferred_execute_state FROM session_meta WHERE session_id = ?")
                    .get(sessionId)!.deferred_execute_state as string,
            );
            expect(rootState.magicContextTokenizerCalibration).toEqual(
                calibration.magicContextTokenizerCalibration,
            );
            expect(rootState.magicContextWorkMetrics.lastTimeCreated).toBe(count);
        } finally {
            observed?.restore();
            writes?.restore();
            closeReadOnlySessionDb();
            _resetHarnessForTesting();
            if (previousPath === undefined) delete process.env.OPENCODE_DB;
            else process.env.OPENCODE_DB = previousPath;
            host.close();
            oracle.close();
            db.close();
            rmSync(root, { recursive: true, force: true });
        }
    });
}
