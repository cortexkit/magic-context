import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as configLoader from "../../config";
import { cortexKitProjectConfigBasePath } from "../../config/migrate-config-location";
import { MagicContextConfigSchema } from "../../config/schema/magic-context";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import { resetCtxReduceRegisteredGloballyForTest } from "../../hooks/magic-context/ctx-reduce-availability";
import { _resetDreamTimerForTests } from "../../plugin/dream-timer";
import { _resetHarnessForTesting } from "../../shared/harness";
import { detectConfigFile } from "../../shared/jsonc-parser";
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import { registerContext } from "./context";
import * as dreamManual from "./dream-manual";
import * as storageGate from "./storage-gate";
import type { V2CommandInvocation, V2Context } from "./types";

/**
 * `/ctx-dream` on OpenCode 2 must run with the configuration the user has now,
 * not the one the plugin started with. The dreamer's model, variant and
 * fallback models are live settings: the scheduled runs re-read them before
 * every run, and the manual run has to read the same live sample.
 */

const directories: string[] = [];
const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
    for (const dispose of disposers.splice(0)) await dispose().catch(() => {});
    _resetDreamTimerForTests();
    closeDatabase();
    resetCtxReduceRegisteredGloballyForTest();
    _resetHarnessForTesting();
    for (const dir of directories.splice(0)) cleanupTestTempDir(dir);
});

function projectDirectory(): string {
    const { dir } = createTestTempDir("mc-v2-dream-manual-live-");
    directories.push(dir);
    return dir;
}

interface RegisteredCommand {
    name: string;
    execute: (input: V2CommandInvocation) => Promise<void>;
}

function fakeHost(directory: string, commands: RegisteredCommand[]): V2Context {
    return {
        location: { directory },
        agent: { transform: async () => {}, reload: async () => {} },
        model: { list: () => [] },
        storage: { get: async () => undefined, set: async () => {} },
        event: { subscribe: async function* () {} },
        tool: { hook: async () => {} },
        command: {
            async transform(callback: (editor: { add: (c: RegisteredCommand) => void }) => void) {
                callback({ add: (definition) => commands.push(definition) });
                return {};
            },
            async reload() {},
        },
        session: {
            remove: async () => {},
            compact: async () => {},
            interrupt: async () => ({ interrupted: true }),
            hook: async () => {},
            get: async () => ({ location: { directory } }),
        },
    } as unknown as V2Context;
}

function dreamerConfig(dreamer: Record<string, unknown>) {
    return MagicContextConfigSchema.parse({
        auto_update: false,
        historian: { disable: true },
        dreamer,
        memory: { enabled: false, git_commit_indexing: { enabled: false } },
        embedding: { provider: "off" },
    });
}

/**
 * Boot with `boot`, then change the configuration the loader returns to `next`
 * and touch the project config file, which is what makes the live reader load
 * again (it reloads only when one of the config files changed on disk).
 */
async function bootThenReload(
    directory: string,
    boot: ReturnType<typeof dreamerConfig>,
    next: ReturnType<typeof dreamerConfig>,
) {
    let current = boot;
    const detailed = configLoader.loadPluginConfigDetailed(directory, false);
    const load = spyOn(configLoader, "loadPluginConfigDetailed").mockImplementation(() => ({
        ...detailed,
        config: current,
    }));
    const db = openDatabase();
    if (!db) throw new Error("throwaway test store unavailable");
    // The storage gate opens the throwaway test store, so both the boot probe and
    // the dream handler's `storage.require()` find it.
    const createGate = storageGate.createV2StorageGate;
    const gate = spyOn(storageGate, "createV2StorageGate").mockImplementation((options) =>
        createGate({ ...options, open: () => db }),
    );
    const runs: Array<Parameters<typeof dreamManual.runManualDreamNow>[0]> = [];
    const manual = spyOn(dreamManual, "runManualDreamNow").mockImplementation(async (args) => {
        runs.push(args);
        return {
            summary: {
                ran: [],
                skippedNoWork: [],
                deferredBusy: [],
                failed: [],
                backlogBefore: {},
                backlogAfter: {},
            },
            unsupportedTasks: [],
        };
    });
    disposers.push(async () => {
        load.mockRestore();
        gate.mockRestore();
        manual.mockRestore();
    });

    const commands: RegisteredCommand[] = [];
    const duties = await registerContext(fakeHost(directory, commands));
    disposers.unshift(async () => {
        await duties?.dispose();
    });

    current = next;
    const projectConfig = detectConfigFile(cortexKitProjectConfigBasePath(directory)).path;
    mkdirSync(dirname(projectConfig), { recursive: true });
    writeFileSync(projectConfig, "{}\n");

    const dream = commands.find((command) => command.name === "ctx-dream");
    if (!dream) throw new Error("ctx-dream was not registered");
    return { dream, runs };
}

describe("OpenCode 2 manual /ctx-dream reads the live dreamer configuration", () => {
    test("a model changed after startup is the model the manual run uses", async () => {
        const directory = projectDirectory();
        const { dream, runs } = await bootThenReload(
            directory,
            dreamerConfig({
                opencode: {
                    model: "claude-agent/haiku",
                    variant: "high",
                    fallback_models: ["old/fallback"],
                },
            }),
            dreamerConfig({
                opencode: {
                    model: "opencode/deepseek-v4.1-flash-free",
                    variant: "low",
                    fallback_models: ["new/fallback"],
                },
            }),
        );

        await dream.execute({ sessionID: "ses_manual", prompt: { text: "" }, delivery: "steer" });

        expect(runs).toHaveLength(1);
        expect(runs[0]?.dreamer.opencode).toEqual({
            model: "opencode/deepseek-v4.1-flash-free",
            variant: "low",
            fallback_models: ["new/fallback"],
        });
    });

    test("a dreamer disabled after startup refuses the manual run", async () => {
        const directory = projectDirectory();
        const { dream, runs } = await bootThenReload(
            directory,
            dreamerConfig({ opencode: { model: "provider/model" } }),
            dreamerConfig({ disable: true, opencode: { model: "provider/model" } }),
        );

        await expect(
            dream.execute({ sessionID: "ses_manual", prompt: { text: "" }, delivery: "steer" }),
        ).rejects.toThrow("dreamer unavailable");
        expect(runs).toHaveLength(0);
    });
});
