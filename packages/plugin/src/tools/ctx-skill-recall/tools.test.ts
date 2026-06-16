import { describe, expect, test } from "bun:test";
import { runMigrations } from "../../features/magic-context/migrations";
import { parseFrontmatterConfig } from "../../features/magic-context/skill-memory/frontmatter";
import { insertSkillMemoryNote } from "../../features/magic-context/skill-memory/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createCtxSkillRecallTool } from "./tools";

// DI-based tests: inject _testFrontmatterConfig + _testProjectIdentity via deps
// to bypass SKILL.md disk resolution and resolveProjectIdentity() entirely.
// This avoids:
//   1. Missing SKILL.md → null frontmatterConfig → early return → no block
//   2. resolveProjectIdentity("/tmp/test") mismatch with test-inserted projectIdentity

const TEST_PROJECT_IDENTITY = "git:abc";
const ENABLED_FRONTMATTER = parseFrontmatterConfig(
    "---\nskill-memory:\n  enabled: true\n  max_tokens: 1500\n  max_pinned_tokens: 4000\n  dedup_threshold: 0.92\n---\n",
);

function makeDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

describe("ctx_skill_recall tool", () => {
    test("returns <skill-memory> block string when notes exist for skill (DI injection)", async () => {
        const db = makeDb();
        try {
            insertSkillMemoryNote(db, {
                skillId: "tdd",
                resolvedPath: "/p/SKILL.md",
                tier: "global",
                skillSource: "opencode-global",
                projectIdentity: TEST_PROJECT_IDENTITY,
                intent: "fix flaky test",
                kind: "gotcha",
                delta: "Always mock the clock in auth tests",
                normalizedHash: "h-recall-tool-1",
                createdAt: Date.now(),
            });

            // Inject frontmatterConfig + projectIdentity via DI — no SKILL.md needed
            const tool = createCtxSkillRecallTool({
                db,
                projectDirectory: "/tmp/test",
                _testFrontmatterConfig: ENABLED_FRONTMATTER,
                _testProjectIdentity: TEST_PROJECT_IDENTITY,
            });
            const result = await tool.execute({ skill: "tdd", intent: "fix flaky test" }, {
                sessionID: "ses_test",
                agent: "general",
                directory: "/tmp/test",
            } as never);
            expect(typeof result).toBe("string");
            expect(result).toContain("<skill-memory");
            expect(result).toContain("Always mock the clock");
        } finally {
            closeQuietly(db);
        }
    });

    test("returns 'No skill-memory found' message when no notes exist for skill (DI injection)", async () => {
        const db = makeDb();
        try {
            // Inject enabled frontmatter + matching projectIdentity, but no notes inserted
            const tool = createCtxSkillRecallTool({
                db,
                projectDirectory: "/tmp/test",
                _testFrontmatterConfig: ENABLED_FRONTMATTER,
                _testProjectIdentity: TEST_PROJECT_IDENTITY,
            });
            const result = await tool.execute({ skill: "nonexistent-skill" }, {
                sessionID: "ses_test",
                agent: "general",
                directory: "/tmp/test",
            } as never);
            expect(typeof result).toBe("string");
            expect(result).toContain("No skill-memory found");
            expect(result).toContain("nonexistent-skill");
        } finally {
            closeQuietly(db);
        }
    });
});
