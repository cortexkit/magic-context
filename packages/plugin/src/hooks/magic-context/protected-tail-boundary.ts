import { getLastCompartmentEndMessage } from "../../features/magic-context/compartment-storage";
import {
    loadProtectedTailMeta,
    markProtectedTailPolicyV3Seeded,
    recordProtectedTailNoEligibleHead,
    resetProtectedTailNoEligibleHead,
} from "../../features/magic-context/storage-meta-persisted";
import { getAllStatusTagTokenTotalsFlat } from "../../features/magic-context/storage-tags";
import { escalationBands } from "../../shared/escalation-bands";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { deriveTriggerBudget } from "./derive-budgets";
import {
    getCachedAbsoluteMessageCount,
    getLegacyProtectedTailStartOrdinal,
    readRawSessionMessages,
} from "./read-session-chunk";
import { hasMeaningfulUserText } from "./read-session-formatting";
import {
    buildToolArcs,
    buildTrueRawTokenIndex,
    completedToolArcCrossesBoundary,
    computeRawRangeFingerprint,
    fenceBoundaryForCompletedToolArcs,
    fenceBoundaryForToolArcs,
    type TrueRawTokenIndex,
} from "./read-session-true-raw-tokens";

export type BoundaryMode =
    | "trigger"
    | "incremental-runner"
    | "transform-force"
    | "manual-full-recomp"
    | "manual-partial-recomp"
    | "manual-wrapup"
    | "pi-trigger"
    | "pi-runner";

export interface BoundaryUsage {
    percentage: number;
    inputTokens: number;
}

export interface ResolvedBoundaryContext {
    sessionId: string;
    mode: BoundaryMode;
    contextLimit: number;
    executeThresholdPercentage: number;
    triggerBudget: number;
    usage: BoundaryUsage | null;
    usageSource: "live" | "persisted" | "provisional-zero" | "manual-none";
    lastCompartmentEndOrdinal: number;
    priorBoundaryOrdinal: number;
    protectedTailPolicyVersion: number;
    migrationFloorActive: boolean;
    emergencyTailScale?: 0.5 | 0.25;
    providerShapeVersion: "opencode-v1" | "pi-folded-v1";
    cacheNamespace: string;
    createdAt?: number;
    /**
     * Durable per-message token totals (sum of the message's active tag
     * token_counts), keyed by real message id. When present, the boundary's
     * token index reads these instead of re-tokenizing the raw session — the
     * restart-durable fast path. A message missing here (or with a NULL-count
     * tag) falls back to live tokenization. Built once in resolveBoundaryContext
     * from the tag store; omitted (→ all-live) when the caller has no tag store.
     */
    storedTokenTotals?: Map<string, number>;
}

export interface ProtectedTailBoundarySnapshot {
    sessionId: string;
    mode: BoundaryMode;
    offset: number;
    offsetMessageId: string | null;
    protectedTailStart: number;
    protectedTailStartMessageId: string | null;
    eligibleEndOrdinal: number;
    eligibleEndMessageId: string | null;
    rawMessageCountAtTrigger: number;
    rawLastMessageIdAtTrigger: string | null;
    N: number;
    usagePercentage: number;
    usageInputTokens: number;
    usageSource: ResolvedBoundaryContext["usageSource"];
    contextLimit: number;
    executeThresholdPercentage: number;
    triggerBudget: number;
    priorBoundaryOrdinal: number;
    migrationFloorActive: boolean;
    emergencyTailScale?: 0.5 | 0.25;
    providerShapeVersion: "opencode-v1" | "pi-folded-v1";
    cacheNamespace: string;
    createdAt: number;
    rawRangeFingerprint: string;
    trueRawEligibleTokens: number;
    oversizeAtomicUnit: boolean;
    boundaryReason: string;
}

export interface ProtectedTailTokenTarget {
    usable: number;
    rawN: number;
    floorN: number;
    ceilingN: number;
    effectiveFloor: number;
    N: number;
    headroom: number;
    triggerBudget: number;
    reserve: number;
}

export interface RawHistoryEligibility {
    lastCompartmentEnd: number;
    offset: number;
    rawMessageCount: number;
    hasRawBeyondLastCompartment: boolean;
}

export interface ProactiveTriggerInfo {
    boundary: ProtectedTailBoundarySnapshot;
    hasProtectedEligibleHead: boolean;
    trueRawEligibleTokens: number;
    tcTokenEstimate: number;
    messageCount: number;
    commitClusterCount: number;
    isMeaningful: boolean;
}

export interface BoundarySnapshotValidationResult {
    ok: boolean;
    reason?: "stale_snapshot" | "model_or_limit_changed";
    detail?: string;
}

export interface WrapupBoundaryPlan {
    snapshot: ProtectedTailBoundarySnapshot;
    /** Raw messages (any role) after the last durable compartment, counted at command start. */
    rawMessagesAboveLastCompartment: number;
    /** Raw-message count used to anchor the keep watermark for the whole wrapup loop. */
    anchorRawMessageCount: number;
    /** First raw ordinal that remains protected by the keep watermark. */
    targetProtectedTailStart: number;
    /** Exclusive eligible end before per-run capping. */
    targetEligibleEndOrdinal: number;
}

const ALPHA = 0.3;
const FLOOR_RATIO = 0.08;
const FLOOR_MIN = 2_000;
const FLOOR_MAX = 12_000;
const ABS_CAP = 96_000;
const MAX_USABLE_RATIO = 0.4;
const RESERVED_HEADROOM_MIN = 1_000;
const RESERVED_HEADROOM_RATIO = 0.02;
const NON_EMERGENCY_MAX_CAP = 250_000;
const FORCE80_MAX_CAP = 500_000;
const FORCE95_MAX_CAP = 750_000;
const NORMAL_HYSTERESIS_TOKENS = 256;

