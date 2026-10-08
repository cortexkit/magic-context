import { getUncoveredCompartmentEndsThrough } from "../../features/magic-context/compartment-storage";
import type { ContextDatabase } from "../../features/magic-context/storage";
import {
    getPersistedCompactionMarkerState,
    type PersistedCompactionMarkerState,
    setPersistedCompactionMarkerState,
} from "../../features/magic-context/storage-meta-persisted";
import type { MarkerUpdateOutcome } from "../../hooks/magic-context/compaction-marker-manager";
import { getOpenCodeProviderProjection } from "../../hooks/magic-context/host-runner/opencode-adapter";
import {
    hasRawMessageProvider,
    readRawSessionMessageIdOrdinalsForRange,
    readRawSessionMessageOrdinalById,
} from "../../hooks/magic-context/read-session-chunk";
import type { RawMessage } from "../../hooks/magic-context/read-session-raw";
import type { CompactionMarkerStrategy } from "../../hooks/magic-context/transform-postprocess-phase";
import { sessionLog } from "../../shared/logger";
import { v2CompactionMarkerStrategy } from "./markers";

/**
 * Resolve the boundary the served array starts at, given the module's baseline end.
 *
 * OpenCode 1 answers this question by writing a compaction row: it picks the
 * nearest user message at or before the module's baseline end and serves the
 * conversation from there. OpenCode 2 has no such row, so the same rule is
 * applied here against the same raw projection. Keeping the rule identical is
 * what makes the two hosts hand the module the same array for the same baseline.
 *
 * Returns null when the baseline end is unknown or no user message precedes it,
 * which is the case a caller must treat as "do not move the boundary".
 */
export function resolveBoundaryUserMessage(
    messages: readonly RawMessage[],
    endMessageId: string,
): RawMessage | null {
    const end = messages.findIndex((message) => message.id === endMessageId);
    if (end < 0) return null;
    for (let index = end; index >= 0; index -= 1) {
        const candidate = messages[index];
        if (candidate && candidate.role === "user") return candidate;
    }
    return null;
}

/**
 * Marker lifecycle for Rust mode on OpenCode 2.
 *
 * On OpenCode 1 the module's materialized boundary becomes a real compaction row
 * in the host's store. OpenCode 2 exposes no way to write such a row, so the
 * boundary is recorded here instead, in the same `session_meta` columns the
 * OpenCode 1 marker state already uses.
 *
 * Only the carrier differs. The advance-only rule and the compare-and-swap on the
 * pending blob are the shared caller's, unchanged: this records a boundary that
 * moved forward and declines one that did not.
 */
