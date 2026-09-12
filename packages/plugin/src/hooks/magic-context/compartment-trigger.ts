import {
    getLastCompartmentEndMessage,
    getLastCompartmentEndMessageId,
} from "../../features/magic-context/compartment-storage";
import {
    deriveTagLoadFloor,
    getActiveTagsBySession,
    getPendingOps,
    getTriggerTagTokenUpperBound,
    loadProtectedTailMeta,
} from "../../features/magic-context/storage";
import type { ContextUsage, SessionMeta, TagEntry } from "../../features/magic-context/types";
import { escalationBands } from "../../shared/escalation-bands";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import {
    createDefaultBoundarySnapshotForTests,
    getRawHistoryEligibility,
    hasRunnableCompartmentWindow,
    type ProtectedTailBoundarySnapshot,
    resolveOpenCodeProtectedTailBoundary,
} from "./protected-tail-boundary";
import {
    primeInMemoryTailRawMessageCache,
    primeTailRawMessageCache,
    readSessionChunk,
    withRawSessionMessageCache,
} from "./read-session-chunk";
import {
    buildInMemoryTailRawMessages,
    type InMemoryMessageView,
    type RawMessage,
} from "./read-session-raw";
import { estimateTrueRawMessageTokens } from "./read-session-true-raw-tokens";
import { modelAcceptsEmptyContent } from "./sentinel";

const PROACTIVE_TRIGGER_OFFSET_PERCENTAGE = 2;
const POST_DROP_TARGET_RATIO = 0.75;
const MIN_PROACTIVE_TAIL_TOKEN_ESTIMATE = 6_000;
const MIN_PROACTIVE_TAIL_MESSAGE_COUNT = 12;
const DEFAULT_MIN_COMMIT_CLUSTERS_FOR_TRIGGER = 3;
const TAIL_SIZE_TRIGGER_MULTIPLIER = 3;
const BLOCK_UNTIL_DONE_PERCENTAGE = 95;
const CONTENT_TAG_OWNER_SUFFIX = /:(?:p|file)\d+$/;

export { BLOCK_UNTIL_DONE_PERCENTAGE, POST_DROP_TARGET_RATIO };

export interface CompartmentTriggerResult {
    shouldFire: boolean;
    reason?: "projected_headroom" | "force_band" | "commit_clusters" | "tail_size";
    /**
     * The protected-tail boundary snapshot the decision was computed from.
     * Present whenever the tail inspection ran. Callers that start the
     * historian in the SAME pass (transform path) should hand this to
     * runCompartmentPhase so it doesn't re-resolve the boundary — one
     * resolution per pass, and the historian sees exactly the snapshot the
     * decision saw.
     */
    boundarySnapshot?: ProtectedTailBoundarySnapshot;
}

/**
 * In-memory tail source for the trigger — the transform's `args.messages`
 * converted to absolute-ordinal RawMessages (via `buildInMemoryTailRawMessages`
 * with `anchorFound=true`). When supplied, the tail inspection primes the
 * raw-message cache from memory and performs ZERO opencode.db reads on the hot
 * path. Callers must only pass an ANCHORED conversion — an unanchored one has
 * assumed ordinals; leave it undefined to fall through to the DB-primed path.
 */
export interface InMemoryTailSource {
    messages: RawMessage[];
    absoluteMessageCount: number;
}

/**
 * Wire capability for projecting reclaimable reasoning bytes. OpenCode derives
 * this from the provider's empty-sentinel support; Pi overrides it because its
 * serializers safely omit cleared thinking for every provider.
 */
export interface ReasoningProjectionCapability {
    providerID?: string;
    canClearReasoning?: boolean;
}

/**
 * Deferred tail conversion for callers that have already tagged the live wire.
 * The trigger's cheap gate can use the caller-provided tag floor without building
 * RawMessages; the factory runs only when authoritative tail inspection is needed.
 */
export type LazyInMemoryTailSource = () => InMemoryTailSource | undefined;

function tagOwnerMessageId(row: {
    type: string;
    message_id: string;
    tool_owner_message_id: string | null;
}): string {
    if (row.type === "tool") return row.tool_owner_message_id ?? row.message_id;
    return row.message_id.replace(CONTENT_TAG_OWNER_SUFFIX, "");
}

