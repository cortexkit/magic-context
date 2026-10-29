import { runSessionWarmupWorker } from "../../hooks/magic-context/raw-ordinal-warmup";
import type {
    RawMessage,
    RawMessageOrdinalAnchor,
} from "../../hooks/magic-context/read-session-raw";
import { scheduleAfterBootQuiet } from "../../plugin/boot-quiet";
import { getHarness } from "../../shared/harness";
import { log, sessionLog } from "../../shared/logger";
import {
    type Database,
    getSqliteDatabasePath,
    indexCoordinationInput,
    withSqliteBackgroundWriter,
} from "../../shared/sqlite";
import {
    clearIndexedMessages,
    getLastIndexedOrdinal,
    getMessageIndexReconciliationStartOrdinal,
    getMessageIndexSourceIdentity,
    indexMessagesAfterOrdinal,
    indexSingleMessage,
    isMessageIndexReconciledThrough,
    isMessageIndexSourceCurrent,
} from "./message-index";
import type { IndexWorkerMeasurements } from "./message-index-bounded";

// Session teardown prevents queued indexing from starting; workers check cancellation before COMMIT.
const indexCancellations = new Map<string, Set<Int32Array>>();
const sessionEpochs = new Map<string, number>();
const workerMeasurements = new WeakMap<Database, Map<string, IndexWorkerMeasurements>>();
export function getIndexWorkerMeasurements(
    db: Database,
    sessionId: string,
): IndexWorkerMeasurements | undefined {
    return workerMeasurements.get(db)?.get(sessionId);
}

/**
 * Detect SQLite "database is locked" errors so the async indexer can
 * downgrade them to a one-line warning instead of a stack trace.
 *
 * Why we tolerate them: incremental indexing is best-effort. Any BUSY
 * conflict is fully recoverable by the next reconciliation pass (which
 * re-reads `last_indexed_ordinal` and indexes everything missed). A
 * single SQLITE_BUSY here just means another writer (concurrent
 * transform on a different session, dreamer task, second OpenCode
 * instance) held the WAL writer lock past our 5s `busy_timeout`.
 * Throwing turns a normal busy-window into a stack trace in user logs
 * without changing the eventual indexing outcome — reconciliation fills
 * in any missed rows automatically the next time
 * `scheduleReconciliation` runs.
 */
function isDatabaseLockedError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const e = error as { code?: unknown; message?: unknown };
    if (typeof e.code === "string") {
        if (e.code === "SQLITE_BUSY" || e.code === "SQLITE_LOCKED") return true;
    }
    if (typeof e.message === "string") {
        if (/database is locked/i.test(e.message)) return true;
        if (/sqlite_(busy|locked)/i.test(e.message)) return true;
    }
    return false;
}

/**
 * Event-driven message-history FTS indexing.
 *
 * v0.17 removes indexing from the `searchMessages()` hot path. Search now only
 * runs an FTS5 SELECT; writes happen through three asynchronous triggers:
 *
 * 1. Live incremental indexing: terminal `message.updated` events schedule a
 *    single-message read and `indexSingleMessage()` insert/replace. Events are
 *    debounced per message for 100ms and completed revisions are keyed by the
 *    source version plus normalized-content hash.
 * 2. Per-session lazy reconciliation: a transform/hook touch schedules
 *    a catch-up pass. Hosts exposing getRevision also catch up after appends. It resumes from
 *    `message_history_index.last_indexed_ordinal`, rewinds from any recorded
 *    dirty floor left by a failed incremental write, inserts missing rows, and
 *    advances the watermark to `messages.length`.
 * 3. Revert/delete handling: `message.removed` clears all FTS rows + the
 *    watermark and then re-runs reconciliation. Searches during that rebuild
 *    window correctly see no message hits.
 *
 * Concurrency: all writes for one session go through a module-scope async lock
 * (`sessionLocks`). Work for different sessions can run in parallel; work for
 * the same session chains behind the prior Promise, so reconciliation, live
 * inserts, and clear+rebuild cannot double-insert or race the watermark.
 *
 * Watermark semantics: `last_indexed_ordinal` means every message with ordinal
 * <= watermark has been processed (inserted when indexable, skipped otherwise).
 */

