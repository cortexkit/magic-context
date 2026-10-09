import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_HISTORIAN_TIMEOUT_MS } from "../../config/schema/magic-context";
import {
    resolveProjectIdentity,
    resolveProjectIdentityForSession,
} from "../../features/magic-context/memory/project-identity";
import { drainSingleStoreEmbeddingWatermarks } from "../../features/magic-context/memory/single-store-embedding-drain";
import {
    modelKeyAcceptsImages,
    resolveMuralWire,
} from "../../features/magic-context/mural/render-trigger";
import type { MuralWireOptions } from "../../features/magic-context/mural/resolve-mural";
import { muralSourceRevision } from "../../features/magic-context/mural/source-revision";
import { getMuralIdentity } from "../../features/magic-context/mural/storage-mural";
import { isPrefixBoundThinkingModel } from "../../features/magic-context/overflow-detection";
import { parseCacheTtl } from "../../features/magic-context/scheduler";
import { resolveSessionCacheTtl } from "../../features/magic-context/session-cache-ttl";
import { recordSessionProjectIdentity } from "../../features/magic-context/session-project-storage";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import {
    casChannel2NudgeState,
    clearEmergencyRecovery,
    clearPersistedTodoSyntheticAnchor,
    clearThinkingBindingRecoveryIf,
    getChannel2NudgeState,
    getEmergencyRecoveryArmedAt,
    getOverflowState,
    getPendingCompactionMarkerState,
    getPersistedCompactionMarkerState,
    getPersistedTodoPermissionDenied,
    isEmergencyRecoveryArmed,
    isProviderOverflowFailClosedProven,
    isProviderOverflowReconfirmed,
    loadProtectedTailMeta,
    resolveEpochFloorForPass,
    setPersistedTodoPermissionDenied,
    setPersistedTodoSyntheticAnchor,
} from "../../features/magic-context/storage-meta-persisted";
import { hasPendingDropOps } from "../../features/magic-context/storage-ops";
import {
    isRustMarkerAdmissionFenced,
    setRustMarkerAdmissionFence,
} from "../../features/magic-context/storage-replay-document";
import { writeRustTransformDecision } from "../../features/magic-context/transform-decision-log";
import type { ContextUsage } from "../../features/magic-context/types";
import { canonicalModelIdentity } from "../../shared/harness-provider-map";
import { log, sessionLog } from "../../shared/logger";
import { getSdkOutputLimit, getSdkWindowGeometry } from "../../shared/models-dev-cache";
import { promptSurfaceConfigIdentity, resolvePromptSurface } from "../../shared/prompt-surface";
import { createPromptSurfaceGuidanceEpochCache } from "../../shared/prompt-surface-runtime";
import {
    isTransientSqliteError,
    withAsyncPrivilegedWriter,
    withoutSqliteTransformPass,
    withSqliteBackgroundWriter,
    withSqliteTransformPass,
} from "../../shared/sqlite";
import { renderUserFacingFailure } from "../../shared/user-facing-codes";
import type { WindowGeometryResult } from "../../shared/window-geometry";
import { markerUpdateDefinitelyDidNotCut } from "./compaction-marker-manager";
import {
    cachedToolPermissionDenied,
    resolveCtxReduceAvailability,
    resolveCtxReduceAvailabilityFromMessages,
    resolveTodowriteAvailability,
    resolveTodowriteAvailabilityFromMessages,
    type ToolAvailabilityVerdict,
    todowritePermissionDenied,
} from "./ctx-reduce-availability";
import {
    resolveHistorianProducerLimits,
    resolveKnownHistorianContextLimit,
} from "./derive-budgets";
import { isEditTool } from "./edit-marker";
import { invalidateAutoEmbedSession } from "./embed-session-state";
import {
    EmergencyFailClosedError,
    ENGINE_RECONNECTING_USER_MESSAGE,
} from "./emergency-fail-closed";
import {
    resolveContextWindowGeometry,
    resolveExecuteThreshold,
    resolveModelKey,
    resolveTrustedContextLimit,
} from "./event-resolvers";
import {
    createFinalWireUsageTracker,
    estimateFinalWireInputTokens,
} from "./final-wire-token-estimate";
import { createHistorianHostRunner } from "./historian-host-runner";
import {
    hasActiveAnthropicThinkingTurn,
    latestAssistantTurnMessages,
} from "./latest-assistant-turn";
import {
    captureLatestTurnOriginals,
    prepareLatestThinkingRecovery,
} from "./latest-thinking-recovery";
import {
    claimLkgRequestIdentity,
    type LkgRequestIdentity,
    noteCapturedLkgRequest,
} from "./lkg-measured-request";
import { clearPersistedLkgSlotStrict, saveLkgSlotToDb } from "./lkg-persist";
import {
    coldStartRawServedIndex,
    coldStartUncapturedReplay,
    replayLkg,
    resolveLkgModelKeys,
} from "./lkg-replay";
import {
    lkgReplayFits,
    lkgReplayLimit,
    measureLkgReplay,
    measureLkgReplayRequest,
    RAW_FALLBACK_BYTES_PER_CONTEXT_TOKEN,
} from "./lkg-replay-fit";
import { recordServedCapture, recordServedSlotState } from "./lkg-served-marker";
import {
    captureSlot,
    contentSnapshotValue,
    dropSlot,
    exactReusablePrefix,
    forgetInMemorySlot,
    getSlot,
    incrementalLkgContentDigests,
    LKG_SNAPSHOT_ARRAY,
    LKG_SNAPSHOT_BOOLEAN,
    LKG_SNAPSHOT_KEY,
    LKG_SNAPSHOT_NULL,
    LKG_SNAPSHOT_NUMBER,
    LKG_SNAPSHOT_OBJECT,
    LKG_SNAPSHOT_STRING,
    LKG_SNAPSHOT_UNDEFINED,
    type LkgEntryNote,
    type LkgInputSnapshot,
    type LkgSlot,
    lkgSlotRejection,
    type MessageContentSnapshot,
    messageContentFields,
    messageContentSnapshot,
    noteEntry,
    signatureForFields,
    visitMessageContentFields,
} from "./lkg-slot";
import {
    type ModuleStateSyncClient,
    type ModuleStateSyncState,
    syncModuleState,
} from "./module-state-sync";
import {
    isModuleTransportGenerationChangedResult,
    TRANSFORM_PAGE_UPLOAD_TIMEOUT_MS,
    transformColdStartExecuteTimeoutMs,
} from "./module-transport";
import {
    buildPagedModuleTransformPayloads,
    cloneModuleNativeOutput,
    encodeOpenCodeMessagesToCk,
    type OrdinalMemoCheckpoint,
    type OrdinalResolveStats,
    resolveOrdinalsForModule,
} from "./module-wire";
import { moveMessageDigestFromFields } from "./move-inputs";
import { onNoteTrigger } from "./note-nudger";
import { RECOVERY_NO_HEAD_LIMIT } from "./protected-tail-boundary";
import { RawFallbackContextLimitError } from "./raw-fallback-context-limit";
import { findLastAssistantModelFromOpenCodeDb } from "./read-session-db";
import type { RawMessageOrdinalAnchor } from "./read-session-raw";
import { resolveKeepReasoningTokens } from "./reasoning-budget";
import { captureOpencodeReasoningBudgetStatus } from "./reasoning-budget-status";
import {
    nextRustPassStamp,
    type RustLkgReplayParticipant,
    registerRustLkgReplayParticipant,
} from "./rust-lkg-freeze-registry";
import { isAnthropicFamilyRoute } from "./sentinel";
import { SharedCompartmentBoundaryError } from "./shared-compartment-boundaries";
import { singleStoreMigrationRequiredFailure } from "./single-store-refusal";
import { StorageBusyRefusalError } from "./storage-busy-refusal";
import { STORE_AHEAD_OF_BINARY_CODE, storeAheadOfBinaryFailure } from "./store-ahead-refusal";
import { snapshotTrailingBlankSourceDecisions } from "./strip-content";
import { computeSyntheticCallId, normalizeTodoStateJson } from "./todo-view";
import type { TransformDeps } from "./transform";
import { resolveHistoryBudgetTokens } from "./transform";
import { loadContextUsage } from "./transform-context-state";
import type { MessageLike } from "./transform-operations";
import type { FrozenReleaseLastServed } from "./transform-postprocess-phase";
import {
    replayRustModeBindingMismatchStrips,
    runRustModePostprocess,
    rustModeServedKeyAfterPersistedStrips,
    type ThinkingBindingRecoveryApplication,
} from "./transform-postprocess-phase";
import { logTransformTiming } from "./transform-stage-logger";

class RustTransformProtocolError extends Error {
    readonly code = "rust_transform_protocol_error";

    constructor(message: string) {
        super(message);
        this.name = "RustTransformProtocolError";
    }
}

/**
 * A frozen replay is over the trusted context limit, and the module's output is
 * over it too (or cannot be shown to fit). Neither array can be sent, so the pass
 * refuses even without a prior provider rejection. The module itself is
 * healthy, so this is not counted as a module failure.
 */
class FrozenReplayOverProvenLimitRefusal extends Error {
    constructor(
        readonly moduleFit: FrozenFit,
        readonly limit: number,
    ) {
        super(`frozen replay and module output are over the provider-proven limit ${limit}`);
        this.name = "FrozenReplayOverProvenLimitRefusal";
    }
}

/** Where an array stands against a context limit; see `measureAgainstLimit` in `run`. */
type FrozenFit = "under" | "over" | "unproven";

export const RUST_FAILURE_PARK_THRESHOLD = 3;
export const RUST_PARK_RETRY_INTERVAL = 5;
export const RUST_EMERGENCY_WALL_PCT = 95;
export const RUST_PARK_PROBE_PRESSURE_BYPASS_PCT = 90;
const RUST_SEND_TIMEOUT_MS = 15_000;
export const RUST_STALL_PROBE_AFTER_MS = 10_000;
export const RUST_HEALTH_PROBE_TIMEOUT_MS = 2_000;
// Healthy passes and raw growth are recovery debt, not permission to rewrite bytes
// the provider already cached. A valid, fitting replay waits for a producer rebuild.

/** Representation adoption does not grant marker, reduction or blanket strip authority. */
function shouldAdoptModuleAfterFreeze(
    prefixRebuildPermitted: boolean,
    frozenReplayReleased: boolean,
): boolean {
    return prefixRebuildPermitted || frozenReplayReleased;
}

function activeAgentFromMessages(messages: readonly MessageLike[]): string | undefined {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const info = messages[index]?.info as { role?: unknown; agent?: unknown } | undefined;
        if (info?.role !== "user") continue;
        return typeof info.agent === "string" && info.agent.length > 0 ? info.agent : undefined;
    }
    return undefined;
}

async function resolveCombinedTodowriteVerdict(
    deps: TransformDeps,
    sessionId: string,
    messages: readonly MessageLike[],
    availability: ToolAvailabilityVerdict,
    timings: RustPassTimings,
    probeFresh = true,
): Promise<boolean> {
    if (!availability.frozen || !availability.callable || deps.compactionOff === true) return false;

    const persistedDenied = getPersistedTodoPermissionDenied(deps.db, sessionId);
    if (!probeFresh && persistedDenied !== null) return !persistedDenied;
    let permissionDenied =
        cachedToolPermissionDenied(sessionId, "todowrite") ?? persistedDenied ?? false;
    if (deps.client) {
        try {
            const probeStartedAt = performance.now();
            permissionDenied = await todowritePermissionDenied(
                deps.client,
                sessionId,
                activeAgentFromMessages(messages),
            );
            timings.todoProbe += performance.now() - probeStartedAt;
            const persistStartedAt = performance.now();
            // Only todo changes and synthesis opportunities revalidate with the host.
            // Avoid rewriting an unchanged durable verdict after that fresh read.
            if (persistedDenied !== permissionDenied) {
                setPersistedTodoPermissionDenied(deps.db, sessionId, permissionDenied);
            }
            timings.todoPersist += performance.now() - persistStartedAt;
        } catch (error) {
            // A failed SDK read cannot turn a prior denial into an allow. Keep the last
            // in-memory or durable verdict until a later pass obtains authoritative data.
            sessionLog(
                sessionId,
                "todowrite permission read failed; retaining the last successful verdict:",
                error,
            );
        }
    }
    return !permissionDenied;
}

export interface RustModeModuleClient extends ModuleStateSyncClient {
    call(
        args: Parameters<ModuleStateSyncClient["call"]>[0] & {
            onTimings?: (timings: import("./module-transport").ModuleCallTimings) => void;
        },
    ): Promise<unknown>;
    deleteSession?(sessionId: string, projectRoot: string): Promise<void>;
    closeSession?(sessionId: string): void;
}

interface RustLkgCapturePlan {
    servedCaptureId?: number;
    sessionId: string;
    inputIds: string[];
    inputSnapshots: readonly Pick<MessageContentSnapshot, "fields">[];
    jsonPrefix: string;
    modelKey: string | null;
    providerKey: string | null;
    capturedAt: number;
    rowVersion: number;
    captureSequence: number;
    requestIdentity?: LkgRequestIdentity;
    systemPromptTokens: number;
    agentName?: string;
}

interface RustWireCache {
    rawCount: number;
    wireCount: number;
    rawLastId: string | null;
    rawLastSignature: string | null;
    rawLastVisible: boolean;
    /** Content-sensitive per-message snapshots for the whole raw array. Delta passes
     * re-verify every reused message so in-place edits cannot ride a stale prefix. */
    rawContentSnapshots: Pick<MessageContentSnapshot, "fields">[];
    ckFingerprint: string;
    ckPrefixFingerprintBeforeLast: string;
    nativeFingerprint: string;
    nativePrefixFingerprintBeforeLast: string;
    fingerprint: string;
    /** Previous acknowledged module output. The array is reused by reference and supplies the
     * prefix for a validated native-output delta; eviction falls back to a full response. */
    nativeOutput?: unknown[];
}

class MagicContextRustHeapHolder {
    readonly wireCaches = new Map<string, RustWireCache>();
}

export interface RustWireCacheHeapStats {
    snapshots: number;
    rawContentSnapshots: number;
    estimatedBytes: number;
    sessions: Array<{
        sessionId: string;
        rawMessages: number;
        wireMessages: number;
        rawContentSnapshots: number;
        estimatedBytes: number;
    }>;
}

function rustWireCacheEstimatedBytes(cache: RustWireCache): number {
    let bytes = 0;
    for (const value of [
        cache.rawLastId,
        cache.rawLastSignature,
        cache.ckFingerprint,
        cache.ckPrefixFingerprintBeforeLast,
        cache.nativeFingerprint,
        cache.nativePrefixFingerprintBeforeLast,
        cache.fingerprint,
    ]) {
        if (value) bytes += value.length * 2;
    }
    for (const snapshot of cache.rawContentSnapshots) {
        for (const field of snapshot.fields) {
            if (typeof field === "string") bytes += field.length * 2;
            else if (typeof field === "number" || typeof field === "boolean") bytes += 8;
            else bytes += String(field).length * 2;
        }
    }
    if (cache.nativeOutput) {
        try {
            bytes += Buffer.byteLength(JSON.stringify(cache.nativeOutput));
        } catch {
            // Cyclic host extensions are excluded from the serialized estimate.
        }
    }
    return bytes;
}

interface RustSessionState extends ModuleStateSyncState {
    initialized: boolean;
    todoProbeIdentity?: string;
    todoBustIdentity?: string;
    todoProbeNextPass?: boolean;
    /** Todo-only signatures survive transport-cache eviction. A full wire resend
     * must not make an unchanged origin call look like a new todowrite. */
    todoCallSignatures?: Map<string, string>;
    /** Last seen compartment `max_sequence:count` for this session; a change re-arms auto-embed. */
    autoEmbedCompartmentMark?: string;
    /** Last transform-response compartment key; the compartment query runs only when it moves. */
    autoEmbedCompartmentKey?: string;
    lastAppliedAtMs?: number;
    consecutiveFailures: number;
    passCount: number;
    parked: boolean;
    passesSincePark: number;
    warningSent: boolean;
    /** Set when the module answered need_full_sync: the next pass must send the
     * full wire array (delta eligibility bypassed) until a pass applies. Wire-layer
     * only — never triggers a state re-seed. */
    forceFullWire: boolean;
    ordinalMemoAnchor: RawMessageOrdinalAnchor | null;
    ordinalMemoStoredCount: number | null;
    ordinalMemoCanonicalCount: number;
    /** Page checkpoints of the host-store ordinal walk; lets a drift resume from the
     * newest intact page instead of re-reading the whole session. */
    ordinalMemoCheckpoints: OrdinalMemoCheckpoint[];
    /** A lifecycle event (message removal) may have shifted ordinals the memo still
     * holds, so the next resolution must probe the store before trusting it. */
    ordinalMemoVerifyPending: boolean;
    /** Why the ordinal memo is empty, reported when the next resolution re-reads the
     * whole session: `cold` until the first prime, otherwise the reset reason. */
    ordinalMemoResetCause: string;
    /** Durable prior-lineage tail returned by the module after descent. Fresh arrays
     * continue after this base instead of regenerating index+1 ordinals. */
    ordinalContinuationBase: number | null;
    failureCount: number;
    parkCount: number;
    syntheticTurnCount: number;
    lastObservedUserMessageId: string | null;
    syntheticLoopBreakerLogged: boolean;
    recordedSessionProjectIdentity: string | null;
    recordedSessionDirectory: string | null;
    resolvedMemoryProjectDirectory: string | null;
    resolvedMemoryProjectPath: string | null;
    stateSyncInputSignature: string | null;
    muralCache: { key: string; revision: string; value: MuralWireOptions } | null;

    lkgCaptureSequence: number;
    /**
     * Capture sequence of the snapshot prepared from the array the previous pass
     * served, or null when that pass served something it did not capture (a
     * last-known-good replay after a module error or park, raw input, or a
     * declined capture). A slot with this sequence is provably the last-served array.
     */
    lkgLastServedCaptureSequence: number | null;
    lkgLastCapturedRowVersion: number;
    lkgSyncCaptureRequired: boolean;
    /** Block last-known-good request (LKG) replay until rebuilt messages pass all send checks. */
    markerAdmissionFenced: boolean;
    lastPassMarkerApplyAttempted: boolean;
    lkgAcceptedCapture?: {
        inputs: readonly LkgInputSnapshot[];
        captureSequence: number;
        rowVersion: number;
    };
    /** A fallback replay is provider-visible output. Keep that exact representation
     * through ordinary defers until a producer rebuild or safety escape adopts native bytes. */
    lkgRepresentationFrozen: boolean;
    lkgFrozenHealthyPasses: number;
    lkgFrozenAtInputCount: number | null;
    /**
     * True until this process's first pass for the session applies module output.
     * That pass checks whether the durable slot it inherited was captured from a
     * frozen serve (a previous process froze and captured raw bytes) and, if so,
     * resumes the freeze instead of adopting module output.
     */
    lkgColdStartCheckPending: boolean;
    /** Highest fold coverage ordinal this process has already armed the deferred-note
     * nudge for. Null until the first committed boundary of the process is observed. */
    noteNudgePublishedOrdinal: number | null;
}

export interface RustModeTransformOptions {
    moduleClient: RustModeModuleClient;
    hostClient?: unknown;
    projectRoot?: string;
    notifyParked?: (sessionId: string, message: string) => void;
    moduleTimeoutMs?: number;
    /** Test-only page-size override for exercising multi-page control flow with small fixtures. */
    modulePageMaxBytes?: number;
    memorySyncRequestedSessions?: Set<string>;
    /** Override only for deterministic capture scheduling in tests. */
    scheduleLkgCapture?: (capture: () => void) => void;
    /** Override only to exercise a failure at the native-output installation boundary. */
    installNativeMessagesForTests?: (output: { messages: unknown[] }, messages: unknown[]) => void;
    /** Override only to exercise raw-fallback estimator failures in tests. */
    rawFallbackEstimatorForTests?: typeof estimateFinalWireInputTokens;
    /** Override only to observe mural candidate resolution in tests. */
    muralResolverForTests?: typeof resolveMuralWire;
    /** Override only to observe session-identity caching in tests. */
    sessionProjectIdentityResolverForTests?: typeof resolveProjectIdentityForSession;
    /** Override only to observe memory-project identity caching in tests. */
    memoryProjectIdentityResolverForTests?: typeof resolveProjectIdentity;
    /** Arm host-side turn recovery after an engine-reconnecting refusal. */
    onEngineReconnectRefusal?: (args: {
        sessionId: string;
        projectRoot: string;
        refusedUserMessageId: string;
        providerProvenEmergency: boolean;
        compactionOff: boolean;
    }) => void;
    /** Disable hot-path I/O caches to establish an uncached differential-timing baseline. */
    disableHotPathIoCachesForTests?: boolean;
    /** Test-only callback after a capture is accepted, reporting the reused digest prefix length. */
    onLkgCaptureForTests?: (reusedPrefix: number) => void;
    /** Test-only override for the stalled-request health-probe threshold. */
    stallProbeAfterMsForTests?: number;
    /** Test-only clock for the module deadline and stalled-transform probe. */
    clockForTests?: {
        setTimeout: typeof setTimeout;
        clearTimeout: typeof clearTimeout;
        now: () => number;
    };
    /** Test-only override for the health-probe deadline. */
    healthProbeTimeoutMsForTests?: number;
    /**
     * Replaces the historian pull loop this transform would build for itself.
     * Tests use it to drive the loop deterministically; production never sets it.
     */
    historianHostRunnerForTests?: HistorianHostRunnerSeam;
}

/** What the transform needs from the historian pull loop, and nothing more. */
export interface HistorianHostRunnerSeam {
    pump(routeSessionId: string): Promise<void>;
    stop(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object";
}

function moduleFailureCode(error: unknown): string | null {
    let current = error;
    const seen = new Set<unknown>();
    while (isRecord(current) && !seen.has(current)) {
        seen.add(current);
        if (typeof current.code === "string" && current.code.length > 0) return current.code;
        if (typeof current.message === "string") {
            try {
                const detail: unknown = JSON.parse(current.message);
                if (isRecord(detail) && typeof detail.code === "string") return detail.code;
            } catch {
                // Human-readable transport errors need no typed classification.
            }
        }
        current = current.cause;
    }
    return null;
}

function isNonRetryableStateSyncFailure(error: unknown): boolean {
    return moduleFailureCode(error) === "state_sync_non_retryable";
}

/**
 * OpenCode retains the original messages array when it serializes a transform result.
 * Mutate that array in place so the module response reaches the wire, while returning
 * the same array for callers that also consume the hook result.
 */
function replaceMessagesInPlace(output: { messages: unknown[] }, next: unknown[]): unknown[] {
    const target = output.messages;
    if (target !== next) target.splice(0, target.length, ...next);
    return target;
}

function messageInfo(value: unknown): Record<string, unknown> {
    if (!isRecord(value)) return {};
    return isRecord(value.info) ? value.info : value;
}

function messageIdOf(message: MessageLike): string | null {
    const id = messageInfo(message).id;
    return typeof id === "string" && id.length > 0 ? id : null;
}

function contentSnapshotsFor(
    messages: readonly MessageLike[],
): Pick<MessageContentSnapshot, "fields">[] {
    // Copy primitive field tokens before the RPC so later host mutations cannot alter
    // this snapshot. Wire-prefix validation compares the fields directly, without a hash.
    return messages.map((message) => ({ fields: messageContentFields(message) }));
}

function rustCaptureDigests(
    inputs: readonly LkgInputSnapshot[],
    prior: LkgSlot | undefined,
    acceptedInputs: readonly LkgInputSnapshot[] | null,
) {
    const reusablePrefix = prior?.inputContentSignatures
        ? exactReusablePrefix(inputs, acceptedInputs)
        : 0;
    const inputContentSignatures = [
        ...(prior?.inputContentSignatures?.slice(0, reusablePrefix) ?? []),
        ...inputs.slice(reusablePrefix).map((input) => signatureForFields(input.fields)),
    ];
    const incremental = incrementalLkgContentDigests(
        inputs.map((input, index) => ({
            ...input,
            signature: inputContentSignatures[index] ?? "",
        })),
        prior?.inputContentSignatures
            ? {
                  ids: prior.inputIdSeq.slice(0, reusablePrefix),
                  signatures: prior.inputContentSignatures.slice(0, reusablePrefix),
                  digests: prior.inputContentDigests.slice(0, reusablePrefix),
              }
            : undefined,
    );
    return { ...incremental, inputContentSignatures };
}

function messageMatchesContentSnapshot(
    message: MessageLike,
    snapshot: Pick<MessageContentSnapshot, "fields">,
): boolean {
    let fieldIndex = 0;
    // Compare the same provider-relevant shape captured by messageContentFields:
    // OpenCode can add an empty user diff summary after the message was served.
    const matched = visitMessageContentFields(contentSnapshotValue(message), {
        field(value) {
            if (!Object.is(value, snapshot.fields[fieldIndex])) return false;
            fieldIndex += 1;
            return true;
        },
        beginObject() {
            const expectedCount = snapshot.fields[fieldIndex];
            if (typeof expectedCount !== "number") return undefined;
            fieldIndex += 1;
            return expectedCount;
        },
        endObject(expectedCount, entryCount) {
            return expectedCount === entryCount;
        },
    });
    return matched && fieldIndex === snapshot.fields.length;
}

function prefixContentSnapshotsMatch(
    messages: readonly MessageLike[],
    cache: RustWireCache,
    prefixLength: number,
): boolean {
    if (prefixLength > cache.rawContentSnapshots.length) return false;
    for (let index = 0; index < prefixLength; index += 1) {
        if (!messageMatchesContentSnapshot(messages[index], cache.rawContentSnapshots[index])) {
            return false;
        }
    }
    return true;
}

function messageCacheSignature(message: MessageLike): string {
    const parts = Array.isArray(message.parts) ? message.parts : [];
    const serializedParts = JSON.stringify(parts) ?? "null";
    const serializedMessage = JSON.stringify(message) ?? "null";
    return `${messageIdOf(message) ?? ""}:${parts.length}:${Buffer.byteLength(serializedParts)}:${createHash("sha256").update(serializedMessage).digest("hex")}`;
}

function advanceWireFingerprint(previous: string, encoded: unknown): string {
    return createHash("sha256")
        .update(previous)
        .update("\\0")
        .update(JSON.stringify(encoded) ?? "null")
        .digest("hex");
}

function buildWireFingerprint(encoded: unknown[]): {
    fingerprint: string;
    prefixFingerprintBeforeLast: string;
} {
    let fingerprint = "rust-wire-v1";
    let prefixFingerprintBeforeLast = fingerprint;
    for (let index = 0; index < encoded.length; index += 1) {
        if (index === encoded.length - 1) prefixFingerprintBeforeLast = fingerprint;
        fingerprint = advanceWireFingerprint(fingerprint, encoded[index]);
    }
    return { fingerprint, prefixFingerprintBeforeLast };
}

function newestUserMessage(messages: MessageLike[]): MessageLike | undefined {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messageInfo(messages[index]).role === "user") return messages[index];
    }
    return undefined;
}

