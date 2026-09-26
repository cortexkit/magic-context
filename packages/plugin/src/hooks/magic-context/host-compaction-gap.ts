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
 * Cache discipline. The range served is recorded durably (row ids, a digest of the
 * served rows, and the bytes of any row the host changed or removed after it was
 * served) and replayed on every pass that is not already known to bust the cache,
 * across a restart too. Only such a pass reads the store again. Between those
 * passes the served rows change in exactly one way: when a busting pass moved the
 * boundary into or past them (the prefix trim then cut through them on that pass),
 * the rows after the new boundary are served, which is what that pass served after
 * its trim.
 */

import { createHash } from "node:crypto";
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

/**
 * Key of this module's state inside the JSON object stored in
 * `session_meta.deferred_execute_state`. That column's original use was retired; it
 * now holds namespaced per-session state (the tokenizer calibration shares it), and
 * each writer rewrites only its own key.
 */
const STATE_KEY = "magicContextHostCompactionGap";

interface KeptRow {
    id: string;
    /** Null for a stored row that is kept for its position but never served. */
    message: HostShapedMessage | null;
}

/** The last range served for one native compaction, as persisted. */
interface ServedRangeRecord {
    compactionMessageId: string;
    tailStartId: string;
    /** The boundary the range starts after; null when it starts at the session's first row. */
    lowerId: string | null;
    rowIds: string[];
    digest: string;
    tokens: number;
    /** False when the range could not be served; passes then fall back. */
    served: boolean;
    /** Why the range is not served, when it is not; absent means it was too large. */
    fallbackReason?: HostCompactionGapFallbackReason;
    fallbackDetail?: string;
    /** Bytes of served rows the host changed or removed after they were served. */
    preserved: Record<string, HostShapedMessage>;
    /** Served rows the host removed; their tag state is cleaned once they leave the range. */
    removed: string[];
}

interface GapState {
    /**
     * Set when a native compaction kept the session's tag statuses because the rows
     * after the boundary were expected to stay on the wire. Cleared once a pass
     * restores them, or turned into the usual tag retirement when it cannot.
     */
    tagsKept?: boolean;
    range?: ServedRangeRecord;
}

interface KeptGap extends Omit<ServedRangeRecord, "rowIds" | "digest"> {
    rows: KeptRow[];
}

const keptGapBySession = new BoundedSessionMap<KeptGap>(KEPT_SESSIONS_MAX);
const loggedBySession = new BoundedSessionMap<string>(KEPT_SESSIONS_MAX);

export type HostCompactionGapFallbackReason =
    | "no-tail-start"
    | "no-boundary"
    | "window-shape"
    | "store-unavailable"
    | "missing-bound"
    | "too-large"
    | "read-failed";

export type HostCompactionGapOutcome = (
    | {
          status: "restored";
          /** Rows inserted in place of the compaction request, in stored order. */
          restored: MessageLike[];
          tokens: number;
          source: "store" | "kept" | "record";
      }
    | { status: "fallback"; reason: HostCompactionGapFallbackReason }
) & {
    /** Rows the host removed that have now left the served range. */
    rowsLeftRange: string[];
};

export interface HostCompactionGapLowerBound {
    /** The boundary row; null when the range starts at the session's first row. */
    afterId: string | null;
}

