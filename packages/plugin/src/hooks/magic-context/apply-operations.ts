import type { ContextDatabase } from "../../features/magic-context/storage";
import {
    getPendingOps,
    getTagsBySession,
    removePendingOp,
    updateTagDropMode,
    updateTagStatus,
} from "../../features/magic-context/storage";
import type { PendingOp, TagEntry } from "../../features/magic-context/types";
import type { TagTarget } from "./tag-messages";

// Max characters kept from the original user content when a user-message tag
// is dropped. ~250 characters maps to ~50 Claude tokens (1 token ≈ 4-5 chars
// for English prose). Keeps the ai-tokenizer dependency in scripts only.

/**
 * Agent-initiated (ctx_reduce) drops of a tool call within the newest N tool
 * calls keep a structural skeleton — the tool_use/tool_result pair survives
 * with the canonical `[dropped §N§]` placeholder as its output — instead of
 * being removed outright. (Long input arg VALUES are separately clamped with
 * `...[truncated]`: that's value-shortening, not a drop, so it keeps its own
 * marker.)
 *
 * WHY: when every recent tool call vanishes from the wire, models (especially
 * smaller ones) lose the anchors showing what they actually did and start
 * hallucinating fake tool-call shapes (the §N§ cargo-culting failure mode).
 * Keeping skeletons in the recent band structurally prevents that class.
 * Older drops still remove the full structure — deep history needs no anchors.
 *
 * CACHE SAFETY: the mode is decided once, at drop time (always a
 * cache-busting pass), persisted in `tags.drop_mode`, and replayed
 * byte-identically by `applyFlushedStatuses` on every later pass. A skeleton
 * is NEVER demoted to a full drop afterwards — that second mutation would be
 * a mid-prefix rewrite on some later pass (the volatile-boundary bust class).
 * Emergency drops and heuristic dedup stay full-drop: emergency wants max
 * reclaim on an already-busting pass, and dedup keeps the newest duplicate's
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
export function applyPendingOperations(
    sessionId: string,
    db: ContextDatabase,
    targets: Map<number, TagTarget>,
    protectedTags: number = 0,
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
): boolean {
    let didMutateMessage = false;
    db.transaction(() => {
        const tags = preloadedTags ?? getTagsBySession(db, sessionId);
        const tagStatusById = new Map(tags.map((tag) => [tag.tagNumber, tag.status] as const));
        const tagTypeById = new Map(tags.map((tag) => [tag.tagNumber, tag.type] as const));
        const protectedTagIds =
            protectedTags > 0
                ? new Set(
                      tags
                          .filter((tag) => tag.status === "active")
                          .map((tag) => tag.tagNumber)
                          .sort((left, right) => right - left)
                          .slice(0, protectedTags),
                  )
                : new Set<number>();

        const pendingOps = preloadedPendingOps ?? getPendingOps(db, sessionId);
        const opsToApply: Array<{ op: PendingOp; synthetic: boolean }> = [
            ...pendingOps.map((op) => ({ op, synthetic: false })),
            ...syntheticPendingOps.map((op) => ({ op, synthetic: true })),
        ];

        // Newest-K tool calls at THIS moment — the skeleton window. Computed
        // once per apply pass over all tool tags (any status: the window
        // reflects conversation recency, not droppability).
        const skeletonWindow = new Set(
            tags
                .filter((tag) => tag.type === "tool")
                .map((tag) => tag.tagNumber)
                .sort((left, right) => right - left)
                .slice(0, RECENT_TOOL_SKELETON_WINDOW),
        );

        for (const { op: pendingOp, synthetic } of opsToApply) {
            const tagStatus = tagStatusById.get(pendingOp.tagId);
            if (tagStatus === "compacted" || tagStatus === "dropped") {
                if (!synthetic) removePendingOp(db, sessionId, pendingOp.tagId);
                continue;
            }

            if (protectedTagIds.has(pendingOp.tagId)) {
                continue;
            }

            const target = targets.get(pendingOp.tagId);
            const isToolTag = tagTypeById.get(pendingOp.tagId) === "tool";

            if (synthetic) {
                // A smart-drop must never persist a DB-only drop for
                // a tag that is absent/incomplete on this pass's visible wire. It
                // only rides an already-mutating pass when the target can actually
                // reclaim bytes right now; real pending ops keep their legacy
                // absent persistence semantics for user-requested ctx_reduce.
                if (!isToolTag || target?.canDrop?.() !== true) continue;
            }

            let shouldPersistDrop = false;
            if (isToolTag) {
                if (editMarkerTagIds.has(pendingOp.tagId)) {
                    // Superseded edit/write: compress to a filePath-preserving
                    // marker even when the tag is inside the recent skeleton
                    // window. Frozen as drop_mode="edit_marker", replayed by mode.
                    const markResult = target?.editMarker?.() ?? "absent";
                    if (markResult === "incomplete" || markResult === "absent") {
                        continue;
                    }
                    didMutateMessage = true;
                    updateTagDropMode(db, sessionId, pendingOp.tagId, "edit_marker");
                    shouldPersistDrop = true;
                } else if (skeletonWindow.has(pendingOp.tagId)) {
                    const truncResult = target?.truncate?.() ?? "absent";
                    if (
                        truncResult === "incomplete" ||
                        (synthetic && truncResult !== "truncated")
                    ) {
                        continue;
                    }
                    if (truncResult === "truncated") {
                        didMutateMessage = true;
                    }
                    updateTagDropMode(db, sessionId, pendingOp.tagId, "truncated");
                    shouldPersistDrop = true;
                } else {
                    const dropResult = target?.drop?.() ?? "absent";
                    if (dropResult === "incomplete" || (synthetic && dropResult !== "removed")) {
                        continue;
                    }
                    if (dropResult === "removed") {
                        didMutateMessage = true;
                    }
                    updateTagDropMode(db, sessionId, pendingOp.tagId, "full");
                    shouldPersistDrop = true;
                }
            } else if (target) {
                const changed = target.setContent(buildReplacementContent(pendingOp.tagId));
                if (changed) didMutateMessage = true;
                shouldPersistDrop = true;
            } else if (!synthetic) {
                shouldPersistDrop = true;
            }

            if (!shouldPersistDrop) continue;
            updateTagStatus(db, sessionId, pendingOp.tagId, "dropped");
            if (!synthetic) removePendingOp(db, sessionId, pendingOp.tagId);
        }
    })();
    return didMutateMessage;
}

export function applyFlushedStatuses(
    sessionId: string,
    db: ContextDatabase,
    targets: Map<number, TagTarget>,
    preloadedTags?: TagEntry[],
): boolean {
    let didMutateMessage = false;
    const tags = preloadedTags ?? getTagsBySession(db, sessionId);

    for (const tag of tags) {
        if (tag.status === "dropped") {
            const target = targets.get(tag.tagNumber);
            if (tag.type === "tool") {
                if (tag.dropMode === "edit_marker") {
                    const markResult = target?.editMarker?.() ?? "absent";
                    if (markResult === "truncated") {
                        didMutateMessage = true;
                    }
                } else if (tag.dropMode === "truncated") {
                    const truncResult = target?.truncate?.() ?? "absent";
                    if (truncResult === "truncated") {
                        didMutateMessage = true;
                    }
                } else {
                    const dropResult = target?.drop?.() ?? "absent";
                    if (dropResult === "removed") {
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
