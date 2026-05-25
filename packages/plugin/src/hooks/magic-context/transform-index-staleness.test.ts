/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Scheduler } from "../../features/magic-context/scheduler";
import {
    closeDatabase,
    getTagsBySession,
    openDatabase,
    queuePendingOp,
    updateTagStatus,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import type { ContextUsage } from "../../features/magic-context/types";
import { createNudgePlacementStore, createTransform } from "./transform";

type TextPart = { type: "text"; text: string };
type ThinkingPart = { type: "thinking"; thinking: string };
type ToolPart = {
    type: "tool";
    callID: string;
    state: { output: string; status?: string; error?: string };
};
type ToolInvocationPart = { type: "tool-invocation"; callID: string };
type FilePart = { type: "file"; url: string; mime?: string; filename?: string };
type TestPart = TextPart | ThinkingPart | ToolPart | ToolInvocationPart | FilePart;

type TestMessage = {
    info: { id: string; role: string; sessionID?: string };
    parts: TestPart[];
};

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;
afterEach(() => {
    closeDatabase();
    process.env.XDG_DATA_HOME = originalXdgDataHome;
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
}
function createTestTransform(sessionId: string) {
    const shouldExecute = mock<Scheduler["shouldExecute"]>(() => "defer");
    const scheduler: Scheduler = { shouldExecute };
    // Force providerID="anthropic" so the merged-assistants strip workaround
    // runs in this test fixture (the workaround is gated on canonical
    // Anthropic to prevent Kimi/Moonshot rejections; this test specifically
    // validates Opus 4.7's position-0 thinking invariant interaction with
    // pruning, so it needs the gate to be open).
    const liveModelBySession = new Map<string, { providerID: string; modelID: string }>([
        [sessionId, { providerID: "anthropic", modelID: "claude-opus-4-7" }],
    ]);
    const transform = createTransform({
        tagger: createTagger(),
        scheduler,
        contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
            [sessionId, { usage: { percentage: 50, inputTokens: 100_000 }, updatedAt: Date.now() }],
        ]),
        liveModelBySession,
        nudger: () => null,
        db: openDatabase(),
        nudgePlacements: createNudgePlacementStore(),
        historyRefreshSessions: new Set<string>(),
        pendingMaterializationSessions: new Set<string>(),
        lastHeuristicsTurnId: new Map<string, string>(),
        clearReasoningAge: 2,
        protectedTags: 0,
        autoDropToolAge: 1000,
        dropToolStructure: true,
    });
    return { transform, shouldExecute };
}
describe("createTransform index staleness regressions", () => {
    it("does not truncate errored tools above watermark after tool-drop pruning", async () => {
        useTempDataHome("context-transform-stale-truncate-");
        const sessionId = "ses-stale-truncate";
        const { transform } = createTestTransform(sessionId);

        const firstPass: TestMessage[] = [
            {
                info: { id: "m-user-1", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "start" }],
            },
            {
                info: { id: "m-assistant-call", role: "assistant" },
                parts: [{ type: "tool-invocation", callID: "call-drop" }],
            },
            {
                info: { id: "m-tool-drop", role: "tool" },
                parts: [{ type: "tool", callID: "call-drop", state: { output: "drop output" } }],
            },
            {
                info: { id: "m-user-2", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "next" }],
            },
            {
                info: { id: "m-tool-keep", role: "tool" },
                parts: [
                    {
                        type: "tool",
                        callID: "call-keep",
                        state: { output: "keep output", status: "error", error: "x".repeat(150) },
                    },
                ],
            },
        ];

        await transform({}, { messages: firstPass });

        const db = openDatabase();
        const dropTag = getTagsBySession(db, sessionId).find(
            (tag) => tag.type === "tool" && tag.messageId === "call-drop",
        );
        if (!dropTag) {
            throw new Error("expected call-drop tool tag");
        }
        updateTagStatus(db, sessionId, dropTag.tagNumber, "dropped");

        const secondPass: TestMessage[] = [
            {
                info: { id: "m-user-1", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "start" }],
            },
            {
                info: { id: "m-assistant-call", role: "assistant" },
                parts: [{ type: "tool-invocation", callID: "call-drop" }],
            },
            {
                info: { id: "m-tool-drop", role: "tool" },
                parts: [{ type: "tool", callID: "call-drop", state: { output: "drop output" } }],
            },
            {
                info: { id: "m-user-2", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "next" }],
            },
            {
                info: { id: "m-tool-keep", role: "tool" },
                parts: [
                    {
                        type: "tool",
                        callID: "call-keep",
                        state: { output: "keep output", status: "error", error: "x".repeat(150) },
                    },
                ],
            },
        ];

        await transform({}, { messages: secondPass });

        const keepToolPart = secondPass[2].parts[0] as ToolPart;
        expect(keepToolPart.state.error).toBe("x".repeat(150));
    });

    it("does not strip processed images above watermark after tool-drop pruning", async () => {
        useTempDataHome("context-transform-stale-images-");
        const sessionId = "ses-stale-images";
        const { transform } = createTestTransform(sessionId);
        const longDataUrl = `data:image/png;base64,${"A".repeat(300)}`;

        const firstPass: TestMessage[] = [
            {
                info: { id: "m-user-1", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "start" }],
            },
            {
                info: { id: "m-assistant-call", role: "assistant" },
                parts: [{ type: "tool-invocation", callID: "call-drop" }],
            },
            {
                info: { id: "m-tool-drop", role: "tool" },
                parts: [{ type: "tool", callID: "call-drop", state: { output: "drop output" } }],
            },
            {
                info: { id: "m-assistant-mid", role: "assistant" },
                parts: [{ type: "text", text: "middle" }],
            },
            {
                info: { id: "m-user-image", role: "user", sessionID: sessionId },
                parts: [
                    { type: "text", text: "image request" },
                    { type: "file", mime: "image/png", url: longDataUrl, filename: "img.png" },
                ],
            },
            {
                info: { id: "m-assistant-tail", role: "assistant" },
                parts: [{ type: "text", text: "tail" }],
            },
        ];

        await transform({}, { messages: firstPass });

        const db = openDatabase();
        const dropTag = getTagsBySession(db, sessionId).find(
            (tag) => tag.type === "tool" && tag.messageId === "call-drop",
        );
        if (!dropTag) {
            throw new Error("expected call-drop tool tag");
        }
        updateTagStatus(db, sessionId, dropTag.tagNumber, "dropped");

        const secondPass: TestMessage[] = [
            {
                info: { id: "m-user-1", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "start" }],
            },
            {
                info: { id: "m-assistant-call", role: "assistant" },
                parts: [{ type: "tool-invocation", callID: "call-drop" }],
            },
            {
                info: { id: "m-tool-drop", role: "tool" },
                parts: [{ type: "tool", callID: "call-drop", state: { output: "drop output" } }],
            },
            {
                info: { id: "m-assistant-mid", role: "assistant" },
                parts: [{ type: "text", text: "middle" }],
            },
            {
                info: { id: "m-user-image", role: "user", sessionID: sessionId },
                parts: [
                    { type: "text", text: "image request" },
                    { type: "file", mime: "image/png", url: longDataUrl, filename: "img.png" },
                ],
            },
            {
                info: { id: "m-assistant-tail", role: "assistant" },
                parts: [{ type: "text", text: "tail" }],
            },
        ];

        await transform({}, { messages: secondPass });

        expect(secondPass[2].parts.some((part) => part.type === "file")).toBe(true);
    });

    it("replays errored-tool truncation and processed-image stripping on defer passes", async () => {
        useTempDataHome("context-transform-defer-watermark-replay-");
        const sessionId = "ses-defer-watermark-replay";
        const { transform } = createTestTransform(sessionId);
        const longDataUrl = `data:image/png;base64,${"A".repeat(300)}`;
        const longError = "E".repeat(180);

        const buildMessages = (): TestMessage[] => [
            {
                info: { id: "m-user-image", role: "user", sessionID: sessionId },
                parts: [
                    { type: "text", text: "please inspect this image" },
                    { type: "file", mime: "image/png", url: longDataUrl, filename: "img.png" },
                ],
            },
            {
                info: { id: "m-assistant-image", role: "assistant" },
                parts: [{ type: "text", text: "processed the image" }],
            },
            {
                info: { id: "m-tool-error", role: "tool" },
                parts: [
                    {
                        type: "tool",
                        callID: "call-error",
                        state: { output: "", status: "error", error: longError },
                    },
                ],
            },
            {
                info: { id: "m-tail", role: "assistant" },
                parts: [{ type: "text", text: "tail marker" }],
            },
        ];

        await transform({}, { messages: buildMessages() });

        const db = openDatabase();
        const tags = getTagsBySession(db, sessionId);
        const watermarkTag = Math.max(...tags.map((tag) => tag.tagNumber));
        updateTagStatus(db, sessionId, watermarkTag, "dropped");

        const firstDeferPass = buildMessages();
        await transform({}, { messages: firstDeferPass });
        const firstBytes = JSON.stringify(firstDeferPass);

        const filePartAfterReplay = firstDeferPass[0].parts[1];
        const toolPartAfterReplay = firstDeferPass[2].parts[0] as ToolPart;
        expect(filePartAfterReplay).toEqual({ type: "text", text: "" });
        expect(toolPartAfterReplay.state.error).toBe(`${longError.slice(0, 100)}... [truncated]`);

        const secondDeferPass = buildMessages();
        await transform({}, { messages: secondDeferPass });
        expect(JSON.stringify(secondDeferPass)).toBe(firstBytes);
    });

    it("clears reasoning before dropped messages correctly after tool-drop pruning", async () => {
        useTempDataHome("context-transform-stale-reasoning-");
        const sessionId = "ses-stale-reasoning";
        const { transform, shouldExecute } = createTestTransform(sessionId);

        const firstPass: TestMessage[] = [
            {
                info: { id: "m-user", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "request" }],
            },
            {
                info: { id: "m-reason-a", role: "assistant" },
                parts: [
                    { type: "thinking", thinking: "reasoning a" },
                    { type: "text", text: "resp a" },
                ],
            },
            {
                info: { id: "m-assistant-call", role: "assistant" },
                parts: [{ type: "tool-invocation", callID: "call-drop" }],
            },
            {
                info: { id: "m-tool-drop", role: "tool" },
                parts: [{ type: "tool", callID: "call-drop", state: { output: "drop output" } }],
            },
            {
                info: { id: "m-reason-b", role: "assistant" },
                parts: [
                    { type: "thinking", thinking: "reasoning b" },
                    { type: "text", text: "resp b" },
                ],
            },
            {
                info: { id: "m-drop", role: "assistant" },
                parts: [
                    { type: "thinking", thinking: "to clear" },
                    { type: "text", text: "drop me" },
                ],
            },
        ];

        await transform({}, { messages: firstPass });

        const db = openDatabase();
        const tags = getTagsBySession(db, sessionId);
        const dropTag = tags.find((tag) => tag.type === "tool" && tag.messageId === "call-drop");
        const messageDropTag = tags.find(
            (tag) => tag.type === "message" && tag.messageId === "m-drop:p1",
        );
        if (!dropTag || !messageDropTag) {
            throw new Error("expected required tags for pruning + pending drop");
        }

        updateTagStatus(db, sessionId, dropTag.tagNumber, "dropped");
        queuePendingOp(db, sessionId, messageDropTag.tagNumber, "drop");
        shouldExecute.mockImplementation(() => "execute");

        const secondPass: TestMessage[] = [
            {
                info: { id: "m-user", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "request" }],
            },
            {
                info: { id: "m-reason-a", role: "assistant" },
                parts: [
                    { type: "thinking", thinking: "reasoning a" },
                    { type: "text", text: "resp a" },
                ],
            },
            {
                info: { id: "m-assistant-call", role: "assistant" },
                parts: [{ type: "tool-invocation", callID: "call-drop" }],
            },
            {
                info: { id: "m-tool-drop", role: "tool" },
                parts: [{ type: "tool", callID: "call-drop", state: { output: "drop output" } }],
            },
            {
                info: { id: "m-reason-b", role: "assistant" },
                parts: [
                    { type: "thinking", thinking: "reasoning b" },
                    { type: "text", text: "resp b" },
                ],
            },
            {
                info: { id: "m-drop", role: "assistant" },
                parts: [
                    { type: "thinking", thinking: "to clear" },
                    { type: "text", text: "drop me" },
                ],
            },
        ];

        await transform({}, { messages: secondPass });

        // The tool drop removed m-assistant-call and m-tool-drop via pruneEmptyMessages, so array shifts:
        // [0]=m-user, [1]=m-reason-a, [2]=m-reason-b, [3]=m-drop
        // clearReasoningAge=2: maxTag=6, ageCutoff=4; m-reason-a (tag 2 <=4) is cleared then stripped
        expect(
            secondPass[1].parts.some((p) => (p as ThinkingPart).thinking === "reasoning a"),
        ).toBe(false);
        // m-reason-b is now at index 2 after dropped messages were pruned — becoming the
        // second assistant in a consecutive run with m-reason-a and m-drop. The merged-
        // assistants workaround (stripReasoningFromMergedAssistants) strips thinking from
        // every assistant except the first in a run to keep Opus 4.7's position-0 thinking
        // invariant, so m-reason-b's thinking is correctly removed even though its tag 5 is
        // above the watermark ageCutoff=4. This tests the interaction between pruning and
        // merge-strip, not the watermark path.
        expect(
            secondPass[2].parts.some((p) => (p as ThinkingPart).thinking === "reasoning b"),
        ).toBe(false);
    });
});