const INCREMENTAL_DEBOUNCE_MS = 100;
const RECONCILIATION_BATCH_SIZE = 100;

class MagicContextMessageIndexHeapHolder {
    readonly reconciledSessions = new Set<string>();
    readonly reconciledSnapshots = new Map<
        string,
        {
            revision: number;
            count: number;
            after?: RawMessageOrdinalAnchor;
        }
    >();
    readonly stalledSessions = new Set<string>();
    readonly reconciliationScheduledSessions = new Set<string>();
    readonly clearAndReindexScheduledSessions = new Map<
        string,
        { source: MessageReconciliationSource }
    >();
    readonly sessionLocks = new Map<string, Promise<void>>();
    readonly incrementalTimers = new Map<string, ReturnType<typeof setTimeout>>();
    readonly pendingIncrementalKeys = new Set<string>();
    readonly completedIncrementalKeys = new Set<string>();
    readonly activeReconcilerBuffers = new Map<string, readonly RawMessage[]>();
}

const heapHolder = new MagicContextMessageIndexHeapHolder();

type IncrementalIndexOutcome =
    | { status: "indexed" }
    | { status: "skipped" | "retry scheduled" | "error"; reason: string };

let incrementalIndexSettledForTests:
    | ((sessionId: string, messageId: string, outcome: IncrementalIndexOutcome) => void)
    | undefined;

/** Observe why an indexing attempt settled, including retries, without changing its scheduling. */
export function __setIncrementalIndexSettledForTests(
    listener: typeof incrementalIndexSettledForTests,
): void {
    incrementalIndexSettledForTests = listener;
}

let reconciliationSettledForTests:
    | ((sessionId: string, outcome: "reconciled" | "retry scheduled" | "error") => void)
    | undefined;

/** Observe startup reconciliation after its session lock and writer transactions have settled. */
export function __setReconciliationSettledForTests(
    listener: typeof reconciliationSettledForTests,
): void {
    reconciliationSettledForTests = listener;
}

function clearCompletedIncrementalKeys(sessionId: string): void {
    const prefix = `${sessionId}\u0000`;
    for (const key of heapHolder.completedIncrementalKeys) {
        if (key.startsWith(prefix)) heapHolder.completedIncrementalKeys.delete(key);
    }
}

/**
 * Sources backed by the OpenCode store provide `prepare`, an off-thread warm-up
 * after which their synchronous reads count ordinals without scanning the
 * session. When it resolves false the job retries later instead of reading.
 * Sources without `prepare` are read directly.
 */
type PreparedSource = { prepare?: (sessionId: string) => Promise<boolean> };

interface RevisionedSource {
    /** Append-only host sequence; unchanged sessions need no history count or page read. */
    getRevision?(sessionId: string): number;
    getCountAfterRevision?(sessionId: string, after: number, through: number): number;
}

const PREPARE_RETRY_MS = 60_000;

async function sourceReady(source: unknown, sessionId: string): Promise<boolean> {
    const prepare = (source as PreparedSource | null)?.prepare;
    return typeof prepare === "function" ? prepare(sessionId) : true;
}

type FullReadMessages = ((sessionId: string) => RawMessage[]) & {
    readPage?: (
        sessionId: string,
        afterOrdinal: number,
        limit: number,
        finalWatermark: number,
        after?: RawMessageOrdinalAnchor,
    ) => RawMessage[];
    getCount?: (sessionId: string) => number;
} & PreparedSource &
    RevisionedSource;

export interface BoundedMessageReconciliationSource extends PreparedSource, RevisionedSource {
    readPage(
        sessionId: string,
        afterOrdinal: number,
        limit: number,
        finalWatermark: number,
        after?: RawMessageOrdinalAnchor,
    ): RawMessage[];
    getCount(sessionId: string): number;
}

export type MessageReconciliationSource = FullReadMessages | BoundedMessageReconciliationSource;
type ReadSingleMessage = ((sessionId: string, messageId: string) => RawMessage | null) &
    PreparedSource;
