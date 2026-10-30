/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";

import type { RawMessage } from "../../hooks/magic-context/read-session-raw";
import { BOOT_QUIET_MS, setBootQuietPeriodForTests } from "../../plugin/boot-quiet";
import * as logger from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    getDirtyIndexFloor,
    getLastIndexedOrdinal,
    indexMessagesAfterOrdinal,
} from "./message-index";
import {
    __resetMessageIndexAsyncForTests,
    clearSessionTracking,
    getMessageIndexQueueHeapStats,
    isSessionReconciled,
    scheduleClearAndReindex,
    scheduleIncrementalIndex,
    scheduleReconciliation,
} from "./message-index-async";
import { initializeDatabase } from "./storage-db";

function createTestDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    return db;
}

function message(
    id: string,
    ordinal: number,
    text: string,
    version: string | number | null = null,
): RawMessage {
    return {
        id,
        ordinal,
        role: "user",
        parts: text.length > 0 ? [{ type: "text", text }] : [],
        version,
    };
}

function pagedReader(
    messages: RawMessage[],
    onPage?: (afterOrdinal: number) => void,
): ((sessionId: string) => RawMessage[]) & {
    getCount: (sessionId: string) => number;
    readPage: (
        sessionId: string,
        afterOrdinal: number,
        limit: number,
        finalWatermark: number,
    ) => RawMessage[];
} {
    return Object.assign((_sessionId: string) => messages, {
        getCount: (_sessionId: string) => messages.length,
        readPage: (
            _sessionId: string,
            afterOrdinal: number,
            limit: number,
            finalWatermark: number,
        ) => {
            onPage?.(afterOrdinal);
            return messages
                .filter((entry) => entry.ordinal > afterOrdinal && entry.ordinal <= finalWatermark)
                .slice(0, limit);
        },
    });
}

async function waitForCondition(condition: () => boolean, ceilingMs = 10_000): Promise<void> {
    const start = Date.now();
    while (!condition()) {
        if (Date.now() - start > ceilingMs) {
            throw new Error("waitForCondition ceiling exceeded");
        }
        await wait(10);
    }
}

function wait(ms = 0): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error("timed out waiting for async message indexing");
        await wait(10);
    }
}

function countRows(db: Database, sessionId: string): number {
    const row = db
        .prepare("SELECT COUNT(*) AS count FROM message_history_fts WHERE session_id = ?")
        .get(sessionId) as { count?: number } | null;
    return typeof row?.count === "number" ? row.count : 0;
}

function countMessageRows(db: Database, sessionId: string, messageId: string): number {
    const row = db
        .prepare(
            "SELECT COUNT(*) AS count FROM message_history_fts WHERE session_id = ? AND message_id = ?",
        )
        .get(sessionId, messageId) as { count?: number } | null;
    return typeof row?.count === "number" ? row.count : 0;
}

function searchMessageIds(db: Database, sessionId: string, ftsQuery: string): string[] {
    return (
        db
            .prepare(
                "SELECT message_id FROM message_history_fts WHERE session_id = ? AND message_history_fts MATCH ? ORDER BY bm25(message_history_fts), CAST(message_ordinal AS INTEGER) ASC",
            )
            .all(sessionId, ftsQuery) as Array<{ message_id: string }>
    ).map((row) => row.message_id);
}