interface RustPassTimings {
    identityResolve: number;
    promptSurface: number;
    muralResolve: number;
    prefixGuard: number;
    ordinalResolve: number;
    /** Part of `ordinalResolve` spent re-reading the host store from the first row or
     * from a rewound checkpoint. Not added to the measured total a second time. */
    ordinalRebuild: number;
    /** Host-store rows the ordinal resolver read on this pass. */
    ordinalRows: number;
    /** The most expensive ordinal resolution mode used on this pass. */
    ordinalMode: OrdinalResolveStats["mode"];
    stateSync: number;
    clone: number;
    wireBuild: number;
    wireMessages: number;
    transport: number;
    transportDetail: import("./module-transport").ModuleCallTimings;
    preflight: number;
    todoVerdict: number;
    todoProbe: number;
    todoPersist: number;
    todoProbeRequired: number;
    todoProbeReason: string;
    todoUnprobedBust: number;
    sessionDirectory: number;
    paging: number;
    outputClone: number;
    delivery: number;
    bookkeeping: number;
    transportPages: number;
    transportBytes: number;
    apply: number;
    lkgSnapshot: number;
    mirrorPull: number;
    compartmentMirror: number;
}

function emptyRustPassTimings(): RustPassTimings {
    return {
        identityResolve: 0,
        promptSurface: 0,
        muralResolve: 0,
        prefixGuard: 0,
        ordinalResolve: 0,
        ordinalRebuild: 0,
        ordinalRows: 0,
        ordinalMode: "memo",
        stateSync: 0,
        clone: 0,
        wireBuild: 0,
        wireMessages: 0,
        transport: 0,
        transportDetail: { lane: 0, route: 0, encode: 0, issue: 0, responseWait: 0, settle: 0 },
        preflight: 0,
        todoVerdict: 0,
        todoProbe: 0,
        todoPersist: 0,
        todoProbeRequired: 0,
        todoProbeReason: "none",
        todoUnprobedBust: 0,
        sessionDirectory: 0,
        paging: 0,
        outputClone: 0,
        delivery: 0,
        bookkeeping: 0,
        transportPages: 0,
        transportBytes: 0,
        apply: 0,
        lkgSnapshot: 0,
        mirrorPull: 0,
        compartmentMirror: 0,
    };
}

export function formatRustInputCoverageLog(args: {
    ocInput: number;
    markerAt: string | null;
    covered: number;
    /**
     * Raw-message ordinal of the first message handed to the module, when known. With
     * `covered` it shows that nothing before the array was dropped unfolded: every
     * ordinal below it has to be inside published compartments.
     */
    firstOrdinal?: number | null;
}): string {
    const first =
        args.firstOrdinal === undefined ? "" : ` first_ordinal=${args.firstOrdinal ?? "unknown"}`;
    return `rust input coverage: oc_input=${args.ocInput} marker_at=${args.markerAt ?? "none"} covered=${args.covered}${first}`;
}

function materializedCompactionBoundary(
    response: Record<string, unknown>,
    cacheBustingPass: boolean,
): import("./transform-postprocess-phase").RustMaterializedCompactionBoundary | undefined {
    if (!cacheBustingPass) return undefined;
    if (response.committed !== true) return undefined;
    return servedCompactionBoundary(response);
}

/** Exact consumed coordinates, not authority to mint a new target. */
function servedCompactionBoundary(
    response: Record<string, unknown>,
): import("./transform-postprocess-phase").RustMaterializedCompactionBoundary | undefined {
    const ordinal = response.coverage_ordinal;
    const rowVersion = response.row_version;
    const boundaryId = response.boundary_id;
    if (
        typeof ordinal !== "number" ||
        !Number.isSafeInteger(ordinal) ||
        ordinal < 0 ||
        typeof rowVersion !== "number" ||
        !Number.isSafeInteger(rowVersion) ||
        rowVersion <= 0 ||
        typeof boundaryId !== "string"
    ) {
        return undefined;
    }
    const separator = boundaryId.lastIndexOf("#");
    if (separator < 1 || !/^\d+$/.test(boundaryId.slice(separator + 1))) return undefined;
    return {
        rowVersion,
        ordinal,
        endMessageId: boundaryId.slice(0, separator),
    };
}

/**
 * Arm the deferred-note nudge when a response reports that a fold published new
 * compartments.
 *
 * In rust mode the module owns the historian, so the host never reaches the publish
 * path that arms this nudge in TypeScript mode; without this the deferred notes are
 * only ever re-surfaced by the commit and todo triggers. The committed materialized
 * boundary above is the host's view of that publish, and its coverage ordinal grows
 * only when a fold covered more raw history. Re-rendering the same fold repeats the
 * same ordinal, so comparing against the highest ordinal already armed keeps every
 * later cache-busting pass from re-arming.
 *
 * `persistedBoundaryOrdinal` is the compaction marker already applied to this session,
 * read before this pass could advance it. It seeds the comparison so a fold published
 * by an earlier process is not treated as new after a restart.
 *
 * Cooldown, clear-on-use, and the "are there notes at all" question stay where the
 * other two triggers leave them: in the shared nudge state machine.
 */
function armNoteNudgeOnRustPublish(args: {
    db: TransformDeps["db"];
    sessionId: string;
    state: RustSessionState;
    boundary: ReturnType<typeof materializedCompactionBoundary>;
    persistedBoundaryOrdinal: number | null;
}): void {
    if (!args.boundary) return;
    const armedThrough =
        args.state.noteNudgePublishedOrdinal ?? args.persistedBoundaryOrdinal ?? -1;
    args.state.noteNudgePublishedOrdinal = Math.max(armedThrough, args.boundary.ordinal);
    if (args.boundary.ordinal <= armedThrough) return;
    sessionLog(
        args.sessionId,
        `rust fold published compartments through ordinal ${args.boundary.ordinal} (previously ${armedThrough}); arming the deferred-note nudge`,
    );
    onNoteTrigger(args.db, args.sessionId, "historian_complete");
}

function formatRustPassLog(args: {
    decision: string;
    committed?: boolean;
    prefixBustPermitted?: boolean;
    reason: string;
    schedulerDecision?: string;
    schedulerDeferReason?: string;
    historianNoFire?: string;
    historianCanonicalCause?: string;
    identityDelta?: readonly string[];
    servedFrom: string;
    inputCount: number;
    outputCount: number;
    applied: boolean;
    elapsedMs: number;
    moduleElapsedMs: number;
    rowVersion: number;
    timings?: RustPassTimings;
}): string {
    const timings = args.timings ?? emptyRustPassTimings();
    const measured =
        timings.identityResolve +
        timings.promptSurface +
        timings.muralResolve +
        timings.prefixGuard +
        timings.ordinalResolve +
        timings.stateSync +
        timings.clone +
        timings.wireBuild +
        timings.transport +
        timings.apply +
        timings.lkgSnapshot +
        timings.preflight +
        timings.todoVerdict +
        timings.sessionDirectory +
        timings.paging +
        timings.delivery +
        timings.bookkeeping;
    // Mirror stages run after appliedAt and are excluded from elapsed, so they
    // must not be subtracted into `other` or they would hide leftover serve work.
    const unattributed = Math.max(0, args.elapsedMs - measured);
    const rowVersion = Number.isSafeInteger(args.rowVersion) ? args.rowVersion : 0;
    const schedulerFields = args.schedulerDecision
        ? ` scheduler=${args.schedulerDecision}${args.schedulerDeferReason ? ` defer_reason=${args.schedulerDeferReason}` : ""}`
        : "";
    const historianFields = args.historianCanonicalCause
        ? ` historian_no_fire=${args.historianNoFire ?? "unknown"} canonical_cause=${args.historianCanonicalCause}`
        : "";
    const identityFields =
        (args.committed === undefined ? "" : ` committed=${args.committed}`) +
        ` prefix_bust_permitted=${args.prefixBustPermitted ?? "unsupported"}` +
        (args.identityDelta?.length ? ` identity_delta=${args.identityDelta.join(",")}` : "");
    return `rust pass: decision=${args.decision} reason=${args.reason}${schedulerFields}${historianFields}${identityFields} served_from=${args.servedFrom} in=${args.inputCount} out=${args.outputCount} applied=${args.applied} row_version=${rowVersion} elapsed=${args.elapsedMs.toFixed(1)} ms module=${args.moduleElapsedMs.toFixed(1)} ms stages=identity_resolve:${timings.identityResolve.toFixed(1)} prompt_surface:${timings.promptSurface.toFixed(1)} mural_resolve:${timings.muralResolve.toFixed(1)} prefix_guard:${timings.prefixGuard.toFixed(1)} ordinal_resolve:${timings.ordinalResolve.toFixed(1)} ordinal_rebuild:${timings.ordinalRebuild.toFixed(1)} ordinal_rows:${timings.ordinalRows} ordinal_mode:${timings.ordinalMode} state_sync:${timings.stateSync.toFixed(1)} clone:${timings.clone.toFixed(1)} wire_build:${timings.wireBuild.toFixed(1)} wire_messages:${timings.wireMessages} transport:${timings.transport.toFixed(1)} transport_pages:${timings.transportPages} transport_bytes:${timings.transportBytes} apply:${timings.apply.toFixed(1)} lkg_snapshot:${timings.lkgSnapshot.toFixed(1)} mirror_pull:${timings.mirrorPull.toFixed(1)} compartment_mirror:${timings.compartmentMirror.toFixed(1)} other:${unattributed.toFixed(1)} transport_lane:${timings.transportDetail.lane.toFixed(1)} transport_route:${timings.transportDetail.route.toFixed(1)} transport_encode:${timings.transportDetail.encode.toFixed(1)} transport_issue:${timings.transportDetail.issue.toFixed(1)} transport_response_wait_decode:${timings.transportDetail.responseWait.toFixed(1)} transport_settle:${timings.transportDetail.settle.toFixed(1)} transport_wrapper:${Math.max(0, timings.transport - Object.values(timings.transportDetail).reduce((sum, ms) => sum + ms, 0)).toFixed(1)} preflight:${timings.preflight.toFixed(1)} todo_verdict:${timings.todoVerdict.toFixed(1)} todo_probe:${timings.todoProbe.toFixed(1)} todo_persist:${timings.todoPersist.toFixed(1)} todo_probe_required:${timings.todoProbeRequired} todo_probe_reason:${timings.todoProbeReason} todo_unprobed_bust:${timings.todoUnprobedBust} session_directory:${timings.sessionDirectory.toFixed(1)} paging:${timings.paging.toFixed(1)} output_clone:${timings.outputClone.toFixed(1)} delivery:${timings.delivery.toFixed(1)} bookkeeping:${timings.bookkeeping.toFixed(1)}`;
}

function isSyntheticUserMessage(message: MessageLike | undefined): boolean {
    if (!message || messageInfo(message).role !== "user" || !Array.isArray(message.parts)) {
        return false;
    }
    return (
        message.parts.length > 0 &&
        message.parts.every(
            (part) => isRecord(part) && (part.synthetic === true || part.ignored === true),
        )
    );
}

function observeSyntheticTurn(state: RustSessionState, messages: MessageLike[]): boolean {
    const newest = newestUserMessage(messages);
    const info = messageInfo(newest);
    const messageId = typeof info.id === "string" ? info.id : null;
    const synthetic = isSyntheticUserMessage(newest);
    const isNewMessage = messageId === null || messageId !== state.lastObservedUserMessageId;

    if (!synthetic) {
        state.syntheticTurnCount = 0;
        state.syntheticLoopBreakerLogged = false;
    } else if (isNewMessage) {
        state.syntheticTurnCount += 1;
    }
    state.lastObservedUserMessageId = messageId;
    return synthetic;
}

function assertNativeBoundary(output: unknown[], sessionId: string, boundaryId: string): void {
    const first = output.find((message) => messageInfo(message).role !== "system");
    const info = messageInfo(first);
    const parts = isRecord(first) && Array.isArray(first.parts) ? first.parts : [];
    const synthetic =
        parts.length > 0 && parts.every((part) => isRecord(part) && part.synthetic === true);
    if (info.role === "user" && info.sessionID === sessionId && synthetic) return;
    // Include the observed head in the error so logs reveal whether the response violated the
    // expected role, session ID, or synthetic-part shape without requiring a payload dump.
    const headSummary = output.slice(0, 3).map((message) => {
        const mi = messageInfo(message);
        const mParts = isRecord(message) && Array.isArray(message.parts) ? message.parts : [];
        const partDesc = mParts
            .slice(0, 5)
            .map((part) =>
                isRecord(part) ? `${String(part.type)}${part.synthetic === true ? "" : "!"}` : "?",
            )
            .join(",");
        return `role=${String(mi.role)} sid=${mi.sessionID === sessionId ? "ok" : String(mi.sessionID ?? "absent")} id=${String(mi.id ?? "-").slice(0, 24)} parts=[${partDesc}]`;
    });
    throw new Error(
        `rust transform wire invariant failed: boundary=${boundaryId} expected a synthetic m0 user message scoped to session ${sessionId}; head: ${headSummary.join(" | ")}`,
    );
}

function responseValue(response: unknown): Record<string, unknown> {
    if (
        isRecord(response) &&
        (response.ok === false || response.isError === true || response.error != null)
    ) {
        throw new RustTransformProtocolError(
            "rust transform wire invariant failed: error envelope cannot permit host mutations",
        );
    }
    if (isRecord(response) && isRecord(response.result)) return response.result;
    if (isRecord(response)) return response;
    throw new Error("module transform returned a non-object response");
}

/**
 * Identity of the module's published compartment state as reported on a transform
 * response. Returns null for a response without a usable row_version (older modules),
 * which makes the caller check context.db on every pass instead of never.
 */
function moduleCompartmentProjectionKey(response: Record<string, unknown>): string | null {
    const rowVersion = response.row_version;
    if (typeof rowVersion !== "number" || !Number.isSafeInteger(rowVersion) || rowVersion < 0) {
        return null;
    }
    return JSON.stringify([
        rowVersion,
        response.boundary_id ?? null,
        response.coverage_ordinal ?? null,
    ]);
}

function stateSyncInputSignature(args: {
    projectPath: string | undefined;
    sessionMeta: ReturnType<typeof getOrCreateSessionMeta>;
    todoAvailability: ToolAvailabilityVerdict;
    historyRefresh: boolean;
    deferredHistoryRefresh: boolean;
    pendingMaterialization: boolean;
    deferredMaterialization: boolean;
}): string {
    return JSON.stringify([
        args.projectPath ?? null,
        args.sessionMeta.lastTodoState ?? "",
        args.sessionMeta.clearedReasoningThroughTag ?? 0,
        args.sessionMeta.toolReclaimWatermark ?? 0,
        args.todoAvailability.frozen,
        args.todoAvailability.callable,
        args.historyRefresh,
        args.deferredHistoryRefresh,
        args.pendingMaterialization,
        args.deferredMaterialization,
    ]);
}

function isTransformPageAttemptMismatch(error: unknown): boolean {
    let current = error;
    const seen = new Set<unknown>();
    while (isRecord(current) && !seen.has(current)) {
        seen.add(current);
        const code = typeof current.code === "string" ? current.code : "";
        const message = typeof current.message === "string" ? current.message : "";
        if (
            code === "attempt_mismatch" ||
            code === "authority_transform_page_attempt_mismatch" ||
            /\b(?:authority_transform_page_)?attempt_mismatch\b/.test(message)
        ) {
            return true;
        }
        current = current.cause;
    }
    return false;
}

function mirrorRustRenderedMemoryIds(args: {
    db: TransformDeps["db"];
    sessionId: string;
    response: Record<string, unknown>;
}): void {
    if (!("rendered_memory_ids" in args.response)) return;
    const rawIds = args.response.rendered_memory_ids;
    if (
        !Array.isArray(rawIds) ||
        rawIds.some((id) => typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)
    ) {
        throw new Error("module transform returned an invalid rendered-memory manifest");
    }
    const serialized = JSON.stringify(rawIds);
    args.db
        .prepare(
            `UPDATE session_meta
                SET memory_block_ids = ?, memory_block_count = ?
              WHERE session_id = ?
                AND (COALESCE(memory_block_ids, '') <> ? OR COALESCE(memory_block_count, -1) <> ?)`,
        )
        .run(serialized, rawIds.length, args.sessionId, serialized, rawIds.length);
}

function modelFromMessages(
    messages: MessageLike[],
): { providerID: string; modelID: string } | undefined {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const info = messages[index]?.info as Record<string, unknown> | undefined;
        const model = isRecord(info?.model) ? info.model : undefined;
        if (typeof model?.providerID === "string" && typeof model.modelID === "string") {
            return { providerID: model.providerID, modelID: model.modelID };
        }
        if (
            typeof info?.providerID === "string" &&
            typeof info.modelID === "string" &&
            info.role === "assistant"
        ) {
            return { providerID: info.providerID, modelID: info.modelID };
        }
    }
    return undefined;
}

function ensureState(states: Map<string, RustSessionState>, sessionId: string): RustSessionState {
    let state = states.get(sessionId);
    if (!state) {
        state = {
            initialized: false,
            consecutiveFailures: 0,
            passCount: 0,
            parked: false,
            passesSincePark: 0,
            warningSent: false,
            forceFullWire: false,
            ordinalMemoAnchor: null,
            ordinalMemoStoredCount: null,
            ordinalMemoCanonicalCount: 0,
            ordinalMemoCheckpoints: [],
            ordinalMemoVerifyPending: false,
            ordinalMemoResetCause: "cold",
            ordinalContinuationBase: null,
            seedPassPending: true,
            failureCount: 0,
            parkCount: 0,
            moduleGeneration: 0,
            lastAckedSeq: 0,
            lastAckedWatermarks: null,
            idOrdinalMemoGeneration: 0,
            idOrdinalMemo: new Map(),
            syntheticTurnCount: 0,
            lastObservedUserMessageId: null,
            syntheticLoopBreakerLogged: false,
            recordedSessionProjectIdentity: null,
            recordedSessionDirectory: null,
            resolvedMemoryProjectDirectory: null,
            resolvedMemoryProjectPath: null,
            stateSyncInputSignature: null,
            muralCache: null,

            lkgCaptureSequence: 0,
            lkgLastServedCaptureSequence: null,
            lkgLastCapturedRowVersion: 0,
            lkgSyncCaptureRequired: false,
            markerAdmissionFenced: false,
            lastPassMarkerApplyAttempted: false,
            lkgRepresentationFrozen: false,
            lkgFrozenHealthyPasses: 0,
            lkgFrozenAtInputCount: null,
            lkgColdStartCheckPending: true,
            noteNudgePublishedOrdinal: null,
        };
        states.set(sessionId, state);
    }
    return state;
}

/**
 * Enter (or keep) the frozen representation after a last-known-good replay was
 * served, whoever served it. From here on the provider holds the replayed bytes,
 * so later healthy passes must keep serving them until a pass installs something
 * else. The replay appended a raw tail the slot does not hold, so the slot is no
 * longer provably the last-served array.
 */
function enterLkgReplayFreeze(state: RustSessionState, inputCount: number): void {
    if (state.lkgFrozenAtInputCount === null) state.lkgFrozenAtInputCount = inputCount;
    state.lkgRepresentationFrozen = true;
    state.lkgFrozenHealthyPasses = 0;
    state.forceFullWire = true;
    state.lkgLastServedCaptureSequence = null;
}

function getSessionDirectory(
    deps: TransformDeps,
    sessionId: string,
): Promise<{ directory: string; resolvedFromHost: boolean }> {
    const cached = deps.sessionDirectoryBySession?.get(sessionId);
    if (cached) return Promise.resolve({ directory: cached, resolvedFromHost: true });
    if (!deps.client)
        return Promise.resolve({
            directory: deps.directory ?? process.cwd(),
            resolvedFromHost: false,
        });
    return Promise.resolve().then(async () => {
        try {
            const response = await deps.client?.session
                ?.get({ path: { id: sessionId } })
                .catch(() => null);
            const directory = (response as { data?: { directory?: unknown } } | null)?.data
                ?.directory;
            if (typeof directory === "string" && directory.length > 0) {
                deps.sessionDirectoryBySession?.set(sessionId, directory);
                return { directory, resolvedFromHost: true };
            }
        } catch {
            // The launch directory is a safe non-fatal fallback for module routing.
        }
        return { directory: deps.directory ?? process.cwd(), resolvedFromHost: false };
    });
}

function readUpgradeState(db: TransformDeps["db"], sessionId: string): string {
    const row = db
        .prepare("SELECT COUNT(*) AS count FROM compartments WHERE session_id = ? AND legacy = 1")
        .get(sessionId) as { count?: number } | undefined;
    return (row?.count ?? 0) > 0 ? "legacy" : "ready";
}

function passUsage(usage: ContextUsage, limit: number): Record<string, number> {
    return {
        input_tokens: usage.inputTokens,
        limit,
        current_total_input_tokens: usage.inputTokens,
        context_limit_tokens: limit,
    };
}

interface TransformGeometryWire {
    usable_soft: number;
    usable_hard: number;
    absolute_wall: number;
    derivation: string;
}

function transformGeometryForWire(
    geometry: WindowGeometryResult | undefined,
): TransformGeometryWire | undefined {
    if (!geometry) return undefined;
    const { window, reserve } = geometry.derivation;
    let derivation: string;
    if (geometry.geometry === "separate" && geometry.usableSoft < geometry.usableHard) {
        derivation = `s1-pre-carve/input=${geometry.usableSoft}`;
    } else if (geometry.geometry === "separate") {
        derivation = `s1-separate/context=${window}`;
    } else {
        derivation =
            `s1-shared/context-output/context=${window}/output=${reserve}` +
            `/mode=${geometry.geometry}/usable-hard=${geometry.usableHard}`;
    }
    return {
        usable_soft: geometry.usableSoft,
        usable_hard: geometry.usableHard,
        absolute_wall: geometry.derivation.absoluteWall,
        derivation,
    };
}

/**
 * Whether a Rust-mode pass for this session must fail closed: usage at or above
 * `RUST_EMERGENCY_WALL_PCT` of a trusted hard wall, or a provider overflow that
 * is proven (in this process, or persisted with provider proof). A pass that
 * fails closed admits no last-known-good replay. `providerProvenEmergency` is the
 * narrower case where the band is reached and the overflow is provider-proven.
 */
function rustEmergencyFailClosed(args: {
    sessionId: string;
    usage: ContextUsage;
    geometry: TransformGeometryWire | undefined;
    trustedContextLimit: number | undefined;
    overflowState: ReturnType<typeof getOverflowState> | undefined;
    modelKey: string | null;
}): { emergencyFailClosed: boolean; providerProvenEmergency: boolean } {
    const { sessionId, overflowState } = args;
    const hasTrustedEmergencyWall = args.geometry
        ? args.geometry.usable_hard > 0
        : args.trustedContextLimit !== undefined && args.trustedContextLimit > 0;
    const hardWallPercentage = hardWallUsagePercentage(args.usage, args.geometry);
    const providerOverflowProven = isProviderOverflowFailClosedProven(sessionId);
    let emergencyFailClosed =
        providerOverflowProven ||
        (hardWallPercentage >= RUST_EMERGENCY_WALL_PCT && hasTrustedEmergencyWall);
    let providerProvenEmergency = false;
    if (overflowState) {
        const detectedLimitMatchesModel =
            overflowState.detectedContextLimitModelKey === null ||
            canonicalModelIdentity(overflowState.detectedContextLimitModelKey) ===
                canonicalModelIdentity(args.modelKey ?? "");
        const hasProviderProof =
            (overflowState.detectedContextLimit > 0 && detectedLimitMatchesModel) ||
            // An unknown persisted arm alone is not proof. A second provider rejection
            // while that arm is durable records the process-local reconfirmation.
            isProviderOverflowReconfirmed(sessionId);
        const persistedProviderEmergency =
            overflowState.needsEmergencyRecovery &&
            overflowState.emergencyRecoveryOrigin === "provider_overflow" &&
            hasProviderProof;
        emergencyFailClosed ||= persistedProviderEmergency;
        providerProvenEmergency =
            hardWallPercentage >= RUST_EMERGENCY_WALL_PCT &&
            (providerOverflowProven || persistedProviderEmergency);
    }
    return { emergencyFailClosed, providerProvenEmergency };
}

