/// <reference types="bun-types" />

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { createCompactionHandler } from "./compaction";
import { toDatabase } from "./mock-database";

//#given
const makeDb = () => {
    const prepare = mock((_sql: string) => ({
        run: mock((_sessionId: string) => {}),
    }));

    const transaction = mock((callback: () => void) => {
        return () => callback();
    });

    return { prepare, transaction };
};

describe("createCompactionHandler", () => {
    let handler: ReturnType<typeof createCompactionHandler>;

    beforeEach(() => {
        handler = createCompactionHandler();
    });

    describe("onCompacted", () => {
        it("clears pending_ops for session", () => {
            //#given
            const db = makeDb();
            //#when
            handler.onCompacted("session-1", toDatabase(db));
            //#then
            expect(db.prepare).toHaveBeenCalledWith("DELETE FROM pending_ops WHERE session_id = ?");
            const stmt = db.prepare.mock.results[0]?.value as { run: ReturnType<typeof mock> };
            expect(stmt.run).toHaveBeenCalledWith("session-1");
        });

        it("wraps DB mutations in a transaction", () => {
            //#given
            const db = makeDb();

            //#when
            handler.onCompacted("session-1", toDatabase(db));

            //#then
            expect(db.transaction).toHaveBeenCalledTimes(2);
        });

        it("marks tags as compacted instead of deleting", () => {
            //#given
            const db = makeDb();
            //#when
            handler.onCompacted("session-1", toDatabase(db));
            //#then
            const allSqls = db.prepare.mock.calls.map((call: [string]) => call[0]);
            const hasTagUpdate = allSqls.some(
                (sql: string) =>
                    sql.includes("UPDATE tags SET status = 'compacted'") &&
                    sql.includes("session_id"),
            );
            expect(hasTagUpdate).toBe(true);
        });

        it("does not delete source contents during compaction", () => {
            //#given
            const db = makeDb();
            //#when
            handler.onCompacted("session-1", toDatabase(db));
            //#then
            const allSqls = db.prepare.mock.calls.map((call: [string]) => call[0]);
            const hasSourceDelete = allSqls.some((sql: string) =>
                sql.includes("DELETE FROM source_contents"),
            );
            expect(hasSourceDelete).toBe(false);
        });

        it("resets rolling nudge band via updateSessionMeta after compaction", () => {
            //#given
            const db = makeDb();
            //#when
            handler.onCompacted("session-1", toDatabase(db));
            //#then
            const allSqls = db.prepare.mock.calls.map((call: [string]) => call[0]);
            const nudgeResetSql = allSqls.find(
                (sql: string) =>
                    sql.includes("UPDATE session_meta SET") && sql.includes("last_nudge_band"),
            );
            expect(nudgeResetSql).toBeDefined();
        });
    });
});