describe("message-index-async", () => {
    let db: Database;

    beforeEach(() => {
        setBootQuietPeriodForTests(null);
        __resetMessageIndexAsyncForTests();
        db = createTestDb();
    });

    afterEach(() => {
        setBootQuietPeriodForTests(null);
        closeQuietly(db);
        __resetMessageIndexAsyncForTests();
    });

    it("dedupes concurrent reconciliation schedules for one session", async () => {
        const messages = [message("m-1", 1, "alpha")];
        let reads = 0;

        scheduleReconciliation(db, "ses-async", () => {
            reads++;
            return messages;
        });
        scheduleReconciliation(db, "ses-async", () => {
            reads++;
            return messages;
        });

        // Poll for completion instead of a fixed wall-clock wait: the async
        // reconciler's scheduling latency is unbounded under CI load, while the
        // property under test (two schedules dedupe to ONE read) is load-independent
        // once the work has actually run.
        await waitForCondition(() => isSessionReconciled("ses-async"));

        expect(reads).toBe(1);
        expect(countRows(db, "ses-async")).toBe(1);
        expect(isSessionReconciled("ses-async")).toBe(true);
    });

    it("does not double-insert when incremental indexing overlaps reconciliation", async () => {
        const messages = [message("m-1", 1, "alpha overlap")];
        scheduleReconciliation(db, "ses-overlap", () => messages);
        scheduleIncrementalIndex(db, "ses-overlap", "m-1", () => messages[0] ?? null);

        await waitForCondition(() => countMessageRows(db, "ses-overlap", "m-1") >= 1);
        // Settle briefly so a late double-insert would still be caught before the
        // uniqueness assertion (the defect direction is MORE rows, not fewer).
        await wait(40);

        expect(countMessageRows(db, "ses-overlap", "m-1")).toBe(1);
    });

    it("replays the same source revision without replacing its FTS row", async () => {
        const converted = message("m-direct", 1, "direct source", 1);
        scheduleIncrementalIndex(db, "ses-watermark", converted.id, converted);
        await wait(140);
        const before = db
            .prepare(
                "SELECT rowid FROM message_history_fts WHERE session_id = ? AND message_id = ?",
            )
            .get("ses-watermark", converted.id) as { rowid: number };

        scheduleIncrementalIndex(db, "ses-watermark", converted.id, () => converted);
        await wait(140);

        const after = db
            .prepare(
                "SELECT rowid FROM message_history_fts WHERE session_id = ? AND message_id = ?",
            )
            .get("ses-watermark", converted.id) as { rowid: number };
        expect(after.rowid).toBe(before.rowid);
        expect(countMessageRows(db, "ses-watermark", converted.id)).toBe(1);
    });

    it("re-indexes a terminal same-ID edit", async () => {
        const original = message("m-edit", 1, "original searchable bytes", 1);
        scheduleReconciliation(db, "ses-edit", () => [original]);
        await wait(20);

        const edited = message("m-edit", 1, "replacement searchable bytes", 2);
        scheduleIncrementalIndex(db, "ses-edit", edited.id, edited);
        await wait(140);

        expect(searchMessageIds(db, "ses-edit", "original")).toEqual([]);
        expect(searchMessageIds(db, "ses-edit", "replacement")).toEqual(["m-edit"]);
        expect(countMessageRows(db, "ses-edit", "m-edit")).toBe(1);
    });

    it("deletes the indexed row when a same-ID message is redacted to empty", async () => {
        const original = message("m-redact", 1, "secret redaction target", 1);
        scheduleReconciliation(db, "ses-redact", () => [original]);
        await wait(20);

        const redacted = message("m-redact", 1, "", 2);
        scheduleIncrementalIndex(db, "ses-redact", redacted.id, redacted);
        await wait(140);

        expect(searchMessageIds(db, "ses-redact", "secret")).toEqual([]);
        expect(countMessageRows(db, "ses-redact", "m-redact")).toBe(0);
    });

    it("reconciles a same-ID replacement after its transaction fails", async () => {
        const original = message("m-retry-edit", 1, "stale before retry", 1);
        const edited = message("m-retry-edit", 1, "fresh after retry", 2);
        scheduleReconciliation(db, "ses-retry-edit", () => [original]);
        await waitUntil(() => isSessionReconciled("ses-retry-edit"));

        const originalExec = db.exec.bind(db);
        let failCommit = true;
        (db as unknown as { exec: typeof db.exec }).exec = ((sql: string) => {
            if (failCommit && sql === "COMMIT") {
                failCommit = false;
                throw new Error("synthetic replace commit failure");
            }
            return originalExec(sql);
        }) as typeof db.exec;

        scheduleIncrementalIndex(db, "ses-retry-edit", edited.id, edited);
        // The failed commit records a dirty floor asynchronously; wait for that
        // transition instead of a fixed delay, which loses under CI load.
        await waitUntil(() => getDirtyIndexFloor(db, "ses-retry-edit") === 1);
        expect(getDirtyIndexFloor(db, "ses-retry-edit")).toBe(1);
        expect(searchMessageIds(db, "ses-retry-edit", "stale")).toEqual(["m-retry-edit"]);
        expect(searchMessageIds(db, "ses-retry-edit", "fresh")).toEqual([]);

        (db as unknown as { exec: typeof db.exec }).exec = originalExec;
        scheduleReconciliation(db, "ses-retry-edit", () => [edited]);
        await waitUntil(() => getDirtyIndexFloor(db, "ses-retry-edit") === null);

        expect(getDirtyIndexFloor(db, "ses-retry-edit")).toBeNull();
        expect(searchMessageIds(db, "ses-retry-edit", "stale")).toEqual([]);
        expect(searchMessageIds(db, "ses-retry-edit", "fresh")).toEqual(["m-retry-edit"]);
    });

    it("reconciles a failed incremental hole even after a later incremental success advanced the watermark", async () => {
        const originalPrepare = db.prepare.bind(db);
        let failMessageId: string | null = "m-2";
        (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
            const stmt = originalPrepare(sql);
            if (sql.startsWith("INSERT INTO message_history_fts")) {
                const run = stmt.run.bind(stmt);
                (stmt as unknown as { run: typeof stmt.run }).run = ((...args: unknown[]) => {
                    if (failMessageId !== null && args[2] === failMessageId) {
                        throw new Error("synthetic incremental failure");
                    }
                    return run(...(args as Parameters<typeof stmt.run>));
                }) as typeof stmt.run;
            }
            return stmt;
        }) as typeof db.prepare;

        const fullHistory = [
            message("m-1", 1, "alpha indexed first"),
            message("m-2", 2, "beta hole should come back"),
            message("m-3", 3, "gamma later incremental succeeds"),
        ];
        scheduleReconciliation(db, "ses-hole", () => [fullHistory[0]!]);
        await waitUntil(() => isSessionReconciled("ses-hole"));
        expect(isSessionReconciled("ses-hole")).toBe(true);

        scheduleIncrementalIndex(db, "ses-hole", "m-2", () => fullHistory[1] ?? null);
        await wait(140);
        expect(countMessageRows(db, "ses-hole", "m-2")).toBe(0);
        expect(getDirtyIndexFloor(db, "ses-hole")).toBe(2);
        expect(isSessionReconciled("ses-hole")).toBe(false);

        failMessageId = null;
        scheduleIncrementalIndex(db, "ses-hole", "m-3", () => fullHistory[2] ?? null);
        await wait(140);
        expect(countMessageRows(db, "ses-hole", "m-3")).toBe(0);

        scheduleReconciliation(db, "ses-hole", () => fullHistory);
        await wait(20);

        expect(searchMessageIds(db, "ses-hole", "beta")).toEqual(["m-2"]);
        expect(countMessageRows(db, "ses-hole", "m-3")).toBe(1);
        expect(isSessionReconciled("ses-hole")).toBe(true);
    });

    it("yields to a timer between bounded reconciliation pages", async () => {
        const messages = Array.from({ length: 201 }, (_, index) =>
            message(`m-${index + 1}`, index + 1, `message ${index + 1}`),
        );
        // The product yields between pages with setImmediate, and a zero-delay timer
        // armed during page 1 is not guaranteed to run before page 2 (immediates run
        // ahead of timers whose 1ms has not elapsed). Record the page each callback
        // observed at fire time and assert the timer ran before the LAST page: that is
        // the yield property, and it does not depend on immediate-vs-timer ordering.
        // An assertion inside the reader would abort reconciliation and surface as
        // an unrelated timeout, so the check happens after the run.
        let timerPage: number | null = null;
        let observedBufferBytes = 0;
        let observedBufferMessages = 0;
        let pageCount = 0;
        const reader = pagedReader(messages, () => {
            pageCount += 1;
            if (pageCount === 1) {
                setTimeout(() => {
                    timerPage = pageCount;
                    const stats = getMessageIndexQueueHeapStats();
                    observedBufferBytes = stats.activeBufferBytes;
                    observedBufferMessages = stats.activeBufferMessages;
                }, 0);
            }
        });

        scheduleReconciliation(db, "ses-pages", reader);
        await waitUntil(() => isSessionReconciled("ses-pages"));

        expect(pageCount).toBe(3);
        expect(timerPage).not.toBeNull();
        expect(timerPage as number).toBeLessThan(3);
        expect(observedBufferBytes).toBeGreaterThan(0);
        expect(observedBufferMessages).toBeGreaterThan(0);
        expect(observedBufferMessages).toBeLessThanOrEqual(100);
        expect(getMessageIndexQueueHeapStats().activeBufferBytes).toBe(0);
        expect(countRows(db, "ses-pages")).toBe(201);
        expect(isSessionReconciled("ses-pages")).toBe(true);
    });

    it("clears the reconciliation latch when the pre-write dirty marker fails", async () => {
        const history = [
            message("m-1", 1, "first"),
            message("m-2", 2, "recovered after marker failure"),
        ];
        scheduleReconciliation(db, "ses-marker-failure", () => [history[0]!]);
        await waitUntil(() => isSessionReconciled("ses-marker-failure"));
        expect(isSessionReconciled("ses-marker-failure")).toBe(true);

        const originalPrepare = db.prepare.bind(db);
        (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
            if (
                sql.includes("dirty_floor_ordinal") &&
                sql.includes("CASE WHEN message_history_index.dirty_floor_ordinal")
            ) {
                throw new Error("synthetic dirty marker failure");
            }
            return originalPrepare(sql);
        }) as typeof db.prepare;

        scheduleIncrementalIndex(db, "ses-marker-failure", "m-2", () => history[1] ?? null);
        // The failed marker write must clear the reconciled latch; poll for that
        // transition instead of assuming the async write lands inside a fixed sleep.
        await waitUntil(() => !isSessionReconciled("ses-marker-failure"));
        expect(isSessionReconciled("ses-marker-failure")).toBe(false);
        expect(countMessageRows(db, "ses-marker-failure", "m-2")).toBe(0);

        (db as unknown as { prepare: typeof db.prepare }).prepare = originalPrepare;
        scheduleReconciliation(db, "ses-marker-failure", () => history);
        await waitUntil(() => countMessageRows(db, "ses-marker-failure", "m-2") === 1);
        expect(countMessageRows(db, "ses-marker-failure", "m-2")).toBe(1);
    });

    it("does not advance past out-of-order live events", async () => {
        const history = [
            message("m-1", 1, "first ordinal"),
            message("m-2", 2, "second ordinal"),
            message("m-3", 3, "third ordinal"),
        ];

        scheduleIncrementalIndex(db, "ses-out-of-order", "m-3", history[2]!);
        scheduleIncrementalIndex(db, "ses-out-of-order", "m-1", history[0]!);
        scheduleIncrementalIndex(db, "ses-out-of-order", "m-2", history[1]!);
        await waitUntil(() => countMessageRows(db, "ses-out-of-order", "m-2") === 1);

        expect(countMessageRows(db, "ses-out-of-order", "m-3")).toBe(0);
        scheduleReconciliation(db, "ses-out-of-order", () => history);
        await waitUntil(() => isSessionReconciled("ses-out-of-order"));

        expect(countRows(db, "ses-out-of-order")).toBe(3);
        expect(isSessionReconciled("ses-out-of-order")).toBe(true);
    });

    it("clears and rebuilds after a removed message", async () => {
        const first = [message("m-1", 1, "old"), message("m-2", 2, "keep")];
        scheduleReconciliation(db, "ses-clear", () => first);
        await wait(20);

        const rebuilt = [message("m-2", 1, "keep")];
        scheduleClearAndReindex(db, "ses-clear", () => rebuilt);
        await wait(20);

        expect(countMessageRows(db, "ses-clear", "m-1")).toBe(0);
        expect(countMessageRows(db, "ses-clear", "m-2")).toBe(1);
        expect(isSessionReconciled("ses-clear")).toBe(true);
    });

    it("coalesces a removal burst into one authoritative rebuild", async () => {
        let clears = 0;
        const prepare = db.prepare.bind(db);
        db.prepare = ((sql: string) => {
            const stmt = prepare(sql);
            if (!sql.startsWith("DELETE FROM message_fts_rowid_map")) return stmt;
            return new Proxy(stmt, {
                get(target, property) {
                    const value = Reflect.get(target, property);
                    if (property === "run")
                        return (...args: unknown[]) => {
                            clears++;
                            return Reflect.apply(value, target, args);
                        };
                    return typeof value === "function" ? value.bind(target) : value;
                },
            });
        }) as typeof db.prepare;
        const survivors = [message("survivor", 1, "unchanged searchable bytes")];
        for (let i = 0; i < 8; i++) scheduleClearAndReindex(db, "burst", pagedReader(survivors));
        await waitForCondition(() => isSessionReconciled("burst"));
        expect(clears).toBe(1);
        expect(countMessageRows(db, "burst", "survivor")).toBe(1);
    });

    it("does not restart an obsolete incremental prepare retry after a rebuild", async () => {
        const originalTimeout = globalThis.setTimeout;
        // Shorten only the one-minute preparation retry so the fixture can
        // exercise its queued callback while leaving other timer delays unchanged.
        const timers = spyOn(globalThis, "setTimeout").mockImplementation(((
            handler,
            delay,
            ...args
        ) =>
            originalTimeout(handler, delay === 60_000 ? 30 : delay, ...args)) as typeof setTimeout);
        const sessionId = "prepare-retry-branch";
        let prepares = 0;
        const old = message("abandoned", 2, "abandoned retry bytes");
        const source = Object.assign(() => old, {
            prepare: async () => ++prepares > 1,
        });
        try {
            scheduleIncrementalIndex(db, sessionId, old.id, source);
            await waitUntil(() => prepares === 1);
            scheduleClearAndReindex(db, sessionId, () => [
                message("keep", 1, "legitimate archive"),
                message("replacement", 2, "active branch"),
            ]);
            await waitUntil(() => isSessionReconciled(sessionId));
            await wait(200);
            expect(prepares).toBe(1);
            expect(countMessageRows(db, sessionId, "abandoned")).toBe(0);
            expect(countMessageRows(db, sessionId, "replacement")).toBe(1);
        } finally {
            timers.mockRestore();
        }
    });

    it("rebuilds again when a removal lands during paged reconciliation", async () => {
        let messages = Array.from({ length: 250 }, (_, i) => message(`m-${i}`, i + 1, `text ${i}`));
        let removed = false;
        const reader = Object.assign((_session: string) => messages, {
            getCount: () => messages.length,
            readPage: (_session: string, cursor: number, limit: number) => {
                const page = messages.filter((m) => m.ordinal > cursor).slice(0, limit);
                if (!removed) {
                    removed = true;
                    messages = messages.slice(1).map((m, i) => ({ ...m, ordinal: i + 1 }));
                    scheduleClearAndReindex(db, "during", reader);
                }
                return page;
            },
        });
        scheduleClearAndReindex(db, "during", reader);
        await waitForCondition(
            () => isSessionReconciled("during") && countMessageRows(db, "during", "m-0") === 0,
        );
        expect(countMessageRows(db, "during", "m-249")).toBe(1);
    });

    it("rebuilds when removal overtakes a boot-quiet reconciliation", async () => {
        const sessionId = "ses-boot-clear";
        const surviving = [message("m-survivor", 1, "surviving searchable bytes")];
        let reads = 0;
        const readSurviving = () => {
            reads++;
            return surviving;
        };
        setBootQuietPeriodForTests(Date.now() - BOOT_QUIET_MS + 20);

        scheduleReconciliation(db, sessionId, readSurviving);
        scheduleClearAndReindex(db, sessionId, readSurviving);
        expect(isSessionReconciled(sessionId)).toBe(false);

        // Wait for the observable outcome, not a scheduling order. Both queued
        // callbacks fire after the same boot-quiet deadline and may run in
        // either order, and both interleaves are correct by design:
        //   reconcile -> clear+rebuild: the clear invalidates the finished
        //     reconciliation under the session lock and rebuilds (reads = 2);
        //   clear+rebuild -> reconcile: the rebuild marks the session
        //     reconciled and the stale reconciliation hits the idempotency
        //     guard and skips (reads = 1).
        // Pinning reads === 2 encoded the first order only, so the second
        // (legal) interleave timed out with a perfectly correct index. The
        // contract is the end state: the survivor row is indexed and the
        // session is re-marked reconciled.
        await waitUntil(
            () =>
                isSessionReconciled(sessionId) &&
                countMessageRows(db, sessionId, "m-survivor") === 1,
        );

        expect(reads).toBeGreaterThanOrEqual(1);
        expect(reads).toBeLessThanOrEqual(2);
        expect(countMessageRows(db, sessionId, "m-survivor")).toBe(1);
        expect(isSessionReconciled(sessionId)).toBe(true);
    });

    it("catches indexing errors without propagating", async () => {
        expect(() =>
            scheduleReconciliation(db, "ses-error", () => {
                throw new Error("boom");
            }),
        ).not.toThrow();

        await wait(20);
        expect(isSessionReconciled("ses-error")).toBe(false);
    });

    it("clearSessionTracking releases module state", async () => {
        scheduleReconciliation(db, "ses-track", () => [message("m-1", 1, "alpha")]);
        await waitUntil(() => isSessionReconciled("ses-track"));
        expect(isSessionReconciled("ses-track")).toBe(true);

        clearSessionTracking("ses-track");

        expect(isSessionReconciled("ses-track")).toBe(false);
    });

    it("backfills a stalled durable prefix from its watermark in bounded pages", async () => {
        const messages = Array.from({ length: 305 }, (_, i) => ({
            ...message(`m-${i + 1}`, i + 1, `backfill ${i + 1}`),
            createdAt: i,
        }));
        indexMessagesAfterOrdinal(db, "stalled", messages.slice(0, 2), 0, 2);
        const pages: number[] = [];
        const reader = Object.assign(
            pagedReader(messages, (after) => pages.push(after)),
            {
                getRevision: () => 305,
            },
        );
        scheduleReconciliation(db, "stalled", reader);
        await waitUntil(() => getLastIndexedOrdinal(db, "stalled") === 305);
        expect(pages).toEqual([2, 102, 202, 302]);
        expect(searchMessageIds(db, "stalled", '"backfill 305"')).toEqual(["m-305"]);
    });

    it("catches appends that arrive while a revision-aware reconciliation is queued", async () => {
        const messages = [message("first", 1, "first bytes")];
        let appended = false;
        const reader = Object.assign(
            pagedReader(messages, () => {
                if (!appended) {
                    appended = true;
                    messages.push(message("second", 2, "second bytes"));
                    scheduleReconciliation(db, "coalesced-append", reader);
                }
            }),
            { getRevision: () => messages.length },
        );
        scheduleReconciliation(db, "coalesced-append", reader);
        await waitUntil(() => getLastIndexedOrdinal(db, "coalesced-append") === 2);
        expect(searchMessageIds(db, "coalesced-append", "second")).toEqual(["second"]);
    });

    it("does not spin on a gap after an earlier successful snapshot", async () => {
        let count = 1;
        let pages = 0;
        const reader = {
            getRevision: () => count,
            getCount: () => count,
            readPage: () => {
                pages++;
                return count === 1 ? [{ ...message("first", 1, "first bytes"), createdAt: 1 }] : [];
            },
        };
        scheduleReconciliation(db, "cached-gap", reader);
        await waitUntil(() => getMessageIndexQueueHeapStats().queueLength === 0);
        expect(getLastIndexedOrdinal(db, "cached-gap")).toBe(1);
        count = 2;
        pages = 0;
        scheduleReconciliation(db, "cached-gap", reader);
        await waitUntil(() => getMessageIndexQueueHeapStats().queueLength === 0);
        expect(getLastIndexedOrdinal(db, "cached-gap")).toBe(1);
        expect(pages).toBe(1);
    });

    it.each([
        "reader error",
        "revision error",
        "count error",
        "gap",
    ])("logs a reconciliation %s once per session and retries", async (failure) => {
        const diagnostic = spyOn(logger, "sessionLog").mockImplementation(() => {});
        let broken = true;
        const reader = {
            getRevision: () => {
                if (broken && failure === "revision error")
                    throw new Error("host sequence unavailable");
                return 1;
            },
            getCount: () => 1,
            getCountAfterRevision: () => {
                if (broken && failure === "count error") throw new Error("host count unavailable");
                return 1;
            },
            readPage: () => {
                if (!broken) return [message("recovered", 1, "recovered bytes")];
                if (failure === "reader error") throw new Error("host reader unavailable");
                return [];
            },
        };
        try {
            for (let attempt = 0; attempt < 2; attempt++) {
                scheduleReconciliation(db, "stalled-log", reader);
                await waitUntil(() => getMessageIndexQueueHeapStats().queueLength === 0);
            }
            expect(diagnostic).toHaveBeenCalledTimes(1);
            expect(diagnostic.mock.calls[0]?.[1]).toContain(
                {
                    "reader error": "host reader unavailable",
                    "revision error": "host sequence unavailable",
                    "count error": "host count unavailable",
                    gap: "gap after ordinal 0 (store count 1)",
                }[failure],
            );
            broken = false;
            scheduleReconciliation(db, "stalled-log", reader);
            await waitUntil(() => getLastIndexedOrdinal(db, "stalled-log") === 1);
            expect(diagnostic).toHaveBeenCalledTimes(1);
            expect(searchMessageIds(db, "stalled-log", "recovered")).toEqual(["recovered"]);
        } finally {
            diagnostic.mockRestore();
        }
    });
});
