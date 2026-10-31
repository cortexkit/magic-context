import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as configLoader from "../../config";
import { MagicContextConfigSchema } from "../../config/schema/magic-context";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import { resetCtxReduceRegisteredGloballyForTest } from "../../hooks/magic-context/ctx-reduce-availability";
import * as budgets from "../../hooks/magic-context/derive-budgets";
import * as transformModule from "../../hooks/magic-context/transform";
import { _resetDreamTimerForTests } from "../../plugin/dream-timer";
import { getSdkContextLimit, refreshModelLimitsFromApi } from "../../shared/models-dev-cache";
import { Database } from "../../shared/sqlite";
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import { registerContext } from "./context";
import { catalogProvidersPayload } from "./model-limit-cache";
import * as storageGate from "./storage-gate";
import type { SessionContext, V2Context } from "./types";

const config = MagicContextConfigSchema.parse({
    historian: {
        disable: true,
        maxTokens: 2048,
        opencode: { model: "anthropic/claude-sonnet-4-5" },
    },
    dreamer: { disable: true, inject_docs: false },
    memory: { enabled: false },
    allow_home_project: true,
});

let currentLimit = 1_000_000;
let listCalls = 0;
let hook: ((draft: SessionContext) => Promise<void>) | undefined;
let dispose: (() => Promise<void>) | undefined;
let dir: string;
const restores: Array<() => void> = [];
const oldEnv = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, OPENCODE_DB: process.env.OPENCODE_DB };
let releaseEvent: () => void = () => {};
const eventReady = new Promise<void>((resolve) => {
    releaseEvent = resolve;
});
let eventProcessed: () => void = () => {};
const processed = new Promise<void>((resolve) => {
    eventProcessed = resolve;
});

function catalog() {
    return {
        data: [
            {
                id: "gpt-4.1",
                providerID: "openai",
                name: "GPT-4.1",
                limit: { context: currentLimit, output: 32_000 },
            },
        ],
    };
}

function pass(id: string): SessionContext {
    return {
        sessionID: "ses-model-limit-refresh",
        model: {
            providerID: "openai",
            id: "gpt-4.1",
            limit: { context: currentLimit, output: 32_000 },
        },
        agent: "build",
        system: [],
        options: {},
        tools: {},
        messages: [{ id, role: "user", content: [{ type: "text", text: "hello" }] }],
    } as SessionContext;
}

beforeAll(async () => {
    dir = createTestTempDir("mc-v2-model-limit-refresh-").dir;
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

    // Warm the shared cache so the first pass does not start a background warm.
    await refreshModelLimitsFromApi({
        config: {
            providers: async () => ({
                data: { providers: catalogProvidersPayload(catalog()) },
            }),
        },
    });

    const load = spyOn(configLoader, "loadPluginConfigDetailed").mockReturnValue({
        config,
    } as ReturnType<typeof configLoader.loadPluginConfigDetailed>);
    // Boot and deferred admission must use the same throwaway store.
    const createGate = storageGate.createV2StorageGate;
    const probe = spyOn(storageGate, "createV2StorageGate").mockImplementation((options) =>
        createGate({ ...options, open: async () => db }),
    );
    const contextLimit = spyOn(budgets, "resolveKnownHistorianContextLimit").mockReturnValue(
        123456,
    );
    const fake = Object.assign(async () => {}, {
        getRustReplayParticipant: () => null,
        disposeRust: () => {},
    });
    const transform = spyOn(transformModule, "createTransform").mockImplementation(
        () => fake as unknown as ReturnType<typeof transformModule.createTransform>,
    );
    restores.push(
        () => load.mockRestore(),
        () => probe.mockRestore(),
        () => transform.mockRestore(),
        () => contextLimit.mockRestore(),
    );

    const duties = await registerContext({
        location: { directory: dir },
        agent: { transform: async () => {}, reload: async () => {} },
        model: {
            list: () => {
                listCalls += 1;
                return catalog();
            },
        },
        storage: { get: async () => undefined, set: async () => {} },
        event: {
            subscribe: async function* () {
                await eventReady;
                yield { type: "provider.updated", data: {} };
                eventProcessed();
            },
        },
        tool: { hook: async () => {} },
        session: {
            remove: async () => {},
            compact: async () => {},
            interrupt: async () => ({ interrupted: true }),
            hook: async (name: string, callback: typeof hook) => {
                if (name === "context") hook = callback;
            },
            get: async () => ({ location: { directory: dir } }),
        },
    } as unknown as V2Context);
    dispose = duties?.dispose;
    expect(hook).toBeFunction();
});

afterAll(async () => {
    releaseEvent();
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

test("re-reads the model catalog after a provider reload", async () => {
    const limit = () => getSdkContextLimit("openai", "gpt-4.1", undefined, { reservation: "none" });
    expect(limit()).toBe(1_000_000);

    await hook!(pass("u1"));
    const callsAfterFirstPass = listCalls;
    expect(callsAfterFirstPass).toBeGreaterThan(0);
    expect(limit()).toBe(1_000_000);

    currentLimit = 500_000;
    releaseEvent();
    await processed;

    await hook!(pass("u2"));
    expect(listCalls).toBe(callsAfterFirstPass + 1);
    expect(limit()).toBe(500_000);
});