function getActiveOrDroppedTagOwnerMessageIds(
    db: Database,
    sessionId: string,
    floor = 0,
): Set<string> {
    // floor > 0 (OpenCode) scopes to the live-wire range (tag_number >= floor) —
    // the same scoping the other two cheap-gate tag scans use. This set is only
    // consumed to mark which IN-MEMORY TAIL messages are already tag-covered (so
    // the cheap-gate's per-message estimate charges only uncovered ones). Every
    // in-memory tail message is at/after the floor by construction, so a tag
    // below the floor could never cover a tail message anyway — scoping shrinks
    // the set to the live wire with an identical loop result, while avoiding the
    // full-session tag scan (~64-72ms on a 100k-tag session, the residual
    // compartmentTrigger cost). floor=0 (Pi / no-floor) keeps the full scan.
    const rows = (
        floor > 0
            ? db
                  .prepare(
                      `SELECT type, message_id, tool_owner_message_id
                       FROM tags
                       WHERE session_id = ? AND status IN ('active', 'dropped') AND tag_number >= ?`,
                  )
                  .all(sessionId, floor)
            : db
                  .prepare(
                      `SELECT type, message_id, tool_owner_message_id
                       FROM tags
                       WHERE session_id = ? AND status IN ('active', 'dropped')`,
                  )
                  .all(sessionId)
    ) as Array<{
        type: string;
        message_id: string;
        tool_owner_message_id: string | null;
    }>;
    const owners = new Set<string>();
    for (const row of rows) owners.add(tagOwnerMessageId(row));
    return owners;
}

function estimateUntaggedInMemoryTailUpperBound(
    db: Database,
    sessionId: string,
    inMemoryTail: InMemoryTailSource,
    taggerFloor = 0,
): number {
    const lastCompartmentEnd = getLastCompartmentEndMessage(db, sessionId);
    const coveredOwnerMessageIds = getActiveOrDroppedTagOwnerMessageIds(db, sessionId, taggerFloor);
    let total = 0;
    for (const message of inMemoryTail.messages) {
        // The anchored in-memory tail includes the last compartment boundary row
        // itself; it is not eligible for a new compartment and the persisted bound
        // deliberately excludes compacted tags, so do not charge it here.
        if (message.ordinal <= lastCompartmentEnd) continue;
        if (coveredOwnerMessageIds.has(message.id)) continue;
        total += estimateTrueRawMessageTokens(message, {
            providerShapeVersion: "opencode-v1",
        }).total;
    }
    return total;
}

/**
 * Convert the transform's in-memory `args.messages` into a trigger tail source,
 * applying the anchored-only gate:
 *
 * - Compartments exist + boundary has a message id → require the anchor to be
 *   FOUND in the array (`anchorFound`). OpenCode's `filterCompacted` stops at
 *   our compaction marker (the boundary message), so the anchor is normally the
 *   array head; when the marker drain lags, the anchor sits a few messages in
 *   and the converter drops the already-compartmentalized prefix. If it isn't
 *   present at all (deleted, or the marker advanced past it), ordinal
 *   assignment would be an unverified guess → return undefined so the caller
 *   falls through to the DB-primed read.
 * - Compartments exist but the boundary row has NO message id (legacy rows) →
 *   undefined (DB path, as before).
 * - No compartments (#132 early-session) → the whole array is the session;
 *   ordinals from 1, no anchor needed.
 *
 * Live-verified byte-identical to the DB path on every boundary decision field
 * (offset, protectedTailStart, eligibleEndOrdinal, N, trueRawEligibleTokens,
 * arc fencing) across real sessions before the cutover.
 */
export function buildTriggerInMemoryTail(
    db: Database,
    sessionId: string,
    messages: readonly InMemoryMessageView[],
): InMemoryTailSource | undefined {
    if (messages.length === 0) return undefined;
    const lastCompartmentEnd = getLastCompartmentEndMessage(db, sessionId);
    const anchorMessageId = getLastCompartmentEndMessageId(db, sessionId);
    if (lastCompartmentEnd >= 1 && !anchorMessageId) return undefined;

    const built = buildInMemoryTailRawMessages({
        messages,
        lastCompartmentEnd,
        anchorMessageId,
    });
    if (!built) return undefined;
    if (lastCompartmentEnd >= 1 && anchorMessageId && !built.anchorFound) return undefined;
    return { messages: built.messages, absoluteMessageCount: built.absoluteMessageCount };
}

