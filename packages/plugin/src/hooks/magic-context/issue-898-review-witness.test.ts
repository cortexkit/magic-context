/// <reference types="bun-types" />
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";

/**
 * Review witnesses for the history-cut fallback that places the summary
 * boundary without the recorded host order.
 *
 * When the summary boundary row is not in the request but rows before it are,
 * the cut is placed by the host store's order (`reanchorStoredBoundary`). A
 * message without an id anywhere in the request makes the recorded order
 * unusable, and the fallback then skips the store-order placement and refuses
 * the cut. Both cases below can be placed from the store's order of the rows
 * that do carry ids, keeping the id-less message where it is.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    capturePrefixTrimSourceOrder,
    type InjectM0M1Result,
    injectM0M1,
    resetPrefixTrimFallbackState,
} from "./inject-compartments";
import { closeReadOnlySessionDb } from "./read-session-db";
import type { MessageLike } from "./tag-messages";

const SESSION_ID = "ses_issue_898_review_witness";
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const tempDirs: string[] = [];
const openDbs: Database[] = [];

afterEach(() => {
    closeReadOnlySessionDb();
    resetPrefixTrimFallbackState(SESSION_ID);
    for (const db of openDbs.splice(0)) closeQuietly(db);
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

const idOf = (index: number): string => `msg_${String(index).padStart(3, "0")}`;
const roleOf = (index: number): "user" | "assistant" => (index % 2 === 1 ? "user" : "assistant");

/** Persist rows 1..count in OpenCode's message table, in canonical order. */
function seedOpenCodeSession(count: number): void {
    const dir = createTestTempDirFromPath(join(tmpdir(), "mc-issue-898-review-"));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    const path = join(dir, "opencode", "opencode.db");
    mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    try {
        db.exec(`
          CREATE TABLE message (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL,
            data TEXT NOT NULL
          );
          CREATE TABLE part (
            id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL,
            data TEXT NOT NULL
          );
        `);
        const insert = db.prepare(
            "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        );
        for (let index = 1; index <= count; index += 1) {
            insert.run(
                idOf(index),
                SESSION_ID,
                index * 1000,
                index * 1000,
                JSON.stringify({ id: idOf(index), role: roleOf(index), sessionID: SESSION_ID }),
            );
        }
    } finally {
        closeQuietly(db);
    }
}

function contextDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    getOrCreateSessionMeta(db, SESSION_ID);
    openDbs.push(db);
    return db;
}

function row(index: number): MessageLike {
    return {
        info: { id: idOf(index), role: roleOf(index), sessionID: SESSION_ID },
        parts: [{ type: "text", text: `row ${index}` }],
    };
}

function rows(from: number, to: number, skip: readonly number[] = []): MessageLike[] {
    const messages: MessageLike[] = [];
    for (let index = from; index <= to; index += 1) {
        if (!skip.includes(index)) messages.push(row(index));
    }
    return messages;
}

/** An assistant message the host adds without an id, as OpenCode does at the step limit. */
function stepLimitNotice(): MessageLike {
    return {
        info: { role: "assistant", sessionID: SESSION_ID },
        parts: [{ type: "text", text: "Maximum steps reached. Summarize your progress." }],
    };
}

/** OpenCode 2.0.22's provider-native checkpoint: an assistant message without an id. */
function providerCheckpoint(): MessageLike {
    return {
        info: { role: "assistant", sessionID: SESSION_ID },
        parts: [{ type: "text", text: "Provider checkpoint of the earlier conversation." }],
    };
}

function preparedPrefix(boundary: string): InjectM0M1Result {
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

/** One pass: the host's array is recorded before the transform, as transform.ts does. */
function servePass(
    db: Database,
    source: MessageLike[],
    boundary: string,
    isCacheBustingPass: boolean,
) {
    const messages = structuredClone(source);
    const result = injectM0M1({
        db,
        sessionId: SESSION_ID,
        state: getOrCreateSessionMeta(db, SESSION_ID),
        messages,
        preparedPrefix: preparedPrefix(boundary),
        prefixTrimSourceOrder: capturePrefixTrimSourceOrder(source),
        isCacheBustingPass,
    });
    return { result, messages };
}

const storedIds = (messages: readonly MessageLike[]): string[] =>
    messages.flatMap((message) => (typeof message.info.id === "string" ? [message.info.id] : []));

describe("issue 898 review: a message without an id and a boundary missing from the request", () => {
    it("a step-limit notice present on one pass only does not change which rows a cache-preserving pass cuts", () => {
        // Rows 1..30 are stored; the summary ends on row 12, which the host does
        // not send. Rows 5..11 are in the request and covered by the summary.
        seedOpenCodeSession(30);
        const db = contextDb();
        const boundary = idOf(12);
        const window = rows(5, 30, [12]);

        // A cache-preserving pass without the notice: the store's order places
        // row 12 and the covered rows 5..11 are cut.
        const plain = servePass(db, window, boundary, false);
        expect(plain.result.prefixTrimStatus).toBe("applied");
        expect(storedIds(plain.messages)).toEqual(storedIds(rows(13, 30)));

        // The next cache-preserving pass carries the host's one-pass step-limit
        // notice. Everything else is the same, so the request must be the one
        // above plus the notice; otherwise the cached prefix changes on a pass
        // that may not change it, and covered rows are sent next to their summary.
        const noticed = servePass(db, [...window, stepLimitNotice()], boundary, false);
        expect(storedIds(noticed.messages)).toEqual(storedIds(plain.messages));
        expect(JSON.stringify(noticed.messages.slice(0, -1))).toBe(JSON.stringify(plain.messages));
        expect(noticed.result.prefixTrimStatus).toBe("applied");
    });

    it("a provider checkpoint without an id does not refuse a boundary the store can place", () => {
        // The host compacted with the provider's own compaction: the request
        // starts with the two newest user messages at that time (rows 3 and 5)
        // and the provider's checkpoint without an id, then the rows after it.
        // The summary ends on row 4, which the request does not hold. The store
        // orders rows 3 < 4 < 5 < 6..30, so row 3 is covered and the rest is not.
        seedOpenCodeSession(30);
        const db = contextDb();
        const boundary = idOf(4);
        const window = [row(3), row(5), providerCheckpoint(), ...rows(6, 30)];

        for (const busting of [true, false]) {
            const pass = servePass(db, window, boundary, busting);
            expect(pass.result.prefixTrimRefusal).toBeUndefined();
            expect(pass.result.prefixTrimStatus).toBe("applied");
            expect(storedIds(pass.messages)).toEqual(storedIds([row(5), ...rows(6, 30)]));
        }
    });
});
