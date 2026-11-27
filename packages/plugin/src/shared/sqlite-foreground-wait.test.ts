import { expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StorageBusyRefusalError } from "../hooks/magic-context/storage-busy-refusal";
import { createMessagesTransformHandler } from "../plugin/messages-transform";
import { log } from "./logger";
import {
    Database,
    guardSqliteTransformPass,
    registerSqliteDiagnosticSink,
    SqliteAcquisitionBusyError,
    withPrivilegedWriter,
    withSqliteTransformPass,
} from "./sqlite";
import { type SqliteWriteLocker, startSqliteWriteLocker } from "./sqlite-write-locker-test-support";
import { createTestTempDirFromPath } from "./test-temp-dir";

function fixture() {
    const dir = createTestTempDirFromPath(join(tmpdir(), "mc-foreground-wait-"));
    const path = join(dir, "context.db");
    const db = new Database(path);
    db.exec(`
        PRAGMA journal_mode=WAL;
        PRAGMA busy_timeout=5000;
        CREATE TABLE context_privilege_state(id INTEGER PRIMARY KEY, enabled INTEGER);
        CREATE TABLE result(value TEXT);
    `);
    return {
        db,
        path,
        close() {
            db.close();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

for (const holdMs of [1000, 2500]) {
    test(holdMs === 1000
        ? "a transform commits and serves managed output after a 1s in-pass writer lock"
        : "a transform refuses a 2.5s in-pass writer lock without raw fallback and logs the real wait", async () => {
        const { db, path, close } = fixture();
        const sessionId = `foreground-wait-${holdMs}`;
        const output = {
            messages: [
                {
                    info: { id: "u", sessionID: sessionId, role: "user" },
                    parts: [{ type: "text", text: "raw input must not be served on failure" }],
                },
            ],
        };
        let locker: SqliteWriteLocker | undefined;
        let refusals = 0;
        let served = false;
        let waitedMs = 0;
        const diagnostics: string[] = [];
        registerSqliteDiagnosticSink((line) => diagnostics.push(line));
        const handler = createMessagesTransformHandler({
            onRefusal: async (id) => {
                expect(id).toBe(sessionId);
                refusals++;
            },
            magicContext: {
                "experimental.chat.messages.transform": async (_input, result) => {
                    // Start the competing writer only once the transform callback begins;
                    // otherwise the wrapper's yielding lock check would absorb the wait.
                    locker = await startSqliteWriteLocker(path, holdMs);
                    const started = performance.now();
                    try {
                        withPrivilegedWriter(db, () => {
                            db.prepare("INSERT INTO result VALUES ('managed')").run();
                        });
                    } finally {
                        waitedMs = performance.now() - started;
                    }
                    (result.messages[0].parts[0] as { text: string }).text = "managed output";
                },
            },
        });
        try {
            const pass = handler({}, output as Parameters<typeof handler>[1]).then((messages) => {
                served = true;
                return messages;
            });
            if (holdMs === 1000) {
                await pass;
                expect(served).toBe(true);
                expect(refusals).toBe(0);
                expect(output.messages[0].parts[0].text).toBe("managed output");
                expect(db.prepare("SELECT * FROM result").all()).toEqual([{ value: "managed" }]);
                expect(waitedMs).toBeGreaterThanOrEqual(900);
            } else {
                await expect(pass).rejects.toBeInstanceOf(StorageBusyRefusalError);
                expect(served).toBe(false);
                expect(refusals).toBe(1);
                expect(db.prepare("SELECT * FROM result").all()).toEqual([]);
                expect(waitedMs).toBeGreaterThanOrEqual(1900);
                expect(waitedMs).toBeLessThan(2400);
                const busy = diagnostics.filter((line) => line.includes("outcome=busy"));
                expect(busy).toHaveLength(1);
                expect(busy[0]).toContain("lane=foreground");
                const reportedMs = Number(/acquire_ms=(\d+)/.exec(busy[0])?.[1]);
                expect(Math.abs(reportedMs - waitedMs)).toBeLessThan(100);
            }
            expect(db.inTransaction).toBe(false);
            expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
        } finally {
            registerSqliteDiagnosticSink(log);
            if (locker) expect(await locker.exited).toBe(0);
            close();
        }
    }, 30_000);
}

for (const holdMs of [1000, 2500]) {
    test(`slow uncontended SQL preserves admission for a ${holdMs}ms autocommit lock`, async () => {
        const { db, path, close } = fixture();
        let locker: SqliteWriteLocker | undefined;
        let served = false;
        let refusals = 0;
        const output = {
            messages: [
                {
                    info: { id: "u", sessionID: "slow", role: "user" },
                    parts: [{ type: "text", text: "raw" }],
                },
            ],
        };
        const handler = createMessagesTransformHandler({
            onRefusal: async () => {
                refusals++;
            },
            magicContext: {
                "experimental.chat.messages.transform": async (_input, result) => {
                    // Spend three seconds inside successful SQL, not between writes.
                    // Recursive work keeps this independent of CPU speed and UDF APIs.
                    const cte =
                        "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000)";
                    const slowWrite = db.prepare(
                        `${cte} INSERT INTO result SELECT sum(x) FROM n RETURNING value`,
                    );
                    const slowRead = db.prepare(`${cte} SELECT sum(x) FROM n`);
                    const started = performance.now();
                    do {
                        slowWrite.all();
                        slowRead.all();
                    } while (performance.now() - started < 3000);
                    locker = await startSqliteWriteLocker(path, holdMs);
                    db.prepare("INSERT INTO result VALUES ('managed')").run();
                    (result.messages[0].parts[0] as { text: string }).text = "managed";
                },
            },
        });
        try {
            const pass = handler({}, output as Parameters<typeof handler>[1]).then(() => {
                served = true;
            });
            if (holdMs === 1000) {
                await pass;
                expect(served).toBe(true);
                expect(refusals).toBe(0);
                expect(output.messages[0].parts[0].text).toBe("managed");
            } else {
                await expect(pass).rejects.toBeInstanceOf(StorageBusyRefusalError);
                expect(served).toBe(false);
                expect(refusals).toBe(1);
                expect(output.messages[0].parts[0].text).toBe("raw");
            }
            expect(
                db.prepare("SELECT count(*) AS n FROM result WHERE value = 'managed'").get(),
            ).toEqual({ n: holdMs === 1000 ? 1 : 0 });
        } finally {
            if (locker) expect(await locker.exited).toBe(0);
            close();
        }
    }, 30_000);
}

test("BUSY autocommit probes do not double-apply INSERT OR IGNORE, UPSERT or RETURNING", async () => {
    const { db, path, close } = fixture();
    db.exec(
        "CREATE TABLE counter(id INTEGER PRIMARY KEY, n INTEGER); INSERT INTO counter VALUES (1, 0)",
    );
    const forms = [
        ["INSERT OR IGNORE INTO counter VALUES (2, 1)", "run"],
        ["INSERT INTO counter VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET n = n + 1", "run"],
        ["UPDATE counter SET n = n + 1 WHERE id = 1 RETURNING n", "get"],
        [
            "INSERT INTO counter VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET n = n + 1 RETURNING n",
            "all",
        ],
    ] as const;
    try {
        for (const [sql, method] of forms) {
            const blocker = new Database(path);
            blocker.exec("BEGIN IMMEDIATE");
            db.exec("PRAGMA busy_timeout=0");
            const before = db.prepare("SELECT * FROM counter ORDER BY id").all();
            try {
                expect(() => db.prepare(sql)[method]()).toThrow("locked");
                expect(db.prepare("SELECT * FROM counter ORDER BY id").all()).toEqual(before);
                expect(db.inTransaction).toBe(false);
            } finally {
                blocker.exec("ROLLBACK");
                blocker.close();
            }
            const locker = await startSqliteWriteLocker(path, 100);
            try {
                await withSqliteTransformPass(() => db.prepare(sql)[method]());
            } finally {
                expect(await locker.exited).toBe(0);
            }
        }
        expect(db.prepare("SELECT * FROM counter ORDER BY id").all()).toEqual([
            { id: 1, n: 3 },
            { id: 2, n: 1 },
        ]);
    } finally {
        close();
    }
}, 30_000);

test("many contended autocommit writes share at most two seconds of lock waiting", async () => {
    const { db, path, close } = fixture();
    const blocker = new Database(path);
    blocker.exec("BEGIN IMMEDIATE");
    const timeouts: number[] = [];
    const nativeExec = db.exec.bind(db);
    const exec = spyOn(db, "exec").mockImplementation((sql) => {
        const timeout = /^PRAGMA busy_timeout=(\d+)$/.exec(sql);
        if (timeout) timeouts.push(Number(timeout[1]));
        return nativeExec(sql);
    });
    try {
        await withSqliteTransformPass(() => {
            // Use real BUSY failures but a controlled accounting clock: each
            // retry costs 400ms regardless of runner scheduling. The deadline
            // keeps the real waits short without hiding lease exhaustion.
            guardSqliteTransformPass({ assert() {}, remainingMs: () => 10 });
            let now = 0;
            const clock = spyOn(performance, "now").mockImplementation(() => (now += 400));
            try {
                for (let i = 0; i < 8; i++) {
                    expect(() => db.prepare("INSERT INTO result VALUES ('one')").run()).toThrow(
                        SqliteAcquisitionBusyError,
                    );
                }
            } finally {
                clock.mockRestore();
            }
            // Five charged retries exhaust 2000ms. All later retries must have
            // zero timeout even though the deadline still offers another 10ms.
            expect(timeouts).toEqual([
                ...Array.from({ length: 5 }, () => [0, 10, 5000]).flat(),
                ...Array.from({ length: 3 }, () => [0, 0, 5000]).flat(),
            ]);
            blocker.exec("ROLLBACK");
            db.prepare("INSERT INTO result VALUES ('uncontended')").run();
        });
        expect(db.prepare("SELECT * FROM result").all()).toEqual([{ value: "uncontended" }]);
    } finally {
        exec.mockRestore();
        if (blocker.inTransaction) blocker.exec("ROLLBACK");
        blocker.close();
        close();
    }
}, 30_000);

test("an exec script charges its single attempt without a zero-wait probe", () => {
    const { db, path, close } = fixture();
    const blocker = new Database(path);
    const timeouts: number[] = [];
    const nativeExec = db.exec.bind(db);
    const exec = spyOn(db, "exec").mockImplementation((sql) => {
        const timeout = /^PRAGMA busy_timeout=(\d+)$/.exec(sql);
        if (timeout) timeouts.push(Number(timeout[1]));
        return nativeExec(sql);
    });
    try {
        withSqliteTransformPass(() => {
            let now = 0;
            const clock = spyOn(performance, "now").mockImplementation(() => (now += 2500));
            try {
                db.exec(
                    "INSERT INTO result VALUES ('prefix'); INSERT INTO result VALUES ('suffix')",
                );
            } finally {
                clock.mockRestore();
            }
            blocker.exec("BEGIN IMMEDIATE");
            expect(() => db.prepare("INSERT INTO result VALUES ('blocked')").run()).toThrow(
                SqliteAcquisitionBusyError,
            );
        });
        expect(timeouts).toEqual([2000, 5000, 0, 0, 5000]);
        expect(db.prepare("SELECT * FROM result").all()).toEqual([
            { value: "prefix" },
            { value: "suffix" },
        ]);
    } finally {
        exec.mockRestore();
        if (blocker.inTransaction) blocker.exec("ROLLBACK");
        blocker.close();
        close();
    }
});

test("an explicit transaction keeps its timeout and never probes or retries", () => {
    const { db, path, close } = fixture();
    const other = new Database(path);
    db.exec("PRAGMA busy_timeout=0; BEGIN; SELECT * FROM result");
    other.exec("INSERT INTO result VALUES ('other')");
    const exec = spyOn(db, "exec");
    try {
        withSqliteTransformPass(() => {
            expect(() => db.prepare("INSERT INTO result VALUES ('stale')").run()).toThrow("locked");
        });
        expect(exec).not.toHaveBeenCalled();
        expect(db.inTransaction).toBe(true);
        expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 0 });
    } finally {
        exec.mockRestore();
        if (db.inTransaction) db.exec("ROLLBACK");
        other.close();
        close();
    }
});

for (const mode of ["BEGIN", "autocommit"]) {
    test(`foreground ${mode} wait is capped by the pass deadline`, () => {
        const { db, path, close } = fixture();
        const blocker = new Database(path);
        blocker.exec("BEGIN IMMEDIATE");
        try {
            const started = performance.now();
            withSqliteTransformPass(() => {
                guardSqliteTransformPass({ assert() {}, remainingMs: () => 100 });
                expect(() => {
                    if (mode === "BEGIN") withPrivilegedWriter(db, () => undefined);
                    else db.prepare("INSERT INTO result VALUES ('late')").run();
                }).toThrow(SqliteAcquisitionBusyError);
            });
            expect(performance.now() - started).toBeGreaterThanOrEqual(75);
            expect(performance.now() - started).toBeLessThan(700);
            expect(db.prepare("SELECT * FROM result").all()).toEqual([]);
            expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
        } finally {
            blocker.exec("ROLLBACK");
            blocker.close();
            close();
        }
    });
}

test("an autocommit exec script never replays a committed prefix after BUSY", () => {
    const main = fixture();
    const auxiliary = fixture();
    const free = fixture();
    try {
        main.db.prepare("ATTACH DATABASE ? AS aux").run(auxiliary.path);
        main.db.prepare("ATTACH DATABASE ? AS free").run(free.path);
        auxiliary.db.exec("BEGIN IMMEDIATE");
        withSqliteTransformPass(() => {
            guardSqliteTransformPass({ assert() {}, remainingMs: () => 100 });
            expect(() =>
                main.db.exec(
                    "INSERT INTO main.result VALUES ('prefix'); INSERT INTO aux.result VALUES ('blocked')",
                ),
            ).toThrow(SqliteAcquisitionBusyError);
            expect(() =>
                main.db.exec(
                    "CREATE TABLE applied_once(id); INSERT INTO aux.result VALUES ('blocked')",
                ),
            ).toThrow(SqliteAcquisitionBusyError);
            expect(() =>
                main.db.exec(
                    "CREATE TABLE free.applied_once(id); INSERT INTO aux.result VALUES ('blocked')",
                ),
            ).toThrow(SqliteAcquisitionBusyError);
        });
        expect(main.db.prepare("SELECT * FROM main.result").all()).toEqual([{ value: "prefix" }]);
        expect(
            main.db.prepare("SELECT name FROM sqlite_schema WHERE name='applied_once'").all(),
        ).toHaveLength(1);
    } finally {
        auxiliary.db.exec("ROLLBACK");
        auxiliary.close();
        main.close();
        free.close();
    }
});
