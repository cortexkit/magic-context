import { expect, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as configLoader from "../../config";
import { MagicContextConfigSchema } from "../../config/schema/magic-context";
import * as storage from "../../features/magic-context/storage";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage-db";
import {
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage-meta";
import {
    beginV2LkgRequest,
    clearLkgMeasuredRequest,
    currentLkgRequestIdentity,
    noteLkgProviderResponse,
} from "../../hooks/magic-context/lkg-measured-request";
import {
    bindSystemPromptResponse,
    recordHeldHeadForRequest,
    recordSystemPromptForRequest,
} from "../../hooks/magic-context/system-prompt-delivery";
import { Database } from "../../shared/sqlite";
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import { registerContext } from "./context";
import * as storageGate from "./storage-gate";
import type { V2Context } from "./types";

test("v2 session deletion retires the prepared system delivery before a late reply", async () => {
    const { dir } = createTestTempDir("mc-v2-delivery-deletion-");
    const oldHome = process.env.XDG_DATA_HOME;
    const oldStore = process.env.OPENCODE_DB;
    process.env.XDG_DATA_HOME = dir;
    process.env.OPENCODE_DB = join(dir, "opencode", "opencode.db");
    mkdirSync(join(dir, "opencode"));
    const store = new Database(process.env.OPENCODE_DB);
    store.exec(
        "CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT, time_updated INTEGER); CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT NOT NULL);",
    );
    store.close();
    const db = openDatabase(join(dir, "context.db"));
    if (!db) throw new Error("missing temporary database");
    const sessionId = "v2-deleted-delivery";
    getOrCreateSessionMeta(db, sessionId);
    updateSessionMeta(db, sessionId, { cachedM0SystemHash: "old" });
    const config = MagicContextConfigSchema.parse({
        historian: { disable: true },
        dreamer: { disable: true },
        memory: { enabled: false },
    });
    const load = spyOn(configLoader, "loadPluginConfigDetailed").mockReturnValue({
        config,
    } as ReturnType<typeof configLoader.loadPluginConfigDetailed>);
    const probe = spyOn(storageGate, "probeV2StorageAtBoot").mockResolvedValue(db);
    let release: () => void = () => {};
    const eventReady = new Promise<void>((resolve) => {
        release = resolve;
    });
    let cleared: () => void = () => {};
    const deleted = new Promise<void>((resolve) => {
        cleared = resolve;
    });
    const clear = storage.clearSession;
    const observe = spyOn(storage, "clearSession").mockImplementation(
        (...args: Parameters<typeof clear>) => {
            const result = clear(...args);
            if (args[1] === sessionId) cleared();
            return result;
        },
    );
    const host = {
        location: { directory: dir },
        agent: { transform: async () => {}, reload: async () => {} },
        model: { list: () => [] },
        storage: { get: async () => undefined, set: async () => {} },
        tool: { hook: async () => {} },
        event: {
            subscribe: async function* () {
                await eventReady;
                yield { type: "session.deleted", data: { sessionID: sessionId } };
            },
        },
        session: {
            remove: async () => {},
            compact: async () => {},
            interrupt: async () => {},
            hook: async () => {},
            get: async () => ({ location: { directory: dir } }),
        },
    } as unknown as V2Context;
    let duties: Awaited<ReturnType<typeof registerContext>> | undefined;
    try {
        duties = await registerContext(host);
        const modelKey = "anthropic/claude-opus-5-5";
        beginV2LkgRequest(sessionId, modelKey, "previous", 10);
        const request = currentLkgRequestIdentity(sessionId);
        const createdAt = Date.now() + 1;
        recordSystemPromptForRequest(sessionId, request, "prepared", db);
        recordHeldHeadForRequest(sessionId, request);
        bindSystemPromptResponse(sessionId, request, { responseId: "reply", createdAt, modelKey });
        release();
        await deleted;
        noteLkgProviderResponse({
            sessionId,
            responseId: "reply",
            modelKey,
            createdAt,
            completedAt: createdAt + 1,
            finish: "stop",
            inputTokens: 1000,
            v2: true,
        });
        expect(
            db
                .prepare("SELECT COUNT(*) AS count FROM session_meta WHERE session_id=?")
                .get(sessionId),
        ).toEqual({ count: 0 });
    } finally {
        release();
        await duties?.dispose();
        observe.mockRestore();
        probe.mockRestore();
        load.mockRestore();
        clearLkgMeasuredRequest(sessionId);
        closeDatabase();
        cleanupTestTempDir(dir);
        if (oldHome === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = oldHome;
        if (oldStore === undefined) delete process.env.OPENCODE_DB;
        else process.env.OPENCODE_DB = oldStore;
    }
}, 120_000);
