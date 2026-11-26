/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { restoreRow } from "../fold/restore";
import type { StoreRow } from "../store-reader";
import {
    dropStorageNotices,
    formatStorageRecoveryNotice,
    formatStorageRefusalNotice,
    STORAGE_NOTICE_PREFIX,
} from "./storage-notice";
import { hostServesRowById } from "./store";
import type { V2Message } from "./types";

const refusal = formatStorageRefusalNotice({
    kind: "migration_guard",
    persistedVersion: 90,
    supportedVersion: 91,
    blockingProcesses: [{ kind: "OpenCode server", pid: 4242 }],
});
const recovery = formatStorageRecoveryNotice(true);

function user(id: string, text: string): V2Message {
    return { id, role: "user", content: [{ type: "text", text }] };
}
function assistant(id: string, text: string): V2Message {
    return { id, role: "assistant", content: [{ type: "text", text }] };
}

/** A transcript as the host renders it: stored notices between ordinary turns. */
function transcriptWithNotices(): V2Message[] {
    return [
        user("msg_u1", "first question"),
        user("msg_n1", refusal),
        user("msg_u2", "second question"),
        assistant("msg_a2", "second answer"),
        user("msg_n2", recovery),
        user("msg_u3", "third question"),
    ];
}

const admitted = new Set(["msg_n1", "msg_n2"]);
const isAdmitted = async (id: string) => admitted.has(id);

describe("storage notices", () => {
    it("start with the fixed prefix", () => {
        expect(refusal.startsWith(STORAGE_NOTICE_PREFIX)).toBe(true);
        expect(refusal).toContain("OpenCode server (PID 4242)");
        expect(recovery.startsWith(STORAGE_NOTICE_PREFIX)).toBe(true);
        expect(recovery).toContain("Restart OpenCode to enable Magic Context's tools.");
        expect(formatStorageRecoveryNotice(false)).toContain(
            "Restart OpenCode to enable Magic Context's tools, historian and dreamer.",
        );
    });

    it("are dropped from a request draft so it matches one that never had them", async () => {
        const withNotices = transcriptWithNotices();
        const removed = await dropStorageNotices(withNotices, isAdmitted);

        expect(removed).toBe(2);
        const never = transcriptWithNotices().filter(
            (message) => message.id !== "msg_n1" && message.id !== "msg_n2",
        );
        expect(JSON.stringify(withNotices)).toBe(JSON.stringify(never));
    });

    it("give identical request bytes on a priced pass and the defer pass after it", async () => {
        // The host hands the context hook a fresh draft on each pass. Both passes
        // carry the same stored notices; the defer pass only appends its new turn.
        const priced = transcriptWithNotices();
        const deferred = [
            ...transcriptWithNotices(),
            assistant("msg_a3", "third answer"),
            user("msg_u4", "fourth question"),
        ];
        await dropStorageNotices(priced, isAdmitted);
        await dropStorageNotices(deferred, isAdmitted);

        expect(JSON.stringify(deferred.slice(0, priced.length))).toBe(JSON.stringify(priced));
        expect(JSON.stringify([...priced, ...deferred])).not.toContain(STORAGE_NOTICE_PREFIX);
    });

    it("keep a user's own message with the same text, which Magic Context never sent", async () => {
        const messages = [user("msg_typed", refusal)];
        expect(await dropStorageNotices(messages, isAdmitted)).toBe(0);
        expect(messages).toHaveLength(1);
    });

    it("keep a synthetic Magic Context message that is not a storage notice", async () => {
        const messages = [user("msg_n1", "Channel 2 reminder")];
        expect(await dropStorageNotices(messages, isAdmitted)).toBe(0);
    });
});

describe("stored storage notice rows", () => {
    const row = (type: string, text: string): StoreRow =>
        ({
            id: `msg_${type}`,
            session_id: "ses_notice",
            type,
            seq: 1,
            time_created: 1,
            data: { text, time: { created: 1 } },
        }) as unknown as StoreRow;

    it("are never restored into a request, and count as rows the request does not carry", () => {
        const notice = row("synthetic", refusal);
        expect(restoreRow(notice, { providerID: "p", id: "m" })).toEqual([]);
        expect(hostServesRowById(notice)).toBe(false);
    });

    it("leave other synthetic rows and user rows with the same text restorable", () => {
        const other = row("synthetic", "Context full — /ctx-flush or /clear to continue.");
        expect(restoreRow(other, { providerID: "p", id: "m" })).toHaveLength(1);
        const typed = row("user", refusal);
        expect(restoreRow(typed, { providerID: "p", id: "m" })).toHaveLength(1);
    });
});
