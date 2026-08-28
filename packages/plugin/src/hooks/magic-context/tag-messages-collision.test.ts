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
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    closeDatabase,
    getTagsBySession,
    openDatabase,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import { Database } from "../../shared/sqlite";
import { closeReadOnlySessionDb } from "./read-session-db";
import { type MessageLike, tagMessages } from "./transform-operations";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalTestDataDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;

afterEach(() => {
    closeReadOnlySessionDb();
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

type FallbackLookup =
    | { kind: "candidates"; callId: string }
    | { kind: "messageTimes"; messageIds: readonly string[] };

function createFallbackLookupRecorder(): {
    candidateCalls: Map<string, number>;
    messageTimeCalls: Map<string, number>;
    options: { onToolOwnerFallbackLookup: (lookup: FallbackLookup) => void };
} {
    const candidateCalls = new Map<string, number>();
    const messageTimeCalls = new Map<string, number>();
    return {
        candidateCalls,
        messageTimeCalls,
        options: {
            onToolOwnerFallbackLookup: (lookup) => {
                if (lookup.kind === "candidates") {
                    candidateCalls.set(lookup.callId, (candidateCalls.get(lookup.callId) ?? 0) + 1);
                    return;
                }
                for (const id of lookup.messageIds) {
                    messageTimeCalls.set(id, (messageTimeCalls.get(id) ?? 0) + 1);
                }
            },
        },
    };
}

function toolOutput(message: MessageLike): string {
    const part = message.parts[0] as { state: { output: string } };
    return part.state.output;
}

function createOpenCodeMessageDb(
    rows: Array<{ id: string; timeCreated: number; sessionId?: string }>,
): void {
    const dataHome = process.env.XDG_DATA_HOME;
    if (!dataHome) throw new Error("XDG_DATA_HOME must be set for OpenCode DB fixture");

    const opencodeDir = join(dataHome, "opencode");
    mkdirSync(opencodeDir, { recursive: true });
    const ocDb = new Database(join(opencodeDir, "opencode.db"));
    try {
        ocDb.exec(`
            CREATE TABLE message (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                data TEXT
            )
        `);
        const insert = ocDb.prepare(
            "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, '{}')",
        );
        for (const row of rows) {
            insert.run(row.id, row.sessionId ?? "ses-1", row.timeCreated);
        }
    } finally {
        ocDb.close();
    }
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

    it("serializes each tool input once without changing tag metadata on a mixed fixture", () => {
        useTempDataHome("single-input-serialization-");
        const db = openDatabase();
        const tagger = createTagger();
        let toJSONCalls = 0;
        const countedInput = {
            toJSON() {
                toJSONCalls += 1;
                return { path: "src/index.ts", line: 42 };
            },
        };
        const messages: MessageLike[] = [
            {
                info: { id: "user-placeholder", role: "user", sessionID: "ses-serialize" },
                parts: [{ type: "text", text: "[dropped §1§]" }],
            },
            {
                info: { id: "assistant-counted", role: "assistant", sessionID: "ses-serialize" },
                parts: [
                    { type: "reasoning", text: "signed reasoning", signature: "sig" },
                    { type: "text", text: "<thinking>inline</thinking>answer" },
                    {
                        type: "tool",
                        callID: "read:counted",
                        tool: "read",
                        state: { input: countedInput, output: "counted output" },
                    },
                    { type: "file", mime: "image/png", url: "data:image/png;base64,AAAA" },
                ],
            },
            {
                info: { id: "assistant-plain", role: "assistant", sessionID: "ses-serialize" },
                parts: [
                    {
                        type: "tool",
                        callID: "read:plain",
                        tool: "read",
                        state: {
                            input: { path: "src/index.ts", line: 42 },
                            output: "plain output",
                        },
                    },
                ],
            },
        ];

        tagMessages("ses-serialize", messages, tagger, db);

        const toolTags = getTagsBySession(db, "ses-serialize")
            .filter((tag) => tag.type === "tool")
            .sort((left, right) => (left.messageId ?? "").localeCompare(right.messageId ?? ""));
        expect(toJSONCalls).toBe(1);
        expect(toolTags).toHaveLength(2);
        expect(toolTags[0]?.inputByteSize).toBe(toolTags[1]?.inputByteSize);
        expect(toolTags[0]?.inputTokenCount).toBe(toolTags[1]?.inputTokenCount);
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

    it("scoped load: invocation whose tool tag is below the floor self-heals to the exact persisted number", () => {
        //#given — a tool tag persisted at a LOW number (2), and the tagger
        // loaded with a high scoping floor so that tag is NOT preloaded into
        // the in-memory map (simulating a straddling tool whose invocation sits
        // below the live-wire boundary). This is the Oracle #2 case: the
        // invocation-only observation path used to only try NULL-owner adoption
        // and would MISS an existing composite-keyed tag, leaving it unbound
        // (a queued drop could then be mis-detected). The #2 fix adds a
        // composite DB lookup so it rebinds the EXACT persisted number.
        useTempDataHome("scoped-straddle-");
        const db = openDatabase();
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number, harness, tool_owner_message_id) VALUES (?, ?, 'tool', 100, 2, 'opencode', ?)",
        ).run("ses-1", "read:50", "m-asst-old");

        const tagger = createTagger();
        tagger.initFromDb("ses-1", db, 100); // floor=100 excludes tag 2
        // precondition: below-floor tag is NOT preloaded.
        expect(tagger.getToolTag("ses-1", "read:50", "m-asst-old")).toBeUndefined();

        const messages: MessageLike[] = [
            {
                info: { id: "m-asst-old", role: "assistant", sessionID: "ses-1" },
                parts: [{ type: "tool-invocation", callID: "read:50" }],
            },
        ];

        //#when
        tagMessages("ses-1", messages, tagger, db);

        //#then — the #2 fix rebound the EXACT persisted number (byte-identical
        // §N§), and created no duplicate row.
        expect(tagger.getToolTag("ses-1", "read:50", "m-asst-old")).toBe(2);
        const toolTags = getTagsBySession(db, "ses-1").filter((t) => t.type === "tool");
        expect(toolTags).toHaveLength(1);
        expect(toolTags[0]?.tagNumber).toBe(2);
    });

    describe("F2 tool-owner derivation fallback memoization", () => {
        it("keeps in-window FIFO result owners and tag numbers unchanged without DB fallback", () => {
            useTempDataHome("f2-steady-fifo-");
            const db = openDatabase();
            const tagger = createTagger();
            const recorder = createFallbackLookupRecorder();

            const messages: MessageLike[] = [
                {
                    info: { id: "m-asst-steady", role: "assistant", sessionID: "ses-1" },
                    parts: [{ type: "tool-invocation", callID: "call-steady" }],
                },
                {
                    info: { id: "m-tool-steady", role: "tool", sessionID: "ses-1" },
                    parts: [
                        {
                            type: "tool",
                            callID: "call-steady",
                            state: { output: "steady output" },
                        },
                    ],
                },
            ];

            tagMessages("ses-1", messages, tagger, db, recorder.options);

            expect(tagger.getToolTag("ses-1", "call-steady", "m-asst-steady")).toBe(1);
            expect(tagger.getToolTag("ses-1", "call-steady", "m-tool-steady")).toBeUndefined();
            expect(toolOutput(messages[1])).toBe("§1§ steady output");
            expect(recorder.candidateCalls.size).toBe(0);
            expect(recorder.messageTimeCalls.size).toBe(0);
        });

        it("still FIFO-pops an already-tagged old invocation for a newer result", () => {
            useTempDataHome("f2-open-arc-tail-");
            const db = openDatabase();
            const tagger = createTagger();
            const recorder = createFallbackLookupRecorder();

            const existingTag = tagger.assignToolTag("ses-1", "call-open", "m-old-asst", 100, db);
            const messages: MessageLike[] = [
                {
                    info: { id: "m-old-asst", role: "assistant", sessionID: "ses-1" },
                    parts: [{ type: "tool-invocation", callID: "call-open" }],
                },
                {
                    info: { id: "m-new-result", role: "tool", sessionID: "ses-1" },
                    parts: [
                        {
                            type: "tool",
                            callID: "call-open",
                            state: { output: "new result for old invocation" },
                        },
                    ],
                },
            ];

            tagMessages("ses-1", messages, tagger, db, recorder.options);

            expect(existingTag).toBe(1);
            expect(tagger.getToolTag("ses-1", "call-open", "m-old-asst")).toBe(existingTag);
            expect(tagger.getToolTag("ses-1", "call-open", "m-new-result")).toBeUndefined();
            expect(toolOutput(messages[1])).toBe("§1§ new result for old invocation");
            expect(recorder.candidateCalls.size).toBe(0);
            expect(recorder.messageTimeCalls.size).toBe(0);
        });

        it("preserves duplicate-callId FIFO composite keys and tag numbers across turns", () => {
            useTempDataHome("f2-duplicate-callid-");
            const db = openDatabase();
            const tagger = createTagger();
            const recorder = createFallbackLookupRecorder();

            const messages: MessageLike[] = [
                {
                    info: { id: "m-asst-one", role: "assistant", sessionID: "ses-1" },
                    parts: [{ type: "tool-invocation", callID: "dup-call" }],
                },
                {
                    info: { id: "m-tool-one", role: "tool", sessionID: "ses-1" },
                    parts: [
                        { type: "tool", callID: "dup-call", state: { output: "first dup result" } },
                    ],
                },
                {
                    info: { id: "m-asst-two", role: "assistant", sessionID: "ses-1" },
                    parts: [{ type: "tool-invocation", callID: "dup-call" }],
                },
                {
                    info: { id: "m-tool-two", role: "tool", sessionID: "ses-1" },
                    parts: [
                        {
                            type: "tool",
                            callID: "dup-call",
                            state: { output: "second dup result" },
                        },
                    ],
                },
            ];

            tagMessages("ses-1", messages, tagger, db, recorder.options);

            expect(tagger.getToolTag("ses-1", "dup-call", "m-asst-one")).toBe(1);
            expect(tagger.getToolTag("ses-1", "dup-call", "m-asst-two")).toBe(2);
            expect(toolOutput(messages[1])).toBe("§1§ first dup result");
            expect(toolOutput(messages[3])).toBe("§2§ second dup result");
            expect(recorder.candidateCalls.size).toBe(0);
            expect(recorder.messageTimeCalls.size).toBe(0);
        });

        it("keeps result-only nearest-prior owners per result while memoizing fallback reads", () => {
            useTempDataHome("f2-result-only-nearest-prior-");
            const db = openDatabase();
            const tagger = createTagger();
            const recorder = createFallbackLookupRecorder();
            const callId = "call-result-only";

            const ownerATag = tagger.assignToolTag("ses-1", callId, "m-owner-A", 100, db);
            const ownerBTag = tagger.assignToolTag("ses-1", callId, "m-owner-B", 100, db);
            createOpenCodeMessageDb([
                { id: "m-owner-A", timeCreated: 1_000 },
                { id: "m-result-between", timeCreated: 2_000 },
                { id: "m-owner-B", timeCreated: 3_000 },
                { id: "m-result-after", timeCreated: 4_000 },
            ]);

            const messages: MessageLike[] = [
                {
                    info: { id: "m-result-between", role: "tool", sessionID: "ses-1" },
                    parts: [{ type: "tool", callID: callId, state: { output: "between owners" } }],
                },
                {
                    info: { id: "m-result-after", role: "tool", sessionID: "ses-1" },
                    parts: [
                        { type: "tool", callID: callId, state: { output: "after second owner" } },
                    ],
                },
            ];

            tagMessages("ses-1", messages, tagger, db, recorder.options);

            expect(ownerATag).toBe(1);
            expect(ownerBTag).toBe(2);
            expect(tagger.getToolTag("ses-1", callId, "m-result-between")).toBeUndefined();
            expect(tagger.getToolTag("ses-1", callId, "m-result-after")).toBeUndefined();
            expect(toolOutput(messages[0])).toBe("§1§ between owners");
            expect(toolOutput(messages[1])).toBe("§2§ after second owner");
            expect(recorder.candidateCalls.get(callId)).toBe(1);
            expect(recorder.messageTimeCalls.size).toBe(4);
            expect(recorder.messageTimeCalls.get("m-owner-A")).toBe(1);
            expect(recorder.messageTimeCalls.get("m-owner-B")).toBe(1);
            expect(recorder.messageTimeCalls.get("m-result-between")).toBe(1);
            expect(recorder.messageTimeCalls.get("m-result-after")).toBe(1);
        });
    });
});
