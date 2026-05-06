import type { RawMessage } from "../../hooks/magic-context/read-session-raw";
import { log, sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import {
    clearIndexedMessages,
    getLastIndexedOrdinal,
    indexMessagesAfterOrdinal,
    indexSingleMessage,
} from "./message-index";

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
 *    single-message read and `indexSingleMessage()` insert. Duplicate events for
 *    the same `(sessionId,messageId)` inside 100ms are dropped.
 * 2. Per-session lazy reconciliation: the first transform/hook touch schedules
 *    one catch-up pass. It reads raw messages, resumes from
 *    `message_history_index.last_indexed_ordinal`, inserts missing newer rows,
 *    and advances the watermark to `messages.length`.
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

const reconciledSessions = new Set<string>();
const reconciliationScheduledSessions = new Set<string>();
const sessionLocks = new Map<string, Promise<void>>();
const incrementalTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingIncrementalKeys = new Set<string>();

type ReadMessages = (sessionId: string) => RawMessage[];
type ReadSingleMessage = (sessionId: string, messageId: string) => RawMessage | null;

function defer(fn: () => void): void {
    const immediate = (globalThis as { setImmediate?: (callback: () => void) => unknown })
        .setImmediate;
    if (typeof immediate === "function") {
        immediate(fn);
        return;
    }
    setTimeout(fn, 0);
}

function runWithSessionLock(
    sessionId: string,
    operation: () => Promise<void> | void,
): Promise<void> {
    const previous = sessionLocks.get(sessionId) ?? Promise.resolve();
    const run = previous
        .catch(() => undefined)
        .then(async () => {
            await operation();
        });

    sessionLocks.set(sessionId, run);
    run.finally(() => {
        if (sessionLocks.get(sessionId) === run) {
            sessionLocks.delete(sessionId);
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

async function reconcileSessionIndex(
    db: Database,
    sessionId: string,
    readMessages: ReadMessages,
): Promise<void> {
    await runWithSessionLock(sessionId, () => {
        if (reconciledSessions.has(sessionId)) {
            return;
        }

        const messages = readMessages(sessionId);
        if (messages.length === 0) {
            clearIndexedMessages(db, sessionId);
            reconciledSessions.add(sessionId);
            return;
        }

        let lastIndexedOrdinal = getLastIndexedOrdinal(db, sessionId);
        if (lastIndexedOrdinal > messages.length) {
            clearIndexedMessages(db, sessionId);
            lastIndexedOrdinal = 0;
        }

        const watermark = Math.min(lastIndexedOrdinal, messages.length);
        indexMessagesAfterOrdinal(db, sessionId, messages, watermark, messages.length);
        reconciledSessions.add(sessionId);
    });
}

export function scheduleReconciliation(
    db: Database,
    sessionId: string,
    readMessages: ReadMessages,
): void {
    if (reconciledSessions.has(sessionId) || reconciliationScheduledSessions.has(sessionId)) {
        return;
    }
    reconciliationScheduledSessions.add(sessionId);

    defer(() => {
        void reconcileSessionIndex(db, sessionId, readMessages).catch((error) => {
            reconciliationScheduledSessions.delete(sessionId);
            logIndexingError(sessionId, "reconciliation", error);
        });
    });
}

export function scheduleIncrementalIndex(
    db: Database,
    sessionId: string,
    messageId: string,
    readSingleMessage: ReadSingleMessage,
): void {
    const key = `${sessionId}\u0000${messageId}`;
    if (incrementalTimers.has(key) || pendingIncrementalKeys.has(key)) {
        return;
    }

    const timer = setTimeout(() => {
        incrementalTimers.delete(key);
        pendingIncrementalKeys.add(key);
        void runWithSessionLock(sessionId, () => {
            const message = readSingleMessage(sessionId, messageId);
            if (!message) {
                return;
            }
            indexSingleMessage(db, sessionId, message);
        })
            .catch((error) => {
                logIndexingError(sessionId, `incremental index for ${messageId}`, error);
            })
            .finally(() => {
                pendingIncrementalKeys.delete(key);
            });
    }, INCREMENTAL_DEBOUNCE_MS);

    incrementalTimers.set(key, timer);
}

export function scheduleClearAndReindex(
    db: Database,
    sessionId: string,
    readMessages: ReadMessages,
): void {
    reconciledSessions.delete(sessionId);
    reconciliationScheduledSessions.delete(sessionId);

    defer(() => {
        void runWithSessionLock(sessionId, () => {
            clearIndexedMessages(db, sessionId);
            const messages = readMessages(sessionId);
            indexMessagesAfterOrdinal(db, sessionId, messages, 0, messages.length);
            reconciledSessions.add(sessionId);
        }).catch((error) => {
            logIndexingError(sessionId, "clear and reindex", error);
        });
    });
}

export function isSessionReconciled(sessionId: string): boolean {
    return reconciledSessions.has(sessionId);
}

export function clearSessionTracking(sessionId: string): void {
    reconciledSessions.delete(sessionId);
    reconciliationScheduledSessions.delete(sessionId);
    sessionLocks.delete(sessionId);

    const prefix = `${sessionId}\u0000`;
    for (const [key, timer] of incrementalTimers) {
        if (key.startsWith(prefix)) {
            clearTimeout(timer);
            incrementalTimers.delete(key);
        }
    }

    for (const key of pendingIncrementalKeys) {
        if (key.startsWith(prefix)) {
            pendingIncrementalKeys.delete(key);
        }
    }
}

export function __resetMessageIndexAsyncForTests(): void {
    for (const timer of incrementalTimers.values()) {
        clearTimeout(timer);
    }
    reconciledSessions.clear();
    reconciliationScheduledSessions.clear();
    sessionLocks.clear();
    incrementalTimers.clear();
    pendingIncrementalKeys.clear();
}
