import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
    _resetProjectEmbeddingRegistryForTests,
    _setTestProviderFactoryForProject,
    type ProjectEmbeddingRegistrationSnapshot,
    registerProjectEmbedding,
} from "../../features/magic-context/memory/embedding";
import type { EmbeddingProvider } from "../../features/magic-context/memory/embedding-provider";
import {
    __resetProjectIdentityForTests,
    resolveProjectIdentity,
} from "../../features/magic-context/memory/project-identity";
import { runMigrations } from "../../features/magic-context/migrations";
import {
    createSkillLoadRegistry,
    registryKey,
    type SkillLoadRegistry,
} from "../../features/magic-context/skill-memory/provenance";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createCtxSkillNoteTool } from "./tools";

function makeDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function installSkillNoteTestProvider(): void {
    _setTestProviderFactoryForProject(
        (): EmbeddingProvider => ({
            modelId: "test-provider-model",
            initialize: async () => true,
            embed: async (text: string) => {
                return text.includes("mock Date.now")
                    ? new Float32Array([1, 0])
                    : new Float32Array([0, 1]);
            },
            embedBatch: async (texts: string[]) =>
                texts.map((t) =>
                    t.includes("mock Date.now")
                        ? new Float32Array([1, 0])
                        : new Float32Array([0, 1]),
                ),
            dispose: async () => {},
            isLoaded: () => true,
        }),
    );
}

function registerSkillNoteTestProject(
    db: Database,
    identity: string,
): ProjectEmbeddingRegistrationSnapshot {
    return registerProjectEmbedding(
        db,
        identity,
        { provider: "local", model: "mock-model" },
        { memoryEnabled: true, gitCommitEnabled: false },
        identity,
    );
}

const toolContext = (sessionID = "ses_test", agent = "general") =>
    ({ sessionID, agent, directory: "/tmp/test" }) as never;

