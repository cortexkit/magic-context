import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as configLoader from "../../config";
import { MagicContextConfigSchema, type MagicContextConfig } from "../../config/schema/magic-context";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import { resetCtxReduceRegisteredGloballyForTest } from "../../hooks/magic-context/ctx-reduce-availability";
import { _resetDreamTimerForTests } from "../../plugin/dream-timer";
import { getSubagentPolicy, resetSubagentPolicy } from "../../plugin/subagent-policy";
import { _resetHarnessForTesting } from "../../shared/harness";
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import { setup } from "../server";
import * as storageGate from "./storage-gate";
import type { V2Context } from "./types";

/**
 * OpenCode 2 boots through `setup` only. These tests pin that the boot installs
 * the project's `subagent` switches (the OpenCode 1 lane was the only caller of
 * `setSubagentPolicy` before), that a disabled project does not disturb a policy
 * another project installed, and the documented process-wide limitation: the
 * last enabled project to boot wins.
 */

const directories: string[] = [];
const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
    for (const dispose of disposers.splice(0)) await dispose().catch(() => {});
    _resetDreamTimerForTests();
    closeDatabase();
    resetCtxReduceRegisteredGloballyForTest();
    _resetHarnessForTesting();
    resetSubagentPolicy();
    for (const dir of directories.splice(0)) cleanupTestTempDir(dir);
});

function projectDirectory(): string {
    const { dir } = createTestTempDir("mc-v2-subagent-wiring-");
    directories.push(dir);
    return dir;
}

function fakeHost(directory: string): V2Context {
    return {
        location: { directory },
        agent: { transform: async () => {}, reload: async () => {} },
        model: { list: () => [] },
        storage: { get: async () => undefined, set: async () => {} },
        event: { subscribe: async function* () {} },
        tool: { hook: async () => {} },
        session: {
            remove: async () => {},
            compact: async () => {},
            interrupt: async () => ({ interrupted: true }),
            hook: async () => {},
            get: async () => ({ location: { directory } }),
        },
    } as unknown as V2Context;
}

function configFor(
    overrides: Partial<{ enabled: boolean; compress: boolean; memory_write: boolean }>,
): MagicContextConfig {
    return MagicContextConfigSchema.parse({
        enabled: overrides.enabled ?? true,
        auto_update: false,
        historian: { disable: true },
        dreamer: { disable: true },
        memory: { enabled: false },
        embedding: { provider: "off" },
        subagent: {
            compress: overrides.compress ?? false,
            memory_write: overrides.memory_write ?? false,
        },
    });
}

/** Serve a per-directory config, the way one process sees several open projects. */
function mockConfigsByDirectory(configs: Map<string, MagicContextConfig>): void {
    const detailed = configLoader.loadPluginConfigDetailed(projectDirectory(), false);
    const load = spyOn(configLoader, "loadPluginConfigDetailed").mockImplementation(
        (directory: string) =>
            ({ ...detailed, config: configs.get(directory) ?? configFor({}) }) as never,
    );
    const db = openDatabase();
    if (!db) throw new Error("throwaway test store unavailable");
    const probe = spyOn(storageGate, "probeV2StorageAtBoot").mockResolvedValue(db);
    disposers.push(async () => {
        load.mockRestore();
        probe.mockRestore();
    });
}

describe("OpenCode 2 subagent policy wiring", () => {
    test("setup installs the project's subagent switches", async () => {
        const directory = projectDirectory();
        mockConfigsByDirectory(
            new Map([[directory, configFor({ compress: true, memory_write: true })]]),
        );
        expect(getSubagentPolicy()).toEqual({ compress: false, memoryWrite: false });

        const dispose = await setup(fakeHost(directory));

        expect(getSubagentPolicy()).toEqual({ compress: true, memoryWrite: true });
        await dispose();
    });

    test("a disabled project does not reset a policy another project installed", async () => {
        const enabledDirectory = projectDirectory();
        const disabledDirectory = projectDirectory();
        mockConfigsByDirectory(
            new Map([
                [enabledDirectory, configFor({ compress: true, memory_write: true })],
                [
                    disabledDirectory,
                    configFor({ enabled: false, compress: false, memory_write: false }),
                ],
            ]),
        );

        const disposeEnabled = await setup(fakeHost(enabledDirectory));
        const disposeDisabled = await setup(fakeHost(disabledDirectory));

        expect(getSubagentPolicy()).toEqual({ compress: true, memoryWrite: true });
        await disposeDisabled();
        await disposeEnabled();
    });

    test("the last enabled project to boot owns the process-wide policy", async () => {
        const first = projectDirectory();
        const second = projectDirectory();
        mockConfigsByDirectory(
            new Map([
                [first, configFor({ compress: true, memory_write: true })],
                [second, configFor({ compress: false, memory_write: true })],
            ]),
        );

        const disposeFirst = await setup(fakeHost(first));
        expect(getSubagentPolicy()).toEqual({ compress: true, memoryWrite: true });

        const disposeSecond = await setup(fakeHost(second));

        // Documented limitation, not an accident: the policy lives in the module,
        // and OpenCode 2 runs one plugin instance per project in the process.
        expect(getSubagentPolicy()).toEqual({ compress: false, memoryWrite: true });
        await disposeSecond();
        await disposeFirst();
    });
});
