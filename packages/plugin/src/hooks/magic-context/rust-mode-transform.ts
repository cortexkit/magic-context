import { createHash } from "node:crypto";

import {
    type AuthorityDrainResponse,
    type AuthorityModuleClient,
    type AuthorityStatus,
    checksumAuthoritySeedRows,
    drainAuthority,
    ensureContextStoreUuid,
    observeAuthorityRouting,
    prepareAuthority,
    pullMemoryMirrorOnce,
    reconcileAuthorityProject,
} from "../../features/magic-context/context-authority";
import {
    resolveProjectIdentity,
    resolveProjectIdentityForSession,
} from "../../features/magic-context/memory/project-identity";
import { getMemoryVerifications } from "../../features/magic-context/memory/storage-memory-verifications";
import {
    modelKeyAcceptsImages,
    resolveMuralWire,
} from "../../features/magic-context/mural/render-trigger";
import type { MuralWireOptions } from "../../features/magic-context/mural/resolve-mural";
import { isFable51ThinkingBindingModel } from "../../features/magic-context/overflow-detection";
import { recordSessionProjectIdentity } from "../../features/magic-context/session-project-storage";
import type { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import {
    casChannel2NudgeState,
    clearEmergencyRecovery,
    clearPersistedTodoSyntheticAnchor,
    clearThinkingBindingRecoveryIf,
    getChannel2NudgeState,
    getEmergencyRecoveryArmedAt,
    getOverflowState,
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
import { getPendingOps } from "../../features/magic-context/storage-ops";
import {
    GLOBAL_USER_PROFILE_PROJECT_PATH,
    getProjectState,
} from "../../features/magic-context/storage-project-state";
import { writeRustTransformDecision } from "../../features/magic-context/transform-decision-log";
import type { ContextUsage } from "../../features/magic-context/types";
import { canonicalModelIdentity } from "../../shared/harness-provider-map";
import { sessionLog } from "../../shared/logger";
import { promptSurfaceConfigIdentity, resolvePromptSurface } from "../../shared/prompt-surface";
import { createPromptSurfaceGuidanceEpochCache } from "../../shared/prompt-surface-runtime";
import type { WindowGeometryResult } from "../../shared/window-geometry";
import {
    cachedToolPermissionDenied,
    resolveCtxReduceAvailability,
    resolveTodowriteAvailability,
    resolveTodowriteAvailabilityFromMessages,
    type ToolAvailabilityVerdict,
    todowritePermissionDenied,
} from "./ctx-reduce-availability";
import { isEditTool } from "./edit-marker";
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
import { estimateFinalWireInputTokens } from "./final-wire-token-estimate";
import { saveLkgSlotToDb } from "./lkg-persist";
import { replayLkg, resolveLkgModelKeys } from "./lkg-replay";
import {
    captureSlot,
    dropSlot,
    exactReusablePrefix,
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
    type MessageContentSnapshot,
    messageContentFields,
    messageContentSnapshot,
    noteEntry,
    signatureForFields,
    visitMessageContentFields,
} from "./lkg-slot";
import {
    clearCompartmentMirrorCursor,
    type ModuleCompartmentMirrorResponse,
    type ModuleCompartmentReader,
    type ModuleStateSyncClient,
    type ModuleStateSyncState,
    mirrorModuleCompartments,
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
    resolveOrdinalsForModule,
} from "./module-wire";
import { RECOVERY_NO_HEAD_LIMIT } from "./protected-tail-boundary";
import { RawFallbackContextLimitError } from "./raw-fallback-context-limit";
import { findLastAssistantModelFromOpenCodeDb } from "./read-session-db";
import type { RawMessageOrdinalAnchor } from "./read-session-raw";
import { modelAcceptsEmptyContent } from "./sentinel";
import { snapshotTrailingBlankSourceDecisions } from "./strip-content";
import { computeSyntheticCallId, normalizeTodoStateJson } from "./todo-view";
import type { TransformDeps } from "./transform";
import { resolveHistoryBudgetTokens } from "./transform";
import { loadContextUsage } from "./transform-context-state";
import type { MessageLike } from "./transform-operations";
import {
    replayRustModeBindingMismatchStrips,
    runRustModePostprocess,
} from "./transform-postprocess-phase";
import { logTransformTiming } from "./transform-stage-logger";

export class MemoryAuthorityUnavailableError extends Error {
    readonly code = "MEMORY_AUTHORITY_UNAVAILABLE";

    constructor(detail: string) {
        super(
            `rust memory authority unavailable; route ctx_memory through the Rust module: ${detail}`,
        );
        this.name = "MemoryAuthorityUnavailableError";
    }
}

class RustTransformProtocolError extends Error {
    readonly code = "rust_transform_protocol_error";

    constructor(message: string) {
        super(message);
        this.name = "RustTransformProtocolError";
    }
}

export const RUST_FAILURE_PARK_THRESHOLD = 3;
export const RUST_PARK_RETRY_INTERVAL = 5;
export const RUST_EMERGENCY_WALL_PCT = 95;
export const RUST_PARK_PROBE_PRESSURE_BYPASS_PCT = 90;
const RUST_SEND_TIMEOUT_MS = 15_000;
// A frozen defer prevents an immediate LKG/module/LKG double bust. After eight healthy module
// passes or sixteen new raw messages, continued replay adds more stale-snapshot risk than value.
const RUST_LKG_FROZEN_HEALTHY_PASS_LIMIT = 8;
const RUST_LKG_FROZEN_RAW_TAIL_GROWTH_LIMIT = 16;

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
            // Permission is still revalidated with the host each pass. Avoid a redundant
            // SQLite write only when the durable verdict already matches that fresh read.
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
const RAW_FALLBACK_BYTES_PER_CONTEXT_TOKEN = 4;

/**
 * Serialize the raw array message-by-message with a running byte sum, aborting
 * as soon as the sum proves the prompt is over the context limit. A refusal
 * then costs a fraction of the full serialization and never runs the
 * tokenizer; when the sum stays under the budget the total matches a
 * whole-array serialization up to array punctuation.
 */
function rawFallbackSerializedBytes(
    messages: readonly MessageLike[],
    abortAboveBytes: number,
): { bytes: number; aborted: boolean } | null {
    let bytes = 0;
    try {
        for (const message of messages) {
            const serialized = JSON.stringify(message);
            if (typeof serialized !== "string") return null;
            // +1 accounts for the separator between array entries.
            bytes += Buffer.byteLength(serialized) + 1;
            if (bytes > abortAboveBytes) return { bytes, aborted: true };
        }
    } catch {
        // Serialization is itself required before these messages can reach a provider.
        return null;
    }
    return { bytes: bytes + 1, aborted: false };
}

export interface RustModeModuleClient extends ModuleStateSyncClient {
    call(
        args: Parameters<ModuleStateSyncClient["call"]>[0] & {
            onTimings?: (timings: import("./module-transport").ModuleCallTimings) => void;
        },
    ): Promise<unknown>;
    authorityStatus?(args: {
        context_store_uuid: string;
        project: string;
        /** Bound route root for this authority query. */
        projectRoot?: string;
        domain: "memories" | "notes";
    }): Promise<{ authority: AuthorityStatus | null }>;
    authorityPrepare?(args: Record<string, unknown>): Promise<{ authority: AuthorityStatus }>;
    authoritySeed?(
        args: Record<string, unknown>,
    ): Promise<{ seeded: number; module_row_ids?: number[] }>;
    authorityDrain?(args: Record<string, unknown>): Promise<AuthorityDrainResponse>;
    mirrorPull?(args: {
        domain: "memories" | "notes";
        cursor: number;
        limit: number;
        live_only?: boolean;
        projectRoot?: string;
    }): Promise<{ page: import("../../features/magic-context/context-authority").ChangefeedPage }>;
    deleteSession?(sessionId: string, projectRoot: string): Promise<void>;
    closeSession?(sessionId: string): void;
    getCompartmentsAfter?(
        sessionId: string,
        afterSequence: number,
    ): Promise<ModuleCompartmentMirrorResponse>;
}

interface RustLkgCapturePlan {
    sessionId: string;
    inputIds: string[];
    inputSnapshots: readonly Pick<MessageContentSnapshot, "fields">[];
    jsonPrefix: string;
    modelKey: string | null;
    providerKey: string | null;
    capturedAt: number;
    rowVersion: number;
    captureSequence: number;
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
    todoProbeNextPass?: boolean;
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
    /** Durable prior-lineage tail returned by the module after descent. Fresh arrays
     * continue after this base instead of regenerating index+1 ordinals. */
    ordinalContinuationBase: number | null;
    failureCount: number;
    parkCount: number;
    syntheticTurnCount: number;
    lastObservedUserMessageId: string | null;
    syntheticLoopBreakerLogged: boolean;
    memoryAuthorityProject: string | null;
    memoryAuthorityRoot: string | null;
    memoryAuthorityReady: boolean;
    recordedSessionProjectIdentity: string | null;
    recordedSessionDirectory: string | null;
    resolvedMemoryProjectDirectory: string | null;
    resolvedMemoryProjectPath: string | null;
    stateSyncInputSignature: string | null;
    memoryMirrorProjectionKey: string | null;
    compartmentMirrorProjectionKey: string | null;
    mirrorProjectionInFlight: boolean;
    muralCuePoolVersion: number;
    muralGeneration: number;
    muralCache: { key: string; value: MuralWireOptions } | null;
    authorityMemorySyncSkipLogged?: boolean;
    lkgCaptureSequence: number;
    lkgLastCapturedRowVersion: number;
    lkgSyncCaptureRequired: boolean;
    lkgAcceptedCapture?: {
        inputs: readonly LkgInputSnapshot[];
        captureSequence: number;
        rowVersion: number;
    };
    /** A fallback replay is provider-visible output. Keep that exact representation through
     * deferred recovery; healthy-pass and raw-tail limits prevent indefinite stale replay. */
    lkgRepresentationFrozen: boolean;
    lkgFrozenHealthyPasses: number;
    lkgFrozenAtInputCount: number | null;
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
    /**
     * Invoked with each project that reaches rust-mode authority preparation, so the
     * host can lazily register per-project services (the smart-note evaluator bridge)
     * for projects other than the plugin's launch directory.
     */
    onProjectPrepared?: (projectPath: string) => void;
    /** Test-only escape hatch for transform-wire tests without an authority transport. */
    allowAuthorityProtocolBypassForTests?: boolean;
    /** Override only for deterministic capture scheduling in tests. */
    scheduleLkgCapture?: (capture: () => void) => void;
    /** Override only to exercise a failure at the native-output installation boundary. */
    installNativeMessagesForTests?: (output: { messages: unknown[] }, messages: unknown[]) => void;
    /** Override only to exercise raw-fallback estimator failures in tests. */
    rawFallbackEstimatorForTests?: typeof estimateFinalWireInputTokens;
    /** Override only to observe mural generation caching in tests. */
    muralResolverForTests?: typeof resolveMuralWire;
    /** Override only to observe session-identity caching in tests. */
    sessionProjectIdentityResolverForTests?: typeof resolveProjectIdentityForSession;
    /** Override only to observe memory-project identity caching in tests. */
    memoryProjectIdentityResolverForTests?: typeof resolveProjectIdentity;
    /** Disable hot-path I/O caches to establish an uncached differential-timing baseline. */
    disableHotPathIoCachesForTests?: boolean;
    /** Test-only callback after a capture is accepted, reporting the reused digest prefix length. */
    onLkgCaptureForTests?: (reusedPrefix: number) => void;
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
    const matched = visitMessageContentFields(message, {
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
}): string {
    return `rust input coverage: oc_input=${args.ocInput} marker_at=${args.markerAt ?? "none"} covered=${args.covered}`;
}

function materializedCompactionBoundary(
    response: Record<string, unknown>,
): import("./transform-postprocess-phase").RustMaterializedCompactionBoundary | undefined {
    if (response.committed !== true) return undefined;
    if (
        typeof response.scheduler_decision !== "string" ||
        response.scheduler_decision.toLowerCase() !== "execute"
    ) {
        return undefined;
    }
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

function formatRustPassLog(args: {
    decision: string;
    reason: string;
    schedulerDecision?: string;
    schedulerDeferReason?: string;
    historianNoFire?: string;
    historianCanonicalCause?: string;
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
    return `rust pass: decision=${args.decision} reason=${args.reason}${schedulerFields}${historianFields} served_from=${args.servedFrom} in=${args.inputCount} out=${args.outputCount} applied=${args.applied} row_version=${rowVersion} elapsed=${args.elapsedMs.toFixed(1)} ms module=${args.moduleElapsedMs.toFixed(1)} ms stages=identity_resolve:${timings.identityResolve.toFixed(1)} prompt_surface:${timings.promptSurface.toFixed(1)} mural_resolve:${timings.muralResolve.toFixed(1)} prefix_guard:${timings.prefixGuard.toFixed(1)} ordinal_resolve:${timings.ordinalResolve.toFixed(1)} state_sync:${timings.stateSync.toFixed(1)} clone:${timings.clone.toFixed(1)} wire_build:${timings.wireBuild.toFixed(1)} wire_messages:${timings.wireMessages} transport:${timings.transport.toFixed(1)} transport_pages:${timings.transportPages} transport_bytes:${timings.transportBytes} apply:${timings.apply.toFixed(1)} lkg_snapshot:${timings.lkgSnapshot.toFixed(1)} mirror_pull:${timings.mirrorPull.toFixed(1)} compartment_mirror:${timings.compartmentMirror.toFixed(1)} other:${unattributed.toFixed(1)} transport_lane:${timings.transportDetail.lane.toFixed(1)} transport_route:${timings.transportDetail.route.toFixed(1)} transport_encode:${timings.transportDetail.encode.toFixed(1)} transport_issue:${timings.transportDetail.issue.toFixed(1)} transport_response_wait_decode:${timings.transportDetail.responseWait.toFixed(1)} transport_settle:${timings.transportDetail.settle.toFixed(1)} transport_wrapper:${Math.max(0, timings.transport - Object.values(timings.transportDetail).reduce((sum, ms) => sum + ms, 0)).toFixed(1)} preflight:${timings.preflight.toFixed(1)} todo_verdict:${timings.todoVerdict.toFixed(1)} todo_probe:${timings.todoProbe.toFixed(1)} todo_persist:${timings.todoPersist.toFixed(1)} todo_probe_required:${timings.todoProbeRequired} todo_probe_reason:${timings.todoProbeReason} todo_unprobed_bust:${timings.todoUnprobedBust} session_directory:${timings.sessionDirectory.toFixed(1)} paging:${timings.paging.toFixed(1)} output_clone:${timings.outputClone.toFixed(1)} delivery:${timings.delivery.toFixed(1)} bookkeeping:${timings.bookkeeping.toFixed(1)}`;
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
    if (isRecord(response) && isRecord(response.result)) return response.result;
    if (isRecord(response)) return response;
    throw new Error("module transform returned a non-object response");
}

function mirrorProjectionKey(response: Record<string, unknown>): string | null {
    const rowVersion = response.row_version;
    if (typeof rowVersion !== "number" || !Number.isSafeInteger(rowVersion) || rowVersion < 0) {
        return null;
    }
    const renderedMemoryIds = Array.isArray(response.rendered_memory_ids)
        ? response.rendered_memory_ids
        : [];
    return JSON.stringify([
        rowVersion,
        response.boundary_id ?? null,
        response.coverage_ordinal ?? null,
        renderedMemoryIds,
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

function noteDeliveryPassIds(response: Record<string, unknown>): string[] {
    if (!Array.isArray(response.note_deliveries)) return [];
    return [
        ...new Set(
            response.note_deliveries.flatMap((delivery) => {
                if (!isRecord(delivery)) return [];
                const passId = delivery.transform_pass_id;
                return typeof passId === "string" && passId.length > 0 ? [passId] : [];
            }),
        ),
    ];
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
            memoryAuthorityProject: null,
            memoryAuthorityRoot: null,
            memoryAuthorityReady: false,
            recordedSessionProjectIdentity: null,
            recordedSessionDirectory: null,
            resolvedMemoryProjectDirectory: null,
            resolvedMemoryProjectPath: null,
            stateSyncInputSignature: null,
            memoryMirrorProjectionKey: null,
            compartmentMirrorProjectionKey: null,
            mirrorProjectionInFlight: false,
            muralCuePoolVersion: 0,
            muralGeneration: 0,
            muralCache: null,
            authorityMemorySyncSkipLogged: false,
            lkgCaptureSequence: 0,
            lkgLastCapturedRowVersion: 0,
            lkgSyncCaptureRequired: false,
            lkgRepresentationFrozen: false,
            lkgFrozenHealthyPasses: 0,
            lkgFrozenAtInputCount: null,
        };
        states.set(sessionId, state);
    }
    return state;
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

function canonicalizeForChecksum(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalizeForChecksum);
    if (!isRecord(value)) return value;
    return Object.fromEntries(
        Object.keys(value)
            .sort()
            .map((key) => [key, canonicalizeForChecksum(value[key])]),
    );
}

function checksumSeedRows(rows: readonly Record<string, unknown>[]): string {
    return createHash("sha256")
        .update(JSON.stringify(rows.map(canonicalizeForChecksum)))
        .digest("hex");
}

function authoritySeedRows(
    db: TransformDeps["db"],
    projectPath: string,
    domain: "memories" | "notes",
): Record<string, unknown>[] {
    const snapshots =
        domain === "memories"
            ? db
                  .prepare("SELECT * FROM memories WHERE project_path = ? ORDER BY id ASC")
                  .all(projectPath)
            : db
                  .prepare(
                      `SELECT n.*
                         FROM notes n
                        WHERE n.project_path = ?
                           OR (n.project_path IS NULL AND EXISTS (
                               SELECT 1 FROM session_projects sp
                                WHERE sp.session_id = n.session_id AND sp.project_path = ?
                           ))
                        ORDER BY n.id ASC`,
                  )
                  .all(projectPath, projectPath);
    const memoryRows = snapshots.filter(isRecord);
    // A `superseded_by_memory_id` pointing outside this seed set can never resolve
    // module-side: the store records it as a pending memory reference, and the
    // resolution sweep only clears pendings whose target later appears in
    // mc_memories. A target that is absent here is absent for good (its row was
    // hard-deleted after an archive), so the pending would survive to
    // authority_finish_prepare and permanently reject the memories-domain handoff.
    // Dropping the dead link here keeps the gate meaningful for the case it exists
    // to catch: a target the host DID send that the module failed to ingest.
    const seededIds = new Set(memoryRows.map((row) => Number(row.id)));
    const mappings =
        domain === "memories"
            ? getMemoryVerifications(
                  db,
                  memoryRows.map((row) => Number(row.id)),
              )
            : new Map<number, { files: string[]; hasSentinel: boolean; mappingOrigin: "mapper" }>();
    return memoryRows.map((snapshot) => {
        const id = Number(snapshot.id);
        const mapping = mappings.get(id);
        const resolvedSnapshot =
            domain === "memories" &&
            snapshot.superseded_by_memory_id != null &&
            !seededIds.has(Number(snapshot.superseded_by_memory_id))
                ? { ...snapshot, superseded_by_memory_id: null }
                : snapshot;
        const seededSnapshot =
            domain === "memories" && mapping
                ? {
                      ...resolvedSnapshot,
                      mapping: mapping.hasSentinel ? null : mapping.files,
                      mapping_origin: mapping.mappingOrigin,
                  }
                : domain === "notes" && snapshot.project_path == null
                  ? { ...resolvedSnapshot, project_path: projectPath }
                  : resolvedSnapshot;
        return { source_row_id: snapshot.id, snapshot: seededSnapshot };
    });
}

async function prepareRustMemoryAuthority(args: {
    db: TransformDeps["db"];
    module: RustModeModuleClient;
    projectPath: string;
    projectRoot: string;
    state: RustSessionState;
    allowProtocolBypassForTests?: boolean;
    /** Fires after authority is ready so hosts can register per-project services. */
    onProjectPrepared?: (projectPath: string) => void;
}): Promise<void> {
    const { db, module, projectPath, projectRoot, state } = args;
    if (
        state.memoryAuthorityProject === projectPath &&
        state.memoryAuthorityRoot === projectRoot &&
        state.memoryAuthorityReady
    ) {
        return;
    }
    state.memoryAuthorityProject = projectPath;
    state.memoryAuthorityRoot = projectRoot;
    state.memoryAuthorityReady = false;
    if (!module.authorityStatus || !module.authorityPrepare || !module.authoritySeed) {
        if (args.allowProtocolBypassForTests === true) {
            state.memoryAuthorityReady = true;
            return;
        }
        throw new MemoryAuthorityUnavailableError(
            "the module does not expose authority.status, authority.prepare, and authority.seed",
        );
    }

    // Call through the module object on every invocation: these may be real class
    // methods whose implementations depend on their instance, so detaching them into
    // locals would sever `this` and only fail at runtime (test fakes are object
    // literals and cannot catch the difference).
    const authorityModule: AuthorityModuleClient = {
        authorityStatus: (request) => {
            const method = module.authorityStatus;
            if (!method) throw new MemoryAuthorityUnavailableError("authority.status unavailable");
            return method.call(module, { ...request, projectRoot });
        },
        authorityPrepare: (request) => {
            const method = module.authorityPrepare;
            if (!method) throw new MemoryAuthorityUnavailableError("authority.prepare unavailable");
            return method.call(module, { ...request, projectRoot });
        },
        authoritySeed: (request) => {
            const method = module.authoritySeed;
            if (!method) throw new MemoryAuthorityUnavailableError("authority.seed unavailable");
            return method.call(module, { ...request, projectRoot });
        },
        authorityDrain: module.authorityDrain
            ? (request) => {
                  const method = module.authorityDrain;
                  if (!method)
                      throw new MemoryAuthorityUnavailableError("authority.drain unavailable");
                  return method.call(module, { ...request, projectRoot });
              }
            : undefined,
        mirrorPull: module.mirrorPull
            ? (request) => {
                  const method = module.mirrorPull;
                  if (!method) throw new MemoryAuthorityUnavailableError("mirror.pull unavailable");
                  return method.call(module, { ...request, projectRoot });
              }
            : undefined,
    };
    const contextStoreUuid = ensureContextStoreUuid(db);
    const domains = ["memories", "notes"] as const;
    const statuses = new Map<
        (typeof domains)[number],
        Awaited<ReturnType<NonNullable<RustModeModuleClient["authorityStatus"]>>>["authority"]
    >();
    for (const domain of domains) {
        const current = await authorityModule.authorityStatus({
            context_store_uuid: contextStoreUuid,
            project: projectPath,
            domain,
        });
        statuses.set(domain, current.authority);
    }

    let resumedDrain = false;
    for (const domain of domains) {
        const current = statuses.get(domain);
        if (current?.state !== "DRAINING") continue;
        resumedDrain = true;
        let drained: Awaited<ReturnType<typeof drainAuthority>> | undefined;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            drained = await drainAuthority({
                db,
                projectPath,
                domain,
                module: authorityModule,
                checksum: () =>
                    checksumSeedRows(
                        db
                            .prepare(
                                `SELECT * FROM ${domain === "memories" ? "memories" : "notes"} WHERE project_path = ? ORDER BY id ASC`,
                            )
                            .all(projectPath)
                            .filter(isRecord),
                    ),
            });
            if (!("code" in drained)) break;
        }
        if (!drained) {
            throw new MemoryAuthorityUnavailableError("authority drain did not return a result");
        }
        if ("code" in drained) {
            throw new MemoryAuthorityUnavailableError(
                `${drained.code}; the next scheduled transform will resume the drain`,
            );
        }
        statuses.set(domain, null);
    }

    // Do not return before finishing authority restore: if some domains are still
    // DRAINING and others MODULE, reinstall the on-disk authority_managed marker and
    // re-apply write fences on remaining MODULE domains before any tools run.
    if (!resumedDrain) {
        for (const domain of domains) {
            const current = statuses.get(domain);
            if (current?.state !== "PREPARING") continue;
            await authorityModule.authorityPrepare({
                method: "authority.prepare",
                phase: "abort",
                context_store_uuid: contextStoreUuid,
                project: projectPath,
                domain,
                generation: current.generation,
            });
            statuses.set(domain, null);
        }
        const preparing = domains.filter((domain) => statuses.get(domain)?.state !== "MODULE");
        for (const domain of preparing) {
            const stateName = statuses.get(domain)?.state;
            if (stateName && stateName !== "TS") {
                throw new Error(`${domain} authority cannot prepare from ${stateName}`);
            }
        }
        if (preparing.length > 0) {
            const prepared = await prepareAuthority({
                db,
                projectPath,
                domains: preparing,
                module: authorityModule,
                seedPages: async (domain) => authoritySeedRows(db, projectPath, domain),
                checksum: (_domain, rows) => checksumAuthoritySeedRows(rows),
            });
            for (const authority of prepared) statuses.set(authority.domain, authority);
        }
    }

    await reconcileAuthorityProject({ db, projectPath, module: authorityModule });
    observeAuthorityRouting(
        projectPath,
        domains.every((domain) => statuses.get(domain)?.state === "MODULE") ? "MODULE" : "TS",
    );
    state.memoryAuthorityReady = true;
    args.onProjectPrepared?.(projectPath);
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
        clear_reasoning_age: args.passInputs.clear_reasoning_age,
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
    getState: (sessionId: string) => Readonly<RustSessionState>;
    getHeapStats: () => RustWireCacheHeapStats;
} {
    const states = new Map<string, RustSessionState>();
    const heapHolder = new MagicContextRustHeapHolder();
    const promptSurfaceGuidanceEpochs = deps.promptSurfaceRuntime
        ? createPromptSurfaceGuidanceEpochCache(deps.promptSurfaceRuntime)
        : undefined;
    const scheduleLkgCapture =
        options.scheduleLkgCapture ?? ((capture: () => void) => setImmediate(capture));
    const installNativeMessages = options.installNativeMessagesForTests ?? replaceMessagesInPlace;
    const rawFallbackEstimator =
        options.rawFallbackEstimatorForTests ?? estimateFinalWireInputTokens;
    const timeoutMs = Math.max(1, options.moduleTimeoutMs ?? RUST_SEND_TIMEOUT_MS);

    const resolveMuralForPass = (
        state: RustSessionState,
        projectIdentity: string | undefined,
        modelKey: string | undefined,
        budgetTokens: number | undefined,
    ): MuralWireOptions => {
        // SDK refreshes can correct image support without changing the model key.
        // Cache the candidate mural for the next permitted HARD (prefix rebuild);
        // the Rust module keeps already-served m0 prefix bytes frozen on passes
        // without cache-bust permission.
        const key = JSON.stringify([
            state.muralGeneration,
            state.muralCuePoolVersion,
            projectIdentity ?? null,
            modelKey ?? null,
            budgetTokens ?? null,
            modelKeyAcceptsImages(modelKey),
        ]);
        if (options.disableHotPathIoCachesForTests !== true && state.muralCache?.key === key) {
            return state.muralCache.value;
        }
        const value = (options.muralResolverForTests ?? resolveMuralWire)(
            deps.db,
            projectIdentity,
            modelKey,
            true,
            budgetTokens,
        );
        state.muralCache = { key, value };
        return value;
    };

    const logStage = (
        sessionId: string,
        stage: Exclude<keyof RustPassTimings, "transportDetail" | "todoProbeReason">,
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
        const timer = setTimeout(() => controller.abort(timeoutError), attemptTimeoutMs);
        try {
            return await options.moduleClient.call({
                ...args,
                signal: controller.signal,
                timeoutMs: attemptTimeoutMs,
            });
        } catch (error) {
            if (controller.signal.aborted) throw timeoutError;
            throw error;
        } finally {
            clearTimeout(timer);
        }
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

    const resetOrdinalMemo = (state: RustSessionState): void => {
        state.idOrdinalMemo.clear();
        state.ordinalMemoAnchor = null;
        state.ordinalMemoStoredCount = null;
        state.ordinalMemoCanonicalCount = 0;
    };

    const invalidateWireState = (sessionId: string): void => {
        heapHolder.wireCaches.delete(sessionId);
        const state = states.get(sessionId);
        if (!state) return;
        resetOrdinalMemo(state);
        state.stateSyncInputSignature = null;
        state.forceFullWire = true;
    };

    const replayLastGood = (
        sessionId: string,
        currentMessages: MessageLike[],
        output: { messages: unknown[] },
        systemPromptTokens: number,
    ): boolean => {
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
            dropSlot(sessionId, "lkg_invalidated_reshape");
            const state = states.get(sessionId);
            if (state) state.lkgAcceptedCapture = undefined;
            sessionLog(sessionId, "lkg_invalidated_reshape");
            return false;
        }
        const keys = resolveLkgModelKeys(currentMessages);
        const replay = replayLkg({
            sessionId,
            messages: currentMessages,
            modelKey: keys.modelKey,
            providerKey: keys.providerKey,
            entry,
        });
        if (!replay.ok) {
            const state = states.get(sessionId);
            if (state) state.lkgAcceptedCapture = undefined;
            sessionLog(sessionId, replay.reason);
            return false;
        }
        const replayModel =
            modelFromMessages(currentMessages) ?? findLastAssistantModelFromOpenCodeDb(sessionId);
        replayRustModeBindingMismatchStrips({
            db: deps.db,
            sessionId,
            messages: replay.messages as MessageLike[],
            // Rust mode stays canonical-Anthropic only; the module keeps its own
            // `provider_id == "anthropic"` gates and both lanes must agree.
            acceptsEmptySentinels: modelAcceptsEmptyContent(replayModel?.providerID),
        });
        const trustedReplayLimit = replayModel
            ? resolveTrustedContextLimit(replayModel.providerID, replayModel.modelID, {
                  db: deps.db,
                  sessionID: sessionId,
              })
            : undefined;
        let detectedReplayLimit = 0;
        try {
            detectedReplayLimit = getOverflowState(
                deps.db,
                sessionId,
                keys.modelKey,
            ).detectedContextLimit;
        } catch {
            // A limit read failure cannot admit cached bytes whose size is now unknown.
            return false;
        }
        const replayLimit =
            trustedReplayLimit ?? (detectedReplayLimit > 0 ? detectedReplayLimit : undefined);
        if (replayLimit !== undefined && replayLimit > 0) {
            try {
                const estimate = estimateFinalWireInputTokens({
                    messages: replay.messages,
                    systemPromptTokens,
                    providerID: replayModel?.providerID,
                    modelID: replayModel?.modelID,
                    agentName: deps.getNotificationParams?.(sessionId)?.agent,
                });
                if (estimate.tokens > replayLimit) {
                    sessionLog(
                        sessionId,
                        `lkg_over_context_limit estimated=${estimate.tokens} limit=${replayLimit}`,
                    );
                    return false;
                }
            } catch {
                return false;
            }
        }
        replaceMessagesInPlace(output, replay.messages);
        sessionLog(sessionId, "lkg_replay_served");
        return true;
    };

    const prepareRustCapture = (
        state: RustSessionState,
        sessionId: string,
        inputIds: readonly unknown[],
        inputKeys: ReturnType<typeof resolveLkgModelKeys>,
        inputSnapshots: readonly Pick<MessageContentSnapshot, "fields">[],
        nativeMessages: readonly unknown[],
        responseRowVersion: number,
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
        };
        const captured = captureSlot(plan.sessionId, slot);
        if (!captured) throw new Error("LKG slot rejected the prepared snapshot");
        state.lkgAcceptedCapture = {
            inputs,
            captureSequence: plan.captureSequence,
            rowVersion: plan.rowVersion,
        };
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
        const trailingBlankSourceDecisions = snapshotTrailingBlankSourceDecisions(messages);
        const trailingBlankNewestAssistantId = [...messages]
            .reverse()
            .find((message) => message.info.role === "assistant")?.info.id;
        const timings = emptyRustPassTimings();
        state.passCount += 1;
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
        let requestInputTokens = 0;
        let decision = "error";
        let materializeReason = "none";
        let schedulerDecision: string | undefined;
        let schedulerDeferReason: string | undefined;
        let historianNoFire: string | undefined;
        let historianCanonicalCause: string | undefined;
        let servedFrom = "none";
        let moduleElapsedMs = 0;
        let rowVersion = 0;
        let coveredOrdinal = 0;
        let markerAt: string | null = null;
        try {
            const marker = getPersistedCompactionMarkerState(deps.db, sessionId);
            markerAt = marker?.targetEndMessageId ?? marker?.boundaryMessageId ?? null;
        } catch {
            // Diagnostics remain available even when the local state database is unavailable.
        }
        let appliedAt: number | undefined;
        let emergencyFailClosed = false;
        // Parking must not hide pressure from the recovery policy. Usage is cheap to read
        // and is the same value copied onto the module request when this pass runs.
        const passUsageSnapshot = loadContextUsage(deps.contextUsageMap, deps.db, sessionId);
        requestInputTokens = Math.max(0, Math.floor(passUsageSnapshot.inputTokens));
        let preflightError: unknown;
        let model = modelFromMessages(messages);
        if (!model) {
            try {
                model = findLastAssistantModelFromOpenCodeDb(sessionId) ?? undefined;
            } catch (error) {
                preflightError = error;
            }
        }
        const modelKey = model
            ? canonicalModelIdentity(resolveModelKey(model.providerID, model.modelID) ?? "")
            : null;
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
        const hasTrustedEmergencyWall = transformGeometry
            ? transformGeometry.usable_hard > 0
            : resolvedContextLimit !== undefined && resolvedContextLimit > 0;
        emergencyFailClosed =
            isProviderOverflowFailClosedProven(sessionId) ||
            (hardWallUsagePercentage(passUsageSnapshot, transformGeometry) >=
                RUST_EMERGENCY_WALL_PCT &&
                hasTrustedEmergencyWall);
        if (overflowState) {
            const detectedLimitMatchesModel =
                overflowState.detectedContextLimitModelKey === null ||
                canonicalModelIdentity(overflowState.detectedContextLimitModelKey) ===
                    canonicalModelIdentity(modelKey ?? "");
            const hasProviderProof =
                (overflowState.detectedContextLimit > 0 && detectedLimitMatchesModel) ||
                // An unknown persisted arm alone is not proof. A second provider rejection
                // while that arm is durable records the process-local reconfirmation.
                isProviderOverflowReconfirmed(sessionId);
            emergencyFailClosed ||=
                overflowState.needsEmergencyRecovery &&
                overflowState.emergencyRecoveryOrigin === "provider_overflow" &&
                hasProviderProof;
        }
        const serveRawFallback = (cause?: unknown): void => {
            const contextLimit =
                transformGeometry?.usable_hard ??
                resolvedContextLimit ??
                (overflowState && overflowState.detectedContextLimit > 0
                    ? overflowState.detectedContextLimit
                    : undefined);
            if (contextLimit !== undefined) {
                // The local tokenizer is telemetry-grade and can materially undercount a new
                // provider tokenizer. Four serialized bytes per context token is an independent,
                // conservative risk budget for a raw full-history fallback.
                const proxyBudgetBytes = contextLimit * RAW_FALLBACK_BYTES_PER_CONTEXT_TOKEN;
                // Byte proxy first: once the running serialized sum crosses the budget,
                // the refusal is proven and the tokenizer pass — seconds on giant
                // histories — is skipped entirely on the failure path.
                const proxy = rawFallbackSerializedBytes(messages, proxyBudgetBytes);
                const proxyTokens =
                    proxy === null
                        ? contextLimit + 1
                        : Math.ceil(proxy.bytes / RAW_FALLBACK_BYTES_PER_CONTEXT_TOKEN);
                let estimate: ReturnType<typeof estimateFinalWireInputTokens> | undefined;
                let estimatorRan = false;
                if (proxy !== null && !proxy.aborted) {
                    try {
                        estimate = rawFallbackEstimator({
                            messages,
                            systemPromptTokens: sessionMeta.systemPromptTokens,
                            providerID: model?.providerID,
                            modelID: model?.modelID,
                            agentName: deps.getNotificationParams?.(sessionId)?.agent,
                        });
                        estimatorRan = true;
                    } catch {
                        // The byte proxy above remains available when tokenization does not.
                    }
                }
                const refusalTokens = Math.max(estimate?.tokens ?? 0, proxyTokens);
                if (refusalTokens > contextLimit) {
                    sessionLog(
                        sessionId,
                        `raw_fallback_over_context_limit estimated=${estimate?.tokens ?? (estimatorRan ? "unavailable" : "skipped")} ` +
                            `proxy_bytes=${proxy?.bytes ?? "unavailable"} proxy_tokens=${proxyTokens} limit=${contextLimit}` +
                            (proxy?.aborted === true ? " early_abort=true" : ""),
                    );
                    throw new RawFallbackContextLimitError(refusalTokens, contextLimit, { cause });
                }
            }
            replaceMessagesInPlace(output, messages);
        };
        const finishPass = (applied: boolean, served = true): void => {
            const elapsedAt = applied && appliedAt !== undefined ? appliedAt : performance.now();
            const elapsedMs = Math.max(0, elapsedAt - passStartedAt);
            sessionLog(
                sessionId,
                formatRustInputCoverageLog({
                    ocInput: inputCount,
                    markerAt,
                    covered: coveredOrdinal,
                }),
            );
            sessionLog(
                sessionId,
                formatRustPassLog({
                    decision,
                    reason: materializeReason,
                    schedulerDecision,
                    schedulerDeferReason,
                    historianNoFire,
                    historianCanonicalCause,
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
                } else {
                    servedFrom = "raw";
                    try {
                        serveRawFallback();
                    } catch (error) {
                        finishPass(false, false);
                        throw error;
                    }
                }
                finishPass(false);
                return;
            }
        }
        timings.preflight = performance.now() - passStartedAt;

        const reduceAvailability = resolveCtxReduceAvailability(sessionId);
        // Freeze the native todo-tool map verdict before state sync reads it, then combine it
        // with OpenCode's live permission decision. The module receives one authoritative bool;
        // provisional or missing host evidence fails closed for synthesis.
        resolveTodowriteAvailabilityFromMessages(sessionId, messages);
        const todoAvailability = resolveTodowriteAvailability(sessionId);
        const toolPresent = reduceAvailability.frozen && reduceAvailability.callable;
        let todoProbeIdentity = "";
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
            const muralResolveStartedAt = performance.now();
            const resolvedMural =
                !sessionMeta.isSubagent && deps.muralEnabled === true
                    ? resolveMuralForPass(
                          state,
                          deps.projectPath,
                          modelKey ?? undefined,
                          deps.memoryConfig?.injectionBudgetTokens,
                      )
                    : undefined;
            const mural = muralInputForWire(resolvedMural);
            logStage(sessionId, "muralResolve", muralResolveStartedAt, timings);
            const protectionFloorCacheBustingPass =
                schedulerDecision === "execute" ||
                deps.historyRefreshSessions.has(sessionId) ||
                deps.pendingMaterializationSessions.has(sessionId) ||
                deps.deferredHistoryRefreshSessions?.has(sessionId) === true ||
                deps.deferredMaterializationSessions?.has(sessionId) === true;
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
            const passInputs: Record<string, unknown> = {
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
                historian_model_chain: resolvedHistorianModelChain(deps),
                clear_reasoning_age: deps.clearReasoningAge,
                caveman_enabled:
                    !sessionMeta.isSubagent && deps.cavemanTextCompression?.enabled === true,
                caveman_min_chars: deps.cavemanTextCompression?.minChars ?? 500,
                cache_ttl: sessionMeta.cacheTtl,
                is_subagent: sessionMeta.isSubagent,
                system_prompt_hash: sessionMeta.systemPromptHash ?? "",
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
                provisionalBase,
                forceProbeForTests: options.disableHotPathIoCachesForTests,
            });
            logStage(sessionId, "ordinalResolve", ordinalStartedAt, timings);
            if (!resolved.ok) {
                // A removal or persistence race can invalidate every durable memo field.
                // Retry once from a clean full-array prime on both delta and full attempts.
                wireDelta = undefined;
                resetOrdinalMemo(state);
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
                    provisionalBase: state.ordinalContinuationBase ?? undefined,
                    forceProbeForTests: options.disableHotPathIoCachesForTests,
                });
                logStage(
                    sessionId,
                    "ordinalResolve",
                    fullOrdinalStartedAt,
                    timings,
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

            const syncPass = {
                db: deps.db,
                sessionId,
                projectPath: memoryProjectPath,
                nowMs: Date.now(),
            };
            const projectRoot = options.projectRoot ?? directory;
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
            todoProbeIdentity = JSON.stringify([
                modelKey,
                sessionMeta.systemPromptHash,
                activeAgentFromMessages(messages),
                currentStateSyncInputSignature,
                markerAt,
                getProjectState(deps.db, memoryProjectPath ?? projectRoot),
                getProjectState(deps.db, GLOBAL_USER_PROFILE_PROJECT_PATH),
                passInputs.upgrade_state,
                promptSurfaceConfigIdentity(deps.promptSurface),
                state.muralCuePoolVersion,
                state.muralGeneration,
                mural,
                effectiveFloor,
                deps.clearReasoningAge,
                deps.cavemanTextCompression,
            ]);
            const idleBudgetMs = sessionMeta.cacheTtl === "1h" ? 3_600_000 : 300_000;
            // Synthetic todo bytes are re-decided only on a bust. Observe every
            // adapter-visible bust signal rather than polling host permissions on
            // an unchanged defer pass; unexpected module busts remain observable.
            const todoProbeSignals = {
                cold: !state.initialized,
                missing_verdict: getPersistedTodoPermissionDenied(deps.db, sessionId) === null,
                full_wire: state.forceFullWire || !wireDelta,
                identity: state.todoProbeIdentity !== todoProbeIdentity,
                module_hint: state.todoProbeNextPass === true,
                pressure: usage.percentage >= threshold,
                memory_sync: memorySyncRequested,
                refresh: protectionFloorCacheBustingPass,
                emergency: overflowState.needsEmergencyRecovery,
                frozen: state.lkgRepresentationFrozen,
                agent_drop: getPendingOps(deps.db, sessionId).length > 0,
                ttl:
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
                await prepareRustMemoryAuthority({
                    db: deps.db,
                    module: options.moduleClient,
                    projectPath: memoryProjectPath ?? projectRoot,
                    projectRoot,
                    state,
                    allowProtocolBypassForTests: options.allowAuthorityProtocolBypassForTests,
                    onProjectPrepared: options.onProjectPrepared,
                });
                if (memorySyncRequested) {
                    // A memory tool call can complete after the prior authority pass has
                    // acknowledged its watermarks. Rewind only memory watermarks so the
                    // next pass ships the mutation delta without reseeding compartments.
                    const watermarks = state.lastAckedWatermarks;
                    if (watermarks) {
                        state.lastAckedWatermarks = {
                            ...watermarks,
                            memory_id: 0,
                            memory_mutation_id: 0,
                        };
                    }
                }
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
                        authorityState: state.memoryAuthorityReady ? "MODULE" : undefined,
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
                    final_wire_input_tokens: finalWireEstimate?.tokens ?? 0,
                    final_wire_trusted: finalWireEstimate?.trusted === true,
                },
                geometry: transformGeometry,
                modelKey: modelKey ?? null,
                providerId: model?.providerID ?? null,
                variant: deps.variantBySession?.get(sessionId),
                systemPromptHash: sessionMeta.systemPromptHash ?? "",
                upgradeState: String(passInputs.upgrade_state ?? ""),
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
                const pages = buildPagedModuleTransformPayloads(
                    payload,
                    options.modulePageMaxBytes,
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
                        const attemptClass = paged
                            ? index === pages.length - 1
                                ? "transform_series_execute"
                                : "transform_page_upload"
                            : undefined;
                        const attemptTimeoutMs =
                            options.moduleTimeoutMs ??
                            (attemptClass === "transform_series_execute"
                                ? transformColdStartExecuteTimeoutMs(seedMessageCount)
                                : attemptClass === "transform_page_upload"
                                  ? TRANSFORM_PAGE_UPLOAD_TIMEOUT_MS
                                  : timeoutMs);
                        moduleResponse = await callModule(
                            {
                                sessionId,
                                projectRoot,
                                method: "transform",
                                body: page,
                                onTimings: (detail) => {
                                    for (const key of Object.keys(
                                        detail,
                                    ) as (keyof typeof detail)[])
                                        timings.transportDetail[key] += detail[key];
                                },
                                // A reconnect discards a collecting page series. Page zero can be
                                // retried safely, but later pages must make the caller restart it.
                                generationSensitive: paged && index > 0,
                                attemptClass,
                            },
                            attemptTimeoutMs,
                        );
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
            let response = await sendTransformSeriesWithSingleRestart(body);
            let servedFinalWireEstimate:
                | ReturnType<typeof estimateFinalWireInputTokens>
                | undefined;
            captureResponseTelemetry(response);
            const needFullSync = isNeedFullSync(response);
            const nativeContentOmitted = !hasNativeResponseContent(response);
            if (needFullSync || nativeContentOmitted) {
                if (needFullSync) {
                    resetOrdinalMemo(state);
                    state.stateSyncInputSignature = null;
                    state.memoryMirrorProjectionKey = null;
                    state.compartmentMirrorProjectionKey = null;
                    state.muralGeneration += 1;
                    state.muralCache = null;
                    clearCompartmentMirrorCursor(sessionId);
                    // The module restarted and rejected the generation used by the state sync
                    // above. Synchronize the new process before requesting the full response;
                    // otherwise this pass may use incomplete restored state while the next pass
                    // uses the complete state, producing inconsistent output.
                    options.moduleClient.invalidateStateSyncCapabilities?.();
                    const recoveryCachedCapabilities =
                        options.moduleClient.getCachedStateSyncCapabilities;
                    const recoveryStateSyncCapabilities =
                        options.moduleClient.stateSyncCapabilities;
                    const recoverySyncStartedAt = performance.now();
                    try {
                        const recoverySync = await syncModuleState({
                            client: {
                                call: callModule,
                                getCachedStateSyncCapabilities: recoveryCachedCapabilities
                                    ? () => recoveryCachedCapabilities.call(options.moduleClient)
                                    : undefined,
                                stateSyncCapabilities: recoveryStateSyncCapabilities
                                    ? (capabilityArgs) =>
                                          recoveryStateSyncCapabilities.call(
                                              options.moduleClient,
                                              capabilityArgs,
                                          )
                                    : undefined,
                            },
                            state,
                            pass: syncPass,
                            projectRoot,
                            force: true,
                            options: {
                                authority: true,
                                authorityState: state.memoryAuthorityReady ? "MODULE" : undefined,
                                authoritySeqAdoption,
                            },
                        });
                        stateSyncRetryBusy = recoverySync.status === "retry_busy";
                    } catch (error) {
                        // If a compatibility seed cannot be built, including when an older
                        // module provides a seed that is too large, retain the recovery path that
                        // sends the complete arrays. Retry state synchronization on a later pass.
                        sessionLog(
                            sessionId,
                            "restart state reconciliation failed; continuing with full transform retry:",
                            error,
                        );
                    } finally {
                        logStage(
                            sessionId,
                            "stateSync",
                            recoverySyncStartedAt,
                            timings,
                            "retry=full reason=need_full_sync",
                        );
                    }
                } else {
                    sessionLog(
                        sessionId,
                        "native_delta_fallback_reason=adapter_response_omitted_native_content retry=full",
                    );
                }
                // Retry the transform with complete arrays. A restart-triggered miss was
                // reconciled with durable state above, so reseeding is appropriate there. A
                // malformed native response does not prove that the module restarted; retry it
                // without reseeding state.
                state.forceFullWire = true;
                if (!todoProbeRequired) {
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
                        provisionalBase: state.ordinalContinuationBase ?? undefined,
                        forceProbeForTests: options.disableHotPathIoCachesForTests,
                    });
                    logStage(
                        sessionId,
                        "ordinalResolve",
                        retryOrdinalStartedAt,
                        timings,
                        "retry=full",
                    );
                    if (!retryResolved.ok) {
                        resetOrdinalMemo(state);
                        retryResolved = await resolveOrdinalsForModule({
                            sessionId,
                            messages,
                            generation: state.moduleGeneration,
                            memoGeneration: state.idOrdinalMemoGeneration,
                            memo: state.idOrdinalMemo,
                            memoAnchor: state.ordinalMemoAnchor,
                            memoStoredCount: state.ordinalMemoStoredCount,
                            memoCanonicalCount: state.ordinalMemoCanonicalCount,
                            forceProbeForTests: options.disableHotPathIoCachesForTests,
                        });
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
                            final_wire_input_tokens: finalWireEstimate?.tokens ?? 0,
                            final_wire_trusted: finalWireEstimate?.trusted === true,
                        },
                        geometry: transformGeometry,
                        modelKey: modelKey ?? null,
                        providerId: model?.providerID ?? null,
                        systemPromptHash: sessionMeta.systemPromptHash ?? "",
                        upgradeState: String(passInputs.upgrade_state ?? ""),
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
            const deliveryPassIds = noteDeliveryPassIds(response);
            const sendNoteDeliveryDisposition = async (
                method: "transform.ack" | "transform.nack",
            ) => {
                for (const transformPassId of deliveryPassIds) {
                    await callModule({
                        sessionId,
                        projectRoot,
                        method,
                        body: {
                            method,
                            v: 1,
                            session_id: sessionId,
                            transform_pass_id: transformPassId,
                        },
                    });
                }
            };
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
            // `let`: a frozen LKG replay that can no longer validate (or hits its bound) releases
            // the freeze on this pass, which then behaves as priced below.
            let cacheBustingPass =
                decisionUpper === "HARD" ||
                decisionUpper === "MIGRATE_HARD" ||
                decisionUpper === "EXECUTE" ||
                // SOFT re-renders m1 (delta folds, coverage folds): the served bytes changed,
                // so the previous last-known-good (LKG) snapshot is already stale.
                decisionUpper === "SOFT";
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
            const materializedBoundary = materializedCompactionBoundary(response);
            let thinkingBindingRecovery: { flagTarget: string; messageId: string } | null = null;
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
                let replayedFrozenRepresentation = false;
                if (state.lkgRepresentationFrozen && !cacheBustingPass) {
                    if (state.lkgFrozenAtInputCount === null) {
                        state.lkgFrozenAtInputCount = inputCount;
                    }
                    const keys = resolveLkgModelKeys(messages);
                    const frozen = replayLkg({
                        sessionId,
                        messages,
                        modelKey: keys.modelKey,
                        providerKey: keys.providerKey,
                    });
                    if (!frozen.ok) {
                        cacheBustingPass = true;
                        frozenReleaseReason = frozen.reason;
                    } else {
                        frozenHealthyPassesAfterApply = state.lkgFrozenHealthyPasses + 1;
                        const rawTailGrowth = Math.max(0, inputCount - state.lkgFrozenAtInputCount);
                        const releaseReason =
                            rawTailGrowth >= RUST_LKG_FROZEN_RAW_TAIL_GROWTH_LIMIT
                                ? "raw_tail_growth_limit"
                                : frozenHealthyPassesAfterApply >=
                                    RUST_LKG_FROZEN_HEALTHY_PASS_LIMIT
                                  ? "healthy_pass_limit"
                                  : null;
                        if (releaseReason) {
                            cacheBustingPass = true;
                            frozenReleaseReason = releaseReason;
                        } else {
                            appliedMessages = frozen.messages;
                            replayedFrozenRepresentation = true;
                            servedFrom = "lkg_frozen";
                            sessionLog(sessionId, "lkg_frozen_replay_served");
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
                    const postprocess = runRustModePostprocess({
                        db: deps.db,
                        sessionId,
                        messages: appliedMessages as MessageLike[],
                        projectPath: memoryProjectPath,
                        sessionDirectory: directory,
                        materializedBoundary,
                        fullFeatureMode: !sessionMeta.isSubagent,
                        compactionOff: deps.compactionOff,
                        // Rust mode stays canonical-Anthropic only. The module keeps its
                        // own `provider_id == "anthropic"` gates, so widening the host side
                        // alone would let the two lanes disagree on the served bytes. See
                        // `anthropic-wire.ts` for the TS-mode capability.
                        acceptsEmptySentinels: modelAcceptsEmptyContent(model?.providerID),
                        thinkingBindingRecoveryEnabledForModel: isFable51ThinkingBindingModel(
                            model?.providerID,
                            model?.modelID,
                        ),
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
                }
                const boundaryId = response.boundary_id;
                if (typeof boundaryId === "string" && boundaryId.length > 0) {
                    assertNativeBoundary(appliedMessages, sessionId, boundaryId);
                }
                if (!sessionMeta.isSubagent) {
                    mirrorRustSyntheticTodoAnchor({
                        db: deps.db,
                        sessionId,
                        messages: appliedMessages,
                        cacheBustingPass,
                    });
                }
                if (passInputs.emergency_recovery_armed === true) {
                    servedFinalWireEstimate = estimateFinalWireInputTokens({
                        messages: appliedMessages as MessageLike[],
                        systemPromptTokens: sessionMeta.systemPromptTokens,
                        providerID: model?.providerID,
                        modelID: model?.modelID,
                        agentName: deps.getNotificationParams?.(sessionId)?.agent,
                    });
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
                        `rust thinking binding recovery: stripped bound reasoning from assistant ${thinkingBindingRecovery.messageId}; flag=${cleared ? "cleared" : "rearmed"}`,
                    );
                }

                const lkgSnapshotStartedAt = performance.now();
                // A cache-busting replacement invalidates the previous snapshot only after the
                // replacement is installed. If installation fails, the prior LKG remains available
                // and its replay still applies durable binding-mismatch strips.
                if (cacheBustingPass) {
                    dropSlot(sessionId, "lkg_cache_bust_pending_capture");
                    state.lkgAcceptedCapture = undefined;
                }
                // Build the capture from the installed array. A priced replacement commits its
                // snapshot before this transform can return, so a process death cannot leave the
                // previous priced representation durable. Defer-only refreshes remain asynchronous.
                const capturePlan = prepareRustCapture(
                    state,
                    sessionId,
                    lkgInputIds,
                    lkgInputKeys,
                    pendingWireCache.rawContentSnapshots,
                    output.messages,
                    rowVersion,
                );
                let captureMode = "async";
                const captureFailed = (mode: "async" | "sync", error: unknown): void => {
                    if (
                        states.get(sessionId) !== state ||
                        (capturePlan && capturePlan.captureSequence !== state.lkgCaptureSequence)
                    ) {
                        return;
                    }
                    dropSlot(sessionId, `lkg_${mode}_capture_failed`);
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
                    if (cacheBustingPass) throw error;
                } else if (cacheBustingPass || state.lkgSyncCaptureRequired) {
                    captureMode = cacheBustingPass ? "sync_priced" : "sync_recovery";
                    try {
                        commitRustCapture(state, capturePlan, cacheBustingPass);
                    } catch (error) {
                        captureFailed("sync", error);
                        if (cacheBustingPass) throw error;
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
                try {
                    await sendNoteDeliveryDisposition("transform.nack");
                } catch (nackError) {
                    sessionLog(sessionId, "rust note delivery nack failed (ignored):", nackError);
                }
                throw error;
            }
            const bookkeepingStartedAt = performance.now();
            if (cacheBustingPass) {
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
            const deliveryStartedAt = performance.now();
            if (deliveryPassIds.length > 0) {
                try {
                    await sendNoteDeliveryDisposition("transform.ack");
                } catch (ackError) {
                    // Leave the delivery unacknowledged when the acknowledgement transport
                    // fails; the module will re-serve those bytes on a later natural bust.
                    sessionLog(sessionId, "rust note delivery ack failed (will retry):", ackError);
                }
            }
            timings.delivery += performance.now() - deliveryStartedAt;
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
            // A frozen LKG representation is not the module's acknowledged native prefix, so
            // output deltas cannot safely splice against it. Full transport resumes deltas only
            // after a cache-busting pass adopts the module representation.
            state.forceFullWire = state.lkgRepresentationFrozen;

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
            if (timings.todoProbe > 0) state.todoProbeIdentity = todoProbeIdentity;
            state.todoProbeNextPass =
                response.reconcile_pending === true ||
                (isRecord(response.historian) && response.historian.fired === true);
            state.lastAppliedAtMs = requestObservedAtMs;
            heapHolder.wireCaches.set(sessionId, pendingWireCache);
            timings.bookkeeping += performance.now() - bookkeepingStartedAt - timings.delivery;
            appliedAt = performance.now();
            // Stable transform projections cannot have new module-owned mirror rows. A changed
            // row/boundary/manifest marker schedules one ordered background pull; old modules that
            // omit row_version keep the compatibility behavior of polling after every pass.
            const projectionKey =
                options.disableHotPathIoCachesForTests === true
                    ? null
                    : mirrorProjectionKey(response);
            const getCompartmentsAfter = options.moduleClient.getCompartmentsAfter;
            const memoryMirrorDue =
                options.moduleClient.mirrorPull !== undefined &&
                (memorySyncRequested ||
                    projectionKey === null ||
                    state.memoryMirrorProjectionKey !== projectionKey);
            const compartmentMirrorDue =
                getCompartmentsAfter !== undefined &&
                (projectionKey === null || state.compartmentMirrorProjectionKey !== projectionKey);
            if ((memoryMirrorDue || compartmentMirrorDue) && !state.mirrorProjectionInFlight) {
                state.mirrorProjectionInFlight = true;
                void (async () => {
                    if (memoryMirrorDue) {
                        const mirrorPullStartedAt = performance.now();
                        try {
                            const mirrorDrain = await pullMemoryMirrorOnce({
                                db: deps.db,
                                module: options.moduleClient,
                            });
                            if (mirrorDrain.cuePoolVersion !== state.muralCuePoolVersion) {
                                state.muralCuePoolVersion = mirrorDrain.cuePoolVersion;
                                state.muralCache = null;
                            }
                            if (mirrorDrain.complete) {
                                state.memoryMirrorProjectionKey = projectionKey;
                            } else if (mirrorDrain.budgetExhausted) {
                                sessionLog(
                                    sessionId,
                                    `rust memory mirror backlog deferred: rows_applied=${mirrorDrain.rowsApplied} backlog_remaining=true pages=${mirrorDrain.pagesPulled}`,
                                );
                            }
                        } catch (error) {
                            sessionLog(
                                sessionId,
                                "rust memory mirror-back failed (ignored):",
                                error,
                            );
                        } finally {
                            logStage(sessionId, "mirrorPull", mirrorPullStartedAt, timings);
                        }
                    }
                    if (compartmentMirrorDue && getCompartmentsAfter) {
                        const compartmentMirrorStartedAt = performance.now();
                        try {
                            await mirrorModuleCompartments({
                                db: deps.db,
                                sessionId,
                                reader: {
                                    getCompartmentsAfter: (mirroredSessionId, afterSequence) =>
                                        getCompartmentsAfter.call(
                                            options.moduleClient,
                                            mirroredSessionId,
                                            afterSequence,
                                        ),
                                } satisfies ModuleCompartmentReader,
                            });
                            state.compartmentMirrorProjectionKey = projectionKey;
                        } catch (error) {
                            sessionLog(
                                sessionId,
                                "rust compartment mirror-back failed (ignored):",
                                error,
                            );
                        } finally {
                            logStage(
                                sessionId,
                                "compartmentMirror",
                                compartmentMirrorStartedAt,
                                timings,
                            );
                        }
                    }
                })().finally(() => {
                    state.mirrorProjectionInFlight = false;
                });
            }
            finishPass(true);
        } catch (error) {
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
                // At 95% of a trusted limit, or while provider overflow recovery is armed,
                // any adapter failure aborts. Parking controls retry cadence, not fallback admission.
                sessionLog(sessionId, "mc_rust_emergency_refusal before_lkg");
                markFailure(sessionId, state, error);
                finishPass(false, false);
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
            if (replayed) {
                if (!state.lkgRepresentationFrozen) {
                    state.lkgFrozenAtInputCount = inputCount;
                }
                state.lkgRepresentationFrozen = true;
                state.lkgFrozenHealthyPasses = 0;
                state.forceFullWire = true;
            } else {
                state.lkgRepresentationFrozen = false;
                state.lkgFrozenHealthyPasses = 0;
                state.lkgFrozenAtInputCount = null;
            }
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

    return {
        run,
        async clearSession(sessionId: string): Promise<void> {
            const projectRoot =
                states.get(sessionId)?.memoryAuthorityRoot ?? options.projectRoot ?? null;
            const clearLocalState = () => {
                dropSlot(sessionId, "session-deleted");
                states.delete(sessionId);
                heapHolder.wireCaches.delete(sessionId);
                promptSurfaceGuidanceEpochs?.clear(sessionId);
                clearCompartmentMirrorCursor(sessionId);
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
    };
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
    authoritySeedRows,
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
    formatRustPassLog,
    formatRustInputCoverageLog,
    materializedCompactionBoundary,
    shouldDisarmRustEmergencyRecovery,
    createRustModeTransform,
    directiveTextOf,
    prepareRustMemoryAuthority,
};
