import { describe, expect, mock, test } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { float32ArrayToBlob } from "../memory/storage-memory-embeddings";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import {
    buildSkillMemoryBlock,
    flatRecall,
    rankRung1,
    recallSkillMemoryBlock,
    sanitizeSkillIntentForFts,
} from "./recall";
import { promoteSkillObservations } from "./promote";
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

describe("sanitizeSkillIntentForFts", () => {
    test("quotes tokens and neutralizes FTS operators", () => {
        expect(sanitizeSkillIntentForFts("debug AND fix (urgent)")).toBe(
            '"debug" OR "and" OR "fix" OR "urgent"',
        );
        expect(sanitizeSkillIntentForFts("!!!")).toBe("");
        expect(sanitizeSkillIntentForFts('say "hi"')).toBe('"say" OR "hi"');
    });
});

describe("rankRung1", () => {
    test("clamps negative cosine and guards div-by-zero", () => {
        const q = new Float32Array([1, 0]);
        const notes = [
            {
                id: 1,
                intentVec: new Float32Array([0, 1]),
                deltaVec: new Float32Array([0, 1]),
                ts: 5,
                hit: 0,
            },
        ];
        const ranked = rankRung1(q, notes, { relevance: 0.6, recency: 0.25, hit: 0.15 });
        expect(ranked.length).toBe(1);
        expect(Number.isNaN(ranked[0].score)).toBe(false);
    });

    test("orders by weighted blend (relevance leads)", () => {
        const q = new Float32Array([1, 0]);
        const notes = [
            {
                id: 1,
                intentVec: new Float32Array([1, 0]),
                deltaVec: new Float32Array([1, 0]),
                ts: 1,
                hit: 0,
            },
            {
                id: 2,
                intentVec: new Float32Array([0, 1]),
                deltaVec: new Float32Array([0, 1]),
                ts: 100,
                hit: 50,
            },
        ];
        const ranked = rankRung1(q, notes, { relevance: 0.6, recency: 0.25, hit: 0.15 });
        expect(ranked[0].id).toBe(1);
    });
});

let EMBED_UP = true;
mock.module("../memory/embedding", () => ({
    embedTextForProject: async (_p: string, text: string) =>
        EMBED_UP
            ? {
                  vector: text.includes("auth")
                      ? new Float32Array([1, 0])
                      : new Float32Array([0, 1]),
                  modelId: "m1",
                  generation: 1,
              }
            : null,
}));

function modeOf(block: string): string | null {
    return block.match(/<skill-memory[^>]*\bmode="([^"]+)"/)?.[1] ?? null;
}
const cfg = {
    enabled: true as const,
    max_tokens: 1500,
    max_pinned_tokens: 4000,
    dedup_threshold: 0.92,
};

