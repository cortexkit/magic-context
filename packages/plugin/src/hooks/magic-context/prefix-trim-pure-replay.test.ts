/// <reference types="bun-types" />
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";

/**
 * Byte pins for prefix-trim shapes that must not change when the absent-boundary
 * fallback is added: a boundary found by id, no boundary, a boundary with no
 * host store to consult, and the source-order trim. The pinned digests were
 * computed before the fallback existed, so this file imports nothing the
 * fallback introduced and can be run against either version of
 * inject-compartments.ts.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    getOrCreateSessionMeta,
    queuePendingOp,
    updateTagStatus,
} from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { createTagger } from "../../features/magic-context/tagger";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    type InjectM0M1Result,
    injectM0M1,
    type PrefixTrimSourceOrder,
} from "./inject-compartments";
import { closeReadOnlySessionDb } from "./read-session-db";
import type { MessageLike } from "./tag-messages";
import { applyFlushedStatuses, applyPendingOperations, tagMessages } from "./transform-operations";

const SESSION_ID = "ses_prefix_trim_pure_replay";
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const cleanup: Array<() => void> = [];

afterEach(() => {
    closeReadOnlySessionDb();
    for (const fn of cleanup.splice(0)) fn();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
});

/** An XDG_DATA_HOME with no OpenCode store in it, so no ordinal can resolve. */
function emptyDataHome(): void {
    const dir = createTestTempDirFromPath(join(tmpdir(), "mc-prefix-trim-pure-"));
    process.env.XDG_DATA_HOME = dir;
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
}

function contextDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    getOrCreateSessionMeta(db, SESSION_ID);
    cleanup.push(() => closeQuietly(db));
    return db;
}

const idOf = (index: number): string => `msg_${String(index).padStart(3, "0")}`;

function liveWindow(from: number, to: number, skip: readonly number[] = []): MessageLike[] {
    const messages: MessageLike[] = [];
    for (let index = from; index <= to; index += 1) {
        if (skip.includes(index)) continue;
        messages.push({
            info: {
                id: idOf(index),
                role: index % 2 === 1 ? "user" : "assistant",
                sessionID: SESSION_ID,
            },
            parts: [{ type: "text", text: `row ${index}` }],
        });
    }
    return messages;
}

function prepared(boundary: string | undefined): InjectM0M1Result {
    return {
        injected: true,
        prependedMessageCount: 0,
        m0RematerializedThisPass: false,
        materializationContentionRetryExhausted: false,
        decision: { value: false, reason: "cache_hit" },
        m0Bytes: Buffer.from("m0"),
        m1Text: "m1",
        preparedMessages: [
            {
                info: { role: "user", sessionID: SESSION_ID },
                parts: [{ type: "text", text: "summary prefix", synthetic: true }],
            } as MessageLike,
        ],
        preparedTrimBoundaryId: boundary,
    };
}

function pass(
    db: Database,
    messages: MessageLike[],
    boundary: string | undefined,
    busting: boolean,
    sourceOrder?: PrefixTrimSourceOrder,
): string {
    const result = injectM0M1({
        db,
        sessionId: SESSION_ID,
        state: getOrCreateSessionMeta(db, SESSION_ID),
        messages,
        preparedPrefix: prepared(boundary),
        isCacheBustingPass: busting,
        prefixTrimSourceOrder: sourceOrder,
    });
    return createHash("sha256")
        .update(JSON.stringify({ status: result.prefixTrimStatus, messages }))
        .digest("hex")
        .slice(0, 16);
}

function sourceOrderOf(messages: readonly MessageLike[]): PrefixTrimSourceOrder {
    return {
        messageIds: messages.map((message) => message.info.id as string),
        syntheticHeadCount: 0,
        invalidReason: null,
    };
}

function scenarios(): Record<string, string[]> {
    emptyDataHome();
    const db = contextDb();
    const out: Record<string, string[]> = {};
    out.foundById = [
        pass(db, liveWindow(1, 20), idOf(6), true),
        pass(db, liveWindow(1, 20), idOf(6), false),
        pass(db, liveWindow(1, 21), idOf(6), false),
    ];
    out.noBoundary = [
        pass(db, liveWindow(1, 20), undefined, true),
        pass(db, liveWindow(1, 21), undefined, false),
    ];
    out.absentNoStore = [
        pass(db, liveWindow(1, 20, [6]), idOf(6), false),
        pass(db, liveWindow(1, 20, [6]), idOf(6), true),
        pass(db, liveWindow(1, 21, [6]), idOf(6), false),
    ];
    const ordered = liveWindow(1, 20);
    out.sourceOrderFound = [
        pass(db, ordered, idOf(9), true, sourceOrderOf(liveWindow(1, 20))),
        pass(db, liveWindow(1, 21), idOf(9), false, sourceOrderOf(liveWindow(1, 21))),
    ];
    out.sourceOrderInvalid = [
        pass(db, liveWindow(1, 20), idOf(9), false, {
            ...sourceOrderOf(liveWindow(1, 20)),
            invalidReason: "host reordered",
        }),
    ];
    return out;
}