export function createV2RustCompactionMarkerStrategy(
    /**
     * The nearest user turn at or before `endMessageId`, by the rule
     * `resolveBoundaryUserMessage` states; null when there is none. The caller
     * answers it from the store with a bounded backward read.
     */
    findBoundaryUserMessage: (sessionId: string, endMessageId: string) => RawMessage | null,
): CompactionMarkerStrategy {
    return {
        ...v2CompactionMarkerStrategy,
        applyDeferred: (db, sessionId, pending): MarkerUpdateOutcome => {
            // A published end can stop partway through a message (an indexed end), leaving
            // that message's later blocks unsummarized. That is not a reason to skip the
            // boundary: it is resolved from that partial message itself, as the nearest
            // user turn at or before it, and `trimToRecordedBoundary` keeps the boundary
            // message and everything after it. So the cut lands after the last whole
            // turn, the partial message stays in the array raw (as TS mode leaves it),
            // and no tool call is separated from its result. An older indexed end
            // before the boundary is still protected by the trim's own partial guard.
            const existing = getPersistedCompactionMarkerState(db as ContextDatabase, sessionId);
            if (existing && existing.boundaryOrdinal >= pending.ordinal) {
                return { kind: "already-current" };
            }
            let boundary: RawMessage | null = null;
            try {
                boundary = findBoundaryUserMessage(sessionId, pending.endMessageId);
            } catch (error) {
                return {
                    kind: "retryable-failure",
                    cut: "definitely-no-cut",
                    error: error instanceof Error ? error : new Error(String(error)),
                };
            }
            if (!boundary) {
                // Same rule as the OpenCode 1 drain: an unresolvable target leaves the
                // previous boundary in place rather than dropping back to full history.
                return {
                    kind: "retryable-failure",
                    cut: "definitely-no-cut",
                    error: new Error(
                        `no user boundary found at or before endMessageId ${pending.endMessageId} (ordinal ${pending.ordinal}); preserving existing boundary`,
                    ),
                };
            }
            // THIS RECORD HAS READERS — it is not bookkeeping for its own sake.
            // Three places read it back, and deleting the write breaks all three:
            //   1. `trimToRecordedBoundary` below, which is what bounds the array
            //      handed to the module on a host that wrote no compaction row;
            //   2. the post-fold restore in src/v2/hooks/context.ts, which uses
            //      `boundaryMessageId` to bound how much pre-cut history it puts
            //      back behind the host's compaction cut;
            //   3. `markerAt` / `persistedBoundaryOrdinal` in
            //      hooks/magic-context/rust-mode-transform.ts, which report the
            //      boundary on the coverage line and gate note-nudge publication.
            const state: PersistedCompactionMarkerState = {
                boundaryMessageId: boundary.id,
                // OpenCode 2 writes no summary message and no parts for it. The
                // columns stay in the record so every existing reader keeps its
                // shape; empty means "this host carries no marker rows".
                summaryMessageId: "",
                compactionPartId: "",
                summaryPartId: "",
                boundaryOrdinal: pending.ordinal,
                targetEndMessageId: pending.endMessageId,
            };
            setPersistedCompactionMarkerState(db as ContextDatabase, sessionId, state);
            sessionLog(
                sessionId,
                `v2 boundary recorded at ordinal ${pending.ordinal}, boundary message ${boundary.id}`,
            );
            return { kind: "applied", markerOrdinal: pending.ordinal };
        },
    };
}

/**
 * Drop everything before the recorded boundary from the array about to be sent.
 *
 * This is the trim OpenCode 1 gets for free from its compaction row. OpenCode 2
 * writes such a row only when it decides to compact, and a healthy Rust-mode
 * session folds before the host's own trigger is ever reached — so on the normal
 * path there is no host cut and this is the ONLY thing that keeps a folded
 * session from handing the module its whole history again on every later turn.
 * Measured with it removed: the array handed to the module grew from 15 to 53
 * messages over twenty post-fold turns while the boundary stood still.
 *
 * It is silent when the host HAS cut, because the boundary message is then
 * already gone from the array. An earlier pass mutated it under a fixture whose
 * mock reported a constant usage — which kept the host compacting on every turn,
 * and therefore always cutting — and concluded from the silence that it never
 * fires at all.
 *
 * Returns the number of messages removed. A boundary that is not in the array is
 * left alone: it either has not been reached yet or belongs to history the host
 * has already dropped, and guessing in either direction would change what the
 * model sees.
 */