describe("recallSkillMemoryBlock (intent-scoped rungs)", () => {
    test("rung 1 full: provider up + intent + a model-matched embedded note", async () => {
        const db = makeDb();
        EMBED_UP = true;
        insertSkillMemoryNote(db, {
            skillId: "s",
            resolvedPath: "/p",
            tier: "global",
            skillSource: null,
            projectIdentity: "git:x",
            intent: "fix auth",
            kind: "fix",
            delta: "auth note",
            normalizedHash: "h1",
            createdAt: 1,
            intentEmbedding: float32ArrayToBlob(new Float32Array([1, 0])),
            deltaEmbedding: float32ArrayToBlob(new Float32Array([1, 0])),
            embeddingModelVersion: "m1",
        });
        const block = await recallSkillMemoryBlock(db, {
            skill: "s",
            intent: "auth bug",
            scope: "global",
            projectIdentity: "git:x",
            frontmatterConfig: cfg,
        });
        expect(modeOf(block)).toBe("full");
    });

    test("rung 2 no-intent: provider up, no intent → flat", async () => {
        const db = makeDb();
        EMBED_UP = true;
        insertSkillMemoryNote(db, {
            skillId: "s",
            resolvedPath: "/p",
            tier: "global",
            skillSource: null,
            projectIdentity: "git:x",
            intent: "i",
            kind: "fix",
            delta: "d",
            normalizedHash: "h1",
            createdAt: 1,
        });
        const block = await recallSkillMemoryBlock(db, {
            skill: "s",
            scope: "global",
            projectIdentity: "git:x",
            frontmatterConfig: cfg,
        });
        expect(modeOf(block)).toBe("no-intent");
    });

    test("rung 3 fts5-fallback: provider down + intent → FTS", async () => {
        const db = makeDb();
        EMBED_UP = false;
        insertSkillMemoryNote(db, {
            skillId: "s",
            resolvedPath: "/p",
            tier: "global",
            skillSource: null,
            projectIdentity: "git:x",
            intent: "fix auth flake",
            kind: "fix",
            delta: "mock timers",
            normalizedHash: "h1",
            createdAt: 1,
        });
        const block = await recallSkillMemoryBlock(db, {
            skill: "s",
            intent: "auth",
            scope: "global",
            projectIdentity: "git:x",
            frontmatterConfig: cfg,
        });
        expect(modeOf(block)).toBe("fts5-fallback");
    });

    test("rung 4 flat-fts: provider down + UNINDEXABLE intent (sanitize→empty) → flat", async () => {
        const db = makeDb();
        EMBED_UP = false;
        insertSkillMemoryNote(db, {
            skillId: "s",
            resolvedPath: "/p",
            tier: "global",
            skillSource: null,
            projectIdentity: "git:x",
            intent: "i",
            kind: "fix",
            delta: "d",
            normalizedHash: "h1",
            createdAt: 1,
        });
        const block = await recallSkillMemoryBlock(db, {
            skill: "s",
            intent: "!!! ???",
            scope: "global",
            projectIdentity: "git:x",
            frontmatterConfig: cfg,
        });
        expect(modeOf(block)).toBe("flat-fts");
    });

    test("rung 5 cold: no notes → empty block", async () => {
        const db = makeDb();
        EMBED_UP = true;
        const block = await recallSkillMemoryBlock(db, {
            skill: "s",
            intent: "x",
            scope: "global",
            projectIdentity: "git:x",
            frontmatterConfig: cfg,
        });
        expect(block).toBe("");
    });

    test("zero model-matched → falls to rung 3, never empty full block", async () => {
        const db = makeDb();
        EMBED_UP = true;
        insertSkillMemoryNote(db, {
            skillId: "s",
            resolvedPath: "/p",
            tier: "global",
            skillSource: null,
            projectIdentity: "git:x",
            intent: "auth fix",
            kind: "fix",
            delta: "d",
            normalizedHash: "h1",
            createdAt: 1,
            intentEmbedding: float32ArrayToBlob(new Float32Array([1, 0])),
            embeddingModelVersion: "OLD-model",
        });
        const block = await recallSkillMemoryBlock(db, {
            skill: "s",
            intent: "auth",
            scope: "global",
            projectIdentity: "git:x",
            frontmatterConfig: cfg,
        });
        expect(modeOf(block)).toBe("fts5-fallback");
    });

    test("intent-scoped recall matches a note sharing SOME (not all) intent tokens (OR semantics)", async () => {
        const db = makeDb();
        EMBED_UP = false; // force rung 3 FTS path
        try {
            insertSkillMemoryNote(db, {
                skillId: "tdd",
                resolvedPath: "/p/SKILL.md",
                tier: "global",
                skillSource: null,
                projectIdentity: "git:abc",
                intent: "fix the flaky auth login test",
                kind: "fix",
                delta: "mock the system clock in auth specs",
                normalizedHash: "h1",
                createdAt: Date.now(),
            });
            insertSkillMemoryNote(db, {
                skillId: "tdd",
                resolvedPath: "/p/SKILL.md",
                tier: "global",
                skillSource: null,
                projectIdentity: "git:abc",
                intent: "speed up the docker build cache",
                kind: "discovery",
                delta: "layer ordering matters",
                normalizedHash: "h2",
                createdAt: Date.now(),
            });
            // A multi-token NL intent that shares SOME tokens with note 1 (auth, test) but NOT all —
            // under AND-join this matches ZERO notes (the bug); under OR-join + bm25 it returns note 1.
            const block = await recallSkillMemoryBlock(db, {
                skill: "tdd",
                intent: "auth test timing clock stabilization",
                scope: "global",
                projectIdentity: "git:abc",
                frontmatterConfig: cfg,
            });
            expect(block).not.toBe(""); // RED with AND (empty), GREEN with OR
            expect(block).toContain('mode="fts5-fallback"'); // proves rung-3 path
            expect(block).toContain("mock the system clock"); // note 1's delta — the relevant note surfaced
            expect(block).not.toContain("layer ordering"); // note 2 (docker) shares no tokens → not matched
        } finally {
            closeQuietly(db);
        }
    });

    test("pinned notes appear even when intent doesn't match them (M2)", async () => {
        const db = makeDb();
        EMBED_UP = true;
        db.prepare(
            `INSERT INTO skill_memory (skill_id,resolved_path,tier,project_identity,intent,kind,delta,normalized_hash,hit_count,pinned,created_at)
             VALUES ('s','/p','global','*','old auth fix','fix','rotate token','h1',0,1,1)`,
        ).run();
        for (let i = 0; i < 10; i++) {
            insertSkillMemoryNote(db, {
                skillId: "s",
                resolvedPath: "/p",
                tier: "global",
                skillSource: null,
                projectIdentity: "git:x",
                intent: `note ${i}`,
                kind: "fix",
                delta: `delta ${i}`,
                normalizedHash: `h${i + 2}`,
                createdAt: 1000 + i,
                intentEmbedding: float32ArrayToBlob(new Float32Array([0, 1])),
                deltaEmbedding: float32ArrayToBlob(new Float32Array([0, 1])),
                embeddingModelVersion: "m1",
            });
        }
        const block = await recallSkillMemoryBlock(db, {
            skill: "s",
            intent: "frontend css",
            scope: "global",
            projectIdentity: "git:x",
            frontmatterConfig: cfg,
        });
        expect(block).toContain("rotate token");
        expect(modeOf(block)).toBe("full");
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
                recall_count: 0,
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

describe("cross-project global recall", () => {
    test("a global note learned in repo A surfaces when recalled from repo B", async () => {
        const db = makeDb();
        try {
            promoteSkillObservations(db, "git:repoA", [
                {
                    skillId: "council",
                    kind: "gotcha",
                    lesson: "aggregator needs a fast model",
                },
            ]);
            const block = await recallSkillMemoryBlock(db, {
                skill: "council",
                scope: "global",
                projectIdentity: "git:repoB",
                frontmatterConfig: cfg,
            });
            expect(block).toContain("aggregator needs a fast model");
        } finally {
            closeQuietly(db);
        }
    });
});

describe("recallSkillMemoryBlock bumps recall_count for surfaced notes", () => {
    test("a surfaced note's recall_count increments per recall (no-intent rung)", async () => {
        const db = makeDb();
        try {
            insertSkillMemoryNote(db, {
                skillId: "tdd",
                resolvedPath: "/p/SKILL.md",
                tier: "global",
                skillSource: "opencode-global",
                projectIdentity: "git:abc",
                intent: "fix a flaky test",
                kind: "fix",
                delta: "mock the clock",
                normalizedHash: "rc1",
                createdAt: Date.now(),
            });
            const cfg = { enabled: true, max_tokens: 1500, max_pinned_tokens: 4000 };
            // Two recalls (no intent → rung 2, which surfaces the note both times).
            const b1 = await recallSkillMemoryBlock(db, {
                skill: "tdd",
                scope: "global",
                projectIdentity: "git:abc",
                frontmatterConfig: cfg,
            });
            const b2 = await recallSkillMemoryBlock(db, {
                skill: "tdd",
                scope: "global",
                projectIdentity: "git:abc",
                frontmatterConfig: cfg,
            });
            expect(b1).toContain("mock the clock");
            expect(b2).toContain("mock the clock");
            const row = db
                .prepare(
                    "SELECT recall_count, last_used_at FROM skill_memory WHERE normalized_hash='rc1'",
                )
                .get() as { recall_count: number; last_used_at: number | null };
            expect(row.recall_count).toBe(2); // bumped once per recall
            expect(row.last_used_at).toBeNull(); // recall must NOT touch recency
        } finally {
            closeQuietly(db);
        }
    });

    test("a cold-start recall (no notes) bumps nothing and returns empty", async () => {
        const db = makeDb();
        try {
            const block = await recallSkillMemoryBlock(db, {
                skill: "ghost",
                scope: "global",
                projectIdentity: "git:abc",
                frontmatterConfig: { enabled: true, max_tokens: 1500, max_pinned_tokens: 4000 },
            });
            expect(block).toBe("");
        } finally {
            closeQuietly(db);
        }
    });
});
