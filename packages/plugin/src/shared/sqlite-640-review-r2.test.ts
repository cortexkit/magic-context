import { expect, spyOn, test } from "bun:test";
import { openDatabase } from "../features/magic-context/storage-db";
import { getOrCreateSessionMeta, updateSessionMeta } from "../features/magic-context/storage-meta";
import { captureLkgSlot, replayLkg } from "../hooks/magic-context/lkg-replay";
import { resetLkgSlotsForTest } from "../hooks/magic-context/lkg-slot";
import type { RustLkgReplayParticipant } from "../hooks/magic-context/rust-lkg-freeze-registry";
import type { MessageLike } from "../hooks/magic-context/transform-operations";
import { createMessagesTransformHandler } from "../plugin/messages-transform";

for (const change of ["content", "reorder", "interior deletion"] as const) {
    test(`r2: OpenCode admission validates current ${change} after a backed-off wait`, async () => {
        resetLkgSlotsForTest();
        const db = openDatabase();
        if (!db) throw new Error("throwaway database unavailable");
        const sessionId = `r2-stale-${change}`;
        getOrCreateSessionMeta(db, sessionId);
        const model = { providerID: "openai", modelID: "gpt-4.1" };
        const raw = ["u0", "u1", "u2"].map((id) => ({
            info: { id, role: "user", sessionID: sessionId, model },
            parts: [{ type: "text", text: id }],
        })) as MessageLike[];
        const saved = structuredClone(raw);
        (saved[0].parts[0] as { text: string }).text = "§1§ saved managed prefix";
        const capture = () =>
            captureLkgSlot({
                sessionId,
                input: raw,
                output: saved,
                modelKey: "openai/gpt-4.1",
                providerKey: "openai",
            });
        expect(capture()).toBe(true);
        const output = { messages: structuredClone(raw) };
        let fits = 0;
        let callbacks = 0;
        let changed: MessageLike[] | undefined;
        const participant: RustLkgReplayParticipant = {
            lastPassStamp: () => 1,
            enterFreezeFromExternalServe: () => {},
            emergencyFailClosed: () => false,
            stripPersistedReasoning: () => {},
            replayFits: () => ++fits > 1,
        };
        const exec = db.exec.bind(db);
        let attempts = 0;
        const spy = spyOn(db, "exec").mockImplementation((sql) => {
            if (sql === "BEGIN IMMEDIATE" && ++attempts <= 2) {
                if (attempts === 1)
                    setImmediate(() => {
                        if (change === "content")
                            (output.messages[0].parts[0] as { text: string }).text =
                                "history edited while waiting";
                        else if (change === "reorder")
                            [output.messages[0], output.messages[1]] = [
                                output.messages[1],
                                output.messages[0],
                            ];
                        else output.messages.splice(1, 1);
                        changed = structuredClone(output.messages);
                    });
                throw Object.assign(new Error("writer busy"), { code: "SQLITE_BUSY" });
            }
            return exec(sql);
        });
        try {
            const handler = createMessagesTransformHandler({
                rustReplayParticipant: () => participant,
                magicContext: {
                    "experimental.chat.messages.transform": async () => {
                        callbacks++;
                    },
                },
            });
            await handler({}, output as Parameters<typeof handler>[1]);
            expect(changed).toBeDefined();
            // A fresh validator rejects this exact input, independently of the wrapper's snapshot.
            expect(capture()).toBe(true);
            expect(
                replayLkg({
                    sessionId,
                    messages: changed!,
                    modelKey: "openai/gpt-4.1",
                    providerKey: "openai",
                }).ok,
            ).toBe(false);
            expect(callbacks).toBe(1);
            expect(output.messages).toEqual(changed!);
        } finally {
            spy.mockRestore();
            resetLkgSlotsForTest();
        }
    });
}

test("r2: writer callback runs once after three failed acquisitions with no saved request", async () => {
    resetLkgSlotsForTest();
    const db = openDatabase();
    if (!db) throw new Error("throwaway database unavailable");
    getOrCreateSessionMeta(db, "r2-three-busy");
    updateSessionMeta(db, "r2-three-busy", { systemPromptTokens: 100 });
    const exec = db.exec.bind(db);
    let attempts = 0;
    let callbacks = 0;
    const spy = spyOn(db, "exec").mockImplementation((sql) => {
        if (sql === "BEGIN IMMEDIATE" && ++attempts <= 3)
            throw Object.assign(new Error("busy"), { code: "SQLITE_BUSY" });
        return exec(sql);
    });
    try {
        const handler = createMessagesTransformHandler({
            magicContext: {
                "experimental.chat.messages.transform": async () => {
                    callbacks++;
                },
            },
        });
        const output = {
            messages: [
                {
                    info: { id: "u", sessionID: "r2-three-busy", role: "user" },
                    parts: [{ type: "text", text: "§1§ managed" }],
                },
            ],
        };
        const bytes = JSON.stringify(output);
        await handler({}, output as Parameters<typeof handler>[1]);
        expect({ attempts, callbacks, bytes: JSON.stringify(output) }).toEqual({
            attempts: 4,
            callbacks: 1,
            bytes,
        });
    } finally {
        spy.mockRestore();
        resetLkgSlotsForTest();
    }
});