export function getProactiveCompartmentTriggerPercentage(
    executeThresholdPercentage: number,
): number {
    return Math.max(0, executeThresholdPercentage - PROACTIVE_TRIGGER_OFFSET_PERCENTAGE);
}

function estimateProjectedPostDropPercentage(
    db: Database,
    sessionId: string,
    usage: ContextUsage,
    activeTags: readonly TagEntry[],
    clearReasoningAge: number | undefined,
    clearedReasoningThroughTag: number | undefined,
    canClearReasoning: boolean,
): number | null {
    // Denominator must include both text/tool bytes and reasoning bytes to match the numerator
    const totalActiveBytes = activeTags.reduce(
        (sum, tag) => sum + tag.byteSize + tag.reasoningByteSize,
        0,
    );
    if (totalActiveBytes === 0) return null;

    let droppableBytes = 0;

    // 1. Pending user-queued drops (from ctx_reduce) — include both text and reasoning bytes
    //    because dropping a message tag also clears its associated reasoning parts
    const pendingDrops = getPendingOps(db, sessionId).filter((op) => op.operation === "drop");
    const pendingDropTagIds = new Set(pendingDrops.map((op) => op.tagId));
    if (pendingDrops.length > 0) {
        droppableBytes += activeTags
            .filter((tag) => pendingDropTagIds.has(tag.tagNumber))
            .reduce((sum, tag) => sum + tag.byteSize + tag.reasoningByteSize, 0);
    }

    // 2. Reasoning clearing: reasoning bytes on message tags between watermark and age cutoff.
    //    (Phase 2 removed routine age-based tool drops — tool outputs are no longer
    //    projected as droppable here. The tiered emergency drop fires only at the derived force band,
    //    which is above this trigger's window, so it is intentionally not modeled.)
    const maxTag = activeTags.reduce((max, t) => Math.max(max, t.tagNumber), 0);
    if (
        canClearReasoning &&
        clearReasoningAge !== undefined &&
        clearedReasoningThroughTag !== undefined
    ) {
        const reasoningAgeCutoff = maxTag - clearReasoningAge;
        for (const tag of activeTags) {
            if (tag.type !== "message") continue;
            // Skip tags already fully counted in pending drops (text + reasoning)
            if (pendingDropTagIds.has(tag.tagNumber)) continue;
            // Only count reasoning not yet cleared (between watermark and age cutoff)
            if (tag.tagNumber <= clearedReasoningThroughTag) continue;
            if (tag.tagNumber > reasoningAgeCutoff) continue;
            if (tag.reasoningByteSize > 0) {
                droppableBytes += tag.reasoningByteSize;
            }
        }
    }

    if (droppableBytes === 0) return null;

    const dropRatio = Math.min(droppableBytes / totalActiveBytes, 1);
    return usage.percentage * (1 - dropRatio);
}

interface TailInfo {
    nextStartOrdinal: number;
    hasNewRawHistory: boolean;
    hasProtectedEligibleHead: boolean;
    isMeaningful: boolean;
    tokenEstimate: number;
    /**
     * True when the TC chunk scan exhausted its token budget before reaching
     * the end of the eligible head — i.e. the chunked (U:/A:/TC:) content
     * exceeds the scan budget. `tokenEstimate` saturates at the scan budget
     * (the reader stops appending blocks at the cap), so THIS is the signal
     * that the narratable content crossed the tail_size threshold.
     */
    chunkHasMore: boolean;
    trueRawEligibleTokens: number;
    commitClusterCount: number;
    boundarySnapshot?: ProtectedTailBoundarySnapshot;
}

const TAIL_INFO_DEFAULTS: TailInfo = {
    nextStartOrdinal: 1,
    hasNewRawHistory: false,
    hasProtectedEligibleHead: false,
    isMeaningful: false,
    tokenEstimate: 0,
    chunkHasMore: false,
    trueRawEligibleTokens: 0,
    commitClusterCount: 0,
};

function resolveBoundaryContextLimit(usage: ContextUsage, fallbackContextLimit?: number): number {
    if (fallbackContextLimit && fallbackContextLimit > 0) return fallbackContextLimit;
    if (usage.percentage > 0 && usage.inputTokens > 0) {
        return Math.max(1, Math.round(usage.inputTokens / (usage.percentage / 100)));
    }
    return 128_000;
}

