import { expect, test } from "bun:test";
import {
    clearSyntheticCandidates,
    deliverSynthetic,
    isAdmittedSynthetic,
    observeSyntheticAdmissionEvent,
} from "./channel2";
import { adaptPayload } from "./payload";
import type { SessionContext } from "./types";

function fixture() {
    const records = new Map<string, unknown>();
    let reads = 0;
    const context = {
        storage: {
            get: async (key: string): Promise<unknown> => {
                reads++;
                return records.get(key);
            },
            set: async (key: string, value: unknown) => {
                records.set(key, value);
            },
            remove: async (key: string) => {
                records.delete(key);
            },
        },
        session: { synthetic: async () => {} },
    };
    return { context, records, reads: () => reads };
}

test("synthetic admission reuses 500 decisions, reads only new ids and preserves payload bytes", async () => {
    const f = fixture();
    try {
        const draft: SessionContext = {
            sessionID: "s",
            model: { providerID: "p", id: "m" },
            agent: "build",
            system: [],
            tools: {},
            options: {},
            messages: Array.from({ length: 500 }, (_, i) => ({
                id: `m${i}`,
                role: "user",
                content: [{ type: "text", text: `message ${i}` }],
            })),
        };
        for (let i = 0; i < 500; i += 2) f.records.set(`synthetic/s/m${i}`, { id: `m${i}` });
        const pass = async () => {
            const admitted = new Set<string>();
            for (const message of draft.messages)
                if (await isAdmittedSynthetic(f.context, "s", message.id!))
                    admitted.add(message.id!);
            const copy = structuredClone(draft);
            const mapped = adaptPayload(copy, admitted);
            const projection = JSON.stringify(mapped.messages);
            mapped.commit();
            return { projection, sent: JSON.stringify(copy) };
        };
        const expected = new Set(
            draft.messages.filter((_, i) => i % 2 === 0).map((message) => message.id!),
        );
        expect((await pass()).projection).toBe(
            JSON.stringify(adaptPayload(structuredClone(draft), expected).messages),
        );
        expect(f.reads()).toBe(500);
        const first = await pass();
        expect(await pass()).toEqual(first);
        expect(f.reads()).toBe(500);
        expect(await isAdmittedSynthetic(f.context, "s", "new")).toBe(false);
        expect(f.reads()).toBe(501);
    } finally {
        clearSyntheticCandidates(f.context);
    }
});

test("synthetic admission expires positive and negative decisions on writes, removals and delivery", async () => {
    const f = fixture();
    try {
        expect(await isAdmittedSynthetic(f.context, "s", "id")).toBe(false);
        await f.context.storage.set("synthetic/s/id", { id: "id" });
        expect(await isAdmittedSynthetic(f.context, "s", "id")).toBe(true);
        await f.context.storage.set("synthetic/s/id", { id: "wrong" });
        expect(await isAdmittedSynthetic(f.context, "s", "id")).toBe(false);
        await f.context.storage.set("synthetic/s/id", { id: "id" });
        expect(await isAdmittedSynthetic(f.context, "s", "id")).toBe(true);
        await f.context.storage.remove("synthetic/s/id");
        expect(await isAdmittedSynthetic(f.context, "s", "id")).toBe(false);
        const before = f.reads();
        await deliverSynthetic(f.context, "s", "reminder");
        expect(await isAdmittedSynthetic(f.context, "s", "id")).toBe(false);
        expect(f.reads()).toBe(before + 1);
    } finally {
        clearSyntheticCandidates(f.context);
    }
});

test("synthetic admission forgets reverts, deletion and disposal and isolates storage and sessions", async () => {
    const f = fixture();
    const other = fixture();
    try {
        await f.context.storage.set("synthetic/s/id", { id: "id" });
        expect(await isAdmittedSynthetic(f.context, "s", "id")).toBe(true);
        expect(await isAdmittedSynthetic(other.context, "s", "id")).toBe(false);
        expect(await isAdmittedSynthetic(f.context, "other", "id")).toBe(false);
        for (const type of [
            "session.revert.started",
            "session.revert.committed",
            "session.deleted",
        ]) {
            const before = f.reads();
            observeSyntheticAdmissionEvent(f.context, { type, data: { sessionID: "s" } });
            expect(await isAdmittedSynthetic(f.context, "s", "id")).toBe(true);
            expect(f.reads()).toBe(before + 1);
            expect(await isAdmittedSynthetic(f.context, "other", "id")).toBe(false);
            expect(f.reads()).toBe(before + 1);
        }
        const before = f.reads();
        clearSyntheticCandidates(f.context);
        expect(await isAdmittedSynthetic(f.context, "s", "id")).toBe(true);
        expect(f.reads()).toBe(before + 1);
    } finally {
        clearSyntheticCandidates(f.context);
        clearSyntheticCandidates(other.context);
    }
});

test("synthetic admission bounds session and id retention", async () => {
    const f = fixture();
    try {
        for (let i = 0; i < 50_001; i++) await isAdmittedSynthetic(f.context, "s", `id${i}`);
        const before = f.reads();
        await isAdmittedSynthetic(f.context, "s", "id50000");
        expect(f.reads()).toBe(before);
        await isAdmittedSynthetic(f.context, "s", "id0");
        expect(f.reads()).toBe(before + 1);
        for (let i = 0; i < 64; i++) await isAdmittedSynthetic(f.context, `s${i}`, "id");
        const sessions = f.reads();
        await isAdmittedSynthetic(f.context, "s63", "id");
        expect(f.reads()).toBe(sessions);
        await isAdmittedSynthetic(f.context, "s", "id0");
        expect(f.reads()).toBe(sessions + 1);
        // More concurrent reads than retained sessions must finish without retry churn.
        expect(
            await Promise.all(
                Array.from({ length: 70 }, (_, i) =>
                    isAdmittedSynthetic(f.context, `parallel${i}`, "id"),
                ),
            ),
        ).toEqual(Array(70).fill(false));
    } finally {
        clearSyntheticCandidates(f.context);
    }
});

test("synthetic admission does not remember failed reads or stale in-flight reads", async () => {
    const f = fixture();
    const read = f.context.storage.get;
    let fail = true;
    let block = false;
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.context.storage.get = async (key) => {
        if (fail) {
            fail = false;
            throw new Error("unavailable");
        }
        const result = await read(key);
        if (block) {
            block = false;
            started.resolve();
            await release.promise;
        }
        return result;
    };
    try {
        await expect(isAdmittedSynthetic(f.context, "s", "id")).rejects.toThrow("unavailable");
        expect(await isAdmittedSynthetic(f.context, "s", "id")).toBe(false);
        clearSyntheticCandidates(f.context);
        block = true;
        const pending = isAdmittedSynthetic(f.context, "s", "id");
        await started.promise;
        await f.context.storage.set("synthetic/s/id", { id: "id" });
        release.resolve();
        expect(await pending).toBe(true);
        expect(await isAdmittedSynthetic(f.context, "s", "id")).toBe(true);
    } finally {
        release.resolve();
        clearSyntheticCandidates(f.context);
    }
});