describe("ctx_skill_note tool", () => {
    beforeEach(() => {
        _resetProjectEmbeddingRegistryForTests();
        _setTestProviderFactoryForProject(null);
        __resetProjectIdentityForTests();
        installSkillNoteTestProvider();
    });

    afterEach(() => {
        _resetProjectEmbeddingRegistryForTests();
        _setTestProviderFactoryForProject(null);
    });

    test("rejects kind='general' with actionable error (hard gate)", async () => {
        const db = makeDb();
        const registry = createSkillLoadRegistry();
        try {
            const t = createCtxSkillNoteTool({ db, skillLoadRegistry: registry });
            const result = await t.execute(
                { skill: "tdd", intent: "fix test", kind: "general" as never, delta: "some note" },
                toolContext(),
            );
            expect(typeof result).toBe("string");
            expect(result).toContain("ctx_memory");
        } finally {
            closeQuietly(db);
        }
    });

    test("returns actionable error when skill not in registry", async () => {
        const db = makeDb();
        const registry: SkillLoadRegistry = createSkillLoadRegistry();
        try {
            const t = createCtxSkillNoteTool({ db, skillLoadRegistry: registry });
            const result = await t.execute(
                {
                    skill: "nonexistent-skill",
                    intent: "fix test",
                    kind: "gotcha",
                    delta: "some note",
                },
                toolContext(),
            );
            expect(typeof result).toBe("string");
            expect(result).toContain("No recent skill load found");
            expect(result).toContain("nonexistent-skill");
        } finally {
            closeQuietly(db);
        }
    });

    test("rejects note when skill-memory is disabled in frontmatter (no orphan insert)", async () => {
        const db = makeDb();
        const registry: SkillLoadRegistry = createSkillLoadRegistry();
        try {
            // Registry entry WITHOUT skill-memory opt-in (frontmatterConfig null —
            // the shape the after-hook stores for skills that never enabled it).
            registry.set(registryKey("ses_test", "tdd"), {
                resolvedPath: "/home/user/.config/opencode/skills/tdd/SKILL.md",
                tier: "global",
                skillSource: "opencode-global",
                skillId: "tdd",
                loadedAt: Date.now(),
                frontmatterConfig: null,
            });

            const t = createCtxSkillNoteTool({ db, skillLoadRegistry: registry });
            const result = await t.execute(
                {
                    skill: "tdd",
                    intent: "fix flaky test",
                    kind: "gotcha",
                    delta: "Always mock the clock",
                },
                toolContext(),
            );
            expect(result).toContain("not enabled");
            expect(result).not.toContain("saved");
            // No orphaned row inserted
            const row = db
                .prepare("SELECT COUNT(*) AS n FROM skill_memory WHERE skill_id = 'tdd'")
                .get() as { n: number };
            expect(row.n).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });

    test("inserts note when skill is in registry", async () => {
        const db = makeDb();
        const projectIdentity = resolveProjectIdentity("/tmp/test");
        registerSkillNoteTestProject(db, projectIdentity);
        const registry: SkillLoadRegistry = createSkillLoadRegistry();
        try {
            // Pre-populate registry
            registry.set(registryKey("ses_test", "tdd"), {
                resolvedPath: "/home/user/.config/opencode/skills/tdd/SKILL.md",
                tier: "global",
                skillSource: "opencode-global",
                skillId: "tdd",
                loadedAt: Date.now(),
                frontmatterConfig: {
                    enabled: true,
                    max_tokens: 1500,
                    max_pinned_tokens: 4000,
                    dedup_threshold: 0.92,
                },
            });

            const t = createCtxSkillNoteTool({ db, skillLoadRegistry: registry });
            const result = await t.execute(
                {
                    skill: "tdd",
                    intent: "fix flaky test",
                    kind: "gotcha",
                    delta: "Always mock the clock",
                },
                toolContext(),
            );
            expect(typeof result).toBe("string");
            expect(result).toContain("saved");
        } finally {
            closeQuietly(db);
        }
    });

    test("global-tier note is written under '*' with origin_project = real repo", async () => {
        const db = makeDb();
        const projectIdentity = resolveProjectIdentity("/tmp/test");
        registerSkillNoteTestProject(db, projectIdentity);
        const registry: SkillLoadRegistry = createSkillLoadRegistry();
        try {
            registry.set(registryKey("ses_test", "council"), {
                resolvedPath: "/home/user/.config/opencode/skills/council/SKILL.md",
                tier: "global",
                skillSource: "opencode-global",
                skillId: "council",
                loadedAt: Date.now(),
                frontmatterConfig: {
                    enabled: true,
                    max_tokens: 1500,
                    max_pinned_tokens: 4000,
                    dedup_threshold: 0.92,
                },
            });

            const t = createCtxSkillNoteTool({ db, skillLoadRegistry: registry });
            await t.execute(
                { skill: "council", intent: "x", kind: "gotcha", delta: "global lesson xyz" },
                toolContext(),
            );
            const row = db
                .prepare(
                    "SELECT project_identity, origin_project FROM skill_memory WHERE delta='global lesson xyz'",
                )
                .get() as { project_identity: string; origin_project: string };
            expect(row.project_identity).toBe("*");
            expect(row.origin_project).not.toBe("*");
            expect(row.origin_project.length).toBeGreaterThan(0);
        } finally {
            closeQuietly(db);
        }
    });

    test("deduplicates: bumps hit_count on exact duplicate delta", async () => {
        const db = makeDb();
        const projectIdentity = resolveProjectIdentity("/tmp/test");
        registerSkillNoteTestProject(db, projectIdentity);
        const registry: SkillLoadRegistry = createSkillLoadRegistry();
        try {
            registry.set(registryKey("ses_test", "tdd"), {
                resolvedPath: "/home/user/.config/opencode/skills/tdd/SKILL.md",
                tier: "global",
                skillSource: "opencode-global",
                skillId: "tdd",
                loadedAt: Date.now(),
                frontmatterConfig: {
                    enabled: true,
                    max_tokens: 1500,
                    max_pinned_tokens: 4000,
                    dedup_threshold: 0.92,
                },
            });

            const t = createCtxSkillNoteTool({ db, skillLoadRegistry: registry });
            await t.execute(
                { skill: "tdd", intent: "fix test", kind: "gotcha", delta: "Exact duplicate note" },
                toolContext(),
            );
            const result = await t.execute(
                { skill: "tdd", intent: "fix test", kind: "gotcha", delta: "Exact duplicate note" },
                toolContext(),
            );
            expect(result).toContain("already recorded");
        } finally {
            closeQuietly(db);
        }
    });

    test("near-duplicate delta under a different intent bumps hit_count (one row)", async () => {
        const db = makeDb();
        const projectIdentity = resolveProjectIdentity("/tmp/test");
        registerSkillNoteTestProject(db, projectIdentity);
        const registry: SkillLoadRegistry = createSkillLoadRegistry();
        try {
            registry.set(registryKey("ses_test", "tdd"), {
                resolvedPath: "/home/user/.config/opencode/skills/tdd/SKILL.md",
                tier: "global",
                skillSource: "opencode-global",
                skillId: "tdd",
                loadedAt: Date.now(),
                frontmatterConfig: {
                    enabled: true,
                    max_tokens: 1500,
                    max_pinned_tokens: 4000,
                    dedup_threshold: 0.92,
                },
            });

            const t = createCtxSkillNoteTool({ db, skillLoadRegistry: registry });
            await t.execute(
                {
                    skill: "tdd",
                    intent: "fix flaky auth test",
                    kind: "fix",
                    delta: "mock Date.now in auth tests",
                },
                toolContext(),
            );
            await t.execute(
                {
                    skill: "tdd",
                    intent: "stabilize login spec",
                    kind: "fix",
                    delta: "also mock Date.now in auth tests",
                },
                toolContext(),
            );
            const rows = db
                .prepare("SELECT hit_count FROM skill_memory WHERE skill_id='tdd'")
                .all() as Array<{ hit_count: number }>;
            expect(rows.length).toBe(1);
            expect(rows[0].hit_count).toBe(1);
        } finally {
            closeQuietly(db);
        }
    });

    test("same-intent different-delta inserts a second row", async () => {
        const db = makeDb();
        const projectIdentity = resolveProjectIdentity("/tmp/test");
        registerSkillNoteTestProject(db, projectIdentity);
        const registry: SkillLoadRegistry = createSkillLoadRegistry();
        try {
            registry.set(registryKey("ses_test", "tdd"), {
                resolvedPath: "/home/user/.config/opencode/skills/tdd/SKILL.md",
                tier: "global",
                skillSource: "opencode-global",
                skillId: "tdd",
                loadedAt: Date.now(),
                frontmatterConfig: {
                    enabled: true,
                    max_tokens: 1500,
                    max_pinned_tokens: 4000,
                    dedup_threshold: 0.92,
                },
            });

            const t = createCtxSkillNoteTool({ db, skillLoadRegistry: registry });
            await t.execute(
                {
                    skill: "tdd",
                    intent: "fix flaky auth test",
                    kind: "fix",
                    delta: "mock Date.now in auth tests",
                },
                toolContext(),
            );
            await t.execute(
                {
                    skill: "tdd",
                    intent: "fix flaky auth test",
                    kind: "fix",
                    delta: "use a fixed seed for the rng",
                },
                toolContext(),
            );
            const rows = db.prepare("SELECT id FROM skill_memory WHERE skill_id='tdd'").all();
            expect(rows.length).toBe(2);
        } finally {
            closeQuietly(db);
        }
    });
});
