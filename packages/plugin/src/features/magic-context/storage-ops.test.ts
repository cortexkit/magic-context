/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { clearPendingOps, getPendingOps, queuePendingOp, removePendingOp } from "./storage-ops";

let db: Database;

function makeMemoryDatabase(): Database {
    const d = new Database(":memory:");
    d.exec(`
    CREATE TABLE IF NOT EXISTS pending_ops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      tag_id INTEGER,
      operation TEXT,
      queued_at INTEGER,
      harness TEXT NOT NULL DEFAULT 'opencode'
    );
  `);
    return d;
}

afterEach(() => {
    if (db) closeQuietly(db);
});

describe("storage-ops", () => {
    describe("pending ops", () => {
        it("queues and returns drop ops in order", () => {
            db = makeMemoryDatabase();

            queuePendingOp(db, "ses-1", 1, "drop", 10);
            queuePendingOp(db, "ses-1", 2, "drop", 20);

            expect(getPendingOps(db, "ses-1")).toEqual([
                expect.objectContaining({ tagId: 1, operation: "drop", queuedAt: 10 }),
                expect.objectContaining({ tagId: 2, operation: "drop", queuedAt: 20 }),
            ]);
        });

        it("ignores unsupported pending-op rows", () => {
            db = makeMemoryDatabase();

            db.prepare(
                "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at) VALUES (?, ?, ?, ?)",
            ).run("ses-1", 1, "noop", Date.now());
            queuePendingOp(db, "ses-1", 2, "drop");

            const ops = getPendingOps(db, "ses-1");

            expect(ops).toHaveLength(1);
            expect(ops[0]?.tagId).toBe(2);
            expect(ops[0]?.operation).toBe("drop");
        });

        it("clears and removes pending ops by session/tag", () => {
            db = makeMemoryDatabase();

            queuePendingOp(db, "ses-1", 1, "drop");
            queuePendingOp(db, "ses-1", 2, "drop");
            queuePendingOp(db, "ses-2", 3, "drop");

            removePendingOp(db, "ses-1", 1);
            expect(getPendingOps(db, "ses-1")).toHaveLength(1);

            clearPendingOps(db, "ses-1");
            expect(getPendingOps(db, "ses-1")).toEqual([]);
            expect(getPendingOps(db, "ses-2")).toHaveLength(1);
        });
    });

    describe("error propagation", () => {
        it("throws when the database layer fails", () => {
            const failingDb = {
                prepare: () => {
                    throw new Error("db-error");
                },
            } as unknown as Database;

            expect(() => queuePendingOp(failingDb, "s", 1, "drop")).toThrow("db-error");
            expect(() => getPendingOps(failingDb, "s")).toThrow("db-error");
            expect(() => clearPendingOps(failingDb, "s")).toThrow("db-error");
            expect(() => removePendingOp(failingDb, "s", 1)).toThrow("db-error");
        });
    });
});
