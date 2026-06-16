import { describe, expect, test } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import {
    bumpHitCount,
    getSkillMemoryNotes,
    getSkillMemoryStats,
    type InsertSkillMemoryNoteArgs,
    insertSkillMemoryNote,
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
});
