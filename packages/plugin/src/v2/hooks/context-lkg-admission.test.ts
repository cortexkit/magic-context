import { expect, mock, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as configLoader from "../../config";
import { MagicContextConfigSchema } from "../../config/schema/magic-context";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage-db";
import { updateSessionMeta } from "../../features/magic-context/storage-meta";
import { resetCtxReduceRegisteredGloballyForTest } from "../../hooks/magic-context/ctx-reduce-availability";
import { captureLkgSlot } from "../../hooks/magic-context/lkg-replay";
import { lkgReplayFits } from "../../hooks/magic-context/lkg-replay-fit";
import { getSlot, resetLkgSlotsForTest } from "../../hooks/magic-context/lkg-slot";
import * as transformModule from "../../hooks/magic-context/transform";
import type { MessageLike } from "../../hooks/magic-context/transform-operations";
import * as messagesTransform from "../../plugin/messages-transform";
import * as logger from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import { registerContext } from "./context";
import { adaptPayload } from "./payload";
import * as storageGate from "./storage-gate";
import type { SessionContext, V2Context } from "./types";

for (const provider of [false, true]) {
    test(
        provider
            ? "v2 outer admission never tries a legacy slot for an active provider session"
            : "v2 outer admission serves validated LKG before writer backoff",
        async () => {
            const { dir } = createTestTempDir("mc-v2-lkg-admission-");
            const oldDataHome = process.env.XDG_DATA_HOME;
            const oldDb = process.env.OPENCODE_DB;
            process.env.XDG_DATA_HOME = dir;
            process.env.OPENCODE_DB = join(dir, "opencode", "opencode.db");
            mkdirSync(join(dir, "opencode"));
            const store = new Database(process.env.OPENCODE_DB);
            store.exec(
                "CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT); CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT NOT NULL);",
            );
            store.close();
            const db = openDatabase(join(dir, "context.db"));
            if (!db) throw new Error("throwaway test store unavailable");
            const config = MagicContextConfigSchema.parse({
                historian: { disable: true },
                dreamer: { disable: true },
                memory: { enabled: false },
            });
            const load = spyOn(configLoader, "loadPluginConfigDetailed").mockReturnValue({
                config,
            } as ReturnType<typeof configLoader.loadPluginConfigDetailed>);
            const probe = spyOn(storageGate, "probeV2StorageAtBoot").mockResolvedValue(db);
            const diagnostics: unknown[][] = [];
            const logging = spyOn(logger, "sessionLog").mockImplementation((...args) => {
                diagnostics.push(args);
            });
            let callbacks = 0;
            const fakeTransform = Object.assign(
                async (_input: unknown, output: { messages: MessageLike[] }) => {
                    callbacks++;
                    const input = structuredClone(output.messages);
                    (output.messages[0].parts[0] as { text: string }).text = "saved managed prefix";
                    captureLkgSlot({
                        sessionId: "ses-v2-lkg-order",
                        input,
                        output: output.messages,
                        modelKey: "openai/gpt-4.1",
                        providerKey: "openai",
                    });
                },
                {
                    isProviderSession: () => provider,
                    getRustReplayParticipant: () => null,
                    disposeRust: () => {},
                },
            );
            const transform = spyOn(transformModule, "createTransform").mockReturnValue(
                fakeTransform as ReturnType<typeof transformModule.createTransform>,
            );
            let hook: ((draft: SessionContext) => Promise<void>) | undefined;
            const interrupt = mock(async () => ({ interrupted: true }));
            const host = {
                location: { directory: dir },
                agent: { transform: async () => {}, reload: async () => {} },
                model: { list: () => [] },
                storage: { get: async () => undefined, set: async () => {} },
                event: { subscribe: async function* () {} },
                tool: { hook: async () => {} },
                session: {
                    remove: async () => {},
                    compact: async () => {},
                    interrupt,
                    hook: async (
                        name: string,
                        callback: (draft: SessionContext) => Promise<void>,
                    ) => {
                        if (name === "context") hook = callback;
                    },
                    get: async () => ({ location: { directory: dir } }),
                },
            } as unknown as V2Context;
            let duties: Awaited<ReturnType<typeof registerContext>>;
            let execSpy: ReturnType<typeof spyOn> | undefined;
            let replaySpy: ReturnType<typeof spyOn> | undefined;
            try {
                resetLkgSlotsForTest();
                duties = await registerContext(host);
                const input: SessionContext = {
                    sessionID: "ses-v2-lkg-order",
                    model: { providerID: "openai", id: "gpt-4.1", limit: { context: 1000000 } },
                    agent: "build",
                    system: [],
                    options: {},
                    tools: { read: { description: "read file", input: { type: "object" } } },
                    messages: [
                        { id: "u1", role: "user", content: [{ type: "text", text: "hello" }] },
                    ],
                };
                const first = structuredClone(input);
                await hook!(first);
                expect(getSlot(input.sessionID)).toBeDefined();
                const activeDb = openDatabase();
                if (!activeDb) throw new Error("active throwaway store unavailable");
                updateSessionMeta(activeDb, input.sessionID, { systemPromptTokens: 100 });
                expect(
                    lkgReplayFits({
                        db: activeDb,
                        sessionId: input.sessionID,
                        messages: adaptPayload(first).messages,
                        model: { providerID: "openai", modelID: "gpt-4.1" },
                        modelKey: "openai/gpt-4.1",
                        systemPromptTokens: 100,
                        agentName: "build",
                    }).fits,
                ).toBe(true);
                const exec = activeDb.exec.bind(activeDb);
                let attempts = 0;
                execSpy = spyOn(activeDb, "exec").mockImplementation((sql) => {
                    if (sql === "BEGIN IMMEDIATE" && ++attempts === 1)
                        throw Object.assign(new Error("writer busy"), { code: "SQLITE_BUSY" });
                    return exec(sql);
                });
                const replay = structuredClone(input);
                replaySpy = spyOn(messagesTransform, "tryMessagesTransformLkgReplay");
                await hook!(replay);
                if (provider) {
                    expect(attempts, JSON.stringify(diagnostics)).toBeGreaterThanOrEqual(2);
                    expect(callbacks).toBe(2);
                    expect(replaySpy).not.toHaveBeenCalled();
                } else {
                    expect(attempts, JSON.stringify(diagnostics)).toBe(1);
                    expect(callbacks).toBe(1);
                    expect(replaySpy).toHaveBeenCalledTimes(1);
                }
                expect(replay.messages).toEqual(first.messages);
                expect(replay.system).toEqual(first.system);
                expect(interrupt).not.toHaveBeenCalled();
            } finally {
                execSpy?.mockRestore();
                replaySpy?.mockRestore();
                await duties?.dispose();
                probe.mockRestore();
                transform.mockRestore();
                logging.mockRestore();
                load.mockRestore();
                closeDatabase();
                resetLkgSlotsForTest();
                resetCtxReduceRegisteredGloballyForTest();
                cleanupTestTempDir(dir);
                if (oldDataHome === undefined) delete process.env.XDG_DATA_HOME;
                else process.env.XDG_DATA_HOME = oldDataHome;
                if (oldDb === undefined) delete process.env.OPENCODE_DB;
                else process.env.OPENCODE_DB = oldDb;
            }
        },
    );
}
