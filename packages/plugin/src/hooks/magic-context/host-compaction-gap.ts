/**
 * Restore the history a native OpenCode 1 `/compact` hides from the model.
 *
 * After a native compaction OpenCode loads the session from its newest compaction
 * pair: [compaction request, summary, retained tail, newer rows]. Magic Context keeps
 * its own compartments as the history (m[0]/m[1]) and strips the host summary, so
 * the rows between the last compartment Magic Context rendered (the stored baseline
 * boundary) and the first retained row (`tail_start_id` on the compaction request)
 * are in no compartment and no longer loaded. This module reads those rows from
 * OpenCode's store and serves them raw, in the host's own message shape, in place
 * of the compaction request, until the historian covers them.
 *
 * Cache discipline. Both bounds are durable: the baseline boundary only moves on a
 * pass that rebuilds m[0]/m[1], and the compaction request never changes. So the
 * range is a pure function of persisted state, and a restarted process reads back
 * exactly what the last pass served. Within one process the served rows are also
 * kept, and a pass that may not bust the cache replays them instead of reading the
 * store again:
 *   - same bounds: the kept rows, byte for byte;
 *   - the boundary moved onto a kept row (a busting pass published history over
 *     part of the range and the prefix trim cut through it): the kept rows after it,
 *     which is what that pass served after its trim;
 *   - the boundary moved at or past the retained tail: nothing;
 *   - anything else (a stored row changed, or the boundary moved somewhere the kept
 *     rows cannot answer): the kept rows unchanged, until a pass that is already
 *     busting reads the store again.
 */

import { getLastCompartmentEndMessageId } from "../../features/magic-context/compartment-storage";
import { BoundedSessionMap } from "../../shared/bounded-session-map";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { estimateMessageTokens } from "./final-wire-token-estimate";
import type { HostCompactionWindow } from "./inject-compartments";
import { deriveProtectedTailTokenTarget } from "./protected-tail-boundary";
import type { HostMessageRangeRead, HostShapedMessage } from "./read-session-raw";
import type { MessageLike } from "./tag-messages";

/** Upper bound on stored rows read for one range; a longer range is not served. */
export const HOST_COMPACTION_GAP_MAX_ROWS = 5_000;

const KEPT_SESSIONS_MAX = 100;

interface KeptRow {
    id: string;
    /** Null for a stored row that is kept for its position but never served. */
    message: MessageLike | null;
}

interface KeptGap {
    compactionMessageId: string;
    tailStartId: string;
    lowerId: string;
    rows: KeptRow[];
    tokens: number;
    /** False when the range was too large to serve; the pass then falls back. */
    served: boolean;
}

const keptGapBySession = new BoundedSessionMap<KeptGap>(KEPT_SESSIONS_MAX);
const loggedBySession = new BoundedSessionMap<string>(KEPT_SESSIONS_MAX);

export type HostCompactionGapOutcome =
    | {
          status: "restored";
          /** Rows inserted in place of the compaction request, in stored order. */
          restored: MessageLike[];
          tokens: number;
          source: "store" | "kept";
      }
    | {
          status: "fallback";
          reason:
              | "no-tail-start"
              | "no-boundary"
              | "window-shape"
              | "store-unavailable"
              | "missing-bound"
              | "too-large"
              | "read-failed";
      };

export interface RestoreHostCompactionGapArgs {
    sessionId: string;
    /** The host-served messages of this pass; edited in place when the gap is restored. */
    messages: MessageLike[];
    window: HostCompactionWindow;
    /** The persisted m[0] baseline boundary, else the latest compartment end. */
    boundaryId: string | null;
    /**
     * True when this pass is already known to rebuild the cached prefix, so the
     * range may be read from the store again even when kept rows could answer it.
     */
    refreshAllowed: boolean;
    /** Most tokens the restored rows may carry; a larger range is not served. */
    budgetTokens: number;
    readRange: (afterId: string, beforeId: string, maxRows: number) => HostMessageRangeRead | null;
    /** Stored order of two rows: negative when `left` comes first, null when unknown. */
    compareOrder: (left: string, right: string) => number | null;
}

/**
 * The tokens the restored rows may take: what is left of the usable window
 * (context limit × execute threshold) after the largest protected tail. Rows the
 * historian has not summarised yet share the window with the protected tail, so a
 * range larger than this could not have been on the wire before the compaction
 * without the emergency path reclaiming it. Independent of live usage, so the
 * verdict does not change between two passes of the same model.
 */
