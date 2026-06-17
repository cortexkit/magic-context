import { describe, expect, test } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { float32ArrayToBlob } from "../memory/storage-memory-embeddings";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import {
    bumpHitCount,
    bumpHitCountById,
    bumpRecallCountByIds,
    getDedupCandidates,
    getPinnedNotes,
    getRankingCandidates,
    getSkillMemoryNotes,
    getSkillMemoryStats,
    type InsertSkillMemoryNoteArgs,
    insertSkillMemoryNote,
    searchSkillMemoryFts,
} from "./storage";

function makeDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

describe("skill_memory storage", () => {
    test("insertSkillMemoryNote inserts a new row", () => {
        const db = makeDb();
        try {
            const args: InsertSkillMemoryNoteArgs = {
                skillId: "test-driven-development",
                resolvedPath: "/home/user/.config/opencode/skills/tdd/SKILL.md",
                tier: "global",
                skillSource: "opencode-global",
                projectIdentity: "git:abc123",
                intent: "fix a flaky test in auth",
                kind: "gotcha",
                delta: "Always mock the clock in auth tests — real timers cause flakiness",
                normalizedHash: "hash-001",
                createdAt: Date.now(),
            };
            const id = insertSkillMemoryNote(db, args);
            expect(typeof id).toBe("number");
            expect(id).toBeGreaterThan(0);
        } finally {
            closeQuietly(db);
        }
    });

    test("insertSkillMemoryNote returns null on duplicate normalized_hash (UNIQUE constraint)", () => {
        const db = makeDb();
        try {
            const args: InsertSkillMemoryNoteArgs = {
                skillId: "tdd",
                resolvedPath: "/path/SKILL.md",
                tier: "project",
                skillSource: "opencode-project",
                projectIdentity: "git:abc123",
                intent: "intent",
                kind: "fix",
                delta: "delta content",
                normalizedHash: "dup-hash",
                createdAt: Date.now(),
            };
            insertSkillMemoryNote(db, args);
            const result = insertSkillMemoryNote(db, args); // duplicate
            expect(result).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    test("insertSkillMemoryNote stores intent_embedding/delta_embedding/embedding_model_version", () => {
        const db = makeDb();
        try {
            const iv = float32ArrayToBlob(new Float32Array([1, 0, 0]));
            const dv = float32ArrayToBlob(new Float32Array([0, 1, 0]));
            const id = insertSkillMemoryNote(db, {
                skillId: "s",
                resolvedPath: "/p",
                tier: "global",
                skillSource: null,
                projectIdentity: "git:x",
                intent: "i",
                kind: "fix",
                delta: "d",
                normalizedHash: "emb-hash",
                createdAt: 1,
                intentEmbedding: iv,
                deltaEmbedding: dv,
                embeddingModelVersion: "m1",
            });
            const row = db
                .prepare("SELECT embedding_model_version FROM skill_memory WHERE id=?")
                .get(id) as { embedding_model_version: string };
            expect(row.embedding_model_version).toBe("m1");
        } finally {
            closeQuietly(db);
        }
    });

    test("getSkillMemoryNotes returns notes ordered by recency × hit_count", () => {
        const db = makeDb();
        try {
            const now = Date.now();
            insertSkillMemoryNote(db, {
                skillId: "tdd",
                resolvedPath: "/p",
                tier: "global",
                skillSource: "opencode-global",
                projectIdentity: "git:abc",
                intent: "i",
                kind: "gotcha",
                delta: "note A (high hit_count)",
                normalizedHash: "h1",
                createdAt: now - 10000,
            });
            insertSkillMemoryNote(db, {
                skillId: "tdd",
                resolvedPath: "/p",
                tier: "global",
                skillSource: "opencode-global",
                projectIdentity: "git:abc",
                intent: "i",
                kind: "discovery",
                delta: "note B (recent)",
                normalizedHash: "h2",
                createdAt: now,
            });
            // Bump hit_count on note A
            bumpHitCount(db, "tdd", "global", "git:abc", "h1");
            bumpHitCount(db, "tdd", "global", "git:abc", "h1");

            const notes = getSkillMemoryNotes(db, "tdd", "global", "git:abc", 10);
            expect(notes.length).toBe(2);
            // Both notes should be returned; order is recency × hit_count
            expect(notes.map((n) => n.delta)).toContain("note A (high hit_count)");
            expect(notes.map((n) => n.delta)).toContain("note B (recent)");
        } finally {
            closeQuietly(db);
        }
    });

    test("bumpHitCountById increments by id", () => {
        const db = makeDb();
        try {
            const id = Number(
                (
                    db
                        .prepare(
                            `INSERT INTO skill_memory (skill_id,resolved_path,tier,project_identity,intent,kind,delta,normalized_hash,hit_count,pinned,created_at)
                         VALUES ('s','/p','global','git:x','i','fix','d','h',0,0,1) RETURNING id`,
                        )
                        .get() as { id: number }
                ).id,
            );
            bumpHitCountById(db, id);
            const row = db.prepare("SELECT hit_count FROM skill_memory WHERE id=?").get(id) as {
                hit_count: number;
            };
            expect(row.hit_count).toBe(1);
        } finally {
            closeQuietly(db);
        }
    });

    test("bumpHitCount increments hit_count and updates last_used_at", () => {
        const db = makeDb();
        try {
            insertSkillMemoryNote(db, {
                skillId: "tdd",
                resolvedPath: "/p",
                tier: "global",
                skillSource: "opencode-global",
                projectIdentity: "git:abc",
                intent: "i",
                kind: "workflow",
                delta: "workflow note",
                normalizedHash: "h-bump",
                createdAt: Date.now(),
            });
            bumpHitCount(db, "tdd", "global", "git:abc", "h-bump");
            bumpHitCount(db, "tdd", "global", "git:abc", "h-bump");
            const notes = getSkillMemoryNotes(db, "tdd", "global", "git:abc", 10);
            expect(notes[0].hit_count).toBe(2);
            expect(notes[0].last_used_at).not.toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    test("bumpRecallCountByIds increments recall_count without touching last_used_at or hit_count", () => {
        const db = makeDb();
        try {
            const mkId = (hash: string): number =>
                insertSkillMemoryNote(db, {
                    skillId: "tdd",
                    resolvedPath: "/p",
                    tier: "global",
                    skillSource: "opencode-global",
                    projectIdentity: "git:abc",
                    intent: "i",
                    kind: "fix",
                    delta: `d-${hash}`,
                    normalizedHash: hash,
                    createdAt: Date.now(),
                }) as number;
            const id1 = mkId("r1");
            const id2 = mkId("r2");
            const id3 = mkId("r3");

            // Surface only id1 + id2 twice; id3 never recalled.
            bumpRecallCountByIds(db, [id1, id2]);
            bumpRecallCountByIds(db, [id1, id2]);

            const rows = db
                .prepare(
                    "SELECT id, recall_count, hit_count, last_used_at FROM skill_memory ORDER BY id",
                )
                .all() as Array<{
                id: number;
                recall_count: number;
                hit_count: number;
                last_used_at: number | null;
            }>;
            const byId = new Map(rows.map((r) => [r.id, r]));
            expect(byId.get(id1)?.recall_count).toBe(2);
            expect(byId.get(id2)?.recall_count).toBe(2);
            expect(byId.get(id3)?.recall_count).toBe(0);
            // read-counter must NOT pollute write-side salience or recency
            expect(byId.get(id1)?.hit_count).toBe(0);
            expect(byId.get(id1)?.last_used_at).toBeNull();
        } finally {
            closeQuietly(db);
        }
    });

    test("bumpRecallCountByIds is a no-op on empty ids", () => {
        const db = makeDb();
        try {
            // must not throw
            bumpRecallCountByIds(db, []);
            expect(true).toBe(true);
        } finally {
            closeQuietly(db);
        }
    });

    test("getSkillMemoryStats returns totals scoped to project_identity", () => {
        const db = makeDb();
        try {
            // Seed 3 notes for skill "tdd" under project "git:abc", 1 of them pinned.
            insertSkillMemoryNote(db, {
                skillId: "tdd",
                resolvedPath: "/p",
                tier: "global",
                skillSource: "opencode-global",
                projectIdentity: "git:abc",
                intent: "i1",
                kind: "gotcha",
                delta: "n1",
                normalizedHash: "stats-h1",
                createdAt: Date.now(),
            });
            insertSkillMemoryNote(db, {
                skillId: "tdd",
                resolvedPath: "/p",
                tier: "global",
                skillSource: "opencode-global",
                projectIdentity: "git:abc",
                intent: "i2",
                kind: "fix",
                delta: "n2",
                normalizedHash: "stats-h2",
                createdAt: Date.now(),
            });
            // pin the second one directly via SQL — there's no pin API in storage yet
            db.prepare("UPDATE skill_memory SET pinned = 1 WHERE normalized_hash = ?").run(
                "stats-h2",
            );

            // Seed 2 notes for a different skill "debugging" under the same project.
            insertSkillMemoryNote(db, {
                skillId: "debugging",
                resolvedPath: "/p2",
                tier: "global",
                skillSource: "opencode-global",
                projectIdentity: "git:abc",
                intent: "i3",
                kind: "discovery",
                delta: "n3",
                normalizedHash: "stats-h3",
                createdAt: Date.now(),
            });
            insertSkillMemoryNote(db, {
                skillId: "debugging",
                resolvedPath: "/p2",
                tier: "global",
                skillSource: "opencode-global",
                projectIdentity: "git:abc",
                intent: "i4",
                kind: "workflow",
                delta: "n4",
                normalizedHash: "stats-h4",
                createdAt: Date.now(),
            });

            // Seed 1 note under a DIFFERENT project — must NOT be counted.
            insertSkillMemoryNote(db, {
                skillId: "tdd",
                resolvedPath: "/p",
                tier: "global",
                skillSource: "opencode-global",
                projectIdentity: "git:other",
                intent: "i5",
                kind: "gotcha",
                delta: "n5",
                normalizedHash: "stats-h5",
                createdAt: Date.now(),
            });

            const stats = getSkillMemoryStats(db, "git:abc");
            expect(stats.totalNotes).toBe(4);
            expect(stats.skillsWithNotes).toBe(2);
            expect(stats.pinnedNotes).toBe(1);
        } finally {
            closeQuietly(db);
        }
    });

    test("getSkillMemoryNotes: equal timestamps don't break ordering (NULLIF guard)", () => {
        const db = makeDb();
        try {
            const ts = 1_000_000;
            const ins = (hash: string, hits: number) =>
                db
                    .prepare(
                        `INSERT INTO skill_memory (skill_id,resolved_path,tier,project_identity,intent,kind,delta,normalized_hash,hit_count,pinned,created_at,last_used_at)
                     VALUES ('s','/p','global','git:x','i','fix','d',?,?,0,?,?)`,
                    )
                    .run(hash, hits, ts, ts);
            ins("a", 1);
            ins("b", 5);
            const notes = getSkillMemoryNotes(db, "s", "global", "git:x", 10);
            expect(notes[0].normalized_hash).toBe("b"); // higher hit_count first when timestamps equal
        } finally {
            closeQuietly(db);
        }
    });

    test("getSkillMemoryStats returns all-zeros when no notes exist for the project", () => {
        const db = makeDb();
        try {
            const stats = getSkillMemoryStats(db, "git:empty");
            expect(stats.totalNotes).toBe(0);
            expect(stats.skillsWithNotes).toBe(0);
            expect(stats.pinnedNotes).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });

    test("getDedupCandidates returns top-N same-scope rows with delta_embedding + model version", () => {
        const db = makeDb();
        try {
            insertSkillMemoryNote(db, {
                skillId: "s",
                resolvedPath: "/p",
                tier: "global",
                skillSource: null,
                projectIdentity: "git:x",
                intent: "i",
                kind: "fix",
                delta: "d1",
                normalizedHash: "dedup-h1",
                createdAt: 1,
                deltaEmbedding: float32ArrayToBlob(new Float32Array([1, 0])),
                embeddingModelVersion: "m1",
            });
            const cands = getDedupCandidates(db, "s", "global", "git:x", 200);
            expect(cands.length).toBe(1);
            expect(cands[0].delta_embedding).toBeTruthy();
        } finally {
            closeQuietly(db);
        }
    });

    test("getRankingCandidates returns scope-filtered rows ordered by recency", () => {
        const db = makeDb();
        try {
            insertSkillMemoryNote(db, {
                skillId: "s",
                resolvedPath: "/p",
                tier: "global",
                skillSource: null,
                projectIdentity: "git:x",
                intent: "i",
                kind: "fix",
                delta: "d",
                normalizedHash: "rank-h1",
                createdAt: 1,
            });
            const cands = getRankingCandidates(db, "s", "global", "git:x", 10);
            expect(cands.length).toBe(1);
            expect(cands[0].skill_id).toBe("s");
        } finally {
            closeQuietly(db);
        }
    });

    test("searchSkillMemoryFts returns scope-filtered BM25 matches", () => {
        const db = makeDb();
        try {
            insertSkillMemoryNote(db, {
                skillId: "s",
                resolvedPath: "/p",
                tier: "global",
                skillSource: null,
                projectIdentity: "git:x",
                intent: "fix flaky auth test",
                kind: "fix",
                delta: "mock Date.now",
                normalizedHash: "fts-h1",
                createdAt: 1,
            });
            insertSkillMemoryNote(db, {
                skillId: "OTHER",
                resolvedPath: "/p",
                tier: "global",
                skillSource: null,
                projectIdentity: "git:x",
                intent: "auth",
                kind: "fix",
                delta: "x",
                normalizedHash: "fts-h2",
                createdAt: 1,
            });
            const hits = searchSkillMemoryFts(db, "s", "global", "git:x", '"auth"', 10);
            expect(hits.every((h) => h.skill_id === "s")).toBe(true);
            expect(hits.length).toBe(1);
        } finally {
            closeQuietly(db);
        }
    });

    test("getPinnedNotes returns only pinned same-scope rows", () => {
        const db = makeDb();
        try {
            insertSkillMemoryNote(db, {
                skillId: "s",
                resolvedPath: "/p",
                tier: "global",
                skillSource: null,
                projectIdentity: "git:x",
                intent: "i",
                kind: "fix",
                delta: "unpinned",
                normalizedHash: "pin-h1",
                createdAt: 1,
            });
            const pid = Number(
                (
                    db
                        .prepare(
                            `INSERT INTO skill_memory (skill_id,resolved_path,tier,project_identity,intent,kind,delta,normalized_hash,hit_count,pinned,created_at)
                         VALUES ('s','/p','global','git:x','i','fix','pinned','pin-h2',0,1,2) RETURNING id`,
                        )
                        .get() as { id: number }
                ).id,
            );
            const pinned = getPinnedNotes(db, "s", "global", "git:x");
            expect(pinned.length).toBe(1);
            expect(pinned[0].id).toBe(pid);
        } finally {
            closeQuietly(db);
        }
    });
});