export interface RestoreHostCompactionGapArgs {
    db: Database;
    sessionId: string;
    /** The host-served messages of this pass; edited in place when the gap is restored. */
    messages: MessageLike[];
    window: HostCompactionWindow;
    /** Where the restored range starts (see `resolveHostCompactionGapLowerBound`). */
    lower: HostCompactionGapLowerBound | null;
    /**
     * True only on a pass already known to rebuild the cached prefix. Only such a
     * pass reads the range from the store again when the served rows answer it.
     */
    refreshAllowed: boolean;
    /** Most tokens the restored rows may carry; a larger range is not served. */
    budgetTokens: number;
    readRange: (
        afterId: string | null,
        beforeId: string,
        maxRows: number,
    ) => HostMessageRangeRead | null;
    readById: (ids: readonly string[]) => Map<string, HostShapedMessage> | null;
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
 * Where the restored range starts, resolved the way the cold-rebuild trim reads the
 * cached baseline: with a cached m[0], its recorded boundary, or the session's first
 * row when that m[0] was built before any compartment existed (it covers none, so
 * rows a later compartment covers stay raw until a busting pass re-renders m[0]).
 * Without a cached m[0], the latest compartment's end. Null when neither exists.
 */
export function resolveHostCompactionGapLowerBound(
    db: Database,
    sessionId: string,
): HostCompactionGapLowerBound | null {
    const row = db
        .prepare(
            "SELECT cached_m0_bytes IS NOT NULL AS has_m0, cached_m0_last_baseline_end_message_id AS id FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId) as { has_m0: number; id: string | null } | null | undefined;
    const boundary = typeof row?.id === "string" && row.id.length > 0 ? row.id : null;
    if (row?.has_m0 === 1) return { afterId: boundary };
    const last = getLastCompartmentEndMessageId(db, sessionId);
    return last ? { afterId: last } : null;
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

// ── Durable state ────────────────────────────────────────────────────────

function readRoot(db: Database, sessionId: string): Record<string, unknown> | null {
    const row = db
        .prepare("SELECT deferred_execute_state AS state FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { state: string | null } | null | undefined;
    if (!row) return null;
    if (!row.state) return {};
    try {
        const parsed = JSON.parse(row.state) as unknown;
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

function readGapState(db: Database, sessionId: string): GapState {
    const value = readRoot(db, sessionId)?.[STATE_KEY];
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as GapState)
        : {};
}

function writeGapState(db: Database, sessionId: string, update: (state: GapState) => GapState) {
    db.transaction(() => {
        const root = readRoot(db, sessionId);
        if (!root) return;
        const current = root[STATE_KEY];
        const next = update(
            typeof current === "object" && current !== null && !Array.isArray(current)
                ? (current as GapState)
                : {},
        );
        if (next.tagsKept || next.range) root[STATE_KEY] = next;
        else delete root[STATE_KEY];
        db.prepare("UPDATE session_meta SET deferred_execute_state = ? WHERE session_id = ?").run(
            JSON.stringify(root),
            sessionId,
        );
    }).immediate();
}

/** Record that a native compaction left this session's tag statuses in place. */
export function markHostCompactionTagsKept(db: Database, sessionId: string): void {
    writeGapState(db, sessionId, (state) => ({ ...state, tagsKept: true }));
}

function digestOf(rows: readonly KeptRow[]): string {
    return createHash("sha256")
        .update(JSON.stringify(rows.map((row) => [row.id, row.message])))
        .digest("hex");
}

function toRecord(kept: KeptGap): ServedRangeRecord {
    const { rows, ...rest } = kept;
    return { ...rest, rowIds: rows.map((row) => row.id), digest: digestOf(rows) };
}

function persist(db: Database, sessionId: string, kept: KeptGap): void {
    writeGapState(db, sessionId, (state) => ({ ...state, range: toRecord(kept) }));
}

// ── Rows ─────────────────────────────────────────────────────────────────

/**
 * Rows of the range that are never served: an older compaction pair left inside
 * the range by an earlier `/compact`. Its request carries nothing but the compaction
 * part (it only asks for a summary), and summary rows are stripped from every pass
 * anyway. A real user turn that also carries a compaction part (Magic Context's own
 * marker is written onto one) is served as stored.
 */
function isServedRangeRow(message: HostShapedMessage): boolean {
    if (message.info.summary === true) return false;
    return !(message.parts.length > 0 && message.parts.every((part) => part.type === "compaction"));
}

function tokensOf(rows: readonly KeptRow[]): number {
    let tokens = 0;
    for (const row of rows) {
        if (!row.message) continue;
        const estimate = estimateMessageTokens(row.message as unknown as MessageLike);
        tokens += estimate.conversation + estimate.toolCall;
    }
    return tokens;
}

function logOnce(sessionId: string, key: string, text: string): void {
    if (loggedBySession.get(sessionId) === key) return;
    loggedBySession.set(sessionId, key);
    sessionLog(sessionId, text);
}

type ReadResult =
    | { kind: "kept"; kept: KeptGap }
    | { kind: "fallback"; reason: HostCompactionGapFallbackReason; detail: string };

function readFromStore(
    args: RestoreHostCompactionGapArgs,
    tailStartId: string,
    lowerId: string | null,
): ReadResult {
    let read: HostMessageRangeRead | null;
    try {
        read = args.readRange(lowerId, tailStartId, HOST_COMPACTION_GAP_MAX_ROWS);
    } catch (error) {
        sessionLog(args.sessionId, "host compaction gap: reading the range failed:", error);
        return { kind: "fallback", reason: "read-failed", detail: "store read threw" };
    }
    if (read === null) {
        return { kind: "fallback", reason: "store-unavailable", detail: "no OpenCode store" };
    }
    if (read.status === "missing-bound") {
        return {
            kind: "fallback",
            reason: "missing-bound",
            detail: `${read.missing === "after" ? `boundary ${lowerId}` : `tail start ${tailStartId}`} is not stored`,
        };
    }
    const base = {
        compactionMessageId: args.window.compactionMessageId,
        tailStartId,
        lowerId,
        preserved: {},
        removed: [],
    };
    if (read.status === "too-many-rows") {
        return { kind: "kept", kept: { ...base, rows: [], tokens: 0, served: false } };
    }
    const rows: KeptRow[] = read.messages.map((message) => ({
        id: message.info.id as string,
        message: isServedRangeRow(message) ? message : null,
    }));
    const tokens = tokensOf(rows);
    return { kind: "kept", kept: { ...base, rows, tokens, served: tokens <= args.budgetTokens } };
}

/**
 * Rebuild the rows a previous process served from its record: stored rows by id,
 * with the recorded bytes of any row the host changed or removed since. Undefined
 * when the rebuilt rows do not match the recorded digest (the store changed while
 * no process could record the served bytes).
 */
function rebuildFromRecord(
    args: RestoreHostCompactionGapArgs,
    record: ServedRangeRecord,
): KeptGap | undefined {
    let stored: Map<string, HostShapedMessage> | null;
    try {
        stored = args.readById(record.rowIds);
    } catch (error) {
        sessionLog(args.sessionId, "host compaction gap: reading the served rows failed:", error);
        return undefined;
    }
    if (stored === null) return undefined;
    const rows: KeptRow[] = [];
    for (const id of record.rowIds) {
        const message = record.preserved[id] ?? stored.get(id);
        if (!message) return undefined;
        rows.push({ id, message: isServedRangeRow(message) ? message : null });
    }
    if (digestOf(rows) !== record.digest) return undefined;
    const { rowIds: _rowIds, digest: _digest, ...rest } = record;
    return { ...rest, rows };
}

/**
 * Answer a moved boundary from the served rows, without reading the store.
 * Undefined when the served rows cannot answer it.
 */
function trimKept(
    args: RestoreHostCompactionGapArgs,
    kept: KeptGap,
    lowerId: string | null,
): KeptGap | undefined {
    if (lowerId === null) return undefined;
    const index = kept.rows.findIndex((row) => row.id === lowerId);
    if (index >= 0) {
        const rows = kept.rows.slice(index + 1);
        return { ...kept, lowerId, rows, tokens: tokensOf(rows) };
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

function sameRange(left: KeptGap, right: KeptGap): boolean {
    return (
        left.lowerId === right.lowerId &&
        left.served === right.served &&
        left.removed.length === right.removed.length &&
        Object.keys(left.preserved).length === Object.keys(right.preserved).length &&
        left.rows.length === right.rows.length &&
        left.rows.every((row, index) => row === right.rows[index])
    );
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
    const fallback = (
        reason: HostCompactionGapFallbackReason,
        detail: string,
        rowsLeftRange: string[] = [],
    ): HostCompactionGapOutcome => {
        logOnce(
            sessionId,
            `fallback:${window.compactionMessageId}:${reason}:${detail}`,
            `host compaction gap: not restored (${reason}; ${detail}); the rows between the Magic Context boundary and the retained tail stay off the wire until the historian covers them`,
        );
        return { status: "fallback", reason, rowsLeftRange };
    };

    const requestIndex = messages.findIndex(
        (message) => message.info.id === window.compactionMessageId,
    );
    const summaryIndex = messages.findIndex(
        (message) => message.info.id === window.summaryMessageId,
    );
    if (requestIndex < 0 || summaryIndex < 0) {
        return fallback("window-shape", "compaction pair not in the served messages");
    }
    const request = messages[requestIndex] as MessageLike;
    const tailStartId = readCompactionTailStartId(request);
    if (!tailStartId) return fallback("no-tail-start", `request ${window.compactionMessageId}`);
    if (!args.lower) return fallback("no-boundary", "no cached m[0] and no compartment");
    const lowerId = args.lower.afterId;

    const matches = (candidate: { compactionMessageId: string; tailStartId: string }) =>
        candidate.compactionMessageId === window.compactionMessageId &&
        candidate.tailStartId === tailStartId;
    const inMemory = keptGapBySession.get(sessionId);
    let previous = inMemory && matches(inMemory) ? inMemory : undefined;
    let source: "store" | "kept" | "record" = "kept";
    if (!previous) {
        // A new process: replay the range the last one served, from its record.
        const record = readGapState(args.db, sessionId).range;
        if (record && matches(record)) {
            previous = rebuildFromRecord(args, record);
            source = "record";
            if (!previous) {
                logOnce(
                    sessionId,
                    `record-mismatch:${window.compactionMessageId}:${record.digest}`,
                    "host compaction gap: the served rows changed in the store while no process recorded them; reading the range again",
                );
            }
        }
    }

    let kept: KeptGap | undefined;
    if (previous && !args.refreshAllowed) {
        if (previous.lowerId === lowerId) kept = previous;
        else {
            kept = trimKept(args, previous, lowerId);
            if (!kept) {
                kept = previous;
                logOnce(
                    sessionId,
                    `stale:${window.compactionMessageId}:${previous.lowerId}:${lowerId}`,
                    `host compaction gap: boundary ${lowerId ?? "(session start)"} is not among the restored rows (after ${previous.lowerId ?? "(session start)"}); replaying them until a cache-busting pass reads the range again`,
                );
            }
        }
    }
    if (!kept) {
        const read = readFromStore(args, tailStartId, lowerId);
        if (read.kind === "kept") {
            kept = read.kept;
            source = "store";
        } else if (previous && read.reason === "read-failed") {
            // A failed store read must not change what this pass serves: replay the
            // rows the previous pass served for the same compaction.
            kept = previous;
        } else if (read.reason === "store-unavailable") {
            // Another host's session: nothing to restore, now or later.
            return fallback(read.reason, read.detail);
        } else {
            // Record the verdict so the passes after this one fall back too, until a
            // pass already known to bust reads the store again.
            kept = {
                compactionMessageId: window.compactionMessageId,
                tailStartId,
                lowerId,
                rows: [],
                tokens: 0,
                served: false,
                fallbackReason: read.reason,
                fallbackDetail: read.detail,
                preserved: {},
                removed: [],
            };
        }
    }

    // Rows the host removed stay served until the range no longer includes them.
    const keptIds = new Set(kept.rows.map((row) => row.id));
    const carried = previous?.removed ?? [];
    const rowsLeftRange = carried.filter((id) => !keptIds.has(id));
    if (kept !== previous) {
        const preserved: Record<string, HostShapedMessage> = {};
        for (const [id, message] of Object.entries(kept.preserved)) {
            if (keptIds.has(id)) preserved[id] = message;
        }
        kept = { ...kept, preserved, removed: carried.filter((id) => keptIds.has(id)) };
    }
    keptGapBySession.set(sessionId, kept);
    if (!previous || source === "record" || !sameRange(previous, kept)) {
        persist(args.db, sessionId, kept);
    }

    if (!kept.served) {
        return fallback(
            kept.fallbackReason ?? "too-large",
            kept.fallbackDetail ??
                `${kept.rows.length} rows, ${kept.tokens} tokens, budget ${args.budgetTokens}`,
            rowsLeftRange,
        );
    }

    const restored = kept.rows.flatMap((row) =>
        row.message ? [row.message as unknown as MessageLike] : [],
    );
    // The transform edits the messages it is handed in place, so every pass gets its
    // own copy and the kept rows stay as they were first read.
    const copies = structuredClone(restored);
    messages.splice(requestIndex, 1);
    const tailIndex = messages.findIndex((message) => message.info.id === tailStartId);
    const summaryAt = messages.findIndex((message) => message.info.id === window.summaryMessageId);
    const insertAt = tailIndex >= 0 ? tailIndex : summaryAt + 1;
    messages.splice(insertAt, 0, ...copies);
    logOnce(
        sessionId,
        `restored:${window.compactionMessageId}:${lowerId}:${kept.rows.length}`,
        `host compaction gap: restored ${copies.length} rows (${kept.tokens} tokens) after ${lowerId ?? "the session start"} up to the retained tail ${tailStartId}; compaction request ${window.compactionMessageId} left off the wire`,
    );
    return { status: "restored", restored: copies, tokens: kept.tokens, source, rowsLeftRange };
}

/**
 * Called when the host changes or removes a stored row. When the row is one this
 * process serves in a restored range, its served bytes are recorded so a later
 * process replays them too, and true is returned: a removed row's tag state must
 * then stay until a busting pass takes the row out of the range (see
 * `rowsLeftRange`). False when the row is not a served row, or its served bytes
 * are not known here.
 */
export function holdHostCompactionGapRow(
    db: Database,
    sessionId: string,
    messageId: string,
    change: "removed" | "changed",
): boolean {
    const kept = keptGapBySession.peek(sessionId);
    const row = kept?.rows.find((candidate) => candidate.id === messageId);
    if (!kept || !row?.message) return false;
    const preserved = kept.preserved[messageId]
        ? kept.preserved
        : { ...kept.preserved, [messageId]: row.message };
    const removed =
        change === "removed" && !kept.removed.includes(messageId)
            ? [...kept.removed, messageId]
            : kept.removed;
    if (preserved === kept.preserved && removed === kept.removed) return true;
    const next = { ...kept, preserved, removed };
    keptGapBySession.set(sessionId, next);
    persist(db, sessionId, next);
    return true;
}

/**
 * Settle a native compaction's kept tag statuses on the first pass that evaluates
 * the restore after it. When the rows were restored, the statuses stay. When they
 * were not, the tags are retired exactly as a native compaction always retired
 * them, just one step later: nothing has been tagged since the compaction, because
 * this runs before the pass tags anything.
 */
export function settleHostCompactionTags(
    db: Database,
    sessionId: string,
    outcome: HostCompactionGapOutcome,
): "kept" | "retired" | "none" {
    if (!readGapState(db, sessionId).tagsKept) return "none";
    if (outcome.status === "fallback") {
        db.transaction(() => {
            db.prepare(
                "UPDATE tags SET status = 'compacted' WHERE session_id = ? AND status IN ('active', 'dropped')",
            ).run(sessionId);
            db.prepare("DELETE FROM pending_ops WHERE session_id = ?").run(sessionId);
        }).immediate();
    }
    writeGapState(db, sessionId, (current) => ({ ...current, tagsKept: undefined }));
    return outcome.status === "restored" ? "kept" : "retired";
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
