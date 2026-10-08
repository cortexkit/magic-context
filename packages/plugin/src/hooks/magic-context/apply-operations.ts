import type { ContextDatabase } from "../../features/magic-context/storage";
import {
    getDroppedTagsByNumbers,
    getNewestToolTagNumbers,
    getPendingOps,
    getTagsByNumbers,
    removePendingOp,
    updateTagDropMode,
    updateTagStatus,
} from "../../features/magic-context/storage";
import type { PendingOp, TagEntry } from "../../features/magic-context/types";
import { sessionLog } from "../../shared/logger";
import { logSlowWriteTransaction } from "../../shared/write-transaction-timing";
import type { DroppedTokenReduction } from "./dropped-token-estimate";
import type { TagTarget } from "./tag-messages";
import type { ToolDropResult } from "./tool-drop-target";
import { SKELETON_REAL_INPUT_MAX_BYTES } from "./tool-input-size";

// Max characters kept from the original user content when a user-message tag
// is dropped. ~250 characters maps to ~50 Claude tokens (1 token ≈ 4-5 chars
// for English prose). Keeps the ai-tokenizer dependency in scripts only.

/**
 * Agent-initiated (ctx_reduce) and emergency drops of a tool call within the
 * newest N tool calls keep a structural skeleton when the call's input is
 * small: the tool_use/tool_result pair survives with its REAL arguments and
 * the canonical `[dropped §N§]` placeholder as its output (`skeleton_real`).
 * A large input is removed outright, like a drop outside the window.
 *
 * WHY a skeleton: when every recent tool call vanishes from the wire, models
 * (especially smaller ones) lose the anchors showing what they actually did
 * and start writing fake tool calls as plain text. Keeping skeletons in the
 * recent band prevents that. Older drops still remove the full structure.
 *
 * WHY real arguments: every synthetic value previously put in the argument
 * position (5-character clamps, then a `{"dropped": "[dropped §N§]"}` marker)
 * was copied by models into new calls, which then ran with garbage arguments
 * or looped on the dropped-input guard's refusal. A dropped call's arguments
 * are therefore either the real ones or absent. The size rule lives in
 * tool-input-size.ts.
 *
 * CACHE SAFETY: the mode is decided once, at drop time (always a
 * cache-busting pass), persisted in `tags.drop_mode`, and replayed
 * byte-identically by `applyFlushedStatuses` on every later pass. A skeleton
 * is NEVER demoted to a full drop afterwards — that second mutation would be
 * a mid-prefix rewrite on some later pass (the volatile-boundary bust class).
 * Emergency drops use the same newest-window skeleton rule as agent drops;
 * heuristic dedup stays full-drop because dedup keeps the newest duplicate's
 * full content as the nearby anchor.
 */
export const RECENT_TOOL_SKELETON_WINDOW = 20;

// ONE canonical placeholder for every non-tool (message) drop, on every path,
// every pass. It is a PURE function of tagId — it reads NO message content, role,
// or window state. That is the whole point: any version that derived bytes from
// the current (already-mutated) content re-derived a DIFFERENT placeholder across
// passes (e.g. `[dropped §N§]` on one pass, `[truncated §N§]\n…` on the next),
// which on a defer pass changes a tail message's bytes and busts the entire
// prompt-cache prefix after it. This exact divergence caused repeated cache
// catastrophes. The bytes here are byte-identical to heuristic-cleanup.ts's
// `[dropped §${n}§]`, so the two drop paths can never disagree. (We deliberately
// dropped the old user-text preview variant — a minor nicety that was the sole
// source of the instability.)
export function buildReplacementContent(tagId: number): string {
    return `[dropped \u00a7${tagId}\u00a7]`;
}
export interface NewToolDropOutcome {
    result: ToolDropResult;
    /** The drop mode to persist so every later pass replays the same bytes. */
    mode: "skeleton_real" | "skeleton_stripped" | "full";
}

/**
 * Apply a NEW drop of a tool call under the real-or-absent rule and report
 * the mode to persist:
 *  1. inside the newest-call window with a small input: keep the call with its
 *     real arguments, output -> `[dropped §N§]` (`skeleton_real`);
 *  2. otherwise remove the call and its result (`full`);
 *  3. except when the call cannot be removed: its result ends the request
 *     (drop() then keeps it, see ToolMutationBatch.wouldStrandConversationEnd),
 *     the host adapter cannot remove it structurally, or the caller requires a
 *     paired skeleton (`keepSkeleton`, e.g. beside native reasoning). Those keep
 *     the REAL arguments too; nothing is ever written into the argument position.
 */