export const RECOVERY_NO_HEAD_LIMIT = 2;

/** A tiny complete head is still worth summarizing at force pressure; below this, wait for a real arc/user turn. */
export const MIN_FORCE_ELIGIBLE_TOKENS_CAP = 1_000;

export function deriveMinForceEligibleTokens(scaledN: number): number {
    return Math.min(MIN_FORCE_ELIGIBLE_TOKENS_CAP, Math.max(1, Math.floor(scaledN / 8)));
}

function clampPercentage(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(100, value));
}

function clampOrdinal(value: number, rawMessageCount: number): number {
    return Math.max(1, Math.min(rawMessageCount + 1, Math.floor(value)));
}

export function deriveProtectedTailTokenTarget(args: {
    contextLimit: number;
    executeThresholdPercentage: number;
    usagePercentage: number;
    triggerBudget?: number;
}): ProtectedTailTokenTarget {
    const safeContextLimit =
        Number.isFinite(args.contextLimit) && args.contextLimit > 0 ? args.contextLimit : 128_000;
    const safeThreshold = Number.isFinite(args.executeThresholdPercentage)
        ? Math.max(0, args.executeThresholdPercentage)
        : 65;
    const usable = Math.max(1, Math.round((safeContextLimit * safeThreshold) / 100));
    const usage = clampPercentage(args.usagePercentage);
    const triggerBudget =
        args.triggerBudget ?? deriveTriggerBudget(safeContextLimit, safeThreshold);
    const reserve = Math.max(RESERVED_HEADROOM_MIN, Math.round(usable * RESERVED_HEADROOM_RATIO));
    const rawN = Math.round(usable * ALPHA * (1 - usage / 100));
    const floorN = Math.min(FLOOR_MAX, Math.max(FLOOR_MIN, Math.round(usable * FLOOR_RATIO)));
    const headroom = Math.min(triggerBudget + reserve, Math.floor(usable * 0.5));
    const ceilingN = Math.max(
        1,
        Math.min(ABS_CAP, Math.floor(usable * MAX_USABLE_RATIO), usable - headroom),
    );
    const effectiveFloor = Math.min(floorN, ceilingN);
    const N = Math.min(ceilingN, Math.max(effectiveFloor, rawN));
    return { usable, rawN, floorN, ceilingN, effectiveFloor, N, headroom, triggerBudget, reserve };
}

export function nonEmergencyPerRunCap(usable: number, N: number): number {
    return Math.min(
        NON_EMERGENCY_MAX_CAP,
        Math.max(2 * N, Math.min(Math.round(0.25 * usable), 100_000)),
    );
}

export function force80PerRunCap(usable: number, N: number): number {
    return Math.min(FORCE80_MAX_CAP, Math.max(3 * N, Math.min(Math.round(0.35 * usable), 150_000)));
}

export function force95PerRunCap(usable: number, N: number): number {
    return Math.min(FORCE95_MAX_CAP, Math.max(4 * N, Math.min(Math.round(0.5 * usable), 250_000)));
}

export function selectPerRunCap(
    snapshot: Pick<
        ProtectedTailBoundarySnapshot,
        "usagePercentage" | "N" | "contextLimit" | "executeThresholdPercentage"
    >,
): number {
    const usable = Math.max(
        1,
        Math.round((snapshot.contextLimit * snapshot.executeThresholdPercentage) / 100),
    );
    if (snapshot.usagePercentage >= 95) return force95PerRunCap(usable, snapshot.N);
    // Capacity sizing deliberately retains its historical 80% tier. For execute
    // thresholds from 84% through 90%, this cap no longer coincides with the
    // derived force-band transition.
    if (snapshot.usagePercentage >= 80) return force80PerRunCap(usable, snapshot.N);
    return nonEmergencyPerRunCap(usable, snapshot.N);
}

function boundaryMessageId(index: TrueRawTokenIndex, ordinal: number): string | null {
    if (ordinal < 1 || ordinal > index.rawMessageCount) return null;
    return index.messageIdAtOrdinal(ordinal);
}

function isSemanticBoundaryCandidate(messageParts: unknown[], role: string): boolean {
    if (role === "user" && hasMeaningfulUserText(messageParts)) return true;
    if (
        messageParts.some(
            (part) =>
                String(
                    typeof part === "object" && part !== null && "type" in part
                        ? (part as { type?: unknown }).type
                        : "",
                ) === "tool",
        )
    ) {
        return true;
    }
    return false;
}

function semanticSnapBoundary(args: {
    messages: ReturnType<typeof readRawSessionMessages>;
    index: TrueRawTokenIndex;
    candidate: number;
    scaledN: number;
    lastCompartmentEndOrdinal: number;
}): number {
    const { messages, index, candidate, scaledN, lastCompartmentEndOrdinal } = args;
    let snapped = candidate;
    for (const message of messages) {
        if (message.ordinal > candidate) break;
        if (message.ordinal < lastCompartmentEndOrdinal + 1) continue;
        if (!isSemanticBoundaryCandidate(message.parts, message.role)) continue;
        snapped = message.ordinal;
    }
    if (snapped === candidate) return candidate;
    const extraTokens =
        index.suffixTokensFromOrdinal(snapped) - index.suffixTokensFromOrdinal(candidate);
    if (extraTokens > Math.min(Math.round(1.5 * scaledN), 48_000)) return candidate;
    const snappedMessage = messages.find((message) => message.ordinal === snapped);
    if (
        snappedMessage?.role === "user" &&
        index.tokenForOrdinal(snapped) > Math.max(2 * scaledN, 64_000)
    ) {
        return candidate;
    }
    return snapped;
}

