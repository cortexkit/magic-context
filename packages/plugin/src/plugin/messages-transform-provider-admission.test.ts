import { expect, mock, spyOn, test } from "bun:test";
import { openDatabase } from "../features/magic-context/storage-db";
import { getOrCreateSessionMeta } from "../features/magic-context/storage-meta";
import { captureLkgSlot } from "../hooks/magic-context/lkg-replay";
import * as slots from "../hooks/magic-context/lkg-slot";
import type { MessageLike } from "../hooks/magic-context/transform-operations";
import { createMessagesTransformHandler } from "./messages-transform";

test("writer retry leaves a provider session's stale legacy slot untouched", async () => {
    slots.resetLkgSlotsForTest();
    const db = openDatabase();
    if (!db) throw new Error("throwaway database unavailable");
    const sessionId = "provider-writer-merge";
    getOrCreateSessionMeta(db, sessionId);
    const raw = [
        {
            info: {
                id: "u",
                role: "user",
                sessionID: sessionId,
                model: { providerID: "openai", modelID: "gpt-4.1" },
            },
            parts: [{ type: "text", text: "input" }],
        },
    ] as MessageLike[];
    const legacy = structuredClone(raw);
    (legacy[0].parts[0] as { text: string }).text = "obsolete legacy representation";
    expect(
        captureLkgSlot({
            sessionId,
            input: raw,
            output: legacy,
            modelKey: "openai/gpt-4.1",
            providerKey: "openai",
        }),
    ).toBe(true);
    const providerOutput = structuredClone(raw);
    (providerOutput[0].parts[0] as { text: string }).text = "durable provider representation";
    const recover = mock((_id: string, output: { messages: unknown[] }) => {
        output.messages = providerOutput;
        return true;
    });
    const run = mock(async () => {
        throw new Error("provider unavailable");
    });
    const transform = Object.assign(run, {
        isProviderSession: () => true,
        recoverProviderOutput: recover,
    });
    const exec = db.exec.bind(db);
    let attempts = 0;
    const writer = spyOn(db, "exec").mockImplementation((sql) => {
        if (sql === "BEGIN IMMEDIATE" && ++attempts === 1)
            throw Object.assign(new Error("busy"), { code: "SQLITE_BUSY" });
        return exec(sql);
    });
    const slotRead = spyOn(slots, "getSlot");
    const entry = spyOn(slots, "noteEntry");
    try {
        const output = { messages: structuredClone(raw) };
        const handler = createMessagesTransformHandler({
            magicContext: { "experimental.chat.messages.transform": transform },
        });
        await handler({}, output as Parameters<typeof handler>[1]);
        expect(attempts).toBeGreaterThanOrEqual(2);
        expect(run).toHaveBeenCalledTimes(1);
        expect(recover).toHaveBeenCalledTimes(1);
        expect(output.messages).toEqual(providerOutput);
        expect(slotRead).not.toHaveBeenCalled();
        expect(entry).not.toHaveBeenCalled();
    } finally {
        writer.mockRestore();
        slotRead.mockRestore();
        entry.mockRestore();
        slots.resetLkgSlotsForTest();
    }
});
