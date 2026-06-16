import { describe, expect, test } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { buildSkillMemoryBlock, flatRecall } from "./recall";
import { insertSkillMemoryNote } from "./storage";

function makeDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

describe("flatRecall", () => {
    test("returns empty array when no notes exist (cold-start rung 5)", () => {
        const db = makeDb();
        try {
            const notes = flatRecall(db, "nonexistent-skill", "global", "git:abc", {
                maxTokens: 1500,
                maxPinnedTokens: 4000,
            });
            expect(notes).toEqual([]);
        } finally {
            closeQuietly(db);
        }
    });

    test("returns notes up to token budget", () => {
        const db = makeDb();
        try {
            const now = Date.now();
            for (let i = 0; i < 5; i++) {
                insertSkillMemoryNote(db, {
                    skillId: "tdd",
                    resolvedPath: "/p",
                    tier: "global",
                    skillSource: "opencode-global",
                    projectIdentity: "git:abc",
                    intent: "intent",
                    kind: "gotcha",
                    delta: `note ${i} — ${"x".repeat(40)}`,
                    normalizedHash: `h${i}`,
                    createdAt: now - i * 1000,
                });
            }
            // Token-budget truncation test (arithmetic verified):
            // delta = "note N — " (9 chars) + 40 "x"s = 49 chars → Math.ceil(49/4) = 13 tokens each.
            // maxTokens: 30 → first note fits (13 ≤ 30), second note fits (13+13=26 ≤ 30),
            // third note would exceed (26+13=39 > 30) → exactly 2 notes fit.
            const notes = flatRecall(db, "tdd", "global", "git:abc", {
                maxTokens: 30, // 2 notes × 13 tokens = 26 ≤ 30; 3rd note would push to 39 > 30
                maxPinnedTokens: 4000,
            });
            expect(notes.length).toBe(2);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("buildSkillMemoryBlock", () => {
    test("returns empty string when notes array is empty (cold-start)", () => {
        expect(buildSkillMemoryBlock("tdd", "no-intent", [], 0)).toBe("");
    });

    test("builds correct XML block with notes", () => {
        const notes = [
            {
                id: 1,
                skill_id: "tdd",
                kind: "gotcha" as const,
                delta: "Always mock the clock",
                intent: "fix flaky test",
                hit_count: 3,
                pinned: 0,
                normalized_hash: "h1",
                created_at: Date.now(),
                last_used_at: Date.now(),
                resolved_path: "/p",
                tier: "global" as const,
                skill_source: "opencode-global" as const,
                project_identity: "git:abc",
                tags: null,
                intent_embedding: null,
                embedding_model_version: null,
            },
        ];
        const block = buildSkillMemoryBlock("tdd", "no-intent", notes, 0);
        expect(block).toContain('<skill-memory skill="tdd"');
        expect(block).toContain('mode="no-intent"');
        expect(block).toContain('count="1"');
        expect(block).toContain('kind="gotcha"');
        expect(block).toContain("Always mock the clock");
        expect(block).toContain("ctx_skill_note");
    });
});
