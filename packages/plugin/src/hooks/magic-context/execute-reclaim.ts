import { sessionDecisionCalibration } from "../../features/magic-context/session-decision-calibration";
import { updateReplayDocument } from "../../features/magic-context/storage-replay-document";
import type { PendingOp, TagEntry } from "../../features/magic-context/types";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { capturePendingDropEligibility } from "./pending-drop-eligibility";
import { postprocessReplaySnapshot } from "./postprocess-read-cache";
import type { TagTarget } from "./tag-messages";

interface ExecuteReclaimState {
    heldPasses: number;
    floorOrdinal: number | null;
    floorPromptId: string | null;
}

const NAMESPACE = "executeReclaim";
const failedWrites = new WeakMap<Database, Set<string>>();

export function readExecuteReclaimState(db: Database, sessionId: string): ExecuteReclaimState {
    return parseState(postprocessReplaySnapshot(db, sessionId).executeReclaim);
}

function parseState(lane: unknown): ExecuteReclaimState {
    const value = lane as Partial<ExecuteReclaimState> | undefined;
    return {
        heldPasses: typeof value?.heldPasses === "number" ? Math.max(0, value.heldPasses) : 0,
        floorOrdinal: typeof value?.floorOrdinal === "number" ? value.floorOrdinal : null,
        floorPromptId: typeof value?.floorPromptId === "string" ? value.floorPromptId : null,
    };
}

export function writeExecuteReclaimState(
    db: Database,
    sessionId: string,
    patch: Partial<ExecuteReclaimState>,
): boolean {
    if (failedWrites.get(db)?.has(sessionId)) return false;
    try {
        const current = readExecuteReclaimState(db, sessionId);
        if (JSON.stringify(current) === JSON.stringify({ ...current, ...patch })) return true;
        if (
            !updateReplayDocument(db, sessionId, (doc) => {
                const previous = parseState(doc[NAMESPACE]);
                const state = { ...previous, ...patch };
                if (JSON.stringify(previous) === JSON.stringify(state)) return false;
                doc.version = 2;
                doc[NAMESPACE] = state;
                return true;
            })
        )
            throw new Error("Could not persist execute reclaim state");
        return true;
    } catch (error) {
        let failed = failedWrites.get(db);
        if (!failed) failedWrites.set(db, (failed = new Set()));
        failed.add(sessionId);
        sessionLog(
            sessionId,
            `execute reclaim state persistence failed; retaining existing policy: ${String(error)}`,
        );
        return false;
    }
}

export function clearExecuteReclaimState(db: Database, sessionId: string): void {
    writeExecuteReclaimState(db, sessionId, {
        heldPasses: 0,
        floorOrdinal: null,
        floorPromptId: null,
    });
}

export function maintainExecuteFloorMark(
    db: Database,
    sessionId: string,
    promptId: string | null,
    belowExecute: boolean,
): void {
    // Maintenance starts each primary pass. A failed prerequisite disables only
    // this pass's optional admission; the next pass recomputes from durable state.
    failedWrites.get(db)?.delete(sessionId);
    const state = readExecuteReclaimState(db, sessionId);
    if (
        state.floorOrdinal !== null &&
        (belowExecute || (promptId !== null && promptId !== state.floorPromptId))
    ) {
        writeExecuteReclaimState(db, sessionId, { floorOrdinal: null, floorPromptId: null });
    }
}

/** Estimate queued drops remaining after protected-tag, thinking and target-completeness checks. */
export function estimateExecuteReclaimTokens(args: {
    db: Database;
    sessionId: string;
    pendingOps: readonly PendingOp[];
    tags: readonly TagEntry[];
    targets: ReadonlyMap<number, TagTarget>;
    protectedTagIds: ReadonlySet<number>;
    /** Batch dry run of prepareDrop; it must leave durable state and wire bytes unchanged. */
    probePreparation?: (targets: ReadonlyMap<number, TagTarget>) => ReadonlySet<number>;
}): number {
    const eligible = capturePendingDropEligibility(args.targets, args.protectedTagIds);
    const queued = new Set(
        args.pendingOps.filter((op) => op.operation === "drop").map((op) => op.tagId),
    );
    const candidates = args.tags.filter(
        (tag) =>
            tag.status === "active" && queued.has(tag.tagNumber) && eligible.has(tag.tagNumber),
    );
    const preparationTargets = new Map<number, TagTarget>();
    for (const tag of candidates) {
        const target = args.targets.get(tag.tagNumber);
        if (target?.prepareDrop) preparationTargets.set(tag.tagNumber, target);
    }
    const prepared =
        preparationTargets.size === 0
            ? new Set<number>()
            : (args.probePreparation?.(preparationTargets) ??
              new Set(
                  [...preparationTargets]
                      .filter(([, target]) => target.prepareDrop?.() !== false)
                      .map(([number]) => number),
              ));
    const seed = sessionDecisionCalibration(args.db, args.sessionId);
    return candidates.reduce((total, tag) => {
        if (preparationTargets.has(tag.tagNumber) && !prepared.has(tag.tagNumber)) return total;
        const ratio = tag.type === "tool" ? seed.toolsRatio : seed.proseRatio;
        return total + Math.max(0, (tag.tokenCount ?? Math.ceil(tag.byteSize / 4)) * ratio);
    }, 0);
}

/**
 * The pure rule behind `originateExecuteReclaim`. A primary execute pass that
 * nothing else rebuilds, and on which no summary can come, rebuilds itself once
 * the queued work it can actually remove is worth it: at least 2% of the usable
 * window, or the third consecutive such pass holding that work. `heldPasses` is
 * the persisted count before this pass; the result is the count to persist.
 */
export function decideExecuteReclaim(args: {
    heldPasses: number;
    primaryExecute: boolean;
    summaryCanCome: boolean;
    alreadyBusting: boolean;
    reclaimableTokens: number;
    usableWindow: number;
}): { heldPasses: number; admitted: boolean } {
    const heldPasses =
        args.primaryExecute && args.reclaimableTokens > 0 && !args.alreadyBusting
            ? args.heldPasses + 1
            : 0;
    return {
        heldPasses,
        admitted:
            args.primaryExecute &&
            !args.alreadyBusting &&
            !args.summaryCanCome &&
            args.reclaimableTokens > 0 &&
            ((args.usableWindow > 0 && args.reclaimableTokens >= args.usableWindow * 0.02) ||
                heldPasses >= 3),
    };
}

/** Drops and cleanup may share an execute rebuild only when no historian run or unrendered summary is expected. */
export function originateExecuteReclaim(args: {
    db: Database;
    sessionId: string;
    primaryExecute: boolean;
    summaryCanCome: boolean;
    alreadyBusting: boolean;
    reclaimableTokens: number;
    usableWindow: number;
}): boolean {
    if (failedWrites.get(args.db)?.has(args.sessionId)) return false;
    const state = readExecuteReclaimState(args.db, args.sessionId);
    const decision = decideExecuteReclaim({ ...args, heldPasses: state.heldPasses });
    if (!writeExecuteReclaimState(args.db, args.sessionId, { heldPasses: decision.heldPasses }))
        return false;
    return decision.admitted;
}
