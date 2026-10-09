import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    buildDreamTaskRuntimeConfigs,
    userMemoryCollectionEnabled,
} from "../features/magic-context/dreamer/task-config";
import { producerInputTokenLimit } from "../hooks/magic-context/producer-window-guard";
import { resolveDreamerTaskModel, resolveHistorianModel } from "../shared/model-resolution";
import { createTestTempDirFromPath } from "../shared/test-temp-dir";
import { loadPluginConfigDetailed } from "./index";
import { dreamerRunConfig, historianRunConfig } from "./live-run-config";
import { LiveConfigReader } from "./live-snapshot";

for (const host of ["OC1", "OC2", "Pi", "OMP"] as const) {
    test(`${host} historian samples the next generation while an existing run keeps its model and fallback`, () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "mc-live-historian-"));
        const previous = { home: process.env.HOME, config: process.env.XDG_CONFIG_HOME };
        process.env.HOME = root;
        process.env.XDG_CONFIG_HOME = join(root, "config");
        const directory = join(root, "project");
        const file = join(root, "config", "cortexkit", "magic-context.jsonc");
        mkdirSync(join(root, "config", "cortexkit"), { recursive: true });
        mkdirSync(join(directory, ".cortexkit"), { recursive: true });
        try {
            const block = host === "Pi" ? "pi" : host === "OMP" ? "omp" : "opencode";
            const write = (
                model: string,
                fallback: string,
                autoPromote: boolean,
                minClusters: number,
                maxTokens: number,
            ) =>
                writeFileSync(
                    file,
                    JSON.stringify({
                        historian: { maxTokens, [block]: { model, fallback_models: [fallback] } },
                        memory: { auto_promote: autoPromote },
                        commit_cluster_trigger: { enabled: true, min_clusters: minClusters },
                    }),
                );
            write("anthropic/old-model", "anthropic/old-fallback", true, 3, 4096);
            const load = () => loadPluginConfigDetailed(directory, false).config;
            const boot = load();
            const reader = new LiveConfigReader(directory, boot, load, () => {});
            reader.poll();
            const runOne = historianRunConfig(boot, reader.current().effective);
            write(
                "anthropic/new-model-with-longer-name",
                "anthropic/new-fallback-with-longer-name",
                false,
                5,
                8192,
            );
            const runTwo = historianRunConfig(boot, reader.poll().effective);
            const harness = host === "Pi" ? "pi" : host === "OMP" ? "omp" : "opencode";
            expect(resolveHistorianModel(runOne, harness).primary?.model).toBe(
                "anthropic/old-model",
            );
            expect(resolveHistorianModel(runOne, harness).fallbacks[0]?.model).toBe(
                "anthropic/old-fallback",
            );
            expect(resolveHistorianModel(runTwo, harness).primary?.model).toBe(
                "anthropic/new-model-with-longer-name",
            );
            expect(resolveHistorianModel(runTwo, harness).fallbacks[0]?.model).toBe(
                "anthropic/new-fallback-with-longer-name",
            );
            expect(runOne.memory.auto_promote).toBe(true);
            expect(runTwo.memory.auto_promote).toBe(false);
            expect(runOne.commit_cluster_trigger.min_clusters).toBe(3);
            expect(runTwo.commit_cluster_trigger.min_clusters).toBe(5);
            expect(runOne.historian?.maxTokens).toBe(4096);
            expect(runTwo.historian?.maxTokens).toBe(8192);
            expect(producerInputTokenLimit(32_000, runTwo.historian?.maxTokens ?? 0)).toBe(23_093);
            expect(reader.current().generation).toBe(2);
        } finally {
            if (previous.home === undefined) delete process.env.HOME;
            else process.env.HOME = previous.home;
            if (previous.config === undefined) delete process.env.XDG_CONFIG_HOME;
            else process.env.XDG_CONFIG_HOME = previous.config;
            rmSync(root, { recursive: true, force: true });
        }
    });
}

