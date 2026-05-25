/// <reference types="bun-types" />

/**
 * v3.3.1 Layer C — plan §5 / Finding D: drop-queue composite-identity
 * tests.
 *
 * The bug class this guards: pre-fix `queueDropsForCompartmentalizedMessages`
 * matched tool tags by bare `messageId === callId`. A callId reused
 * outside the compartment range matched a tag inside the compartment
 * by string equality alone, queuing drops on tags that should have
 * stayed live. Layer C filters by `(callId, tool_owner_message_id)`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    closeDatabase,
    getPendingOps,
    insertTag,
    openDatabase,
    updateTagStatus,
} from "../../features/magic-context/storage";
import { queueDropsForCompartmentalizedMessages } from "./compartment-runner-drop-queue";
import { withRawMessageProvider } from "./read-session-chunk";
import type { RawMessage } from "./read-session-raw";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

beforeEach(() => {
    closeDatabase();
});

afterEach(() => {
    closeDatabase();
    process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            // Ignore EBUSY on Windows
        }
    }
    tempDirs.length = 0;
});

function useTempDataHome(prefix: string): void {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

function makeRawMessages(messages: RawMessage[]) {
    return {
        readMessages: () => messages,
    };
}

describe("queueDropsForCompartmentalizedMessages composite identity", () => {
    it("does NOT queue a drop for a callId reused outside the compartment", () => {
        //#given — `read:32` is invoked twice: at message 5 (in
        // compartment), again at message 10 (outside compartment).
        // Both have distinct owner ids. Pre-fix this would queue both
        // tags for drop. Post-fix only tag-100 (owner m-asst-5) gets
        // queued.
        useTempDataHome("drop-queue-collision-");
        const db = openDatabase();

        const messages: RawMessage[] = [
            { id: "m-user-1", role: "user", ordinal: 1, parts: [] },
            {
                id: "m-asst-5",
                role: "assistant",
                time_created: 5,
                ordinal: 5,
                parts: [{ type: "tool-invocation", callID: "read:32" }],
            },
            {
                id: "m-tool-6",
                role: "tool",
                time_created: 6,
                ordinal: 6,
                parts: [{ type: "tool", callID: "read:32", state: { output: "first" } }],
            },
            {
                id: "m-user-7",
                role: "user",
                time_created: 7,
                ordinal: 7,
                parts: [{ type: "text", text: "ask again" }],
            },
            {
                id: "m-asst-10",
                role: "assistant",
                time_created: 10,
                ordinal: 10,
                parts: [{ type: "tool-invocation", callID: "read:32" }],
            },
            {
                id: "m-tool-11",
                role: "tool",
                time_created: 11,
                ordinal: 11,
                parts: [{ type: "tool", callID: "read:32", state: { output: "second" } }],
            },
        ];

        // Two persisted tags for the same callId, different owners.
        insertTag(db, "ses-1", "read:32", "tool", 100, 100, 0, "read", 50, "m-asst-5");
        insertTag(db, "ses-1", "read:32", "tool", 200, 250, 0, "read", 50, "m-asst-10");

        //#when — compartment covers messages 1-7 (so m-asst-5 is in,
        // m-asst-10 is out).
        withRawMessageProvider("ses-1", makeRawMessages(messages), () => {
            queueDropsForCompartmentalizedMessages(db, "ses-1", 7);
        });

        //#then — only tag 100 (in-compartment) is queued.
        const ops = getPendingOps(db, "ses-1");
        expect(ops).toHaveLength(1);
        expect(ops[0]?.tagId).toBe(100);
    });

    it("queues both tags when both owners are inside the compartment", () => {
        //#given — same callId across two assistant turns, both inside
        // the compartment range.
        useTempDataHome("drop-queue-both-in-");
        const db = openDatabase();

        const messages: RawMessage[] = [
            {
                id: "m-asst-3",
                role: "assistant",
                time_created: 3,
                ordinal: 3,
                parts: [{ type: "tool-invocation", callID: "grep:1" }],
            },
            {
                id: "m-tool-4",
                role: "tool",
                time_created: 4,
                ordinal: 4,
                parts: [{ type: "tool", callID: "grep:1", state: { output: "result-1" } }],
            },
            {
                id: "m-asst-5",
                role: "assistant",
                time_created: 5,
                ordinal: 5,
                parts: [{ type: "tool-invocation", callID: "grep:1" }],
            },
            {
                id: "m-tool-6",
                role: "tool",
                time_created: 6,
                ordinal: 6,
                parts: [{ type: "tool", callID: "grep:1", state: { output: "result-2" } }],
            },
        ];

        insertTag(db, "ses-1", "grep:1", "tool", 100, 50, 0, "grep", 20, "m-asst-3");
        insertTag(db, "ses-1", "grep:1", "tool", 200, 60, 0, "grep", 20, "m-asst-5");

        //#when
        withRawMessageProvider("ses-1", makeRawMessages(messages), () => {
            queueDropsForCompartmentalizedMessages(db, "ses-1", 6);
        });

        //#then
        const ops = getPendingOps(db, "ses-1");
        const queuedTagIds = ops.map((op) => op.tagId).sort();
        expect(queuedTagIds).toEqual([50, 60]);
    });

    it("legacy NULL-owner row falls back to bare-callId match", () => {
        //#given — a NULL-owner tool tag (pre-Layer-B-backfill data).
        // The drop queue must still fire for this tag; lazy adoption
        // will populate the owner on the next tag-messages pass.
        useTempDataHome("drop-queue-null-owner-");
        const db = openDatabase();

        const messages: RawMessage[] = [
            {
                id: "m-asst",
                role: "assistant",
                time_created: 1,
                ordinal: 1,
                parts: [{ type: "tool-invocation", callID: "legacy:1" }],
            },
            {
                id: "m-tool",
                role: "tool",
                time_created: 2,
                ordinal: 2,
                parts: [{ type: "tool", callID: "legacy:1", state: { output: "ok" } }],
            },
        ];

        // NULL owner (pre-v10 row).
        insertTag(db, "ses-1", "legacy:1", "tool", 100, 7, 0, null, 0, null);

        //#when
        withRawMessageProvider("ses-1", makeRawMessages(messages), () => {
            queueDropsForCompartmentalizedMessages(db, "ses-1", 2);
        });

        //#then
        const ops = getPendingOps(db, "ses-1");
        expect(ops).toHaveLength(1);
        expect(ops[0]?.tagId).toBe(7);
    });

    it("skips already-dropped tags", () => {
        //#given
        useTempDataHome("drop-queue-already-dropped-");
        const db = openDatabase();

        const messages: RawMessage[] = [
            {
                id: "m-asst",
                role: "assistant",
                time_created: 1,
                ordinal: 1,
                parts: [{ type: "tool-invocation", callID: "x:1" }],
            },
            {
                id: "m-tool",
                role: "tool",
                time_created: 2,
                ordinal: 2,
                parts: [{ type: "tool", callID: "x:1", state: { output: "ok" } }],
            },
        ];

        insertTag(db, "ses-1", "x:1", "tool", 100, 1, 0, "x", 0, "m-asst");
        updateTagStatus(db, "ses-1", 1, "dropped");

        //#when
        withRawMessageProvider("ses-1", makeRawMessages(messages), () => {
            queueDropsForCompartmentalizedMessages(db, "ses-1", 2);
        });

        //#then — no drops queued.
        expect(getPendingOps(db, "ses-1")).toHaveLength(0);
    });
});
