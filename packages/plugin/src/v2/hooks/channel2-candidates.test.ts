import { expect, test } from "bun:test";
import {
    clearSyntheticCandidates,
    deliverSynthetic,
    isAdmittedSynthetic,
    observeSyntheticAdmissionEvent,
    syntheticCandidates,
} from "./channel2";

test("synthetic candidates bridge a delayed SQL projection without bypassing admission", async () => {
    const records = new Map<string, unknown>();
    let sentID = "";
    const context = {
        storage: {
            get: async (key: string) => records.get(key),
            set: async (key: string, value: unknown) => {
                records.set(key, value);
            },
        },
        session: {
            synthetic: async ({ id }: { id: string }) => {
                sentID = id;
                expect(syntheticCandidates(context, "s", new Set())).toEqual(new Set([id]));
                expect(await isAdmittedSynthetic(context, "s", id)).toBe(true);
            },
        },
    };
    try {
        const id = await deliverSynthetic(context, "s", "reminder");
        expect(id).toBe(sentID);
        expect(syntheticCandidates(context, "other", new Set())).toEqual(new Set());
        expect(syntheticCandidates(context, "s", new Set())).toEqual(new Set([id]));
        observeSyntheticAdmissionEvent(context, {
            type: "session.revert.committed",
            data: { sessionID: "s" },
        });
        expect(syntheticCandidates(context, "s", new Set())).toEqual(new Set([id]));
        expect(await isAdmittedSynthetic(context, "s", id)).toBe(true);
        const stored = new Set([id, "host-synthetic"]);
        expect(syntheticCandidates(context, "s", stored)).toEqual(stored);
        // A native synthetic from another plugin is only a candidate, not admitted.
        expect(await isAdmittedSynthetic(context, "s", "host-synthetic")).toBe(false);
        await context.storage.set(`synthetic/s/${id}`, { id: "wrong" });
        expect(await isAdmittedSynthetic(context, "s", id)).toBe(false);
        // Once SQL has observed a send, it no longer needs the pending bridge.
        expect(syntheticCandidates(context, "s", new Set())).toEqual(new Set());
    } finally {
        clearSyntheticCandidates(context);
    }
});