describe("prefix trim shapes the absent-boundary fallback must not change", () => {
    it("serves the same bytes as before the fallback existed", () => {
        const actual = scenarios();
        if (process.env.MC_PURE_REPLAY_PRINT === "1") console.log(JSON.stringify(actual));
        expect(actual).toEqual(PINNED);
    });
});

// Computed with inject-compartments.ts from master bd8b7d5fce (before the fallback).
// sourceOrderInvalid is the one exception: an unusable source order now places a
// visible boundary by its position in the live array instead of refusing the
// cut, so it serves exactly the bytes a valid source order serves for the same
// window and boundary (sourceOrderFound[0]).
const PINNED: Record<string, string[]> = {
    foundById: ["e240e7397f6f9ee3", "e240e7397f6f9ee3", "9d4ad8f05834550d"],
    noBoundary: ["daa9121a6e3f22d2", "4799ab1110ffbdf5"],
    absentNoStore: ["b46ecebebfe62beb", "b46ecebebfe62beb", "84e38817a370b5b2"],
    sourceOrderFound: ["fde86711883560fc", "0ec71e798e4c1e9b"],
    sourceOrderInvalid: ["fde86711883560fc"],
};

it("keeps a partial end-boundary message and its uncovered blocks raw on direct and source-order trims", () => {
    emptyDataHome();
    const db = contextDb();
    db.prepare(
        "INSERT INTO compartments(session_id, sequence, start_message, end_message, start_message_id, end_message_id, end_block_index, title, content, created_at) VALUES (?, 1, 1, 2, ?, ?, 0, 'partial', 'covers only the first block', 1)",
    ).run(SESSION_ID, idOf(1), idOf(2));
    for (const sourceOrder of [
        undefined,
        { messageIds: [idOf(1), idOf(2), idOf(3)], syntheticHeadCount: 0, invalidReason: null },
    ]) {
        const make = () => {
            const messages = liveWindow(1, 3);
            messages[1].parts.push({ type: "text", text: "UNCOVERED_SUFFIX" });
            return messages;
        };
        const first = make();
        const digest = pass(db, first, idOf(2), false, sourceOrder);
        expect(first.some((message) => message.info.id === idOf(1))).toBe(false);
        expect(first.some((message) => message.info.id === idOf(2))).toBe(true);
        expect(JSON.stringify(first)).toContain("UNCOVERED_SUFFIX");
        expect(pass(db, make(), idOf(2), false, sourceOrder)).toBe(digest);
    }
});

it("keeps large tool, image, and signed thinking suffixes unchanged through append-only defers", () => {
    emptyDataHome();
    const db = contextDb();
    db.prepare(
        "INSERT INTO compartments(session_id, sequence, start_message, end_message, start_message_id, end_message_id, end_block_index, title, content, created_at) VALUES (?, 1, 1, 2, ?, ?, 0, 'partial', 'covered block', 1)",
    ).run(SESSION_ID, idOf(1), idOf(2));
    const suffixes = [
        { type: "tool", content: `TOOL_UNCOVERED_${"x".repeat(128_000)}` },
        { type: "file", mime: "image/png", url: `data:image/png;base64,${"A".repeat(8_192)}` },
        { type: "thinking", thinking: "SIGNED_UNCOVERED", signature: "signed-original-bytes" },
    ];
    for (const suffix of suffixes) {
        for (const ordered of [false, true]) {
            const make = (append: boolean) => {
                const messages = liveWindow(1, append ? 4 : 3);
                messages[1].parts.push(structuredClone(suffix));
                return messages;
            };
            const order = (messages: MessageLike[]) =>
                ordered ? sourceOrderOf(messages) : undefined;
            const first = make(false);
            pass(db, first, idOf(2), true, order(first));
            const prefix = JSON.stringify(first);
            expect(first.filter((message) => message.info.id === idOf(2))).toHaveLength(1);
            expect(first.find((message) => message.info.id === idOf(2))?.parts[1]).toEqual(suffix);
            const defer = make(true);
            pass(db, defer, idOf(2), false, order(defer));
            expect(JSON.stringify(defer.slice(0, first.length))).toBe(prefix);
            expect(defer.filter((message) => message.info.id === idOf(2))).toHaveLength(1);
        }
    }
});

