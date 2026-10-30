import {
    type CompactionMarkerReplacementOutcome,
    type CompactionMarkerState,
    findBoundaryUserMessage,
    type InjectCompactionMarkerArgs,
    inspectCompactionMarkerPublication,
    planCompactionMarker,
    replaceCompactionMarker,
    withCompactionMarkerPublicationLock,
} from "../../features/magic-context/compaction-marker";
import { getCompartmentsByEndMessageId } from "../../features/magic-context/compartment-storage";
import {
    compareAndSetCompactionMarkerPublicationState,
    getCompactionMarkerPublicationState,
    getDeferredClearedCompactionMarkerState,
    getPersistedCompactionMarkerState,
    type PersistedCompactionMarkerState,
} from "../../features/magic-context/storage-meta-persisted";
import {
    getTagNumberByMessageId,
    updateTagStatus,
} from "../../features/magic-context/storage-tags";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";

function samePair(left: CompactionMarkerState, right: CompactionMarkerState): boolean {
    return (
        left.boundaryMessageId === right.boundaryMessageId &&
        left.summaryMessageId === right.summaryMessageId &&
        left.compactionPartId === right.compactionPartId &&
        left.summaryPartId === right.summaryPartId
    );
}

/** Called only while regenerating a model request, never by startup or a cached-request replay. */
export function publishRecoverableCompactionMarker(
    db: Database,
    args: InjectCompactionMarkerArgs,
    targetIsCurrent: () => boolean,
): CompactionMarkerReplacementOutcome {
    const { sessionId } = args;
    let raw = "";
    let previous: PersistedCompactionMarkerState | null = null;
    let oldSummary: string | null = null;
    let intended: PersistedCompactionMarkerState | undefined;
    let reason = "publication-failed";
    let recovered: "pending-intent-recovered" | "adopted-existing-pair" | undefined;
    let cut: "definitely-no-cut" | "uncertain" = "uncertain";
    let writingState = false;
    const persist = (state: PersistedCompactionMarkerState): void => {
        writingState = true;
        db.transaction(() => {
            raw = compareAndSetCompactionMarkerPublicationState(db, sessionId, raw, state, null);
            if (previous && previous.summaryMessageId !== state.summaryMessageId) {
                const tag = getTagNumberByMessageId(
                    db,
                    sessionId,
                    `${previous.summaryMessageId}:p0`,
                );
                if (tag !== null) updateTagStatus(db, sessionId, tag, "dropped");
            }
        }).immediate();
        writingState = false;
        previous = state;
    };
    try {
        cut = getCompactionMarkerPublicationState(db, sessionId).pending
            ? "uncertain"
            : "definitely-no-cut";
        const result = withCompactionMarkerPublicationLock(
            (): CompactionMarkerReplacementOutcome => {
                const snapshot = getCompactionMarkerPublicationState(db, sessionId);
                if (snapshot.pending) cut = "uncertain";
                raw = snapshot.raw;
                previous =
                    getPersistedCompactionMarkerState(db, sessionId) ??
                    getDeferredClearedCompactionMarkerState(db, sessionId);
                oldSummary = previous?.summaryMessageId ?? null;
                if (
                    snapshot.pending &&
                    (snapshot.pending.boundaryOrdinal > args.endOrdinal ||
                        (snapshot.pending.boundaryOrdinal === args.endOrdinal &&
                            snapshot.pending.targetEndMessageId !== args.endMessageId))
                )
                    throw new Error("a newer marker publication intent is pending");
                const boundary = findBoundaryUserMessage(sessionId, args.endMessageId);
                if (
                    !targetIsCurrent() ||
                    !boundary ||
                    boundary.id !== args.resolvedBoundary?.id ||
                    boundary.timeCreated !== args.resolvedBoundary.timeCreated
                )
                    throw new Error("marker publication frontier changed before publication");
                intended = {
                    ...planCompactionMarker(args, boundary),
                    boundaryOrdinal: args.endOrdinal,
                    targetEndMessageId: args.endMessageId,
                };

                // A pending pair is recognized only from its exact target and deterministic
                // IDs. The generic summary text and nearby timestamps cannot identify
                // which compartment end was used to choose the boundary.
                let pending = snapshot.pending;
                if (pending) {
                    const pendingTarget = pending.targetEndMessageId;
                    const pendingBoundary = pendingTarget
                        ? findBoundaryUserMessage(sessionId, pendingTarget)
                        : null;
                    const compartments = pendingTarget
                        ? getCompartmentsByEndMessageId(db, sessionId, pendingTarget)
                        : [];
                    const validTarget =
                        (pending.targetEndMessageId === args.endMessageId &&
                            pending.boundaryOrdinal === args.endOrdinal) ||
                        (compartments.length === 1 &&
                            compartments[0].endMessage === pending.boundaryOrdinal);
                    if (
                        !validTarget ||
                        !pendingBoundary ||
                        !pendingTarget ||
                        !samePair(
                            pending,
                            planCompactionMarker(
                                { ...args, endMessageId: pendingTarget },
                                pendingBoundary,
                            ),
                        )
                    )
                        pending = null;
                }
                const inspection = inspectCompactionMarkerPublication(
                    sessionId,
                    [intended, ...(previous ? [previous] : []), ...(pending ? [pending] : [])],
                    args.summaryText,
                );
                if (inspection.kind === "deferred") {
                    reason = "candidate-preparation";
                    return {
                        kind: cut === "uncertain" ? "uncertain" : "deferred",
                        error: new Error("marker candidate preparation pending"),
                    };
                }
                if (inspection.kind === "ambiguous") {
                    reason = "ambiguous-left-alone";
                    return {
                        kind: cut,
                        error: new Error("unverified or ambiguous host marker pairs; left alone"),
                    };
                }
                cut = "definitely-no-cut";
                const host = inspection.marker;
                if (host && ((pending && samePair(host, pending)) || samePair(host, intended))) {
                    const adopted = pending && samePair(host, pending) ? pending : intended;
                    recovered =
                        adopted === pending ? "pending-intent-recovered" : "adopted-existing-pair";
                    // The host pair exists before its ownership record is finalized in context.db.
                    // OpenCode may now load different messages than the older cached request contains.
                    cut = "uncertain";
                    if (samePair(host, intended)) return { kind: "committed", marker: host };
                    persist(adopted);
                }
                // Preserve the existing JSON, including a cleared marker kept for replay,
                // and durably stage all four new IDs before touching the host rows.
                writingState = true;
                raw = compareAndSetCompactionMarkerPublicationState(
                    db,
                    sessionId,
                    raw,
                    previous,
                    intended,
                );
                writingState = false;
                cut = "uncertain";
                const replacement = replaceCompactionMarker(host, {
                    ...args,
                    resolvedBoundary: boundary,
                });
                if (recovered && replacement.kind !== "committed")
                    return { kind: "uncertain", error: replacement.error };
                if (replacement.kind !== "committed")
                    cut = replacement.kind === "uncertain" ? "uncertain" : "definitely-no-cut";
                return replacement;
            },
        );
        if (result.kind === "committed") {
            // The outer host transaction has committed. If this write fails, its
            // pending publication state still records the committed pair after a restart.
            if (!intended) throw new Error("committed marker has no publication intent");
            persist(intended);
            reason = recovered ?? "published";
        }
        return result;
    } catch (error) {
        if (writingState) reason = "state-write-failed";
        return { kind: cut, error: error instanceof Error ? error : new Error(String(error)) };
    } finally {
        sessionLog(
            sessionId,
            `compaction-marker publication reason=${reason} oldSummary=${oldSummary ?? "none"} newSummary=${intended?.summaryMessageId ?? "none"} target=${args.endMessageId} at=${Date.now()}`,
        );
    }
}