export function trimToRecordedBoundary(
    db: ContextDatabase,
    sessionId: string,
    messages: Array<{ id?: string; role?: string; ordinal?: number }>,
): number {
    const marker = getPersistedCompactionMarkerState(db, sessionId);
    const boundaryId = marker?.boundaryMessageId;
    if (!boundaryId) return 0;
    const start = messages.findIndex((message) => message.id === boundaryId);
    if (start <= 0) return 0;
    const provider = getOpenCodeProviderProjection(sessionId);
    // An unseen id belongs to the admission scan, not to the old coverage. Never
    // substitute a store position for it: a middle insertion appends at the tail.
    if (provider && messages.slice(0, start).some((m) => !m.id || !provider.ids.has(m.id)))
        return 0;
    // An indexed end (end_block_index set) may leave later blocks of that message
    // unsummarized, so the trim must never cut past such a message while its
    // remainder is uncovered. The remainder counts as covered once the next
    // compartment continues exactly where this one stopped: on the same message at
    // a later block, or on the next message ordinal. Both indices the historian
    // publishes are last-block anchors (every chunk line covers a whole host
    // message and is anchored at its last block), so a successor's start index
    // cannot be required to equal end+1 or 0; the ordinal continuation is what
    // proves nothing was skipped. The latest compartment has no successor, so its
    // indexed end always stays protected, and so does any end followed by a gap.
    const uncovered = new Set(
        getUncoveredCompartmentEndsThrough(db, sessionId).map((end) => end.endMessageId),
    );
    let partialIndex = messages.findIndex(
        (message) => message.id !== undefined && uncovered.has(message.id),
    );
    // Endpoint visibility is not coverage of the raw span: a host cut/revert can
    // remove an old endpoint but leave a real message in its successor gap.
    // Resolve the visible prefix in the host's actual ordinal space. The provider
    // range read returns ids only, never decodes full-history message bodies.
    const ranges = db
        .prepare(
            "SELECT start_message AS start, end_message AS end FROM compartments WHERE session_id=? ORDER BY start_message, end_message",
        )
        .all(sessionId) as Array<{ start: number; end: number }>;
    const coveredRanges: Array<{ start: number; end: number }> = [];
    for (const range of ranges) {
        if (
            !Number.isSafeInteger(range.start) ||
            !Number.isSafeInteger(range.end) ||
            range.start < 0 ||
            range.end < range.start
        )
            continue;
        const previous = coveredRanges.at(-1);
        if (previous && range.start <= previous.end + 1)
            previous.end = Math.max(previous.end, range.end);
        else coveredRanges.push({ ...range });
    }
    const covers = (ordinal: number | undefined): boolean => {
        if (ordinal === undefined || !Number.isSafeInteger(ordinal)) return false;
        let low = 0,
            high = coveredRanges.length - 1;
        while (low <= high) {
            const middle = (low + high) >>> 1;
            const range = coveredRanges[middle];
            if (!range) return false;
            if (ordinal < range.start) high = middle - 1;
            else if (ordinal > range.end) low = middle + 1;
            else return true;
        }
        return false;
    };
    let ordinals: ReadonlyMap<string, number> | undefined = provider?.ids;
    const prefix = messages.slice(0, start);
    if (
        !provider &&
        !prefix.every(
            (message) => Number.isSafeInteger(message.ordinal) && (message.ordinal ?? -1) >= 1,
        )
    ) {
        if (!hasRawMessageProvider(sessionId)) return 0;
        try {
            const cutOrdinal = readRawSessionMessageOrdinalById(sessionId, boundaryId);
            if (cutOrdinal === null || cutOrdinal <= 1) return 0;
            ordinals = readRawSessionMessageIdOrdinalsForRange(sessionId, 1, cutOrdinal - 1);
        } catch {
            return 0;
        }
    }
    for (let index = 0; index < start; index++) {
        const message = messages[index];
        if (!message) return 0;
        const ordinal = ordinals
            ? message.id
                ? ordinals.get(message.id)
                : undefined
            : message.ordinal;
        const covered = covers(ordinal);
        if (!covered) {
            partialIndex = partialIndex >= 0 ? Math.min(partialIndex, index) : index;
            break;
        }
    }
    // The recorded cut can predate this guard; never remove a visible
    // partially covered message even when that old cut lies after it.
    let safeStart = partialIndex >= 0 ? Math.min(start, partialIndex) : start;
    if (partialIndex >= 0 && partialIndex < start) {
        // A partial assistant/tool endpoint is not a valid turn boundary. Roll
        // back to its user; if roles or that user are absent, do not guess a cut.
        while (safeStart > 0 && messages[safeStart]?.role !== "user") safeStart--;
        if (messages[safeStart]?.role !== "user") return 0;
    }
    if (safeStart <= 0) return 0;
    messages.splice(0, safeStart);
    return safeStart;
}
