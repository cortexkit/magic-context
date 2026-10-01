/// <reference types="bun-types" />

/**
 * Issue #582 — OpenCode 2 WebSocket transport forces a full-history resend
 * because Magic Context re-prefixes assistant-role text parts between turns.
 *
 * The host checkpoints the raw assistant bytes and its incremental-continuation
 * check replays them verbatim. Adding `§N§ ` to a served assistant text part
 * changes those bytes, so the next request falls back to a full history upload.
 *
 * The v2 lane therefore threads `skipPrefixInjection: "assistant-text"` into
 * tagMessages: it withholds the visible prefix from assistant-role text parts
 * only, while still assigning the tag (so ctx_reduce can target the part), and
 * keeps user-message and tool-output prefixes intact. The v1 lane must stay
 * byte-identical to today.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import { type MessageLike, tagMessages } from "./transform-operations";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
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

const TAGGED = /^§\d+§ /;

const USER_TEXT = "please check both files";
const ASSISTANT_TEXT = "I'll check both files now.";
const TOOL_OUTPUT = "file contents";

/**
 * A user prompt, an assistant tool call, its tool result, and a trailing
 * assistant text narration — exactly the shape that triggered the full resend.
 */
function buildMessages(sessionID: string): {
    messages: MessageLike[];
    user: MessageLike;
    assistantText: MessageLike;
    tool: MessageLike;
} {
    const user: MessageLike = {
        info: { id: `${sessionID}-m-user`, role: "user", sessionID },
        parts: [{ type: "text", text: USER_TEXT }],
    };
    const assistantCall: MessageLike = {
        info: { id: `${sessionID}-m-call`, role: "assistant", sessionID },
        parts: [{ type: "tool-invocation", callID: "read:1" }],
    };
    const tool: MessageLike = {
        info: { id: `${sessionID}-m-tool`, role: "tool", sessionID },
        parts: [
            { type: "tool", callID: "read:1", state: { status: "completed", output: TOOL_OUTPUT } },
        ],
    };
    const assistantText: MessageLike = {
        info: { id: `${sessionID}-m-asst`, role: "assistant", sessionID },
        parts: [{ type: "text", text: ASSISTANT_TEXT }],
    };
    return { messages: [user, assistantCall, tool, assistantText], user, assistantText, tool };
}

function textOf(message: MessageLike): string {
    return (message.parts[0] as { text: string }).text;
}

function toolOutputOf(message: MessageLike): string {
    return (message.parts[0] as { state: { output: string } }).state.output;
}

describe("issue #582 — assistant-text prefix injection by lane", () => {
    it('v2 lane ("assistant-text"): withholds the assistant prefix, keeps user + tool prefixes', () => {
        //#given
        useTempDataHome("mc-582-v2-");
        const db = openDatabase();
        const tagger = createTagger();
        const { messages, user, assistantText, tool } = buildMessages("ses-v2");

        //#when
        tagMessages("ses-v2", messages, tagger, db, {
            skipPrefixInjection: "assistant-text",
        });

        //#then — only assistant text loses its visible handle.
        expect(textOf(user)).toMatch(TAGGED);
        expect(toolOutputOf(tool)).toMatch(TAGGED);
        expect(textOf(assistantText)).toBe(ASSISTANT_TEXT);
    });

    it("v2 lane still assigns the assistant tag so ctx_reduce can target the part", () => {
        //#given
        useTempDataHome("mc-582-v2-target-");
        const db = openDatabase();
        const tagger = createTagger();
        const { messages, assistantText } = buildMessages("ses-v2-target");

        //#when
        const result = tagMessages("ses-v2-target", messages, tagger, db, {
            skipPrefixInjection: "assistant-text",
        });

        //#then — a tag target exists for the assistant text, holds the raw
        // content, and is registered for setContent/drop bookkeeping.
        const assistantTarget = [...result.targets.values()].find(
            (target) => target.message === assistantText,
        );
        expect(assistantTarget).toBeDefined();
        expect(assistantTarget?.getContent?.()).toBe(ASSISTANT_TEXT);

        // The withheld prefix means the part was not queued for normalization.
        expect(result.normalizationTargets.some((entry) => entry.message === assistantText)).toBe(
            false,
        );
    });

    it("v1 lane (no gate): prefixes assistant, user, and tool parts exactly as before", () => {
        //#given
        useTempDataHome("mc-582-v1-");
        const db = openDatabase();
        const tagger = createTagger();
        const { messages, user, assistantText, tool } = buildMessages("ses-v1");

        //#when
        const result = tagMessages("ses-v1", messages, tagger, db);

        //#then — legacy behavior is byte-identical: every tagged part is prefixed.
        expect(textOf(user)).toMatch(TAGGED);
        expect(toolOutputOf(tool)).toMatch(TAGGED);
        expect(textOf(assistantText)).toMatch(TAGGED);

        // This lane keeps the assistant part in the normalization set.
        expect(result.normalizationTargets.some((entry) => entry.message === assistantText)).toBe(
            true,
        );
    });

    it("skipPrefixInjection: true still suppresses every prefix (ctx_reduce unavailable)", () => {
        //#given
        useTempDataHome("mc-582-all-");
        const db = openDatabase();
        const tagger = createTagger();
        const { messages, user, assistantText, tool } = buildMessages("ses-all");

        //#when
        const result = tagMessages("ses-all", messages, tagger, db, {
            skipPrefixInjection: true,
        });

        //#then — tag records exist but no part carries a prefix.
        expect(textOf(user)).toBe(USER_TEXT);
        expect(toolOutputOf(tool)).toBe(TOOL_OUTPUT);
        expect(textOf(assistantText)).toBe(ASSISTANT_TEXT);
        expect(result.targets.size).toBeGreaterThan(0);
    });
});
