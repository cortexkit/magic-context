import { expect, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Media } from "@opencode/ai/media";
import { Message } from "@opencode/ai/schema/messages";
import * as configLoader from "../../config";
import { MagicContextConfigSchema } from "../../config/schema/magic-context";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage-db";
import { updateSessionMeta } from "../../features/magic-context/storage-meta";
import { resetCtxReduceRegisteredGloballyForTest } from "../../hooks/magic-context/ctx-reduce-availability";
import { saveLkgSlotToDb } from "../../hooks/magic-context/lkg-persist";
import { captureLkgSlot } from "../../hooks/magic-context/lkg-replay";
import { getSlot, resetLkgSlotsForTest } from "../../hooks/magic-context/lkg-slot";
import * as transformModule from "../../hooks/magic-context/transform";
import type { MessageLike } from "../../hooks/magic-context/transform-operations";
import * as logger from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import { resetHostMediaForTests } from "../fold/host-media";
import { unavailableAttachmentNote } from "../fold/restore";
import { registerContext } from "./context";
import { clonePreservingInstances } from "./payload";
import * as storageGate from "./storage-gate";
import type { SessionContext, V2Context } from "./types";

const SESSION = "ses-v2-lkg-flat-media";
const PNG =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** A request as the host builds it: its own message class and its own Media.Asset. */
function hostDraft(): SessionContext {
    return {
        sessionID: SESSION,
        model: { providerID: "openai", id: "gpt-4.1", limit: { context: 1000000 } },
        agent: "build",
        system: [],
        options: {},
        tools: { read: { description: "read file", input: { type: "object" } } },
        messages: [
            Message.make({
                id: "u1",
                role: "user",
                content: [
                    { type: "text", text: "what is in this image?" },
                    { type: "media", media: Media.base64(PNG, "image/png"), filename: "pixel.png" },
                ],
            }) as unknown as SessionContext["messages"][number],
        ],
    };
}

// An older build restored attachments after a host checkpoint as a flat
// `{ type: "media", mediaType, data }` part, and the saved copy of that request (the
// last-known-good replay) kept it: the copy is taken from the transform's output, before
// the request is handed to the host. OpenCode 2.3 cannot prepare a request holding that
// part. The saved copy must never be replayed (the replay fit check cannot size the flat
// part, so it declines the copy), and the pass that runs instead must hand the host the
// restore's note, never the flat part, with the same bytes on every later request.
test("a saved replay holding a flat media part is declined, and the pass serves the note with the same bytes next time", async () => {
    const { dir } = createTestTempDir("mc-v2-lkg-flat-media-");
    const oldDataHome = process.env.XDG_DATA_HOME;
    const oldDb = process.env.OPENCODE_DB;
    process.env.XDG_DATA_HOME = dir;
    process.env.OPENCODE_DB = join(dir, "opencode", "opencode.db");
    mkdirSync(join(dir, "opencode"));
    const store = new Database(process.env.OPENCODE_DB);
    store.exec(
        "CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT, time_updated INTEGER); CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT NOT NULL);",
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
    const diagnostics: string[] = [];
    const logging = spyOn(logger, "sessionLog").mockImplementation((_session, message) => {
        diagnostics.push(String(message));
    });
    let callbacks = 0;
    // Every managed pass puts the flat part in its output, the way the older build's
    // restore produced it, and saves that output as the replay copy.
    const fakeTransform = Object.assign(
        async (_input: unknown, output: { messages: MessageLike[] }) => {
            callbacks++;
            const input = clonePreservingInstances(output.messages);
            output.messages[0].parts[1] = {
                type: "media",
                mediaType: "image/png",
                data: PNG,
                filename: "pixel.png",
            };
            captureLkgSlot({
                sessionId: SESSION,
                input,
                output: output.messages,
                modelKey: "openai/gpt-4.1",
                providerKey: "openai",
            });
            if (!saveLkgSlotToDb(db, SESSION, getSlot(SESSION)!, undefined, { rebuild: true }))
                throw new Error("Fixture LKG did not commit");
        },
        { getRustReplayParticipant: () => null, disposeRust: () => {} },
    );
    const transform = spyOn(transformModule, "createTransform").mockReturnValue(
        fakeTransform as ReturnType<typeof transformModule.createTransform>,
    );
    let hook: ((draft: SessionContext) => Promise<void>) | undefined;
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
            interrupt: async () => ({ interrupted: true }),
            hook: async (name: string, callback: (draft: SessionContext) => Promise<void>) => {
                if (name === "context") hook = callback;
            },
            get: async () => ({ location: { directory: dir } }),
        },
    } as unknown as V2Context;
    let duties: Awaited<ReturnType<typeof registerContext>> | undefined;
    const execSpies: Array<ReturnType<typeof spyOn>> = [];
    try {
        resetHostMediaForTests();
        resetLkgSlotsForTest();
        duties = await registerContext(host);
        await hook!(hostDraft());
        expect(callbacks).toBe(1);
        expect(getSlot(SESSION)?.jsonPrefix).toContain('"mediaType":"image/png","data"');
        const activeDb = openDatabase();
        if (!activeDb) throw new Error("active throwaway store unavailable");
        updateSessionMeta(activeDb, SESSION, { systemPromptTokens: 100 });
        // A busy writer makes each later request try the saved copy first.
        let busy = false;
        const exec = activeDb.exec.bind(activeDb);
        execSpies.push(
            spyOn(activeDb, "exec").mockImplementation((sql) => {
                if (sql === "BEGIN IMMEDIATE" && busy) {
                    busy = false;
                    throw Object.assign(new Error("writer busy"), { code: "SQLITE_BUSY" });
                }
                return exec(sql);
            }),
        );
        const replay = hostDraft();
        busy = true;
        await hook!(replay);
        const again = hostDraft();
        busy = true;
        await hook!(again);

        // Neither later request replayed the saved copy: the fit check could not size the
        // flat part, so each declined it and ran a pass instead.
        expect(diagnostics.filter((line) => line.startsWith("lkg_fit_untrusted"))).toHaveLength(2);
        expect(diagnostics.filter((line) => line === "lkg_replay_declined")).toHaveLength(2);
        expect(diagnostics.some((line) => line.endsWith("lkg_replay_served"))).toBe(false);
        expect(callbacks, diagnostics.join("\n")).toBe(3);
        // Each pass hands the host the restore's note in place of the flat part.
        const note = unavailableAttachmentNote("pixel.png", "image/png");
        expect(replay.messages[0]?.content).toEqual([
            { type: "text", text: "what is in this image?" },
            { type: "text", text: note },
        ]);
        expect(() => Message.make(replay.messages[0] as never)).not.toThrow();
        expect(JSON.stringify(again.messages)).toBe(JSON.stringify(replay.messages));
        // The saved copy is the transform's output, taken before the request is handed to
        // the host, so it still holds the flat part.
        expect(getSlot(SESSION)?.jsonPrefix).toContain('"mediaType":"image/png","data"');
    } finally {
        for (const spy of execSpies) spy.mockRestore();
        await duties?.dispose();
        probe.mockRestore();
        transform.mockRestore();
        logging.mockRestore();
        load.mockRestore();
        closeDatabase();
        resetLkgSlotsForTest();
        resetHostMediaForTests();
        resetCtxReduceRegisteredGloballyForTest();
        cleanupTestTempDir(dir);
        if (oldDataHome === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = oldDataHome;
        if (oldDb === undefined) delete process.env.OPENCODE_DB;
        else process.env.OPENCODE_DB = oldDb;
    }
});
