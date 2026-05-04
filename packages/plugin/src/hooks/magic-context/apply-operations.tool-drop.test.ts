/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    closeDatabase,
    getPendingOps,
    getTagById,
    insertTag,
    openDatabase,
    queuePendingOp,
    updateTagDropMode,
    updateTagStatus,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import {
    applyFlushedStatuses,
    applyPendingOperations,
    type MessageLike,
    tagMessages,
} from "./transform-operations";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    closeDatabase();
    process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
});

function useTempDataHome(prefix: string): void {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

function hasCall(messages: MessageLike[], callId: string): boolean {
    for (const message of messages) {
        for (const part of message.parts) {
            if (part === null || typeof part !== "object") continue;
            const candidate = part as Record<string, unknown>;
            if (
                (candidate.type === "tool" || candidate.type === "tool-invocation") &&
                candidate.callID === callId
            ) {
                return true;
            }
            if (candidate.type === "tool_use" && candidate.id === callId) {
                return true;
            }
            if (candidate.type === "tool_result" && candidate.tool_use_id === callId) {
                return true;
            }
        }
    }

    return false;
}

describe("apply operations for tool drops", () => {
    it("drops complete tool call slices and clears pending op", () => {
        useTempDataHome("context-tool-drop-complete-");
        const db = openDatabase();
        const tagger = createTagger();
        const messages: MessageLike[] = [
            {
                info: { id: "m-assistant", role: "assistant", sessionID: "ses-1" },
                parts: [{ type: "tool-invocation", callID: "call-1" }],
            },
            {
                info: { id: "m-tool", role: "tool", sessionID: "ses-1" },
                parts: [{ type: "tool", callID: "call-1", state: { output: "result" } }],
            },
        ];

        const { targets, batch } = tagMessages("ses-1", messages, tagger, db);
        const toolTagId = tagger.getTag("ses-1", "call-1");
        expect(toolTagId).toBeDefined();

        queuePendingOp(db, "ses-1", toolTagId!, "drop");
        const didMutate = applyPendingOperations("ses-1", db, targets);
        batch.finalize();

        expect(didMutate).toBe(true);
        expect(hasCall(messages, "call-1")).toBe(false);
        expect(getPendingOps(db, "ses-1")).toHaveLength(0);
        expect(getTagById(db, "ses-1", toolTagId!)?.status).toBe("dropped");
        expect(getTagById(db, "ses-1", toolTagId!)?.dropMode).toBe("full");
    });

    it("defers pending drop when only invocation exists", () => {
        useTempDataHome("context-tool-drop-incomplete-");
        const db = openDatabase();
        insertTag(db, "ses-1", "call-orphan", "tool", 123, 7);

        const tagger = createTagger();
        tagger.initFromDb("ses-1", db);

        const messages: MessageLike[] = [
            {
                info: { id: "m-assistant", role: "assistant", sessionID: "ses-1" },
                parts: [{ type: "tool-invocation", callID: "call-orphan" }],
            },
        ];

        const { targets } = tagMessages("ses-1", messages, tagger, db);
        queuePendingOp(db, "ses-1", 7, "drop");

        const didMutate = applyPendingOperations("ses-1", db, targets);

        expect(didMutate).toBe(false);
        expect(hasCall(messages, "call-orphan")).toBe(true);
        expect(getPendingOps(db, "ses-1")).toHaveLength(1);
        expect(getTagById(db, "ses-1", 7)?.status).toBe("active");
    });

    it("keeps protected pending drops queued until they age out", () => {
        useTempDataHome("context-protected-pending-drop-");
        const db = openDatabase();
        const tagger = createTagger();
        const messages: MessageLike[] = [
            {
                info: { id: "m-1", role: "assistant", sessionID: "ses-1" },
                parts: [{ type: "text", text: "one" }],
            },
            {
                info: { id: "m-2", role: "assistant", sessionID: "ses-1" },
                parts: [{ type: "text", text: "two" }],
            },
            {
                info: { id: "m-3", role: "assistant", sessionID: "ses-1" },
                parts: [{ type: "text", text: "three" }],
            },
            {
                info: { id: "m-4", role: "assistant", sessionID: "ses-1" },
                parts: [{ type: "text", text: "four" }],
            },
            {
                info: { id: "m-5", role: "assistant", sessionID: "ses-1" },
                parts: [{ type: "text", text: "five" }],
            },
        ];

        const { targets } = tagMessages("ses-1", messages, tagger, db);
        const messageTagId = tagger.getTag("ses-1", "m-5:p0");
        expect(messageTagId).toBeDefined();

        queuePendingOp(db, "ses-1", messageTagId!, "drop");
        const didMutate = applyPendingOperations("ses-1", db, targets, 2);

        expect(didMutate).toBe(false);
        expect(getPendingOps(db, "ses-1")).toHaveLength(1);
        expect(getTagById(db, "ses-1", messageTagId!)?.status).toBe("active");
        expect(messages[4]?.parts).toEqual([{ type: "text", text: "§5§ five" }]);
    });

    it("applies deferred pending drops once they leave the protected range", () => {
        useTempDataHome("context-aged-pending-drop-");
        const db = openDatabase();
        const tagger = createTagger();
        const messages: MessageLike[] = [
            {
                info: { id: "m-1", role: "assistant", sessionID: "ses-1" },
                parts: [{ type: "text", text: "one" }],
            },
            {
                info: { id: "m-2", role: "assistant", sessionID: "ses-1" },
                parts: [{ type: "text", text: "two" }],
            },
            {
                info: { id: "m-3", role: "assistant", sessionID: "ses-1" },
                parts: [{ type: "text", text: "three" }],
            },
            {
                info: { id: "m-4", role: "assistant", sessionID: "ses-1" },
                parts: [{ type: "text", text: "four" }],
            },
            {
                info: { id: "m-5", role: "assistant", sessionID: "ses-1" },
                parts: [{ type: "text", text: "five" }],
            },
            {
                info: { id: "m-6", role: "assistant", sessionID: "ses-1" },
                parts: [{ type: "text", text: "six" }],
            },
            {
                info: { id: "m-7", role: "assistant", sessionID: "ses-1" },
                parts: [{ type: "text", text: "seven" }],
            },
        ];

        const { targets } = tagMessages("ses-1", messages, tagger, db);
        const messageTagId = tagger.getTag("ses-1", "m-3:p0");
        expect(messageTagId).toBeDefined();

        queuePendingOp(db, "ses-1", messageTagId!, "drop");
        const didMutate = applyPendingOperations("ses-1", db, targets, 2);

        expect(didMutate).toBe(true);
        expect(getPendingOps(db, "ses-1")).toHaveLength(0);
        expect(getTagById(db, "ses-1", messageTagId!)?.status).toBe("dropped");
        expect(messages[2]?.parts).toEqual([{ type: "text", text: "[dropped §3§]" }]);
    });

    it("treats missing tool call as absent and finalizes pending drop", () => {
        useTempDataHome("context-tool-drop-absent-");
        const db = openDatabase();
        insertTag(db, "ses-1", "call-missing", "tool", 100, 8);

        const tagger = createTagger();
        tagger.initFromDb("ses-1", db);

        const messages: MessageLike[] = [];
        const { targets } = tagMessages("ses-1", messages, tagger, db);
        queuePendingOp(db, "ses-1", 8, "drop");

        const didMutate = applyPendingOperations("ses-1", db, targets);

        expect(didMutate).toBe(false);
        expect(getPendingOps(db, "ses-1")).toHaveLength(0);
        expect(getTagById(db, "ses-1", 8)?.status).toBe("dropped");
    });

    it("applies flushed dropped status to tool call slices", () => {
        useTempDataHome("context-tool-drop-flushed-");
        const db = openDatabase();
        const tagger = createTagger();
        const messages: MessageLike[] = [
            {
                info: { id: "m-assistant", role: "assistant", sessionID: "ses-1" },
                parts: [{ type: "tool-invocation", callID: "call-2" }],
            },
            {
                info: { id: "m-tool", role: "tool", sessionID: "ses-1" },
                parts: [{ type: "tool", callID: "call-2", state: { output: "result" } }],
            },
        ];

        const { targets, batch } = tagMessages("ses-1", messages, tagger, db);
        const toolTagId = tagger.getTag("ses-1", "call-2");
        expect(toolTagId).toBeDefined();

        updateTagStatus(db, "ses-1", toolTagId!, "dropped");

        updateTagDropMode(db, "ses-1", toolTagId!, "truncated");

        const didMutate = applyFlushedStatuses("ses-1", db, targets);
        batch.finalize();

        expect(didMutate).toBe(true);
        expect(hasCall(messages, "call-2")).toBe(true);
        const toolPart = messages
            .flatMap((m) => m.parts)
            .find((p: any) => p.callID === "call-2" && p.type === "tool") as any;
        expect(toolPart.state.output).toBe("[truncated]");
    });

    it("fully removes tool parts when drop mode is full", () => {
        useTempDataHome("context-tool-drop-flushed-full-");
        const db = openDatabase();
        const tagger = createTagger();
        const messages: MessageLike[] = [
            {
                info: { id: "m-user", role: "user", sessionID: "ses-1" },
                parts: [{ type: "text", text: "hello" }],
            },
            {
                info: { id: "m-tool", role: "assistant", sessionID: "ses-1" },
                parts: [
                    {
                        type: "tool-invocation",
                        callID: "call-3",
                        tool: "read",
                        args: { filePath: "test.ts" },
                    },
                    {
                        type: "tool",
                        callID: "call-3",
                        tool: "read",
                        state: { input: { filePath: "test.ts" }, output: "file content here" },
                    },
                ],
            },
        ];

        const { targets, batch } = tagMessages("ses-1", messages, tagger, db);
        const toolTagId = tagger.getTag("ses-1", "call-3");
        expect(toolTagId).toBeDefined();

        updateTagStatus(db, "ses-1", toolTagId!, "dropped");
        updateTagDropMode(db, "ses-1", toolTagId!, "full");
        const didMutate = applyFlushedStatuses("ses-1", db, targets);
        batch.finalize();

        expect(didMutate).toBe(true);
        expect(hasCall(messages, "call-3")).toBe(false);
    });

    it("preserves step markers when dropping a tool from a mixed assistant message", () => {
        useTempDataHome("context-tool-drop-step-markers-");
        const db = openDatabase();
        const tagger = createTagger();
        const messages: MessageLike[] = [
            {
                info: { id: "m-user", role: "user", sessionID: "ses-1" },
                parts: [{ type: "text", text: "request" }],
            },
            {
                info: { id: "m-assistant", role: "assistant", sessionID: "ses-1" },
                parts: [
                    { type: "step-start", snapshot: "snap-1" },
                    { type: "text", text: "keep this explanation" },
                    { type: "tool", callID: "call-3", state: { output: "result" } },
                    { type: "step-finish", reason: "tool-calls" },
                ],
            },
        ];

        const { targets, batch } = tagMessages("ses-1", messages, tagger, db);
        const toolTagId = tagger.getTag("ses-1", "call-3");
        expect(toolTagId).toBeDefined();

        queuePendingOp(db, "ses-1", toolTagId!, "drop");
        const didMutate = applyPendingOperations("ses-1", db, targets);
        batch.finalize();

        expect(didMutate).toBe(true);
        expect(hasCall(messages, "call-3")).toBe(false);
        expect(messages).toHaveLength(2);
        expect(messages[1]?.parts.map((part) => (part as { type?: string }).type)).toEqual([
            "step-start",
            "text",
            "step-finish",
        ]);
    });

    it("prunes tool-only step wrapper messages after dropping the tool", () => {
        useTempDataHome("context-tool-drop-empty-step-wrapper-");
        const db = openDatabase();
        const tagger = createTagger();
        const messages: MessageLike[] = [
            {
                info: { id: "m-user", role: "user", sessionID: "ses-1" },
                parts: [{ type: "text", text: "request" }],
            },
            {
                info: { id: "m-assistant", role: "assistant", sessionID: "ses-1" },
                parts: [
                    { type: "step-start", snapshot: "snap-1" },
                    { type: "tool", callID: "call-4", state: { output: "result" } },
                    { type: "step-finish", reason: "tool-calls" },
                ],
            },
        ];

        const { targets, batch } = tagMessages("ses-1", messages, tagger, db);
        const toolTagId = tagger.getTag("ses-1", "call-4");
        expect(toolTagId).toBeDefined();

        queuePendingOp(db, "ses-1", toolTagId!, "drop");
        const didMutate = applyPendingOperations("ses-1", db, targets);
        batch.finalize();

        expect(didMutate).toBe(true);
        expect(hasCall(messages, "call-4")).toBe(false);
        expect(messages).toHaveLength(1);
        expect(messages[0]?.info.id).toBe("m-user");
    });

    it("clears stale drop ops for compacted tags", () => {
        useTempDataHome("context-drop-compacted-");
        const db = openDatabase();
        const tagger = createTagger();
        const messages: MessageLike[] = [
            {
                info: { id: "m-user", role: "user", sessionID: "ses-1" },
                parts: [{ type: "text", text: "request" }],
            },
            {
                info: { id: "m-assistant", role: "assistant", sessionID: "ses-1" },
                parts: [{ type: "text", text: "reduce me later" }],
            },
        ];

        const { targets, batch } = tagMessages("ses-1", messages, tagger, db);
        const messageTagId = tagger.getTag("ses-1", "m-assistant:p0");
        expect(messageTagId).toBeDefined();

        queuePendingOp(db, "ses-1", messageTagId!, "drop");
        updateTagStatus(db, "ses-1", messageTagId!, "compacted");

        const didMutate = applyPendingOperations("ses-1", db, targets);
        batch.finalize();

        expect(didMutate).toBe(false);
        expect(getPendingOps(db, "ses-1")).toHaveLength(0);
        expect(getTagById(db, "ses-1", messageTagId!)?.status).toBe("compacted");
        expect(messages[1]?.parts).toEqual([{ type: "text", text: "§2§ reduce me later" }]);
    });

    describe("role-aware message drops (user message protection)", () => {
        it("truncates user message content instead of full drop when tag is queued", () => {
            useTempDataHome("context-user-msg-truncate-pending-");
            const db = openDatabase();
            const tagger = createTagger();
            const longPaste = `Here is the log I was debugging:\n${"ERROR: something failed at line 42. ".repeat(50)}`;
            const messages: MessageLike[] = [
                {
                    info: { id: "m-user", role: "user", sessionID: "ses-1" },
                    parts: [{ type: "text", text: longPaste }],
                },
                {
                    info: { id: "m-assistant", role: "assistant", sessionID: "ses-1" },
                    parts: [{ type: "text", text: "ok" }],
                },
            ];

            const { targets } = tagMessages("ses-1", messages, tagger, db);
            const userMsgTagId = tagger.getTag("ses-1", "m-user:p0");
            expect(userMsgTagId).toBeDefined();

            queuePendingOp(db, "ses-1", userMsgTagId!, "drop");
            const didMutate = applyPendingOperations("ses-1", db, targets);

            expect(didMutate).toBe(true);
            expect(getTagById(db, "ses-1", userMsgTagId!)?.status).toBe("dropped");

            const text = (messages[0]?.parts[0] as { text: string }).text;
            // Must start with the truncated marker, not the dropped marker.
            expect(text.startsWith(`[truncated §${userMsgTagId}§]`)).toBe(true);
            expect(text.includes("[dropped")).toBe(false);
            // Must preserve the START of the user's original text (intent).
            expect(text.includes("Here is the log I was debugging")).toBe(true);
            // Must NOT contain the full original repeated content (50 copies) — it was truncated.
            const matchCount = (text.match(/ERROR: something failed/g) ?? []).length;
            expect(matchCount).toBeLessThan(20);
            // Truncation window is ~250 chars; length must be bounded.
            expect(text.length).toBeLessThan(400);
        });

        it("preserves user message shell when flushed dropped status is re-applied", () => {
            useTempDataHome("context-user-msg-truncate-flush-");
            const db = openDatabase();
            const tagger = createTagger();
            const messages: MessageLike[] = [
                {
                    info: { id: "m-user", role: "user", sessionID: "ses-1" },
                    parts: [
                        {
                            type: "text",
                            text: "Please fix the bug I mentioned in the last ticket. See attached log for details.",
                        },
                    ],
                },
                {
                    info: { id: "m-assistant", role: "assistant", sessionID: "ses-1" },
                    parts: [{ type: "text", text: "ok" }],
                },
            ];

            const { targets } = tagMessages("ses-1", messages, tagger, db);
            const userMsgTagId = tagger.getTag("ses-1", "m-user:p0");
            expect(userMsgTagId).toBeDefined();

            updateTagStatus(db, "ses-1", userMsgTagId!, "dropped");
            const didMutate = applyFlushedStatuses("ses-1", db, targets);

            expect(didMutate).toBe(true);
            const text = (messages[0]?.parts[0] as { text: string }).text;
            expect(text.startsWith(`[truncated §${userMsgTagId}§]`)).toBe(true);
            // Short text should be preserved as-is (under preview window).
            expect(text.includes("Please fix the bug I mentioned")).toBe(true);
        });

        it("keeps using [dropped §N§] full drop for assistant messages (no regression)", () => {
            useTempDataHome("context-assistant-msg-drop-unchanged-");
            const db = openDatabase();
            const tagger = createTagger();
            const messages: MessageLike[] = [
                {
                    info: { id: "m-user", role: "user", sessionID: "ses-1" },
                    parts: [{ type: "text", text: "hi" }],
                },
                {
                    info: { id: "m-assistant", role: "assistant", sessionID: "ses-1" },
                    parts: [{ type: "text", text: "response body" }],
                },
            ];

            const { targets } = tagMessages("ses-1", messages, tagger, db);
            const asstMsgTagId = tagger.getTag("ses-1", "m-assistant:p0");
            expect(asstMsgTagId).toBeDefined();

            queuePendingOp(db, "ses-1", asstMsgTagId!, "drop");
            const didMutate = applyPendingOperations("ses-1", db, targets);

            expect(didMutate).toBe(true);
            expect(messages[1]?.parts).toEqual([
                { type: "text", text: `[dropped §${asstMsgTagId}§]` },
            ]);
        });

        it("short user text survives as truncated preview without ellipsis", () => {
            useTempDataHome("context-user-msg-short-");
            const db = openDatabase();
            const tagger = createTagger();
            const shortText = "rebuild the project";
            const messages: MessageLike[] = [
                {
                    info: { id: "m-user", role: "user", sessionID: "ses-1" },
                    parts: [{ type: "text", text: shortText }],
                },
                {
                    info: { id: "m-assistant", role: "assistant", sessionID: "ses-1" },
                    parts: [{ type: "text", text: "ok" }],
                },
            ];

            const { targets } = tagMessages("ses-1", messages, tagger, db);
            const userMsgTagId = tagger.getTag("ses-1", "m-user:p0");
            queuePendingOp(db, "ses-1", userMsgTagId!, "drop");
            applyPendingOperations("ses-1", db, targets);

            const text = (messages[0]?.parts[0] as { text: string }).text;
            expect(text).toBe(`[truncated §${userMsgTagId}§]\n${shortText}`);
            // No ellipsis for content that already fits under the preview window.
            expect(text.includes("\u2026")).toBe(false);
        });
    });
});
