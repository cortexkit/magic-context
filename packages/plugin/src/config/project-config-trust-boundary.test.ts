import { describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isConfigLoadUntrusted } from "../plugin/embedding-bootstrap-helpers";
import { createTestTempDirFromPath } from "../shared/test-temp-dir";
import { isCommitRetentionPaused } from "./commit-retention-recovery";
import { loadPluginConfigDetailed } from "./index";

/**
 * A repository's project config may only tighten what the user configured. A
 * wrong-typed or otherwise invalid project value used to replace the user's
 * value in the raw deep merge; schema recovery then dropped the key and used
 * the schema DEFAULT, so a cloned repo could reset user-only settings (turn
 * compaction back on, unset the historian model, force a re-embed) or lower
 * compaction thresholds. These cases pin that an invalid project value is
 * ignored and the user's value survives.
 */
function loadUserAndProject(user: unknown, project: unknown) {
    const xdg = createTestTempDirFromPath(join(tmpdir(), "mc-trust-user-"));
    const projectDir = createTestTempDirFromPath(join(tmpdir(), "mc-trust-proj-"));
    mkdirSync(join(xdg, "cortexkit"), { recursive: true });
    mkdirSync(join(projectDir, ".cortexkit"), { recursive: true });
    writeFileSync(join(xdg, "cortexkit", "magic-context.jsonc"), JSON.stringify(user), "utf-8");
    writeFileSync(
        join(projectDir, ".cortexkit", "magic-context.jsonc"),
        JSON.stringify(project),
        "utf-8",
    );
    const origXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdg;
    try {
        return loadPluginConfigDetailed(projectDir, false);
    } finally {
        if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = origXdg;
        rmSync(xdg, { recursive: true, force: true });
        rmSync(projectDir, { recursive: true, force: true });
    }
}

describe("project config cannot reset user settings with a wrong-typed parent block", () => {
    it("pauses retention eviction for a recovered commit cap without making memory untrusted", () => {
        const loaded = loadUserAndProject(
            { memory: { git_commit_indexing: { enabled: true, max_commits: 0 } } },
            {},
        );
        expect(loaded.config.memory.git_commit_indexing.max_commits).toBe(2000);
        expect(isCommitRetentionPaused(loaded.config.memory.git_commit_indexing)).toBe(true);
        expect(isConfigLoadUntrusted(loaded)).toBe(false);
        expect(
            loaded.config.configWarnings?.filter((warning) =>
                warning.includes("retention eviction is paused"),
            ),
        ).toHaveLength(1);
        expect(loaded.config.configWarnings?.join("\n")).toContain(
            "memory.git_commit_indexing.max_commits",
        );
        expect(
            loaded.warningDetails.filter((warning) =>
                warning.message.includes("retention eviction is paused"),
            ),
        ).toHaveLength(1);
        const valid = loadUserAndProject(
            { memory: { git_commit_indexing: { enabled: true, max_commits: 100 } } },
            {},
        );
        expect(isCommitRetentionPaused(valid.config.memory.git_commit_indexing)).toBe(false);
    });

    it("recovers an out-of-range injection budget without making memory untrusted", () => {
        const loaded = loadUserAndProject({}, { memory: { injection_budget_tokens: 20001 } });
        expect(loaded.config.memory.enabled).toBe(true);
        expect(loaded.config.memory.injection_budget_tokens).toBe(4000);
        expect(loaded.recoveredFieldPaths).toEqual(["memory.injection_budget_tokens"]);
        expect(loaded.config.configWarnings?.join("\n")).toContain(
            "memory.injection_budget_tokens",
        );
        expect(isConfigLoadUntrusted(loaded)).toBe(false);
    });

    it("records the exact restored project leaf without distrusting a plain threshold", () => {
        const loaded = loadUserAndProject(
            { memory: { auto_search: { score_threshold: 0.7 } } },
            { memory: { auto_search: { score_threshold: "invalid" } } },
        );
        expect(loaded.config.memory.auto_search.score_threshold).toBe(0.7);
        expect(loaded.recoveredFieldPaths).toEqual(["memory.auto_search.score_threshold"]);
        expect(isConfigLoadUntrusted(loaded)).toBe(false);
    });

    it("keeps an invalid embedding model untrusted after field recovery", () => {
        const loaded = loadUserAndProject({ embedding: { model: 123 } }, {});
        expect(loaded.recoveredFieldPaths).toEqual(["embedding.model"]);
        expect(isConfigLoadUntrusted(loaded)).toBe(true);
    });

    it("keeps the user's compaction block when the project sets compaction:false", () => {
        const loaded = loadUserAndProject(
            { compaction: { enabled: false } },
            { compaction: false },
        );
        expect(loaded.config.compaction).toMatchObject({ enabled: false });
        expect(loaded.config.configWarnings?.join("\n")).toContain("compaction");
    });

    it("keeps the user's historian model when the project sets historian:1", () => {
        const loaded = loadUserAndProject(
            { historian: { opencode: { model: "anthropic/claude-x" } } },
            { historian: 1 },
        );
        expect(loaded.config.historian?.opencode?.model).toBe("anthropic/claude-x");
    });

    it("keeps the user's embedding provider when the project sets embedding:'x'", () => {
        const loaded = loadUserAndProject(
            {
                embedding: {
                    provider: "openai-compatible",
                    endpoint: "https://fixture.example/v1",
                    model: "fixture-model",
                },
            },
            { embedding: "x" },
        );
        expect(loaded.config.embedding).toMatchObject({
            provider: "openai-compatible",
            endpoint: "https://fixture.example/v1",
            model: "fixture-model",
        });
    });

    it("keeps storage.enforce_private_permissions:false when the project sets storage:0", () => {
        const loaded = loadUserAndProject(
            { storage: { enforce_private_permissions: false } },
            { storage: 0 },
        );
        expect(loaded.config.storage?.enforce_private_permissions).toBe(false);
    });

    it("keeps the user's prompt_surface override when the project sets prompt_surface:1", () => {
        const loaded = loadUserAndProject(
            { prompt_surface: { default: "light" } },
            { prompt_surface: 1 },
        );
        expect(loaded.config.prompt_surface).toMatchObject({ default: "light" });
    });

    it("keeps the user's nested leaf when the project gives that leaf a wrong type", () => {
        const loaded = loadUserAndProject(
            { memory: { auto_search: { enabled: false } } },
            { memory: { auto_search: { enabled: "nope" } } },
        );
        expect(loaded.config.memory?.auto_search?.enabled).toBe(false);
    });

    it("still applies a valid project value next to an invalid one", () => {
        const loaded = loadUserAndProject(
            { compaction: { enabled: false }, cache_ttl: "5m" },
            { compaction: false, cache_ttl: "1h" },
        );
        expect(loaded.config.compaction).toMatchObject({ enabled: false });
        expect(loaded.config.cache_ttl).toBe("1h");
    });

    it("reports the ignored project value as schema recovery", () => {
        const loaded = loadUserAndProject(
            { compaction: { enabled: false } },
            { compaction: false },
        );
        expect(loaded.recoveredTopLevelKeys).toContain("compaction");
        expect(loaded.loadOutcome).toBe("schema-recovery");
    });
});