export function applyNewToolDrop(
    target: TagTarget | undefined,
    options: { inWindow: boolean; keepSkeleton?: boolean },
): NewToolDropOutcome {
    if (!target) return { result: "absent", mode: "full" };
    if (
        (options.inWindow && hasSmallToolInput(target)) ||
        options.keepSkeleton === true ||
        target.cannotRemove?.() === true
    ) {
        const strip = target.hasAttachments?.() === true;
        return {
            result: (strip ? target.skeletonStripped?.() : target.skeletonReal?.()) ?? "absent",
            mode: strip ? "skeleton_stripped" : "skeleton_real",
        };
    }
    const result = target.drop?.() ?? "absent";
    // A result at the end of the request cannot be removed without leaving a
    // dangling call. When drop() keeps that call as a skeleton, strip its media
    // and persist the choice; older skeleton modes still replay their media.
    if (result === "truncated" && target.hasAttachments?.() === true) {
        return { result: target.skeletonStripped?.() ?? "absent", mode: "skeleton_stripped" };
    }
    return { result, mode: result === "truncated" ? "skeleton_real" : "full" };
}

/** True when a drop of this call inside the newest-call window keeps real arguments. */
export function hasSmallToolInput(target: TagTarget | undefined): boolean {
    const bytes = target?.inputStringBytes?.() ?? null;
    return bytes !== null && bytes <= SKELETON_REAL_INPUT_MAX_BYTES;
}

export type ConvertedToolDropMode = "skeleton_real" | "full";

/**
 * HARD fold reasons whose trigger already loses the provider's cached prefix
 * whatever bytes Magic Context serves: a different model has its own cache, a
 * changed system prompt precedes every message, an idle TTL expiry means the
 * cache was evicted, and a native host compaction replaced the conversation
 * after the prefix. Other reasons only bust when the fold changes the served
 * bytes (see foldChangesServedPrefix).
 */
export const CACHE_LOSING_FOLD_REASONS: ReadonlySet<string> = new Set([
    "model_change",
    "system_hash",
    "ttl_idle",
    "host_compaction",
]);

/**
 * The cached m[0]/m[1] bytes a pass serves ahead of the conversation tail, plus
 * the mural image served with m[0] (null when no image is served). The mural is
 * required so no caller can leave the image out of the comparison: a changed
 * image is a changed served prefix even when the text is identical.
 */
export interface ServedPrefixBytes {
    m0Bytes: Uint8Array | null;
    m1Bytes: Uint8Array | null;
    muralDataUrl: string | null;
}

function sameBytes(left: Uint8Array | null, right: Uint8Array | null): boolean {
    if (left === null || right === null) return left === right;
    return Buffer.compare(Buffer.from(left), Buffer.from(right)) === 0;
}

/**
 * Does a HARD fold change the prefix bytes served ahead of every tool call?
 * Any difference counts: m[0] text, m[1] text, or the mural image, including
 * an image that appears or disappears. A fold that re-renders all of them
 * byte-identically keeps the provider's cached prefix.
 */
export function foldChangesServedPrefix(
    before: ServedPrefixBytes,
    after: ServedPrefixBytes,
): boolean {
    if (!sameBytes(before.m0Bytes, after.m0Bytes)) return true;
    if (!sameBytes(before.m1Bytes, after.m1Bytes)) return true;
    return before.muralDataUrl !== after.muralDataUrl;
}

/**
 * The single bust permission an executed HARD fold grants. True when the fold
 * loses the provider's cached prefix anyway: its trigger evicts the cache
 * (CACHE_LOSING_FOLD_REASONS) or it changes the m[0]/m[1]/mural bytes served
 * ahead of the tail. A fold that re-renders the prefix byte-identically, such
 * as a memory epoch bump, an upgrade marker or a mutation-log entry with no
 * rendered-content change, keeps the provider cache alive, and any lane riding
 * it would make itself the pass's only bust. Every lane that rides a fold
 * consults this one decision: legacy skeleton conversion, pending-op drains,
 * heuristic cleanup, synthetic todo and sentinel first-application. OpenCode
 * and Pi both call it.
 */
