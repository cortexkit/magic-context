import { afterEach, expect, spyOn, test } from "bun:test";
import { openDatabase } from "../features/magic-context/storage-db";
import { saveLkgSlotToDb } from "../hooks/magic-context/lkg-persist";
import { captureLkgSlot } from "../hooks/magic-context/lkg-replay";
import { getSlot, resetLkgSlotsForTest } from "../hooks/magic-context/lkg-slot";
import { STORAGE_BUSY_MESSAGE } from "../hooks/magic-context/storage-busy-refusal";
import type { MessageLike } from "../hooks/magic-context/transform-operations";
import { Database, withAsyncPrivilegedWriter } from "../shared/sqlite";
import { adaptPayload } from "../v2/hooks/payload";
import type { SessionContext } from "../v2/hooks/types";
import { createMessagesTransformHandler } from "./messages-transform";

afterEach(() => resetLkgSlotsForTest());

for (const host of ["OpenCode 1", "OpenCode 2"]) {
    function fixture() {
        const draft = {
            sessionID: `busy-${host}`,
            model: { providerID: "test", id: "model" },
            messages: [
                { id: "u0", role: "user", content: [{ type: "text", text: "old history" }] },
                { id: "u1", role: "user", content: [{ type: "text", text: "new question" }] },
            ],
        } as SessionContext;
        const mapped = adaptPayload(draft, new Set());
        const output =
            host === "OpenCode 2" ? mapped : { messages: structuredClone(mapped.messages) };
        const bytes = () => {
            if (host === "OpenCode 2") {
                mapped.commit();
                return JSON.stringify(draft.messages);
            }
            return JSON.stringify(output.messages);
        };
        return { output, bytes };
    }
    type Output = Parameters<ReturnType<typeof createMessagesTransformHandler>>[1];
    test(`${host}: busy with LKG serves managed bytes`, async () => {
        expect(openDatabase()).not.toBeNull();
        const { output, bytes } = fixture();
        const input = structuredClone(output.messages) as MessageLike[];
        const managed = structuredClone(input);
        (managed[0].parts[0] as { text: string }).text = "managed summary";
        expect(
            captureLkgSlot({
                sessionId: `busy-${host}`,
                input,
                output: managed,
                modelKey: "test/model",
                providerKey: "test",
            }),
        ).toBe(true);
        expect(
            saveLkgSlotToDb(openDatabase()!, `busy-${host}`, getSlot(`busy-${host}`)!, undefined, {
                rebuild: true,
            }),
        ).toBe(true);
        const handler = createMessagesTransformHandler({
            magicContext: {
                "experimental.chat.messages.transform": async () => {
                    throw Object.assign(new Error("lock after acquisition"), {
                        code: "SQLITE_BUSY",
                    });
                },
            },
        });
        await handler({}, output as Output);
        expect(bytes()).toContain("managed summary");
        expect(bytes()).not.toContain("old history");
    });
    for (const clearsOn of [2, 3]) {
        test(`${host}: acquisition clears on ${clearsOn}, output bytes match uncontended`, async () => {
            const db = new Database(":memory:");
            db.exec(
                "CREATE TABLE context_privilege_state(id INTEGER PRIMARY KEY, enabled INTEGER)",
            );
            const realExec = db.exec.bind(db);
            let attempts = 0;
            let callbacks = 0;
            const exec = spyOn(db, "exec").mockImplementation((sql) => {
                if (sql === "BEGIN IMMEDIATE" && ++attempts < clearsOn)
                    throw Object.assign(new Error("locked"), { code: "SQLITE_BUSY" });
                return realExec(sql);
            });
            try {
                const handler = createMessagesTransformHandler({
                    magicContext: {
                        "experimental.chat.messages.transform": async (_input, output) => {
                            await withAsyncPrivilegedWriter(db, () => {
                                callbacks++;
                                (output.messages[0].parts[0] as { text: string }).text =
                                    "managed summary";
                            });
                        },
                    },
                });
                const retried = fixture();
                await handler({}, retried.output as Output);
                expect(attempts).toBe(clearsOn);
                expect(callbacks).toBe(1);
                exec.mockRestore();
                const unbusy = fixture();
                await handler({}, unbusy.output as Output);
                expect(retried.bytes()).toBe(unbusy.bytes());
                expect(retried.bytes()).toContain("managed summary");
            } finally {
                exec.mockRestore();
                db.close();
            }
        });
    }
    test(`${host}: perpetual busy refuses and does not return raw`, async () => {
        const { output } = fixture();
        let notices = 0;
        const handler = createMessagesTransformHandler({
            onRefusal: async (_session, message) => {
                expect(message).toBe(`${STORAGE_BUSY_MESSAGE} [STORAGE_BUSY_REFUSAL]`);
                notices++;
            },
            magicContext: {
                "experimental.chat.messages.transform": async () => {
                    throw Object.assign(new Error("still locked"), { code: "SQLITE_BUSY" });
                },
            },
        });
        await expect(handler({}, output as Output)).rejects.toThrow(STORAGE_BUSY_MESSAGE);
        expect(notices).toBe(1);
    });
    test(`${host}: compaction off passes through busy`, async () => {
        const { output, bytes } = fixture();
        const raw = bytes();
        const handler = createMessagesTransformHandler({
            compactionOff: true,
            magicContext: {
                "experimental.chat.messages.transform": async () => {
                    throw Object.assign(new Error("still locked"), { code: "SQLITE_BUSY" });
                },
            },
        });
        await handler({}, output as Output);
        expect(bytes()).toBe(raw);
    });
}