function snapWrapupBoundaryToUser(args: {
    messages: ReturnType<typeof readRawSessionMessages>;
    index: TrueRawTokenIndex;
    candidate: number;
    offset: number;
    triggerBudget: number;
}): number {
    const { messages, index, candidate, offset, triggerBudget } = args;
    if (candidate <= offset) return candidate;
    const snapTokenLimit = Math.min(Math.max(triggerBudget, 2_000), 48_000);
    for (let ordinal = candidate; ordinal >= offset; ordinal -= 1) {
        const message = messages.find((m) => m.ordinal === ordinal);
        if (!message) continue;
        if (message.role !== "user" || !hasMeaningfulUserText(message.parts)) continue;
        const extraTokens = index.rangeTokens(ordinal, candidate);
        if (extraTokens <= snapTokenLimit) return ordinal;
        return candidate;
    }
    return candidate;
}

function fenceWrapupBoundaryForToolArcs(args: {
    candidate: number;
    arcs: ReturnType<typeof buildToolArcs>;
    lastCompartmentEndOrdinal: number;
}): number {
    let boundary = args.candidate;
    const maxPasses = args.arcs.length + 1;
    for (let pass = 0; pass < maxPasses; pass += 1) {
        let next = boundary;
        for (const arc of args.arcs) {
            if (arc.resOrdinal === null) {
                // An open invocation at or after the watermark is already in the kept
                // tail. An older open invocation is treated as stale/interrupted, which
                // matches the normal boundary resolver's staleness rule.
                continue;
            }
            if (
                arc.invOrdinal >= args.lastCompartmentEndOrdinal + 1 &&
                completedToolArcCrossesBoundary(arc.invOrdinal, arc.resOrdinal, next)
            ) {
                next = arc.invOrdinal;
            }
        }
        if (next === boundary) return boundary;
        boundary = next;
    }
    return boundary;
}

function applyHeadCap(args: {
    index: TrueRawTokenIndex;
    protectedTailStart: number;
    offset: number;
    arcs: ReturnType<typeof buildToolArcs>;
    lastCompartmentEndOrdinal: number;
    capTokens: number;
    recentOpenArcCutoff: number;
}): { eligibleEndOrdinal: number; oversizeAtomicUnit: boolean } {
    const {
        index,
        protectedTailStart,
        offset,
        arcs,
        lastCompartmentEndOrdinal,
        capTokens,
        recentOpenArcCutoff,
    } = args;
    if (offset >= protectedTailStart)
        return { eligibleEndOrdinal: offset, oversizeAtomicUnit: false };
    let end = index.findHeadEndForCap(offset, protectedTailStart, capTokens);
    let oversizeAtomicUnit = end === offset + 1 && index.tokenForOrdinal(offset) > capTokens;
    const completedFence = fenceBoundaryForCompletedToolArcs(
        end,
        arcs,
        lastCompartmentEndOrdinal + 1,
    );
    if (completedFence > end) {
        end = Math.min(protectedTailStart, completedFence);
        if (index.rangeTokens(offset, end) > capTokens) oversizeAtomicUnit = true;
    } else {
        end = completedFence;
    }
    for (const arc of arcs) {
        const resOrdinal = arc.resOrdinal;
        if (resOrdinal === null) {
            // Mirror the boundary fence: only a RECENT open arc (the in-flight
            // call) caps the head. A stale open arc in the eligible head is an
            // interrupted invocation and must not shrink the head to its
            // ordinal (which, for a dead arc at the head edge, would collapse
            // the eligible region and starve the historian).
            if (
                arc.invOrdinal >= recentOpenArcCutoff &&
                arc.invOrdinal >= offset &&
                arc.invOrdinal < end
            ) {
                end = Math.min(end, arc.invOrdinal);
            }
        }
    }
    if (end <= offset && offset < protectedTailStart) {
        return { eligibleEndOrdinal: offset, oversizeAtomicUnit };
    }
    return { eligibleEndOrdinal: Math.min(end, protectedTailStart), oversizeAtomicUnit };
}