export function foldBustsServedPrefix(
    reason: string | null | undefined,
    before: ServedPrefixBytes,
    after: ServedPrefixBytes,
): boolean {
    return CACHE_LOSING_FOLD_REASONS.has(reason ?? "") || foldChangesServedPrefix(before, after);
}

/**
 * Convert every dropped tool call that still serves the legacy
 * `{"dropped": "[dropped §N§]"}` argument marker to the real-or-absent rule,
 * persisting the new mode, and return the conversions so the caller can render
 * them on this pass's wire.
 *
 * Call this ONLY inside the transaction that records an executing HARD fold.
 * That pass rebuilds the whole prefix anyway, so the changed bytes ride the
 * same cache bust; on every other pass the legacy tags keep replaying their
 * marker byte-identically. Deciding here and persisting the mode means later
 * passes never re-decide (never demote, never restore).
 *
 * Legacy tags are `drop_mode = 'truncated'`, plus `full` tags whose host
 * adapter cannot remove the call and so replays a marker instead (Pi). Each is
 * re-decided from its real input: small -> `skeleton_real`; large -> `full`,
 * unless the call cannot be removed (it ends the request, the adapter cannot
 * remove it, or it sits beside native reasoning), which keeps real arguments.
 * The legacy marker was only ever written inside the newest-call window or for
 * a call that could not be removed, so every legacy tag is re-decided as an
 * in-window drop. Tags not on this pass's wire stay as they are.
 *
 * `keepFullDrop` lets a host exempt `full` tags whose removal it has already
 * recorded. Pi records the first structural removal of each arc; such a call
 * was removed, not served as a marker, and it may only look unremovable on this
 * pass (a model that needs tool pairs beside its reasoning). Converting it
 * would keep the call on every later pass, including ones that can remove it.
 */
export function convertLegacyToolSkeletons(
    db: ContextDatabase,
    sessionId: string,
    targets: ReadonlyMap<number, TagTarget>,
    options: { keepFullDrop?: (callId: string | null) => boolean } = {},
): Map<number, ConvertedToolDropMode> {
    const prepared = prepareLegacyToolSkeletonConversions(db, sessionId, targets, options);
    prepared.persist(db);
    return prepared.converted;
}

/** Traverse the wire before writer admission; commit only if the tag rows still match. */
export function prepareLegacyToolSkeletonConversions(
    db: ContextDatabase,
    sessionId: string,
    targets: ReadonlyMap<number, TagTarget>,
    options: { keepFullDrop?: (callId: string | null) => boolean } = {},
) {
    const readRows = (connection: ContextDatabase) =>
        connection
            .prepare(
                `SELECT tag_number AS tagNumber, drop_mode AS dropMode, message_id AS callId
               FROM tags
              WHERE session_id = ? AND type = 'tool' AND status = 'dropped'
                AND drop_mode IN ('truncated', 'full')
              ORDER BY tag_number`,
            )
            .all(sessionId) as Array<{
            tagNumber: number;
            dropMode: string;
            callId: string | null;
        }>;
    const rows = readRows(db);
    const identity = JSON.stringify(rows);
    const converted = new Map<number, ConvertedToolDropMode>();
    for (const row of rows) {
        const target = targets.get(row.tagNumber);
        if (target?.canDrop?.() !== true) continue;
        const cannotRemove =
            target.cannotRemove?.() === true ||
            target.requiresToolArcSkeleton === true ||
            target.wouldStrandConversationEnd?.() === true;
        let mode: ConvertedToolDropMode;
        if (row.dropMode === "full") {
            if (options.keepFullDrop?.(row.callId) === true) continue;
            // Removable full drops already serve real-or-absent bytes.
            if (target.cannotRemove?.() !== true) continue;
            mode = "skeleton_real";
        } else {
            mode = hasSmallToolInput(target) || cannotRemove ? "skeleton_real" : "full";
        }
        converted.set(row.tagNumber, mode);
    }
    return {
        converted,
        isCurrent: (connection: ContextDatabase) =>
            JSON.stringify(readRows(connection)) === identity,
        persist: (connection: ContextDatabase) => {
            for (const [tagNumber, mode] of converted)
                updateTagDropMode(connection, sessionId, tagNumber, mode);
        },
    };
}