type IncrementalMessageSource = ReadSingleMessage | RawMessage;

function defer(fn: () => void): void {
    const immediate = (globalThis as { setImmediate?: (callback: () => void) => unknown })
        .setImmediate;
    if (typeof immediate === "function") {
        inRootAsyncContext(() => immediate(fn));
        return;
    }
    inRootAsyncContext(() => setTimeout(fn, 0));
}

function yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => defer(resolve));
}

function runWithSessionLock(
    sessionId: string,
    operation: () => Promise<void> | void,
): Promise<void> {
    const previous = heapHolder.sessionLocks.get(sessionId) ?? Promise.resolve();
    const run = previous
        .catch(() => undefined)
        .then(async () => {
            await operation();
        });

    heapHolder.sessionLocks.set(sessionId, run);
    run.finally(() => {
        if (heapHolder.sessionLocks.get(sessionId) === run) {
            heapHolder.sessionLocks.delete(sessionId);
        }
    }).catch(() => undefined);

    return run;
}

function logIndexingError(sessionId: string, action: string, error: unknown): void {
    if (isDatabaseLockedError(error)) {
        // Concise warning, no stack trace. Reconciliation catches up later.
        sessionLog(
            sessionId,
            `message FTS async ${action} skipped (database busy; will retry on next reconciliation)`,
        );
        return;
    }
    sessionLog(
        sessionId,
        `message FTS async ${action} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    log(`[message-index-async] ${action} failed for ${sessionId}:`, error);
}

function serializedMessageBytes(messages: readonly RawMessage[]): number {
    try {
        return Buffer.byteLength(JSON.stringify(messages));
    } catch {
        return 0;
    }
}

function logReconciliationStall(sessionId: string, reason: string): void {
    if (heapHolder.stalledSessions.has(sessionId)) return;
    heapHolder.stalledSessions.add(sessionId);
    sessionLog(sessionId, `message FTS reconciliation stalled: ${reason}; will retry`);
}

async function reconcileSessionIndex(
    db: Database,
    sessionId: string,
    readMessages: MessageReconciliationSource,
): Promise<boolean> {
    // Wait for the warm-up outside the session lock, so live indexing of this
    // session is not held behind it.
    if (!(await sourceReady(readMessages, sessionId))) {
        logReconciliationStall(sessionId, "raw message reader is not ready");
        return false;
    }
    await runWithSessionLock(sessionId, async () => {
        if (!readMessages.getRevision && heapHolder.reconciledSessions.has(sessionId)) return;

        let fallbackSnapshot: RawMessage[] | null = null;
        try {
            const fullReader = typeof readMessages === "function" ? readMessages : null;
            const revision = readMessages.getRevision?.(sessionId);
            const previous = heapHolder.reconciledSnapshots.get(sessionId);
            const finalWatermark =
                previous && revision === previous.revision
                    ? previous.count
                    : revision !== undefined && readMessages.getCountAfterRevision
                      ? previous && revision > previous.revision
                          ? previous.count +
                            readMessages.getCountAfterRevision(
                                sessionId,
                                previous.revision,
                                revision,
                            )
                          : readMessages.getCountAfterRevision(sessionId, -1, revision)
                      : readMessages.getCount
                        ? readMessages.getCount(sessionId)
                        : (fallbackSnapshot = fullReader?.(sessionId) ?? []).length;
            let cursor = getMessageIndexReconciliationStartOrdinal(db, sessionId);
            let after = cursor === previous?.count ? previous.after : undefined;

            while (cursor < finalWatermark) {
                const pageEnd = Math.min(finalWatermark, cursor + RECONCILIATION_BATCH_SIZE);
                const messages = readMessages.readPage
                    ? readMessages.readPage(
                          sessionId,
                          cursor,
                          RECONCILIATION_BATCH_SIZE,
                          finalWatermark,
                          after,
                      )
                    : (fallbackSnapshot ?? []).filter(
                          (message) => message.ordinal > cursor && message.ordinal <= pageEnd,
                      );
                const retainedMessages = fallbackSnapshot ?? messages;
                heapHolder.activeReconcilerBuffers.set(sessionId, retainedMessages);

                withSqliteBackgroundWriter(() =>
                    indexMessagesAfterOrdinal(db, sessionId, messages, cursor, pageEnd),
                );
                const nextCursor = getMessageIndexReconciliationStartOrdinal(db, sessionId);
                if (nextCursor <= cursor) break;
                cursor = nextCursor;
                const last = messages.at(-1);
                // Only seek from a row whose ordinal matches the durable progress.
                // Empty/filtered pages may advance farther than the last hydrated row.
                after =
                    last?.ordinal === cursor && typeof last.createdAt === "number"
                        ? { timeCreated: last.createdAt, id: last.id }
                        : undefined;

                if (cursor < finalWatermark) {
                    // One bounded page is the maximum synchronous work per event-loop
                    // turn. The timer-backed await lets host I/O run before the next
                    // source read and writer transaction.
                    await yieldToEventLoop();
                }
            }

            if (isMessageIndexReconciledThrough(db, sessionId, finalWatermark)) {
                heapHolder.reconciledSessions.add(sessionId);
                if (revision !== undefined) {
                    // A rebase may already cover the entire store. Capture its last
                    // row once so later appends start with a keyset seek, not OFFSET.
                    if (!after && finalWatermark > 0 && readMessages.readPage) {
                        const last = readMessages
                            .readPage(sessionId, finalWatermark - 1, 1, finalWatermark)
                            .at(-1);
                        if (last?.ordinal === finalWatermark && typeof last.createdAt === "number")
                            after = { timeCreated: last.createdAt, id: last.id };
                    }
                    heapHolder.reconciledSnapshots.set(sessionId, {
                        revision,
                        count: finalWatermark,
                        after,
                    });
                }
            } else {
                logReconciliationStall(
                    sessionId,
                    `gap after ordinal ${cursor} (store count ${finalWatermark})`,
                );
            }
        } finally {
            heapHolder.activeReconcilerBuffers.delete(sessionId);
        }
    });
    return true;
}

export function scheduleReconciliation(
    db: Database,
    sessionId: string,
    readMessages: MessageReconciliationSource,
): void {
    if (
        (!readMessages.getRevision && heapHolder.reconciledSessions.has(sessionId)) ||
        heapHolder.reconciliationScheduledSessions.has(sessionId)
    ) {
        return;
    }
    heapHolder.reconciliationScheduledSessions.add(sessionId);

    scheduleAfterBootQuiet(() => {
        defer(() => {
            let appendedDuringReconciliation = false;
            const previousSnapshot = heapHolder.reconciledSnapshots.get(sessionId);
            void reconcileSessionIndex(db, sessionId, readMessages)
                .then((ran) => {
                    reconciliationSettledForTests?.(
                        sessionId,
                        ran ? "reconciled" : "retry scheduled",
                    );
                    if (ran) {
                        const snapshot = heapHolder.reconciledSnapshots.get(sessionId);
                        // A failed catch-up keeps the old snapshot. Wait for another
                        // touch after a gap rather than repeatedly retrying that snapshot.
                        appendedDuringReconciliation =
                            snapshot !== undefined &&
                            snapshot !== previousSnapshot &&
                            readMessages.getRevision !== undefined &&
                            readMessages.getRevision(sessionId) !== snapshot.revision;
                        return;
                    }
                    // The source could not be prepared: try again later.
                    inRootAsyncContext(() =>
                        setTimeout(() => {
                            heapHolder.reconciliationScheduledSessions.delete(sessionId);
                            scheduleReconciliation(db, sessionId, readMessages);
                        }, PREPARE_RETRY_MS),
                    ).unref?.();
                })
                .catch((error) => {
                    reconciliationSettledForTests?.(sessionId, "error");
                    logReconciliationStall(
                        sessionId,
                        error instanceof Error ? error.message : String(error),
                    );
                    if (isDatabaseLockedError(error))
                        inRootAsyncContext(() =>
                            setTimeout(
                                () => scheduleReconciliation(db, sessionId, readMessages),
                                1000,
                            ),
                        ).unref();
                })
                .finally(() => {
                    heapHolder.reconciliationScheduledSessions.delete(sessionId);
                    if (appendedDuringReconciliation)
                        scheduleReconciliation(db, sessionId, readMessages);
                });
        });
    });
}

export function scheduleIncrementalIndex(
    db: Database,
    sessionId: string,
    messageId: string,
    messageSource: IncrementalMessageSource,
): void {
    const schedulingKey = `${sessionId}\u0000${messageId}`;
    const epoch = sessionEpochs.get(sessionId) ?? 0;
    if (heapHolder.pendingIncrementalKeys.has(schedulingKey)) return;

    const activeTimer = heapHolder.incrementalTimers.get(schedulingKey);
    if (activeTimer) clearTimeout(activeTimer);

    // Restart the settle window for every update. OpenCode can repeat a terminal
    // message.updated event as its final parts land; a trailing debounce reads the
    // authoritative message once after that burst instead of once per timer window.
    const timer = inRootAsyncContext(() =>
        setTimeout(() => {
            heapHolder.incrementalTimers.delete(schedulingKey);
            heapHolder.pendingIncrementalKeys.add(schedulingKey);
            let outcome: IncrementalIndexOutcome = {
                status: "skipped",
                reason: "session epoch changed before source preparation",
            };
            const indexMessage = async () => {
                if (
                    (sessionEpochs.get(sessionId) ?? 0) !== epoch ||
                    !heapHolder.pendingIncrementalKeys.has(schedulingKey)
                ) {
                    outcome = { status: "skipped", reason: "session epoch or pending key changed" };
                    return;
                }
                const message =
                    typeof messageSource === "function"
                        ? messageSource(sessionId, messageId)
                        : messageSource;
                if (!message) {
                    outcome = { status: "skipped", reason: "source message unavailable" };
                    return;
                }

                const revisionKey = `${schedulingKey}\u0000${getMessageIndexSourceIdentity(message)}`;
                if (heapHolder.completedIncrementalKeys.has(revisionKey)) {
                    outcome = { status: "skipped", reason: "source revision already completed" };
                    return;
                }

                const currentWatermark = getLastIndexedOrdinal(db, sessionId);
                if (
                    message.ordinal <= currentWatermark &&
                    isMessageIndexSourceCurrent(db, sessionId, message)
                ) {
                    heapHolder.completedIncrementalKeys.add(revisionKey);
                    outcome = { status: "skipped", reason: "source already current at watermark" };
                    return;
                }

                const wasReconciled = heapHolder.reconciledSessions.delete(sessionId);
                const inserted = await indexSingleMessageOffThread(db, sessionId, message);
                outcome = inserted
                    ? { status: "indexed" }
                    : { status: "skipped", reason: "indexing worker returned inserted=false" };
                if (
                    (sessionEpochs.get(sessionId) ?? 0) !== epoch ||
                    !heapHolder.pendingIncrementalKeys.has(schedulingKey)
                ) {
                    outcome = {
                        status: "skipped",
                        reason: "session epoch or pending key changed after indexing",
                    };
                    return;
                }
                const finalWatermark = getLastIndexedOrdinal(db, sessionId);
                if (
                    wasReconciled &&
                    isMessageIndexReconciledThrough(db, sessionId, finalWatermark)
                ) {
                    heapHolder.reconciledSessions.add(sessionId);
                }
                heapHolder.completedIncrementalKeys.add(revisionKey);
            };
            void sourceReady(messageSource, sessionId)
                .then((ready) => {
                    if ((sessionEpochs.get(sessionId) ?? 0) !== epoch) return;
                    if (ready) return runWithSessionLock(sessionId, indexMessage);
                    outcome = {
                        status: "retry scheduled",
                        reason: "source preparation returned false",
                    };
                    // Try again after PREPARE_RETRY_MS. A later reconciliation of the
                    // session also indexes this message.
                    setTimeout(
                        () => scheduleIncrementalIndex(db, sessionId, messageId, messageSource),
                        PREPARE_RETRY_MS,
                    ).unref?.();
                })
                .catch((error) => {
                    outcome = { status: "error", reason: String(error) };
                    if ((sessionEpochs.get(sessionId) ?? 0) !== epoch) return;
                    heapHolder.reconciledSessions.delete(sessionId);
                    logIndexingError(sessionId, `incremental index for ${messageId}`, error);
                    if (isDatabaseLockedError(error)) {
                        outcome = { status: "retry scheduled", reason: String(error) };
                        setTimeout(
                            () => scheduleIncrementalIndex(db, sessionId, messageId, messageSource),
                            1000,
                        ).unref();
                    }
                })
                .finally(() => {
                    if ((sessionEpochs.get(sessionId) ?? 0) === epoch)
                        heapHolder.pendingIncrementalKeys.delete(schedulingKey);
                    incrementalIndexSettledForTests?.(sessionId, messageId, outcome);
                });
        }, INCREMENTAL_DEBOUNCE_MS),
    );

    heapHolder.incrementalTimers.set(schedulingKey, timer);
}

/** FTS segment merges and WAL checkpoints at COMMIT must not run on the event loop. */
export async function indexSingleMessageOffThread(
    db: Database,
    sessionId: string,
    message: RawMessage,
): Promise<boolean> {
    const path = getSqliteDatabasePath(db);
    if (!path) return withSqliteBackgroundWriter(() => indexSingleMessage(db, sessionId, message));
    const cancellation = new Int32Array(new SharedArrayBuffer(4));
    const active = indexCancellations.get(sessionId) ?? new Set<Int32Array>();
    active.add(cancellation);
    indexCancellations.set(sessionId, active);
    const result = await runSessionWarmupWorker(
        {
            path,
            sessionId,
            indexMessage: message,
            harness: getHarness(),
            indexCancellation: cancellation.buffer as SharedArrayBuffer,
            ...indexCoordinationInput(),
        },
        {},
    ).finally(() => {
        active.delete(cancellation);
        if (active.size === 0) indexCancellations.delete(sessionId);
    });
    if (!("inserted" in result))
        throw new Error("failure" in result ? result.detail : "unexpected indexing worker reply");
    if (result.measurements) {
        const sessions = workerMeasurements.get(db) ?? new Map();
        sessions.set(sessionId, result.measurements);
        workerMeasurements.set(db, sessions);
        if (result.measurements.skipped)
            log(
                `[magic-context] incremental FTS skipped oversized source ${message.id} (${result.measurements.sourceBytes} bytes); identity and progress persisted`,
            );
    }
    return result.inserted;
}

export function scheduleClearAndReindex(
    db: Database,
    sessionId: string,
    readMessages: MessageReconciliationSource,
): void {
    heapHolder.reconciledSessions.delete(sessionId);
    heapHolder.reconciledSnapshots.delete(sessionId);
    heapHolder.reconciliationScheduledSessions.delete(sessionId);
    clearCompletedIncrementalKeys(sessionId);

    const existing = heapHolder.clearAndReindexScheduledSessions.get(sessionId);
    if (existing) {
        existing.source = readMessages;
        return;
    }
    const pending = { source: readMessages };
    heapHolder.clearAndReindexScheduledSessions.set(sessionId, pending);

    scheduleAfterBootQuiet(() => {
        defer(() => {
            let cleared = false;
            void runWithSessionLock(sessionId, () => {
                if (heapHolder.clearAndReindexScheduledSessions.get(sessionId) !== pending) return;
                // Coalesce removals only until the clear starts. A removal during
                // paged reconciliation must schedule another authoritative rebuild.
                heapHolder.clearAndReindexScheduledSessions.delete(sessionId);
                // An older boot-quiet reconciliation can finish after this clear was
                // scheduled, so invalidate process state under the same session lock
                // that clears the durable index.
                heapHolder.reconciledSessions.delete(sessionId);
                heapHolder.reconciledSnapshots.delete(sessionId);
                clearCompletedIncrementalKeys(sessionId);
                clearIndexedMessages(db, sessionId);
                cleared = true;
            })
                .then(() =>
                    cleared ? reconcileSessionIndex(db, sessionId, pending.source) : undefined,
                )
                .catch((error) => {
                    heapHolder.reconciledSessions.delete(sessionId);
                    if (heapHolder.clearAndReindexScheduledSessions.get(sessionId) === pending)
                        heapHolder.clearAndReindexScheduledSessions.delete(sessionId);
                    logIndexingError(sessionId, "clear and reindex", error);
                });
        });
    });
}

export interface MessageIndexQueueHeapStats {
    queueLength: number;
    reconciliationScheduled: number;
    incrementalTimers: number;
    pendingIncremental: number;
    activeSessionLocks: number;
    completedIncrementalKeys: number;
    activeBufferMessages: number;
    activeBufferBytes: number;
}

/** Live async-index holder counts used by the opt-in heap diagnostic RPC. */
export function getMessageIndexQueueHeapStats(): MessageIndexQueueHeapStats {
    return {
        queueLength:
            heapHolder.reconciliationScheduledSessions.size +
            heapHolder.incrementalTimers.size +
            heapHolder.pendingIncrementalKeys.size,
        reconciliationScheduled: heapHolder.reconciliationScheduledSessions.size,
        incrementalTimers: heapHolder.incrementalTimers.size,
        pendingIncremental: heapHolder.pendingIncrementalKeys.size,
        activeSessionLocks: heapHolder.sessionLocks.size,
        completedIncrementalKeys: heapHolder.completedIncrementalKeys.size,
        activeBufferMessages: [...heapHolder.activeReconcilerBuffers.values()].reduce(
            (sum, messages) => sum + messages.length,
            0,
        ),
        activeBufferBytes: [...heapHolder.activeReconcilerBuffers.values()].reduce(
            (sum, messages) => sum + serializedMessageBytes(messages),
            0,
        ),
    };
}

export function isSessionReconciled(sessionId: string): boolean {
    return heapHolder.reconciledSessions.has(sessionId);
}

export function clearSessionTracking(sessionId: string): void {
    sessionEpochs.set(sessionId, (sessionEpochs.get(sessionId) ?? 0) + 1);
    for (const cancellation of indexCancellations.get(sessionId) ?? [])
        Atomics.store(cancellation, 0, 1);
    heapHolder.clearAndReindexScheduledSessions.delete(sessionId);
    heapHolder.reconciledSessions.delete(sessionId);
    heapHolder.reconciledSnapshots.delete(sessionId);
    heapHolder.stalledSessions.delete(sessionId);
    heapHolder.reconciliationScheduledSessions.delete(sessionId);
    heapHolder.sessionLocks.delete(sessionId);
    heapHolder.activeReconcilerBuffers.delete(sessionId);

    const prefix = `${sessionId}\u0000`;
    for (const [key, timer] of heapHolder.incrementalTimers) {
        if (key.startsWith(prefix)) {
            clearTimeout(timer);
            heapHolder.incrementalTimers.delete(key);
        }
    }

    for (const key of heapHolder.pendingIncrementalKeys) {
        if (key.startsWith(prefix)) {
            heapHolder.pendingIncrementalKeys.delete(key);
        }
    }
    for (const key of heapHolder.completedIncrementalKeys) {
        if (key.startsWith(prefix)) heapHolder.completedIncrementalKeys.delete(key);
    }
}

export function __resetMessageIndexAsyncForTests(): void {
    incrementalIndexSettledForTests = undefined;
    reconciliationSettledForTests = undefined;
    for (const sessionId of indexCancellations.keys()) clearSessionTracking(sessionId);
    heapHolder.clearAndReindexScheduledSessions.clear();
    for (const timer of heapHolder.incrementalTimers.values()) {
        clearTimeout(timer);
    }
    heapHolder.reconciledSessions.clear();
    heapHolder.reconciledSnapshots.clear();
    heapHolder.stalledSessions.clear();
    heapHolder.reconciliationScheduledSessions.clear();
    heapHolder.sessionLocks.clear();
    heapHolder.incrementalTimers.clear();
    heapHolder.pendingIncrementalKeys.clear();
    heapHolder.completedIncrementalKeys.clear();
    heapHolder.activeReconcilerBuffers.clear();
}

import { inRootAsyncContext } from "../../shared/sqlite";