export function resolveProtectedTailBoundary(
    ctx: ResolvedBoundaryContext,
): ProtectedTailBoundarySnapshot {
    const createdAt = ctx.createdAt ?? Date.now();
    const messages = readRawSessionMessages(ctx.sessionId);
    const storedTotals = ctx.storedTokenTotals;
    // When a tail-only slice is primed, `messages` holds just the eligible tail
    // with absolute ordinals; the index must be sized to the ABSOLUTE total so
    // every offset-forward query matches a whole-session read. null → whole
    // session (index uses messages.length, unchanged).
    const absoluteMessageCount = getCachedAbsoluteMessageCount(ctx.sessionId) ?? undefined;
    const index = buildTrueRawTokenIndex(ctx.sessionId, messages, {
        providerShapeVersion: ctx.providerShapeVersion,
        cacheNamespace: ctx.cacheNamespace,
        absoluteMessageCount,
        storedTotalForMessage: storedTotals
            ? (m) => {
                  const v = storedTotals.get(m.id);
                  return v === undefined ? null : v;
              }
            : undefined,
    });
    const rawMessageCount = index.rawMessageCount;
    const offset = Math.max(1, ctx.lastCompartmentEndOrdinal + 1);
    const usagePercentage = clampPercentage(ctx.usage?.percentage ?? 0);
    const usageInputTokens = Math.max(0, Math.round(ctx.usage?.inputTokens ?? 0));

    if (rawMessageCount === 0) {
        return {
            sessionId: ctx.sessionId,
            mode: ctx.mode,
            offset,
            offsetMessageId: null,
            protectedTailStart: 1,
            protectedTailStartMessageId: null,
            eligibleEndOrdinal: 1,
            eligibleEndMessageId: null,
            rawMessageCountAtTrigger: 0,
            rawLastMessageIdAtTrigger: null,
            N: 0,
            usagePercentage,
            usageInputTokens,
            usageSource: ctx.usageSource,
            contextLimit: ctx.contextLimit,
            executeThresholdPercentage: ctx.executeThresholdPercentage,
            triggerBudget: ctx.triggerBudget,
            priorBoundaryOrdinal: ctx.priorBoundaryOrdinal,
            migrationFloorActive: ctx.migrationFloorActive,
            emergencyTailScale: ctx.emergencyTailScale,
            providerShapeVersion: ctx.providerShapeVersion,
            cacheNamespace: ctx.cacheNamespace,
            createdAt,
            rawRangeFingerprint: "",
            trueRawEligibleTokens: 0,
            oversizeAtomicUnit: false,
            boundaryReason: "empty-session",
        };
    }

    if (ctx.mode === "manual-full-recomp") {
        const arcs = buildToolArcs(messages);
        // Staleness gate (mirrors the trigger path): only the current in-flight
        // call — an open arc within the live recent window — may hold back a full
        // recomp. A stale/interrupted open arc (its result will never arrive)
        // must NOT block /ctx-recomp; otherwise the same dead invocation that
        // froze the historian also freezes the user's manual escape hatch.
        const recompTarget = deriveProtectedTailTokenTarget({
            contextLimit: ctx.contextLimit,
            executeThresholdPercentage: ctx.executeThresholdPercentage,
            usagePercentage: 0,
            triggerBudget: ctx.triggerBudget,
        });
        const recentOpenArcCutoff = index.findSuffixStartForTokens(recompTarget.N);
        const firstOpenArc = arcs.find(
            (arc) =>
                arc.resOrdinal === null &&
                arc.invOrdinal >= offset &&
                arc.invOrdinal >= recentOpenArcCutoff,
        );
        const protectedTailStart = firstOpenArc?.invOrdinal ?? rawMessageCount + 1;
        const rawRangeFingerprint = computeRawRangeFingerprint(
            messages,
            offset,
            protectedTailStart,
        );
        return {
            sessionId: ctx.sessionId,
            mode: ctx.mode,
            offset,
            offsetMessageId: boundaryMessageId(index, offset),
            protectedTailStart,
            protectedTailStartMessageId: null,
            eligibleEndOrdinal: protectedTailStart,
            eligibleEndMessageId: boundaryMessageId(index, protectedTailStart - 1),
            rawMessageCountAtTrigger: rawMessageCount,
            rawLastMessageIdAtTrigger: boundaryMessageId(index, rawMessageCount),
            N: 0,
            usagePercentage: 0,
            usageInputTokens: 0,
            usageSource: "manual-none",
            contextLimit: ctx.contextLimit,
            executeThresholdPercentage: ctx.executeThresholdPercentage,
            triggerBudget: ctx.triggerBudget,
            priorBoundaryOrdinal: ctx.priorBoundaryOrdinal,
            migrationFloorActive: false,
            emergencyTailScale: ctx.emergencyTailScale,
            providerShapeVersion: ctx.providerShapeVersion,
            cacheNamespace: ctx.cacheNamespace,
            createdAt,
            rawRangeFingerprint,
            trueRawEligibleTokens: index.rangeTokens(offset, protectedTailStart),
            oversizeAtomicUnit: false,
            boundaryReason: firstOpenArc ? "open-tool-arc" : "manual-full-recomp",
        };
    }

    const target = deriveProtectedTailTokenTarget({
        contextLimit: ctx.contextLimit,
        executeThresholdPercentage: ctx.executeThresholdPercentage,
        usagePercentage,
        triggerBudget: ctx.triggerBudget,
    });
    const scaledN = ctx.emergencyTailScale
        ? Math.max(1, Math.floor(target.N * ctx.emergencyTailScale))
        : target.N;
    const arcs = buildToolArcs(messages);
    let boundary = index.findSuffixStartForTokens(scaledN);
    // The size-walk start (last scaledN tokens) is the live protected-tail
    // window. Open tool arcs at/after it may be the current in-flight call and
    // are protected; open arcs before it are stale (interrupted) and must not
    // fence the boundary. This auto-scales with context (scaledN scales with the
    // window), so a single dead invocation at the eligible-head edge can no
    // longer collapse the boundary to offset and freeze the historian.
    const recentOpenArcCutoff = boundary;
    let boundaryReason = boundary === 1 ? "whole-session-smaller-than-tail" : "size-walk";
    const tokenAtBoundary = index.tokenForOrdinal(boundary);
    if (
        boundary <= rawMessageCount &&
        tokenAtBoundary > Math.max(2 * scaledN, 64_000) &&
        boundary < rawMessageCount
    ) {
        boundary += 1;
        boundaryReason = "huge-message-exception";
    }
    boundary = fenceBoundaryForToolArcs(
        boundary,
        arcs,
        ctx.lastCompartmentEndOrdinal,
        recentOpenArcCutoff,
    );
    const snapped = semanticSnapBoundary({
        messages,
        index,
        candidate: boundary,
        scaledN,
        lastCompartmentEndOrdinal: ctx.lastCompartmentEndOrdinal,
    });
    if (snapped !== boundary) boundaryReason = "semantic-snap";
    boundary = fenceBoundaryForToolArcs(
        snapped,
        arcs,
        ctx.lastCompartmentEndOrdinal,
        recentOpenArcCutoff,
    );
    let runtimeFloor = offset;
    if (ctx.migrationFloorActive) runtimeFloor = Math.max(runtimeFloor, ctx.priorBoundaryOrdinal);
    let protectedTailStart = Math.max(boundary, runtimeFloor);
    // Live-prompt floor: on routine (non-emergency) passes the boundary must
    // never cross the newest MEANINGFUL user message — compacting the prompt
    // the agent is actively answering replaces it with a narration mid-turn
    // and renders the compaction divider at the live tail (observed in
    // production on a tool-heavy session: the in-flight turn's suffix was all
    // assistant/tool messages, so pure token sizing left the current prompt
    // eligible — structurally impossible under v2's user-turn rule, regained
    // here). Emergency-scaled re-resolution (force-band/95 second attempt) may
    // deliberately cross it: a sparse session with one user turn and a huge
    // assistant tail must stay compactable under genuine pressure (#132),
    // and overflow is strictly worse than narrating the live prompt.
    // The floor lifts at the derived force pressure for the same reason — the
    // sparse #132 session (one user turn, huge assistant tail) must expose a
    // runnable head on the force path's FIRST attempt, not only after the
    // emergency-scaled retry.
    const forceMaterializationPercentage = escalationBands(
        ctx.executeThresholdPercentage,
    ).forceMaterializationPercentage;
    if (!ctx.emergencyTailScale && usagePercentage < forceMaterializationPercentage) {
        let lastMeaningfulUserOrdinal = 0;
        for (let i = messages.length - 1; i >= 0; i--) {
            const message = messages[i];
            if (message.role !== "user") continue;
            if (!hasMeaningfulUserText(message.parts)) continue;
            lastMeaningfulUserOrdinal = message.ordinal;
            break;
        }
        if (lastMeaningfulUserOrdinal >= offset) {
            protectedTailStart = Math.min(protectedTailStart, lastMeaningfulUserOrdinal);
        }
    }
    // Keep defer-pass cache keys stable when a tiny token fluctuation would move the ideal by one message.
    if (
        protectedTailStart > offset &&
        index.rangeTokens(offset, protectedTailStart) <= NORMAL_HYSTERESIS_TOKENS
    ) {
        protectedTailStart = offset;
    }
    protectedTailStart = clampOrdinal(protectedTailStart, rawMessageCount);
    const perRunCap = selectPerRunCap({
        usagePercentage,
        N: scaledN,
        contextLimit: ctx.contextLimit,
        executeThresholdPercentage: ctx.executeThresholdPercentage,
    });
    const head = applyHeadCap({
        index,
        protectedTailStart,
        offset,
        arcs,
        lastCompartmentEndOrdinal: ctx.lastCompartmentEndOrdinal,
        capTokens: perRunCap,
        recentOpenArcCutoff,
    });
    const rawRangeFingerprint = computeRawRangeFingerprint(
        messages,
        offset,
        head.eligibleEndOrdinal,
    );
    return {
        sessionId: ctx.sessionId,
        mode: ctx.mode,
        offset,
        offsetMessageId: boundaryMessageId(index, offset),
        protectedTailStart,
        protectedTailStartMessageId: boundaryMessageId(index, protectedTailStart),
        eligibleEndOrdinal: head.eligibleEndOrdinal,
        eligibleEndMessageId: boundaryMessageId(index, head.eligibleEndOrdinal - 1),
        rawMessageCountAtTrigger: rawMessageCount,
        rawLastMessageIdAtTrigger: boundaryMessageId(index, rawMessageCount),
        N: scaledN,
        usagePercentage,
        usageInputTokens,
        usageSource: ctx.usageSource,
        contextLimit: ctx.contextLimit,
        executeThresholdPercentage: ctx.executeThresholdPercentage,
        triggerBudget: ctx.triggerBudget,
        priorBoundaryOrdinal: ctx.priorBoundaryOrdinal,
        migrationFloorActive: ctx.migrationFloorActive,
        emergencyTailScale: ctx.emergencyTailScale,
        providerShapeVersion: ctx.providerShapeVersion,
        cacheNamespace: ctx.cacheNamespace,
        createdAt,
        rawRangeFingerprint,
        trueRawEligibleTokens: index.rangeTokens(offset, protectedTailStart),
        oversizeAtomicUnit: head.oversizeAtomicUnit,
        boundaryReason,
    };
}