/** Render conversions from convertLegacyToolSkeletons on this pass's wire. */
export function renderConvertedToolSkeletons(
    targets: ReadonlyMap<number, TagTarget>,
    converted: ReadonlyMap<number, ConvertedToolDropMode>,
): boolean {
    let didMutate = false;
    for (const [tagNumber, mode] of converted) {
        const target = targets.get(tagNumber);
        const result =
            mode === "skeleton_real"
                ? (target?.skeletonReal?.() ?? "absent")
                : (target?.drop?.() ?? "absent");
        if (result === "removed" || result === "truncated") didMutate = true;
    }
    return didMutate;
}

export interface PendingOperationBatchDiagnostics {
    source: "pending" | "synthetic" | "mixed";
    total: number;
    mutated: number;
    persistedWithoutMutation: number;
    reasons: Record<string, number>;
}

export function applyPendingOperations(
    sessionId: string,
    db: ContextDatabase,
    targets: Map<number, TagTarget>,
    /**
     * Union projection form: protectedTagIds (set form).
     * Coordinate space: tag-number space (Set<number> of member tool tag numbers).
     * Empty-window behavior: an empty set means zero tool tags are protected by the window;
     * non-tool (message/file) tags never become reclaim targets through any window form,
     * their eligibility remaining decided solely by the independent protections.
     */
    protectedTagIds: ReadonlySet<number>,
    preloadedTags?: TagEntry[],
    preloadedPendingOps?: ReturnType<typeof getPendingOps>,
    syntheticPendingOps: PendingOp[] = [],
    /**
     * Smart-drops: tag ids to compress as an edit_marker (an edit/write
     * superseded by a later edit to the same file) instead of a full/skeleton
     * drop. Synthetic-only: these are selected for the current apply pass;
     * replay reads the frozen drop_mode, not this set.
     */
    editMarkerTagIds: ReadonlySet<number> = new Set(),
    /** Reports only reductions that changed the live message representation. */
    onTagReduced?: (reduction: DroppedTokenReduction) => void,
    /** Reports why selected operations did or did not change the visible payload. */
    onBatchComplete?: (diagnostics: PendingOperationBatchDiagnostics) => void,
): boolean {
    let didMutateMessage = false;
    let diagnostics: PendingOperationBatchDiagnostics | undefined;
    const reject = (reason: string): void => {
        if (!diagnostics) return;
        diagnostics.reasons[reason] = (diagnostics.reasons[reason] ?? 0) + 1;
    };
    let admitted = false;
    let startedAt = 0;
    try {
        db.transaction(() => {
            admitted = true;
            startedAt = performance.now();
            const pendingOps = preloadedPendingOps ?? getPendingOps(db, sessionId);
            // Load only the rows this batch reads: the operations' own tags. A
            // full getTagsBySession load (every tag the session ever had, about
            // 100k rows on a long session) ran here while this transaction held
            // the writer lock and cost over a second per call.
            const tags =
                preloadedTags ??
                getTagsByNumbers(db, sessionId, [
                    ...new Set([
                        ...pendingOps.map((op) => op.tagId),
                        ...syntheticPendingOps.map((op) => op.tagId),
                    ]),
                ]);
            const tagById = new Map(tags.map((tag) => [tag.tagNumber, tag] as const));
            const tagStatusById = new Map(tags.map((tag) => [tag.tagNumber, tag.status] as const));
            const tagTypeById = new Map(tags.map((tag) => [tag.tagNumber, tag.type] as const));
            const opsToApply: Array<{ op: PendingOp; synthetic: boolean }> = [
                ...pendingOps.map((op) => ({ op, synthetic: false })),
                ...syntheticPendingOps.map((op) => ({ op, synthetic: true })),
            ];
            diagnostics = {
                source:
                    pendingOps.length > 0 && syntheticPendingOps.length > 0
                        ? "mixed"
                        : syntheticPendingOps.length > 0
                          ? "synthetic"
                          : "pending",
                total: opsToApply.length,
                mutated: 0,
                persistedWithoutMutation: 0,
                reasons: {},
            };

            // Newest-K tool calls at THIS moment — the skeleton window. Computed
            // once per apply pass over all tool tags (any status: the window
            // reflects conversation recency, not droppability). Preloaded tags
            // carry the window rows (getTagsForPendingOperations); otherwise an
            // index walk reads just those K tag numbers.
            const skeletonWindow = new Set(
                preloadedTags
                    ? tags
                          .filter((tag) => tag.type === "tool")
                          .map((tag) => tag.tagNumber)
                          .sort((left, right) => right - left)
                          .slice(0, RECENT_TOOL_SKELETON_WINDOW)
                    : getNewestToolTagNumbers(db, sessionId, RECENT_TOOL_SKELETON_WINDOW),
            );

            for (const { op: pendingOp, synthetic } of opsToApply) {
                let operationMutated = false;
                const tagStatus = tagStatusById.get(pendingOp.tagId);
                if (tagStatus === "compacted" || tagStatus === "dropped") {
                    reject("already_reduced");
                    if (!synthetic) removePendingOp(db, sessionId, pendingOp.tagId);
                    continue;
                }

                if (protectedTagIds.has(pendingOp.tagId)) {
                    reject("protected");
                    continue;
                }

                const target = targets.get(pendingOp.tagId);
                const isToolTag = tagTypeById.get(pendingOp.tagId) === "tool";

                if (synthetic) {
                    // Synthetic two-pass reclaim must never persist a DB-only drop for
                    // a tag that is absent/incomplete on this pass's visible wire. It
                    // only rides an already-mutating pass when the target can actually
                    // reclaim bytes right now; real pending ops keep their legacy
                    // absent persistence semantics for user-requested ctx_reduce.
                    if (!isToolTag) {
                        reject("synthetic_non_tool");
                        continue;
                    }
                    if (target?.canDrop?.() !== true) {
                        reject("synthetic_target_not_droppable");
                        continue;
                    }
                }

                let shouldPersistDrop = false;
                if (isToolTag) {
                    if (editMarkerTagIds.has(pendingOp.tagId)) {
                        // Superseded edit/write: compress to a filePath-preserving
                        // marker even when the tag is inside the recent skeleton
                        // window. Freeze the chosen render mode for later replay.
                        const strip = target?.hasAttachments?.() === true;
                        const markResult =
                            (strip ? target?.editMarkerStripped?.() : target?.editMarker?.()) ??
                            "absent";
                        if (markResult === "incomplete" || markResult === "absent") {
                            reject(`edit_marker_${markResult}`);
                            continue;
                        }
                        didMutateMessage = true;
                        operationMutated = true;
                        onTagReduced?.({ tagNumber: pendingOp.tagId, mode: "edit_marker" });
                        updateTagDropMode(
                            db,
                            sessionId,
                            pendingOp.tagId,
                            strip ? "edit_marker_stripped" : "edit_marker",
                        );
                        shouldPersistDrop = true;
                    } else {
                        // Real-or-absent: a small input inside the newest-call
                        // window keeps its real arguments; everything else is
                        // removed, except the call whose result ends the request
                        // (drop() keeps it with real arguments). Persist the mode
                        // applied so replays match this pass.
                        const { result: dropResult, mode: appliedMode } = applyNewToolDrop(target, {
                            inWindow: skeletonWindow.has(pendingOp.tagId),
                        });
                        if (
                            dropResult === "incomplete" ||
                            (synthetic && dropResult !== "removed" && dropResult !== "truncated")
                        ) {
                            reject(`drop_${dropResult}`);
                            continue;
                        }
                        if (dropResult === "removed" || dropResult === "truncated") {
                            didMutateMessage = true;
                            operationMutated = true;
                            onTagReduced?.({
                                tagNumber: pendingOp.tagId,
                                mode: appliedMode === "full" ? "full" : "truncated",
                            });
                        } else {
                            reject(`drop_${dropResult}`);
                        }
                        updateTagDropMode(db, sessionId, pendingOp.tagId, appliedMode);
                        shouldPersistDrop = true;
                    }
                } else if (target) {
                    const replacement = buildReplacementContent(pendingOp.tagId);
                    const priorContent = target.getContent?.();
                    const changed = target.setContent(replacement);
                    if (changed) {
                        didMutateMessage = true;
                        operationMutated = true;
                        const originalCharacters =
                            typeof priorContent === "string"
                                ? priorContent.length
                                : (tagById.get(pendingOp.tagId)?.byteSize ?? replacement.length);
                        onTagReduced?.({
                            tagNumber: pendingOp.tagId,
                            mode: "partial",
                            removedCharacters: Math.max(0, originalCharacters - replacement.length),
                        });
                    } else {
                        reject("content_unchanged");
                    }
                    shouldPersistDrop = true;
                } else if (!synthetic) {
                    reject("target_absent");
                    shouldPersistDrop = true;
                }

                if (!shouldPersistDrop) {
                    reject("not_persisted");
                    continue;
                }
                updateTagStatus(db, sessionId, pendingOp.tagId, "dropped");
                if (!synthetic) removePendingOp(db, sessionId, pendingOp.tagId);
                if (operationMutated) diagnostics.mutated += 1;
                else diagnostics.persistedWithoutMutation += 1;
            }
        }).immediate();
    } catch (error) {
        // Acquire the writer before reading tags or changing wire bytes. A WAL
        // read-to-write upgrade cannot wait under busy_timeout. Failed admission
        // leaves both the pending queue and this pass's representation untouched.
        if (
            !admitted &&
            /database (?:table )?is locked|sqlite_(busy|locked)/i.test(String(error))
        ) {
            sessionLog(
                sessionId,
                "pending operations write admission busy; retaining prior bytes for retry",
            );
            return false;
        }
        // Once mutation starts, rollback of SQLite alone cannot restore the wire.
        throw error;
    } finally {
        if (admitted) logSlowWriteTransaction("apply_pending_operations", startedAt);
    }
    if (diagnostics) {
        onBatchComplete?.(diagnostics);
        if (diagnostics.total > 0 && diagnostics.mutated === 0) {
            const reasons = Object.entries(diagnostics.reasons)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([reason, count]) => `${reason}:${count}`)
                .join(",");
            sessionLog(
                sessionId,
                `pending operations no-op: source=${diagnostics.source} total=${diagnostics.total} persisted=${diagnostics.persistedWithoutMutation} reasons=${reasons || "none"}`,
            );
        }
    }
    return didMutateMessage;
}

