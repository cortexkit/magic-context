/// <reference types="bun-types" />

import { describe, expect, it, mock } from "bun:test";
import { toDatabase } from "./mock-database";
import { clearSession, updateSessionMeta } from "./storage-meta";

function createMockDb() {
    const prepare = mock((_sql: string) => ({
        run: mock((..._args: unknown[]) => {}),
    }));

    const transaction = mock((callback: () => void) => {
        return () => callback();
    });

    return {
        prepare,
        transaction,
    };
}

describe("storage-meta", () => {
    describe("updateSessionMeta", () => {
        it("runs insert + update inside a transaction", () => {
            //#given
            const db = createMockDb();

            //#when
            updateSessionMeta(toDatabase(db), "session-1", { counter: 3, lastNudgeTokens: 20_000 });

            //#then
            expect(db.transaction).toHaveBeenCalledTimes(1);
            const sqls = db.prepare.mock.calls.map((call: [string]) => call[0]);
            expect(
                sqls.some((sql: string) => sql.includes("INSERT OR IGNORE INTO session_meta")),
            ).toBe(true);
            expect(sqls.some((sql: string) => sql.startsWith("UPDATE session_meta SET"))).toBe(
                true,
            );
        });

        it("does not start a transaction when there are no updates", () => {
            //#given
            const db = createMockDb();

            //#when
            updateSessionMeta(toDatabase(db), "session-1", {});

            //#then
            expect(db.transaction).not.toHaveBeenCalled();
            expect(db.prepare).not.toHaveBeenCalled();
        });

        it("stores null values using the empty-string sentinel", () => {
            //#given
            const db = createMockDb();

            //#when
            updateSessionMeta(toDatabase(db), "session-1", { lastNudgeBand: null });

            //#then
            const updateSqlIndex = db.prepare.mock.calls.findIndex((call: [string]) =>
                call[0].startsWith("UPDATE session_meta SET"),
            );
            expect(updateSqlIndex).toBeGreaterThanOrEqual(0);

            const updateResult = db.prepare.mock.results[updateSqlIndex]?.value as
                | { run: ReturnType<typeof mock> }
                | undefined;
            const updateRun = updateResult?.run;
            expect(updateRun).toHaveBeenCalledWith("", "session-1");
        });
    });

    describe("clearSession", () => {
        it("runs all delete statements in one transaction", () => {
            //#given
            const db = createMockDb();

            //#when
            clearSession(toDatabase(db), "session-1");

            //#then
            // 2 transactions: outer clearSession + nested clearIndexedMessages
            expect(db.transaction).toHaveBeenCalledTimes(2);
            expect(db.prepare).toHaveBeenCalledTimes(11);
        });
    });
});
