import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { runMigrations } from "../../features/magic-context/migrations";
import {
    createSkillLoadRegistry,
    registryKey,
} from "../../features/magic-context/skill-memory/provenance";
import { recallSkillMemoryBlock } from "../../features/magic-context/skill-memory/recall";
import { insertSkillMemoryNote } from "../../features/magic-context/skill-memory/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    createIntentByCallIdMap,
    createToolExecuteAfterHook,
    maybeInjectSkillMemory,
} from "../magic-context/hook-handlers";

function makeDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

describe("recallSkillMemoryBlock (shared recall core)", () => {
    test("returns non-empty string containing <skill-memory when notes exist and enabled", async () => {
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
            const block = await recallSkillMemoryBlock(db, {
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

    test("returns empty string when frontmatterConfig is null (not opted in)", async () => {
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
            const block = await recallSkillMemoryBlock(db, {
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

    test("returns empty string when no notes exist (cold-start)", async () => {
        const db = makeDb();
        try {
            const block = await recallSkillMemoryBlock(db, {
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
    test("appends skill-memory block to output.output when notes exist", async () => {
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
            await maybeInjectSkillMemory(
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

    test("does NOT append when no notes exist (cold-start)", async () => {
        const db = makeDb();
        try {
            const output = { output: "# TDD Skill\nContent here." };
            await maybeInjectSkillMemory(db, "tdd", "global", "git:abc", null, output);
            expect(output.output).not.toContain("<skill-memory");
        } finally {
            closeQuietly(db);
        }
    });

    test("does NOT append when frontmatterConfig is null (skill-memory not opted in)", async () => {
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
            await maybeInjectSkillMemory(db, "tdd", "global", "git:abc", null, output);
            expect(output.output).not.toContain("<skill-memory");
        } finally {
            closeQuietly(db);
        }
    });

    test("skill-memory block appears AFTER existing output content (append semantics)", async () => {
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
            await maybeInjectSkillMemory(
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

describe("createToolExecuteAfterHook skill registry (truncation fallback)", () => {
    const projectDir = `${tmpdir()}/skill-truncation-test-${Date.now()}`;
    const skillDir = `${projectDir}/.opencode/skills/truncated-skill`;
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
        `${skillDir}/SKILL.md`,
        "---\nskill-memory:\n  enabled: true\n  max_tokens: 1500\n---\n\n# Truncated Skill\n",
    );

    afterAll(() => {
        rmSync(projectDir, { recursive: true, force: true });
    });

    test("populates registry via name-based fallback when Base-dir line is absent (truncation simulation)", async () => {
        // Simulates the bug: MAX_BYTES=51200 truncation drops the
        // "Base directory for this skill:" line, making parseSkillProvenance
        // return null. The fallback resolveSkillPathByName must populate
        // the registry so ctx_skill_note doesn't hard-fail with
        // "No recent skill load found... provenance parse failure".
        const db = makeDb();
        const registry = createSkillLoadRegistry();
        // Seed the map so project-tier resolution is authoritative (P1 fix).
        const hook = createToolExecuteAfterHook({
            db,
            channel1StateBySession: new Map(),
            skillLoadRegistry: registry,
            sessionDirectoryBySession: new Map([["ses_trunc", projectDir]]),
            defaultDirectory: "/tmp/irrelevant",
            intentByCallId: createIntentByCallIdMap(),
        });
        try {
            // Simulated truncated skill output: NO "Base directory for this skill:" line
            const output = {
                output: [
                    '<skill_content name="truncated-skill">',
                    "# Truncated Skill",
                    "",
                    "Some skill content that would normally be long enough",
                    "to push the provenance line past the 51200-byte cutoff.",
                    "",
                    "More content...",
                    "</skill_content>",
                ].join("\n"),
            };

            await hook(
                { tool: "skill", sessionID: "ses_trunc", args: { name: "truncated-skill" } },
                output,
            );

            const entry = registry.get(registryKey("ses_trunc", "truncated-skill"));
            // Without the name-based fallback this would be undefined (RED test).
            expect(entry).not.toBeUndefined();
            expect(entry!.resolvedPath).toBe(`${skillDir}/SKILL.md`);
            expect(entry!.tier).toBe("project");
            expect(entry!.skillSource).toBe("opencode-project");
            expect(entry!.skillId).toBe("truncated-skill");
            // Frontmatter should be parsed from the on-disk SKILL.md
            expect(entry!.frontmatterConfig).not.toBeNull();
            expect(entry!.frontmatterConfig!.enabled).toBe(true);
        } finally {
            closeQuietly(db);
        }
    });

    test("registry stays empty when fallback also cannot find SKILL.md", async () => {
        const db = makeDb();
        const registry = createSkillLoadRegistry();
        const hook = createToolExecuteAfterHook({
            db,
            channel1StateBySession: new Map(),
            skillLoadRegistry: registry,
            sessionDirectoryBySession: new Map([["ses_miss", projectDir]]),
            defaultDirectory: "/tmp/irrelevant",
            intentByCallId: createIntentByCallIdMap(),
        });
        try {
            // Skill that doesn't exist on disk at all
            const output = {
                output: "# Nonexistent Skill\n\nNo base dir here either.",
            };

            await hook(
                { tool: "skill", sessionID: "ses_miss", args: { name: "nonexistent-skill" } },
                output,
            );

            const entry = registry.get(registryKey("ses_miss", "nonexistent-skill"));
            expect(entry).toBeUndefined();
        } finally {
            closeQuietly(db);
        }
    });

    test("map-miss does NOT resolve a project-local skill (P1 guard)", async () => {
        // When sessionDirectoryBySession has no entry for the session,
        // the fallback receives null as projectDirectory and MUST NOT
        // resolve project-tier candidates — the defaultDirectory is a guess.
        const db = makeDb();
        const registry = createSkillLoadRegistry();
        // Empty map (no entry for ses_guess) → mappedDir is undefined → null → skip project
        const hook = createToolExecuteAfterHook({
            db,
            channel1StateBySession: new Map(),
            skillLoadRegistry: registry,
            sessionDirectoryBySession: new Map(),
            defaultDirectory: projectDir, // projectDir HAS the skill, but it's a guess
            intentByCallId: createIntentByCallIdMap(),
        });
        try {
            const output = {
                output: [
                    '<skill_content name="truncated-skill">',
                    "# Truncated Skill",
                    "",
                    "Some content...",
                    "</skill_content>",
                ].join("\n"),
            };

            await hook(
                { tool: "skill", sessionID: "ses_guess", args: { name: "truncated-skill" } },
                output,
            );

            // Registry must NOT contain the project-local skill — the fallback
            // skips project candidates when mappedDir is null.
            const entry = registry.get(registryKey("ses_guess", "truncated-skill"));
            expect(entry).toBeUndefined();
        } finally {
            closeQuietly(db);
        }
    });
});