function getUnsummarizedTailInfo(
    db: Database,
    sessionId: string,
    triggerBudget: number,
    usage: ContextUsage,
    executeThresholdPercentage: number,
    contextLimit?: number,
    inMemoryTail?: InMemoryTailSource,
    taggerFloor = 0,
): TailInfo {
    return withRawSessionMessageCache(() => {
        try {
            // Prime the scoped cache from MEMORY when the transform supplied its
            // own `args.messages` tail (live-verified byte-identical to the DB
            // read on every boundary decision field) — zero opencode.db reads.
            // Otherwise prime with the TAIL-ONLY DB read so the boundary
            // resolution and chunk scan below read only messages after the last
            // compartment — never the whole session (the O(session) read that
            // froze the JS event loop ~3s on a large session and made every
            // parallel tool.definition hook measure multi-second durations). The
            // boundary math is offset-forward only, so a tail slice anchored at
            // lastCompartmentEnd+1 yields an identical trigger decision. Skipped
            // (full read) when the protected-tail policy hasn't migrated to v3
            // yet, because the one-time v3 seed (getLegacyProtectedTailStartOrdinal)
            // scans ALL user-message parts; once seeded it never runs again.
            // No-op for Pi (provider-backed) and in test/no-DB environments, and
            // when no usable boundary anchor exists (falls through to full read).
            const memoryPrimed = inMemoryTail
                ? primeInMemoryTailRawMessageCache({
                      sessionId,
                      messages: inMemoryTail.messages,
                      absoluteMessageCount: inMemoryTail.absoluteMessageCount,
                  })
                : false;
            if (!memoryPrimed) {
                const policyVersion = loadProtectedTailMeta(
                    db,
                    sessionId,
                ).protectedTailPolicyVersion;
                if (policyVersion >= 3) {
                    primeTailRawMessageCache({
                        sessionId,
                        lastCompartmentEnd: getLastCompartmentEndMessage(db, sessionId),
                        anchorMessageId: getLastCompartmentEndMessageId(db, sessionId),
                    });
                }
            }

            const rawEligibility = getRawHistoryEligibility(db, sessionId);
            if (!rawEligibility.hasRawBeyondLastCompartment) {
                return { ...TAIL_INFO_DEFAULTS, nextStartOrdinal: rawEligibility.offset };
            }

            const boundary =
                process.env.NODE_ENV === "test"
                    ? createDefaultBoundarySnapshotForTests(sessionId)
                    : resolveOpenCodeProtectedTailBoundary({
                          db,
                          sessionId,
                          mode: "trigger",
                          contextLimit: resolveBoundaryContextLimit(usage, contextLimit),
                          executeThresholdPercentage,
                          usage,
                          usageSource: "live",
                          taggerFloor,
                      });
            const hasProtectedEligibleHead = boundary.offset < boundary.protectedTailStart;

            if (!hasProtectedEligibleHead) {
                return {
                    ...TAIL_INFO_DEFAULTS,
                    nextStartOrdinal: rawEligibility.offset,
                    hasNewRawHistory: true,
                    boundarySnapshot: boundary,
                };
            }

            const scanBudget = Math.max(
                MIN_PROACTIVE_TAIL_TOKEN_ESTIMATE,
                triggerBudget * TAIL_SIZE_TRIGGER_MULTIPLIER,
            );
            const chunk = readSessionChunk(
                sessionId,
                scanBudget,
                rawEligibility.offset,
                boundary.protectedTailStart,
            );
            const isMeaningful =
                chunk.hasMore ||
                boundary.trueRawEligibleTokens >= MIN_PROACTIVE_TAIL_TOKEN_ESTIMATE ||
                chunk.tokenEstimate >= MIN_PROACTIVE_TAIL_TOKEN_ESTIMATE ||
                chunk.messageCount >= MIN_PROACTIVE_TAIL_MESSAGE_COUNT;

            return {
                nextStartOrdinal: rawEligibility.offset,
                hasNewRawHistory: true,
                hasProtectedEligibleHead,
                isMeaningful,
                tokenEstimate: chunk.tokenEstimate,
                chunkHasMore: chunk.hasMore,
                trueRawEligibleTokens: boundary.trueRawEligibleTokens,
                commitClusterCount: chunk.commitClusterCount,
                boundarySnapshot: boundary,
            };
        } catch (error) {
            sessionLog(sessionId, "compartment trigger: raw tail inspection failed:", error);
            return TAIL_INFO_DEFAULTS;
        }
    });
}

