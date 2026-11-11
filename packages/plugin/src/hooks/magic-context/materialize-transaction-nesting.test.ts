import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import * as appliedProjection from "../../features/magic-context/memory/applied-projection";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database, isSqliteTransactionOpen } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { materializeM0 } from "./inject-compartments";

// materializeM0 opens two transactions of its own: a read snapshot for its
// inputs and a write section that stores the new history head. A caller that
// already holds a transaction on the connection (the OpenCode 2 manual-compact
// staging renders inside one and rolls it back) needs both to nest as
// savepoints, because SQLite refuses a nested BEGIN and a COMMIT would end the
// caller's transaction. Every other caller must see exactly the statements it
// saw before nesting existed.

const SESSION = "materialize-nesting-session";
const databases: Database[] = [];

afterEach(() => {
    for (const db of databases.splice(0)) closeQuietly(db);
});

function store(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    getOrCreateSessionMeta(db, SESSION);
    appendCompartments(db, SESSION, [
        {
            sequence: 0,
            startMessage: 1,
            endMessage: 4,
            startMessageId: "m1",
            endMessageId: "m4",
            title: "Reviewed the cache policy",
            content: "Reviewed the cache policy and kept the frozen head.",
            p1: "Reviewed the cache policy and kept the frozen head.",
            p2: "Reviewed the cache policy.",
            p3: "Cache policy reviewed.",
            p4: "Cache policy.",
        },
    ]);
    databases.push(db);
    return db;
}

const fold = (db: Database, options: Record<string, unknown> = {}) =>
    materializeM0({
        db,
        sessionId: SESSION,
        state: getOrCreateSessionMeta(db, SESSION),
        projectDirectory: "",
        injectDocs: false,
        ...options,
    });

/** Every statement handed to the connection through exec or prepare, and every run of a statement prepared meanwhile. */
function recordStatements(db: Database) {
    const statements: string[] = [];
    const exec = db.exec.bind(db);
    const prepare = db.prepare.bind(db);
    const execSpy = spyOn(db, "exec").mockImplementation((sql: string) => {
        statements.push(`exec ${sql}`);
        return exec(sql);
    });
    const prepareSpy = spyOn(db, "prepare").mockImplementation(((sql: string) => {
        statements.push(`prepare ${sql}`);
        const statement = prepare(sql);
        for (const method of ["run", "get", "all"] as const) {
            const original = statement[method].bind(statement);
            Object.defineProperty(statement, method, {
                configurable: true,
                value: (...args: unknown[]) => {
                    statements.push(`${method} ${sql}`);
                    return (original as (...values: unknown[]) => unknown)(...args);
                },
            });
        }
        return statement;
    }) as typeof db.prepare);
    return {
        statements,
        restore() {
            execSpy.mockRestore();
            prepareSpy.mockRestore();
        },
    };
}

/** The stored head and the tables a fold writes, read back as plain values. */
function storedHead(db: Database) {
    const rows = (sql: string) =>
        (db.prepare(sql).all(SESSION) as Record<string, unknown>[]).map((row) =>
            Object.fromEntries(
                Object.entries(row).map(([key, value]) => [
                    key,
                    value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : value,
                ]),
            ),
        );
    return {
        meta: rows("SELECT * FROM session_meta WHERE session_id = ?"),
        payloads: rows(
            "SELECT cache_key, value FROM session_render_cache WHERE session_id = ? ORDER BY cache_key",
        ),
        chunks: rows(
            "SELECT column_name, chunk, body FROM session_meta_chunks WHERE session_id = ? ORDER BY column_name, chunk",
        ),
        projection: rows("SELECT * FROM memory_applied_snapshots WHERE session_id = ?"),
    };
}