export function resolveBoundaryContext(args: {
    db: Database;
    sessionId: string;
    mode: BoundaryMode;
    contextLimit: number;
    executeThresholdPercentage: number;
    usage?: BoundaryUsage | null;
    usageSource?: ResolvedBoundaryContext["usageSource"];
    emergencyTailScale?: 0.5 | 0.25;
    providerShapeVersion?: "opencode-v1" | "pi-folded-v1";
    cacheNamespace?: string;
    /**
     * Tagger load-scoping floor (OpenCode only). When > 0, the stored-token map
     * is loaded only for tags at/above this floor (the live wire) instead of
     * scanning the whole session's tags (~100k rows → ~50ms every pass). The
     * boundary only indexes the live slice (all >= floor), and any slice message
     * the scoped map misses degrades to live tokenization of the same content,
     * so the cut point is byte-identical. Omit / 0 = full scan (Pi, recomp,
     * tests) — unchanged.
     */
    taggerFloor?: number;
}): ResolvedBoundaryContext {
    const lastCompartmentEndOrdinal = getLastCompartmentEndMessage(args.db, args.sessionId);
    const triggerBudget = deriveTriggerBudget(args.contextLimit, args.executeThresholdPercentage);
    let meta = loadProtectedTailMeta(args.db, args.sessionId);
    let migrationFloorActive = false;
    if (meta.protectedTailPolicyVersion < 3) {
        let legacyBoundary = 1;
        try {
            legacyBoundary = getLegacyProtectedTailStartOrdinal(args.sessionId);
        } catch (error) {
            sessionLog(
                args.sessionId,
                "protected-tail migration seed fell back to ordinal 1:",
                error,
            );
        }
        const seedResult = markProtectedTailPolicyV3Seeded(
            args.db,
            args.sessionId,
            Math.max(1, legacyBoundary),
        );
        meta = seedResult;
        migrationFloorActive = seedResult.seeded;
    }
    // Durable token source: sum each message's precomputed tag token_counts so
    // the boundary indexes raw messages without re-tokenizing 60k+ messages on
    // a cold pass (the 16s→ms win). Best-effort: a store failure just falls back
    // to all-live tokenization.
    let storedTokenTotals: Map<string, number> | undefined;
    try {
        storedTokenTotals = getAllStatusTagTokenTotalsFlat(
            args.db,
            args.sessionId,
            args.taggerFloor ?? 0,
        ).totals;
    } catch (error) {
        sessionLog(
            args.sessionId,
            "protected-tail stored-token map unavailable (live fallback):",
            error,
        );
    }
    return {
        sessionId: args.sessionId,
        mode: args.mode,
        contextLimit: args.contextLimit,
        executeThresholdPercentage: args.executeThresholdPercentage,
        triggerBudget,
        usage: args.usage ?? null,
        usageSource: args.usageSource ?? (args.usage ? "live" : "provisional-zero"),
        lastCompartmentEndOrdinal,
        priorBoundaryOrdinal: meta.priorBoundaryOrdinal,
        protectedTailPolicyVersion: meta.protectedTailPolicyVersion,
        migrationFloorActive,
        emergencyTailScale: args.emergencyTailScale,
        providerShapeVersion: args.providerShapeVersion ?? "opencode-v1",
        cacheNamespace: args.cacheNamespace ?? `opencode:${args.sessionId}`,
        storedTokenTotals,
    };
}