export function hostCompactionGapBudgetTokens(
    contextLimit: number | undefined,
    executeThresholdPercentage: number,
): number {
    const target = deriveProtectedTailTokenTarget({
        contextLimit: contextLimit ?? 0,
        executeThresholdPercentage,
        usagePercentage: 0,
    });
    return Math.max(0, target.usable - target.ceilingN);
}

/**
 * The boundary the restored range starts after: the persisted m[0] baseline
 * boundary, or the latest compartment's end when no baseline has recorded one yet.
 * Both are persisted state, and the baseline only moves on a cache-busting pass.
 */
export function readHostCompactionGapBoundary(db: Database, sessionId: string): string | null {
    const row = db
        .prepare(
            "SELECT cached_m0_last_baseline_end_message_id AS id FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId) as { id: string | null } | null | undefined;
    if (typeof row?.id === "string" && row.id.length > 0) return row.id;
    return getLastCompartmentEndMessageId(db, sessionId);
}

/** The `tail_start_id` a compaction request names, or null when it names none. */
export function readCompactionTailStartId(request: MessageLike): string | null {
    for (const part of request.parts) {
        const record = part as { type?: unknown; tail_start_id?: unknown };
        if (record.type !== "compaction") continue;
        return typeof record.tail_start_id === "string" && record.tail_start_id.length > 0
            ? record.tail_start_id
            : null;
    }
    return null;
}

/**
 * Rows of the range that are never served: an older compaction pair left inside
 * the range by an earlier `/compact`. Its request only asks for a summary, and
 * summary rows are stripped from every pass anyway.
 */
function isServedRangeRow(message: HostShapedMessage): boolean {
    if (message.info.summary === true) return false;
    return !message.parts.some((part) => part.type === "compaction");
}

function logOnce(sessionId: string, key: string, text: string): void {
    if (loggedBySession.get(sessionId) === key) return;
    loggedBySession.set(sessionId, key);
    sessionLog(sessionId, text);
}

function fallback(
    args: RestoreHostCompactionGapArgs,
    reason: Extract<HostCompactionGapOutcome, { status: "fallback" }>["reason"],
    detail: string,
): HostCompactionGapOutcome {
    logOnce(
        args.sessionId,
        `fallback:${args.window.compactionMessageId}:${reason}:${detail}`,
        `host compaction gap: not restored (${reason}; ${detail}); the rows between the Magic Context boundary and the retained tail stay off the wire until the historian covers them`,
    );
    return { status: "fallback", reason };
}

function readKept(
    args: RestoreHostCompactionGapArgs,
    tailStartId: string,
    lowerId: string,
): HostCompactionGapOutcome | KeptGap {
    let read: HostMessageRangeRead | null;
    try {
        read = args.readRange(lowerId, tailStartId, HOST_COMPACTION_GAP_MAX_ROWS);
    } catch (error) {
        sessionLog(args.sessionId, "host compaction gap: reading the range failed:", error);
        return { status: "fallback", reason: "read-failed" };
    }
    if (read === null) return fallback(args, "store-unavailable", "no OpenCode store");
    if (read.status === "missing-bound") {
        return fallback(
            args,
            "missing-bound",
            `${read.missing === "after" ? `boundary ${lowerId}` : `tail start ${tailStartId}`} is not stored`,
        );
    }
    const rows: KeptRow[] = [];
    let tokens = 0;
    let served = true;
    if (read.status === "too-many-rows") {
        served = false;
    } else {
        for (const message of read.messages) {
            const id = message.info.id as string;
            if (!isServedRangeRow(message)) {
                rows.push({ id, message: null });
                continue;
            }
            const shaped = message as unknown as MessageLike;
            const estimate = estimateMessageTokens(shaped);
            tokens += estimate.conversation + estimate.toolCall;
            rows.push({ id, message: shaped });
        }
        if (tokens > args.budgetTokens) served = false;
    }
    return {
        compactionMessageId: args.window.compactionMessageId,
        tailStartId,
        lowerId,
        rows,
        tokens,
        served,
    };
}

/**
 * Answer a moved boundary from kept rows, without reading the store. Returns
 * undefined when the kept rows cannot answer it.
 */
function trimKept(
    args: RestoreHostCompactionGapArgs,
    kept: KeptGap,
    lowerId: string,
): KeptGap | undefined {
    const index = kept.rows.findIndex((row) => row.id === lowerId);
    if (index >= 0) {
        const rows = kept.rows.slice(index + 1);
        let tokens = 0;
        for (const row of rows) {
            if (!row.message) continue;
            const estimate = estimateMessageTokens(row.message);
            tokens += estimate.conversation + estimate.toolCall;
        }
        return { ...kept, lowerId, rows, tokens };
    }
    let order: number | null = null;
    try {
        order = args.compareOrder(lowerId, kept.tailStartId);
    } catch {
        order = null;
    }
    if (order !== null && order >= 0) return { ...kept, lowerId, rows: [], tokens: 0 };
    return undefined;
}

/**
 * Serve the rows a native compaction hid, in place of its compaction request. Edits
 * `args.messages` only when the outcome is `restored`; a fallback leaves the pass
 * exactly as the host served it.
 */
export function restoreHostCompactionGap(
    args: RestoreHostCompactionGapArgs,
): HostCompactionGapOutcome {
    const { sessionId, messages, window } = args;
    const requestIndex = messages.findIndex(
        (message) => message.info.id === window.compactionMessageId,
    );
    const summaryIndex = messages.findIndex(
        (message) => message.info.id === window.summaryMessageId,
    );
    if (requestIndex < 0 || summaryIndex < 0) {
        return fallback(args, "window-shape", "compaction pair not in the served messages");
    }
    const request = messages[requestIndex] as MessageLike;
    const tailStartId = readCompactionTailStartId(request);
    if (!tailStartId) {
        return fallback(args, "no-tail-start", `request ${window.compactionMessageId}`);
    }
    const lowerId = args.boundaryId;
    if (!lowerId) return fallback(args, "no-boundary", "no stored compartment boundary");

    const stored = keptGapBySession.get(sessionId);
    const previous =
        stored !== undefined &&
        stored.compactionMessageId === window.compactionMessageId &&
        stored.tailStartId === tailStartId
            ? stored
            : undefined;
    let kept: KeptGap | undefined;
    let source: "store" | "kept" = "kept";
    if (previous && !args.refreshAllowed) {
        if (previous.lowerId === lowerId) kept = previous;
        else {
            kept = trimKept(args, previous, lowerId);
            if (!kept) {
                kept = previous;
                logOnce(
                    sessionId,
                    `stale:${window.compactionMessageId}:${previous.lowerId}:${lowerId}`,
                    `host compaction gap: boundary ${lowerId} is not among the restored rows (after ${previous.lowerId}); replaying them until a cache-busting pass reads the range again`,
                );
            }
        }
    }
    if (!kept) {
        const read = readKept(args, tailStartId, lowerId);
        if (!("status" in read)) {
            kept = read;
            source = "store";
        } else if (previous && read.status === "fallback" && read.reason === "read-failed") {
            // A pass that cannot read the store keeps serving what it served last.
            kept = previous;
        } else {
            return read;
        }
    }
    keptGapBySession.set(sessionId, kept);
    if (!kept.served) {
        return fallback(
            args,
            "too-large",
            `${kept.rows.length} rows, ${kept.tokens} tokens, budget ${args.budgetTokens}`,
        );
    }

    const restored = kept.rows.flatMap((row) => (row.message ? [row.message] : []));
    // The transform edits the messages it is handed, so every pass gets its own copy.
    const copies = structuredClone(restored);
    messages.splice(requestIndex, 1);
    const tailIndex = messages.findIndex((message) => message.info.id === tailStartId);
    const summaryAt = messages.findIndex((message) => message.info.id === window.summaryMessageId);
    const insertAt = tailIndex >= 0 ? tailIndex : summaryAt + 1;
    messages.splice(insertAt, 0, ...copies);
    logOnce(
        sessionId,
        `restored:${window.compactionMessageId}:${lowerId}:${kept.rows.length}`,
        `host compaction gap: restored ${copies.length} rows (${kept.tokens} tokens) after boundary ${lowerId} up to the retained tail ${tailStartId}; compaction request ${window.compactionMessageId} left off the wire`,
    );
    return { status: "restored", restored: copies, tokens: kept.tokens, source };
}

/** Forget the kept rows of a session (deleted session, tests). */
export function forgetHostCompactionGap(sessionId: string): void {
    keptGapBySession.delete(sessionId);
    loggedBySession.delete(sessionId);
}

/** Drop every session's kept rows, as a restarted process starts. */
export function clearHostCompactionGapState(): void {
    keptGapBySession.clear();
    loggedBySession.clear();
}