function hardWallUsagePercentage(
    usage: ContextUsage,
    geometry: TransformGeometryWire | undefined,
): number {
    return geometry && geometry.usable_hard > 0 && usage.inputTokens > 0
        ? (usage.inputTokens / geometry.usable_hard) * 100
        : usage.percentage;
}

function shouldDisarmRustEmergencyRecovery(input: {
    materialized: boolean;
    usagePercentage: number;
    recoveryOrigin: "provider_overflow" | "proactive_model_shrink" | null;
    recoveryArmedAt: number | null;
    usageEntry: { updatedAt: number; hasUsageTokens?: boolean } | null | undefined;
    finalWireEstimate?: { tokens: number; trusted: boolean };
    providerProvenLimitTokens: number;
}): "fresh-usage" | "trusted-final-wire" | null {
    if (
        input.finalWireEstimate?.trusted === true &&
        input.providerProvenLimitTokens > 0 &&
        input.finalWireEstimate.tokens < input.providerProvenLimitTokens * 0.8
    ) {
        return "trusted-final-wire";
    }
    if (!input.materialized || input.usagePercentage >= 80) return null;
    if (input.recoveryOrigin !== "provider_overflow") return "fresh-usage";
    if (
        input.usageEntry?.hasUsageTokens === true &&
        (input.recoveryArmedAt === null || input.usageEntry.updatedAt > input.recoveryArmedAt)
    ) {
        // A missing process-local arm timestamp means the durable arm predates this
        // process; persisted usage is loaded with hasUsageTokens=false, so true can
        // only come from a provider response observed after restart.
        return "fresh-usage";
    }
    return null;
}

function directiveTextOf(response: Record<string, unknown>): string | undefined {
    const directives = isRecord(response.host_directives) ? response.host_directives : undefined;
    const channel2 = isRecord(directives?.channel2_nudge) ? directives.channel2_nudge : undefined;
    return typeof channel2?.text === "string" && channel2.text.length > 0
        ? channel2.text
        : undefined;
}

function isNeedFullSync(response: Record<string, unknown>): boolean {
    return response.status === "need_full_sync" || response.action === "NEED_FULL_SYNC";
}

const TODO_HEAD_ANCHOR_ID = "__magic_context_todo_head__";

function syntheticTodoAnchorFromNative(messages: readonly unknown[]): {
    callId: string;
    messageId: string;
    stateJson: string;
} | null {
    for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        if (!isRecord(message) || !Array.isArray(message.parts)) continue;
        const part = message.parts.find(
            (candidate) => isRecord(candidate) && candidate.syntheticTodoMarker === true,
        );
        if (!isRecord(part) || typeof part.callID !== "string") continue;
        const state = isRecord(part.state) ? part.state : undefined;
        const input = state && isRecord(state.input) ? state.input : undefined;
        const stateJson = normalizeTodoStateJson(input?.todos);
        if (stateJson === null || computeSyntheticCallId(stateJson) !== part.callID) continue;

        const previous = messages[index - 1];
        const previousInfo =
            isRecord(previous) && isRecord(previous.info) ? previous.info : undefined;
        const messageId =
            previousInfo && typeof previousInfo.id === "string" && previousInfo.id.length > 0
                ? previousInfo.id
                : TODO_HEAD_ANCHOR_ID;
        return { callId: part.callID, messageId, stateJson };
    }
    return null;
}

