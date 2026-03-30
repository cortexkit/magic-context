import type { ContextDatabase } from "../../features/magic-context/storage";
import {
    getPendingOps,
    getTagsBySession,
    removePendingOp,
    updateTagStatus,
} from "../../features/magic-context/storage";
import type { TagEntry } from "../../features/magic-context/types";
import type { TagTarget } from "./tag-messages";
export function applyPendingOperations(
    sessionId: string,
    db: ContextDatabase,
    targets: Map<number, TagTarget>,
    protectedTags: number = 0,
    preloadedTags?: TagEntry[],
    preloadedPendingOps?: ReturnType<typeof getPendingOps>,
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

        for (const pendingOp of pendingOps) {
            const tagStatus = tagStatusById.get(pendingOp.tagId);
            if (tagStatus === "compacted" || tagStatus === "dropped") {
                removePendingOp(db, sessionId, pendingOp.tagId);
                continue;
            }

            if (protectedTagIds.has(pendingOp.tagId)) {
                continue;
            }

            const target = targets.get(pendingOp.tagId);
            const isToolTag = tagTypeById.get(pendingOp.tagId) === "tool";

            if (isToolTag) {
                const dropResult = target?.drop?.() ?? "absent";
                if (dropResult === "incomplete") {
                    continue;
                }
                if (dropResult === "removed") {
                    didMutateMessage = true;
                }
            } else if (target) {
                const changed = target.setContent(`[dropped \u00a7${pendingOp.tagId}\u00a7]`);
                if (changed) didMutateMessage = true;
            }

            updateTagStatus(db, sessionId, pendingOp.tagId, "dropped");
            removePendingOp(db, sessionId, pendingOp.tagId);
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
                const dropResult = target?.drop?.() ?? "absent";
                if (dropResult === "removed") {
                    didMutateMessage = true;
                }
            } else if (target) {
                const changed = target.setContent(`[dropped \u00a7${tag.tagNumber}\u00a7]`);
                if (changed) didMutateMessage = true;
            }
        }
    }
    return didMutateMessage;
}
