import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadPluginConfig } from "./index";

/**
 * Writes a magic-context.jsonc file inside a fresh temp XDG_CONFIG_HOME tree
 * and runs loadPluginConfig against it. Returns warnings + parsed config.
 *
 * Scope directory is NOT set — we pass a unique directory that does not
 * contain a project config so only the user config is loaded.
 */
function loadWithUserConfig(configText: string, extraEnv: Record<string, string> = {}) {
    const xdg = mkdtempSync(join(tmpdir(), "mc-config-test-"));
    const configDir = join(xdg, "opencode");
    const fs = require("node:fs") as typeof import("node:fs");
    fs.mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "magic-context.jsonc"), configText, "utf-8");

    const origXdg = process.env.XDG_CONFIG_HOME;
    const savedEnv: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(extraEnv)) {
        savedEnv[k] = process.env[k];
        process.env[k] = v;
    }
    process.env.XDG_CONFIG_HOME = xdg;

    // Use a directory that definitely has no project config so only the
    // user config feeds the loader. We use a sibling temp directory.
    const projectDir = mkdtempSync(join(tmpdir(), "mc-config-proj-"));
    try {
        return loadPluginConfig(projectDir);
    } finally {
        if (origXdg === undefined) {
            delete process.env.XDG_CONFIG_HOME;
        } else {
            process.env.XDG_CONFIG_HOME = origXdg;
        }
        for (const [k, v] of Object.entries(savedEnv)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        try {
            rmSync(xdg, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* Ignore EBUSY on Windows */
        }
        try {
            rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* Ignore EBUSY on Windows */
        }
    }
}

function loadWithUserAndProjectConfig(
    userConfigText: string,
    projectConfigText: string,
    extraEnv: Record<string, string> = {},
) {
    const xdg = mkdtempSync(join(tmpdir(), "mc-config-test-"));
    const projectDir = mkdtempSync(join(tmpdir(), "mc-config-proj-"));
    const fs = require("node:fs") as typeof import("node:fs");
    const configDir = join(xdg, "opencode");
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(join(projectDir, ".opencode"), { recursive: true });
    writeFileSync(join(configDir, "magic-context.jsonc"), userConfigText, "utf-8");
    writeFileSync(join(projectDir, ".opencode", "magic-context.jsonc"), projectConfigText, "utf-8");

    const origXdg = process.env.XDG_CONFIG_HOME;
    const savedEnv: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(extraEnv)) {
        savedEnv[k] = process.env[k];
        process.env[k] = v;
    }
    process.env.XDG_CONFIG_HOME = xdg;

    try {
        return loadPluginConfig(projectDir);
    } finally {
        if (origXdg === undefined) {
            delete process.env.XDG_CONFIG_HOME;
        } else {
            process.env.XDG_CONFIG_HOME = origXdg;
        }
        for (const [k, v] of Object.entries(savedEnv)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        try {
            rmSync(xdg, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* Ignore EBUSY on Windows */
        }
        try {
            rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* Ignore EBUSY on Windows */
        }
    }
}

describe("loadPluginConfig — secret redaction", () => {
    it("does NOT leak resolved env values through Zod validation warnings", () => {
        const secret = "sk-live-CARDINAL-SIN-IF-THIS-APPEARS-IN-LOGS";
        const config = JSON.stringify({
            // `historian_timeout_ms` has a minimum of 60_000. Feeding the
            // substituted secret string here causes Zod to reject the field
            // and route through the warning path we care about.
            historian_timeout_ms: "{env:MC_TEST_SECRET}",
        });

        const result = loadWithUserConfig(config, { MC_TEST_SECRET: secret });
        const warnings = result.configWarnings ?? [];

        // The plugin should still load (enabled: true kept by recovery path).
        expect(result.enabled).toBe(true);

        // No warning or config field may contain the resolved secret.
        const allText = JSON.stringify({ config: result, warnings });
        expect(allText).not.toContain(secret);
        expect(allText).not.toContain("CARDINAL-SIN");

        // But the warnings should still describe what failed. We expect a
        // warning mentioning historian_timeout_ms and the safe type summary.
        const relevantWarning = warnings.find((w) => w.includes("historian_timeout_ms"));
        expect(relevantWarning).toBeDefined();
        expect(relevantWarning).toContain("invalid value");
        // Must show type + length, not the value itself.
        expect(relevantWarning).toMatch(/string, \d+ chars?/);
    });

    it("redacts long string values of any source (not just env-substituted)", () => {
        // Verifies the redaction applies to plain invalid values too — we
        // don't want to special-case env vs non-env because we can't tell
        // them apart at the Zod layer.
        const config = JSON.stringify({
            historian_timeout_ms: "super-secret-plain-literal-that-should-not-leak",
        });

        const result = loadWithUserConfig(config);
        const warnings = result.configWarnings ?? [];
        const combined = warnings.join("\n");

        expect(combined).not.toContain("super-secret-plain-literal-that-should-not-leak");
        expect(combined).toMatch(/string, \d+ chars?/);
    });

    it("redacts nested object values to structural shape only", () => {
        const config = JSON.stringify({
            historian_timeout_ms: { nested: "secret-xyz", apiKey: "also-secret" },
        });

        const result = loadWithUserConfig(config);
        const warnings = result.configWarnings ?? [];
        const combined = warnings.join("\n");

        expect(combined).not.toContain("secret-xyz");
        expect(combined).not.toContain("also-secret");
        expect(combined).toContain("object with keys");
        expect(combined).toContain("nested");
        expect(combined).toContain("apiKey");
    });

    it("still shows numeric and boolean invalid values (not secrets by nature)", () => {
        // Numbers/booleans in config fields are never secrets — they're
        // plain validation mistakes — so we surface them fully to help
        // the user diagnose.
        const config = JSON.stringify({
            execute_threshold_percentage: 5, // below min (20)
        });

        const result = loadWithUserConfig(config);
        const warnings = result.configWarnings ?? [];
        const combined = warnings.join("\n");

        expect(combined).toContain("execute_threshold_percentage");
        // `number 5` is the human-friendly safe render.
        expect(combined).toMatch(/number 5/);
    });
});

describe("loadPluginConfig — experimental graduation migration", () => {
    it("migrates experimental.user_memories object block to dreamer.user_memories", () => {
        const config = JSON.stringify({
            experimental: {
                user_memories: {
                    enabled: true,
                    promotion_threshold: 5,
                },
            },
        });

        const result = loadWithUserConfig(config);
        expect(result.dreamer?.user_memories?.enabled).toBe(true);
        expect(result.dreamer?.user_memories?.promotion_threshold).toBe(5);
        // Warning so users know to run doctor.
        expect(result.configWarnings?.join("\n")).toContain("experimental.user_memories");
    });

    it("coerces primitive experimental.user_memories: false to dreamer object shape", () => {
        // Without coercion, Zod rejects the primitive and silently falls back
        // to the new default (enabled=true) — flipping the user's opt-out.
        const config = JSON.stringify({
            experimental: {
                user_memories: false,
            },
        });

        const result = loadWithUserConfig(config);
        expect(result.dreamer?.user_memories?.enabled).toBe(false);
    });

    it("coerces primitive experimental.pin_key_files: true to dreamer object shape", () => {
        const config = JSON.stringify({
            experimental: {
                pin_key_files: true,
            },
        });

        const result = loadWithUserConfig(config);
        expect(result.dreamer?.pin_key_files?.enabled).toBe(true);
    });

    it("preserves existing dreamer.user_memories over legacy experimental.user_memories", () => {
        // When both exist, dreamer.* wins (user has graduated), but missing
        // sub-fields from the old block fill in.
        const config = JSON.stringify({
            experimental: {
                user_memories: {
                    enabled: false,
                    promotion_threshold: 10,
                },
            },
            dreamer: {
                user_memories: {
                    enabled: true,
                    // Intentionally no promotion_threshold — should pick up from old block.
                },
            },
        });

        const result = loadWithUserConfig(config);
        // dreamer.user_memories wins.
        expect(result.dreamer?.user_memories?.enabled).toBe(true);
        // Missing sub-field fills in from old block.
        expect(result.dreamer?.user_memories?.promotion_threshold).toBe(10);
    });

    it("is a no-op when no experimental block exists", () => {
        const config = JSON.stringify({ enabled: true });
        const result = loadWithUserConfig(config);
        // No warning, no disruption.
        expect(result.configWarnings).toBeUndefined();
    });

    it("temporal_awareness and memory.auto_search default ON; git_commit_indexing and caveman default OFF", () => {
        const result = loadWithUserConfig(JSON.stringify({ enabled: true }));
        expect(result.temporal_awareness).toBe(true);
        expect(result.memory.auto_search.enabled).toBe(true);
        expect(result.memory.git_commit_indexing.enabled).toBe(false);
        expect(result.caveman_text_compression.enabled).toBe(false);
    });

    it("relocates legacy experimental.* graduated keys to top-level + memory.* (run-doctor warning)", () => {
        const config = JSON.stringify({
            experimental: {
                temporal_awareness: false,
                auto_search: { enabled: false },
                git_commit_indexing: { enabled: true, since_days: 30 },
                caveman_text_compression: { enabled: true, min_chars: 800 },
            },
        });
        const result = loadWithUserConfig(config);
        // Explicit user values survive the relocation (opt-outs/opt-ins preserved).
        expect(result.temporal_awareness).toBe(false);
        expect(result.caveman_text_compression.enabled).toBe(true);
        expect(result.caveman_text_compression.min_chars).toBe(800);
        // auto_search + git_commit_indexing land under memory.*
        expect(result.memory.auto_search.enabled).toBe(false);
        expect(result.memory.git_commit_indexing.enabled).toBe(true);
        expect(result.memory.git_commit_indexing.since_days).toBe(30);
        const warnings = result.configWarnings?.join("\n") ?? "";
        expect(warnings).toContain("experimental.temporal_awareness");
        expect(warnings).toContain('"memory.auto_search"');
        expect(warnings).toContain('"memory.git_commit_indexing"');
    });

    it("memory.* graduated key wins over a legacy experimental.* duplicate (sub-fields merge)", () => {
        const config = JSON.stringify({
            experimental: {
                git_commit_indexing: { enabled: false, since_days: 99, max_commits: 500 },
            },
            memory: { git_commit_indexing: { enabled: true } },
        });
        const result = loadWithUserConfig(config);
        // memory.* (graduated) enabled wins; missing sub-fields fill from old block.
        expect(result.memory.git_commit_indexing.enabled).toBe(true);
        expect(result.memory.git_commit_indexing.since_days).toBe(99);
        expect(result.memory.git_commit_indexing.max_commits).toBe(500);
    });
});

describe("loadPluginConfig — legacy agent enabled migration", () => {
    it("migrates dreamer.enabled=false to disable=true with manual-dream warning", () => {
        const result = loadWithUserConfig(JSON.stringify({ dreamer: { enabled: false } }));

        expect(result.dreamer?.disable).toBe(true);
        expect(result.configWarnings?.join("\n")).toContain(
            'Migrated "dreamer.enabled=false" → "dreamer.disable=true" in-memory (run doctor to persist). This now also disables manual /ctx-dream; for manual-only remove disable and set schedule="".',
        );
    });

    it("removes dreamer.enabled=true silently (no warning, no disable mutation)", () => {
        const result = loadWithUserConfig(JSON.stringify({ dreamer: { enabled: true } }));

        expect(result.dreamer?.disable).toBeUndefined();
        expect("enabled" in (result.dreamer as Record<string, unknown>)).toBe(false);
        // enabled=true is a no-op alias for the new default; no warning should be emitted.
        const warnings = result.configWarnings?.join("\n") ?? "";
        expect(warnings).not.toContain("dreamer.enabled=true");
        expect(warnings).not.toContain("dreamer.enabled");
    });

    it("migrates sidekick.enabled=false (loud) and removes sidekick.enabled=true (silent)", () => {
        const disabled = loadWithUserConfig(JSON.stringify({ sidekick: { enabled: false } }));
        expect(disabled.sidekick?.disable).toBe(true);
        expect(disabled.configWarnings?.join("\n")).toContain(
            'Migrated "sidekick.enabled=false" → "sidekick.disable=true" in-memory (run doctor to persist).',
        );

        const enabled = loadWithUserConfig(JSON.stringify({ sidekick: { enabled: true } }));
        expect(enabled.sidekick?.disable).toBeUndefined();
        expect("enabled" in (enabled.sidekick as Record<string, unknown>)).toBe(false);
        const enabledWarnings = enabled.configWarnings?.join("\n") ?? "";
        expect(enabledWarnings).not.toContain("sidekick.enabled");
    });

    it("removes invalid historian.enabled and applies conflict rules", () => {
        const result = loadWithUserConfig(
            JSON.stringify({
                historian: { enabled: false },
                dreamer: { enabled: false, disable: false },
                sidekick: { enabled: true, disable: true },
            }),
        );

        expect(result.historian).toEqual({ two_pass: false });
        expect(result.dreamer?.disable).toBe(true);
        expect(result.sidekick?.disable).toBe(true);
        expect(result.configWarnings?.join("\n")).toContain(
            'Removed invalid "historian.enabled" in-memory (run doctor to persist).',
        );
    });
});

describe("loadPluginConfig — variable expansion scope", () => {
    it("keeps {env:} and {file:} expansion enabled for user config", () => {
        const secretFile = join(mkdtempSync(join(tmpdir(), "mc-config-secret-")), "secret.txt");
        writeFileSync(secretFile, "file-secret", "utf-8");

        try {
            const result = loadWithUserConfig(
                JSON.stringify({
                    embedding: {
                        provider: "openai-compatible",
                        model: `{file:${secretFile}}`,
                        endpoint: "{env:MC_USER_ENDPOINT}",
                    },
                }),
                { MC_USER_ENDPOINT: "http://user-env.test/v1" },
            );

            expect(result.embedding.provider).toBe("openai-compatible");
            if (result.embedding.provider === "openai-compatible") {
                expect(result.embedding.model).toBe("file-secret");
                expect(result.embedding.endpoint).toBe("http://user-env.test/v1");
            }
            expect(result.configWarnings).toBeUndefined();
        } finally {
            rmSync(secretFile, { force: true });
        }
    });

    it("leaves {env:} and {file:} tokens literal in project config and warns", () => {
        const secretFile = join(mkdtempSync(join(tmpdir(), "mc-config-secret-")), "secret.txt");
        writeFileSync(secretFile, "project-file-secret", "utf-8");

        try {
            const result = loadWithUserAndProjectConfig(
                JSON.stringify({ enabled: true }),
                JSON.stringify({
                    embedding: {
                        provider: "openai-compatible",
                        model: `{file:${secretFile}}`,
                        endpoint: "{env:MC_PROJECT_ENDPOINT}",
                    },
                }),
                { MC_PROJECT_ENDPOINT: "http://project-env.test/v1" },
            );

            expect(result.embedding.provider).toBe("openai-compatible");
            if (result.embedding.provider === "openai-compatible") {
                expect(result.embedding.model).toBe(`{file:${secretFile}}`);
                expect(result.embedding.endpoint).toBe("{env:MC_PROJECT_ENDPOINT}");
            }
            const warnings = result.configWarnings?.join("\n") ?? "";
            expect(warnings).toContain("Project-level config no longer supports");
            expect(warnings).toContain("security reasons");
        } finally {
            rmSync(secretFile, { force: true });
        }
    });

    it("lets project literal token text override user-expanded secret values", () => {
        const result = loadWithUserAndProjectConfig(
            JSON.stringify({
                embedding: {
                    provider: "openai-compatible",
                    model: "user-model",
                    endpoint: "{env:MC_USER_ENDPOINT}",
                },
            }),
            JSON.stringify({
                embedding: {
                    endpoint: "{env:MC_PROJECT_LITERAL}",
                },
            }),
            {
                MC_USER_ENDPOINT: "http://user-expanded.test/v1",
                MC_PROJECT_LITERAL: "http://should-not-expand.test/v1",
            },
        );

        expect(result.embedding.provider).toBe("openai-compatible");
        if (result.embedding.provider === "openai-compatible") {
            expect(result.embedding.model).toBe("user-model");
            expect(result.embedding.endpoint).toBe("{env:MC_PROJECT_LITERAL}");
        }
    });
});

describe("loadPluginConfig — user-only settings", () => {
    it("allows user config to disable auto_update", () => {
        const result = loadWithUserConfig(JSON.stringify({ auto_update: false }));

        expect(result.auto_update).toBe(false);
    });

    it("prevents project config from overriding user auto_update", () => {
        const result = loadWithUserAndProjectConfig(
            JSON.stringify({ auto_update: true, enabled: true }),
            JSON.stringify({ auto_update: false, enabled: false }),
        );

        expect(result.auto_update).toBe(true);
        expect(result.enabled).toBe(false);
        expect(result.configWarnings?.join("\n")).toContain("Ignoring auto_update");
    });
});

describe("loadPluginConfig — raw merge preserves user fields not set in project", () => {
    // Regression for the 2026-05-12 embedding-wipe bug. Project configs that
    // don't mention `embedding` (or any other defaulted field) must inherit
    // the user's explicit value instead of getting clobbered by the Zod
    // default. Previously each source was parsed separately and Zod-filled
    // defaults appeared as if they were explicit project overrides.

    it("user embedding survives when project config omits embedding", () => {
        const userConfig = JSON.stringify({
            embedding: {
                provider: "openai-compatible",
                model: "text-embedding-qwen3-embedding-8b",
                endpoint: "http://localhost:1234/v1",
            },
        });
        const projectConfig = JSON.stringify({ ctx_reduce_enabled: true });

        const result = loadWithUserAndProjectConfig(userConfig, projectConfig);

        expect(result.embedding.provider).toBe("openai-compatible");
        if (result.embedding.provider === "openai-compatible") {
            expect(result.embedding.model).toBe("text-embedding-qwen3-embedding-8b");
            expect(result.embedding.endpoint).toBe("http://localhost:1234/v1");
        }
    });

    it("project can still override embedding when it explicitly sets one", () => {
        const userConfig = JSON.stringify({
            embedding: {
                provider: "openai-compatible",
                model: "user-model",
                endpoint: "http://user:1/v1",
            },
        });
        const projectConfig = JSON.stringify({
            embedding: {
                provider: "openai-compatible",
                model: "project-model",
                endpoint: "http://project:1/v1",
            },
        });

        const result = loadWithUserAndProjectConfig(userConfig, projectConfig);
        expect(result.embedding.provider).toBe("openai-compatible");
        if (result.embedding.provider === "openai-compatible") {
            expect(result.embedding.model).toBe("project-model");
            expect(result.embedding.endpoint).toBe("http://project:1/v1");
        }
    });

    it("user scalar field survives when project omits it", () => {
        // execute_threshold_percentage default is { default: 65, ... }. User
        // sets a value, project doesn't mention it — user must win.
        const result = loadWithUserAndProjectConfig(
            JSON.stringify({ execute_threshold_percentage: 30, enabled: true }),
            JSON.stringify({ ctx_reduce_enabled: false }),
        );

        // execute_threshold_percentage min is 20, so 30 is valid
        expect(result.execute_threshold_percentage).toBe(30);
        expect(result.ctx_reduce_enabled).toBe(false);
    });

    it("nested object fields deep-merge across user and project", () => {
        // User sets drop_tool_structure: false; project sets historian model.
        // Both must coexist in the merged result.
        const result = loadWithUserAndProjectConfig(
            JSON.stringify({
                drop_tool_structure: false,
                historian: { model: "anthropic/claude-opus-4-7" },
            }),
            JSON.stringify({
                historian: { fallback_models: ["anthropic/claude-sonnet-4-6"] },
            }),
        );

        expect(result.drop_tool_structure).toBe(false);
        expect(result.historian?.model).toBe("anthropic/claude-opus-4-7");
        expect(result.historian?.fallback_models).toEqual(["anthropic/claude-sonnet-4-6"]);
    });

    it("project boolean override beats user default", () => {
        // User: ctx_reduce_enabled defaults to true (omitted). Project sets false.
        const result = loadWithUserAndProjectConfig(
            JSON.stringify({ enabled: true }),
            JSON.stringify({ ctx_reduce_enabled: false }),
        );

        expect(result.ctx_reduce_enabled).toBe(false);
    });

    it("disabled_hooks union-merges across user and project", () => {
        const result = loadWithUserAndProjectConfig(
            JSON.stringify({ disabled_hooks: ["a", "b"] }),
            JSON.stringify({ disabled_hooks: ["b", "c"] }),
        );

        expect(result.disabled_hooks?.sort()).toEqual(["a", "b", "c"]);
    });
});