for (const host of ["OC1", "OC2", "Pi", "OMP"] as const) {
    test(`${host} dreamer samples the new schedule and model chain without changing a running task`, () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "mc-live-dreamer-"));
        const previous = { home: process.env.HOME, config: process.env.XDG_CONFIG_HOME };
        process.env.HOME = root;
        process.env.XDG_CONFIG_HOME = join(root, "config");
        const directory = join(root, "project");
        const userFile = join(root, "config", "cortexkit", "magic-context.jsonc");
        const projectFile = join(directory, ".cortexkit", "magic-context.jsonc");
        mkdirSync(join(root, "config", "cortexkit"), { recursive: true });
        mkdirSync(join(directory, ".cortexkit"), { recursive: true });
        try {
            const block = host === "Pi" ? "pi" : host === "OMP" ? "omp" : "opencode";
            writeFileSync(
                userFile,
                JSON.stringify({
                    dreamer: {
                        maxTokens: 4096,
                        [block]: { model: "old/model", fallback_models: ["old/fallback"] },
                    },
                }),
            );
            const writeSchedule = (schedule: string) =>
                writeFileSync(
                    projectFile,
                    JSON.stringify({
                        dreamer: {
                            tasks: {
                                verify: { schedule },
                                "review-user-memories": {
                                    schedule: schedule === "0 3 * * *" ? "" : "0 0 * * *",
                                },
                            },
                        },
                    }),
                );
            writeSchedule("0 3 * * *");
            const load = () => loadPluginConfigDetailed(directory, false).config;
            const boot = load();
            const reader = new LiveConfigReader(directory, boot, load, () => {});
            reader.poll();
            const runOne = dreamerRunConfig(boot, reader.current().effective);
            writeFileSync(
                userFile,
                JSON.stringify({
                    dreamer: {
                        maxTokens: 8192,
                        [block]: {
                            model: "new/model-long",
                            fallback_models: ["new/fallback-long"],
                        },
                    },
                }),
            );
            writeSchedule("15 4 * * *");
            const runTwo = dreamerRunConfig(boot, reader.poll().effective);
            const task = (cfg: typeof runOne) =>
                buildDreamTaskRuntimeConfigs(
                    cfg.dreamer,
                    host === "Pi" ? "pi" : host === "OMP" ? "omp" : "opencode",
                ).find((entry) => entry.task === "verify")!;
            expect(task(runOne).schedule).toBe("0 3 * * *");
            expect(userMemoryCollectionEnabled(runOne.dreamer)).toBe(false);
            expect(task(runOne).model?.model).toBe("old/model");
            expect(task(runOne).fallbackModels[0]?.model).toBe("old/fallback");
            expect(task(runTwo).schedule).toBe("15 4 * * *");
            expect(runOne.dreamer?.maxTokens).toBe(4096);
            expect(runTwo.dreamer?.maxTokens).toBe(8192);
            expect(
                userMemoryCollectionEnabled(
                    historianRunConfig(boot, reader.current().effective).dreamer,
                ),
            ).toBe(true);
            expect(task(runTwo).model?.model).toBe("new/model-long");
            expect(task(runTwo).fallbackModels[0]?.model).toBe("new/fallback-long");
        } finally {
            if (previous.home === undefined) delete process.env.HOME;
            else process.env.HOME = previous.home;
            if (previous.config === undefined) delete process.env.XDG_CONFIG_HOME;
            else process.env.XDG_CONFIG_HOME = previous.config;
            rmSync(root, { recursive: true, force: true });
        }
    });
}