export function resolveOpenCodeProtectedTailBoundary(
    args: Parameters<typeof resolveBoundaryContext>[0],
): ProtectedTailBoundarySnapshot {
    return resolveProtectedTailBoundary(resolveBoundaryContext(args));
}

export function resolveWrapupProtectedTailBoundary(
    args: Parameters<typeof resolveBoundaryContext>[0] & {
        messagesToKeep: number;
        anchorRawMessageCount?: number;
    },
): WrapupBoundaryPlan {
    const ctx = resolveBoundaryContext({ ...args, mode: "manual-wrapup" });
    const createdAt = ctx.createdAt ?? Date.now();
    const messages = readRawSessionMessages(ctx.sessionId);
    const absoluteMessageCount = getCachedAbsoluteMessageCount(ctx.sessionId) ?? undefined;
    const index = buildTrueRawTokenIndex(ctx.sessionId, messages, {
        providerShapeVersion: ctx.providerShapeVersion,
        cacheNamespace: ctx.cacheNamespace,
        absoluteMessageCount,
        storedTotalForMessage: ctx.storedTokenTotals
            ? (m) => {
                  const value = ctx.storedTokenTotals?.get(m.id);
                  return value === undefined ? null : value;
              }
            : undefined,
    });
    const rawMessageCount = index.rawMessageCount;
    const offset = Math.max(1, ctx.lastCompartmentEndOrdinal + 1);
    const anchorRawMessageCount = Math.max(
        0,
        Math.min(rawMessageCount, Math.floor(args.anchorRawMessageCount ?? rawMessageCount)),
    );
    const usagePercentage = clampPercentage(ctx.usage?.percentage ?? 0);
    const usageInputTokens = Math.max(0, Math.round(ctx.usage?.inputTokens ?? 0));

    // The keep watermark counts RAW messages (any role), not user turns: in
    // agentic sessions one user turn can span 100+ tool messages, so a
    // user-turn count would keep an unbounded token tail and defeat the
    // pre-model-switch use case. Raw counting gives a bounded, predictable
    // keep; the arc fence and user-boundary snap below still keep the actual
    // cut safe.
    const rawMessagesAboveLastCompartment = Math.max(0, anchorRawMessageCount - offset + 1);
    const keep = Math.max(1, Math.floor(args.messagesToKeep));

    let targetProtectedTailStart = offset;
    let boundaryReason = "manual-wrapup-empty";
    if (rawMessageCount === 0 || rawMessagesAboveLastCompartment <= keep) {
        targetProtectedTailStart = offset;
        boundaryReason =
            rawMessageCount === 0 ? "manual-wrapup-empty" : "manual-wrapup-within-keep";
    } else {
        targetProtectedTailStart = anchorRawMessageCount - keep + 1;
        boundaryReason = "manual-wrapup-keep-watermark";
        const arcs = buildToolArcs(messages);
        const fenced = fenceWrapupBoundaryForToolArcs({
            candidate: targetProtectedTailStart,
            arcs,
            lastCompartmentEndOrdinal: ctx.lastCompartmentEndOrdinal,
        });
        if (fenced !== targetProtectedTailStart) boundaryReason = "manual-wrapup-tool-arc";
        targetProtectedTailStart = fenced;
        const snapped = snapWrapupBoundaryToUser({
            messages,
            index,
            candidate: targetProtectedTailStart,
            offset,
            triggerBudget: ctx.triggerBudget,
        });
        if (snapped !== targetProtectedTailStart) boundaryReason = "manual-wrapup-user-snap";
        targetProtectedTailStart = snapped;
        const refenced = fenceWrapupBoundaryForToolArcs({
            candidate: targetProtectedTailStart,
            arcs,
            lastCompartmentEndOrdinal: ctx.lastCompartmentEndOrdinal,
        });
        // User snapping can move from a later tool invocation to an earlier queued
        // user turn that sits inside another closed tool arc. Re-fence after the
        // snap; the fence helper iterates so overlapping arcs move to a stable
        // invocation boundary instead of splitting an invocation/result pair.
        if (refenced !== targetProtectedTailStart) boundaryReason = "manual-wrapup-tool-arc";
        targetProtectedTailStart = refenced;
    }

    targetProtectedTailStart = clampOrdinal(targetProtectedTailStart, rawMessageCount);
    const target = deriveProtectedTailTokenTarget({
        contextLimit: ctx.contextLimit,
        executeThresholdPercentage: ctx.executeThresholdPercentage,
        usagePercentage,
        triggerBudget: ctx.triggerBudget,
    });
    const perRunCap = selectPerRunCap({
        usagePercentage,
        N: target.N,
        contextLimit: ctx.contextLimit,
        executeThresholdPercentage: ctx.executeThresholdPercentage,
    });
    const head = applyHeadCap({
        index,
        protectedTailStart: targetProtectedTailStart,
        offset,
        arcs: buildToolArcs(messages),
        lastCompartmentEndOrdinal: ctx.lastCompartmentEndOrdinal,
        capTokens: perRunCap,
        recentOpenArcCutoff: targetProtectedTailStart,
    });
    const eligibleEndOrdinal = Math.min(head.eligibleEndOrdinal, targetProtectedTailStart);
    const rawRangeFingerprint = computeRawRangeFingerprint(messages, offset, eligibleEndOrdinal);
    const snapshot: ProtectedTailBoundarySnapshot = {
        sessionId: ctx.sessionId,
        mode: "manual-wrapup",
        offset,
        offsetMessageId: boundaryMessageId(index, offset),
        protectedTailStart: targetProtectedTailStart,
        protectedTailStartMessageId: boundaryMessageId(index, targetProtectedTailStart),
        eligibleEndOrdinal,
        eligibleEndMessageId: boundaryMessageId(index, eligibleEndOrdinal - 1),
        rawMessageCountAtTrigger: rawMessageCount,
        rawLastMessageIdAtTrigger: boundaryMessageId(index, rawMessageCount),
        N: keep,
        usagePercentage,
        usageInputTokens,
        usageSource: ctx.usageSource,
        contextLimit: ctx.contextLimit,
        executeThresholdPercentage: ctx.executeThresholdPercentage,
        triggerBudget: ctx.triggerBudget,
        priorBoundaryOrdinal: ctx.priorBoundaryOrdinal,
        migrationFloorActive: ctx.migrationFloorActive,
        emergencyTailScale: ctx.emergencyTailScale,
        providerShapeVersion: ctx.providerShapeVersion,
        cacheNamespace: ctx.cacheNamespace,
        createdAt,
        rawRangeFingerprint,
        trueRawEligibleTokens: index.rangeTokens(offset, targetProtectedTailStart),
        oversizeAtomicUnit: head.oversizeAtomicUnit,
        boundaryReason,
    };
    return {
        snapshot,
        rawMessagesAboveLastCompartment,
        anchorRawMessageCount,
        targetProtectedTailStart,
        targetEligibleEndOrdinal: targetProtectedTailStart,
    };
}

