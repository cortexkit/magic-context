/// <reference types="bun-types" />
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";

/**
 * Tests for `applyDeferredCompactionMarker` (plan v6 §5).
 *
 * These cover the validation + outcome surface end-to-end against a real
 * OpenCode DB harness (same pattern as compaction-marker-consistency.test.ts):
 *
 *   - applied happy path (no existing marker, validation passes)
 *   - already-current when persisted marker is at the pending ordinal
 *   - stale-skip / compartment-removed when the raw OC message is gone
 *   - stale-skip / compartment-removed when the local compartment row is gone
 *   - stale-skip / target-superseded when the compartment ordinal advanced
 *   - retryable-failure when DB access throws
 *
 * The remove→inject sequencing for the boundary-advance case is exercised
 * indirectly via the "applied" path: when there's no existing marker, we
 * verify inject succeeded. The "retryable on inject null" is covered by
 * deleting the boundary message after validation but before inject can
 * find a target.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    findBoundaryUserMessage,
    injectCompactionMarker,
    prepareCompactionMarkerCandidates,
} from "../../features/magic-context/compaction-marker";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import {
    getPersistedCompactionMarkerState,
    type PendingCompactionMarker,
    type PersistedCompactionMarkerState,
    setPendingCompactionMarkerState,
    setPersistedCompactionMarkerState,
} from "../../features/magic-context/storage-meta-persisted";
import { getTagById, insertTag } from "../../features/magic-context/storage-tags";
import { createTagger } from "../../features/magic-context/tagger";
import { _resetHarnessForTesting, setHarness } from "../../shared/harness";
import * as logger from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    applyDeferredCompactionMarker as applyDeferredOriginal,
    checkCompactionMarkerConsistency,
    closeCompactionMarkerConnection,
    MARKER_SUMMARY_TEXT,
    markerUpdateDefinitelyDidNotCut,
    updateCompactionMarkerAfterPublication as updateOriginal,
} from "./compaction-marker-manager";
import {
    clearInjectionCache,
    prepareCompartmentInjection,
    selectHiddenMessagesAtCompactionSeam,
} from "./inject-compartments";
import type { MessageLike } from "./tag-messages";
import {
    reconcileMarkerRepresentation,
    runRustModePostprocess,
} from "./transform-postprocess-phase";

const tempDirs: string[] = [];
// Production prepares summary IDs on a worker when rebuilding context history,
// before attempting these synchronous marker writes. Fixtures do the same.
async function applyDeferredCompactionMarker(...args: Parameters<typeof applyDeferredOriginal>) {
    await prepareCompactionMarkerCandidates(args[1]);
    return applyDeferredOriginal(...args);
}
async function updateCompactionMarkerAfterPublication(...args: Parameters<typeof updateOriginal>) {
    await prepareCompactionMarkerCandidates(args[1]);
    return updateOriginal(...args);
}
const originalXdgDataHome = process.env.XDG_DATA_HOME;

function useTempDataHome(prefix: string): string {
    const dir = createTestTempDirFromPath(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    mkdirSync(join(dir, "opencode"), { recursive: true });
    mkdirSync(join(dir, "cortexkit", "magic-context"), { recursive: true });
    return dir;
}

function createOpenCodeDb(dataHome: string): Database {
    const dbPath = join(dataHome, "opencode", "opencode.db");
    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec(
        "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
    );
    db.exec(
        "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
    );
    return db;
}

function insertUserMessage(db: Database, id: string, sessionId: string, timeCreated: number): void {
    insertMessage(db, id, sessionId, timeCreated, "user");
}

function insertMessage(
    db: Database,
    id: string,
    sessionId: string,
    timeCreated: number,
    role: string,
): void {
    db.prepare(
        "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    ).run(id, sessionId, timeCreated, timeCreated, JSON.stringify({ role }));
}

function makePending(overrides: Partial<PendingCompactionMarker> = {}): PendingCompactionMarker {
    return {
        ordinal: 10,
        endMessageId: "msg-boundary",
        publishedAt: Date.now(),
        ...overrides,
    };
}

function insertCompartment(
    db: ReturnType<typeof openDatabase>,
    sessionId: string,
    ordinal: number,
    endMessageId: string,
): void {
    appendCompartments(db, sessionId, [
        {
            sequence: 0,
            startMessage: 1,
            endMessage: ordinal,
            startMessageId: `msg-${1}`,
            endMessageId,
            title: "test compartment",
            content: "test content",
        },
    ]);
}

function serializeAnthropicWireWithAdjacentAssistantMerge(messages: MessageLike[]): string {
    const merged: MessageLike[] = [];
    for (const message of messages) {
        const previous = merged.at(-1);
        if (previous?.info.role === "assistant" && message.info.role === "assistant") {
            previous.parts.push(...message.parts);
        } else {
            merged.push(structuredClone(message));
        }
    }
    return JSON.stringify(
        merged.map((message) => ({ role: message.info.role, content: message.parts })),
    );
}

function markerServeWire(
    db: Database,
    sessionId: string,
    state: PersistedCompactionMarkerState,
): string {
    const messages = [
        {
            info: { role: "user", sessionID: sessionId, syntheticHead: true },
            parts: [{ type: "text", text: "m0", synthetic: true }],
        },
        {
            info: { role: "user", sessionID: sessionId, syntheticHead: true },
            parts: [{ type: "text", text: "m1", synthetic: true }],
        },
        {
            info: { id: "tail-assistant", role: "assistant", sessionID: sessionId },
            parts: [
                {
                    type: "tool_use",
                    id: "toolu-tail",
                    name: "read",
                    input: { path: "README.md" },
                },
            ],
        },
    ] as MessageLike[];
    reconcileMarkerRepresentation(messages, state, {
        db,
        sessionId,
        tagger: createTagger(),
        ctxReduceAvailability: { callable: true, frozen: true },
    });
    return serializeAnthropicWireWithAdjacentAssistantMerge(messages);
}

function insertMarkerRows(
    db: Database,
    sessionId: string,
    state: PersistedCompactionMarkerState,
): void {
    db.prepare(
        "INSERT OR IGNORE INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, 1, 1, ?)",
    ).run(
        state.summaryMessageId,
        sessionId,
        JSON.stringify({
            role: "assistant",
            parentID: state.boundaryMessageId,
            summary: true,
            finish: "stop",
            providerID: "magic-context",
            modelID: "magic-context",
        }),
    );
    db.prepare(
        "INSERT OR IGNORE INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, 1, 1, ?)",
    ).run(
        state.compactionPartId,
        state.boundaryMessageId,
        sessionId,
        '{"type":"compaction","auto":true}',
    );
    db.prepare(
        "INSERT OR IGNORE INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, 1, 1, ?)",
    ).run(
        state.summaryPartId,
        state.summaryMessageId,
        sessionId,
        JSON.stringify({ type: "text", text: MARKER_SUMMARY_TEXT }),
    );
}

afterEach(() => {
    closeCompactionMarkerConnection();
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            // Ignore EBUSY on Windows
        }
    }
    tempDirs.length = 0;
});

describe("applyDeferredCompactionMarker — outcomes", () => {
    async function checkRetainedPartial() {
        const home = useTempDataHome("r2-retained-partial-");
        const sid = "ses-r2-retained";
        const oc = createOpenCodeDb(home);
        insertUserMessage(oc, "turn-user", sid, 7);
        insertMessage(oc, "partial", sid, 8, "assistant");
        oc.prepare("INSERT INTO part VALUES ('partial-p','partial',?,8,8,?)").run(
            sid,
            JSON.stringify({ type: "text", text: "covered then UNCOVERED_SUFFIX" }),
        );
        insertMessage(oc, "real-gap", sid, 9, "assistant");
        insertUserMessage(oc, "next-start", sid, 10);
        insertUserMessage(oc, "target", sid, 20);
        const db = openDatabase();
        appendCompartments(db, sid, [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 8,
                startMessageId: "older",
                endMessageId: "partial",
                endBlockIndex: 0,
                title: "partial",
                content: "covered",
            },
        ]);
        db.prepare("INSERT INTO session_meta(session_id) VALUES (?)").run(sid);
        expect(
            await applyDeferredCompactionMarker(
                db,
                sid,
                makePending({ ordinal: 8, endMessageId: "partial" }),
                home,
            ),
        ).toEqual({ kind: "applied", markerOrdinal: 8 });
        expect(getPersistedCompactionMarkerState(db, sid)?.boundaryMessageId).toBe("turn-user");
        appendCompartments(db, sid, [
            {
                sequence: 1,
                startMessage: 10,
                endMessage: 20,
                startMessageId: "next-start",
                endMessageId: "target",
                endBlockIndex: 0,
                title: "later",
                content: "later",
            },
        ]);
        oc.close();
        expect(
            await applyDeferredCompactionMarker(
                db,
                sid,
                makePending({ ordinal: 20, endMessageId: "target" }),
                home,
            ),
        ).toEqual({ kind: "stale-skip", reason: "partial-message-boundary" });
    }
    it(
        "r2 proof: a retained partial at the prior target ordinal still vetoes the next cut",
        checkRetainedPartial,
    );
    it("does not let already-cut indexed ends behind the current marker veto an advance", async () => {
        const dataHome = useTempDataHome("marker-old-gap-");
        const oc = createOpenCodeDb(dataHome);
        insertMessage(oc, "gone-end", "ses-old-gap", 8, "assistant");
        insertUserMessage(oc, "current", "ses-old-gap", 10);
        insertUserMessage(oc, "target", "ses-old-gap", 20);
        const db = openDatabase();
        appendCompartments(db, "ses-old-gap", [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 8,
                startMessageId: "gone",
                endMessageId: "gone-end",
                endBlockIndex: 0,
                title: "old",
                content: "old",
            },
            {
                sequence: 1,
                startMessage: 11,
                endMessage: 20,
                startMessageId: "next",
                endMessageId: "target",
                endBlockIndex: 0,
                title: "new",
                content: "new",
            },
        ]);
        const marker = {
            boundaryOrdinal: 10,
            boundaryMessageId: "current",
            targetEndMessageId: "current",
            summaryMessageId: "old-summary",
            summaryPartId: "old-summary-part",
            compactionPartId: "old-compaction",
        };
        insertMarkerRows(oc, "ses-old-gap", marker);
        setPersistedCompactionMarkerState(db, "ses-old-gap", marker);
        oc.close();
        expect(
            await applyDeferredCompactionMarker(
                db,
                "ses-old-gap",
                makePending({ ordinal: 20, endMessageId: "target" }),
                dataHome,
            ),
        ).toEqual({ kind: "applied", markerOrdinal: 20 });
    });

    it("unknown canonical order of an older endpoint stays protected rather than trusting its target ordinal", async () => {
        const home = useTempDataHome("marker-unknown-old-order-");
        const sid = "ses-unknown-old-order";
        const oc = createOpenCodeDb(home);
        insertUserMessage(oc, "old-user", sid, 10);
        insertUserMessage(oc, "target", sid, 20);
        const db = openDatabase();
        appendCompartments(db, sid, [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 8,
                startMessageId: "old-start",
                endMessageId: "absent-end",
                endBlockIndex: 0,
                title: "old",
                content: "old",
            },
            {
                sequence: 1,
                startMessage: 11,
                endMessage: 20,
                startMessageId: "next",
                endMessageId: "target",
                title: "new",
                content: "new",
            },
        ]);
        const state = {
            boundaryMessageId: "old-user",
            boundaryOrdinal: 10,
            targetEndMessageId: "old-user",
            summaryMessageId: "old-summary",
            summaryPartId: "old-summary-part",
            compactionPartId: "old-compaction",
        };
        insertMarkerRows(oc, sid, state);
        setPersistedCompactionMarkerState(db, sid, state);
        oc.close();
        expect(
            await applyDeferredCompactionMarker(
                db,
                sid,
                makePending({ ordinal: 20, endMessageId: "target" }),
                home,
            ),
        ).toEqual({ kind: "stale-skip", reason: "partial-message-boundary" });
        expect(getPersistedCompactionMarkerState(db, sid)?.boundaryMessageId).toBe("old-user");
    });

    it("sparse certificates and retained partial turns survive newly eligible cuts", async () => {
        // Read-only context.db coordinates, 2026-10-05: three gaps are already
        // behind marker 121728. No raw OpenCode store or live content is copied.
        const gaps = [
            [1589, 111638, 111640],
            [1640, 114784, 114786],
            [1746, 121167, 121169],
            [1786, 122829, 122831],
            [1795, 123463, 123465],
            [1799, 123686, 123689],
            [1843, 126147, 126150],
        ] as const;
        for (const gapFlag of [true, false, "true", null, undefined]) {
            closeDatabase();
            closeCompactionMarkerConnection();
            const dataHome = useTempDataHome("marker-alf-sparse-");
            const oc = createOpenCodeDb(dataHome);
            const db = openDatabase();
            const sessionId = "ses-alf-shape";
            insertUserMessage(oc, "current", sessionId, 121728);
            insertUserMessage(oc, "target", sessionId, 134815);
            const marker = {
                boundaryOrdinal: 121728,
                boundaryMessageId: "current",
                targetEndMessageId: "current",
                summaryMessageId: "old-summary",
                summaryPartId: "old-summary-part",
                compactionPartId: "old-compaction",
            };
            insertMarkerRows(oc, sessionId, marker);
            setPersistedCompactionMarkerState(db, sessionId, marker);
            for (const [sequence, end, next] of gaps) {
                appendCompartments(db, sessionId, [
                    {
                        sequence,
                        startMessage: end - 1,
                        endMessage: end,
                        startMessageId: `start-${end}`,
                        endMessageId: `end-${end}`,
                        endBlockIndex: 0,
                        title: "left",
                        content: "left",
                    },
                    {
                        sequence: sequence + 1,
                        startMessage: next,
                        endMessage: next,
                        startMessageId: `next-${next}`,
                        endMessageId: `next-${next}`,
                        title: "right",
                        content: "right",
                    },
                ]);
                // A native cut filters these older rows from input; it does not
                // erase them from raw storage. Keep canonical proof of their order.
                insertMessage(oc, `end-${end}`, sessionId, end, "assistant");
                oc.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
                    `covered-${end}`,
                    `end-${end}`,
                    sessionId,
                    end,
                    end,
                    '{"type":"text","text":"covered whole message"}',
                );
                insertUserMessage(oc, `next-${next}`, sessionId, next);
                for (let ordinal = end + 1; ordinal < next; ordinal++) {
                    const id = `notice-${ordinal}`;
                    insertUserMessage(oc, id, sessionId, ordinal);
                    oc.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
                        `part-${ordinal}`,
                        id,
                        sessionId,
                        ordinal,
                        ordinal,
                        JSON.stringify({
                            type: "text",
                            text: "background task notice",
                            synthetic: ordinal === 123687 ? gapFlag : true,
                        }),
                    );
                }
            }
            appendCompartments(db, sessionId, [
                {
                    sequence: 2029,
                    startMessage: 134800,
                    endMessage: 134815,
                    startMessageId: "latest-start",
                    endMessageId: "target",
                    endBlockIndex: 0,
                    title: "latest",
                    content: "latest",
                },
            ]);
            oc.close();
            const outcome = await applyDeferredCompactionMarker(
                db,
                sessionId,
                makePending({ ordinal: 134815, endMessageId: "target" }),
                dataHome,
                { rowVersion: 1, ordinal: 134815, endMessageId: "target" },
            );
            expect(outcome).toEqual(
                gapFlag !== true
                    ? { kind: "stale-skip", reason: "partial-message-boundary" }
                    : { kind: "applied", markerOrdinal: 134815 },
            );
            expect(getPersistedCompactionMarkerState(db, sessionId)?.boundaryOrdinal).toBe(
                gapFlag !== true ? 121728 : 134815,
            );
        }
        await checkRetainedPartial();
    });
    it("advances past an indexed end covered by the next ordinal", async () => {
        const dataHome = useTempDataHome("partial-adjacent-marker-");
        const opencodeDb = createOpenCodeDb(dataHome);
        insertUserMessage(opencodeDb, "msg-boundary", "ses-partial-adjacent", 1_000);
        insertUserMessage(opencodeDb, "msg-next", "ses-partial-adjacent", 2_000);
        closeQuietly(opencodeDb);
        const db = openDatabase();
        insertCompartment(db, "ses-partial-adjacent", 10, "msg-boundary");
        db.prepare(
            "UPDATE compartments SET end_block_index=0 WHERE session_id='ses-partial-adjacent'",
        ).run();
        appendCompartments(db, "ses-partial-adjacent", [
            {
                sequence: 1,
                startMessage: 11,
                endMessage: 11,
                startMessageId: "msg-next",
                endMessageId: "msg-next",
                title: "next",
                content: "next",
            },
        ]);
        db.prepare("INSERT INTO session_meta(session_id) VALUES ('ses-partial-adjacent')").run();
        const outcome = await applyDeferredCompactionMarker(
            db,
            "ses-partial-adjacent",
            makePending({ ordinal: 11, endMessageId: "msg-next" }),
            dataHome,
        );
        expect(outcome).toEqual({ kind: "applied", markerOrdinal: 11 });
        expect(
            getPersistedCompactionMarkerState(db, "ses-partial-adjacent")?.boundaryMessageId,
        ).toBe("msg-next");
    });

    it("keeps a partial published end and its tool turn raw with and without a Rust fence", async () => {
        const dataHome = useTempDataHome("partial-block-marker-");
        const opencodeDb = createOpenCodeDb(dataHome);
        insertUserMessage(opencodeDb, "msg-user", "ses-partial", 1_000);
        insertMessage(opencodeDb, "msg-boundary", "ses-partial", 1_001, "assistant");
        closeQuietly(opencodeDb);
        const db = openDatabase();
        insertCompartment(db, "ses-partial", 10, "msg-boundary");
        db.prepare(
            "UPDATE compartments SET end_block_index=0 WHERE session_id='ses-partial'",
        ).run();
        db.prepare("INSERT INTO session_meta(session_id) VALUES ('ses-partial')").run();
        for (const trusted of [
            undefined,
            { ordinal: 10, endMessageId: "msg-boundary", rowVersion: 1 },
        ]) {
            const outcome = await applyDeferredCompactionMarker(
                db,
                "ses-partial",
                makePending(),
                dataHome,
                trusted,
            );
            expect(["applied", "already-current"]).toContain(outcome.kind);
            expect(getPersistedCompactionMarkerState(db, "ses-partial")?.boundaryMessageId).toBe(
                "msg-user",
            );
        }
    });

    it("still blocks an older indexed end with an uncovered remainder before the user cut", async () => {
        const dataHome = useTempDataHome("partial-gap-marker-");
        const opencodeDb = createOpenCodeDb(dataHome);
        insertUserMessage(opencodeDb, "msg-user", "ses-gap", 1_000);
        insertMessage(opencodeDb, "msg-partial", "ses-gap", 1_001, "assistant");
        // A real present message at the skipped coordinate, not merely a hole
        // in the ordinal integers. Empty/retired holes are legitimate for Rust.
        insertUserMessage(opencodeDb, "msg-real-gap", "ses-gap", 1_500);
        insertUserMessage(opencodeDb, "msg-boundary", "ses-gap", 2_000);
        closeQuietly(opencodeDb);
        const db = openDatabase();
        insertCompartment(db, "ses-gap", 8, "msg-partial");
        db.prepare("UPDATE compartments SET end_block_index=0 WHERE session_id='ses-gap'").run();
        appendCompartments(db, "ses-gap", [
            {
                sequence: 1,
                startMessage: 10,
                endMessage: 10,
                startMessageId: "msg-boundary",
                endMessageId: "msg-boundary",
                title: "gap",
                content: "gap",
            },
        ]);
        db.prepare("INSERT INTO session_meta(session_id) VALUES ('ses-gap')").run();
        expect(
            await applyDeferredCompactionMarker(db, "ses-gap", makePending(), dataHome, {
                ordinal: 10,
                endMessageId: "msg-boundary",
                rowVersion: 1,
            }),
        ).toEqual({ kind: "stale-skip", reason: "partial-message-boundary" });
        expect(await updateCompactionMarkerAfterPublication(db, "ses-gap", 10, dataHome)).toBe(
            false,
        );
        expect(getPersistedCompactionMarkerState(db, "ses-gap")).toBeNull();
    });
    it("returns `applied` on the happy path (no existing marker)", async () => {
        const dataHome = useTempDataHome("apply-deferred-applied-");
        const opencodeDb = createOpenCodeDb(dataHome);
        insertUserMessage(opencodeDb, "msg-boundary", "ses-1", 1_000);
        closeQuietly(opencodeDb);

        const db = openDatabase();
        insertCompartment(db, "ses-1", 10, "msg-boundary");
        // Seed session_meta row so the manager can write boundary state into it.
        db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run("ses-1");

        const outcome = await applyDeferredCompactionMarker(db, "ses-1", makePending(), dataHome);

        expect(outcome.kind).toBe("applied");
        if (outcome.kind === "applied") {
            expect(outcome.markerOrdinal).toBe(10);
        }
        // Persisted marker state should now hold the new boundary.
        const persisted = getPersistedCompactionMarkerState(db, "ses-1");
        expect(persisted).not.toBeNull();
        expect(persisted?.boundaryOrdinal).toBe(10);
    });

    it("retries a post-insert state failure without minting duplicate marker rows", async () => {
        const dataHome = useTempDataHome("apply-deferred-post-insert-retry-");
        const opencodeDb = createOpenCodeDb(dataHome);
        insertUserMessage(opencodeDb, "msg-boundary", "ses-retry", 1_000);
        closeQuietly(opencodeDb);

        const db = openDatabase();
        insertCompartment(db, "ses-retry", 10, "msg-boundary");
        db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run("ses-retry");
        db.exec(`CREATE TRIGGER fail_marker_state_persist
        BEFORE UPDATE OF compaction_marker_state ON session_meta
        WHEN NEW.compaction_marker_state <> '' AND json_extract(NEW.compaction_marker_state, '$.pending') IS NULL
        BEGIN
            SELECT RAISE(ABORT, 'simulated marker state persist failure');
        END`);

        const first = await applyDeferredCompactionMarker(db, "ses-retry", makePending(), dataHome);
        expect(first.kind).toBe("retryable-failure");
        expect(first).toMatchObject({ cut: "uncertain" });

        const inspectAfterCrash = new Database(join(dataHome, "opencode", "opencode.db"));
        const firstSummaryIds = inspectAfterCrash
            .prepare(
                "SELECT id FROM message WHERE session_id = ? AND json_extract(data, '$.summary') = 1 ORDER BY id",
            )
            .all("ses-retry") as Array<{ id: string }>;
        expect(firstSummaryIds).toHaveLength(1);
        expect(firstSummaryIds[0]?.id).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
        closeQuietly(inspectAfterCrash);

        db.exec("DROP TRIGGER fail_marker_state_persist");
        const retry = await applyDeferredCompactionMarker(db, "ses-retry", makePending(), dataHome);
        expect(retry.kind).toBe("applied");

        const inspectAfterRetry = new Database(join(dataHome, "opencode", "opencode.db"));
        const summaryIds = inspectAfterRetry
            .prepare(
                "SELECT id FROM message WHERE session_id = ? AND json_extract(data, '$.summary') = 1 ORDER BY id",
            )
            .all("ses-retry") as Array<{ id: string }>;
        const compactionParts = inspectAfterRetry
            .prepare(
                "SELECT id FROM part WHERE session_id = ? AND message_id = ? AND json_extract(data, '$.type') = 'compaction' ORDER BY id",
            )
            .all("ses-retry", "msg-boundary") as Array<{ id: string }>;
        expect(summaryIds.map((row) => row.id)).toEqual(firstSummaryIds.map((row) => row.id));
        expect(compactionParts).toHaveLength(1);
        const retryState = getPersistedCompactionMarkerState(db, "ses-retry");
        expect(retryState?.summaryMessageId).toBe(firstSummaryIds[0]?.id);

        insertUserMessage(inspectAfterRetry, "clean-boundary", "ses-clean", 2_000);
        closeQuietly(inspectAfterRetry);
        insertCompartment(db, "ses-clean", 10, "clean-boundary");
        db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run("ses-clean");
        const clean = await applyDeferredCompactionMarker(
            db,
            "ses-clean",
            makePending({ endMessageId: "clean-boundary" }),
            dataHome,
        );
        expect(clean.kind).toBe("applied");
        const cleanState = getPersistedCompactionMarkerState(db, "ses-clean");
        if (!retryState || !cleanState) throw new Error("expected both marker states");
        expect(markerServeWire(db, "ses-retry", retryState)).toBe(
            markerServeWire(db, "ses-clean", cleanState),
        );
    });

    it("returns `already-current` when persisted boundary >= pending ordinal", async () => {
        const dataHome = useTempDataHome("apply-deferred-current-");
        const opencodeDb = createOpenCodeDb(dataHome);
        insertUserMessage(opencodeDb, "msg-boundary", "ses-1", 1_000);
        closeQuietly(opencodeDb);

        const db = openDatabase();
        insertCompartment(db, "ses-1", 10, "msg-boundary");
        db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run("ses-1");
        // Persist an existing marker AT the pending ordinal.
        setPersistedCompactionMarkerState(db, "ses-1", {
            boundaryMessageId: "msg-boundary",
            summaryMessageId: "msg-summary",
            compactionPartId: "prt-comp",
            summaryPartId: "prt-summary",
            boundaryOrdinal: 10,
            targetEndMessageId: "msg-boundary",
        });

        const outcome = await applyDeferredCompactionMarker(
            db,
            "ses-1",
            makePending({ ordinal: 10 }),
            dataHome,
        );

        expect(outcome.kind).toBe("already-current");
        // Persisted state untouched (no remove/re-inject)
        const persisted = getPersistedCompactionMarkerState(db, "ses-1");
        expect(persisted?.boundaryMessageId).toBe("msg-boundary");
    });

    it("returns `stale-skip / compartment-removed` when raw OpenCode message is gone", async () => {
        const dataHome = useTempDataHome("apply-deferred-msg-gone-");
        const opencodeDb = createOpenCodeDb(dataHome);
        // Intentionally do NOT insert msg-boundary — simulates revert/cleanup
        closeQuietly(opencodeDb);

        const db = openDatabase();
        insertCompartment(db, "ses-1", 10, "msg-boundary");
        db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run("ses-1");

        const outcome = await applyDeferredCompactionMarker(db, "ses-1", makePending(), dataHome);

        expect(outcome.kind).toBe("stale-skip");
        if (outcome.kind === "stale-skip") {
            expect(outcome.reason).toBe("compartment-removed");
        }
    });

    it("returns `stale-skip / compartment-removed` when local compartment row is gone", async () => {
        const dataHome = useTempDataHome("apply-deferred-compart-gone-");
        const opencodeDb = createOpenCodeDb(dataHome);
        insertUserMessage(opencodeDb, "msg-boundary", "ses-1", 1_000);
        closeQuietly(opencodeDb);

        const db = openDatabase();
        // No compartment inserted — simulates a recomp that wiped local state
        db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run("ses-1");

        const outcome = await applyDeferredCompactionMarker(db, "ses-1", makePending(), dataHome);

        expect(outcome.kind).toBe("stale-skip");
        if (outcome.kind === "stale-skip") {
            expect(outcome.reason).toBe("compartment-removed");
        }
    });

    it("returns `stale-skip / target-superseded` when compartment ordinal advanced past pending", async () => {
        const dataHome = useTempDataHome("apply-deferred-superseded-");
        const opencodeDb = createOpenCodeDb(dataHome);
        insertUserMessage(opencodeDb, "msg-boundary", "ses-1", 1_000);
        closeQuietly(opencodeDb);

        const db = openDatabase();
        // Compartment ends at endMessageId "msg-boundary" but at ordinal 20
        // (different from the pending blob's ordinal of 10). This simulates
        // a later partial-recomp resequencing the same boundary message id
        // to a different ordinal.
        insertCompartment(db, "ses-1", 20, "msg-boundary");
        db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run("ses-1");

        const outcome = await applyDeferredCompactionMarker(
            db,
            "ses-1",
            makePending({ ordinal: 10 }),
            dataHome,
        );

        expect(outcome.kind).toBe("stale-skip");
        if (outcome.kind === "stale-skip") {
            expect(outcome.reason).toBe("target-superseded");
        }
    });

    it("returns `retryable-failure` when injectCompactionMarker cannot find a boundary message", async () => {
        // Trigger this by giving the validator a compartment that points to a
        // raw msg with NO user role / no time_created < boundary — but with
        // the boundary message itself missing AFTER validation. Easier path:
        // insert msg-boundary so validation passes, then close+reopen OC DB
        // with WAL handles in a state that makes findBoundaryUserMessage fail.
        //
        // Concretely: the simplest reproducer is a session row in OpenCode
        // with the boundary message but no preceding user messages — the
        // marker injector needs a user message AT or BEFORE the boundary to
        // anchor the compaction part. We insert only the boundary as a
        // non-user message (assistant role) so findBoundaryUserMessage
        // returns null and inject returns null, mapping to retryable-failure.
        const dataHome = useTempDataHome("apply-deferred-retryable-");
        const opencodeDb = createOpenCodeDb(dataHome);
        // Insert msg-boundary as an ASSISTANT message — passes validation
        // (getOpenCodeMessageById only checks existence) but the marker
        // injector requires a user-role boundary anchor, so inject returns null.
        opencodeDb
            .prepare(
                "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
            )
            .run("msg-boundary", "ses-1", 1_000, 1_000, JSON.stringify({ role: "assistant" }));
        closeQuietly(opencodeDb);

        const db = openDatabase();
        insertCompartment(db, "ses-1", 10, "msg-boundary");
        db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run("ses-1");

        const outcome = await applyDeferredCompactionMarker(db, "ses-1", makePending(), dataHome);

        // No user message exists at or before the boundary → inject returns
        // null → retryable-failure.
        expect(outcome.kind).toBe("retryable-failure");
        // Persisted state remains absent ( we never wrote a marker)
        const persisted = getPersistedCompactionMarkerState(db, "ses-1");
        expect(persisted).toBeNull();
    });

    it("returns `retryable-failure` on raw OpenCode DB access errors", async () => {
        // Don't create the opencode dir at all — this makes the writable
        // OpenCode DB handle fail to open, which throws inside
        // getOpenCodeMessageById and trips the outer try/catch.
        const dataHome = createTestTempDirFromPath(join(tmpdir(), "apply-deferred-db-err-"));
        tempDirs.push(dataHome);
        process.env.XDG_DATA_HOME = dataHome;
        mkdirSync(join(dataHome, "cortexkit", "magic-context"), { recursive: true });
        // No opencode/ subdir created.

        const db = openDatabase();
        insertCompartment(db, "ses-1", 10, "msg-boundary");
        db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run("ses-1");

        const outcome = await applyDeferredCompactionMarker(db, "ses-1", makePending(), dataHome);

        expect(outcome.kind).toBe("retryable-failure");
    });

    it("preserves an existing marker when the new target has no user boundary", async () => {
        const dataHome = useTempDataHome("apply-deferred-no-boundary-preserve-");
        const opencodeDb = createOpenCodeDb(dataHome);
        insertMessage(opencodeDb, "msg-boundary", "ses-1", 1_000, "assistant");
        const oldState: PersistedCompactionMarkerState = {
            boundaryMessageId: "msg-old-missing-boundary",
            summaryMessageId: "msg-old-summary",
            compactionPartId: "prt-old-compaction",
            summaryPartId: "prt-old-summary",
            boundaryOrdinal: 5,
            targetEndMessageId: "msg-old-target",
        };
        insertMarkerRows(opencodeDb, "ses-1", oldState);
        closeQuietly(opencodeDb);

        const db = openDatabase();
        insertCompartment(db, "ses-1", 10, "msg-boundary");
        setPersistedCompactionMarkerState(db, "ses-1", oldState);

        const outcome = await applyDeferredCompactionMarker(db, "ses-1", makePending(), dataHome);

        expect(outcome.kind).toBe("retryable-failure");
        expect(getPersistedCompactionMarkerState(db, "ses-1")?.summaryMessageId).toBe(
            "msg-old-summary",
        );
    });

    it("keeps the old marker when BEGIN IMMEDIATE cannot acquire the host-store lock", async () => {
        const dataHome = useTempDataHome("apply-deferred-atomic-lock-");
        const opencodeDb = createOpenCodeDb(dataHome);
        insertUserMessage(opencodeDb, "msg-old-boundary", "ses-lock", 500);
        insertUserMessage(opencodeDb, "msg-boundary", "ses-lock", 1_000);
        const oldState: PersistedCompactionMarkerState = {
            boundaryMessageId: "msg-old-boundary",
            summaryMessageId: "msg-old-summary",
            compactionPartId: "prt-old-compaction",
            summaryPartId: "prt-old-summary",
            boundaryOrdinal: 5,
            targetEndMessageId: "msg-old-boundary",
        };
        insertMarkerRows(opencodeDb, "ses-lock", oldState);
        closeQuietly(opencodeDb);

        const db = openDatabase();
        insertCompartment(db, "ses-lock", 10, "msg-boundary");
        db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run("ses-lock");
        setPersistedCompactionMarkerState(db, "ses-lock", oldState);

        const locker = new Database(join(dataHome, "opencode", "opencode.db"));
        locker.exec("BEGIN IMMEDIATE");
        const logged = spyOn(logger, "log").mockImplementation(() => {});
        try {
            const startedAt = Date.now();
            const outcome = await applyDeferredCompactionMarker(
                db,
                "ses-lock",
                makePending(),
                dataHome,
            );
            expect(outcome.kind).toBe("retryable-failure");
            expect(outcome).toMatchObject({ cut: "definitely-no-cut" });
            // Marker publication is retryable; a busy host must not stall the
            // consuming pass for the old five-second native timeout.
            expect(Date.now() - startedAt).toBeLessThan(1000);
            expect(
                logged.mock.calls.some(([message]) =>
                    /sqlite writer site=compaction-marker-replace .*acquire_ms=\d+ hold_ms=0 .*outcome=not_acquired/.test(
                        String(message),
                    ),
                ),
            ).toBe(true);
        } finally {
            logged.mockRestore();
            locker.exec("ROLLBACK");
            closeQuietly(locker);
        }

        const inspect = new Database(join(dataHome, "opencode", "opencode.db"));
        expect(
            inspect
                .prepare("SELECT COUNT(*) AS n FROM message WHERE id = ?")
                .get(oldState.summaryMessageId),
        ).toEqual({ n: 1 });
        expect(
            inspect
                .prepare("SELECT COUNT(*) AS n FROM part WHERE id IN (?, ?)")
                .get(oldState.compactionPartId, oldState.summaryPartId),
        ).toEqual({ n: 2 });
        closeQuietly(inspect);
        expect(getPersistedCompactionMarkerState(db, "ses-lock")).toEqual(oldState);
        // Releasing the competing writer allows the unchanged request to heal
        // on the next pass, rather than losing the marker publication.
        expect(
            (await applyDeferredCompactionMarker(db, "ses-lock", makePending(), dataHome)).kind,
        ).toBe("applied");
        expect(getPersistedCompactionMarkerState(db, "ses-lock")?.boundaryOrdinal).toBe(10);
    }, 10_000);

    it("rolls direct publication replacement back when insertion fails", async () => {
        const dataHome = useTempDataHome("direct-marker-atomic-rollback-");
        const opencodeDb = createOpenCodeDb(dataHome);
        insertUserMessage(opencodeDb, "msg-old-boundary", "ses-direct", 500);
        insertUserMessage(opencodeDb, "msg-boundary", "ses-direct", 1_000);
        const oldState: PersistedCompactionMarkerState = {
            boundaryMessageId: "msg-old-boundary",
            summaryMessageId: "msg-old-summary",
            compactionPartId: "prt-old-compaction",
            summaryPartId: "prt-old-summary",
            boundaryOrdinal: 5,
            targetEndMessageId: "msg-old-boundary",
        };
        insertMarkerRows(opencodeDb, "ses-direct", oldState);
        opencodeDb.exec(`CREATE TRIGGER reject_new_marker BEFORE INSERT ON message
        WHEN NEW.id <> 'msg-old-summary'
        BEGIN SELECT RAISE(ABORT, 'simulated insert failure'); END`);
        closeQuietly(opencodeDb);

        const db = openDatabase();
        insertCompartment(db, "ses-direct", 10, "msg-boundary");
        db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run("ses-direct");
        setPersistedCompactionMarkerState(db, "ses-direct", oldState);

        expect(await updateCompactionMarkerAfterPublication(db, "ses-direct", 10, dataHome)).toBe(
            false,
        );
        const inspect = new Database(join(dataHome, "opencode", "opencode.db"));
        expect(
            inspect
                .prepare("SELECT COUNT(*) AS n FROM message WHERE id = ?")
                .get(oldState.summaryMessageId),
        ).toEqual({ n: 1 });
        expect(
            inspect
                .prepare("SELECT COUNT(*) AS n FROM part WHERE id IN (?, ?)")
                .get(oldState.compactionPartId, oldState.summaryPartId),
        ).toEqual({ n: 2 });
        closeQuietly(inspect);
        expect(getPersistedCompactionMarkerState(db, "ses-direct")).toEqual(oldState);
    });

    it("repairs an equal-ordinal marker whose boundary is after the target endMessageId", async () => {
        const dataHome = useTempDataHome("apply-deferred-repair-overextended-");
        const opencodeDb = createOpenCodeDb(dataHome);
        insertUserMessage(opencodeDb, "msg_009_prior_user", "ses-1", 900);
        insertMessage(opencodeDb, "msg_010_target", "ses-1", 1_000, "assistant");
        insertUserMessage(opencodeDb, "msg_020_after_user", "ses-1", 2_000);
        const corruptState: PersistedCompactionMarkerState = {
            boundaryMessageId: "msg_020_after_user",
            summaryMessageId: "msg-corrupt-summary",
            compactionPartId: "prt-corrupt-compaction",
            summaryPartId: "prt-corrupt-summary",
            boundaryOrdinal: 10,
            targetEndMessageId: null,
        };
        insertMarkerRows(opencodeDb, "ses-1", corruptState);
        closeQuietly(opencodeDb);

        const db = openDatabase();
        insertCompartment(db, "ses-1", 10, "msg_010_target");
        setPersistedCompactionMarkerState(db, "ses-1", corruptState);

        const outcome = await applyDeferredCompactionMarker(
            db,
            "ses-1",
            makePending({ endMessageId: "msg_010_target" }),
            dataHome,
        );

        expect(outcome.kind).toBe("applied");
        const repaired = getPersistedCompactionMarkerState(db, "ses-1");
        expect(repaired?.boundaryMessageId).toBe("msg_009_prior_user");
        expect(repaired?.targetEndMessageId).toBe("msg_010_target");
    });

    it("direct publication path resolves the compartment endMessageId instead of ordinal", async () => {
        const dataHome = useTempDataHome("direct-marker-end-id-");
        const opencodeDb = createOpenCodeDb(dataHome);
        insertUserMessage(opencodeDb, "msg_001_deleted_user", "ses-1", 100);
        insertMessage(opencodeDb, "msg_002_deleted_assistant", "ses-1", 200, "assistant");
        insertUserMessage(opencodeDb, "msg_003_prior_user", "ses-1", 300);
        insertMessage(opencodeDb, "msg_004_target", "ses-1", 400, "assistant");
        insertUserMessage(opencodeDb, "msg_005_after_user", "ses-1", 500);
        opencodeDb
            .prepare(
                "DELETE FROM message WHERE id IN ('msg_001_deleted_user', 'msg_002_deleted_assistant')",
            )
            .run();
        closeQuietly(opencodeDb);

        const db = openDatabase();
        insertCompartment(db, "ses-1", 4, "msg_004_target");
        db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run("ses-1");

        expect(await updateCompactionMarkerAfterPublication(db, "ses-1", 4, dataHome)).toBe(true);

        const persisted = getPersistedCompactionMarkerState(db, "ses-1");
        expect(persisted?.boundaryMessageId).toBe("msg_003_prior_user");
        expect(persisted?.boundaryOrdinal).toBe(4);
        expect(persisted?.targetEndMessageId).toBe("msg_004_target");
    });

    it("no-ops (success) on the pi harness without touching opencode.db", async () => {
        // Pi reaches this function through the recompilation runners both
        // harnesses share. On a Pi-only install there is no opencode.db (often
        // not even its parent directory), and the pre-fix behavior was an
        // `unable to open database file` throw that turned a fully successful
        // recompilation into a "Failed" report. The gate must return success
        // without any opencode.db access.
        const dataHome = useTempDataHome("pi-harness-no-oc-db-");
        rmSync(join(dataHome, "opencode"), { recursive: true, force: true });

        const db = openDatabase();
        insertCompartment(db, "ses-pi", 4, "msg_004_target");
        db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run("ses-pi");

        setHarness("pi");
        try {
            expect(await updateCompactionMarkerAfterPublication(db, "ses-pi", 4, dataHome)).toBe(
                true,
            );
        } finally {
            _resetHarnessForTesting();
        }
        // No opencode.db file may be created as a side effect (an empty file
        // here would make every later query fail with `no such table`).
        expect(existsSync(join(dataHome, "opencode", "opencode.db"))).toBe(false);
    });

    it("fails loud without creating a junk opencode.db when the file is missing on opencode", async () => {
        // Defense-in-depth: even if an OpenCode-harness call somehow runs with
        // opencode.db missing, the open must throw a diagnosable error instead
        // of creating an empty database and failing later with `no such table`.
        const dataHome = useTempDataHome("oc-harness-missing-db-");
        rmSync(join(dataHome, "opencode"), { recursive: true, force: true });
        mkdirSync(join(dataHome, "opencode"), { recursive: true });

        const db = openDatabase();
        insertCompartment(db, "ses-2", 4, "msg_004_target");
        db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run("ses-2");

        expect(() => updateOriginal(db, "ses-2", 4, dataHome)).toThrow(
            /OpenCode database not found/,
        );
        expect(existsSync(join(dataHome, "opencode", "opencode.db"))).toBe(false);
    });
});

describe("recoverable two-store marker publication", () => {
    function fixture() {
        const home = useTempDataHome("marker-publication-recovery-");
        const sid = "ses-recovery";
        const oc = createOpenCodeDb(home);
        insertUserMessage(oc, "first", sid, 1_000);
        insertUserMessage(oc, "second", sid, 2_000);
        const db = openDatabase();
        appendCompartments(db, sid, [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 10,
                startMessageId: "first",
                endMessageId: "first",
                title: "first",
                content: "first",
            },
            {
                sequence: 1,
                startMessage: 11,
                endMessage: 20,
                startMessageId: "second",
                endMessageId: "second",
                title: "second",
                content: "second",
            },
        ]);
        db.prepare("INSERT INTO session_meta(session_id) VALUES (?)").run(sid);
        return { home, sid, oc, db };
    }
    function markerJson(db: Database, sid: string): string {
        return (
            db
                .prepare(
                    "SELECT compaction_marker_state AS state FROM session_meta WHERE session_id = ?",
                )
                .get(sid) as { state: string }
        ).state;
    }
    function hostRows(oc: Database) {
        return {
            messages: oc.prepare("SELECT * FROM message ORDER BY id").all(),
            parts: oc.prepare("SELECT * FROM part ORDER BY id").all(),
        };
    }
    function pairCount(oc: Database): number {
        return (
            oc
                .prepare(
                    "SELECT COUNT(*) AS n FROM message WHERE json_extract(data, '$.summary') = 1",
                )
                .get() as { n: number }
        ).n;
    }
    function failFinalization(db: Database) {
        db.exec(`CREATE TRIGGER fail_finalization BEFORE UPDATE OF compaction_marker_state ON session_meta
            WHEN json_extract(NEW.compaction_marker_state, '$.pending') IS NULL
            BEGIN SELECT RAISE(ABORT, 'injected post-host state write failure'); END`);
    }
    function forbidHostWrites(oc: Database) {
        for (const table of ["message", "part"])
            for (const operation of ["INSERT", "UPDATE", "DELETE"])
                oc.exec(`CREATE TRIGGER forbid_${table}_${operation} BEFORE ${operation} ON ${table}
                BEGIN SELECT RAISE(ABORT, 'adoption must not write host rows'); END`);
    }
    const first = makePending({ endMessageId: "first" });
    const second = makePending({ ordinal: 20, endMessageId: "second" });

    it("review witness: a cold defer must not delete the committed pending pair as a fork orphan", async () => {
        const { home, sid, oc, db } = fixture();
        try {
            expect((await applyDeferredCompactionMarker(db, sid, first, home)).kind).toBe(
                "applied",
            );
            failFinalization(db);
            expect(await applyDeferredCompactionMarker(db, sid, second, home)).toMatchObject({
                kind: "retryable-failure",
                cut: "uncertain",
            });
            db.exec("DROP TRIGGER fail_finalization");
            const pending = markerJson(db, sid);
            const before = hostRows(oc);
            expect(pairCount(oc)).toBe(1);
            db.prepare(`UPDATE session_meta SET cached_m0_bytes = ?, cached_m1_bytes = ?,
                cached_m0_last_baseline_end_message_id = 'first' WHERE session_id = ?`).run(
                Buffer.from("<session-history>frozen baseline</session-history>"),
                Buffer.from("<session-history>frozen delta</session-history>"),
                sid,
            );
            // The host's newer cut hides the frozen baseline boundary after a restart.
            clearInjectionCache(sid);
            const messages = [
                {
                    info: { id: "tail", role: "user", sessionID: sid },
                    parts: [{ type: "text", text: "retained tail" }],
                },
            ] as MessageLike[];
            prepareCompartmentInjection(db, sid, messages, false, [], home);
            expect(markerJson(db, sid)).toBe(pending);
            expect(hostRows(oc)).toEqual(before);
        } finally {
            clearInjectionCache(sid);
            closeQuietly(oc);
        }
    });

    it("review witness: a superseded target must not certify no cut while a committed intent is unfinalized", async () => {
        const { home, sid, oc, db } = fixture();
        try {
            failFinalization(db);
            expect(await applyDeferredCompactionMarker(db, sid, first, home)).toMatchObject({
                kind: "retryable-failure",
                cut: "uncertain",
            });
            db.exec("DROP TRIGGER fail_finalization");
            const pending = markerJson(db, sid);
            // Deleting the target compartment does not revert the host cut.
            db.prepare(
                "DELETE FROM compartments WHERE session_id = ? AND end_message_id = 'first'",
            ).run(sid);
            const outcome = await applyDeferredCompactionMarker(db, sid, first, home);
            expect(pairCount(oc)).toBe(1);
            expect(markerJson(db, sid)).toBe(pending);
            expect(markerUpdateDefinitelyDidNotCut(outcome)).toBe(false);
            expect(outcome).toMatchObject({ kind: "retryable-failure", cut: "uncertain" });
        } finally {
            closeQuietly(oc);
        }
    });

    it("review witness: a host revert after intent but before commit must not permanently block an older valid frontier", async () => {
        const { home, sid, oc, db } = fixture();
        try {
            oc.exec(`CREATE TRIGGER interrupt_host BEFORE INSERT ON message
                BEGIN SELECT RAISE(ABORT, 'interrupted before host commit'); END`);
            expect((await applyDeferredCompactionMarker(db, sid, second, home)).kind).toBe(
                "retryable-failure",
            );
            expect(JSON.parse(markerJson(db, sid)).pending.targetEndMessageId).toBe("second");
            expect(pairCount(oc)).toBe(0);
            oc.exec("DROP TRIGGER interrupt_host");
            oc.prepare("DELETE FROM message WHERE id = 'second'").run();
            db.prepare(
                "DELETE FROM compartments WHERE session_id = ? AND end_message_id = 'second'",
            ).run(sid);
            expect((await applyDeferredCompactionMarker(db, sid, first, home)).kind).toBe(
                "applied",
            );
            expect(pairCount(oc)).toBe(1);
            expect(JSON.parse(markerJson(db, sid)).pending).toBeUndefined();
        } finally {
            closeQuietly(oc);
        }
    });

    it("review control: startup is read-only and a failed tag drop rolls finalization back before one successful retry", async () => {
        const { home, sid, oc, db } = fixture();
        try {
            expect((await applyDeferredCompactionMarker(db, sid, first, home)).kind).toBe(
                "applied",
            );
            const old = getPersistedCompactionMarkerState(db, sid)!;
            insertTag(db, sid, `${old.summaryMessageId}:p0`, "message", 100, 1);
            db.exec(`CREATE TRIGGER fail_tag_drop BEFORE UPDATE OF status ON tags
                WHEN NEW.status = 'dropped'
                BEGIN SELECT RAISE(ABORT, 'interrupted tag drop'); END`);
            expect(await applyDeferredCompactionMarker(db, sid, second, home)).toMatchObject({
                kind: "retryable-failure",
                cut: "uncertain",
            });
            expect(getPersistedCompactionMarkerState(db, sid)).toEqual(old);
            expect(getTagById(db, sid, 1)?.status).toBe("active");
            const pending = markerJson(db, sid);
            const before = hostRows(oc);
            checkCompactionMarkerConsistency(db);
            expect(markerJson(db, sid)).toBe(pending);
            expect(hostRows(oc)).toEqual(before);
            db.exec("DROP TRIGGER fail_tag_drop");
            db.exec(`CREATE TABLE review_tag_drops (n INTEGER);
                CREATE TRIGGER count_tag_drop AFTER UPDATE OF status ON tags
                WHEN NEW.status = 'dropped'
                BEGIN INSERT INTO review_tag_drops VALUES (1); END`);
            expect((await applyDeferredCompactionMarker(db, sid, second, home)).kind).toBe(
                "applied",
            );
            expect((await applyDeferredCompactionMarker(db, sid, second, home)).kind).toBe(
                "already-current",
            );
            expect(db.prepare("SELECT count(*) AS n FROM review_tag_drops").get()).toEqual({
                n: 1,
            });
            expect(getTagById(db, sid, 1)?.status).toBe("dropped");
            expect(hostRows(oc)).toEqual(before);
        } finally {
            closeQuietly(oc);
        }
    });

    it("adopts a post-commit state-write failure before advancing to the next fold, leaving one pair", async () => {
        const { home, sid, oc, db } = fixture();
        const logged = spyOn(logger, "sessionLog");
        try {
            failFinalization(db);
            expect(await applyDeferredCompactionMarker(db, sid, first, home)).toMatchObject({
                kind: "retryable-failure",
                cut: "uncertain",
            });
            expect(pairCount(oc)).toBe(1);
            expect(getPersistedCompactionMarkerState(db, sid)).toBeNull();
            db.exec("DROP TRIGGER fail_finalization");
            expect((await applyDeferredCompactionMarker(db, sid, second, home)).kind).toBe(
                "applied",
            );
            expect(pairCount(oc)).toBe(1);
            expect(
                oc
                    .prepare(
                        "SELECT COUNT(*) AS n FROM part WHERE json_extract(data, '$.type') = 'compaction'",
                    )
                    .get(),
            ).toEqual({ n: 1 });
            expect(getPersistedCompactionMarkerState(db, sid)?.targetEndMessageId).toBe("second");
            expect(JSON.parse(markerJson(db, sid)).pending).toBeUndefined();
            const outcomes = logged.mock.calls.filter(([, text]) =>
                String(text).startsWith("compaction-marker publication reason="),
            );
            expect(outcomes).toHaveLength(2);
            expect(outcomes[0][1]).toContain("reason=state-write-failed");
            expect(outcomes[1][1]).toContain("reason=pending-intent-recovered");
        } finally {
            logged.mockRestore();
            closeQuietly(oc);
        }
    });

    for (const committed of [false, true])
        it(`restart recovers pending intent with host commit=${committed}`, async () => {
            const { home, sid, oc, db } = fixture();
            if (committed) failFinalization(db);
            else
                oc.exec(`CREATE TRIGGER interrupt_host BEFORE INSERT ON message
            BEGIN SELECT RAISE(ABORT, 'interrupted before host commit'); END`);
            expect((await applyDeferredCompactionMarker(db, sid, first, home)).kind).toBe(
                "retryable-failure",
            );
            const pending = JSON.parse(markerJson(db, sid)).pending;
            expect(pending).toMatchObject({
                boundaryMessageId: "first",
                targetEndMessageId: "first",
                boundaryOrdinal: 10,
            });
            expect(getPersistedCompactionMarkerState(db, sid)).toBeNull();
            expect(pairCount(oc)).toBe(committed ? 1 : 0);
            if (committed) {
                db.exec("DROP TRIGGER fail_finalization");
                forbidHostWrites(oc);
            } else oc.exec("DROP TRIGGER interrupt_host");
            const before = hostRows(oc);
            closeCompactionMarkerConnection();
            closeDatabase();
            const restarted = openDatabase();
            expect((await applyDeferredCompactionMarker(restarted, sid, first, home)).kind).toBe(
                "applied",
            );
            expect(getPersistedCompactionMarkerState(restarted, sid)?.summaryMessageId).toBe(
                pending.summaryMessageId,
            );
            expect(JSON.parse(markerJson(restarted, sid)).pending).toBeUndefined();
            expect(pairCount(oc)).toBe(1);
            if (committed) expect(hostRows(oc)).toEqual(before);
            closeQuietly(oc);
        });

    it("keeps a recovered host cut uncertain when adoption finalization fails again", async () => {
        const { home, sid, oc, db } = fixture();
        failFinalization(db);
        expect(await applyDeferredCompactionMarker(db, sid, first, home)).toMatchObject({
            kind: "retryable-failure",
            cut: "uncertain",
        });
        const pending = markerJson(db, sid);
        const before = hostRows(oc);
        forbidHostWrites(oc);
        closeCompactionMarkerConnection();
        closeDatabase();
        const restarted = openDatabase();
        expect(await applyDeferredCompactionMarker(restarted, sid, first, home)).toMatchObject({
            kind: "retryable-failure",
            cut: "uncertain",
        });
        expect(markerJson(restarted, sid)).toBe(pending);
        expect(getPersistedCompactionMarkerState(restarted, sid)).toBeNull();
        expect(hostRows(oc)).toEqual(before);
        restarted.exec("DROP TRIGGER fail_finalization");
        expect((await applyDeferredCompactionMarker(restarted, sid, first, home)).kind).toBe(
            "applied",
        );
        expect(pairCount(oc)).toBe(1);
        expect(hostRows(oc)).toEqual(before);
        closeQuietly(oc);
    });

    it("keeps a pending host commit uncertain when its recovery cannot acquire the host lock", async () => {
        const { home, sid, oc, db } = fixture();
        failFinalization(db);
        expect((await applyDeferredCompactionMarker(db, sid, first, home)).kind).toBe(
            "retryable-failure",
        );
        const before = hostRows(oc);
        oc.exec("BEGIN IMMEDIATE");
        try {
            expect(await applyDeferredCompactionMarker(db, sid, first, home)).toMatchObject({
                kind: "retryable-failure",
                cut: "uncertain",
            });
            expect(hostRows(oc)).toEqual(before);
        } finally {
            oc.exec("ROLLBACK");
            closeQuietly(oc);
        }
    });

    it("adopts a unique deterministic pair with missing state without changing any host bytes", async () => {
        const { home, sid, oc, db } = fixture();
        expect((await applyDeferredCompactionMarker(db, sid, first, home)).kind).toBe("applied");
        const state = getPersistedCompactionMarkerState(db, sid);
        db.prepare(
            "UPDATE session_meta SET compaction_marker_state = '', compaction_marker_target_end_message_id = NULL WHERE session_id = ?",
        ).run(sid);
        const before = hostRows(oc);
        forbidHostWrites(oc);
        const logged = spyOn(logger, "sessionLog");
        try {
            expect(await updateCompactionMarkerAfterPublication(db, sid, 10, home)).toBe(true);
            expect(getPersistedCompactionMarkerState(db, sid)).toEqual(state);
            expect(hostRows(oc)).toEqual(before);
            expect(
                logged.mock.calls.some(([, text]) =>
                    String(text).includes("reason=adopted-existing-pair"),
                ),
            ).toBe(true);
        } finally {
            logged.mockRestore();
            closeQuietly(oc);
        }
    });

    it("leaves two candidate pairs untouched and logs ambiguity", async () => {
        const { home, sid, oc, db } = fixture();
        for (const target of [first, second]) {
            expect(await prepareCompactionMarkerCandidates(sid)).toBe(true);
            expect(
                injectCompactionMarker({
                    sessionId: sid,
                    endOrdinal: target.ordinal,
                    endMessageId: target.endMessageId,
                    directory: home,
                    summaryText: MARKER_SUMMARY_TEXT,
                }),
            ).not.toBeNull();
        }
        expect(pairCount(oc)).toBe(2);
        const before = hostRows(oc);
        const logged = spyOn(logger, "sessionLog");
        try {
            expect(await applyDeferredCompactionMarker(db, sid, second, home)).toMatchObject({
                kind: "retryable-failure",
                cut: "definitely-no-cut",
            });
            expect(hostRows(oc)).toEqual(before);
            expect(markerJson(db, sid)).toBe("");
            expect(
                logged.mock.calls.filter(([, text]) =>
                    String(text).includes("reason=ambiguous-left-alone"),
                ),
            ).toHaveLength(1);
        } finally {
            logged.mockRestore();
            closeQuietly(oc);
        }
    });

    it("does not touch the host when staging intent fails", async () => {
        const { home, sid, oc, db } = fixture();
        db.exec(`CREATE TRIGGER fail_intent BEFORE UPDATE OF compaction_marker_state ON session_meta
            BEGIN SELECT RAISE(ABORT, 'intent write failed'); END`);
        const before = hostRows(oc);
        expect(await applyDeferredCompactionMarker(db, sid, first, home)).toMatchObject({
            kind: "retryable-failure",
            cut: "definitely-no-cut",
        });
        expect(hostRows(oc)).toEqual(before);
        expect(markerJson(db, sid)).toBe("");
        closeQuietly(oc);
    });

    it("does not certify an unchanged host window when pending recovery is ambiguous", async () => {
        const { home, sid, oc, db } = fixture();
        failFinalization(db);
        expect((await applyDeferredCompactionMarker(db, sid, first, home)).kind).toBe(
            "retryable-failure",
        );
        db.exec("DROP TRIGGER fail_finalization");
        expect(await prepareCompactionMarkerCandidates(sid)).toBe(true);
        expect(
            injectCompactionMarker({
                sessionId: sid,
                endOrdinal: second.ordinal,
                endMessageId: second.endMessageId,
                directory: home,
                summaryText: MARKER_SUMMARY_TEXT,
            }),
        ).not.toBeNull();
        const before = hostRows(oc);
        const pending = markerJson(db, sid);
        expect(await applyDeferredCompactionMarker(db, sid, first, home)).toMatchObject({
            kind: "retryable-failure",
            cut: "uncertain",
        });
        expect(hostRows(oc)).toEqual(before);
        expect(markerJson(db, sid)).toBe(pending);
        expect(getPersistedCompactionMarkerState(db, sid)).toBeNull();
        closeQuietly(oc);
    });

    for (const corruption of ["native", "error", "text", "tail-start", "foreign-part"])
        it(`never adopts or deletes an unverified ${corruption} pair`, async () => {
            const { home, sid, oc, db } = fixture();
            expect((await applyDeferredCompactionMarker(db, sid, first, home)).kind).toBe(
                "applied",
            );
            const state = getPersistedCompactionMarkerState(db, sid)!;
            if (corruption === "native")
                oc.prepare(
                    "UPDATE message SET data = json_set(data, '$.providerID', 'anthropic') WHERE id = ?",
                ).run(state.summaryMessageId);
            if (corruption === "error")
                oc.prepare(
                    "UPDATE message SET data = json_set(data, '$.error', json('{\"name\":\"failed\"}')) WHERE id = ?",
                ).run(state.summaryMessageId);
            if (corruption === "text")
                oc.prepare(
                    "UPDATE part SET data = json_set(data, '$.text', 'not the MC placeholder') WHERE id = ?",
                ).run(state.summaryPartId);
            if (corruption === "tail-start")
                oc.prepare(
                    "UPDATE part SET data = json_set(data, '$.tail_start_id', 'second') WHERE id = ?",
                ).run(state.compactionPartId);
            if (corruption === "foreign-part")
                oc.prepare("UPDATE part SET session_id = 'another-session' WHERE id = ?").run(
                    state.summaryPartId,
                );
            db.prepare(
                "UPDATE session_meta SET compaction_marker_state = '', compaction_marker_target_end_message_id = NULL WHERE session_id = ?",
            ).run(sid);
            const before = hostRows(oc);
            expect(await updateCompactionMarkerAfterPublication(db, sid, 10, home)).toBe(false);
            expect(hostRows(oc)).toEqual(before);
            expect(markerJson(db, sid)).toBe("");
            closeQuietly(oc);
        });

    it("defer passes replay identical bytes and leave pending recovery for an admitted rebuild", async () => {
        const { home, sid, oc, db } = fixture();
        expect((await applyDeferredCompactionMarker(db, sid, first, home)).kind).toBe("applied");
        failFinalization(db);
        expect((await applyDeferredCompactionMarker(db, sid, second, home)).kind).toBe(
            "retryable-failure",
        );
        db.exec("DROP TRIGGER fail_finalization");
        setPendingCompactionMarkerState(db, sid, second);
        const source = [
            {
                info: { role: "user", sessionID: sid, syntheticHead: true },
                parts: [
                    {
                        type: "text",
                        text: "<session-history>stable</session-history>",
                        synthetic: true,
                    },
                ],
            },
            {
                info: { id: "tail", role: "user", sessionID: sid },
                parts: [{ type: "text", text: "retained tail" }],
            },
        ] as MessageLike[];
        const serve = (rebuild: boolean, admitted = true) => {
            const messages = structuredClone(source);
            runRustModePostprocess({
                db,
                sessionId: sid,
                messages,
                sessionDirectory: home,
                cacheBustingPass: rebuild,
                markerAdmissionProven: admitted,
                consumedBoundary: { rowVersion: 2, ordinal: 20, endMessageId: "second" },
                fullFeatureMode: true,
                tagger: createTagger(),
                ctxReduceAvailability: { callable: false, frozen: true },
            });
            return JSON.stringify(messages);
        };
        const pending = markerJson(db, sid);
        const before = hostRows(oc);
        const deferredBytes = serve(false);
        expect(serve(false)).toBe(deferredBytes);
        expect(serve(true, false)).toBe(deferredBytes);
        expect(markerJson(db, sid)).toBe(pending);
        expect(hostRows(oc)).toEqual(before);
        expect(await prepareCompactionMarkerCandidates(sid)).toBe(true);
        forbidHostWrites(oc);
        const recoveredBytes = serve(true);
        expect(getPersistedCompactionMarkerState(db, sid)?.targetEndMessageId).toBe("second");
        expect(serve(false)).toBe(recoveredBytes);
        expect(hostRows(oc)).toEqual(before);
        closeQuietly(oc);
    });
});

describe("assistant-ended marker seam geometry", () => {
    it("selects exactly the rows between the required user marker and trim boundary", async () => {
        const dataHome = useTempDataHome("assistant-ended-marker-seam-");
        const sessionId = "ses-assistant-ended-marker-seam";
        const opencodeDb = createOpenCodeDb(dataHome);
        insertMessage(opencodeDb, "older-assistant", sessionId, 1_000, "assistant");
        insertMessage(opencodeDb, "marker-user", sessionId, 2_000, "user");
        insertMessage(opencodeDb, "seam-assistant-a", sessionId, 3_000, "assistant");
        insertMessage(opencodeDb, "seam-assistant-b", sessionId, 4_000, "assistant");
        insertMessage(opencodeDb, "assistant-end", sessionId, 5_000, "assistant");
        insertMessage(opencodeDb, "retained-user", sessionId, 6_000, "user");
        closeQuietly(opencodeDb);

        const db = openDatabase();
        insertCompartment(db, sessionId, 5, "assistant-end");
        const messages = [
            { info: { id: "older-assistant", role: "assistant", sessionID: sessionId }, parts: [] },
            { info: { id: "marker-user", role: "user", sessionID: sessionId }, parts: [] },
            {
                info: { id: "seam-assistant-a", role: "assistant", sessionID: sessionId },
                parts: [],
            },
            {
                info: { id: "seam-assistant-b", role: "assistant", sessionID: sessionId },
                parts: [],
            },
            { info: { id: "assistant-end", role: "assistant", sessionID: sessionId }, parts: [] },
            { info: { id: "retained-user", role: "user", sessionID: sessionId }, parts: [] },
        ] as MessageLike[];
        const beforeTrim = [...messages];
        const prepared = prepareCompartmentInjection(db, sessionId, messages, true, []);
        const markerBoundary = findBoundaryUserMessage(sessionId, "assistant-end");

        // OpenCode filterCompacted requires the marker part on a user row, so the
        // nearest user at-or-before an assistant compartment end is the boundary.
        expect(markerBoundary?.id).toBe("marker-user");
        const markerOrdinal = beforeTrim.findIndex(
            (message) => message.info.id === markerBoundary?.id,
        );
        const trimOrdinal = beforeTrim.findIndex(
            (message) => message.info.id === prepared?.compartmentEndMessageId,
        );
        expect(markerOrdinal).toBeLessThan(trimOrdinal);
        const rowsBetween = beforeTrim
            .slice(markerOrdinal + 1, trimOrdinal + 1)
            .map((message) => message.info.id);
        expect(rowsBetween).toEqual(["seam-assistant-a", "seam-assistant-b", "assistant-end"]);
        expect(
            selectHiddenMessagesAtCompactionSeam(
                beforeTrim,
                prepared?.skippedVisibleMessages ?? 0,
            ).map((message) => message.info.id),
        ).toEqual(rowsBetween);
    });
});
