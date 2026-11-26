import { expect, mock, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Media } from "@opencode/ai/media";
import { Message } from "@opencode/ai/schema/messages";
import * as configLoader from "../../config";
import { MagicContextConfigSchema } from "../../config/schema/magic-context";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage-db";
import { updateSessionMeta } from "../../features/magic-context/storage-meta";
import { resetCtxReduceRegisteredGloballyForTest } from "../../hooks/magic-context/ctx-reduce-availability";
import { estimateFinalWireInputTokens } from "../../hooks/magic-context/final-wire-token-estimate";
import { saveLkgSlotToDb } from "../../hooks/magic-context/lkg-persist";
import { captureLkgSlot } from "../../hooks/magic-context/lkg-replay";
import { lkgReplayFits } from "../../hooks/magic-context/lkg-replay-fit";
import { getSlot, resetLkgSlotsForTest } from "../../hooks/magic-context/lkg-slot";
import * as transformModule from "../../hooks/magic-context/transform";
import type { MessageLike } from "../../hooks/magic-context/transform-operations";
import * as logger from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import { resetHostMediaForTests } from "../fold/host-media";
import { registerContext } from "./context";
import { adaptPayload, clonePreservingInstances } from "./payload";
import * as storageGate from "./storage-gate";
import type { SessionContext, V2Context } from "./types";

const png = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fccfc0500f000485018084a98c210000000049454e44ae426082",
    "hex",
);
const pngBase64 = png.toString("base64");

function hostMessage(input: Parameters<typeof Message.make>[0]) {
    return Message.make(input) as unknown as SessionContext["messages"][number];
}

test.each([
    ["v2 outer admission serves validated LKG before writer backoff", undefined],
    ["v2 outer admission replays a saved base64 image before writer backoff", "base64"],
    ["v2 outer admission replays a saved bytes image before writer backoff", "bytes"],
] as const)("%s", async (_name, imageSource) => {
    const { dir } = createTestTempDir("mc-v2-lkg-admission-");
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
    const diagnostics: unknown[][] = [];
    const logging = spyOn(logger, "sessionLog").mockImplementation((...args) => {
        diagnostics.push(args);
    });
    let callbacks = 0;
    const fakeTransform = Object.assign(
        async (_input: unknown, output: { messages: MessageLike[] }) => {
            callbacks++;
            const input = clonePreservingInstances(output.messages);
            (output.messages[0].parts[0] as { text: string }).text = "saved managed prefix";
            captureLkgSlot({
                sessionId: "ses-v2-lkg-order",
                input,
                output: output.messages,
                modelKey: "openai/gpt-4.1",
                providerKey: "openai",
            });
            if (
                !saveLkgSlotToDb(db, "ses-v2-lkg-order", getSlot("ses-v2-lkg-order")!, undefined, {
                    rebuild: true,
                })
            )
                throw new Error("Fixture LKG did not commit");
        },
        { getRustReplayParticipant: () => null, disposeRust: () => {} },
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
            hook: async (name: string, callback: (draft: SessionContext) => Promise<void>) => {
                if (name === "context") hook = callback;
            },
            get: async () => ({ location: { directory: dir } }),
        },
    } as unknown as V2Context;
    let duties: Awaited<ReturnType<typeof registerContext>>;
    let execSpy: ReturnType<typeof spyOn> | undefined;
    try {
        resetHostMediaForTests();
        resetLkgSlotsForTest();
        duties = await registerContext(host);
        const input: SessionContext = {
            sessionID: "ses-v2-lkg-order",
            model: { providerID: "openai", id: "gpt-4.1", limit: { context: 1000000 } },
            agent: "build",
            system: [],
            options: {},
            tools: { read: { description: "read file", input: { type: "object" } } },
            messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hello" }] }],
        };
        if (imageSource) {
            const options = { info: { width: 1, height: 1 } };
            const media =
                imageSource === "base64"
                    ? Media.base64(pngBase64, "image/png", options)
                    : Media.bytes(new Uint8Array(png), "image/png", options);
            input.messages = [
                hostMessage({
                    id: "u1",
                    role: "user",
                    content: [
                        { type: "text", text: "hello" },
                        { type: "media", media, filename: "pixel.png" },
                        { type: "text", text: "what is in this image?" },
                    ],
                }),
            ];
        }
        const first = clonePreservingInstances(input);
        await hook!(first);
        const slot = getSlot(input.sessionID);
        if (!slot) throw new Error("Fixture LKG was not captured");
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
        const replay = clonePreservingInstances(input);
        const tail = imageSource
            ? [
                  hostMessage({
                      id: "a1",
                      role: "assistant",
                      content: [{ type: "text", text: "A pixel." }],
                  }),
                  hostMessage({
                      id: "u2",
                      role: "user",
                      content: [{ type: "text", text: "Describe its color." }],
                  }),
              ]
            : [];
        replay.messages.push(...tail);
        const tailJson = JSON.stringify(tail);
        const firstJson = JSON.stringify(first.messages);
        await hook!(replay);
        expect(attempts, JSON.stringify(diagnostics)).toBe(1);
        expect(callbacks, JSON.stringify(diagnostics)).toBe(1);
        expect(replay.system).toEqual(first.system);
        expect(interrupt).not.toHaveBeenCalled();
        if (imageSource) {
            expect(diagnostics.some((row) => String(row[1]).endsWith("lkg_replay_served"))).toBe(
                true,
            );
            expect(JSON.stringify(replay.messages.slice(0, first.messages.length))).toBe(firstJson);
            expect(JSON.stringify(replay.messages.slice(first.messages.length))).toBe(tailJson);
            const originalImage = first.messages[0].content[1].media;
            const replayedImage = replay.messages[0].content[1].media;
            expect(replayedImage).toBeInstanceOf(Media.Asset);
            expect(replayedImage).not.toBe(originalImage);
            expect(JSON.stringify(replayedImage)).toBe(JSON.stringify(originalImage));
            for (const message of replay.messages)
                expect(() => Message.make(message as never)).not.toThrow();

            const saved = JSON.parse(slot.jsonPrefix) as MessageLike[];
            expect(saved[0].parts[1]).toMatchObject({
                type: "media",
                media: { source: { type: imageSource, mediaType: "image/png", data: pngBase64 } },
            });
            expect(saved[0].parts[1].media).not.toHaveProperty("mediaType");
            const estimate = (messages: MessageLike[]) =>
                estimateFinalWireInputTokens({
                    messages,
                    systemPromptTokens: 100,
                    toolDefinitionTokens: 100,
                    providerID: "openai",
                    modelID: "gpt-4.1",
                });
            const live = estimate(adaptPayload(first).messages);
            expect(live.trusted).toBe(true);
            expect(estimate(saved)).toMatchObject({
                trusted: true,
                tokens: live.tokens,
                messageTokens: live.messageTokens,
            });
            // A MIME type alone does not make an image measurable.
            saved[0].parts[1] = {
                type: "media",
                media: { source: { type: "base64", mediaType: "image/png", data: "" } },
            };
            expect(estimate(saved).trusted).toBe(false);
        } else expect(replay.messages).toEqual(first.messages);
    } finally {
        execSpy?.mockRestore();
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
