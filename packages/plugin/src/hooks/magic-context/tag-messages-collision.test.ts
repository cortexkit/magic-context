/// <reference types="bun-types" />

/**
 * v3.3.1 Layer C: tag-messages.ts FIFO pairing + composite-key
 * collision handling tests.
 *
 * The bug class this guards: two assistant turns reusing the same
 * OpenCode-generated callID (e.g. `read:32`) used to bind to the same
 * tag, so dropping the first turn's tag silently propagated to the
 * second turn's content. With composite keys keyed by
 * `(ownerMsgId, callId)`, each turn gets its own independent tag.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    closeDatabase,
    getTagsBySession,
    openDatabase,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import { type MessageLike, tagMessages } from "./transform-operations";

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

describe("tag-messages composite-key collision handling (v3.3.1 Layer C)", () => {
    it("two assistant turns reusing the same callId get distinct tags", () => {
        //#given — two assistant turns, both invoking `read:32`. Pre-fix
        // these would have shared one tag; dropping the first would
        // corrupt the second.
        useTempDataHome("collision-cross-turn-");
        const db = openDatabase();
        const tagger = createTagger();

        const messages: MessageLike[] = [
            {
                info: { id: "m-asst-1", role: "assistant", sessionID: "ses-1" },
                parts: [{ type: "tool-invocation", callID: "read:32" }],
            },
            {
                info: { id: "m-tool-1", role: "tool", sessionID: "ses-1" },
                parts: [{ type: "tool", callID: "read:32", state: { output: "first content" } }],
            },
            {
                info: { id: "m-user-2", role: "user", sessionID: "ses-1" },
                parts: [{ type: "text", text: "ask again" }],
            },
            {
                info: { id: "m-asst-2", role: "assistant", sessionID: "ses-1" },
                parts: [{ type: "tool-invocation", callID: "read:32" }],
            },
            {
                info: { id: "m-tool-2", role: "tool", sessionID: "ses-1" },
                parts: [{ type: "tool", callID: "read:32", state: { output: "second content" } }],
            },
        ];

        //#when
        tagMessages("ses-1", messages, tagger, db);

        //#then — the two turns' tags must be distinct.
        const tag1 = tagger.getToolTag("ses-1", "read:32", "m-asst-1");
        const tag2 = tagger.getToolTag("ses-1", "read:32", "m-asst-2");
        expect(tag1).toBeDefined();
        expect(tag2).toBeDefined();
        expect(tag1).not.toBe(tag2);

        // DB rows reflect the same: two distinct tool tags with
        // different `tool_owner_message_id` values.
        const tags = getTagsBySession(db, "ses-1").filter((t) => t.type === "tool");
        expect(tags).toHaveLength(2);
        const owners = tags.map((t) => t.toolOwnerMessageId).sort();
        expect(owners).toEqual(["m-asst-1", "m-asst-2"]);
    });

    it("FIFO pairing: invocation+result sequences pair correctly across messages", () => {
        //#given — interleaved invocations and results: A1, A2, R1, R2.
        // This is the OpenCode-shape FIFO test from plan Test #14.
        useTempDataHome("collision-fifo-");
        const db = openDatabase();
        const tagger = createTagger();

        const messages: MessageLike[] = [
            {
                info: { id: "m-asst-A1", role: "assistant", sessionID: "ses-1" },
                parts: [{ type: "tool-invocation", callID: "grep:1" }],
            },
            {
                info: { id: "m-asst-A2", role: "assistant", sessionID: "ses-1" },
                parts: [{ type: "tool-invocation", callID: "grep:1" }],
            },
            {
                info: { id: "m-tool-R1", role: "tool", sessionID: "ses-1" },
                parts: [
                    {
                        type: "tool",
                        callID: "grep:1",
                        state: { output: "result for A1" },
                    },
                ],
            },
            {
                info: { id: "m-tool-R2", role: "tool", sessionID: "ses-1" },
                parts: [
                    {
                        type: "tool",
                        callID: "grep:1",
                        state: { output: "result for A2" },
                    },
                ],
            },
        ];

        //#when
        tagMessages("ses-1", messages, tagger, db);

        //#then — FIFO pairing: R1 pairs with A1, R2 pairs with A2.
        // Two distinct tags should exist, owned by m-asst-A1 and
        // m-asst-A2 respectively.
        const tagA1 = tagger.getToolTag("ses-1", "grep:1", "m-asst-A1");
        const tagA2 = tagger.getToolTag("ses-1", "grep:1", "m-asst-A2");
        expect(tagA1).toBeDefined();
        expect(tagA2).toBeDefined();
        expect(tagA1).not.toBe(tagA2);
    });

    it("result-only window with no OC-DB attached falls back to result message id", () => {
        //#given — invocation has been compacted away; only the result
        // shows up in the visible window. Without OC-DB attached, the
        // nearest-prior fallback fails, so we land on the last-resort
        // path: owner == result's own message id. This keeps tag
        // identity stable even in degraded states.
        useTempDataHome("collision-result-only-");
        const db = openDatabase();
        const tagger = createTagger();

        const messages: MessageLike[] = [
            {
                info: { id: "m-tool-orphan", role: "tool", sessionID: "ses-1" },
                parts: [
                    {
                        type: "tool",
                        callID: "read:99",
                        state: { output: "orphan result" },
                    },
                ],
            },
        ];

        //#when
        tagMessages("ses-1", messages, tagger, db);

        //#then — fallback owner = result message id.
        const tag = tagger.getToolTag("ses-1", "read:99", "m-tool-orphan");
        expect(tag).toBeDefined();
        const tags = getTagsBySession(db, "ses-1").filter((t) => t.type === "tool");
        expect(tags).toHaveLength(1);
        expect(tags[0]?.toolOwnerMessageId).toBe("m-tool-orphan");
    });

    it("Anthropic-shape observations populate the FIFO queue but tag allocation is Pi's job", () => {
        //#given — `tag-messages.ts` is the OpenCode-shape pipeline. It
        // only allocates tags for OpenCode `type='tool'` parts via the
        // `isToolPartWithOutput` block. Anthropic-shape `tool_use` /
        // `tool_result` parts are recognized by
        // `extractToolCallObservation` (so the FIFO queue is populated
        // and `toolCallIndex` records the occurrences for drop-target
        // mutation), but the actual tag allocation for those happens
        // in Pi's `tag-transcript.ts` pipeline, not here. This test
        // documents that division.
        useTempDataHome("collision-anthropic-shape-");
        const db = openDatabase();
        const tagger = createTagger();

        const messages: MessageLike[] = [
            {
                info: { id: "m-asst", role: "assistant", sessionID: "ses-1" },
                parts: [{ type: "tool_use", id: "call_abc", name: "search" }],
            },
            {
                info: { id: "m-user", role: "user", sessionID: "ses-1" },
                parts: [
                    {
                        type: "tool_result",
                        tool_use_id: "call_abc",
                        content: "result body",
                    },
                ],
            },
        ];

        //#when
        tagMessages("ses-1", messages, tagger, db);

        //#then — no DB rows allocated by tag-messages.ts for
        // Anthropic-shape parts; `tag-transcript.ts` is the Anthropic
        // pipeline (covered by tag-transcript tests).
        expect(getTagsBySession(db, "ses-1")).toHaveLength(0);
    });

    it("idempotent across multiple passes — same composite key produces same tag", () => {
        //#given — cache stability: tagging the same messages twice must
        // return the same tag numbers. This protects Anthropic prompt-
        // cache prefix stability for replay passes.
        useTempDataHome("collision-idempotent-");
        const db = openDatabase();
        const tagger = createTagger();

        const buildMessages = (): MessageLike[] => [
            {
                info: { id: "m-asst-1", role: "assistant", sessionID: "ses-1" },
                parts: [{ type: "tool-invocation", callID: "read:32" }],
            },
            {
                info: { id: "m-tool-1", role: "tool", sessionID: "ses-1" },
                parts: [{ type: "tool", callID: "read:32", state: { output: "content" } }],
            },
        ];

        //#when
        tagMessages("ses-1", buildMessages(), tagger, db);
        const tagAfterFirstPass = tagger.getToolTag("ses-1", "read:32", "m-asst-1");
        tagMessages("ses-1", buildMessages(), tagger, db);
        const tagAfterSecondPass = tagger.getToolTag("ses-1", "read:32", "m-asst-1");

        //#then
        expect(tagAfterFirstPass).toBeDefined();
        expect(tagAfterSecondPass).toBe(tagAfterFirstPass);
        // Only one DB row (no duplicates).
        const tags = getTagsBySession(db, "ses-1").filter((t) => t.type === "tool");
        expect(tags).toHaveLength(1);
    });
});