/** The array a last-known-good snapshot recorded as served, or null when unreadable. */
function parseLastServedSnapshot(jsonPrefix: string | undefined): unknown[] | null {
    if (!jsonPrefix) return null;
    try {
        const parsed: unknown = JSON.parse(jsonPrefix);
        return Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function mirrorRustSyntheticTodoAnchor(args: {
    db: TransformDeps["db"];
    sessionId: string;
    messages: readonly unknown[];
    cacheBustingPass: boolean;
}): void {
    const anchor = syntheticTodoAnchorFromNative(args.messages);
    if (anchor) {
        setPersistedTodoSyntheticAnchor(
            args.db,
            args.sessionId,
            anchor.callId,
            anchor.messageId,
            anchor.stateJson,
        );
    } else if (args.cacheBustingPass) {
        clearPersistedTodoSyntheticAnchor(args.db, args.sessionId);
    }
}

/** Single response-field seam for the parallel module encode-back contract. */
function hasNativeResponseContent(response: Record<string, unknown>): boolean {
    if (typeof response.native_messages === "string" || Array.isArray(response.native_messages)) {
        return true;
    }
    const delta = response.native_messages_delta;
    return isRecord(delta) && Array.isArray(delta.messages);
}

export function applyNativeMessagesVerbatim(
    output: { messages: unknown[] },
    response: Record<string, unknown>,
    previous?: { messages: readonly unknown[]; fingerprint: string },
): unknown[] {
    const nativeMessages = response.native_messages;
    if (typeof nativeMessages === "string") {
        const parsed = JSON.parse(nativeMessages) as unknown;
        if (!Array.isArray(parsed))
            throw new Error("rust transform native_messages string was not an array");
        return replaceMessagesInPlace(output, parsed);
    }
    if (Array.isArray(nativeMessages)) {
        // The module owns healing, ordering, and codec fidelity. Do not clone,
        // normalize, or otherwise inspect the returned native message array.
        return replaceMessagesInPlace(output, nativeMessages);
    }
    const delta = response.native_messages_delta;
    if (!isRecord(delta) || !Array.isArray(delta.messages)) {
        throw new Error("rust transform response omitted native_messages");
    }
    const replaceFrom = delta.replace_from;
    if (
        !previous ||
        delta.after !== previous.fingerprint ||
        typeof replaceFrom !== "number" ||
        !Number.isSafeInteger(replaceFrom) ||
        replaceFrom < 0 ||
        replaceFrom > previous.messages.length
    ) {
        throw new Error(
            "rust transform native_messages_delta did not match the acknowledged output",
        );
    }
    return replaceMessagesInPlace(output, [
        ...previous.messages.slice(0, replaceFrom),
        ...delta.messages,
    ]);
}

function resolvedHistorianModelChain(
    deps: Pick<TransformDeps, "historianModel" | "fallbackModels">,
): string[] {
    const models = [deps.historianModel, ...(deps.fallbackModels ?? [])]
        .map((entry) => (typeof entry === "string" ? entry : entry?.model))
        .filter((model): model is string => typeof model === "string" && model.length > 0);
    return [...new Set(models)];
}

/**
 * The configured OpenCode variant (e.g. a reasoning effort such as `high`) of each
 * historian chain model, keyed by the same model strings as the chain. When a module
 * runner runs the historian, it sends this as the runner's `model.variant`. The chain
 * keeps the first entry for a repeated model, so that entry's variant wins here too.
 * A model whose entry configures no variant has no key and sends none.
 */
function resolvedHistorianModelVariants(
    deps: Pick<TransformDeps, "historianModel" | "fallbackModels">,
): Record<string, string> {
    const variants: Record<string, string> = {};
    const seen = new Set<string>();
    for (const entry of [deps.historianModel, ...(deps.fallbackModels ?? [])]) {
        const model = typeof entry === "string" ? entry : entry?.model;
        if (typeof model !== "string" || model.length === 0 || seen.has(model)) continue;
        seen.add(model);
        const variant = typeof entry === "string" ? undefined : entry?.qualifier;
        if (variant) variants[model] = variant;
    }
    return variants;
}

function resolvedHistorianModelLimits(
    chain: readonly string[],
): Record<string, { context?: number; input?: number; output?: number }> {
    return Object.fromEntries(
        chain.map((key) => {
            const [provider, ...parts] = key.split("/");
            const output =
                provider && parts.length ? getSdkOutputLimit(provider, parts.join("/")) : undefined;
            const producerLimits = resolveHistorianProducerLimits(key);
            const known =
                producerLimits.input === undefined
                    ? resolveKnownHistorianContextLimit(key)
                    : undefined;
            const learned =
                provider && parts.length
                    ? getSdkWindowGeometry(provider, parts.join("/"))?.derivation.window
                    : undefined;
            const context =
                producerLimits.context ??
                (known === undefined
                    ? learned
                    : learned === undefined
                      ? known
                      : Math.min(known, learned));
            return [
                key,
                {
                    ...(context !== undefined ? { context } : {}),
                    ...(producerLimits.input !== undefined ? { input: producerLimits.input } : {}),
                    ...(output !== undefined ? { output } : {}),
                },
            ];
        }),
    );
}

/** Over-approximate host-visible HARD opportunities: the module freezes mural bytes on all non-materializing passes. */
function shouldRefreshMuralCandidate(args: {
    initialized: boolean;
    pressure: number;
    threshold: number;
    lastAppliedAtMs: number | undefined;
    nowMs: number;
    cacheTtl: string;
    explicitMaterialization: boolean;
}): boolean {
    let ttlMs = 300_000;
    try {
        ttlMs = parseCacheTtl(args.cacheTtl);
    } catch {
        // Keep ttlMs's initial 300,000-millisecond (five-minute) value, matching the scheduler's
        // 5 * 60 * 1000 millisecond fallback.
    }
    return (
        !args.initialized ||
        args.pressure >= args.threshold ||
        args.explicitMaterialization ||
        (args.lastAppliedAtMs !== undefined && args.nowMs - args.lastAppliedAtMs >= ttlMs)
    );
}

function muralInputForWire(
    mural: ReturnType<typeof resolveMuralWire> | undefined,
): Record<string, unknown> | undefined {
    if (
        !mural?.enabled ||
        !mural.supportsVision ||
        typeof mural.dataUrl !== "string" ||
        mural.dataUrl.length === 0
    ) {
        return undefined;
    }
    return {
        enabled: true,
        supports_vision: true,
        data_url: mural.dataUrl,
        content_hash: mural.contentHash,
    };
}

function toolInputKeyOrders(input: unknown[]): Record<string, string[]> {
    const orders: Record<string, string[]> = {};
    for (const entry of input) {
        if (!entry || typeof entry !== "object") continue;
        const record = entry as Record<string, unknown>;
        const mid = typeof record.mid === "string" ? record.mid : null;
        const ck = record.ck;
        if (!mid || !ck || typeof ck !== "object") continue;
        const content = (ck as Record<string, unknown>).content;
        if (!Array.isArray(content)) continue;
        for (let index = 0; index < content.length; index += 1) {
            const block = content[index];
            if (!block || typeof block !== "object") continue;
            const kind = (block as Record<string, unknown>).kind;
            if (!kind || typeof kind !== "object") continue;
            const kindRecord = kind as Record<string, unknown>;
            const toolInput = kindRecord.input;
            if (
                kindRecord.type === "tool_call" &&
                isEditTool(typeof kindRecord.name === "string" ? kindRecord.name : undefined) &&
                toolInput !== null &&
                typeof toolInput === "object" &&
                !Array.isArray(toolInput)
            ) {
                orders[`${mid}#${index}`] = Object.keys(toolInput as Record<string, unknown>);
            }
        }
    }
    return orders;
}

function buildTransformBody(args: {
    sessionId: string;
    input: unknown[];
    nativeMessages: unknown[];
    toolInputKeyOrders?: Record<string, string[]>;
    passInputs: Record<string, unknown>;
    usage: Record<string, number | boolean>;
    geometry?: TransformGeometryWire;
    modelKey: string | null;
    providerId: string | null;
    variant?: string;
    systemPromptHash: string;
    upgradeState: string;
    prevResponseCompletedAtMs?: number;
    requestObservedAtMs?: number;
    channel2NudgeState: string;
    emergencyRecoveryArmed: boolean;
    declaredTrim?: unknown;
    fullArrayFingerprint?: string;
    tailDelta?: {
        after: string;
        replaceFrom: number;
        nativeReplaceFrom: number;
    };
}): Record<string, unknown> {
    return {
        method: "transform",
        kind: "transform",
        v: 2,
        serializer_profile: "opencode-aisdk",
        serve_native: true,
        session_id: args.sessionId,
        // Send the same model/provider/system identity used by the TypeScript materializer.
        // The module retains effort only for models where a change naturally busts the
        // provider cache; cache-preserving models keep it out of the render identity.
        render_config: [
            args.providerId ? `provider:${args.providerId}` : "",
            args.modelKey ? `model:${args.modelKey}` : "",
            args.variant ? `variant:${args.variant}` : "",
            args.systemPromptHash ? `system:${args.systemPromptHash}` : "",
        ]
            .filter(Boolean)
            .join("|"),
        system_prompt_hash: args.systemPromptHash,
        adopted_system_prompt_hash: args.passInputs.adopted_system_prompt_hash,
        upgrade_state: args.upgradeState,
        is_subagent: args.passInputs.is_subagent === true,
        messages: args.input,
        native_messages: args.nativeMessages,
        tool_input_key_orders: args.toolInputKeyOrders ?? toolInputKeyOrders(args.input),
        ...(args.fullArrayFingerprint ? { full_array_fingerprint: args.fullArrayFingerprint } : {}),
        ...(args.tailDelta
            ? {
                  tail_delta: {
                      after: args.tailDelta.after,
                      replace_from: args.tailDelta.replaceFrom,
                      native_replace_from: args.tailDelta.nativeReplaceFrom,
                  },
              }
            : {}),
        usage: args.usage,
        ...(args.geometry ? { geometry: args.geometry } : {}),
        provider_error: args.passInputs.provider_error,
        prev_response_completed_at_ms: args.prevResponseCompletedAtMs,
        request_observed_at_ms: args.requestObservedAtMs,
        channel2_nudge_state: args.channel2NudgeState,
        emergency_recovery_armed: args.emergencyRecoveryArmed,
        emergency_recovery_no_head_escape:
            args.passInputs.emergency_recovery_no_head_escape === true,
        detected_context_limit: args.passInputs.detected_context_limit,
        detected_context_limit_model_key: args.passInputs.detected_context_limit_model_key,
        model_key: args.modelKey,
        provider_id: args.providerId,
        tool_present: args.passInputs.tool_present === true,
        ...(typeof args.passInputs.todo_tool_present === "boolean"
            ? { todo_tool_present: args.passInputs.todo_tool_present }
            : {}),
        ...(typeof args.passInputs.todo_verdict_probed === "boolean"
            ? { todo_verdict_probed: args.passInputs.todo_verdict_probed, verdict_stale_ok: false }
            : {}),
        prompt_surface_preset: args.passInputs.prompt_surface_preset ?? "full",
        prompt_surface_model_key: args.passInputs.prompt_surface_model_key,
        prompt_surface_config_identity: args.passInputs.prompt_surface_config_identity,
        prompt_surface_tool_descriptions: args.passInputs.prompt_surface_tool_descriptions ?? {},
        prompt_surface_guidance_override: args.passInputs.prompt_surface_guidance_override,
        mural: args.passInputs.mural,
        effective_execute_threshold: args.passInputs.effective_execute_threshold,
        ...(typeof args.passInputs.protected_tokens_effective === "number"
            ? { protected_tokens_effective: args.passInputs.protected_tokens_effective }
            : {}),
        auto_search_enabled: args.passInputs.auto_search_enabled === true,
        auto_search_score_threshold: args.passInputs.auto_search_score_threshold,
        auto_search_min_prompt_chars: args.passInputs.auto_search_min_prompt_chars,
        history_budget_tokens: args.passInputs.history_budget_tokens,
        historian_model_chain: args.passInputs.historian_model_chain,
        historian_model_limits: args.passInputs.historian_model_limits,
        historian_model_variants: args.passInputs.historian_model_variants,
        historian_timeout_ms: args.passInputs.historian_timeout_ms,
        keep_reasoning_tokens_effective: args.passInputs.keep_reasoning_tokens_effective,
        caveman_enabled: args.passInputs.caveman_enabled === true,
        caveman_min_chars: args.passInputs.caveman_min_chars ?? 500,
        cache_ttl: args.passInputs.cache_ttl,
        // Thalamus owns these values. The plugin neither interprets nor recomposes the edge;
        // explicit pass-through keeps mixed direct/plugin deployments wire-compatible.
        lineage_switched: args.passInputs.lineage_switched === true,
        descent_edge_id: args.passInputs.descent_edge_id,
        prior_conversation_key: args.passInputs.prior_conversation_key,
        prior_epoch: args.passInputs.prior_epoch,
        new_epoch: args.passInputs.new_epoch,
        constituents: args.passInputs.constituents,
        compaction_observed: args.passInputs.compaction_observed === true,
        pass_inputs: args.passInputs,
        declared_trim: args.declaredTrim,
    };
}

export function createRustModeTransform(
    deps: TransformDeps,
    options: RustModeTransformOptions,
): {
    run: (
        sessionId: string,
        messages: MessageLike[],
        output: { messages: unknown[] },
        sessionMeta: ReturnType<typeof getOrCreateSessionMeta>,
    ) => Promise<void>;
    clearSession: (sessionId: string) => Promise<void>;
    invalidateWireState: (sessionId: string) => void;
    stopHostRunner: () => Promise<void>;
    dispose: () => void;
    getState: (sessionId: string) => Readonly<RustSessionState>;
    getHeapStats: () => RustWireCacheHeapStats;
    replayParticipant: RustLkgReplayParticipant;
} {
    const states = new Map<string, RustSessionState>();
    const finalWireUsage = createFinalWireUsageTracker();
    const clock = options.clockForTests ?? { setTimeout, clearTimeout, now: Date.now };
    // The model this pass resolves when the messages carry none. OpenCode 1 reads it
    // back out of the host's own database; hosts that keep no such database supply
    // the draft's model through this seam instead.
    const hostModelFallback = deps.hostModelFallback ?? findLastAssistantModelFromOpenCodeDb;
    const heapHolder = new MagicContextRustHeapHolder();
    const promptSurfaceGuidanceEpochs = deps.promptSurfaceRuntime
        ? createPromptSurfaceGuidanceEpochCache(deps.promptSurfaceRuntime)
        : undefined;
    const captureScheduler =
        options.scheduleLkgCapture ?? ((capture: () => void) => setImmediate(capture));
    const scheduleLkgCapture = (capture: () => void) =>
        withoutSqliteTransformPass(() => captureScheduler(capture));
    const installNativeMessages = options.installNativeMessagesForTests ?? replaceMessagesInPlace;
    const rawFallbackEstimator =
        options.rawFallbackEstimatorForTests ?? estimateFinalWireInputTokens;
    const timeoutMs = Math.max(1, options.moduleTimeoutMs ?? RUST_SEND_TIMEOUT_MS);

    // This transform runs only for OpenCode 1 and OpenCode 2 in Rust mode, and for
    // those harnesses the module's runner, when the user names none, is the host:
    // it queues each fold for a claimant in this process. So the pull loop is built
    // unless the user explicitly sent the historian to Broca, where nothing is ever
    // queued and the loop would only add a module round trip per pass to ask a
    // question whose answer is always "nothing".
    const hostRunnerWanted = deps.historianRunner !== "broca";
    let hostRunner: HistorianHostRunnerSeam | undefined | null =
        options.historianHostRunnerForTests ?? (hostRunnerWanted ? null : undefined);
    const resolveHostRunner = (): HistorianHostRunnerSeam | undefined => {
        if (hostRunner !== null) return hostRunner;
        try {
            hostRunner = createHistorianHostRunner({
                call: (args) =>
                    options.moduleClient.call({
                        method: args.method,
                        sessionId: args.sessionId,
                        projectRoot: options.projectRoot ?? deps.directory ?? process.cwd(),
                        // Keep the dispatch field explicit for alternate clients;
                        // the subc transport also derives it from the call method.
                        body: { ...args.body, method: args.method },
                    }),
                db: deps.db,
                client: deps.client,
                ...(deps.hiddenCompletionExecutor
                    ? { hiddenCompletionExecutor: deps.hiddenCompletionExecutor }
                    : {}),
                sessionDirectory: (sessionId) =>
                    deps.sessionDirectoryBySession?.get(sessionId) ??
                    deps.directory ??
                    process.cwd(),
                // Read per poll, not captured: an operator turning the loop off must
                // take effect on the next pass rather than at the next restart.
                enabled: () => deps.historianHostRunnerEnabled !== false,
                ...(deps.historianMaxOutputTokens !== undefined
                    ? { maxOutputTokens: deps.historianMaxOutputTokens }
                    : {}),
                // Sampled per claim so a live edit of historian_timeout_ms applies to
                // the next run, as it does for the host's own historian.
                attemptTimeoutMs: () =>
                    deps.resolveHistorianRun?.().timeoutMs ?? deps.historianTimeoutMs,
            });
        } catch (error) {
            // A loop that cannot be built leaves the runs for another claimant rather
            // than failing the pass that discovered it could not be built.
            hostRunner = undefined;
            log(`[magic-context] historian host runner unavailable: ${String(error)}`);
        }
        return hostRunner ?? undefined;
    };

    const resolveMuralForPass = (
        state: RustSessionState,
        projectIdentity: string | undefined,
        modelKey: string | undefined,
        budgetTokens: number | undefined,
        refresh: boolean,
    ): MuralWireOptions => {
        const key = JSON.stringify([
            projectIdentity,
            modelKey,
            budgetTokens,
            modelKeyAcceptsImages(modelKey),
        ]);
        const cached = state.muralCache;
        if (!refresh && cached?.key === key) return cached.value;
        const sourceProject =
            projectIdentity && (options.muralResolverForTests || modelKeyAcceptsImages(modelKey))
                ? projectIdentity
                : undefined;
        const sourceRevision = sourceProject ? muralSourceRevision(deps.db, sourceProject) : "";
        const revision = sourceProject
            ? JSON.stringify([sourceRevision, getMuralIdentity(deps.db, sourceProject)])
            : "";
        if (
            options.disableHotPathIoCachesForTests !== true &&
            cached?.key === key &&
            cached.revision === revision
        ) {
            return cached.value;
        }
        const value = (options.muralResolverForTests ?? resolveMuralWire)(
            deps.db,
            projectIdentity,
            modelKey,
            true,
            budgetTokens,
        );
        // Resolution may publish a new manifest. Record its revision after the write.
        state.muralCache = {
            key,
            revision: sourceProject
                ? JSON.stringify([sourceRevision, getMuralIdentity(deps.db, sourceProject)])
                : "",
            value,
        };
        return value;
    };

    const logStage = (
        sessionId: string,
        stage: Exclude<
            keyof RustPassTimings,
            "transportDetail" | "todoProbeReason" | "ordinalMode"
        >,
        startedAt: number,
        timings: RustPassTimings,
        extra?: string,
    ): void => {
        const elapsed = Math.max(0, performance.now() - startedAt);
        timings[stage] += elapsed;
        logTransformTiming(
            sessionId,
            `rust.${stage.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`,
            startedAt,
            extra,
        );
    };

    const callModule = async (
        args: Parameters<RustModeModuleClient["call"]>[0],
        attemptTimeoutMs = args.timeoutMs ?? timeoutMs,
        allowTimeoutRetry = true,
    ): Promise<unknown> => {
        const controller = new AbortController();
        const body = isRecord(args.body) ? args.body : {};
        const timeoutError =
            args.method === "state_sync"
                ? Object.assign(
                      new Error(
                          `state_sync timeout stage=module_ack page=${body.seed_batch_index ?? 0}/${body.seed_batch_total ?? 1} series=${body.seed_id ?? "delta"} budget_ms=${attemptTimeoutMs}`,
                      ),
                      {
                          code: "state_sync_timeout",
                          stage: "module_ack",
                          page: body.seed_batch_index ?? 0,
                          pages: body.seed_batch_total ?? 1,
                          series: body.seed_id ?? null,
                      },
                  )
                : new Error("rust module request timed out");
        let rejectDeadline!: (error: Error) => void;
        const deadline = new Promise<never>((_resolve, reject) => {
            rejectDeadline = reject;
        });
        const timer = clock.setTimeout(() => {
            controller.abort(timeoutError);
            rejectDeadline(timeoutError);
        }, attemptTimeoutMs);
        try {
            return await Promise.race([
                options.moduleClient.call({
                    ...args,
                    signal: controller.signal,
                    timeoutMs: attemptTimeoutMs,
                }),
                deadline,
            ]);
        } catch (error) {
            const timedOut =
                controller.signal.aborted ||
                (error instanceof Error && /timed out|deadline/i.test(error.message));
            if (
                allowTimeoutRetry &&
                options.moduleTimeoutMs === undefined &&
                args.method === "transform" &&
                body.transform_page_complete === true &&
                timedOut
            ) {
                clock.clearTimeout(timer);
                // Retry only the identical content-addressed final page. The module
                // checks its generation and final digest and replays a completed result;
                // no state-sync, page upload or host mutation is repeated here.
                sessionLog(
                    args.sessionId,
                    "rust transform deadline: waiting up to 45000ms for identical final-page completion",
                );
                const completionDeadline = clock.now() + 45_000;
                for (;;) {
                    const remaining = completionDeadline - clock.now();
                    if (remaining <= 0) throw timeoutError;
                    try {
                        return await callModule(args, remaining, false);
                    } catch (retryError) {
                        if (
                            moduleFailureCode(retryError) !== "authority_transform_page_in_progress"
                        )
                            throw retryError;
                        // The original execution is still applying. Re-submit only
                        // its identical final page after yielding, until its cached
                        // committed result is available or this one budget expires.
                        const wait = Math.min(250, completionDeadline - clock.now());
                        if (wait <= 0) throw timeoutError;
                        await new Promise<void>((resolve) => clock.setTimeout(resolve, wait));
                    }
                }
            }
            if (controller.signal.aborted) throw timeoutError;
            throw error;
        } finally {
            clock.clearTimeout(timer);
        }
    };

    const callTransformWithStallProbe = async (
        args: Parameters<RustModeModuleClient["call"]>[0],
        attemptTimeoutMs: number,
    ): Promise<unknown> => {
        const startedAtMs = clock.now();
        const deadlineMs = startedAtMs + attemptTimeoutMs;
        const probeAfterMs = options.stallProbeAfterMsForTests ?? RUST_STALL_PROBE_AFTER_MS;
        const probeTimeoutMs = options.healthProbeTimeoutMsForTests ?? RUST_HEALTH_PROBE_TIMEOUT_MS;
        const originalAttemptId = randomUUID();
        const originalBody = isRecord(args.body)
            ? { ...args.body, attempt_id: originalAttemptId }
            : args.body;
        const original = callModule({ ...args, body: originalBody }, attemptTimeoutMs);
        if (attemptTimeoutMs <= probeAfterMs) return original;

        let stallTimer: ReturnType<typeof setTimeout> | undefined;
        const first = await Promise.race([
            original.then(
                (response) => ({ kind: "response" as const, response }),
                (error) => ({ kind: "error" as const, error }),
            ),
            new Promise<{ kind: "stalled" }>((resolve) => {
                stallTimer = clock.setTimeout(() => resolve({ kind: "stalled" }), probeAfterMs);
            }),
        ]);
        if (first.kind !== "stalled") clock.clearTimeout(stallTimer);
        if (first.kind === "response") return first.response;
        if (first.kind === "error") throw first.error;

        const probeBudgetMs = Math.min(probeTimeoutMs, Math.max(0, deadlineMs - clock.now()));
        if (probeBudgetMs <= 0) return original;
        try {
            await callModule(
                {
                    sessionId: args.sessionId,
                    projectRoot: args.projectRoot,
                    method: "session.status",
                    body: {
                        method: "session.status",
                        v: 1,
                        session_id: args.sessionId,
                    },
                    bypassSessionLane: true,
                },
                probeBudgetMs,
            );
        } catch {
            // A failed probe indicates that the module may be unavailable. Keep waiting on
            // the original request so normal timeout handling chooses refusal or fallback.
            return original;
        }

        sessionLog(
            args.sessionId,
            `rust transform still pending after healthy probe original_attempt=${originalAttemptId} stall_ms=${clock.now() - startedAtMs}; duplicate resend suppressed`,
        );
        // A healthy status response does not prove the original mutating transform stopped.
        // Keep its single deadline instead of overlapping a second request against stale state.
        return original;
    };

    const markFailure = (sessionId: string, state: RustSessionState, error: unknown): void => {
        state.consecutiveFailures = isNonRetryableStateSyncFailure(error)
            ? Math.max(RUST_FAILURE_PARK_THRESHOLD, state.consecutiveFailures + 1)
            : state.consecutiveFailures + 1;
        state.failureCount += 1;
        sessionLog(sessionId, "rust transform failed; attempting LKG replay:", error);
        if (state.consecutiveFailures < RUST_FAILURE_PARK_THRESHOLD || state.parked) return;
        state.parked = true;
        state.parkCount += 1;
        state.passesSincePark = 0;
        state.warningSent = true;
        const warning = ENGINE_RECONNECTING_USER_MESSAGE;
        sessionLog(
            sessionId,
            `mc_rust_park_transition failure_passes=${state.consecutiveFailures} pass_count=${state.passCount} park_count=${state.parkCount}`,
        );
        options.notifyParked?.(sessionId, warning);
    };

    // Clearing the memo makes the next resolution read every stored row of the
    // session, which took close to a minute on a 124k-row session. Reserve it for a
    // drift that an incremental rewind could not repair.
    const resetOrdinalMemo = (state: RustSessionState, cause: string): void => {
        state.idOrdinalMemo.clear();
        state.ordinalMemoAnchor = null;
        state.ordinalMemoStoredCount = null;
        state.ordinalMemoCanonicalCount = 0;
        state.ordinalMemoCheckpoints.length = 0;
        state.ordinalMemoVerifyPending = false;
        state.ordinalMemoResetCause = cause;
    };

    const invalidateWireState = (sessionId: string): void => {
        heapHolder.wireCaches.delete(sessionId);
        const state = states.get(sessionId);
        if (!state) return;
        // A removal can shift the ordinals of messages the memo still maps, but the
        // rows before the removed one are unchanged. Keep the memo and make the next
        // resolution probe the store; its count check rewinds to the newest intact
        // page checkpoint instead of re-reading the session from the first row.
        state.ordinalMemoVerifyPending = true;
        state.stateSyncInputSignature = null;
        state.forceFullWire = true;
    };

    /** Record one ordinal resolution: timing, rows read, and a named rebuild stage. */
    const recordOrdinalResolve = (
        sessionId: string,
        state: RustSessionState,
        startedAt: number,
        timings: RustPassTimings,
        stats: OrdinalResolveStats,
        extra?: string,
    ): void => {
        const rank = { memo: 0, incremental: 1, rewind: 2, prime: 3 } as const;
        if (rank[stats.mode] > rank[timings.ordinalMode]) timings.ordinalMode = stats.mode;
        timings.ordinalRows += stats.rowsRead;
        const cause =
            stats.mode === "prime"
                ? state.ordinalMemoResetCause
                : stats.mode === "rewind"
                  ? "store_drift"
                  : "none";
        const detail = `mode=${stats.mode} rows=${stats.rowsRead} pages=${stats.pages} rewinds=${stats.rewinds} cause=${cause}${extra ? ` ${extra}` : ""}`;
        logStage(sessionId, "ordinalResolve", startedAt, timings, detail);
        if (stats.mode === "prime" || stats.mode === "rewind") {
            // Named separately so a slow whole-session or rewound read is visible in the
            // pass summary instead of hiding inside ordinal_resolve or request latency.
            timings.ordinalRebuild += Math.max(0, performance.now() - startedAt);
            logTransformTiming(sessionId, "rust.ordinal_rebuild", startedAt, detail);
        }
    };

    const replayLastGood = (
        sessionId: string,
        currentMessages: MessageLike[],
        output: { messages: unknown[] },
        systemPromptTokens: number,
    ): boolean => {
        try {
            if (
                states.get(sessionId)?.markerAdmissionFenced ||
                isRustMarkerAdmissionFenced(deps.db, sessionId)
            )
                return false;
        } catch {
            return false;
        }
        const slot = getSlot(sessionId);
        if (!slot) {
            const state = states.get(sessionId);
            if (state) state.lkgAcceptedCapture = undefined;
            sessionLog(sessionId, "lkg_miss");
            return false;
        }
        if (isEmergencyRecoveryArmed(sessionId)) {
            sessionLog(sessionId, "lkg_emergency_armed");
            return false;
        }
        try {
            if (getOverflowState(deps.db, sessionId).needsEmergencyRecovery) {
                sessionLog(sessionId, "lkg_emergency_armed");
                return false;
            }
        } catch {
            return false;
        }
        let entry: LkgEntryNote | null = null;
        try {
            entry = noteEntry(sessionId, currentMessages);
        } catch (error) {
            sessionLog(sessionId, "rust LKG entry snapshot failed:", error);
            return false;
        }
        if (!entry) {
            dropSlot(sessionId, "lkg_invalidated_reshape", deps.compactionOff !== true);
            const state = states.get(sessionId);
            if (state) state.lkgAcceptedCapture = undefined;
            sessionLog(sessionId, "lkg_invalidated_reshape");
            return false;
        }
        const keys = resolveLkgModelKeys(currentMessages);
        const replayModel = resolveReplayModel(sessionId, currentMessages);
        const replay = replayLkg({
            sessionId,
            messages: currentMessages,
            modelKey: keys.modelKey,
            providerKey: keys.providerKey,
            entry,
            prepareReplay: (messages) =>
                replayRustModeBindingMismatchStrips({
                    db: deps.db,
                    sessionId,
                    messages,
                    resolvedProviderID: replayModel?.providerID,
                }),
        });
        if (!replay.ok) {
            const state = states.get(sessionId);
            if (state) state.lkgAcceptedCapture = undefined;
            sessionLog(sessionId, replay.reason);
            return false;
        }
        const fit = lkgReplayFits({
            db: deps.db,
            sessionId,
            messages: replay.messages,
            model: replayModel,
            modelKey: keys.modelKey,
            systemPromptTokens,
            agentName: deps.getNotificationParams?.(sessionId)?.agent,
            estimator: rawFallbackEstimator,
        });
        if (!fit.fits) {
            if (fit.detail) sessionLog(sessionId, fit.detail);
            return false;
        }
        // OpenCode aliases input and output; count ingress before replay shortens that array.
        const replayInputCount = currentMessages.length;
        replaceMessagesInPlace(output, replay.messages);
        // Every provider-visible replay enters the freeze here: the failure ladder,
        // the parked shortcut and the parked health-probe failure alike.
        enterLkgReplayFreeze(ensureState(states, sessionId), replayInputCount);
        sessionLog(sessionId, "lkg_replay_served");
        return true;
    };

    // The model a last-known-good replay is admitted and stripped for. The outer
    // wrapper's replay goes through the registered participant below, which uses
    // this same function, so both replays of one tail strip it identically.
    const resolveReplayModel = (
        sessionId: string,
        messages: MessageLike[],
    ): { providerID: string; modelID: string } | null | undefined =>
        modelFromMessages(messages) ??
        deps.liveModelBySession?.get(sessionId) ??
        hostModelFallback(sessionId);

    const fenceMarkerAdmission = (
        sessionId: string,
        state: RustSessionState,
        quarantine = false,
    ): void => {
        state.markerAdmissionFenced = true;
        state.forceFullWire = true;
        // Cancel any queued SOFT+ snapshot write from before the marker attempt;
        // it must not restore an outdated saved request after this pass fails.
        state.lkgCaptureSequence += 1;
        state.lkgLastServedCaptureSequence = null;
        // Persist the replay-blocking flag before attempting to move the host marker.
        // Keep the saved request but hide it until the outcome is known. Delete it
        // if the marker changed or might have changed; retain it only when no change
        // is proven.
        deps.db
            .transaction(() => {
                setRustMarkerAdmissionFence(deps.db, sessionId, true);
                if (!deps.compactionOff)
                    recordServedSlotState(deps.db, sessionId, "rust_marker_admission_fenced");
                if (!quarantine) clearPersistedLkgSlotStrict(deps.db, sessionId);
            })
            .immediate();
        if (!quarantine)
            dropSlot(sessionId, "rust_marker_admission_fenced", deps.compactionOff !== true);
        state.lkgAcceptedCapture = undefined;
        state.lkgSyncCaptureRequired = true;
    };

    /**
     * On this process's first applied pass for a session, find whether a previous
     * process left a freeze behind. A frozen healthy pass captures the raw bytes it
     * served, so a durable slot ending in messages exactly as the host sent them,
     * one of which the module now renders differently, shows the provider last saw
     * the frozen representation (see `coldStartRawServedIndex`): the result is
     * `frozen_slot`, with the slot's messages, the first raw-served slot index and
     * the raw-input index where the raw run begins.
     *
     * Otherwise, a previous process may have ended right after a last-known-good
     * replay it never captured (see `coldStartUncapturedReplay`): the result is
     * `uncaptured_replay`, with the array that replay most likely served, so the
     * thinking strip can remove thinking produced against bytes the module now
     * renders differently.
     *
     * Null when neither applies. Uses the module output from before postprocess,
     * which has side effects a pass that ends in a frozen serve must not run.
     */
    const detectColdStartFrozenSlot = (
        sessionId: string,
        rawInput: MessageLike[],
        moduleOutput: readonly unknown[],
        providerID: string | undefined,
    ):
        | { kind: "frozen_slot"; slotMessages: unknown[]; index: number; rawRunStart: number }
        | { kind: "uncaptured_replay"; lastServed: unknown[]; rawUserIndex: number }
        | null => {
        try {
            const slotMessages = parseLastServedSnapshot(getSlot(sessionId)?.jsonPrefix);
            if (!slotMessages) return null;
            const key = rustModeServedKeyAfterPersistedStrips({
                db: deps.db,
                sessionId,
                resolvedProviderID: providerID,
            });
            const frozen = coldStartRawServedIndex({ slotMessages, rawInput, moduleOutput, key });
            if (frozen) return { kind: "frozen_slot", slotMessages, ...frozen };
            const uncaptured = coldStartUncapturedReplay({
                slotMessages,
                rawInput,
                moduleOutput,
                key,
            });
            if (!uncaptured) return null;
            // The uncaptured replay removed the session's persisted thinking strips from
            // the raw tail before serving it; do the same here so the comparison matches.
            const lastServed = structuredClone(uncaptured.lastServed) as MessageLike[];
            replayRustModeBindingMismatchStrips({
                db: deps.db,
                sessionId,
                messages: lastServed,
                resolvedProviderID: providerID,
            });
            return {
                kind: "uncaptured_replay",
                lastServed,
                rawUserIndex: uncaptured.rawUserIndex,
            };
        } catch (error) {
            sessionLog(sessionId, "lkg cold-start freeze check failed (ignored):", error);
            return null;
        }
    };

    // When this adapter last started a pass for each session; the outer wrapper's
    // replay registry uses it to find the adapter that currently runs a session.
    const passStampBySession = new Map<string, number>();
    const replayParticipant: RustLkgReplayParticipant = {
        lastPassStamp: (sessionId) =>
            states.has(sessionId) ? passStampBySession.get(sessionId) : undefined,
        enterFreezeFromExternalServe: (sessionId, inputCount) =>
            enterLkgReplayFreeze(ensureState(states, sessionId), inputCount),
        replayFits: (sessionId, messages, inputMessages) => {
            try {
                const fit = lkgReplayFits({
                    db: deps.db,
                    sessionId,
                    messages,
                    model: resolveReplayModel(sessionId, inputMessages),
                    modelKey: resolveLkgModelKeys(inputMessages).modelKey,
                    systemPromptTokens: getOrCreateSessionMeta(deps.db, sessionId)
                        .systemPromptTokens,
                    agentName: deps.getNotificationParams?.(sessionId)?.agent,
                    estimator: rawFallbackEstimator,
                });
                if (!fit.fits && fit.detail) sessionLog(sessionId, fit.detail);
                return fit.fits;
            } catch (error) {
                sessionLog(sessionId, "lkg wrapper replay fit check failed:", error);
                return false;
            }
        },
        emergencyFailClosed: (sessionId, inputMessages) => {
            try {
                const state = ensureState(states, sessionId);
                if (
                    state.lastPassMarkerApplyAttempted ||
                    state.markerAdmissionFenced ||
                    isRustMarkerAdmissionFenced(deps.db, sessionId)
                ) {
                    // The messages-transform wrapper catches storage-busy errors outside
                    // this adapter. If the marker may have moved, refuse rather than send
                    // a saved request or raw messages built for the previous history boundary.
                    fenceMarkerAdmission(sessionId, state);
                    return true;
                }
                const model = resolveReplayModel(sessionId, inputMessages) ?? undefined;
                const modelKey = model
                    ? canonicalModelIdentity(resolveModelKey(model.providerID, model.modelID) ?? "")
                    : null;
                const limits = { db: deps.db, sessionID: sessionId };
                return rustEmergencyFailClosed({
                    sessionId,
                    usage: loadContextUsage(deps.contextUsageMap, deps.db, sessionId),
                    geometry: transformGeometryForWire(
                        model
                            ? resolveContextWindowGeometry(model.providerID, model.modelID, limits)
                            : undefined,
                    ),
                    trustedContextLimit: model
                        ? resolveTrustedContextLimit(model.providerID, model.modelID, limits)
                        : undefined,
                    overflowState: getOverflowState(deps.db, sessionId, modelKey),
                    modelKey,
                }).emergencyFailClosed;
            } catch (error) {
                // Unknown pressure must not admit cached bytes.
                sessionLog(sessionId, "lkg wrapper replay emergency check failed:", error);
                return true;
            }
        },
        stripPersistedReasoning: (sessionId, messages, inputMessages) =>
            replayRustModeBindingMismatchStrips({
                db: deps.db,
                sessionId,
                messages,
                resolvedProviderID: resolveReplayModel(sessionId, inputMessages)?.providerID,
            }),
    };
    const unregisterReplayParticipant = registerRustLkgReplayParticipant(replayParticipant);

    const prepareRustCapture = (
        state: RustSessionState,
        sessionId: string,
        inputIds: readonly unknown[],
        inputKeys: ReturnType<typeof resolveLkgModelKeys>,
        inputSnapshots: readonly Pick<MessageContentSnapshot, "fields">[],
        nativeMessages: readonly unknown[],
        responseRowVersion: number,
        systemPromptTokens: number,
    ): RustLkgCapturePlan | null => {
        state.lkgCaptureSequence += 1;
        if (
            inputIds.some((id) => typeof id !== "string") ||
            new Set(inputIds).size !== inputIds.length ||
            inputIds.length === 0 ||
            inputSnapshots.length !== inputIds.length
        ) {
            return null;
        }
        const jsonPrefix = JSON.stringify(nativeMessages);
        if (typeof jsonPrefix !== "string") return null;
        return {
            sessionId,
            inputIds: inputIds as string[],
            inputSnapshots,
            jsonPrefix,
            modelKey: inputKeys.modelKey,
            providerKey: inputKeys.providerKey,
            capturedAt: Date.now(),
            rowVersion: responseRowVersion,
            captureSequence: state.lkgCaptureSequence,
            servedCaptureId: deps.compactionOff
                ? undefined
                : recordServedCapture(deps.db, sessionId, true),
            requestIdentity: claimLkgRequestIdentity(sessionId),
            systemPromptTokens,
            agentName: deps.getNotificationParams?.(sessionId)?.agent,
        };
    };

    const commitRustCapture = (
        state: RustSessionState,
        plan: RustLkgCapturePlan,
        requireDurable = false,
    ): "captured" | "superseded" => {
        if (
            states.get(plan.sessionId) !== state ||
            plan.captureSequence !== state.lkgCaptureSequence ||
            plan.rowVersion < state.lkgLastCapturedRowVersion
        ) {
            return "superseded";
        }
        // Reuse requires the exact inputs from a previously accepted capture in this
        // process; a restarted adapter has no such proof. Compute FNV signatures at
        // commit, not before the RPC, retaining Pi's input_content_signatures format.
        // Cache-busting/recovery captures still commit synchronously for durability.
        const prior = getSlot(plan.sessionId);
        const inputs = plan.inputIds.map((id, index) => ({
            id,
            fields: plan.inputSnapshots[index]?.fields ?? [],
        }));
        // A failed durable refresh followed by eviction can hydrate an older slot.
        // Its digests must not borrow the newer in-memory capture's equality proof.
        const accepted = state.lkgAcceptedCapture;
        const {
            digests: inputContentDigests,
            inputContentSignatures,
            reusedPrefix,
        } = rustCaptureDigests(
            inputs,
            prior?.modelKey === plan.modelKey &&
                prior?.providerKey === plan.providerKey &&
                prior?.captureSequence === accepted?.captureSequence &&
                prior?.rowVersion === accepted?.rowVersion
                ? prior
                : undefined,
            accepted?.inputs ?? null,
        );
        const slot = {
            jsonPrefix: plan.jsonPrefix,
            inputIdSeq: plan.inputIds,
            inputContentDigests,
            inputContentSignatures,
            lastInputMessageId: plan.inputIds[plan.inputIds.length - 1] as string,
            modelKey: plan.modelKey,
            providerKey: plan.providerKey,
            capturedAt: plan.capturedAt,
            rowVersion: plan.rowVersion,
            captureSequence: plan.captureSequence,
            servedCaptureId: plan.servedCaptureId,
            fullCoverage: true,
            inputMoveDigests: inputs.map((input) => moveMessageDigestFromFields(input.fields)),
        };
        const rejection = lkgSlotRejection(plan.sessionId, slot);
        const captured = rejection === null && captureSlot(plan.sessionId, slot);
        if (!captured)
            throw new Error(
                `LKG slot rejected the prepared snapshot: ${rejection ?? "over the LKG heap budget"}`,
            );
        state.lkgAcceptedCapture = {
            inputs,
            captureSequence: plan.captureSequence,
            rowVersion: plan.rowVersion,
        };
        noteCapturedLkgRequest({
            sessionId: plan.sessionId,
            slot,
            request: plan.requestIdentity,
            systemPromptTokens: plan.systemPromptTokens,
            agentName: plan.agentName,
        });
        options.onLkgCaptureForTests?.(reusedPrefix);
        // Durability across restarts: store the exact accepted snapshot (the
        // jsonPrefix string is reused as-is, never re-serialized). Best-effort —
        // a write failure leaves the in-memory slot serving this process.
        const persisted = saveLkgSlotToDb(deps.db, plan.sessionId, slot);
        if (requireDurable && !persisted) {
            throw new Error("priced LKG snapshot did not reach durable storage");
        }
        state.lkgLastCapturedRowVersion = plan.rowVersion;
        state.lkgSyncCaptureRequired = false;
        return "captured";
    };

    const run = async (
        sessionId: string,
        messages: MessageLike[],
        output: { messages: unknown[] },
        sessionMeta: ReturnType<typeof getOrCreateSessionMeta>,
    ): Promise<void> => {
        const passStartedAt = performance.now();
        const passObservedAtMs = Date.now();
        const state = ensureState(states, sessionId);
        let markerApplyAttempted = false;
        let markerDefinitelyNoCut = false;
        let markerSafeSnapshot: LkgSlot | undefined;
        let markerOriginalMessages: MessageLike[] | undefined;
        state.lastPassMarkerApplyAttempted = false;
        // Only the path that captures the array it serves sets this again, so every
        // other way out of this pass leaves the next pass unable to trust the slot.
        const lastServedCaptureSequence = state.lkgLastServedCaptureSequence;
        state.lkgLastServedCaptureSequence = null;
        const trailingBlankSourceDecisions = snapshotTrailingBlankSourceDecisions(messages);
        const trailingBlankNewestAssistantId = [...messages]
            .reverse()
            .find((message) => message.info.role === "assistant")?.info.id;
        const timings = emptyRustPassTimings();
        state.passCount += 1;
        passStampBySession.set(sessionId, nextRustPassStamp());
        const syntheticTurn = observeSyntheticTurn(state, messages);
        const syntheticLoopBlocked = syntheticTurn && state.syntheticTurnCount >= 3;
        if (syntheticLoopBlocked && !state.syntheticLoopBreakerLogged) {
            state.syntheticLoopBreakerLogged = true;
            sessionLog(
                sessionId,
                "RUST LOOP BREAKER: suppressing host directives after three consecutive synthetic turns until a real user message arrives",
            );
        }
        const inputCount = messages.length;
        const inputHasActiveThinking = hasActiveAnthropicThinkingTurn(messages, "anthropic");
        const thinkingRecovery = prepareLatestThinkingRecovery({
            db: deps.db,
            sessionId,
            messages,
            id: (message) => (message as MessageLike)?.info.id,
            parts: (message) => (message as MessageLike)?.parts ?? [],
        });
        const restoreLatestTurnOriginals = thinkingRecovery.restore
            ? captureLatestTurnOriginals(messages as MessageLike[])
            : undefined;
        let requestInputTokens = 0;
        let decision = "error";
        let materializeReason = "none";
        let schedulerDecision: string | undefined;
        let responseCommitted: boolean | undefined;
        let responsePrefixBustPermitted: boolean | undefined;
        let schedulerDeferReason: string | undefined;
        let historianNoFire: string | undefined;
        let historianCanonicalCause: string | undefined;
        let identityDelta: string[] = [];
        let servedFrom = "none";
        let moduleElapsedMs = 0;
        let rowVersion = 0;
        let coveredOrdinal = 0;
        let inputFirstOrdinal: number | null = null;
        let markerAt: string | null = null;
        // Read before this pass can advance the marker: the nudge arm below needs the
        // coverage a previous process already published.
        let persistedBoundaryOrdinal: number | null = null;
        try {
            const marker = getPersistedCompactionMarkerState(deps.db, sessionId);
            markerAt = marker?.targetEndMessageId ?? marker?.boundaryMessageId ?? null;
            persistedBoundaryOrdinal = marker?.boundaryOrdinal ?? null;
        } catch {
            // Diagnostics remain available even when the local state database is unavailable.
        }
        let appliedAt: number | undefined;
        let emergencyFailClosed = false;
        let providerProvenEmergency = false;
        let recoveryProjectRoot = options.projectRoot ?? deps.directory ?? "";
        // Parking must not hide pressure from the recovery policy. Usage is cheap to read
        // and is the same value copied onto the module request when this pass runs.
        const passUsageSnapshot = loadContextUsage(deps.contextUsageMap, deps.db, sessionId);
        requestInputTokens = Math.max(0, Math.floor(passUsageSnapshot.inputTokens));
        let preflightError: unknown;
        let markerAdmissionRecovery = state.markerAdmissionFenced;
        try {
            markerAdmissionRecovery ||= isRustMarkerAdmissionFenced(deps.db, sessionId);
        } catch (error) {
            preflightError = error;
        }
        if (markerAdmissionRecovery) {
            state.markerAdmissionFenced = true;
            state.lastPassMarkerApplyAttempted = true;
            state.forceFullWire = true;
            state.parked = false;
            state.lkgRepresentationFrozen = false;
            state.lkgColdStartCheckPending = false;
        }
        let model = modelFromMessages(messages) ?? deps.liveModelBySession?.get(sessionId);
        if (!model) {
            try {
                model = hostModelFallback(sessionId) ?? undefined;
            } catch (error) {
                preflightError = error;
            }
        }
        const modelKey = model
            ? canonicalModelIdentity(resolveModelKey(model.providerID, model.modelID) ?? "")
            : null;
        try {
            const ttlConfig = deps.sampleCacheTtlConfig?.();
            sessionMeta.cacheTtl = resolveSessionCacheTtl(
                deps.db,
                sessionId,
                ttlConfig?.cache_ttl ?? deps.cacheTtlConfig,
                modelKey ?? undefined,
                ttlConfig?.cacheTtlConfigured ?? deps.cacheTtlConfigured,
            ).value;
        } catch (error) {
            preflightError ??= error;
        }
        let resolvedContextLimit: number | undefined;
        let resolvedWindowGeometry: WindowGeometryResult | undefined;
        if (model) {
            try {
                resolvedContextLimit = resolveTrustedContextLimit(model.providerID, model.modelID, {
                    db: deps.db,
                    sessionID: sessionId,
                });
                resolvedWindowGeometry = resolveContextWindowGeometry(
                    model.providerID,
                    model.modelID,
                    { db: deps.db, sessionID: sessionId },
                );
            } catch (error) {
                preflightError ??= error;
            }
        }
        let overflowState: ReturnType<typeof getOverflowState> | undefined;
        try {
            overflowState = getOverflowState(deps.db, sessionId, modelKey);
        } catch (error) {
            preflightError ??= error;
        }
        const transformGeometry = transformGeometryForWire(resolvedWindowGeometry);
        ({ emergencyFailClosed, providerProvenEmergency } = rustEmergencyFailClosed({
            sessionId,
            usage: passUsageSnapshot,
            geometry: transformGeometry,
            trustedContextLimit: resolvedContextLimit,
            overflowState,
            modelKey,
        }));
        const serveRawFallback = (cause?: unknown): void => {
            servedFrom = "refused";
            let admissionFenced: boolean;
            try {
                admissionFenced =
                    state.markerAdmissionFenced || isRustMarkerAdmissionFenced(deps.db, sessionId);
            } catch (error) {
                // If storage cannot tell us whether replay is blocked, refuse rather
                // than send raw history that may belong to the previous marker position.
                throw new RawFallbackContextLimitError(Number.POSITIVE_INFINITY, 0, {
                    cause: error,
                });
            }
            if (admissionFenced) {
                throw new EmergencyFailClosedError(
                    "Magic Context cannot serve raw history after a failed boundary rebuild. Retry to recompose from the new boundary.",
                    { cause },
                );
            }
            // A lost transform reply cannot authorize unmanaged history, even when
            // compaction is disabled; only a verified last-good replay may continue.
            if (moduleFailureCode(cause) === "transform_transport_interrupted") {
                throw new EmergencyFailClosedError(ENGINE_RECONNECTING_USER_MESSAGE, { cause });
            }
            if (!deps.compactionOff && isTransientSqliteError(cause)) {
                throw new StorageBusyRefusalError(cause, "rust-mode-transform");
            }
            // The raw full history is admitted exactly like a last-known-good replay:
            // against the trusted limit, never the larger usable hard limit (some
            // providers enforce their declared prompt limit), measured on what the
            // request carries, and only when a trusted estimate is under the limit.
            let contextLimit: number | undefined;
            try {
                contextLimit = lkgReplayLimit({
                    db: deps.db,
                    sessionId,
                    model,
                    modelKey: resolveLkgModelKeys(messages).modelKey,
                });
            } catch {
                contextLimit = undefined;
            }
            if (contextLimit !== undefined) {
                // The wire byte proxy runs first: once its running sum crosses the
                // budget the refusal is proven and the tokenizer pass, seconds on giant
                // histories, is skipped on the failure path.
                const measure = measureLkgReplay({
                    messages,
                    limit: contextLimit,
                    estimate: () =>
                        rawFallbackEstimator({
                            messages,
                            systemPromptTokens: sessionMeta.systemPromptTokens,
                            providerID: model?.providerID,
                            modelID: model?.modelID,
                            agentName: deps.getNotificationParams?.(sessionId)?.agent,
                        }),
                });
                if (measure.fit !== "under") {
                    const proxyTokens = measure.proxy
                        ? Math.ceil(measure.proxy.bytes / RAW_FALLBACK_BYTES_PER_CONTEXT_TOKEN)
                        : null;
                    const refusalTokens =
                        measure.trusted && measure.tokens !== null && measure.tokens > 0
                            ? Math.max(measure.tokens, proxyTokens ?? 0)
                            : Number.POSITIVE_INFINITY;
                    sessionLog(
                        sessionId,
                        `raw_fallback_over_context_limit estimated=${measure.tokens ?? (measure.estimatorRan ? "unavailable" : "skipped")} trusted=${measure.trusted} ` +
                            `proxy_bytes=${measure.proxy?.bytes ?? "unavailable"} proxy_tokens=${proxyTokens ?? "unavailable"} limit=${contextLimit}` +
                            (measure.proxy?.aborted === true ? " early_abort=true" : ""),
                    );
                    throw new RawFallbackContextLimitError(refusalTokens, contextLimit, { cause });
                }
            } else {
                throw new RawFallbackContextLimitError(Number.POSITIVE_INFINITY, 0, { cause });
            }
            if (!deps.compactionOff) {
                servedFrom = "refused";
                throw new EmergencyFailClosedError(ENGINE_RECONNECTING_USER_MESSAGE, { cause });
            }
            replaceMessagesInPlace(output, messages);
            servedFrom = "raw";
            // The provider now sees the raw input instead of the frozen array, so there is
            // no frozen representation left to keep byte-identical.
            state.lkgRepresentationFrozen = false;
            state.lkgFrozenHealthyPasses = 0;
            state.lkgFrozenAtInputCount = null;
        };
        // The measurement every last-known-good replay is admitted with (see
        // `measureLkgReplay`), here with this pass's model and estimator.
        const measureOutputAgainstLimit = (candidate: readonly unknown[], limit: number) =>
            measureLkgReplayRequest({
                sessionId,
                messages: candidate as MessageLike[],
                limit,
                model,
                systemPromptTokens: sessionMeta.systemPromptTokens,
                agentName: deps.getNotificationParams?.(sessionId)?.agent,
                estimator: rawFallbackEstimator,
            });
        const measureAgainstLimit = (candidate: readonly unknown[], limit: number): FrozenFit =>
            measureOutputAgainstLimit(candidate, limit).fit;
        /**
         * Admission for a healthy pass that would serve the frozen replay `candidate`
         * instead of `moduleOutput`. Returns a release reason when the frozen bytes no
         * longer fit but the module's output does, null to keep serving the freeze, and
         * throws `FrozenReplayOverProvenLimitRefusal` when the replay is known over
         * a trusted limit and the native output cannot be shown to fit. An unproven
         * frozen measurement never releases: adopting module output on a guess would bust the cache of
         * every frozen session on a model whose estimate is incomplete.
         */
        const frozenReplayAdmission = (
            candidate: readonly unknown[],
            moduleOutput: readonly unknown[],
        ): string | null => {
            const emergency =
                isEmergencyRecoveryArmed(sessionId) || overflowState?.needsEmergencyRecovery;
            if (emergency) {
                const provenLimit =
                    overflowState &&
                    overflowState.detectedContextLimit > 0 &&
                    (overflowState.detectedContextLimitModelKey === null ||
                        canonicalModelIdentity(overflowState.detectedContextLimitModelKey) ===
                            canonicalModelIdentity(modelKey ?? ""))
                        ? overflowState.detectedContextLimit
                        : undefined;
                if (provenLimit !== undefined) {
                    const frozenFit = measureAgainstLimit(candidate, provenLimit);
                    if (frozenFit === "over") {
                        const moduleFit = measureAgainstLimit(moduleOutput, provenLimit);
                        if (moduleFit === "under") return "frozen_over_proven_limit";
                        throw new FrozenReplayOverProvenLimitRefusal(moduleFit, provenLimit);
                    }
                    if (frozenFit === "unproven") {
                        sessionLog(sessionId, `frozen_emergency_fit_unproven limit=${provenLimit}`);
                    }
                } else {
                    sessionLog(sessionId, "frozen_emergency_limit_unknown");
                }
            }
            // The same limit the failure and wrapper replays are admitted against.
            let limit: number | undefined;
            try {
                limit = lkgReplayLimit({
                    db: deps.db,
                    sessionId,
                    model,
                    modelKey: resolveLkgModelKeys(messages).modelKey,
                });
            } catch {
                limit = undefined;
            }
            if (limit === undefined) {
                sessionLog(sessionId, "frozen_fit_unproven limit=unknown");
                return null;
            }
            const frozenFit = measureAgainstLimit(candidate, limit);
            if (frozenFit === "unproven") {
                sessionLog(sessionId, `frozen_fit_unproven limit=${limit}`);
                return null;
            }
            if (frozenFit === "under") return null;
            const moduleFit = measureAgainstLimit(moduleOutput, limit);
            if (moduleFit === "under") return "frozen_over_context_limit";
            sessionLog(
                sessionId,
                moduleFit === "over"
                    ? `frozen_fit_both_over limit=${limit}`
                    : `frozen_fit_unproven module=unproven limit=${limit}`,
            );
            throw new FrozenReplayOverProvenLimitRefusal(moduleFit, limit);
        };
        const finishPass = (applied: boolean, served = true): void => {
            // A pass that serves nothing leaves the provider's last-seen array unchanged,
            // so the proof that the slot holds that array must survive the refusal.
            if (!served) state.lkgLastServedCaptureSequence = lastServedCaptureSequence;
            const elapsedAt = applied && appliedAt !== undefined ? appliedAt : performance.now();
            const elapsedMs = Math.max(0, elapsedAt - passStartedAt);
            sessionLog(
                sessionId,
                formatRustInputCoverageLog({
                    ocInput: inputCount,
                    markerAt,
                    covered: coveredOrdinal,
                    firstOrdinal: inputFirstOrdinal,
                }),
            );
            sessionLog(
                sessionId,
                formatRustPassLog({
                    decision,
                    committed: responseCommitted,
                    prefixBustPermitted: responsePrefixBustPermitted,
                    reason: materializeReason,
                    schedulerDecision,
                    schedulerDeferReason,
                    historianNoFire,
                    historianCanonicalCause,
                    identityDelta,
                    servedFrom,
                    inputCount,
                    outputCount: output.messages.length,
                    applied,
                    elapsedMs,
                    moduleElapsedMs,
                    rowVersion,
                    timings,
                }),
            );
            if (served) {
                writeRustTransformDecision({
                    sessionId,
                    decision,
                    materializeReason: materializeReason === "none" ? null : materializeReason,
                    inputTokens: requestInputTokens,
                    tsMs: passObservedAtMs,
                });
            }
        };
        const captureResponseTelemetry = (response: Record<string, unknown>): void => {
            responsePrefixBustPermitted =
                typeof response.prefix_bust_permitted === "boolean"
                    ? response.prefix_bust_permitted
                    : undefined;
            responseCommitted =
                typeof response.committed === "boolean" ? response.committed : undefined;
            decision =
                typeof response.decision === "string"
                    ? response.decision
                    : typeof response.action === "string"
                      ? response.action
                      : typeof response.status === "string"
                        ? response.status
                        : "unknown";
            servedFrom =
                typeof response.served_from === "string" ? response.served_from : "unknown";
            schedulerDecision =
                typeof response.scheduler_decision === "string"
                    ? response.scheduler_decision
                    : undefined;
            schedulerDeferReason =
                typeof response.scheduler_defer_reason === "string"
                    ? response.scheduler_defer_reason
                    : undefined;
            const historian = isRecord(response.historian) ? response.historian : undefined;
            historianNoFire =
                typeof historian?.no_fire === "string" ? historian.no_fire : undefined;
            historianCanonicalCause =
                typeof historian?.canonical_cause === "string"
                    ? historian.canonical_cause
                    : undefined;
            materializeReason =
                typeof response.materialize_reason === "string" &&
                response.materialize_reason.length > 0
                    ? response.materialize_reason
                    : "none";
            identityDelta = Array.isArray(response.identity_delta)
                ? response.identity_delta.filter(
                      (component): component is string =>
                          typeof component === "string" && component.length > 0,
                  )
                : [];
            const timings = isRecord(response.timings) ? response.timings : undefined;
            const applyOnceTotal = timings?.total;
            const handlerTotal = timings?.handler_total;
            moduleElapsedMs =
                typeof handlerTotal === "number" && Number.isFinite(handlerTotal)
                    ? handlerTotal
                    : typeof applyOnceTotal === "number" && Number.isFinite(applyOnceTotal)
                      ? applyOnceTotal
                      : 0;
            rowVersion =
                typeof response.row_version === "number" &&
                Number.isSafeInteger(response.row_version)
                    ? response.row_version
                    : 0;
            coveredOrdinal =
                typeof response.coverage_ordinal === "number" &&
                Number.isSafeInteger(response.coverage_ordinal) &&
                response.coverage_ordinal >= 0
                    ? response.coverage_ordinal
                    : 0;
            if (
                timings &&
                (typeof timings.handler_total === "number" ||
                    typeof timings.native_cache_reused_messages === "number" ||
                    typeof timings.native_cache_encoded_messages === "number")
            ) {
                const stage = (name: string): string => {
                    const value = timings[name];
                    return typeof value === "number" && Number.isFinite(value)
                        ? value.toFixed(1)
                        : "n/a";
                };
                sessionLog(
                    sessionId,
                    `rust module stages: handler=${stage("handler_total")} apply_once=${stage("total")} ` +
                        `request_to_handler=${stage("request_observed_to_handler")} delta_expand=${stage("delta_expand")} ` +
                        `projection_cache_lookup=${stage("projection_cache_lookup")} projection=${stage("projection")} ` +
                        `selection=${stage("selection")} build_output=${stage("build_output")} ` +
                        `store_commit=${stage("store_commit")} trigger=${stage("trigger_ms")} ` +
                        `trigger_boundary=${stage("trigger_boundary_build")} trigger_eval=${stage("trigger_eval")} ` +
                        `projection_cache_store=${stage("projection_cache_store")} native_attach=${stage("native_attach")} ` +
                        `retained_size=${stage("retained_size")} snapshot_store=${stage("snapshot_store")} ` +
                        `post_attach=${stage("post_attach")} response_encode=${stage("response_encode")} ` +
                        `response_meta_encode=${stage("response_meta_encode")} response_splice=${stage("response_splice")} ` +
                        `native_cache_reused=${stage("native_cache_reused_messages")} ` +
                        `native_cache_encoded=${stage("native_cache_encoded_messages")}`,
                );
            }
            // If the module took at least one second, log every other numeric timing
            // field so the slow stage can be identified.
            if (timings && moduleElapsedMs >= 1000) {
                const detail = Object.entries(timings)
                    .filter(
                        ([key, value]) =>
                            key !== "total" && key !== "handler_total" && typeof value === "number",
                    )
                    .map(([key, value]) => `${key}:${(value as number).toFixed(1)}`)
                    .join(" ");
                if (detail) sessionLog(sessionId, `rust module stages (slow pass): ${detail}`);
            }
        };
        if (state.parked) {
            state.passesSincePark += 1;
            // The fifth live pass is the first retry opportunity after the
            // three-failure park; later retries use the same global cadence.
            if (
                !emergencyFailClosed &&
                passUsageSnapshot.percentage < RUST_PARK_PROBE_PRESSURE_BYPASS_PCT &&
                state.passCount % RUST_PARK_RETRY_INTERVAL !== 0
            ) {
                decision = "parked";
                const replayed = replayLastGood(
                    sessionId,
                    messages,
                    output,
                    sessionMeta.systemPromptTokens,
                );
                if (replayed) {
                    servedFrom = "lkg";
                    finishPass(false);
                    return;
                }
                // Parking only saves work when a safe cached prompt can serve.
                // With no LKG, try the module now instead of refusing four turns
                // out of five even after it has recovered.
                decision = "pending";
            }
            // A parked session without a usable replay should recover immediately
            // when the module is alive, but must not spend another full transform
            // deadline discovering an unresponsive module on every user turn.
            try {
                await callModule(
                    {
                        sessionId,
                        projectRoot: recoveryProjectRoot,
                        method: "session.status",
                        body: { method: "session.status", v: 1, session_id: sessionId },
                        bypassSessionLane: true,
                    },
                    options.healthProbeTimeoutMsForTests ?? RUST_HEALTH_PROBE_TIMEOUT_MS,
                    false,
                );
            } catch (error) {
                decision = "parked";
                if (replayLastGood(sessionId, messages, output, sessionMeta.systemPromptTokens)) {
                    servedFrom = "lkg";
                    finishPass(false);
                    return;
                }
                if (deps.compactionOff) {
                    try {
                        serveRawFallback(error);
                    } catch (rawFallbackError) {
                        finishPass(false, false);
                        throw rawFallbackError;
                    }
                    finishPass(false);
                    return;
                }
                servedFrom = "refused";
                sessionLog(
                    sessionId,
                    "rust parked health probe failed; refusing without a full request",
                    error,
                );
                finishPass(false, false);
                throw new EmergencyFailClosedError(ENGINE_RECONNECTING_USER_MESSAGE, {
                    cause: error,
                });
            }
        }
        timings.preflight = performance.now() - passStartedAt;

        // The first user prompt is available before OpenCode saves its tools map. Check that
        // prompt for ctx_reduce permission first; otherwise an unknown verdict sends the first
        // subagent request without tags even though the model can call ctx_reduce.
        resolveCtxReduceAvailabilityFromMessages(sessionId, messages);
        const reduceAvailability = resolveCtxReduceAvailability(sessionId);
        // Freeze the native todo-tool map verdict before state sync reads it, then combine it
        // with OpenCode's live permission decision. The module receives one authoritative bool;
        // provisional or missing host evidence fails closed for synthesis.
        resolveTodowriteAvailabilityFromMessages(sessionId, messages);
        const todoAvailability = resolveTodowriteAvailability(sessionId);
        const toolPresent = reduceAvailability.frozen && reduceAvailability.callable;
        let todoProbeIdentity = "";
        let todoBustIdentity = "";
        let todoProbeRequired = true;
        try {
            if (preflightError) throw preflightError;
            if (!overflowState) throw new Error("rust overflow state unavailable");
            const directoryStartedAt = performance.now();
            const { directory, resolvedFromHost } = await getSessionDirectory(deps, sessionId);
            timings.sessionDirectory += performance.now() - directoryStartedAt;
            const identityResolveStartedAt = performance.now();
            if (
                resolvedFromHost &&
                (options.disableHotPathIoCachesForTests === true ||
                    state.recordedSessionDirectory !== directory)
            ) {
                const sessionProjectIdentity = (
                    options.sessionProjectIdentityResolverForTests ??
                    resolveProjectIdentityForSession
                )(directory, deps.allowHomeProject);
                if (sessionProjectIdentity) {
                    if (state.recordedSessionProjectIdentity !== sessionProjectIdentity) {
                        // Missing chunk embeddings are restored through the session's
                        // host-owned project binding, not through Rust module state.
                        recordSessionProjectIdentity(deps.db, sessionId, sessionProjectIdentity);
                    }
                    state.recordedSessionProjectIdentity = sessionProjectIdentity;
                    state.recordedSessionDirectory = directory;
                }
            }
            let memoryProjectPath = deps.projectPath;
            if (deps.memoryConfig?.enabled && directory.length > 0) {
                if (
                    options.disableHotPathIoCachesForTests !== true &&
                    state.resolvedMemoryProjectDirectory === directory
                ) {
                    memoryProjectPath = state.resolvedMemoryProjectPath ?? undefined;
                } else {
                    const resolvedProject = (
                        options.memoryProjectIdentityResolverForTests ?? resolveProjectIdentity
                    )(directory);
                    if (resolvedProject) {
                        state.resolvedMemoryProjectDirectory = directory;
                        state.resolvedMemoryProjectPath = resolvedProject;
                    }
                    memoryProjectPath = resolvedProject;
                }
            }
            logStage(sessionId, "identityResolve", identityResolveStartedAt, timings);
            if (model) deps.liveModelBySession?.set(sessionId, model);
            const usage = passUsageSnapshot;
            requestInputTokens = Math.max(0, Math.floor(usage.inputTokens));
            const contextLimit =
                resolvedContextLimit && resolvedContextLimit > 0
                    ? resolvedContextLimit
                    : usage.percentage > 0
                      ? Math.round(usage.inputTokens / (usage.percentage / 100))
                      : 128_000;
            const threshold = resolveExecuteThreshold(
                deps.executeThresholdPercentage ?? 65,
                modelKey ?? undefined,
                65,
                { tokensConfig: deps.executeThresholdTokens, contextLimit },
            );
            const historyBudgetTokens = resolveHistoryBudgetTokens(
                deps.historyBudgetPercentage,
                usage,
                deps.executeThresholdPercentage,
                modelKey ?? undefined,
                deps.executeThresholdTokens,
                resolvedContextLimit,
            );
            const requestObservedAtMs = Date.now();
            const recoveryNoHeadEscape =
                overflowState.needsEmergencyRecovery &&
                loadProtectedTailMeta(deps.db, sessionId).recoveryNoEligibleHeadCount >=
                    RECOVERY_NO_HEAD_LIMIT;
            const promptSurfaceStartedAt = performance.now();
            const promptSurfaceGuidance =
                options.disableHotPathIoCachesForTests === true
                    ? deps.promptSurfaceRuntime?.resolveGuidance(
                          deps.promptSurface,
                          modelKey ?? undefined,
                      )
                    : promptSurfaceGuidanceEpochs?.resolve(
                          sessionId,
                          deps.promptSurface,
                          modelKey ?? undefined,
                      );
            const promptSurface =
                promptSurfaceGuidance ??
                resolvePromptSurface(deps.promptSurface, modelKey ?? undefined);
            logStage(sessionId, "promptSurface", promptSurfaceStartedAt, timings);
            const protectionFloorCacheBustingPass =
                schedulerDecision === "execute" ||
                deps.historyRefreshSessions.has(sessionId) ||
                deps.pendingMaterializationSessions.has(sessionId) ||
                deps.deferredHistoryRefreshSessions?.has(sessionId) === true ||
                deps.deferredMaterializationSessions?.has(sessionId) === true;
            // A module-driven HARD on a host-defer pass may use the previous candidate; cue-only changes wait for the next host bust opportunity.
            const muralResolveStartedAt = performance.now();
            const resolvedMural =
                !sessionMeta.isSubagent && deps.muralEnabled === true
                    ? resolveMuralForPass(
                          state,
                          deps.projectPath,
                          modelKey ?? undefined,
                          deps.memoryConfig?.injectionBudgetTokens,
                          shouldRefreshMuralCandidate({
                              initialized: state.initialized,
                              pressure: usage.percentage,
                              threshold,
                              lastAppliedAtMs: state.lastAppliedAtMs,
                              nowMs: passObservedAtMs,
                              cacheTtl: sessionMeta.cacheTtl,
                              explicitMaterialization: protectionFloorCacheBustingPass,
                          }),
                      )
                    : undefined;
            const mural = muralInputForWire(resolvedMural);
            logStage(sessionId, "muralResolve", muralResolveStartedAt, timings);
            const protectionFloorResolution = resolveEpochFloorForPass(deps.db, sessionId, {
                configuredOverride: deps.protectedTokens,
                tierOverrides: deps.protectedTokenTierOverrides,
                usableSoft: transformGeometry?.usable_soft ?? 128_000,
                isCacheBustingPass: protectionFloorCacheBustingPass,
                onRejectedProjectOverride: (warning) => sessionLog(sessionId, warning),
            });
            if (protectionFloorResolution.snapshotChanged) {
                sessionLog(
                    sessionId,
                    `protected token floor snapshot: floor=${protectionFloorResolution.floor} provenance=${protectionFloorResolution.provenance === "override" ? "absolute" : "derived"} usableSoft=${transformGeometry?.usable_soft ?? 128_000}`,
                );
            } else if (protectionFloorResolution.preSnapshotInputChanged) {
                sessionLog(
                    sessionId,
                    `protected token floor remains frozen until next priced pass: floor=${protectionFloorResolution.floor} reason=${protectionFloorResolution.preSnapshotBustReason}`,
                );
            }
            const effectiveFloor = protectionFloorResolution.floor;
            const historianRun = deps.resolveHistorianRun?.();
            // The system hook acknowledges its first hash and idle-expired changes in
            // the durable cached marker. Forward that acknowledgement separately from
            // the actual identity so the module can adopt only a system-only delta.
            const observedSystemHash = sessionMeta.systemPromptHash ?? "";
            const rustSystemHash = observedSystemHash;
            const historianModels = {
                historianModel: historianRun?.model ?? deps.historianModel,
                fallbackModels: historianRun?.fallbackModels ?? deps.fallbackModels,
            };
            const historianChain = resolvedHistorianModelChain(historianModels);
            const passInputs: Record<string, unknown> = {
                historian_model_limits: resolvedHistorianModelLimits(historianChain),
                historian_max_output_tokens: historianRun
                    ? historianRun.maxOutputTokens
                    : deps.historianMaxOutputTokens,
                now_ms: requestObservedAtMs,
                model_key: modelKey,
                provider_id: model?.providerID ?? null,
                usage: passUsage(usage, contextLimit),
                geometry: transformGeometry,
                effective_execute_threshold: threshold,
                auto_search_enabled: deps.autoSearch?.enabled ?? true,
                auto_search_score_threshold: deps.autoSearch?.scoreThreshold ?? 0.6,
                auto_search_min_prompt_chars: deps.autoSearch?.minPromptChars ?? 20,
                history_budget_tokens: historyBudgetTokens,
                historian_model_chain: historianChain,
                historian_model_variants: resolvedHistorianModelVariants(historianModels),
                historian_timeout_ms:
                    historianRun?.timeoutMs ??
                    deps.historianTimeoutMs ??
                    DEFAULT_HISTORIAN_TIMEOUT_MS,
                keep_reasoning_tokens_effective: resolveKeepReasoningTokens(
                    deps.keepReasoningTokens,
                    modelKey ?? undefined,
                ),
                caveman_enabled:
                    !sessionMeta.isSubagent && deps.cavemanTextCompression?.enabled === true,
                caveman_min_chars: deps.cavemanTextCompression?.minChars ?? 500,
                cache_ttl: sessionMeta.cacheTtl,
                is_subagent: sessionMeta.isSubagent,
                system_prompt_hash: rustSystemHash,
                adopted_system_prompt_hash:
                    observedSystemHash && sessionMeta.cachedM0SystemHash === observedSystemHash
                        ? observedSystemHash
                        : undefined,
                upgrade_state: readUpgradeState(deps.db, sessionId),
                tool_present: toolPresent,
                todo_tool_present: false,
                prompt_surface_preset: promptSurface.preset,
                prompt_surface_model_key: modelKey,
                prompt_surface_config_identity: promptSurfaceConfigIdentity(deps.promptSurface),
                prompt_surface_tool_descriptions: deps.promptSurface?.tool_descriptions ?? {},
                prompt_surface_guidance_override: promptSurfaceGuidance?.primaryOverride,
                mural,
                protected_tokens_effective: effectiveFloor,
                temporal_awareness: deps.experimentalTemporalAwareness === true,
                channel2_nudge_state: getChannel2NudgeState(deps.db, sessionId),
                emergency_recovery_armed:
                    overflowState.needsEmergencyRecovery || isEmergencyRecoveryArmed(sessionId),
                emergency_recovery_no_head_escape: recoveryNoHeadEscape,
                detected_context_limit: overflowState.detectedContextLimit,
                detected_context_limit_model_key: overflowState.detectedContextLimitModelKey,
            };
            const previousWireCache = heapHolder.wireCaches.get(sessionId);
            let wireDelta:
                | {
                      rawStart: number;
                      wireStart: number;
                      after: string;
                      ckAfter: string;
                      nativeAfter: string;
                  }
                | undefined;
            if (
                !state.forceFullWire &&
                passInputs.emergency_recovery_armed !== true &&
                previousWireCache &&
                messages.length >= previousWireCache.rawCount
            ) {
                const appending = messages.length > previousWireCache.rawCount;
                const lastMessage = messages.at(-1);
                // Delta transport is only sound when the prefix the module would reuse is
                // byte-identical to what OpenCode holds NOW. Count/last-signature checks
                // cover the tail; this covers in-place mutation of an older message (an
                // ephemeral reminder wrapper, a late tool completion) which must force a
                // full send instead of riding a stale-prefix delta.
                const prefixGuardStartedAt = performance.now();
                const prefixIntact = prefixContentSnapshotsMatch(
                    messages,
                    previousWireCache,
                    Math.max(0, previousWireCache.rawCount - 1),
                );
                logStage(sessionId, "prefixGuard", prefixGuardStartedAt, timings);
                const lastChanged =
                    !appending && lastMessage !== undefined
                        ? messageCacheSignature(lastMessage) !== previousWireCache.rawLastSignature
                        : false;
                const replaceExistingTail =
                    lastChanged || (appending && previousWireCache.rawLastVisible);
                const rawStart = replaceExistingTail
                    ? Math.max(0, previousWireCache.rawCount - 1)
                    : previousWireCache.rawCount;
                const replaceExistingWireTail =
                    previousWireCache.rawLastVisible && (lastChanged || appending);
                const wireStart = replaceExistingWireTail
                    ? Math.max(0, previousWireCache.wireCount - 1)
                    : previousWireCache.wireCount;
                const ckAfter =
                    wireStart === previousWireCache.wireCount - 1
                        ? previousWireCache.ckPrefixFingerprintBeforeLast
                        : wireStart === previousWireCache.wireCount
                          ? previousWireCache.ckFingerprint
                          : undefined;
                const nativeAfter =
                    rawStart === previousWireCache.rawCount - 1
                        ? previousWireCache.nativePrefixFingerprintBeforeLast
                        : rawStart === previousWireCache.rawCount
                          ? previousWireCache.nativeFingerprint
                          : undefined;
                if (prefixIntact && ckAfter !== undefined && nativeAfter !== undefined) {
                    wireDelta = {
                        rawStart,
                        wireStart,
                        ckAfter,
                        nativeAfter,
                        after: previousWireCache.fingerprint,
                    };
                }
            }
            const cloneStartedAt = performance.now();
            const ordinalMessages = wireDelta ? messages.slice(wireDelta.rawStart) : messages;
            logStage(
                sessionId,
                "clone",
                cloneStartedAt,
                timings,
                wireDelta ? "mode=projection-tail" : "mode=projection-full",
            );
            const provisionalBase = wireDelta
                ? (() => {
                      for (let index = wireDelta.rawStart - 1; index >= 0; index -= 1) {
                          const priorId = messageIdOf(messages[index]);
                          if (!priorId) continue;
                          const prior = state.idOrdinalMemo.get(priorId);
                          if (prior !== undefined)
                              return Math.max(prior, state.ordinalContinuationBase ?? 0);
                      }
                      return Math.max(
                          state.ordinalMemoCanonicalCount,
                          state.ordinalContinuationBase ?? 0,
                      );
                  })()
                : (state.ordinalContinuationBase ?? undefined);
            const ordinalStartedAt = performance.now();
            let resolved = await resolveOrdinalsForModule({
                sessionId,
                messages: ordinalMessages,
                generation: state.moduleGeneration,
                memoGeneration: state.idOrdinalMemoGeneration,
                memo: state.idOrdinalMemo,
                memoAnchor: state.ordinalMemoAnchor,
                memoStoredCount: state.ordinalMemoStoredCount,
                memoCanonicalCount: state.ordinalMemoCanonicalCount,
                memoCheckpoints: state.ordinalMemoCheckpoints,
                verifyStore: state.ordinalMemoVerifyPending,
                provisionalBase,
                forceProbeForTests: options.disableHotPathIoCachesForTests,
            });
            recordOrdinalResolve(sessionId, state, ordinalStartedAt, timings, resolved.stats);
            if (!resolved.ok) {
                // A drift the checkpoint rewind could not repair (or an id that no
                // stored row explains) invalidates every durable memo field. Retry once
                // from a clean full-array prime on both delta and full attempts.
                wireDelta = undefined;
                resetOrdinalMemo(state, `mismatch_${resolved.reason}`);
                const fullOrdinalStartedAt = performance.now();
                resolved = await resolveOrdinalsForModule({
                    sessionId,
                    messages,
                    generation: state.moduleGeneration,
                    memoGeneration: state.idOrdinalMemoGeneration,
                    memo: state.idOrdinalMemo,
                    memoAnchor: state.ordinalMemoAnchor,
                    memoStoredCount: state.ordinalMemoStoredCount,
                    memoCanonicalCount: state.ordinalMemoCanonicalCount,
                    memoCheckpoints: state.ordinalMemoCheckpoints,
                    provisionalBase: state.ordinalContinuationBase ?? undefined,
                    forceProbeForTests: options.disableHotPathIoCachesForTests,
                });
                recordOrdinalResolve(
                    sessionId,
                    state,
                    fullOrdinalStartedAt,
                    timings,
                    resolved.stats,
                    "fallback=clean_full",
                );
            }
            if (!resolved.ok) {
                throw new Error(
                    `rust ordinal ${resolved.reason}: messageId=${resolved.messageId ?? "unknown"} ` +
                        `index=${resolved.messageIndex ?? "unknown"} role=${resolved.messageRole ?? "unknown"}`,
                );
            }
            state.idOrdinalMemoGeneration = resolved.memoGeneration;
            state.ordinalMemoAnchor = resolved.memoAnchor;
            state.ordinalMemoStoredCount = resolved.memoStoredCount;
            state.ordinalMemoCanonicalCount = resolved.memoCanonicalCount;
            state.ordinalMemoVerifyPending = false;
            const firstInputId = messages[0] ? messageIdOf(messages[0]) : null;
            inputFirstOrdinal = firstInputId
                ? (state.idOrdinalMemo.get(firstInputId) ?? null)
                : null;

            const syncPass = {
                db: deps.db,
                sessionId,
                projectPath: memoryProjectPath,
                nowMs: Date.now(),
            };
            const projectRoot = options.projectRoot ?? directory;
            recoveryProjectRoot = projectRoot;
            const authoritySeqAdoption = { used: false };
            const memorySyncRequested =
                options.memorySyncRequestedSessions?.delete(sessionId) === true;
            // The acknowledged watermark snapshot is invalidated only by inputs already observed
            // on this pass: memory-tool mutation requests; compartment/m0 publication signals;
            // project/config refresh signals; or the already-loaded session_meta todo/reasoning
            // epoch. A new transform instance is the config-reload/workspace epoch boundary.
            const currentStateSyncInputSignature = stateSyncInputSignature({
                projectPath: syncPass.projectPath,
                sessionMeta,
                todoAvailability,
                historyRefresh: deps.historyRefreshSessions.has(sessionId),
                deferredHistoryRefresh:
                    deps.deferredHistoryRefreshSessions?.has(sessionId) === true,
                pendingMaterialization: deps.pendingMaterializationSessions.has(sessionId),
                deferredMaterialization:
                    deps.deferredMaterializationSessions?.has(sessionId) === true,
            });
            const todoVerdictStartedAt = performance.now();
            const todoStart = wireDelta?.rawStart ?? 0;
            const todoCandidates = wireDelta ? messages.slice(todoStart) : messages;
            const todoCalls = wireDelta
                ? new Map(state.todoCallSignatures)
                : new Map<string, string>();
            for (const [offset, message] of todoCandidates.entries()) {
                const id = messageIdOf(message) ?? `index:${todoStart + offset}`;
                const parts = message.parts?.filter(
                    (part) => isRecord(part) && part.type === "tool" && part.tool === "todowrite",
                );
                if (parts?.length) {
                    todoCalls.set(
                        id,
                        createHash("sha256").update(JSON.stringify(parts)).digest("hex"),
                    );
                } else {
                    todoCalls.delete(id);
                }
            }
            state.todoCallSignatures = todoCalls;
            todoProbeIdentity = JSON.stringify([
                activeAgentFromMessages(messages),
                todoAvailability.frozen,
                todoAvailability.callable,
                deps.compactionOff === true,
                sessionMeta.lastTodoState,
                [...todoCalls],
            ]);
            let idleBudgetMs = 300_000;
            try {
                idleBudgetMs = parseCacheTtl(sessionMeta.cacheTtl);
            } catch {
                // Invalid TTLs use the same five-minute fallback as the scheduler.
            }
            // Full-wire transport, frozen replay, mural and memory changes do not
            // change todo permissions. Check only new/edited todowrites and busts
            // that could replace the origin call with a synthetic pair.
            const maySynthesizeTodo = !!sessionMeta.lastTodoState;
            todoBustIdentity = JSON.stringify([
                modelKey,
                sessionMeta.systemPromptHash,
                markerAt,
                effectiveFloor,
            ]);
            const todoProbeSignals = {
                cold: state.todoProbeIdentity === undefined,
                missing_verdict: getPersistedTodoPermissionDenied(deps.db, sessionId) === null,
                identity: state.todoProbeIdentity !== todoProbeIdentity,
                bust_identity: maySynthesizeTodo && state.todoBustIdentity !== todoBustIdentity,
                module_hint: maySynthesizeTodo && state.todoProbeNextPass === true,
                pressure: maySynthesizeTodo && usage.percentage >= threshold,
                memory_sync: maySynthesizeTodo && memorySyncRequested,
                refresh: maySynthesizeTodo && protectionFloorCacheBustingPass,
                emergency: maySynthesizeTodo && overflowState.needsEmergencyRecovery,
                agent_drop: maySynthesizeTodo && hasPendingDropOps(deps.db, sessionId),
                ttl:
                    maySynthesizeTodo &&
                    state.lastAppliedAtMs !== undefined &&
                    requestObservedAtMs - state.lastAppliedAtMs >= idleBudgetMs,
            };
            const probeReasons = Object.entries(todoProbeSignals)
                .filter(([, due]) => due)
                .map(([reason]) => reason);
            todoProbeRequired = probeReasons.length > 0;
            timings.todoProbeReason = probeReasons.join(",") || "none";
            timings.todoProbeRequired = Number(todoProbeRequired);
            passInputs.todo_tool_present = await resolveCombinedTodowriteVerdict(
                deps,
                sessionId,
                messages,
                todoAvailability,
                timings,
                todoProbeRequired,
            );
            passInputs.todo_verdict_probed = timings.todoProbe > 0;
            passInputs.verdict_stale_ok = false;
            timings.todoVerdict += performance.now() - todoVerdictStartedAt;
            const knownWatermarksUnchanged =
                options.disableHotPathIoCachesForTests !== true &&
                !memorySyncRequested &&
                !state.lkgRepresentationFrozen &&
                state.stateSyncInputSignature === currentStateSyncInputSignature;
            let stateSyncRetryBusy = false;
            const stateSyncStartedAt = performance.now();
            try {
                const getCachedStateSyncCapabilities =
                    options.moduleClient.getCachedStateSyncCapabilities;
                const stateSyncCapabilities = options.moduleClient.stateSyncCapabilities;
                const stateSyncResult = await syncModuleState({
                    client: {
                        call: callModule,
                        getCachedStateSyncCapabilities: getCachedStateSyncCapabilities
                            ? () => getCachedStateSyncCapabilities.call(options.moduleClient)
                            : undefined,
                        stateSyncCapabilities: stateSyncCapabilities
                            ? (capabilityArgs) =>
                                  stateSyncCapabilities.call(options.moduleClient, capabilityArgs)
                            : undefined,
                    },
                    state,
                    pass: syncPass,
                    projectRoot,
                    force: !state.initialized,
                    options: {
                        authority: true,
                        authoritySeqAdoption,
                        knownWatermarksUnchanged,
                    },
                });
                stateSyncRetryBusy = stateSyncResult.status === "retry_busy";
                if (!stateSyncRetryBusy) {
                    state.stateSyncInputSignature = currentStateSyncInputSignature;
                }
            } finally {
                logStage(sessionId, "stateSync", stateSyncStartedAt, timings);
            }
            const wireBuildStartedAt = performance.now();
            const encodedInput = encodeOpenCodeMessagesToCk(resolved.annotatedInput);
            timings.wireMessages = wireDelta
                ? messages.length - wireDelta.rawStart
                : messages.length;
            let pendingWireCache: RustWireCache = (() => {
                const rawLast = messages.at(-1);
                if (!wireDelta || !previousWireCache) {
                    const ckFingerprint = buildWireFingerprint(encodedInput);
                    const nativeFingerprint = buildWireFingerprint(messages);
                    return {
                        rawCount: messages.length,
                        wireCount: encodedInput.length,
                        rawLastId: rawLast ? messageIdOf(rawLast) : null,
                        rawLastSignature: rawLast ? messageCacheSignature(rawLast) : null,
                        rawLastVisible:
                            rawLast !== undefined &&
                            encodedInput.some((entry) => entry.mid === messageIdOf(rawLast)),
                        ckFingerprint: ckFingerprint.fingerprint,
                        ckPrefixFingerprintBeforeLast: ckFingerprint.prefixFingerprintBeforeLast,
                        nativeFingerprint: nativeFingerprint.fingerprint,
                        nativePrefixFingerprintBeforeLast:
                            nativeFingerprint.prefixFingerprintBeforeLast,
                        rawContentSnapshots: contentSnapshotsFor(messages),
                        fingerprint: `${ckFingerprint.fingerprint}|${nativeFingerprint.fingerprint}`,
                    };
                }
                let ckFingerprint = wireDelta.ckAfter;
                let ckPrefixFingerprintBeforeLast = ckFingerprint;
                for (let index = 0; index < encodedInput.length; index += 1) {
                    if (index === encodedInput.length - 1)
                        ckPrefixFingerprintBeforeLast = ckFingerprint;
                    ckFingerprint = advanceWireFingerprint(ckFingerprint, encodedInput[index]);
                }
                const nativeMessages = messages.slice(wireDelta.rawStart);
                let nativeFingerprint = wireDelta.nativeAfter;
                let nativePrefixFingerprintBeforeLast = nativeFingerprint;
                for (let index = 0; index < nativeMessages.length; index += 1) {
                    if (index === nativeMessages.length - 1)
                        nativePrefixFingerprintBeforeLast = nativeFingerprint;
                    nativeFingerprint = advanceWireFingerprint(
                        nativeFingerprint,
                        nativeMessages[index],
                    );
                }
                const rawLastVisible =
                    rawLast !== undefined &&
                    encodedInput.some((entry) => entry.mid === messageIdOf(rawLast));
                return {
                    rawCount: messages.length,
                    wireCount: wireDelta.wireStart + encodedInput.length,
                    rawLastId: rawLast ? messageIdOf(rawLast) : null,
                    rawLastSignature: rawLast ? messageCacheSignature(rawLast) : null,
                    rawLastVisible,
                    ckFingerprint,
                    ckPrefixFingerprintBeforeLast,
                    nativeFingerprint,
                    nativePrefixFingerprintBeforeLast,
                    // Preserve snapshots for messages reused from the previous wire cache,
                    // and recompute them only for messages included in this request's suffix.
                    rawContentSnapshots: [
                        ...previousWireCache.rawContentSnapshots.slice(0, wireDelta.rawStart),
                        ...contentSnapshotsFor(messages.slice(wireDelta.rawStart)),
                    ],
                    fingerprint: `${ckFingerprint}|${nativeFingerprint}`,
                };
            })();
            // Final-wire estimation is only needed while the host's durable overflow
            // latch is armed. It can then clear that latch, never arm one, so normal
            // large-payload passes avoid an unnecessary full-wire tokenization.
            const finalWireEstimate =
                passInputs.emergency_recovery_armed === true
                    ? estimateFinalWireInputTokens({
                          messages,
                          systemPromptTokens: sessionMeta.systemPromptTokens,
                          providerID: model?.providerID,
                          modelID: model?.modelID,
                          agentName: deps.getNotificationParams?.(sessionId)?.agent,
                      })
                    : undefined;
            // The module folds these fields into the session's render identity and
            // HARD-renders whenever that identity changes. Both the tail-delta body and
            // the full-array retry after need_full_sync must therefore send the same
            // values: when the retry dropped `variant`, a module restart cost two HARDs
            // (the retry recorded an identity without the variant, and the next ordinary
            // pass put it back).
            const renderIdentityFields = {
                modelKey: modelKey ?? null,
                providerId: model?.providerID ?? null,
                variant: deps.variantBySession?.get(sessionId),
                systemPromptHash: rustSystemHash,
                upgradeState: String(passInputs.upgrade_state ?? ""),
            };
            let body = buildTransformBody({
                sessionId,
                input: encodedInput,
                nativeMessages: wireDelta ? messages.slice(wireDelta.rawStart) : messages,
                toolInputKeyOrders: toolInputKeyOrders(encodedInput),
                fullArrayFingerprint: pendingWireCache.fingerprint,
                tailDelta: wireDelta
                    ? {
                          after: wireDelta.after,
                          replaceFrom: wireDelta.wireStart,
                          nativeReplaceFrom: wireDelta.rawStart,
                      }
                    : undefined,
                passInputs,
                usage: {
                    ...passUsage(usage, contextLimit),
                    // The native refusal guard needs route-specific proof of non-fit,
                    // not an estimate used to decide whether to send.
                    final_wire_input_tokens: finalWireEstimate?.refusalTokens ?? 0,
                    final_wire_trusted: finalWireEstimate?.refusalGrade === true,
                },
                geometry: transformGeometry,
                ...renderIdentityFields,
                prevResponseCompletedAtMs:
                    sessionMeta.lastResponseTime > 0 ? sessionMeta.lastResponseTime : undefined,
                requestObservedAtMs,
                channel2NudgeState: String(passInputs.channel2_nudge_state ?? ""),
                emergencyRecoveryArmed: passInputs.emergency_recovery_armed === true,
            });
            logStage(
                sessionId,
                "wireBuild",
                wireBuildStartedAt,
                timings,
                wireDelta ? `mode=tail_delta input=${encodedInput.length}` : "mode=full",
            );
            type TransformSeriesRestart = {
                reason: "attempt_mismatch" | "reconnect";
                pages: number;
                atPage: number;
            };
            type TransformSeriesResult =
                | { response: Record<string, unknown> }
                | { restart: TransformSeriesRestart };
            const sendTransformSeries = async (
                payload: Record<string, unknown>,
                detail = "",
            ): Promise<TransformSeriesResult> => {
                const pagingStartedAt = performance.now();
                // Classify the payload being sent, not the original pass: need_full_sync
                // replaces a cheap tail delta with a potentially large full-array request.
                const fullWire = !isRecord(payload.tail_delta);
                // A one-page content-addressed envelope lets the module replay a completed
                // request when only its response was lost, without executing the transform twice.
                const pages = buildPagedModuleTransformPayloads(
                    payload,
                    options.modulePageMaxBytes,
                    true,
                );
                timings.paging += performance.now() - pagingStartedAt;
                const seedMessageCount = Array.isArray(payload.input)
                    ? payload.input.length
                    : Array.isArray(payload.messages)
                      ? payload.messages.length
                      : 0;
                const paged = pages.some(
                    (entry) => typeof entry.page.transform_page_id === "string",
                );
                let response: Record<string, unknown> | undefined;
                for (const [index, { page, bytes }] of pages.entries()) {
                    const transportStartedAt = performance.now();
                    let moduleResponse: unknown;
                    try {
                        const attemptClass:
                            | "transform_page_upload"
                            | "transform_series_execute"
                            | undefined = paged
                            ? index === pages.length - 1
                                ? "transform_series_execute"
                                : "transform_page_upload"
                            : undefined;
                        const attemptTimeoutMs =
                            options.moduleTimeoutMs ??
                            (attemptClass === "transform_series_execute"
                                ? Math.max(
                                      fullWire
                                          ? transformColdStartExecuteTimeoutMs(seedMessageCount)
                                          : timeoutMs,
                                      protectionFloorCacheBustingPass ||
                                          fullWire ||
                                          passInputs.emergency_recovery_armed === true
                                          ? 45_000
                                          : timeoutMs,
                                  )
                                : attemptClass === "transform_page_upload"
                                  ? TRANSFORM_PAGE_UPLOAD_TIMEOUT_MS
                                  : timeoutMs);
                        const callArgs = {
                            sessionId,
                            projectRoot,
                            method: "transform" as const,
                            body: page,
                            onTimings: (detail: import("./module-transport").ModuleCallTimings) => {
                                for (const key of Object.keys(detail) as (keyof typeof detail)[])
                                    timings.transportDetail[key] += detail[key];
                            },
                            // A reconnect discards a collecting page series. Page zero can be
                            // retried safely, but later pages must make the caller restart it.
                            generationSensitive: paged && index > 0,
                            attemptClass,
                        };
                        moduleResponse = page.transform_page_complete
                            ? await callTransformWithStallProbe(callArgs, attemptTimeoutMs)
                            : await callModule(callArgs, attemptTimeoutMs);
                    } catch (error) {
                        if (paged && isTransformPageAttemptMismatch(error)) {
                            return {
                                restart: {
                                    reason: "attempt_mismatch",
                                    pages: pages.length,
                                    atPage: index,
                                },
                            };
                        }
                        throw error;
                    }
                    if (paged && isModuleTransportGenerationChangedResult(moduleResponse)) {
                        return {
                            restart: { reason: "reconnect", pages: pages.length, atPage: index },
                        };
                    }
                    if (paged && isTransformPageAttemptMismatch(moduleResponse)) {
                        return {
                            restart: {
                                reason: "attempt_mismatch",
                                pages: pages.length,
                                atPage: index,
                            },
                        };
                    }
                    response = responseValue(moduleResponse);
                    timings.transportBytes += bytes;
                    timings.transportPages += 1;
                    logStage(
                        sessionId,
                        "transport",
                        transportStartedAt,
                        timings,
                        `page=${index + 1}/${pages.length}${detail}`,
                    );
                }
                if (!response) throw new Error("rust module returned no transform response");
                return { response };
            };
            let transformSeriesRestarted = false;
            const sendTransformSeriesWithSingleRestart = async (
                payload: Record<string, unknown>,
                detail = "",
            ): Promise<Record<string, unknown>> => {
                let result = await sendTransformSeries(payload, detail);
                if (!("restart" in result)) return result.response;
                if (transformSeriesRestarted) {
                    throw new Error(
                        `rust transform page series restart exhausted: reason=${result.restart.reason}`,
                    );
                }
                transformSeriesRestarted = true;
                sessionLog(
                    sessionId,
                    `transform_series_restart reason=${result.restart.reason} pages=${result.restart.pages} at_page=${result.restart.atPage}`,
                );
                result = await sendTransformSeries(payload, `${detail} restart=series`);
                if ("restart" in result) {
                    throw new Error(
                        `rust transform page series restart exhausted: reason=${result.restart.reason}`,
                    );
                }
                return result.response;
            };
            if (markerAdmissionRecovery) {
                // A failed earlier pass may have moved the marker without completing
                // its request. Rebuild from the host's current retained history. This
                // retry is for that failure; queued marker work alone must not cause a bust.
                const flushed = await options.moduleClient.call({
                    sessionId,
                    projectRoot,
                    method: "session.flush",
                    body: { method: "session.flush", v: 1, session_id: sessionId },
                    timeoutMs: options.moduleTimeoutMs,
                });
                if (!isRecord(flushed) || flushed.ok !== true)
                    throw new RustTransformProtocolError(
                        "rust marker admission recovery: module did not acknowledge rebuilding the new cut",
                    );
            }
            let response = await sendTransformSeriesWithSingleRestart(body);
            let servedFinalWireEstimate:
                | ReturnType<typeof estimateFinalWireInputTokens>
                | undefined;
            captureResponseTelemetry(response);
            const needFullSync = isNeedFullSync(response);
            const nativeContentOmitted = !hasNativeResponseContent(response);
            if (needFullSync || nativeContentOmitted) {
                if (needFullSync) {
                    // A rejected tail delta says only that its base is unavailable; bounded
                    // module caches can evict it without losing the durable session state.
                    // Re-importing that state here would change the next pass's render identity.
                    // The ordinal memo is left intact for the same reason: it maps host-store
                    // rows, which the module's missing delta base says nothing about. Clearing
                    // it here made the retry (or the next pass) re-read every stored row of
                    // the session before dispatch, 57 s on a 124k-row session.
                    sessionLog(
                        sessionId,
                        `need_full_sync retry=full ordinal_memo=kept reason=${
                            typeof response.need_full_sync_reason === "string"
                                ? response.need_full_sync_reason
                                : "unknown"
                        }`,
                    );
                } else {
                    sessionLog(
                        sessionId,
                        "native_delta_fallback_reason=adapter_response_omitted_native_content retry=full",
                    );
                }
                // Retry complete arrays after a missing delta base or malformed native response.
                // Neither result proves that the module lost its durable session state.
                state.forceFullWire = true;
                if (!todoProbeRequired && maySynthesizeTodo) {
                    const todoRetryStartedAt = performance.now();
                    todoProbeRequired = true;
                    timings.todoProbeRequired = 1;
                    timings.todoProbeReason = "full_retry";
                    passInputs.todo_tool_present = await resolveCombinedTodowriteVerdict(
                        deps,
                        sessionId,
                        messages,
                        todoAvailability,
                        timings,
                    );
                    passInputs.todo_verdict_probed = timings.todoProbe > 0;
                    timings.todoVerdict += performance.now() - todoRetryStartedAt;
                    Object.assign(body, {
                        todo_tool_present: passInputs.todo_tool_present,
                        todo_verdict_probed: passInputs.todo_verdict_probed,
                    });
                }
                if (wireDelta) {
                    const retryOrdinalStartedAt = performance.now();
                    let retryResolved = await resolveOrdinalsForModule({
                        sessionId,
                        messages,
                        generation: state.moduleGeneration,
                        memoGeneration: state.idOrdinalMemoGeneration,
                        memo: state.idOrdinalMemo,
                        memoAnchor: state.ordinalMemoAnchor,
                        memoStoredCount: state.ordinalMemoStoredCount,
                        memoCanonicalCount: state.ordinalMemoCanonicalCount,
                        memoCheckpoints: state.ordinalMemoCheckpoints,
                        provisionalBase: state.ordinalContinuationBase ?? undefined,
                        forceProbeForTests: options.disableHotPathIoCachesForTests,
                    });
                    recordOrdinalResolve(
                        sessionId,
                        state,
                        retryOrdinalStartedAt,
                        timings,
                        retryResolved.stats,
                        "retry=full",
                    );
                    if (!retryResolved.ok) {
                        resetOrdinalMemo(state, `retry_mismatch_${retryResolved.reason}`);
                        const retryPrimeStartedAt = performance.now();
                        retryResolved = await resolveOrdinalsForModule({
                            sessionId,
                            messages,
                            generation: state.moduleGeneration,
                            memoGeneration: state.idOrdinalMemoGeneration,
                            memo: state.idOrdinalMemo,
                            memoAnchor: state.ordinalMemoAnchor,
                            memoStoredCount: state.ordinalMemoStoredCount,
                            memoCanonicalCount: state.ordinalMemoCanonicalCount,
                            memoCheckpoints: state.ordinalMemoCheckpoints,
                            forceProbeForTests: options.disableHotPathIoCachesForTests,
                        });
                        recordOrdinalResolve(
                            sessionId,
                            state,
                            retryPrimeStartedAt,
                            timings,
                            retryResolved.stats,
                            "retry=full fallback=clean_full",
                        );
                    }
                    if (!retryResolved.ok) {
                        throw new Error(`rust ordinal ${retryResolved.reason} during full retry`);
                    }
                    state.idOrdinalMemoGeneration = retryResolved.memoGeneration;
                    state.ordinalMemoAnchor = retryResolved.memoAnchor;
                    state.ordinalMemoStoredCount = retryResolved.memoStoredCount;
                    state.ordinalMemoCanonicalCount = retryResolved.memoCanonicalCount;
                    const retryEncodedInput = encodeOpenCodeMessagesToCk(
                        retryResolved.annotatedInput,
                    );
                    timings.wireMessages = messages.length;
                    const retryCkFingerprint = buildWireFingerprint(retryEncodedInput);
                    const retryNativeFingerprint = buildWireFingerprint(messages);
                    const retryRawLast = messages.at(-1);
                    pendingWireCache = {
                        rawCount: messages.length,
                        wireCount: retryEncodedInput.length,
                        rawLastId: retryRawLast ? messageIdOf(retryRawLast) : null,
                        rawLastSignature: retryRawLast ? messageCacheSignature(retryRawLast) : null,
                        rawLastVisible:
                            retryRawLast !== undefined &&
                            retryEncodedInput.some(
                                (entry) => entry.mid === messageIdOf(retryRawLast),
                            ),
                        ckFingerprint: retryCkFingerprint.fingerprint,
                        ckPrefixFingerprintBeforeLast:
                            retryCkFingerprint.prefixFingerprintBeforeLast,
                        nativeFingerprint: retryNativeFingerprint.fingerprint,
                        nativePrefixFingerprintBeforeLast:
                            retryNativeFingerprint.prefixFingerprintBeforeLast,
                        rawContentSnapshots: contentSnapshotsFor(messages),
                        fingerprint: `${retryCkFingerprint.fingerprint}|${retryNativeFingerprint.fingerprint}`,
                    };
                    const retryWireBuildStartedAt = performance.now();
                    body = buildTransformBody({
                        sessionId,
                        input: retryEncodedInput,
                        nativeMessages: messages,
                        toolInputKeyOrders: toolInputKeyOrders(retryEncodedInput),
                        fullArrayFingerprint: pendingWireCache.fingerprint,
                        passInputs,
                        usage: {
                            ...passUsage(usage, contextLimit),
                            final_wire_input_tokens: finalWireEstimate?.refusalTokens ?? 0,
                            final_wire_trusted: finalWireEstimate?.refusalGrade === true,
                        },
                        geometry: transformGeometry,
                        ...renderIdentityFields,
                        prevResponseCompletedAtMs:
                            sessionMeta.lastResponseTime > 0
                                ? sessionMeta.lastResponseTime
                                : undefined,
                        requestObservedAtMs,
                        channel2NudgeState: String(passInputs.channel2_nudge_state ?? ""),
                        emergencyRecoveryArmed: passInputs.emergency_recovery_armed === true,
                    });
                    logStage(
                        sessionId,
                        "wireBuild",
                        retryWireBuildStartedAt,
                        timings,
                        "retry=full",
                    );
                }
                response = await sendTransformSeriesWithSingleRestart(body, " retry=full");
                captureResponseTelemetry(response);
                if (isNeedFullSync(response)) {
                    // The retry was a genuine full send; a second need_full_sync means
                    // the module cannot serve at all. Throwing routes this through the
                    // failure ladder (LKG replay now, park after three) instead of
                    // letting an empty-output response masquerade as a served pass.
                    throw new Error("rust module still requires full sync after a full-array send");
                }
                if (!hasNativeResponseContent(response)) {
                    throw new Error("rust module omitted native content after a full-array retry");
                }
            }
            if (
                response.ok === false ||
                response.isError === true ||
                response.error != null ||
                (response.status !== undefined && response.status !== "ok")
            ) {
                throw new RustTransformProtocolError(
                    "rust transform wire invariant failed: unsuccessful native response cannot permit host mutations",
                );
            }
            const explicitDecision =
                typeof response.decision === "string" && response.decision.length > 0
                    ? response.decision
                    : typeof response.action === "string" && response.action.length > 0
                      ? response.action
                      : undefined;
            if (!explicitDecision) {
                throw new RustTransformProtocolError(
                    "rust transform wire invariant failed: response omitted decision and action",
                );
            }
            const decisionUpper = explicitDecision.toUpperCase();
            const permissionSupported = typeof response.prefix_bust_permitted === "boolean";
            const moduleDecisionBusts = response.prefix_bust_permitted === true;
            if (!permissionSupported) {
                sessionLog(
                    sessionId,
                    "rust prefix-bust permission unsupported: upgrade ck-mc to a build emitting boolean prefix_bust_permitted; holding host first applications",
                );
            }
            if (moduleDecisionBusts && decisionUpper === "SOFT+") {
                throw new RustTransformProtocolError(
                    "rust transform wire invariant failed: SOFT+ cannot permit a prefix bust",
                );
            }
            // Only the producer grants prefix-rebuild authority. A local safety escape
            // may replace the frozen representation, but cannot grant any other edits.
            const cacheBustingPass = moduleDecisionBusts;
            let frozenReplayReleased = false;
            if (markerAdmissionRecovery && !moduleDecisionBusts)
                throw new RustTransformProtocolError(
                    "rust marker admission recovery: supported prefix_bust_permitted=true required; upgrade ck-mc if unsupported",
                );
            // Read the freeze flag before the deferred m0/m1 divergence below can set it, so
            // `passStartedFrozen` records only a freeze an earlier pass entered.
            const passStartedFrozen = state.lkgRepresentationFrozen;
            let frozenReleaseLastServed: FrozenReleaseLastServed = {
                messages: null,
                proven: false,
            };
            if (!todoProbeRequired && cacheBustingPass) {
                timings.todoUnprobedBust += 1;
                sessionLog(
                    sessionId,
                    `todo_permission_probe_miss decision=${decisionUpper} reason=${response.materialize_reason ?? "unknown"} verdict_stale_ok=false`,
                );
            }
            const deferredFirstDivergence = isRecord(response.first_divergence)
                ? response.first_divergence
                : undefined;
            const deferredFrozenPrefixDivergence =
                !cacheBustingPass &&
                [deferredFirstDivergence?.block_id_old, deferredFirstDivergence?.block_id_new].some(
                    (blockId) => blockId === "mc_m0#0" || blockId === "mc_m1#0",
                );
            if (deferredFrozenPrefixDivergence) {
                // The module keeps the fingerprint from its last served response until an
                // explicit cache invalidation. Freeze the host representation as well, so losing
                // the process-local cache cannot change m0/m1 during either the first or a later
                // deferred pass after restart.
                state.lkgRepresentationFrozen = true;
                state.forceFullWire = true;
                sessionLog(sessionId, "deferred frozen-prefix divergence; replaying LKG");
            }
            const materializedBoundary = materializedCompactionBoundary(
                response,
                moduleDecisionBusts,
            );
            let thinkingBindingRecovery: ThinkingBindingRecoveryApplication | null = null;
            let frozenHealthyPassesAfterApply: number | null = null;
            let frozenReleaseReason: string | null = null;
            const applyStartedAt = performance.now();
            try {
                // Validate and postprocess the module result before touching the caller-owned
                // array. This keeps failure recovery O(1) on the steady path: no defensive
                // full-array clone is needed just in case boundary validation rejects it.
                const moduleMessages = applyNativeMessagesVerbatim(
                    { messages: [] },
                    response,
                    previousWireCache?.nativeOutput
                        ? {
                              messages: previousWireCache.nativeOutput,
                              fingerprint: previousWireCache.fingerprint,
                          }
                        : undefined,
                );
                let appliedMessages = moduleMessages;
                let markerStrategyFailure: Error | undefined;
                let replayedFrozenRepresentation = false;
                const boundaryId = response.boundary_id;
                if (typeof boundaryId === "string" && boundaryId.length > 0) {
                    // An invalid Rust m[0] must not move the host marker. Check its
                    // synthetic-message shape and session before postprocess writes.
                    assertNativeBoundary(moduleMessages, sessionId, boundaryId);
                }
                const markerCandidate =
                    moduleDecisionBusts &&
                    !deps.compactionOff &&
                    !sessionMeta.isSubagent &&
                    (materializedBoundary !== undefined ||
                        getPendingCompactionMarkerState(deps.db, sessionId) !== null);
                let markerAdmissionProven = true;
                if (markerCandidate) {
                    const ids = messages.map((message) => message.info.id);
                    const coherentInputs =
                        ids.length > 0 &&
                        ids.every((id) => typeof id === "string") &&
                        new Set(ids).size === ids.length &&
                        pendingWireCache.rawContentSnapshots.length === ids.length;
                    const measure = measureOutputAgainstLimit(moduleMessages, contextLimit);
                    markerAdmissionProven = coherentInputs && measure.fit === "under";
                    if (!markerAdmissionProven) {
                        // A host cut is optional. Retain its pending target and serve the
                        // fresh engine output when local fit/capture proof is unavailable.
                        // Only a fault after a possible cut may fence this representation.
                        sessionLog(
                            sessionId,
                            `rust compaction-marker admission deferred: reason=${coherentInputs ? "output_fit" : "capture_inputs"} fit=${measure.fit} ` +
                                `estimated=${measure.tokens ?? "unavailable"} trusted=${measure.trusted} ` +
                                `proxy_tokens=${measure.proxy ? Math.ceil(measure.proxy.bytes / RAW_FALLBACK_BYTES_PER_CONTEXT_TOKEN) : "unavailable"} ` +
                                `proxy_bytes=${measure.proxy?.bytes ?? "unavailable"} limit=${contextLimit}`,
                        );
                    }
                }
                // The slot a previous process captured from a frozen serve, when this is
                // this process's first applied pass and that pass is a module bust: the
                // bust replaces messages the provider last saw raw, so the thinking strip
                // needs that array exactly as a bust of a freeze in this process would.
                let coldStartLastServed: FrozenReleaseLastServed | null = null;
                if (state.lkgColdStartCheckPending) {
                    state.lkgColdStartCheckPending = false;
                    const coldStart =
                        !state.lkgRepresentationFrozen && state.lkgAcceptedCapture === undefined
                            ? detectColdStartFrozenSlot(
                                  sessionId,
                                  messages,
                                  moduleMessages,
                                  model?.providerID,
                              )
                            : null;
                    if (coldStart?.kind === "uncaptured_replay") {
                        // The module now renders differently a message the previous
                        // process's uncaptured replay served raw. Nothing proves the
                        // reconstructed array is exact, so it is unproven: the strip
                        // starts at its first change or at its end.
                        coldStartLastServed = { messages: coldStart.lastServed, proven: false };
                        sessionLog(
                            sessionId,
                            `lkg_cold_start_uncaptured_replay raw_user_index=${coldStart.rawUserIndex}`,
                        );
                    } else if (coldStart && !cacheBustingPass) {
                        state.lkgRepresentationFrozen = true;
                        state.forceFullWire = true;
                        // Count raw tail growth from the first message the freeze served
                        // raw, not from this pass, so restart does not hide recovery debt.
                        // That start may precede the original freeze's ingress count.
                        state.lkgFrozenAtInputCount =
                            coldStart.rawRunStart >= 0 ? coldStart.rawRunStart : inputCount;
                        sessionLog(
                            sessionId,
                            `lkg_cold_start_frozen_slot_resumed raw_served_index=${coldStart.index}`,
                        );
                    } else if (coldStart) {
                        // Nothing in this process proves the slot is the very last array
                        // served (an uncaptured replay may have followed), so it is
                        // unproven: the strip covers the first change or the slot's end.
                        coldStartLastServed = { messages: coldStart.slotMessages, proven: false };
                        sessionLog(
                            sessionId,
                            `lkg_cold_start_frozen_slot_busted raw_served_index=${coldStart.index}`,
                        );
                    }
                }
                // While frozen, the last-known-good slot holds the array the last pass served
                // (or its prefix). Read it before any replay, because a replay that fails
                // validation drops the slot, and also on a module-busting pass: that bust
                // replaces messages the freeze served raw, and the thinking strip in
                // postprocess compares against this array to find the first changed message.
                const lastServedSlot = state.lkgRepresentationFrozen
                    ? getSlot(sessionId)
                    : undefined;
                const lastServedSnapshot = (): FrozenReleaseLastServed => ({
                    messages: parseLastServedSnapshot(lastServedSlot?.jsonPrefix),
                    proven:
                        lastServedSlot !== undefined &&
                        lastServedCaptureSequence !== null &&
                        lastServedSlot.captureSequence === lastServedCaptureSequence,
                });
                if (passStartedFrozen && cacheBustingPass) {
                    frozenReleaseLastServed = lastServedSnapshot();
                } else if (coldStartLastServed) {
                    frozenReleaseLastServed = coldStartLastServed;
                }
                if (
                    state.lkgRepresentationFrozen &&
                    !shouldAdoptModuleAfterFreeze(moduleDecisionBusts, frozenReplayReleased)
                ) {
                    if (state.lkgFrozenAtInputCount === null) {
                        state.lkgFrozenAtInputCount = inputCount;
                    }
                    const keys = resolveLkgModelKeys(messages);
                    const frozen = replayLkg({
                        sessionId,
                        messages,
                        modelKey: keys.modelKey,
                        providerKey: keys.providerKey,
                        // The stored prefix already carries the binding-mismatch strips;
                        // the replayed tail comes from the raw input, so apply the
                        // persisted set there too, before validation, so the array that
                        // is validated is the array that is served. A removed thinking
                        // block must not return on a replayed pass.
                        prepareReplay: (replayed) =>
                            replayRustModeBindingMismatchStrips({
                                db: deps.db,
                                sessionId,
                                messages: replayed,
                                resolvedProviderID: model?.providerID,
                            }),
                    });
                    if (!frozen.ok) {
                        frozenReplayReleased = true;
                        frozenReleaseReason = frozen.reason;
                        frozenReleaseLastServed = lastServedSnapshot();
                    } else {
                        frozenHealthyPassesAfterApply = state.lkgFrozenHealthyPasses + 1;
                        const rawTailGrowth = Math.max(0, inputCount - state.lkgFrozenAtInputCount);
                        const releaseReason = frozenReplayAdmission(
                            frozen.messages,
                            moduleMessages,
                        );
                        if (releaseReason) {
                            frozenReplayReleased = true;
                            frozenReleaseReason = releaseReason;
                            frozenReleaseLastServed = lastServedSnapshot();
                        } else {
                            appliedMessages = frozen.messages;
                            replayedFrozenRepresentation = true;
                            servedFrom = "lkg_frozen";
                            sessionLog(sessionId, "lkg_frozen_replay_served");
                            sessionLog(
                                sessionId,
                                `lkg_frozen_replay_debt healthy_passes=${frozenHealthyPassesAfterApply} raw_messages=${rawTailGrowth}`,
                            );
                        }
                    }
                }
                if (!replayedFrozenRepresentation) {
                    const outputCloneStartedAt = performance.now();
                    appliedMessages = cloneModuleNativeOutput(moduleMessages);
                    timings.outputClone += performance.now() - outputCloneStartedAt;
                }
                // Delta offsets count the module's array, before host marker insertion or
                // reasoning recovery. Keep that basis unmodified, including nested parts;
                // a postprocessed prefix can silently discard a message at the next splice.
                pendingWireCache.nativeOutput = moduleMessages;
                // LKG captures postprocessed output, so running postprocess again would stop the
                // fallback artifact from being an exact replay.
                if (!replayedFrozenRepresentation) {
                    if (materializedBoundary && !deps.compactionOff) {
                        try {
                            await withAsyncPrivilegedWriter(deps.db, () => undefined);
                        } catch (error) {
                            // Postprocess can still serve a safe SOFT replay when its
                            // optional host-store marker cannot acquire the writer.
                            if (!isTransientSqliteError(error)) throw error;
                        }
                    }
                    const protectedThinkingMessages = latestAssistantTurnMessages(
                        appliedMessages as MessageLike[],
                    );
                    const activeThinkingTurn =
                        inputHasActiveThinking &&
                        isAnthropicFamilyRoute(model?.providerID, model?.modelID);
                    const postprocess = runRustModePostprocess({
                        activeThinkingTurn,
                        protectedThinkingMessages: thinkingRecovery.restore
                            ? protectedThinkingMessages
                            : undefined,
                        restoreLatestTurnOriginals: () =>
                            restoreLatestTurnOriginals?.(appliedMessages as MessageLike[]),
                        db: deps.db,
                        sessionId,
                        messages: appliedMessages as MessageLike[],
                        projectPath: memoryProjectPath,
                        sessionDirectory: directory,
                        materializedBoundary,
                        consumedBoundary: servedCompactionBoundary(response),
                        markerAdmissionProven,
                        beforeMarkerApply: () => {
                            if (!markerAdmissionRecovery) markerSafeSnapshot = getSlot(sessionId);
                            markerOriginalMessages = messages.slice();
                            markerApplyAttempted = true;
                            state.lastPassMarkerApplyAttempted = true;
                            fenceMarkerAdmission(sessionId, state, true);
                        },
                        afterMarkerApply: (outcome) => {
                            // An unchanged marker now does not undo an earlier possible move.
                            // Keep the old saved request blocked until recovery finishes.
                            markerDefinitelyNoCut =
                                !markerAdmissionRecovery &&
                                markerUpdateDefinitelyDidNotCut(outcome);
                            if (markerDefinitelyNoCut) {
                                state.lastPassMarkerApplyAttempted = false;
                            } else {
                                markerSafeSnapshot = undefined;
                                fenceMarkerAdmission(sessionId, state);
                                if (outcome.kind === "retryable-failure") {
                                    markerStrategyFailure = outcome.error;
                                }
                            }
                        },
                        compactionMarkerStrategy: deps.compactionMarkerStrategy,
                        fullFeatureMode: !sessionMeta.isSubagent,
                        compactionOff: deps.compactionOff,
                        resolvedProviderID: model?.providerID,
                        thinkingBindingRecoveryEnabledForModel: isPrefixBoundThinkingModel(
                            model?.providerID,
                            model?.modelID,
                        ),
                        cacheBustingPass: moduleDecisionBusts,
                        prefixPermissionSupported: permissionSupported,
                        moduleReasoningTrimOnly: response.reasoning_trim_only === true,
                        // A frozen session hands the strip gate the last-served array on
                        // every pass that reaches postprocess. That includes a module bust
                        // whose own edit only trims the oldest reasoning: it still replaces
                        // the raw tail the freeze served with tagged module output, and a
                        // signed thinking block is valid only while every byte before it is
                        // unchanged, so thinking after the first changed message must be
                        // stripped.
                        ...(permissionSupported &&
                        (passStartedFrozen || frozenReleaseReason || coldStartLastServed)
                            ? { frozenReleaseLastServed }
                            : {}),
                        trailingBlankSourceDecisions,
                        trailingBlankNewestAssistantId:
                            typeof trailingBlankNewestAssistantId === "string"
                                ? trailingBlankNewestAssistantId
                                : undefined,
                        tagger: deps.tagger,
                        ctxReduceAvailability: reduceAvailability,
                    });
                    thinkingBindingRecovery = postprocess.thinkingBindingRecovery;
                    markerAt = postprocess.markerAt;
                    // A possibly committed host write with unfinished mirror/CAS
                    // work is not an admitted cut, even if fresh native output fits.
                    // Keep the durable fence until a supported recovery repairs it.
                    if (markerStrategyFailure) throw markerStrategyFailure;
                }
                if (typeof boundaryId === "string" && boundaryId.length > 0) {
                    assertNativeBoundary(appliedMessages, sessionId, boundaryId);
                }
                if (
                    (markerApplyAttempted || markerAdmissionRecovery) &&
                    measureAgainstLimit(appliedMessages, contextLimit) !== "under"
                ) {
                    // Host canonicalization can add reminders/summary bytes. A
                    // final fit failure after the cut is a refusal, never an
                    // excuse to serve the previous representation.
                    throw new RustTransformProtocolError(
                        "rust marker rebuilding request failed final output admission",
                    );
                }
                if (!sessionMeta.isSubagent) {
                    mirrorRustSyntheticTodoAnchor({
                        db: deps.db,
                        sessionId,
                        messages: appliedMessages,
                        cacheBustingPass: moduleDecisionBusts,
                    });
                }
                if (
                    passInputs.emergency_recovery_armed === true ||
                    cacheBustingPass ||
                    response.scheduler_decision === "execute"
                ) {
                    servedFinalWireEstimate = finalWireUsage.estimate(
                        sessionId,
                        {
                            messages: appliedMessages as MessageLike[],
                            systemPromptTokens: sessionMeta.systemPromptTokens,
                            providerID: model?.providerID,
                            modelID: model?.modelID,
                            agentName: deps.getNotificationParams?.(sessionId)?.agent,
                            systemPromptHash: sessionMeta.systemPromptHash,
                        },
                        resolvedWindowGeometry?.usableHard ?? resolvedContextLimit,
                    );
                    const refusal = outgoingContextRefusal(
                        servedFinalWireEstimate,
                        resolvedWindowGeometry?.usableHard ?? resolvedContextLimit,
                        protectedToolTokenCount(
                            getActiveTagsBySession(deps.db, sessionId),
                            deps.protectedTools,
                            resolveDecisionCalibration(model?.providerID, model?.modelID),
                        ),
                    );
                    if (refusal) {
                        // A priced module replacement invalidates its prior durable
                        // snapshot even when final admission refuses before installation.
                        if (cacheBustingPass) {
                            dropSlot(
                                sessionId,
                                "lkg_over_limit_replacement",
                                deps.compactionOff !== true,
                            );
                            state.lkgAcceptedCapture = undefined;
                        }
                        const error = contextRefusalError(refusal);
                        // The module returned an unservable array, not a typed
                        // native refusal. Repeated invalid outputs must park it.
                        markFailure(sessionId, state, error);
                        throw error;
                    }
                }
                logStage(sessionId, "apply", applyStartedAt, timings);
                // output.messages commonly aliases the raw input array, so preserve the entry ids
                // before installation replaces that array with native output.
                const lkgInputIds = messages.map((message) => message.info.id);
                const lkgInputKeys = resolveLkgModelKeys(messages);
                const applyReplaceStartedAt = performance.now();
                installNativeMessages(output, appliedMessages);
                logStage(sessionId, "apply", applyReplaceStartedAt, timings);
                if (thinkingBindingRecovery) {
                    const cleared = clearThinkingBindingRecoveryIf(
                        deps.db,
                        sessionId,
                        thinkingBindingRecovery.flagTarget,
                    );
                    sessionLog(
                        sessionId,
                        `rust thinking binding recovery: stripped bound reasoning from ${thinkingBindingRecovery.messageIds.length} assistant(s) [${thinkingBindingRecovery.messageIds.join(",")}]; flag=${cleared ? "cleared" : "rearmed"}`,
                    );
                }

                const lkgSnapshotStartedAt = performance.now();
                // An old producer cannot certify replay stability. Persist the installed
                // representation synchronously without granting host mutation authority.
                const synchronousReplacement =
                    shouldAdoptModuleAfterFreeze(moduleDecisionBusts, frozenReplayReleased) ||
                    !permissionSupported;
                // A cache-busting replacement invalidates the previous snapshot only after the
                // replacement is installed. If installation fails, the prior LKG remains available
                // and its replay still applies durable binding-mismatch strips.
                if (synchronousReplacement && !markerDefinitelyNoCut) {
                    dropSlot(
                        sessionId,
                        "lkg_cache_bust_pending_capture",
                        deps.compactionOff !== true,
                    );
                    state.lkgAcceptedCapture = undefined;
                }
                // Build the capture from the installed array. Rebuilds and local safety
                // replacements commit before returning, so a restart cannot resurrect the
                // prior representation. Ordinary frozen refreshes remain asynchronous.
                const capturePlan = prepareRustCapture(
                    state,
                    sessionId,
                    lkgInputIds,
                    lkgInputKeys,
                    pendingWireCache.rawContentSnapshots,
                    output.messages,
                    rowVersion,
                    sessionMeta.systemPromptTokens,
                );
                let captureMode = "async";
                if (capturePlan) state.lkgLastServedCaptureSequence = capturePlan.captureSequence;
                const captureFailed = (mode: "async" | "sync", error: unknown): void => {
                    if (
                        states.get(sessionId) !== state ||
                        (capturePlan && capturePlan.captureSequence !== state.lkgCaptureSequence)
                    ) {
                        return;
                    }
                    if (!markerDefinitelyNoCut)
                        dropSlot(
                            sessionId,
                            `lkg_${mode}_capture_failed`,
                            deps.compactionOff !== true,
                        );
                    state.lkgAcceptedCapture = undefined;
                    state.lkgSyncCaptureRequired = true;
                    sessionLog(
                        sessionId,
                        `LKG ${mode.toUpperCase()} CAPTURE FAILED; forcing synchronous capture on the next applied pass:`,
                        error,
                    );
                };
                if (!capturePlan) {
                    captureMode = "declined";
                    const error = new Error("LKG snapshot preparation was rejected");
                    captureFailed("async", error);
                    if (synchronousReplacement) throw error;
                } else if (synchronousReplacement || state.lkgSyncCaptureRequired) {
                    captureMode = synchronousReplacement ? "sync_priced" : "sync_recovery";
                    try {
                        commitRustCapture(state, capturePlan, synchronousReplacement);
                    } catch (error) {
                        captureFailed("sync", error);
                        if (synchronousReplacement) throw error;
                    }
                } else {
                    try {
                        scheduleLkgCapture(() => {
                            const asyncStartedAt = performance.now();
                            try {
                                const result = commitRustCapture(state, capturePlan);
                                logTransformTiming(
                                    sessionId,
                                    "rust.lkg_snapshot_async",
                                    asyncStartedAt,
                                    `result=${result} row_version=${capturePlan.rowVersion}`,
                                );
                            } catch (error) {
                                captureFailed("async", error);
                            }
                        });
                    } catch (error) {
                        captureMode = "schedule_failed";
                        captureFailed("async", error);
                    }
                }
                logStage(
                    sessionId,
                    "lkgSnapshot",
                    lkgSnapshotStartedAt,
                    timings,
                    `mode=${captureMode} row_version=${rowVersion}`,
                );
            } catch (error) {
                logStage(sessionId, "apply", applyStartedAt, timings, "failed=true");
                throw error;
            }
            const bookkeepingStartedAt = performance.now();
            if (shouldAdoptModuleAfterFreeze(moduleDecisionBusts, frozenReplayReleased)) {
                if (frozenReleaseReason) {
                    sessionLog(
                        sessionId,
                        `lkg_frozen_replay_released reason=${frozenReleaseReason}`,
                    );
                }
                state.lkgRepresentationFrozen = false;
                state.lkgFrozenHealthyPasses = 0;
                state.lkgFrozenAtInputCount = null;
            } else if (frozenHealthyPassesAfterApply !== null) {
                state.lkgFrozenHealthyPasses = frozenHealthyPassesAfterApply;
            }
            try {
                mirrorRustRenderedMemoryIds({ db: deps.db, sessionId, response });
            } catch (error) {
                sessionLog(sessionId, "rust rendered-memory mirror write failed (ignored):", error);
            }
            try {
                armNoteNudgeOnRustPublish({
                    db: deps.db,
                    sessionId,
                    state,
                    boundary: materializedBoundary,
                    persistedBoundaryOrdinal,
                });
            } catch (error) {
                // The module output is already installed for this pass, so a failure while
                // recording the nudge must not fail the pass; a later publish arms it again.
                sessionLog(sessionId, "rust note-nudge arm after publish failed (ignored):", error);
            }
            const ordinalContinuationBase = response.ordinal_continuation_base;
            if (
                typeof ordinalContinuationBase === "number" &&
                Number.isSafeInteger(ordinalContinuationBase) &&
                ordinalContinuationBase > 0
            ) {
                if (state.ordinalContinuationBase === null) {
                    for (const [messageId, ordinal] of state.idOrdinalMemo) {
                        state.idOrdinalMemo.set(messageId, ordinal + ordinalContinuationBase);
                    }
                    state.ordinalMemoCanonicalCount += ordinalContinuationBase;
                    // Checkpoints must stay in the memo's numbering, or a later rewind
                    // would resume from an unshifted count.
                    for (const checkpoint of state.ordinalMemoCheckpoints) {
                        checkpoint.canonicalCount += ordinalContinuationBase;
                    }
                }
                state.ordinalContinuationBase = ordinalContinuationBase;
            }
            if (!stateSyncRetryBusy) {
                state.initialized = true;
                state.seedPassPending = false;
            }
            state.consecutiveFailures = 0;
            state.parked = false;
            state.passesSincePark = 0;
            state.warningSent = false;
            // Input and output acknowledgements describe the module's native arrays,
            // not the provider-visible LKG replay. The separately retained nativeOutput
            // is the splice basis even while frozen, so a successful pass can resume
            // deltas without granting permission to adopt or edit the frozen bytes.
            state.forceFullWire = false;

            const directiveText = directiveTextOf(response);
            if (syntheticTurn) {
                // A pending lease must not escape the breaker through the terminal
                // event handler while synthetic turns are cascading.
                try {
                    casChannel2NudgeState(deps.db, sessionId, "pending", "");
                    deps.channel2DirectiveTextBySession?.delete(sessionId);
                } catch {
                    // The delivery lease remains authoritative if another sender owns it.
                }
            } else if (directiveText) {
                // The module only recommends Channel 2 here. Delivery must wait for the
                // terminal message.updated boundary, where the host's shared claim/CAS
                // path revalidates the lease and coalesces the synthetic user turn.
                try {
                    casChannel2NudgeState(deps.db, sessionId, "", "pending");
                    deps.channel2DirectiveTextBySession?.set(sessionId, directiveText);
                } catch (error) {
                    sessionLog(
                        sessionId,
                        "rust channel2 pending-intent CAS failed (ignored):",
                        error,
                    );
                }
            }
            // Provider overflow proves the prior wire failed, so successful local
            // materialization is not enough to clear recovery. Require either provider
            // usage observed after the arm or a trusted estimate of the bytes actually
            // returned by the module; persisted percentages can outlive failed requests.
            const currentOverflowState = getOverflowState(deps.db, sessionId, modelKey);
            const disarmEvidence = currentOverflowState.needsEmergencyRecovery
                ? shouldDisarmRustEmergencyRecovery({
                      materialized: materializeReason !== "none",
                      usagePercentage: passUsageSnapshot.percentage,
                      recoveryOrigin: currentOverflowState.emergencyRecoveryOrigin,
                      recoveryArmedAt: getEmergencyRecoveryArmedAt(sessionId),
                      usageEntry: deps.contextUsageMap.get(sessionId),
                      finalWireEstimate: servedFinalWireEstimate,
                      providerProvenLimitTokens: currentOverflowState.detectedContextLimit,
                  })
                : null;
            if (disarmEvidence) {
                try {
                    clearEmergencyRecovery(deps.db, sessionId);
                    sessionLog(
                        sessionId,
                        `rust pass disarmed emergency recovery via ${disarmEvidence} after ${materializeReason} at ${passUsageSnapshot.percentage.toFixed(1)}% usage`,
                    );
                } catch {
                    // Best-effort: a later pass with current recovery evidence retries the clear.
                }
            }
            if (timings.todoProbe > 0) {
                state.todoProbeIdentity = todoProbeIdentity;
                state.todoBustIdentity = todoBustIdentity;
            }
            state.todoProbeNextPass =
                response.reconcile_pending === true ||
                (isRecord(response.historian) && response.historian.fired === true);
            state.lastAppliedAtMs = requestObservedAtMs;
            heapHolder.wireCaches.set(sessionId, pendingWireCache);
            timings.bookkeeping += performance.now() - bookkeepingStartedAt - timings.delivery;
            appliedAt = performance.now();
            // The module writes compartments straight into context.db, so the TS
            // compartment writers that re-arm the once-per-session auto-embed latch
            // never run for them. A module publish moves row_version, the boundary or
            // the coverage ordinal, so only a changed key pays for the compartment
            // query that decides whether to re-arm; stable passes read nothing.
            const compartmentKey = moduleCompartmentProjectionKey(response);
            const compartmentCheckDue =
                compartmentKey === null || state.autoEmbedCompartmentKey !== compartmentKey;
            state.autoEmbedCompartmentKey = compartmentKey ?? undefined;
            // Embedding work is background maintenance, not a foreground transform writer.
            void withoutSqliteTransformPass(async () => {
                if (compartmentCheckDue) {
                    const compartmentRow = deps.db
                        .prepare(
                            "SELECT COALESCE(MAX(sequence), -1) AS max_sequence, COUNT(*) AS count FROM compartments WHERE session_id = ?",
                        )
                        .get(sessionId) as { max_sequence?: number; count?: number } | undefined;
                    const compartmentMark = `${compartmentRow?.max_sequence ?? -1}:${compartmentRow?.count ?? 0}`;
                    if (
                        state.autoEmbedCompartmentMark !== undefined &&
                        state.autoEmbedCompartmentMark !== compartmentMark
                    ) {
                        invalidateAutoEmbedSession(sessionId);
                    }
                    state.autoEmbedCompartmentMark = compartmentMark;
                }
                await withSqliteBackgroundWriter(() =>
                    drainSingleStoreEmbeddingWatermarks(deps.db),
                );
            }).catch((error) => {
                sessionLog(sessionId, "single-store embedding drain failed (ignored):", error);
            });
            finalWireUsage.capture(sessionId, {
                messages: output.messages as MessageLike[],
                systemPromptTokens: sessionMeta.systemPromptTokens,
                providerID: model?.providerID,
                modelID: model?.modelID,
                agentName: deps.getNotificationParams?.(sessionId)?.agent,
                systemPromptHash: sessionMeta.systemPromptHash,
            });
            captureOpencodeReasoningBudgetStatus(
                sessionId,
                output.messages as MessageLike[],
                resolveKeepReasoningTokens(deps.keepReasoningTokens, modelKey ?? undefined),
                isPrefixBoundThinkingModel(model?.providerID, model?.modelID),
            );
            finishPass(true);
            // Validation, message replacement, synchronous LKG persistence and
            // bookkeeping have finished. Clear the persisted replay block last; if
            // this write fails, a restarted process must rebuild instead of replaying.
            if (state.markerAdmissionFenced) {
                setRustMarkerAdmissionFence(deps.db, sessionId, false);
                state.markerAdmissionFenced = false;
            }
        } catch (error) {
            if (markerDefinitelyNoCut) {
                try {
                    // A snapshot write can finish before later bookkeeping fails, even
                    // when the host marker stayed unchanged. Restore the previous saved
                    // request in storage before allowing it to be replayed.
                    deps.db
                        .transaction(() => {
                            if (markerSafeSnapshot) {
                                markerSafeSnapshot = {
                                    ...markerSafeSnapshot,
                                    servedCaptureId: deps.compactionOff
                                        ? undefined
                                        : recordServedCapture(deps.db, sessionId, true),
                                };
                                if (!saveLkgSlotToDb(deps.db, sessionId, markerSafeSnapshot))
                                    throw new Error("could not restore the unchanged-boundary LKG");
                            } else {
                                clearPersistedLkgSlotStrict(deps.db, sessionId);
                            }
                            setRustMarkerAdmissionFence(deps.db, sessionId, false);
                        })
                        .immediate();
                    // Remove this failed pass's in-memory snapshot before restoring the
                    // older safe request. Ordinary captures still reject older row versions
                    // so delayed writes cannot overwrite newer snapshots.
                    forgetInMemorySlot(sessionId);
                    if (markerSafeSnapshot && !captureSlot(sessionId, markerSafeSnapshot))
                        throw new Error("could not restore the unchanged-boundary LKG in memory");
                    if (!markerSafeSnapshot)
                        dropSlot(
                            sessionId,
                            "unchanged_boundary_without_prior_lkg",
                            deps.compactionOff !== true,
                        );
                    state.markerAdmissionFenced = false;
                    state.lkgAcceptedCapture = undefined;
                    state.lkgSyncCaptureRequired = true;
                    markerApplyAttempted = false;
                    if (markerOriginalMessages)
                        replaceMessagesInPlace(output, markerOriginalMessages);
                } catch (restoreError) {
                    sessionLog(
                        sessionId,
                        "unchanged-boundary LKG restoration failed; refusing:",
                        restoreError,
                    );
                }
            }
            if (markerApplyAttempted || markerAdmissionRecovery || state.markerAdmissionFenced) {
                // The host marker writer may throw after committing its change.
                // Without proof that the marker stayed unchanged, keep the previous
                // saved request unavailable, including after a restart.
                try {
                    fenceMarkerAdmission(sessionId, state);
                } catch {
                    // Failure to save the replay-blocking flag must not allow a send.
                }
                state.markerAdmissionFenced = true;
                state.forceFullWire = true;
                state.parked = false;
                servedFrom = "refused";
                decision = "error";
                materializeReason = "marker_admission_failed";
                // The host marker may have committed before saving its context.db copy
                // failed. Neither the previous LKG nor this pass's original raw input
                // is then known to match the host's next history boundary.
                try {
                    finishPass(false, false);
                } catch {
                    /* refusal must survive diagnostic/storage failures */
                }
                throw new EmergencyFailClosedError(
                    "Magic Context could not safely admit a history-boundary rebuild. This turn was not sent; retry to recompose from the current boundary.",
                    { cause: error },
                );
            }
            if (error instanceof FrozenReplayOverProvenLimitRefusal) {
                decision = "error";
                materializeReason = "frozen_over_proven_limit";
                sessionLog(
                    sessionId,
                    `mc_rust_emergency_refusal frozen_over_proven_limit module=${error.moduleFit} limit=${error.limit}`,
                );
                finishPass(false, false);
                // The module is healthy, so "reconnecting" would be wrong. The freeze
                // stays (the provider still holds the frozen bytes) and ends on the
                // first pass whose module output fits (a release) or that the module
                // busts, which /ctx-flush requests.
                throw new EmergencyFailClosedError(
                    renderUserFacingFailure("frozen_history_over_window", "plain"),
                    { cause: error },
                );
            }
            if (error instanceof SharedCompartmentBoundaryError) {
                decision = "error";
                materializeReason = error.code;
                finishPass(false, false);
                throw new EmergencyFailClosedError(error.message, { cause: error });
            }
            const migration = singleStoreMigrationRequiredFailure(error);
            const protectedRefusal = protectedToolRefusal(error);
            if (protectedRefusal || error instanceof EmergencyFailClosedError) {
                decision = "error";
                servedFrom = "refused";
                finishPass(false, false);
                throw protectedRefusal ?? error;
            }
            if (migration) {
                decision = "error";
                materializeReason = migration.code;
                sessionLog(sessionId, `mc_rust_single_store_refusal reason=${migration.code}`);
                finishPass(false, false);
                throw new EmergencyFailClosedError(migration.message, { cause: migration });
            }
            const storeAhead = storeAheadOfBinaryFailure(error);
            if (storeAhead) {
                // The module refuses every request until ck-mc is updated or both databases
                // are restored from one backup. Replaying the last-known-good answer or the raw
                // prompt would keep the session running without memory, notes or compression
                // while the user is never told why. Parking would stop calling the module and
                // show only the reconnecting notice. So this turn fails visibly with the reason
                // and the fix, and the next turn asks the module again.
                decision = "error";
                materializeReason = STORE_AHEAD_OF_BINARY_CODE;
                sessionLog(
                    sessionId,
                    `mc_rust_store_ahead_refusal db_version=${storeAhead.versions?.dbVersion ?? "unknown"} binary_max=${storeAhead.versions?.binaryMax ?? "unknown"}`,
                );
                finishPass(false, false);
                throw new EmergencyFailClosedError(storeAhead.message, { cause: storeAhead });
            }
            if (
                error instanceof Error &&
                error.message.startsWith("rust transform wire invariant failed")
            ) {
                sessionLog(
                    sessionId,
                    "rust transform wire invariant failed; LKG replay required",
                    error,
                );
            }
            if (emergencyFailClosed) {
                if (!deps.compactionOff && isTransientSqliteError(error)) {
                    finishPass(false, false);
                    throw new StorageBusyRefusalError(error, "rust-mode-emergency");
                }
                // At 95% of a trusted limit, or while provider overflow recovery is armed,
                // any adapter failure aborts. Parking controls retry cadence, not fallback admission.
                sessionLog(sessionId, "mc_rust_emergency_refusal before_lkg");
                markFailure(sessionId, state, error);
                finishPass(false, false);
                const refusedUser = newestUserMessage(messages);
                const refusedUserMessageId = refusedUser ? messageIdOf(refusedUser) : null;
                if (refusedUserMessageId) {
                    try {
                        options.onEngineReconnectRefusal?.({
                            sessionId,
                            projectRoot: recoveryProjectRoot,
                            refusedUserMessageId,
                            providerProvenEmergency,
                            compactionOff: deps.compactionOff === true,
                        });
                    } catch (recoveryError) {
                        sessionLog(
                            sessionId,
                            "rust refusal recovery failed to arm:",
                            recoveryError,
                        );
                    }
                }
                throw new EmergencyFailClosedError(ENGINE_RECONNECTING_USER_MESSAGE, {
                    cause: error,
                });
            }
            // Validation happens before the caller-owned array is replaced, so the
            // original live array is still available for fail-open replay.
            const replayed = replayLastGood(
                sessionId,
                messages,
                output,
                sessionMeta.systemPromptTokens,
            );
            // A served replay entered the freeze inside replayLastGood. One that cannot
            // serve leaves the freeze alone: either the raw fallback below serves the raw
            // input and clears it, or the pass refuses and the provider still holds the
            // frozen bytes the next pass must keep serving.
            servedFrom = replayed ? "lkg" : "raw";
            if (decision.toLowerCase() !== "need_full_sync") decision = "error";
            materializeReason = moduleFailureCode(error) ?? "none";
            markFailure(sessionId, state, error);
            if (!replayed) {
                try {
                    serveRawFallback(error);
                } catch (rawFallbackError) {
                    finishPass(false, false);
                    throw rawFallbackError;
                }
            }
            finishPass(false);
            return;
        }
    };

    const adapter = {
        run: async (
            sessionId: string,
            messages: MessageLike[],
            output: { messages: unknown[] },
            sessionMeta: ReturnType<typeof getOrCreateSessionMeta>,
        ): Promise<void> => {
            try {
                await withSqliteTransformPass(() => run(sessionId, messages, output, sessionMeta));
            } finally {
                // The pass is the loop's clock. A run can only be queued by a pass, so
                // looking right after one is when there is most likely something to
                // take. Never awaited: the fold the loop picks up takes minutes and the
                // response this pass just built is already correct without it.
                try {
                    void withoutSqliteTransformPass(() => resolveHostRunner()?.pump(sessionId));
                } catch (error) {
                    // Failure to start background summarization must not reject the request
                    // already validated and saved for the host's current history.
                    sessionLog(sessionId, "rust host runner launch failed (ignored):", error);
                }
            }
        },
        async clearSession(sessionId: string): Promise<void> {
            const projectRoot =
                states.get(sessionId)?.recordedSessionDirectory ?? options.projectRoot ?? null;
            const clearLocalState = () => {
                dropSlot(sessionId, "session-deleted", deps.compactionOff !== true);
                states.delete(sessionId);
                passStampBySession.delete(sessionId);
                heapHolder.wireCaches.delete(sessionId);
                promptSurfaceGuidanceEpochs?.clear(sessionId);
            };
            clearLocalState();
            try {
                if (projectRoot && options.moduleClient.deleteSession) {
                    await options.moduleClient.deleteSession(sessionId, projectRoot);
                }
            } catch (error) {
                sessionLog(sessionId, "rust module session deletion failed:", error);
                throw error;
            } finally {
                // A transform that was already running may finish while session.delete waits.
                // Clear the state again so its completion cannot repopulate this route's
                // wire or last-known-good state after deletion has begun.
                clearLocalState();
                options.moduleClient.closeSession?.(sessionId);
            }
        },
        invalidateWireState,
        async stopHostRunner(): Promise<void> {
            await (hostRunner ?? undefined)?.stop();
        },
        /**
         * The host disposed the instance that owns this adapter. Stop offering it
         * to the outer wrapper's replay registry; the registry holds it weakly, so
         * this only makes the removal immediate instead of waiting for collection.
         */
        dispose(): void {
            unregisterReplayParticipant();
        },
        getState(sessionId: string): Readonly<RustSessionState> {
            return {
                ...ensureState(states, sessionId),
                idOrdinalMemo: new Map(ensureState(states, sessionId).idOrdinalMemo),
            };
        },
        getHeapStats(): RustWireCacheHeapStats {
            const sessions = [...heapHolder.wireCaches].map(([sessionId, cache]) => ({
                sessionId,
                rawMessages: cache.rawCount,
                wireMessages: cache.wireCount,
                rawContentSnapshots: cache.rawContentSnapshots.length,
                estimatedBytes: rustWireCacheEstimatedBytes(cache),
            }));
            return {
                snapshots: heapHolder.wireCaches.size,
                rawContentSnapshots: sessions.reduce(
                    (sum, session) => sum + session.rawContentSnapshots,
                    0,
                ),
                estimatedBytes: sessions.reduce((sum, session) => sum + session.estimatedBytes, 0),
                sessions,
            };
        },
        // What the outer messages-transform wrapper of this adapter's own instance
        // uses to replay and freeze. Holding it here also keeps the replay registry's
        // weak reference alive exactly as long as the adapter is.
        replayParticipant,
    };
    return adapter;
}

export async function runRustModeTransform(
    transform: ReturnType<typeof createRustModeTransform>,
    sessionId: string,
    messages: MessageLike[],
    output: { messages: unknown[] },
    sessionMeta: ReturnType<typeof getOrCreateSessionMeta>,
): Promise<void> {
    await transform.run(sessionId, messages, output, sessionMeta);
}

export const __rustModeTransformTest = {
    applyNativeMessagesVerbatim,
    contentSnapshotsFor,
    rustCaptureDigests,
    snapshotTags: {
        array: LKG_SNAPSHOT_ARRAY,
        object: LKG_SNAPSHOT_OBJECT,
        key: LKG_SNAPSHOT_KEY,
        string: LKG_SNAPSHOT_STRING,
        number: LKG_SNAPSHOT_NUMBER,
        boolean: LKG_SNAPSHOT_BOOLEAN,
        null: LKG_SNAPSHOT_NULL,
        undefined: LKG_SNAPSHOT_UNDEFINED,
    },
    messageContentSnapshot,
    messageMatchesContentSnapshot,
    buildTransformBody,
    transformGeometryForWire,
    hardWallUsagePercentage,
    muralInputForWire,
    resolvedHistorianModelChain,
    resolvedHistorianModelVariants,
    resolvedHistorianModelLimits,
    formatRustPassLog,
    formatRustInputCoverageLog,
    materializedCompactionBoundary,
    shouldDisarmRustEmergencyRecovery,
    createRustModeTransform,
    directiveTextOf,
};

import { protectedToolTokenCount } from "../../features/magic-context/reclaim-protection";
import { getActiveTagsBySession } from "../../features/magic-context/storage";
import { resolveDecisionCalibration } from "./decision-calibration";
import {
    contextRefusalError,
    outgoingContextRefusal,
    protectedToolRefusal,
} from "./emergency-fail-closed";