export function applyFlushedStatuses(
    sessionId: string,
    db: ContextDatabase,
    targets: Map<number, TagTarget>,
    preloadedTags?: TagEntry[],
): boolean {
    let didMutateMessage = false;
    // Rows without a target in the visible output cannot change that output.
    // Restrict fallback callers, including Pi, to dropped tags in the target map.
    const tags = preloadedTags ?? getDroppedTagsByNumbers(db, sessionId, [...targets.keys()]);

    for (const tag of tags) {
        if (tag.status === "dropped") {
            const target = targets.get(tag.tagNumber);
            if (tag.type === "tool") {
                if (tag.dropMode === "edit_marker_stripped") {
                    const result = target?.editMarkerStripped?.() ?? "absent";
                    if (result === "truncated") didMutateMessage = true;
                } else if (tag.dropMode === "edit_marker") {
                    const markResult = target?.editMarker?.() ?? "absent";
                    if (markResult === "truncated") {
                        didMutateMessage = true;
                    }
                } else if (tag.dropMode === "skeleton_stripped") {
                    const result = target?.skeletonStripped?.() ?? "absent";
                    if (result === "truncated") didMutateMessage = true;
                } else if (tag.dropMode === "skeleton_real") {
                    const result = target?.skeletonReal?.() ?? "absent";
                    if (result === "truncated") {
                        didMutateMessage = true;
                    }
                } else if (tag.dropMode === "truncated") {
                    // Legacy marker skeleton: replayed byte-identically until a
                    // HARD fold converts it (convertLegacyToolSkeletons).
                    const truncResult = target?.truncate?.() ?? "absent";
                    if (truncResult === "truncated") {
                        didMutateMessage = true;
                    }
                } else {
                    const dropResult = target?.drop?.() ?? "absent";
                    if (dropResult === "removed" || dropResult === "truncated") {
                        didMutateMessage = true;
                    }
                }
            } else if (target) {
                const changed = target.setContent(buildReplacementContent(tag.tagNumber));
                if (changed) didMutateMessage = true;
            }
        }
    }
    return didMutateMessage;
}