test("malformed project config retains last good values and deduplicates the warning; project overrides remain tier-safe", () => {
    const root = createTestTempDirFromPath(join(tmpdir(), "mc-live-tiers-"));
    const previous = { home: process.env.HOME, config: process.env.XDG_CONFIG_HOME };
    process.env.HOME = root;
    process.env.XDG_CONFIG_HOME = join(root, "config");
    const directory = join(root, "project");
    const userFile = join(root, "config", "cortexkit", "magic-context.jsonc");
    const projectFile = join(directory, ".cortexkit", "magic-context.jsonc");
    mkdirSync(join(root, "config", "cortexkit"), { recursive: true });
    mkdirSync(join(directory, ".cortexkit"), { recursive: true });
    const warnings: string[] = [];
    try {
        writeFileSync(
            userFile,
            JSON.stringify({
                dreamer: {
                    opencode: { model: "user/model" },
                    tasks: { verify: { schedule: "0 3 * * *" } },
                    prompt: "trusted",
                },
                historian: { opencode: { model: "user/historian" } },
            }),
        );
        writeFileSync(
            projectFile,
            JSON.stringify({
                dreamer: {
                    opencode: { model: "project/model" },
                    tasks: { verify: { schedule: "1 3 * * *" } },
                    prompt: "untrusted",
                },
                historian: { opencode: { model: "project/historian" } },
            }),
        );
        const load = () => loadPluginConfigDetailed(directory, false).config;
        const reader = new LiveConfigReader(directory, load(), load, (message) =>
            warnings.push(message),
        );
        const first = reader.poll();
        expect(first.effective.dreamer?.opencode?.model).toBe("project/model");
        expect(first.effective.dreamer?.prompt).toBe("trusted");
        expect(resolveHistorianModel(first.effective, "opencode").primary?.model).toBe(
            "user/historian",
        );
        writeFileSync(projectFile, "{ broken:");
        expect(reader.poll()).toBe(first);
        expect(reader.poll()).toBe(first);
        expect(warnings.filter((message) => message.includes("config reload failed"))).toHaveLength(
            1,
        );
        writeFileSync(
            projectFile,
            JSON.stringify({
                dreamer: {
                    opencode: { model: "project/new-model" },
                    tasks: { verify: { schedule: "2 3 * * *" } },
                    prompt: "still-untrusted",
                },
                historian: { opencode: { model: "project/new-historian" } },
            }),
        );
        const second = reader.poll();
        expect(second.generation).toBe(2);
        expect(second.effective.dreamer?.opencode?.model).toBe("project/new-model");
        expect(second.effective.dreamer?.tasks?.verify.schedule).toBe("2 3 * * *");
        expect(second.effective.dreamer?.prompt).toBe("trusted");
        expect(resolveHistorianModel(second.effective, "opencode").primary?.model).toBe(
            "user/historian",
        );
        expect(first.effective.dreamer?.opencode?.model).toBe("project/model");
    } finally {
        if (previous.home === undefined) delete process.env.HOME;
        else process.env.HOME = previous.home;
        if (previous.config === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = previous.config;
        rmSync(root, { recursive: true, force: true });
    }
});

test("OMP keeps the pi historian and dreamer models when the config has no omp block", () => {
    // Live sampling used to create empty parent objects for every live path. An empty
    // `omp` block then shadowed the `pi` block OMP falls back to, and OMP ran the
    // historian and dreamer on its own default model.
    const config = {
        historian: { pi: { model: "anthropic/claude-sonnet-5-5" } },
        dreamer: {
            pi: {
                model: "anthropic/claude-sonnet-5-5",
                tasks: { curate: { model: "openai/gpt-6-luna" } },
            },
        },
    } as unknown as Parameters<typeof historianRunConfig>[0];
    for (const sampled of [historianRunConfig(config, config), dreamerRunConfig(config, config)]) {
        expect((sampled as { historian?: Record<string, unknown> }).historian?.omp).toBeUndefined();
        expect((sampled as { dreamer?: Record<string, unknown> }).dreamer?.omp).toBeUndefined();
        expect(resolveHistorianModel(sampled, "omp").primary?.model).toBe(
            "anthropic/claude-sonnet-5-5",
        );
        expect(
            resolveDreamerTaskModel({ config: sampled, harness: "omp", task: "curate" }).primary
                ?.model,
        ).toBe("openai/gpt-6-luna");
    }
});

test("live sampling clears a key removed from the fresh config without touching the boot object", () => {
    const boot = {
        historian: { pi: { model: "anthropic/claude-sonnet-5-5" } },
    } as unknown as Parameters<typeof historianRunConfig>[0];
    const fresh = { historian: { pi: {} } } as unknown as Parameters<typeof historianRunConfig>[0];
    const sampled = historianRunConfig(boot, fresh);
    expect(resolveHistorianModel(sampled, "pi").primary).toBeUndefined();
    expect(resolveHistorianModel(boot, "pi").primary?.model).toBe("anthropic/claude-sonnet-5-5");
});