describe("materializeM0 transaction boundaries", () => {
    it("an ordinary fold runs exactly the statements it ran before nesting existed", () => {
        const db = store();
        const recording = recordStatements(db);
        try {
            fold(db);
        } finally {
            recording.restore();
        }
        const { statements } = recording;
        if (process.env.MC_RECORD_FOLD_STATEMENTS === "1")
            console.log(JSON.stringify({ statements }, null, 1));
        const control = statements.filter((line) =>
            /^exec\s*(BEGIN|COMMIT|ROLLBACK|END|SAVEPOINT|RELEASE)\b/i.test(line),
        );
        expect(control).toEqual(BASE_TRANSACTION_CONTROL);
        expect({
            count: statements.length,
            sha256: createHash("sha256").update(statements.join("\n")).digest("hex"),
        }).toEqual(BASE_STATEMENTS);
    });

    it("inside a caller's transaction, a fold nests and the caller's rollback undoes it", () => {
        const db = store();
        const before = storedHead(db);
        let inside: ReturnType<typeof storedHead> | undefined;
        const rollback = new Error("roll the caller's transaction back");
        expect(() =>
            db
                .transaction(() => {
                    fold(db);
                    inside = storedHead(db);
                    throw rollback;
                })
                .immediate(),
        ).toThrow(rollback.message);
        expect(isSqliteTransactionOpen(db)).toBe(false);
        expect(JSON.stringify(inside?.payloads)).toContain("Reviewed the cache policy");
        expect(storedHead(db)).toEqual(before);
        // Committed instead, the caller keeps the head the nested fold stored.
        db.transaction(() => fold(db)).immediate();
        expect(JSON.stringify(storedHead(db).payloads)).toContain("Reviewed the cache policy");
    });

    // A failure at each of the fold's transactions: its read snapshot, the
    // contention check that opens its write section, and a write inside that
    // section. Each must leave the caller's transaction open and usable, and
    // the caller's rollback must leave the store as it was.
    const failures: Array<
        [string, string, (db: Database) => { options?: Record<string, unknown>; undo(): void }]
    > = [
        [
            "a throw inside the read snapshot",
            "read failed",
            () => {
                const spy = spyOn(appliedProjection, "readMemoryRevisions").mockImplementation(
                    () => {
                        throw new Error("read failed");
                    },
                );
                return { undo: () => spy.mockRestore() };
            },
        ],
        [
            "a contention refusal at the write section",
            "snapshot changed before Phase 3",
            (db) => ({
                options: {
                    beforeCacheCommitForTest: () =>
                        appendCompartments(db, SESSION, [
                            {
                                sequence: 1,
                                startMessage: 5,
                                endMessage: 6,
                                startMessageId: "m5",
                                endMessageId: "m6",
                                title: "Published while the fold rendered",
                                content: "Published while the fold rendered.",
                            },
                        ]),
                },
                undo: () => {},
            }),
        ],
        [
            "a throw inside the write section",
            "write failed",
            () => {
                const spy = spyOn(appliedProjection, "writeHardProjection").mockImplementation(
                    () => {
                        throw new Error("write failed");
                    },
                );
                return { undo: () => spy.mockRestore() };
            },
        ],
    ];
    for (const [name, failure, inject] of failures) {
        it(`inside a caller's transaction, ${name} leaves that transaction usable and the store unchanged`, () => {
            const db = store();
            const before = storedHead(db);
            const injected = inject(db);
            const rollback = new Error("roll the caller's transaction back");
            let usable = false;
            try {
                expect(() =>
                    db
                        .transaction(() => {
                            expect(() => fold(db, injected.options)).toThrow(failure);
                            // The caller's transaction is still open and accepts a write.
                            usable =
                                isSqliteTransactionOpen(db) &&
                                db
                                    .prepare(
                                        "UPDATE session_meta SET last_response_time = 42 WHERE session_id = ?",
                                    )
                                    .run(SESSION).changes === 1;
                            throw rollback;
                        })
                        .immediate(),
                ).toThrow(rollback.message);
            } finally {
                injected.undo();
            }
            expect(usable).toBe(true);
            expect(isSqliteTransactionOpen(db)).toBe(false);
            expect(storedHead(db)).toEqual(before);
        });
    }
});

// Recorded on the commit before the boundaries could nest (MC_RECORD_FOLD_STATEMENTS=1).
const BASE_TRANSACTION_CONTROL: string[] = [
    "exec BEGIN",
    "exec COMMIT",
    "exec BEGIN IMMEDIATE",
    "exec SAVEPOINT mc_tx_sp",
    "exec RELEASE mc_tx_sp",
    "exec SAVEPOINT mc_tx_sp",
    "exec RELEASE mc_tx_sp",
    "exec SAVEPOINT mc_tx_sp",
    "exec RELEASE mc_tx_sp",
    "exec COMMIT",
];
const BASE_STATEMENTS = {
    count: 77,
    sha256: "afe634e609ef4c78e49fdbaa08a0a1736dc86274bdda2a920f5369c45d15a480",
};
