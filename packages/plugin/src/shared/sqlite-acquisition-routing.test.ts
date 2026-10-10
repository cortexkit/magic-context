import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    Database,
    SqliteAcquisitionBusyError,
    withAsyncPrivilegedWriter,
    withPrivilegedWriter,
    withSqliteTransformPass,
} from "./sqlite";
import { startSqliteWriteLocker } from "./sqlite-write-locker-test-support";
import { createTestTempDirFromPath } from "./test-temp-dir";

test("async writer never retries callback acquisition errors after work began", async () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE context_privilege_state(id INTEGER PRIMARY KEY, enabled INTEGER)");
    let calls = 0;
    try {
        await expect(
            withAsyncPrivilegedWriter(db, () => {
                calls++;
                throw new SqliteAcquisitionBusyError(new Error("nested BEGIN"));
            }),
        ).rejects.toThrow("acquisition remained busy");
        expect(calls).toBe(1);
    } finally {
        db.close();
    }
});

for (const mode of ["default", "immediate", "exclusive", "literal"] as const) {
    test(`shared SQLite retries ${mode} acquisition before running any writes`, async () => {
        const dir = createTestTempDirFromPath(join(tmpdir(), "mc-routed-acquisition-"));
        const path = join(dir, "context.db");
        const db = new Database(path);
        db.exec(
            "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=50; CREATE TABLE result(value TEXT); CREATE TABLE context_privilege_state(id INTEGER PRIMARY KEY, enabled INTEGER)",
        );
        const locker = await startSqliteWriteLocker(path, 650);
        let calls = 0;
        const write = () => {
            calls++;
            db.prepare("INSERT INTO result VALUES (?)").run("once");
            return "managed";
        };
        try {
            await withSqliteTransformPass(async () => {
                await withAsyncPrivilegedWriter(db, () => undefined);
                if (mode === "literal") {
                    db.exec("BEGIN IMMEDIATE");
                    write();
                    db.exec("COMMIT");
                } else {
                    const transaction = db.transaction(write);
                    expect(mode === "default" ? transaction() : transaction[mode]()).toBe(
                        "managed",
                    );
                }
            });
            expect(calls).toBe(1);
            expect(db.prepare("SELECT * FROM result").all()).toEqual([{ value: "once" }]);
        } finally {
            await locker.exited;
            db.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 30000);
}

test("routed transactions preserve nesting, receiver, arguments and rollback without callback retries", () => {
    const db = new Database(":memory:");
    db.exec(
        "CREATE TABLE result(value TEXT); CREATE TABLE context_privilege_state(id INTEGER PRIMARY KEY, enabled INTEGER)",
    );
    let calls = 0;
    const transaction = db.transaction(function (this: { prefix: string }, value: string) {
        calls++;
        db.prepare("INSERT INTO result VALUES (?)").run(this.prefix + value);
        db.transaction(() => {
            db.exec("INSERT INTO result VALUES ('inner')");
        }).immediate();
        throw Object.assign(new Error("busy after writes"), { code: "SQLITE_BUSY" });
    });
    try {
        expect(() =>
            withSqliteTransformPass(() => transaction.call({ prefix: "outer-" }, "value")),
        ).toThrow("busy after writes");
        expect(calls).toBe(1);
        expect(db.prepare("SELECT * FROM result").all()).toEqual([]);
    } finally {
        db.close();
    }
});

test("exhausted routed acquisition never enters the callback or multiplies privileged retries", () => {
    const dir = createTestTempDirFromPath(join(tmpdir(), "mc-routed-exhaustion-"));
    const path = join(dir, "context.db");
    const blocker = new Database(path);
    const db = new Database(path);
    blocker.exec(
        "PRAGMA journal_mode=WAL; CREATE TABLE result(value TEXT); CREATE TABLE context_privilege_state(id INTEGER PRIMARY KEY, enabled INTEGER)",
    );
    db.exec("PRAGMA busy_timeout=0");
    blocker.exec("BEGIN IMMEDIATE");
    let callbacks = 0;
    try {
        for (const run of [
            () => db.transaction(() => callbacks++)(),
            () => withPrivilegedWriter(db, () => callbacks++),
        ]) {
            expect(() => withSqliteTransformPass(run)).toThrow("acquisition remained busy");
            expect(callbacks).toBe(0);
        }
    } finally {
        blocker.exec("ROLLBACK");
        blocker.close();
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

for (const mode of ["run", "get", "all", "exec"] as const) {
    test(`foreground ${mode} autocommit waits share one turn budget and restore production timeout`, () => {
        const dir = createTestTempDirFromPath(join(tmpdir(), "mc-autocommit-budget-"));
        const path = join(dir, "context.db");
        const db = new Database(path);
        db.exec(
            "PRAGMA journal_mode=WAL; CREATE TABLE result(value TEXT); PRAGMA busy_timeout=5000",
        );
        const blocker = new Database(path);
        blocker.exec("BEGIN IMMEDIATE");
        try {
            const started = performance.now();
            withSqliteTransformPass(() => {
                for (let attempt = 0; attempt < 3; attempt++) {
                    // Nested foreground wrappers must reuse the turn's remaining budget.
                    expect(() =>
                        withSqliteTransformPass(() => {
                            if (mode === "exec") db.exec("INSERT INTO result VALUES ('blocked')");
                            else
                                db.prepare("INSERT INTO result VALUES ('blocked') RETURNING value")[
                                    mode
                                ]();
                        }),
                    ).toThrow("acquisition remained busy");
                }
                expect(() => db.exec("BEGIN IMMEDIATE")).toThrow("acquisition remained busy");
            });
            expect(performance.now() - started).toBeLessThan(650);
            expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
            expect(db.prepare("SELECT * FROM result").all()).toEqual([]);
            blocker.exec("ROLLBACK");
            withSqliteTransformPass(() => db.prepare("INSERT INTO result VALUES ('free')").run());
            expect(db.prepare("SELECT * FROM result").all()).toEqual([{ value: "free" }]);
        } finally {
            if (blocker.inTransaction) blocker.exec("ROLLBACK");
            blocker.close();
            db.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });
}