export function formatProjectedPostDropPercentage(value: number | null): string {
    return value === null ? "none" : `${value.toFixed(1)}%`;
}

export function checkCompartmentTrigger(
    db: Database,
    sessionId: string,
    sessionMeta: SessionMeta,
    usage: ContextUsage,
    _previousPercentage: number,
    executeThresholdPercentage: number,
    triggerBudget: number,
    clearReasoningAge?: number,
    commitClusterTrigger?: { enabled: boolean; min_clusters: number },
    preloadedActiveTags?: readonly TagEntry[],
    contextLimit?: number,
    inMemoryTail?: InMemoryTailSource | LazyInMemoryTailSource,
    taggerFloorOverride?: number,
    reasoningProjection?: ReasoningProjectionCapability,
): CompartmentTriggerResult {
    if (sessionMeta.compartmentInProgress) {
        sessionLog(
            sessionId,
            `compartment trigger: skipped — historian already in progress (usage=${usage.percentage.toFixed(1)}%)`,
        );
        return { shouldFire: false };
    }

    const lazyInMemoryTail = typeof inMemoryTail === "function" ? inMemoryTail : undefined;
    let resolvedInMemoryTail = typeof inMemoryTail === "function" ? undefined : inMemoryTail;

    // An in-memory tail is usable only after the one-time v3 seed, which needs
    // the complete session. Before then, retain the provider-backed fallback.
    if (resolvedInMemoryTail) {
        try {
            const policyVersion = loadProtectedTailMeta(db, sessionId).protectedTailPolicyVersion;
            if (policyVersion < 3) resolvedInMemoryTail = undefined;
        } catch {
            resolvedInMemoryTail = undefined;
        }
    }

    // Tag load-scoping floor (OpenCode only). Both tag scans below — the pre-gate
    // upper-bound sum and the boundary's stored-token map — used to scan the
    // whole session's tags (~100k rows → ~90ms combined every pass) to read data
    // about only the live wire. Scope both reads to `tag_number >= floor`.
    //
    // The caller (transform) passes `taggerFloorOverride` derived directly from
    // the raw wire ids — that path is NOT gated on the compaction-marker anchor,
    // so the floor stays live even on passes where `inMemoryTail` is undefined
    // (post-restart / marker-drain lag, when `buildTriggerInMemoryTail` bails).
    // Those were exactly the passes that regressed to the full ~90ms scan. Fall
    // back to deriving from `inMemoryTail` (its leading ids) when no override is
    // given, then to 0 (Pi / un-seeded migration path) → unchanged full scan.
    // The floor only ever UNDER-estimates (lower = loads more), so the boundary
    // cut stays byte-identical and the pre-gate bound stays a valid upper bound.
    const taggerFloor =
        taggerFloorOverride !== undefined && taggerFloorOverride > 0
            ? taggerFloorOverride
            : resolvedInMemoryTail
              ? deriveTagLoadFloor(
                    db,
                    sessionId,
                    resolvedInMemoryTail.messages.map((m) => m.id),
                )
              : 0;

    // Cheap pre-gate (avoids the full raw tail inspection on every message.updated).
    //
    // getUnsummarizedTailInfo resolves the protected-tail boundary and runs the
    // TC chunk scan / true-raw token walk. Below the proactive floor, the ONLY
    // triggers that can fire are the size-based ones (commit_clusters needs
    // eligible TC-tokens ≥ triggerBudget; tail_size needs true-raw eligible ≥
    // triggerBudget×MULT). The active+dropped tag token sum is a cheap,
    // conservative UPPER BOUND on already-tagged eligible-tail tokens (eligible
    // ⊆ the post-compaction live tail covered by active/dropped tags; any
    // pre-boundary still-active tag only inflates it). When the transform passes
    // an in-memory tail, it may include newest messages that run BEFORE tagging,
    // so add a real per-message true-raw estimate for exactly those uncovered
    // in-memory messages. Only trust the persisted bound when the tag store is
    // fully backfilled (nullCount === 0); a cold/partial store undercounts and
    // falls through to the authoritative path.
    const proactiveFloorForGate = getProactiveCompartmentTriggerPercentage(
        executeThresholdPercentage,
    );
    if (usage.percentage < proactiveFloorForGate) {
        try {
            // Bound must include DROPPED tags: ctx_reduce/emergency drops
            // remove tool output from the wire but the raw content still
            // counts toward the historian's true-raw chunk size — an
            // active-only bound undercounts after drops and suppresses real
            // tail-size triggers. Scoped to the live-wire floor: a whole-session
            // sum is a uselessly-loose bound AND leaves nullCount stuck at the
            // legacy-row count forever (never backfilled), so the skip could never
            // trigger; scoping makes it a tight valid upper bound with nullCount≈0.
            // When there IS an in-memory tail, the scoped floor is safe: any live
            // tag sitting below the floor has its owner message in `inMemoryTail`
            // and is NOT in the (also-floor-scoped) covered-owner set, so
            // estimateUntaggedInMemoryTailUpperBound charges its true-raw tokens —
            // nothing is lost. But with NO in-memory tail (post-restart /
            // marker-drain lag) there is no such compensation: a scoped bound would
            // silently DROP the tokens of any live tool tag below the floor and
            // could falsely cheap-skip a needed historian fire (context overflow).
            // So fall back to floor 0 here — the full active+dropped sum is still a
            // valid UPPER bound (pre-boundary tags only inflate it), just looser.
            // A lazy source is supplied only after the caller has tagged the live
            // wire, so its scoped persisted sum already covers the retained tail.
            const boundFloor = resolvedInMemoryTail || lazyInMemoryTail ? taggerFloor : 0;
            const { bound: persistedBound, nullCount } = getTriggerTagTokenUpperBound(
                db,
                sessionId,
                boundFloor,
            );
            if (nullCount === 0) {
                const untaggedUpperBound = resolvedInMemoryTail
                    ? estimateUntaggedInMemoryTailUpperBound(
                          db,
                          sessionId,
                          resolvedInMemoryTail,
                          taggerFloor,
                      )
                    : 0;
                const eligibleUpperBound = persistedBound + untaggedUpperBound;
                // Smallest token floor any size trigger needs is triggerBudget
                // (commit_clusters). tail_size needs even more. Equality falls
                // through to preserve the existing conservative < semantics.
                if (eligibleUpperBound < triggerBudget) {
                    const memorySuffix = resolvedInMemoryTail
                        ? ` (persisted=${persistedBound}, untagged-memory≤${untaggedUpperBound})`
                        : "";
                    sessionLog(
                        sessionId,
                        `compartment trigger: cheap-skip at ${usage.percentage.toFixed(1)}% (below proactive floor ${proactiveFloorForGate}%) — live-tail upper bound ${eligibleUpperBound}${memorySuffix} < triggerBudget ${triggerBudget}; no size trigger possible, skipped full raw read`,
                    );
                    return { shouldFire: false };
                }
            }
        } catch (error) {
            // Best-effort gate: any failure falls through to the authoritative
            // (expensive) path, never changing behavior — only its cost.
            sessionLog(
                sessionId,
                `compartment trigger: cheap-gate skipped (falling through to full read): ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    if (lazyInMemoryTail) {
        try {
            const policyVersion = loadProtectedTailMeta(db, sessionId).protectedTailPolicyVersion;
            if (policyVersion >= 3) resolvedInMemoryTail = lazyInMemoryTail();
        } catch {
            resolvedInMemoryTail = undefined;
        }
    }

    const tailInfo = getUnsummarizedTailInfo(
        db,
        sessionId,
        triggerBudget,
        usage,
        executeThresholdPercentage,
        contextLimit,
        resolvedInMemoryTail,
        taggerFloor,
    );
    if (!tailInfo.hasNewRawHistory) {
        // Diagnostic data collection is best-effort. The helpers can throw if
        // the OpenCode session DB is unavailable (e.g. in unit-test env or
        // when the harness has not yet wired a RawMessageProvider). A throw
        // here would propagate to the caller's try/catch and prevent
        // downstream state updates (e.g. session-meta writes in event-handler
        // line 542). Swallow any failure and log without the diagnostic
        // fields so callers see no behavioral change.
        try {
            const lastCompartmentEnd = getLastCompartmentEndMessage(db, sessionId);
            sessionLog(
                sessionId,
                `compartment trigger: skipped — no new raw history (usage=${usage.percentage.toFixed(1)}% nextStartOrdinal=${tailInfo.nextStartOrdinal} lastCompartmentEnd=${lastCompartmentEnd})`,
            );
        } catch (error) {
            sessionLog(
                sessionId,
                `compartment trigger: skipped — no new raw history (usage=${usage.percentage.toFixed(1)}% nextStartOrdinal=${tailInfo.nextStartOrdinal} diagnostic-collection-failed: ${error instanceof Error ? error.message : String(error)})`,
            );
        }
        return { shouldFire: false };
    }

    // Never project reclaimed reasoning unless this harness can actually clear it
    // from the provider wire. Both harnesses now supply `canClearReasoning`
    // explicitly — OpenCode passes the capability its transform already resolved,
    // Pi passes its own. The predicate below is a provider-id-only fallback for a
    // caller that supplies neither; it under-reports for a custom provider serving
    // Claude, so a new caller should pass the capability rather than rely on it.
    const canClearReasoning =
        reasoningProjection?.canClearReasoning ??
        modelAcceptsEmptyContent(reasoningProjection?.providerID);
    const projectedPostDropPercentage = estimateProjectedPostDropPercentage(
        db,
        sessionId,
        usage,
        preloadedActiveTags ?? getActiveTagsBySession(db, sessionId),
        clearReasoningAge,
        sessionMeta.clearedReasoningThroughTag,
        canClearReasoning,
    );
    const relativePostDropTarget = executeThresholdPercentage * POST_DROP_TARGET_RATIO;

    const forceMaterializationPercentage = escalationBands(
        executeThresholdPercentage,
    ).forceMaterializationPercentage;
    // Force only at the threshold-derived band; below it the proactive path retains precedence.
    if (usage.percentage >= forceMaterializationPercentage) {
        if (
            projectedPostDropPercentage !== null &&
            projectedPostDropPercentage <= relativePostDropTarget
        ) {
            sessionLog(
                sessionId,
                `historian redundancy skip: summarizer not needed this pass — force band is ${forceMaterializationPercentage}%; queued/automatic drops are projected to reclaim to ${projectedPostDropPercentage.toFixed(1)}% (target ${relativePostDropTarget.toFixed(1)}%) on the next eligible execute pass`,
            );
            return { shouldFire: false };
        }

        sessionLog(
            sessionId,
            `compartment trigger: force-firing at ${usage.percentage.toFixed(1)}% (projected post-drop ${formatProjectedPostDropPercentage(projectedPostDropPercentage)})`,
        );
        if (tailInfo.boundarySnapshot && hasRunnableCompartmentWindow(tailInfo.boundarySnapshot)) {
            return {
                shouldFire: true,
                reason: "force_band",
                boundarySnapshot: tailInfo.boundarySnapshot,
            };
        }
        const scale = usage.percentage >= BLOCK_UNTIL_DONE_PERCENTAGE ? 0.25 : 0.5;
        // Scaled re-resolution must read from the same source as the primary
        // inspection: prime from the in-memory tail when supplied (zero DB
        // reads), otherwise this rare force-band path does its own full read as before.
        const scaledBoundary = withRawSessionMessageCache(() => {
            if (resolvedInMemoryTail) {
                primeInMemoryTailRawMessageCache({
                    sessionId,
                    messages: resolvedInMemoryTail.messages,
                    absoluteMessageCount: resolvedInMemoryTail.absoluteMessageCount,
                });
            }
            return resolveOpenCodeProtectedTailBoundary({
                db,
                sessionId,
                mode: "trigger",
                contextLimit: resolveBoundaryContextLimit(usage, contextLimit),
                executeThresholdPercentage,
                usage,
                usageSource: "live",
                emergencyTailScale: scale,
            });
        });
        if (hasRunnableCompartmentWindow(scaledBoundary)) {
            return { shouldFire: true, reason: "force_band", boundarySnapshot: scaledBoundary };
        }
        sessionLog(
            sessionId,
            "compartment trigger: force_band skipped — raw exists but protected head genuinely empty after emergency tail scale",
        );
        return { shouldFire: false };
    }

    // Commit-cluster trigger: N+ distinct work phases with commits, enough token volume
    const clusterEnabled = commitClusterTrigger?.enabled ?? true;
    const minClusters =
        commitClusterTrigger?.min_clusters ?? DEFAULT_MIN_COMMIT_CLUSTERS_FOR_TRIGGER;
    if (
        clusterEnabled &&
        tailInfo.commitClusterCount >= minClusters &&
        tailInfo.tokenEstimate >= triggerBudget
    ) {
        sessionLog(
            sessionId,
            `compartment trigger: commit-cluster fire — ${tailInfo.commitClusterCount} clusters (min=${minClusters}), ~${tailInfo.tokenEstimate} tokens in eligible prefix`,
        );
        return {
            shouldFire: true,
            reason: "commit_clusters",
            boundarySnapshot: tailInfo.boundarySnapshot,
        };
    }

    // Tail-size trigger: enough NARRATABLE material accumulated, regardless of
    // pressure or commits. Measured on the TC-chunked estimate (U:/A:/TC:
    // lines — what the historian actually condenses), NOT true-raw. NOTE: this
    // is a deliberate two-axis split, do not re-unify. True-raw (tool outputs
    // included) is the axis for the BOUNDARY and the pressure paths, because
    // it measures wire occupancy. But firing tail_size on true-raw made
    // tool-heavy sessions fire at 25% usage on a few file reads — each run
    // narrating ~700 tokens of content into a confetti compartment (observed
    // live: spans degraded 155 → 27 messages/compartment over one session).
    // Under no pressure the agent is managing its own context (drops working);
    // the historian shouldn't spawn until there's enough chunked data to make
    // a properly-sized compartment. Tool-heavy-but-thin tails are covered by
    // the pressure paths (proactive floor / force band), which fire on occupancy.
    // The chunk scan budget IS the threshold (scanBudget = max(min-estimate,
    // budget×multiplier)), so tokenEstimate saturates at the cap — "≥ cap OR
    // the scan ran out of budget with more blocks remaining" is the complete
    // crossed-the-threshold signal.
    if (
        tailInfo.tokenEstimate >= triggerBudget * TAIL_SIZE_TRIGGER_MULTIPLIER ||
        (tailInfo.chunkHasMore && tailInfo.tokenEstimate > 0)
    ) {
        sessionLog(
            sessionId,
            `compartment trigger: tail-size fire — ~${tailInfo.tokenEstimate} TC-chunked tokens (hasMore=${tailInfo.chunkHasMore}, true-raw ~${tailInfo.trueRawEligibleTokens}) exceeds ${triggerBudget * TAIL_SIZE_TRIGGER_MULTIPLIER} budget threshold`,
        );
        return {
            shouldFire: true,
            reason: "tail_size",
            boundarySnapshot: tailInfo.boundarySnapshot,
        };
    }

    // Pressure-driven trigger: context is near threshold and drops aren't enough
    const proactiveTriggerPercentage = getProactiveCompartmentTriggerPercentage(
        executeThresholdPercentage,
    );
    if (usage.percentage < proactiveTriggerPercentage) {
        sessionLog(
            sessionId,
            `compartment trigger: not firing at ${usage.percentage.toFixed(1)}% — below proactive floor (${proactiveTriggerPercentage}%)`,
        );
        return { shouldFire: false };
    }

    if (
        projectedPostDropPercentage !== null &&
        projectedPostDropPercentage <= relativePostDropTarget
    ) {
        sessionLog(
            sessionId,
            `historian redundancy skip: summarizer not needed this pass — usage is ${usage.percentage.toFixed(1)}%; queued/automatic drops are projected to reclaim to ${projectedPostDropPercentage.toFixed(1)}% (target ${relativePostDropTarget.toFixed(1)}%) on the next eligible execute pass`,
        );
        return { shouldFire: false };
    }

    if (!tailInfo.hasProtectedEligibleHead || !tailInfo.isMeaningful) {
        sessionLog(
            sessionId,
            `compartment trigger: not firing at ${usage.percentage.toFixed(1)}% because unsummarized tail from ${tailInfo.nextStartOrdinal} is too small`,
        );
        return { shouldFire: false };
    }

    sessionLog(
        sessionId,
        `compartment trigger: proactive fire at ${usage.percentage.toFixed(1)}% (floor=${proactiveTriggerPercentage}% projected post-drop=${formatProjectedPostDropPercentage(projectedPostDropPercentage)} target=${relativePostDropTarget.toFixed(1)}%)`,
    );
    return {
        shouldFire: true,
        reason: "projected_headroom",
        boundarySnapshot: tailInfo.boundarySnapshot,
    };
}