describe("project config cannot lower compaction thresholds", () => {
    it("does not lower a user threshold of 88 to a project value of 81", () => {
        const loaded = loadUserAndProject(
            { execute_threshold_percentage: 88 },
            { execute_threshold_percentage: 81 },
        );
        expect(loaded.config.execute_threshold_percentage).toBe(88);
    });

    it("does not lower a per-model user threshold of 89 to a project value of 82", () => {
        const loaded = loadUserAndProject(
            { execute_threshold_percentage: { default: 70, "a/b": 89 } },
            { execute_threshold_percentage: { "a/b": 82 } },
        );
        expect(loaded.config.execute_threshold_percentage).toEqual({ default: 70, "a/b": 89 });
    });

    it("still raises the threshold to a valid project value above 80", () => {
        const loaded = loadUserAndProject(
            { execute_threshold_percentage: 70 },
            { execute_threshold_percentage: 85 },
        );
        expect(loaded.config.execute_threshold_percentage).toBe(85);
    });

    it("keeps the user threshold of 80 when the project value 10 is invalid", () => {
        const loaded = loadUserAndProject(
            { execute_threshold_percentage: 80 },
            { execute_threshold_percentage: 10 },
        );
        expect(loaded.config.execute_threshold_percentage).toBe(80);
    });

    it("keeps the user threshold when the project value is a string or an invalid object", () => {
        for (const projectValue of ["x", { default: 5 }]) {
            const loaded = loadUserAndProject(
                { execute_threshold_percentage: 80 },
                { execute_threshold_percentage: projectValue },
            );
            expect(loaded.config.execute_threshold_percentage).toBe(80);
        }
    });

    it("keeps the user's execute_threshold_tokens when the project sets a scalar", () => {
        const loaded = loadUserAndProject(
            { execute_threshold_tokens: { default: 300_000 } },
            { execute_threshold_tokens: 5 },
        );
        expect(loaded.config.execute_threshold_tokens).toEqual({ default: 300_000 });
    });

    it("keeps the user's execute_threshold_tokens.default when the project value is out of range", () => {
        const loaded = loadUserAndProject(
            { execute_threshold_tokens: { default: 300_000 } },
            { execute_threshold_tokens: { default: 10 } },
        );
        expect(loaded.config.execute_threshold_tokens).toEqual({ default: 300_000 });
    });
});

describe("project command block", () => {
    it("adds well-formed new commands but never replaces user or built-in ones", () => {
        const loaded = loadUserAndProject(
            { command: { "my-cmd": { template: "user template" } } },
            {
                command: {
                    "my-cmd": { template: "repository template" },
                    "ctx-status": { template: "repository status" },
                    "repo-cmd": { template: "repository command", description: "from the repo" },
                    "bad-cmd": { template: 5 },
                    "no-template": { description: "missing template" },
                },
            },
        );
        expect(loaded.config.command).toEqual({
            "my-cmd": { template: "user template" },
            "repo-cmd": { template: "repository command", description: "from the repo" },
        });
        expect(loaded.config.configWarnings?.join("\n")).toContain("command.my-cmd");
    });

    it("ignores a project command block that is not an object", () => {
        const loaded = loadUserAndProject(
            { command: { "my-cmd": { template: "user template" } } },
            { command: "nope" },
        );
        expect(loaded.config.command).toEqual({ "my-cmd": { template: "user template" } });
    });
});
