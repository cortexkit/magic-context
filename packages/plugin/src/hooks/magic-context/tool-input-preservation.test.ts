/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import { type MessageLike, tagMessages, truncateErroredTools } from "./transform-operations";

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

describe("tool input preservation", () => {
    it("removes dropped tool call atomically", () => {
        useTempDataHome("context-tool-input-preserve-drop-");
        const db = openDatabase();
        const tagger = createTagger();

        const messages: MessageLike[] = [
            {
                info: { id: "m-assistant", role: "assistant", sessionID: "ses-1" },
                parts: [{ type: "tool-invocation", callID: "call-1" }],
            },
            {
                info: { id: "m-tool", role: "tool", sessionID: "ses-1" },
                parts: [
                    {
                        type: "tool",
                        callID: "call-1",
                        state: {
                            output: "tool output",
                            input: { path: "src/index.ts", replaceAll: true },
                        },
                    },
                ],
            },
        ];

        const { targets, batch } = tagMessages("ses-1", messages, tagger, db);
        const toolTagId = tagger.getTag("ses-1", "call-1");
        expect(toolTagId).toBeDefined();

        const dropResult = targets.get(toolTagId!)?.drop?.();
        expect(dropResult).toBe("removed");
        batch.finalize();
        expect(messages).toHaveLength(0);
    });

    it("preserves errored tool input while still truncating long error text", () => {
        const originalInput = { command: "very long payload" };
        const messages: MessageLike[] = [
            {
                info: { id: "m-1", role: "tool", sessionID: "ses-1" },
                parts: [
                    {
                        type: "tool",
                        state: {
                            status: "error",
                            input: originalInput,
                            error: "x".repeat(150),
                        },
                    },
                ],
            },
        ];

        const messageTagNumbers = new Map<MessageLike, number>([[messages[0], 1]]);
        const mutatedCount = truncateErroredTools(messages, 1, messageTagNumbers);

        const toolPart = messages[0].parts[0] as {
            state: { input?: Record<string, unknown>; error?: string };
        };
        expect(mutatedCount).toBe(1);
        expect(toolPart.state.input).toEqual(originalInput);
        expect(toolPart.state.error).toBeDefined();
        expect(toolPart.state.error).toContain("... [truncated]");
    });
});