export function getRawHistoryEligibility(db: Database, sessionId: string): RawHistoryEligibility {
    const lastCompartmentEnd = getLastCompartmentEndMessage(db, sessionId);
    const offset = Math.max(1, lastCompartmentEnd + 1);
    // When a tail-only slice is primed in scope, its `.length` is the tail size,
    // not the absolute total — read the stashed absolute count instead. Without a
    // tail slice (whole-session array or Pi provider) this is null and we use the
    // array length exactly as before.
    const absoluteCount = getCachedAbsoluteMessageCount(sessionId);
    const rawMessageCount = absoluteCount ?? readRawSessionMessages(sessionId).length;
    return {
        lastCompartmentEnd,
        offset,
        rawMessageCount,
        hasRawBeyondLastCompartment: rawMessageCount >= offset,
    };
}

export function hasProtectedEligibleHead(snapshot: ProtectedTailBoundarySnapshot): boolean {
    return snapshot.offset < snapshot.protectedTailStart;
}

export function hasRunnableCompartmentWindow(snapshot: ProtectedTailBoundarySnapshot): boolean {
    if (snapshot.offset >= snapshot.protectedTailStart) return false;
    const forceMaterializationPercentage = escalationBands(
        snapshot.executeThresholdPercentage,
    ).forceMaterializationPercentage;
    if (snapshot.usagePercentage >= forceMaterializationPercentage || snapshot.emergencyTailScale) {
        return (
            snapshot.trueRawEligibleTokens >= deriveMinForceEligibleTokens(snapshot.N) ||
            snapshot.eligibleEndOrdinal > snapshot.offset
        );
    }
    return snapshot.eligibleEndOrdinal > snapshot.offset;
}

