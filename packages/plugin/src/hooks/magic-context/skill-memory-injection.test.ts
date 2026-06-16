import { describe, expect, test } from "bun:test";
import { runMigrations } from "../../features/magic-context/migrations";
import { recallSkillMemoryBlock } from "../../features/magic-context/skill-memory/recall";
import { insertSkillMemoryNote } from "../../features/magic-context/skill-memory/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { maybeInjectSkillMemory } from "../magic-context/hook-handlers";

function makeDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

describe("recallSkillMemoryBlock (shared recall core)", () => {
    test("returns non-empty string containing <skill-memory when notes exist and enabled", () => {
        const db = makeDb();
        try {
            insertSkillMemoryNote(db, {
                skillId: "tdd",
                resolvedPath: "/p/SKILL.md",
                tier: "global",
                skillSource: "opencode-global",
                projectIdentity: "git:abc",
                intent: "fix flaky test",
                kind: "gotcha",
                delta: "Always mock the clock in auth tests",
                normalizedHash: "h-recall-1",
                createdAt: Date.now(),
            });
            const block = recallSkillMemoryBlock(db, {
                skill: "tdd",
                scope: "global",
                projectIdentity: "git:abc",
                frontmatterConfig: {
                    enabled: true,
                    max_tokens: 1500,
                    max_pinned_tokens: 4000,
                    dedup_threshold: 0.92,
                },
            });
            expect(block).toContain("<skill-memory");
            expect(block).toContain("Always mock the clock");
        } finally {
            closeQuietly(db);
        }
    });

    test("returns empty string when frontmatterConfig is null (not opted in)", () => {
        const db = makeDb();
        try {
            insertSkillMemoryNote(db, {
                skillId: "tdd",
                resolvedPath: "/p/SKILL.md",
                tier: "global",
                skillSource: "opencode-global",
                projectIdentity: "git:abc",
                intent: "i",
                kind: "gotcha",
                delta: "some note",
                normalizedHash: "h-recall-2",
                createdAt: Date.now(),
            });
            const block = recallSkillMemoryBlock(db, {
                skill: "tdd",
                scope: "global",
                projectIdentity: "git:abc",
                frontmatterConfig: null,
            });
            expect(block).toBe("");
        } finally {
            closeQuietly(db);
        }
    });

    test("returns empty string when no notes exist (cold-start)", () => {
        const db = makeDb();
        try {
            const block = recallSkillMemoryBlock(db, {
                skill: "nonexistent-skill",
                scope: "global",
                projectIdentity: "git:abc",
                frontmatterConfig: {
                    enabled: true,
                    max_tokens: 1500,
                    max_pinned_tokens: 4000,
                    dedup_threshold: 0.92,
                },
            });
            expect(block).toBe("");
        } finally {
            closeQuietly(db);
        }
    });
});

describe("maybeInjectSkillMemory", () => {
    test("appends skill-memory block to output.output when notes exist", () => {
        const db = makeDb();
        try {
            insertSkillMemoryNote(db, {
                skillId: "tdd",
                resolvedPath: "/p/SKILL.md",
                tier: "global",
                skillSource: "opencode-global",
                projectIdentity: "git:abc",
                intent: "fix flaky test",
                kind: "gotcha",
                delta: "Always mock the clock in auth tests",
                normalizedHash: "h1",
                createdAt: Date.now(),
            });

            const output = { output: "# TDD Skill\nContent here." };
            // Pass enabled frontmatterConfig — null triggers the early-return guard
            // (`if (!frontmatterConfig?.enabled) return;`) and the block is never injected.
            maybeInjectSkillMemory(
                db,
                "tdd",
                "global",
                "git:abc",
                { enabled: true, max_tokens: 1500, max_pinned_tokens: 4000, dedup_threshold: 0.92 },
                output,
            );

            expect(output.output).toContain("<skill-memory");
            expect(output.output).toContain("Always mock the clock");
            expect(output.output).toContain("ctx_skill_note");
        } finally {
            closeQuietly(db);
        }
    });

    test("does NOT append when no notes exist (cold-start)", () => {
        const db = makeDb();
        try {
            const output = { output: "# TDD Skill\nContent here." };
            maybeInjectSkillMemory(db, "tdd", "global", "git:abc", null, output);
            expect(output.output).not.toContain("<skill-memory");
        } finally {
            closeQuietly(db);
        }
    });

    test("does NOT append when frontmatterConfig is null (skill-memory not opted in)", () => {
        const db = makeDb();
        try {
            insertSkillMemoryNote(db, {
                skillId: "tdd",
                resolvedPath: "/p/SKILL.md",
                tier: "global",
                skillSource: "opencode-global",
                projectIdentity: "git:abc",
                intent: "i",
                kind: "gotcha",
                delta: "some note",
                normalizedHash: "h2",
                createdAt: Date.now(),
            });
            const output = { output: "# TDD Skill\nContent here." };
            // null frontmatterConfig = skill-memory not enabled for this skill
            maybeInjectSkillMemory(db, "tdd", "global", "git:abc", null, output);
            expect(output.output).not.toContain("<skill-memory");
        } finally {
            closeQuietly(db);
        }
    });

    test("skill-memory block appears AFTER existing output content (append semantics)", () => {
        // maybeInjectSkillMemory APPENDS to output.output — it does NOT prepend.
        // So if a sentinel is already in the output, the skill-memory block lands AFTER it.
        // This test verifies the append contract: skillMemoryPos > channel1Pos.
        //
        // The ordering contract between maybeInjectSkillMemory and maybeInjectChannel1Nudge
        // (skill-memory before Channel-1 meta-reminder) is enforced at the
        // createToolExecuteAfterHook level, not at the single-function level.
        // TODO (U11): add a createToolExecuteAfterHook integration test with stubs to verify
        // that maybeInjectSkillMemory fires before maybeInjectChannel1Nudge.
        const db = makeDb();
        try {
            insertSkillMemoryNote(db, {
                skillId: "tdd",
                resolvedPath: "/p/SKILL.md",
                tier: "global",
                skillSource: "opencode-global",
                projectIdentity: "git:abc",
                intent: "i",
                kind: "gotcha",
                delta: "some note",
                normalizedHash: "h3",
                createdAt: Date.now(),
            });
            const output = { output: "# TDD Skill\nContent here.\n<!-- CHANNEL1_SENTINEL -->" };
            maybeInjectSkillMemory(
                db,
                "tdd",
                "global",
                "git:abc",
                { enabled: true, max_tokens: 1500, max_pinned_tokens: 4000, dedup_threshold: 0.92 },
                output,
            );
            const skillMemoryPos = output.output.indexOf("<skill-memory");
            const channel1Pos = output.output.indexOf("CHANNEL1_SENTINEL");
            // Append semantics: skill-memory block is added AFTER existing content (including sentinel)
            expect(skillMemoryPos).toBeGreaterThan(channel1Pos);
        } finally {
            closeQuietly(db);
        }
    });
});
