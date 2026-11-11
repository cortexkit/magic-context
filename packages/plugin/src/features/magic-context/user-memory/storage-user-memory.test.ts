import { describe, expect, it, spyOn } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import {
    deleteUserMemoryCandidates,
    dismissUserMemory,
    getActiveUserMemories,
    getUserMemoryCandidates,
    insertUserMemory,
    insertUserMemoryCandidates,
    pruneExpiredUserMemoryCandidates,
    restoreUserMemory,
    USER_MEMORY_CANDIDATE_TTL_MS,
} from "./storage-user-memory";

function freshDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

describe("user-memory provenance", () => {
    it("retains candidate session provenance after promotion consumes the candidate", () => {
        const db = freshDb();
        insertUserMemoryCandidates(db, [
            {
                content: "User prefers concise updates",
                sessionId: "ses_source",
                sourceCompartmentStart: 4,
                sourceCompartmentEnd: 9,
            },
        ]);
        const [candidate] = getUserMemoryCandidates(db);

        db.transaction(() => {
            insertUserMemory(db, "User prefers concise updates", [candidate.id]);
            deleteUserMemoryCandidates(db, [candidate.id]);
        })();

        expect(getUserMemoryCandidates(db)).toHaveLength(0);
        expect(getActiveUserMemories(db)[0].sourceProvenance).toEqual([
            {
                candidateId: candidate.id,
                sessionId: "ses_source",
                sourceCompartmentStart: 4,
                sourceCompartmentEnd: 9,
            },
        ]);
        db.close();
    });

    it("reports legacy bare candidate ids as unknown provenance", () => {
        const db = freshDb();
        db.prepare(
            `INSERT INTO user_memories
                (content, status, promoted_at, source_candidate_ids, created_at, updated_at)
             VALUES (?, 'active', ?, ?, ?, ?)`,
        ).run("Legacy observation", 1, "[41]", 1, 1);

        expect(getActiveUserMemories(db)[0].sourceCandidateIds).toEqual([41]);
        expect(getActiveUserMemories(db)[0].sourceProvenance).toBeNull();
        db.close();
    });
});

describe("user-memory dismiss", () => {
    it("leaves updated_at unchanged on a second dismiss", () => {
        const db = freshDb();
        const clock = spyOn(Date, "now").mockReturnValue(1000);
        try {
            const id = insertUserMemory(db, "Prefers concise explanations", []);
            dismissUserMemory(db, id);
            const before = db
                .prepare("SELECT status, updated_at FROM user_memories WHERE id = ?")
                .get(id) as { status: string; updated_at: number };
            expect(before).toEqual({ status: "dismissed", updated_at: 1000 });

            clock.mockReturnValue(2000);
            dismissUserMemory(db, id);

            const after = db
                .prepare("SELECT status, updated_at FROM user_memories WHERE id = ?")
                .get(id) as { status: string; updated_at: number };
            expect(after).toEqual(before);
        } finally {
            clock.mockRestore();
            db.close();
        }
    });
});

describe("user-memory restore", () => {
    it("returns a dismissed memory to the active set", () => {
        const db = freshDb();
        db.prepare(
            `INSERT INTO user_memories
                (content, status, promoted_at, source_candidate_ids, created_at, updated_at)
             VALUES (?, 'dismissed', ?, ?, ?, ?)`,
        ).run("Prefers concise explanations", 1, "[]", 1, 1);
        expect(getActiveUserMemories(db)).toHaveLength(0);

        const [row] = db.prepare("SELECT id FROM user_memories").all() as Array<{ id: number }>;
        restoreUserMemory(db, row.id);

        const active = getActiveUserMemories(db);
        expect(active).toHaveLength(1);
        expect(active[0].content).toBe("Prefers concise explanations");
        db.close();
    });

    it("leaves an already-active memory untouched", () => {
        const db = freshDb();
        db.prepare(
            `INSERT INTO user_memories
                (content, status, promoted_at, source_candidate_ids, created_at, updated_at)
             VALUES (?, 'active', ?, ?, ?, ?)`,
        ).run("Prefers concise explanations", 1, "[]", 1, 1);
        const [row] = db.prepare("SELECT id FROM user_memories").all() as Array<{ id: number }>;

        restoreUserMemory(db, row.id);

        // No transition, no write: updated_at must stay at the seeded value so
        // a caller that bumps on the caller side does not invalidate for a
        // no-op (mirrors the Rust status predicate).
        const [after] = db
            .prepare("SELECT updated_at FROM user_memories WHERE id = ?")
            .all(row.id) as Array<{ updated_at: number }>;
        expect(after.updated_at).toBe(1);
        expect(getActiveUserMemories(db)).toHaveLength(1);
        db.close();
    });
});

describe("user-memory candidate decay", () => {
    it("prunes candidates older than the TTL, keeps fresher ones", () => {
        const db = freshDb();
        const now = 1_000_000_000_000;
        // Insert two candidates, then back-date one past the TTL via direct UPDATE
        // (insert stamps created_at=Date.now()).
        insertUserMemoryCandidates(db, [
            { content: "stale one-off", sessionId: "s1" },
            { content: "recent observation", sessionId: "s1" },
        ]);
        const [stale, recent] = getUserMemoryCandidates(db);
        db.prepare("UPDATE user_memory_candidates SET created_at = ? WHERE id = ?").run(
            now - USER_MEMORY_CANDIDATE_TTL_MS - 1,
            stale.id,
        );
        db.prepare("UPDATE user_memory_candidates SET created_at = ? WHERE id = ?").run(
            now - 1000,
            recent.id,
        );

        const pruned = pruneExpiredUserMemoryCandidates(db, USER_MEMORY_CANDIDATE_TTL_MS, now);
        expect(pruned).toBe(1);

        const survivors = getUserMemoryCandidates(db);
        expect(survivors).toHaveLength(1);
        expect(survivors[0].content).toBe("recent observation");
        db.close();
    });

    it("prunes nothing when all candidates are within the TTL", () => {
        const db = freshDb();
        insertUserMemoryCandidates(db, [{ content: "fresh", sessionId: "s1" }]);
        const pruned = pruneExpiredUserMemoryCandidates(db, USER_MEMORY_CANDIDATE_TTL_MS);
        expect(pruned).toBe(0);
        expect(getUserMemoryCandidates(db)).toHaveLength(1);
        db.close();
    });
});