export function validateBoundarySnapshot(args: {
    db: Database;
    snapshot: ProtectedTailBoundarySnapshot;
    currentContextLimit?: number;
}): BoundarySnapshotValidationResult {
    const { snapshot } = args;
    if (args.currentContextLimit && args.currentContextLimit !== snapshot.contextLimit) {
        return {
            ok: false,
            reason: "model_or_limit_changed",
            detail: `context limit changed from ${snapshot.contextLimit} to ${args.currentContextLimit}`,
        };
    }
    const messages = readRawSessionMessages(snapshot.sessionId);
    // Readers preserve ordinal slots for malformed rows by skipping the element
    // but keeping later message ordinals absolute. Compare against the same
    // gap-preserving measure the resolver used, not the compacted array length.
    const currentRawMessageCount = messages.reduce(
        (max, message) => Math.max(max, message.ordinal),
        messages.length,
    );
    if (snapshot.rawMessageCountAtTrigger > currentRawMessageCount) {
        return { ok: false, reason: "stale_snapshot", detail: "raw message count shrank" };
    }
    const idsByOrdinal = new Map(messages.map((message) => [message.ordinal, message.id]));
    const idAt = (ordinal: number): string | null => idsByOrdinal.get(ordinal) ?? null;
    const checks: Array<[number, string | null, string]> = [
        [snapshot.offset, snapshot.offsetMessageId, "offset"],
        [snapshot.rawMessageCountAtTrigger, snapshot.rawLastMessageIdAtTrigger, "last"],
    ];
    if (snapshot.protectedTailStart <= snapshot.rawMessageCountAtTrigger) {
        checks.push([
            snapshot.protectedTailStart,
            snapshot.protectedTailStartMessageId,
            "protectedTailStart",
        ]);
    }
    if (snapshot.eligibleEndOrdinal > snapshot.offset) {
        checks.push([
            snapshot.eligibleEndOrdinal - 1,
            snapshot.eligibleEndMessageId,
            "eligibleEnd",
        ]);
    }
    for (const [ordinal, expected, label] of checks) {
        if (expected !== idAt(ordinal)) {
            return {
                ok: false,
                reason: "stale_snapshot",
                detail: `${label} ordinal ${ordinal} id changed`,
            };
        }
    }
    // Apply the SAME clamp the resolver applies (`offset = Math.max(1, end+1)`,
    // line ~328): a zero-compartment session has lastCompartmentEnd = -1, so
    // the unclamped expectation (0) would mismatch the clamped snapshot offset
    // (1) and permanently reject every FIRST-compartment snapshot as stale —
    // a fresh session could never publish its first compartment.
    const expectedOffset = Math.max(
        1,
        getLastCompartmentEndMessage(args.db, snapshot.sessionId) + 1,
    );
    if (expectedOffset !== snapshot.offset) {
        return {
            ok: false,
            reason: "stale_snapshot",
            detail: `last compartment moved: offset ${snapshot.offset} -> ${expectedOffset}`,
        };
    }
    const fingerprint = computeRawRangeFingerprint(
        messages,
        snapshot.offset,
        snapshot.eligibleEndOrdinal,
    );
    if (fingerprint !== snapshot.rawRangeFingerprint) {
        return { ok: false, reason: "stale_snapshot", detail: "raw range fingerprint changed" };
    }
    return { ok: true };
}

export function recordHighPressureNoEligibleHead(
    db: Database,
    snapshot: ProtectedTailBoundarySnapshot,
): number {
    const forceMaterializationPercentage = escalationBands(
        snapshot.executeThresholdPercentage,
    ).forceMaterializationPercentage;
    if (snapshot.usagePercentage < forceMaterializationPercentage && !snapshot.emergencyTailScale) {
        return 0;
    }
    return recordProtectedTailNoEligibleHead(db, snapshot.sessionId);
}

export function resetHighPressureNoEligibleHead(db: Database, sessionId: string): void {
    resetProtectedTailNoEligibleHead(db, sessionId);
}

export function createDefaultBoundarySnapshotForTests(
    sessionId: string,
): ProtectedTailBoundarySnapshot {
    const messages = readRawSessionMessages(sessionId);
    const rawMessageCount = messages.length;
    const protectedTailStart = Math.max(
        1,
        Math.min(rawMessageCount + 1, getLegacyProtectedTailStartOrdinal(sessionId)),
    );
    // Real true-raw sum over the eligible head — the trigger semantics under
    // test (tail_size vs TC, isMeaningful) depend on this being the genuine
    // tool-output-inclusive size, not a hardcoded 0 (which made tests of the
    // true-raw/TC distinction pass vacuously).
    const index = buildTrueRawTokenIndex(sessionId, messages, {
        providerShapeVersion: "opencode-v1",
        cacheNamespace: `test:${sessionId}`,
    });
    const trueRawEligibleTokens = index.rangeTokens(1, protectedTailStart);
    const messageIdAt = (ordinal: number): string | null =>
        messages.find((message) => message.ordinal === ordinal)?.id ?? null;
    return {
        sessionId,
        mode: "incremental-runner",
        offset: 1,
        offsetMessageId: messageIdAt(1),
        protectedTailStart,
        protectedTailStartMessageId: messageIdAt(protectedTailStart),
        eligibleEndOrdinal: protectedTailStart,
        eligibleEndMessageId: messageIdAt(protectedTailStart - 1),
        rawMessageCountAtTrigger: rawMessageCount,
        rawLastMessageIdAtTrigger: messageIdAt(rawMessageCount),
        N: 0,
        usagePercentage: 0,
        usageInputTokens: 0,
        usageSource: "provisional-zero",
        contextLimit: 128_000,
        executeThresholdPercentage: 65,
        triggerBudget: deriveTriggerBudget(128_000, 65),
        priorBoundaryOrdinal: protectedTailStart,
        migrationFloorActive: false,
        providerShapeVersion: "opencode-v1",
        cacheNamespace: `test:${sessionId}`,
        createdAt: Date.now(),
        rawRangeFingerprint: "",
        trueRawEligibleTokens,
        oversizeAtomicUnit: false,
        boundaryReason: "test-legacy",
    };
}
