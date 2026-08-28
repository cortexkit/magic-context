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
const originalTestDataDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;

afterEach(() => {
    closeDatabase();
    process.env.XDG_DATA_HOME = originalXdgDataHome;
    if (originalTestDataDir === undefined) delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
    else process.env.MAGIC_CONTEXT_TEST_DATA_DIR = originalTestDataDir;
    for (const dir of tempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* Ignore EBUSY on Windows */
        }
    }
    tempDirs.length = 0;
});

function useTempDataHome(prefix: string): void {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    process.env.MAGIC_CONTEXT_TEST_DATA_DIR = dir;
}

/**
 * Insert 20 newer tool tags so `realTagNumber` falls OUTSIDE the newest-20
 * skeleton window and a queued drop takes the full-removal path.
 */
function padSkeletonWindow(
    db: ReturnType<typeof openDatabase> & object,
    realTagNumber: number,
): void {
    for (let i = 1; i <= 20; i += 1) {
        insertTag(db, "ses-1", `call-pad-${i}`, "tool", 10, realTagNumber + i);
    }
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
        const toolTagId = tagger.getToolTag("ses-1", "call-1", "m-assistant");
        expect(toolTagId).toBeDefined();
        // Push the real tag out of the newest-20 skeleton window so this test
        // exercises the FULL-removal path (deep-history drop).
        padSkeletonWindow(db, toolTagId!);

        queuePendingOp(db, "ses-1", toolTagId!, "drop");
        const didMutate = applyPendingOperations("ses-1", db, targets);
        batch.finalize();

        expect(didMutate).toBe(true);
        expect(hasCall(messages, "call-1")).toBe(false);
        expect(getPendingOps(db, "ses-1")).toHaveLength(0);
        expect(getTagById(db, "ses-1", toolTagId!)?.status).toBe("dropped");
        expect(getTagById(db, "ses-1", toolTagId!)?.dropMode).toBe("full");
    });

    it("keeps a skeleton (canonical [dropped §N§] output) for drops within the recent tool window", () => {
        useTempDataHome("context-tool-drop-skeleton-");
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
        const toolTagId = tagger.getToolTag("ses-1", "call-1", "m-assistant");
        expect(toolTagId).toBeDefined();

        // No padding: the tool is within the newest-20 window, so the agent
        // drop keeps the structural skeleton (anti-hallucination anchor).
        queuePendingOp(db, "ses-1", toolTagId!, "drop");
        const didMutate = applyPendingOperations("ses-1", db, targets);
        batch.finalize();

        expect(didMutate).toBe(true);
        expect(hasCall(messages, "call-1")).toBe(true);
        const toolPart = messages
            .flatMap((m) => m.parts)
            .find((p: any) => p.callID === "call-1" && p.type === "tool") as any;
        expect(toolPart.state.output).toBe(`[dropped \u00a7${toolTagId}\u00a7]`);
        expect(getPendingOps(db, "ses-1")).toHaveLength(0);
        expect(getTagById(db, "ses-1", toolTagId!)?.status).toBe("dropped");
        expect(getTagById(db, "ses-1", toolTagId!)?.dropMode).toBe("truncated");
    });

    it("defers a pending/running task part and keeps its long prompt byte-identical (#250 open arc)", () => {
        useTempDataHome("context-tool-drop-pending-task-");
        const db = openDatabase();
        // Pre-seed a tool tag for the task call so the still-running part binds
        // into a drop target (mirrors a tag adopted from an earlier pass). The
        // part itself has NO result output yet — the child is still spawning.
        insertTag(db, "ses-1", "call-task", "tool", 123, 7);
        const tagger = createTagger();
        tagger.initFromDb("ses-1", db);

        const longPrompt = `Fix the auth bug and add coverage. ${"x".repeat(600)}`;
        const taskPart = {
            type: "tool",
            tool: "task",
            callID: "call-task",
            state: {
                status: "running",
                input: { prompt: longPrompt, subagent_type: "mason" },
            },
        };
        const pristine = JSON.stringify(taskPart);
        const messages: MessageLike[] = [
            {
                info: { id: "m-task", role: "assistant", sessionID: "ses-1" },
                parts: [taskPart],
            },
        ];

        const { targets } = tagMessages("ses-1", messages, tagger, db);
        queuePendingOp(db, "ses-1", 7, "drop");
        const didMutate = applyPendingOperations("ses-1", db, targets);

        // Open arc: the drop is deferred (not applied), the pending op stays
        // queued, the tag stays active, and the LIVE task part is byte-identical
        // — the child agent's prompt is never clamped mid-spawn.
        expect(didMutate).toBe(false);
        expect(JSON.stringify(taskPart)).toBe(pristine);
        expect(taskPart.state.input.prompt).toBe(longPrompt);
        expect(getPendingOps(db, "ses-1")).toHaveLength(1);
        expect(getTagById(db, "ses-1", 7)?.status).toBe("active");
    });

    it("still clamps a completed task arc on the wire while preserving the live object (#250 mutation-safety)", () => {
        useTempDataHome("context-tool-drop-completed-task-");
        const db = openDatabase();
        const tagger = createTagger();
        const longPrompt = `Investigate and fix the regression. ${"y".repeat(600)}`;
        const taskPart = {
            type: "tool",
            tool: "task",
            callID: "call-bg",
            state: {
                status: "completed",
                input: { prompt: longPrompt, subagent_type: "mason" },
                output: '<task state="running">started</task>',
            },
        };
        const messages: MessageLike[] = [
            {
                info: { id: "m-bg", role: "assistant", sessionID: "ses-1" },
                parts: [taskPart],
            },
        ];

        const { targets, batch } = tagMessages("ses-1", messages, tagger, db);
        const toolTagId = tagger.getToolTag("ses-1", "call-bg", "m-bg");
        expect(toolTagId).toBeDefined();

        // Snapshot AFTER tagging (tagMessages legitimately prefixes the output
        // with §N§). The reclaim pass below must not change the live object any
        // further — this is the byte-identity we assert.
        const pristine = JSON.stringify(taskPart);

        // Within the skeleton window → truncate (skeleton) path, as before.
        queuePendingOp(db, "ses-1", toolTagId!, "drop");
        const didMutate = applyPendingOperations("ses-1", db, targets);
        batch.finalize();

        // No reclaim regression: the completed arc still clamps.
        expect(didMutate).toBe(true);
        expect(getTagById(db, "ses-1", toolTagId!)?.dropMode).toBe("truncated");

        // The wire copy now in the array is clamped + sentinelled...
        const wire = messages[0]?.parts[0] as {
            state: { input: Record<string, unknown>; output: string };
        };
        expect(wire).not.toBe(taskPart);
        expect(wire.state.output).toBe(`[dropped \u00a7${toolTagId}\u00a7]`);
        expect(wire.state.input.prompt).toBe("Inves...[truncated]");

        // ...but the LIVE object OpenCode still holds is byte-identical (the long
        // prompt is intact), so a background child spawning from it is unharmed.
        expect(JSON.stringify(taskPart)).toBe(pristine);
        expect(taskPart.state.input.prompt).toBe(longPrompt);
    });

    it("edit_marker: preserves filePath + region hint, freezes mode, replays byte-identically", () => {
        useTempDataHome("context-edit-marker-");
        const db = openDatabase();
        const tagger = createTagger();
        const longDiff = "## SECTION ".repeat(30);
        const messages: MessageLike[] = [
            {
                info: { id: "m-assistant", role: "assistant", sessionID: "ses-1" },
                parts: [
                    {
                        type: "tool",
                        tool: "edit",
                        callID: "call-edit",
                        state: {
                            input: {
                                filePath: "/Users/me/proj/spec.md",
                                oldString: longDiff,
                                newString: `${longDiff}X`,
                            },
                            output: "edit applied",
                            status: "completed",
                        },
                    },
                ],
            },
        ];

        const { targets, batch } = tagMessages("ses-1", messages, tagger, db);
        const tagId = tagger.getToolTag("ses-1", "call-edit", "m-assistant");
        expect(tagId).toBeDefined();

        // Apply as a synthetic edit_marker op (the smart-drops compression path).
        const did = applyPendingOperations(
            "ses-1",
            db,
            targets,
            0,
            undefined,
            [],
            [{ id: 0, sessionId: "ses-1", tagId: tagId!, operation: "drop", queuedAt: 0 }],
            new Set([tagId!]),
        );
        batch.finalize();

        expect(did).toBe(true);
        expect(getTagById(db, "ses-1", tagId!)?.dropMode).toBe("edit_marker");
        const editPart = messages
            .flatMap((m) => m.parts)
            .find((p: any) => p.callID === "call-edit") as any;
        // filePath preserved verbatim; diff clamped; output → canonical sentinel.
        expect(editPart.state.input.filePath).toBe("/Users/me/proj/spec.md");
        expect(editPart.state.input.oldString.endsWith("...[truncated]")).toBe(true);
        expect(editPart.state.output).toBe(`[dropped \u00a7${tagId}\u00a7]`);

        // Snapshot the frozen bytes, then replay via applyFlushedStatuses (the
        // defer-pass path) on a FRESHLY re-tagged copy of the ORIGINAL message:
        // it must reproduce the exact same bytes (cache-stable replay).
        const frozen = JSON.stringify(editPart);

        const replayMessages: MessageLike[] = [
            {
                info: { id: "m-assistant", role: "assistant", sessionID: "ses-1" },
                parts: [
                    {
                        type: "tool",
                        tool: "edit",
                        callID: "call-edit",
                        state: {
                            input: {
                                filePath: "/Users/me/proj/spec.md",
                                oldString: longDiff,
                                newString: `${longDiff}X`,
                            },
                            output: "edit applied",
                            status: "completed",
                        },
                    },
                ],
            },
        ];
        const replay = tagMessages("ses-1", replayMessages, tagger, db);
        applyFlushedStatuses("ses-1", db, replay.targets);
        replay.batch.finalize();
        const replayed = replayMessages
            .flatMap((m) => m.parts)
            .find((p: any) => p.callID === "call-edit") as any;
        expect(JSON.stringify(replayed)).toBe(frozen);
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
        const messageTagId = tagger.getTag("ses-1", "m-5:p0", "message");
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
        const messageTagId = tagger.getTag("ses-1", "m-3:p0", "message");
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
        const toolTagId = tagger.getToolTag("ses-1", "call-2", "m-assistant");
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
        expect(toolPart.state.output).toBe(`[dropped \u00a7${toolTagId}\u00a7]`);
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
        const toolTagId = tagger.getToolTag("ses-1", "call-3", "m-tool");
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
        const toolTagId = tagger.getToolTag("ses-1", "call-3", "m-assistant");
        expect(toolTagId).toBeDefined();
        padSkeletonWindow(db, toolTagId!);

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
        const toolTagId = tagger.getToolTag("ses-1", "call-4", "m-assistant");
        expect(toolTagId).toBeDefined();
        padSkeletonWindow(db, toolTagId!);

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
        const messageTagId = tagger.getTag("ses-1", "m-assistant:p0", "message");
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

    describe("role-aware message drops (canonical [dropped §N§])", () => {
        it("drops a user message to the canonical [dropped §N§] placeholder when queued", () => {
            useTempDataHome("context-user-msg-drop-pending-");
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
            const userMsgTagId = tagger.getTag("ses-1", "m-user:p0", "message");
            expect(userMsgTagId).toBeDefined();

            queuePendingOp(db, "ses-1", userMsgTagId!, "drop");
            const didMutate = applyPendingOperations("ses-1", db, targets);

            expect(didMutate).toBe(true);
            expect(getTagById(db, "ses-1", userMsgTagId!)?.status).toBe("dropped");

            const text = (messages[0]?.parts[0] as { text: string }).text;
            // ONE canonical placeholder — byte-identical regardless of role/content
            // so it can never flip across passes and bust the prompt cache.
            expect(text).toBe(`[dropped §${userMsgTagId}§]`);
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
            const userMsgTagId = tagger.getTag("ses-1", "m-user:p0", "message");
            expect(userMsgTagId).toBeDefined();

            updateTagStatus(db, "ses-1", userMsgTagId!, "dropped");
            const didMutate = applyFlushedStatuses("ses-1", db, targets);

            expect(didMutate).toBe(true);
            const text = (messages[0]?.parts[0] as { text: string }).text;
            // Flushed-status replay produces the SAME canonical placeholder as the
            // execute-pass drop — byte-identical, no flip across passes.
            expect(text).toBe(`[dropped §${userMsgTagId}§]`);
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
            const asstMsgTagId = tagger.getTag("ses-1", "m-assistant:p0", "message");
            expect(asstMsgTagId).toBeDefined();

            queuePendingOp(db, "ses-1", asstMsgTagId!, "drop");
            const didMutate = applyPendingOperations("ses-1", db, targets);

            expect(didMutate).toBe(true);
            expect(messages[1]?.parts).toEqual([
                { type: "text", text: `[dropped §${asstMsgTagId}§]` },
            ]);
        });

        it("a short user message also drops to the canonical [dropped §N§]", () => {
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
            const userMsgTagId = tagger.getTag("ses-1", "m-user:p0", "message");
            queuePendingOp(db, "ses-1", userMsgTagId!, "drop");
            applyPendingOperations("ses-1", db, targets);

            const text = (messages[0]?.parts[0] as { text: string }).text;
            expect(text).toBe(`[dropped §${userMsgTagId}§]`);
        });
    });
});