it("priced partial boundary preserves served prefix bytes after append and defer", () => {
    emptyDataHome();
    const db = contextDb();
    db.prepare(
        "INSERT INTO compartments(session_id, sequence, start_message, end_message, start_message_id, end_message_id, end_block_index, title, content, created_at) VALUES (?, 1, 1, 2, ?, ?, 0, 'partial', 'covered', 1)",
    ).run(SESSION_ID, idOf(1), idOf(2));
    const make = (append: boolean) => {
        const messages = liveWindow(1, append ? 4 : 3);
        messages[1].parts.push({
            type: "thinking",
            thinking: "signed suffix",
            signature: "original-signature",
        });
        return messages;
    };
    const tagger = createTagger();
    const first = make(false);
    pass(db, first, idOf(2), true);
    const tagged = tagMessages(SESSION_ID, first, tagger, db);
    tagged.batch.finalize();
    const tag = tagger.getTag(SESSION_ID, `${idOf(2)}:p0`, "message");
    expect(tag).toBeDefined();
    const price = db
        .prepare("SELECT byte_size FROM tags WHERE session_id=? AND tag_number=?")
        .get(SESSION_ID, tag!) as { byte_size: number };
    expect(price.byte_size).toBeGreaterThan(0);
    const prefix = JSON.stringify(first);
    const defer = make(true);
    pass(db, defer, idOf(2), false);
    const replay = tagMessages(SESSION_ID, defer, tagger, db);
    replay.batch.finalize();
    expect(JSON.stringify(defer.slice(0, first.length))).toBe(prefix);
    expect(
        (
            db
                .prepare("SELECT byte_size FROM tags WHERE session_id=? AND tag_number=?")
                .get(SESSION_ID, tag!) as { byte_size: number }
        ).byte_size,
    ).toBe(price.byte_size);
});

for (const kind of ["ctx_reduce", "age-drop status replay"] as const) {
    for (const role of ["tool", "assistant"] as const) {
        it(`${kind} of a partial ${role} must preserve uncovered suffix through defer`, () => {
            emptyDataHome();
            const db = contextDb();
            db.prepare(
                "INSERT INTO compartments(session_id, sequence, start_message, end_message, start_message_id, end_message_id, end_block_index, title, content, created_at) VALUES (?, 1, 1, 2, ?, ?, 0, 'partial', 'covered block', 1)",
            ).run(SESSION_ID, idOf(1), idOf(2));
            const make = (append: boolean) => {
                const messages = liveWindow(1, append ? 4 : 3);
                messages[1].info.role = role;
                messages[1].parts =
                    role === "tool"
                        ? [
                              { type: "text", text: "covered" },
                              {
                                  type: "tool",
                                  callID: "uncovered-call",
                                  state: { output: "UNCOVERED_TOOL" },
                              },
                          ]
                        : [
                              { type: "text", text: "covered" },
                              {
                                  type: "thinking",
                                  thinking: "UNCOVERED_THINKING",
                                  signature: "signed-by-host",
                              },
                          ];
                return messages;
            };
            const tagger = createTagger();
            const first = make(false);
            pass(db, first, idOf(2), true);
            const tagged = tagMessages(SESSION_ID, first, tagger, db);
            const tag = tagger.getTag(SESSION_ID, `${idOf(2)}:p0`, "message");
            expect(tag).toBeDefined();
            if (kind === "ctx_reduce") {
                queuePendingOp(db, SESSION_ID, tag!, "drop");
                applyPendingOperations(SESSION_ID, db, tagged.targets, new Set());
            } else {
                updateTagStatus(db, SESSION_ID, tag!, "dropped");
                applyFlushedStatuses(SESSION_ID, db, tagged.targets);
            }
            tagged.batch.finalize();
            const served = first.find((message) => message.info.id === idOf(2));
            expect(JSON.stringify(served)).toContain(
                role === "tool" ? "UNCOVERED_TOOL" : "UNCOVERED_THINKING",
            );
            const prefix = JSON.stringify(first);
            const defer = make(true);
            pass(db, defer, idOf(2), false);
            const replay = tagMessages(SESSION_ID, defer, tagger, db);
            applyFlushedStatuses(SESSION_ID, db, replay.targets);
            replay.batch.finalize();
            expect(JSON.stringify(defer.slice(0, first.length))).toBe(prefix);
        });
    }
}
