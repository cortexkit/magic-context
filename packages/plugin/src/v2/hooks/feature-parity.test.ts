import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as configLoader from "../../config";
import { MagicContextConfigSchema } from "../../config/schema/magic-context";
import { resolveProjectIdentityForSession } from "../../features/magic-context/memory/project-identity";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import { resetCtxReduceRegisteredGloballyForTest } from "../../hooks/magic-context/ctx-reduce-availability";
import * as budgets from "../../hooks/magic-context/derive-budgets";
import * as transformModule from "../../hooks/magic-context/transform";
import { _resetDreamTimerForTests } from "../../plugin/dream-timer";
import { ensureProjectRegisteredFromOpenCodeDirectory } from "../../plugin/embedding-bootstrap";
import { Database } from "../../shared/sqlite";
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import { registerContext } from "./context";
import * as storageGate from "./storage-gate";
import { createV2TransformFeatureDeps } from "./transform-features";
import type { SessionContext, V2Context } from "./types";

const config = MagicContextConfigSchema.parse({
    historian: {
        disable: true,
        maxTokens: 2048,
        opencode: { model: "anthropic/claude-sonnet-4-5" },
    },
    dreamer: { disable: true, inject_docs: false },
    memory: {
        enabled: false,
        auto_search: { enabled: true, score_threshold: 0.73, min_prompt_chars: 37 },
    },
    protected_tools: { read: 4 },
    history_budget_percentage: 0.23,
    temporal_awareness: true,
    mural: { enabled: true },
    caveman_text_compression: { enabled: true, min_chars: 123 },
    commit_cluster_trigger: { enabled: true, min_clusters: 3 },
    allow_home_project: true,
});
let deps: transformModule.TransformDeps;
let dispose: (() => Promise<void>) | undefined;
let dir: string;
const restores: Array<() => void> = [];
const oldEnv = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, OPENCODE_DB: process.env.OPENCODE_DB };

beforeAll(async () => {
    dir = createTestTempDir("mc-v2-feature-parity-").dir;
    process.env.XDG_DATA_HOME = dir;
    process.env.OPENCODE_DB = join(dir, "opencode", "opencode.db");
    mkdirSync(join(dir, "opencode"));
    const store = new Database(process.env.OPENCODE_DB);
    store.exec(
        "CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT, time_updated INTEGER); CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT NOT NULL);",
    );
    store.close();
    const db = openDatabase(join(dir, "context.db"));
    if (!db) throw new Error("throwaway store unavailable");
    const load = spyOn(configLoader, "loadPluginConfigDetailed").mockReturnValue({
        config,
    } as ReturnType<typeof configLoader.loadPluginConfigDetailed>);
    const probe = spyOn(storageGate, "probeV2StorageAtBoot").mockResolvedValue(db);
    const contextLimit = spyOn(budgets, "resolveKnownHistorianContextLimit").mockReturnValue(
        123456,
    );
    const fake = Object.assign(async () => {}, {
        getRustReplayParticipant: () => null,
        disposeRust: () => {},
    });
    const transform = spyOn(transformModule, "createTransform").mockImplementation((args) => {
        deps = args;
        return fake as unknown as ReturnType<typeof transformModule.createTransform>;
    });
    restores.push(
        () => load.mockRestore(),
        () => probe.mockRestore(),
        () => transform.mockRestore(),
        () => contextLimit.mockRestore(),
    );
    let hook: ((draft: SessionContext) => Promise<void>) | undefined;
    const duties = await registerContext({
        location: { directory: dir },
        agent: { transform: async () => {}, reload: async () => {} },
        model: { list: () => [] },
        storage: { get: async () => undefined, set: async () => {} },
        event: { subscribe: async function* () {} },
        tool: { hook: async () => {} },
        session: {
            remove: async () => {},
            compact: async () => {},
            interrupt: async () => ({}),
            hook: async (name: string, callback: typeof hook) => {
                if (name === "context") hook = callback;
            },
            get: async () => ({ location: { directory: dir } }),
        },
    } as unknown as V2Context);
    dispose = duties?.dispose;
    await hook!({
        sessionID: "ses-v2-feature-parity",
        model: { providerID: "openai", id: "gpt-4.1", limit: { context: 1000000 } },
        agent: "build",
        system: [],
        options: {},
        tools: {},
        messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hello" }] }],
    });
    expect(deps).toBeDefined();
});

afterAll(async () => {
    await dispose?.();
    for (const restore of restores) restore();
    _resetDreamTimerForTests();
    closeDatabase();
    resetCtxReduceRegisteredGloballyForTest();
    cleanupTestTempDir(dir);
    for (const [key, value] of Object.entries(oldEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

test("v2 wires autoSearch", () => {
    expect(deps.autoSearch).toMatchObject({
        enabled: true,
        scoreThreshold: 0.73,
        minPromptChars: 37,
        directory: dir,
        ensureProjectRegistered: deps.ensureProjectRegistered,
    });
    expect(deps.autoSearch?.wordRules).toBeDefined();
});
test("v2 wires cavemanTextCompression", () => {
    expect(deps.cavemanTextCompression).toMatchObject({ enabled: true, minChars: 123 });
    expect(deps.cavemanTextCompression?.wordRules).toBeDefined();
});
test("v2 wires protectedTools", () => expect(deps.protectedTools).toEqual(config.protected_tools));
test("v2 wires commitClusterTrigger", () =>
    expect(deps.commitClusterTrigger).toEqual(config.commit_cluster_trigger));
test("v2 wires allowHomeProject", () => expect(deps.allowHomeProject).toBe(true));
test("v2 wires injectDocs", () => expect(deps.injectDocs).toBe(false));
test("v2 wires ensureProjectRegistered through context ownership", () => {
    expect(deps.ensureProjectRegistered).toBeFunction();
    expect(deps.ensureProjectRegistered).not.toBe(ensureProjectRegisteredFromOpenCodeDirectory);
});
test("v2 wires historyBudgetPercentage", () => expect(deps.historyBudgetPercentage).toBe(0.23));
// This config disables the dreamer, so review-user-memories can never run and
// the historian neither stores user observations nor is asked for them.
test("v2 wires experimentalUserMemories", () => expect(deps.experimentalUserMemories).toBe(false));
test("v2 wires userObservationsRequested", () =>
    expect(deps.userObservationsRequested).toBe(false));
test("v2 wires experimentalTemporalAwareness", () =>
    expect(deps.experimentalTemporalAwareness).toBe(true));
test("v2 wires muralEnabled", () => expect(deps.muralEnabled).toBe(true));
test("v2 wires commitSeenLastPass", () => expect(deps.commitSeenLastPass).toBeInstanceOf(Map));
test("v2 wires maybeAutoEmbedSession", () => expect(deps.maybeAutoEmbedSession).toBeFunction());
test("v2 wires getHistorianChunkTokens", () =>
    expect(deps.getHistorianChunkTokens?.()).toBe(deps.resolveHistorianRun!().chunkTokens));
test("v2 wires historianContextLimit", () => {
    expect(deps.historianContextLimit).toBe(123456);
    expect(deps.historianContextLimit).toBe(deps.resolveHistorianRun!().contextLimit);
});
test("v2 wires getFallbackModelId", () =>
    expect(deps.getFallbackModelId?.("ses-v2-feature-parity")).toBe("openai/gpt-4.1"));
test("v2 wires project identity", () =>
    expect(deps.projectPath).toBe(resolveProjectIdentityForSession(dir, true)));
test("v2 omits caveman when compaction is off", () =>
    expect(createV2TransformFeatureDeps(config, true, dir).cavemanTextCompression).toBeUndefined());
test("v2 collects and requests user observations with a runnable dreamer", () => {
    const runnable = MagicContextConfigSchema.parse({ dreamer: {} });
    const features = createV2TransformFeatureDeps(runnable, false, dir);
    expect(features.experimentalUserMemories).toBe(true);
    expect(features.userObservationsRequested).toBe(true);
});
