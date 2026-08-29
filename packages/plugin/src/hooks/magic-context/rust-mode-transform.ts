import { createHash } from "node:crypto";

import {
    type AuthorityDrainResponse,
    type AuthorityModuleClient,
    type AuthorityStatus,
    checksumAuthoritySeedRows,
    drainAuthority,
    ensureContextStoreUuid,
    prepareAuthority,
    pullMemoryMirrorOnce,
    reconcileAuthorityProject,
} from "../../features/magic-context/context-authority";
import { DEFAULT_PROTECTED_TAGS } from "../../features/magic-context/defaults";
import {
    resolveProjectIdentity,
    resolveProjectIdentityForSession,
} from "../../features/magic-context/memory/project-identity";
import { getMemoryVerifications } from "../../features/magic-context/memory/storage-memory-verifications";
import { resolveMuralWire } from "../../features/magic-context/mural/render-trigger";
import { recordSessionProjectIdentity } from "../../features/magic-context/session-project-storage";
import type { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import {
    casChannel2NudgeState,
    clearEmergencyRecovery,
    clearPersistedTodoSyntheticAnchor,
    getChannel2NudgeState,
    getEmergencyRecoveryArmedAt,
    getOverflowState,
    getPersistedTodoPermissionDenied,
    isEmergencyRecoveryArmed,
    isProviderOverflowReconfirmed,
    loadProtectedTailMeta,
    setPersistedTodoPermissionDenied,
    setPersistedTodoSyntheticAnchor,
} from "../../features/magic-context/storage-meta-persisted";
import { writeRustTransformDecision } from "../../features/magic-context/transform-decision-log";
import type { ContextUsage } from "../../features/magic-context/types";
import { piModelRefToCanonical } from "../../shared/harness-provider-map";
import { sessionLog } from "../../shared/logger";
import { promptSurfaceConfigIdentity, resolvePromptSurface } from "../../shared/prompt-surface";
import type { WindowGeometryResult } from "../../shared/window-geometry";
import {
    cachedToolPermissionDenied,
    resolveCtxReduceAvailability,
    resolveTodowriteAvailability,
    resolveTodowriteAvailabilityFromMessages,
    type ToolAvailabilityVerdict,
    todowritePermissionDenied,
} from "./ctx-reduce-availability";
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
    type LkgContentField,
    type LkgEntryNote,
    noteEntry,
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
    TRANSFORM_COLD_START_EXECUTE_TIMEOUT_MS,
    TRANSFORM_PAGE_UPLOAD_TIMEOUT_MS,
} from "./module-transport";
import {
    buildPagedModuleTransformPayloads,
    encodeOpenCodeMessagesToCk,
    resolveOrdinalsForModule,
} from "./module-wire";
import { RECOVERY_NO_HEAD_LIMIT } from "./protected-tail-boundary";
import { RawFallbackContextLimitError } from "./raw-fallback-context-limit";
import { findLastAssistantModelFromOpenCodeDb, isMidTurn } from "./read-session-db";
import type { RawMessageOrdinalAnchor } from "./read-session-raw";
import { computeSyntheticCallId, normalizeTodoStateJson } from "./todo-view";
import type { TransformDeps } from "./transform";
import { resolveHistoryBudgetTokens } from "./transform";
import { loadContextUsage } from "./transform-context-state";
import type { MessageLike } from "./transform-operations";
import { runRustModePostprocess } from "./transform-postprocess-phase";
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

export const RUST_FAILURE_PARK_THRESHOLD = 3;
export const RUST_PARK_RETRY_INTERVAL = 5;
export const RUST_EMERGENCY_WALL_PCT = 95;
export const RUST_PARK_PROBE_PRESSURE_BYPASS_PCT = 90;
const RUST_SEND_TIMEOUT_MS = 15_000;

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
): Promise<boolean> {
    if (!availability.frozen || !availability.callable || deps.compactionOff === true) return false;

    let permissionDenied =
        cachedToolPermissionDenied(sessionId, "todowrite") ??
        getPersistedTodoPermissionDenied(deps.db, sessionId) ??
        false;
    if (deps.client) {
        try {
            permissionDenied = await todowritePermissionDenied(
                deps.client,
                sessionId,
                activeAgentFromMessages(messages),
            );
            setPersistedTodoPermissionDenied(deps.db, sessionId, permissionDenied);
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

interface MessageContentSnapshot {
    signature: string;
    fields: LkgContentField[];
}

interface RustLkgCapturePlan {
    sessionId: string;
    inputIds: string[];
    inputSnapshots: readonly MessageContentSnapshot[];
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
    rawContentSnapshots: MessageContentSnapshot[];
    ckFingerprint: string;
    ckPrefixFingerprintBeforeLast: string;
    nativeFingerprint: string;
    nativePrefixFingerprintBeforeLast: string;
    fingerprint: string;
    /** Previous acknowledged module output. The array is reused by reference and supplies the
     * prefix for a validated native-output delta; eviction falls back to a full response. */
    nativeOutput?: unknown[];
}

interface RustSessionState extends ModuleStateSyncState {
    initialized: boolean;
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
    authorityMemorySyncSkipLogged?: boolean;
    lkgCaptureSequence: number;
    lkgLastCapturedRowVersion: number;
    lkgSyncCaptureRequired: boolean;
    /** A fallback replay is provider-visible output. Keep that exact representation until the
     * module authorizes a cache-busting pass instead of replacing it during a later defer. */
    lkgRepresentationFrozen: boolean;
}

export interface RustModeTransformOptions {
    moduleClient: RustModeModuleClient;
    hostClient?: unknown;
    projectRoot?: string;
    notifyParked?: (sessionId: string, message: string) => void;
    moduleTimeoutMs?: number;
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
    /** Override only to exercise raw-fallback estimator failures in tests. */
    rawFallbackEstimatorForTests?: typeof estimateFinalWireInputTokens;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object";
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

const FNV1A_32_OFFSET = 0x811c9dc5;
const FNV1A_32_PRIME = 0x01000193;

function updateFnv1a32(hash: number, value: string): number {
    let next = hash;
    for (let index = 0; index < value.length; index += 1) {
        next ^= value.charCodeAt(index);
        next = Math.imul(next, FNV1A_32_PRIME) >>> 0;
    }
    return next;
}

interface MessageContentFieldVisitor {
    field(value: LkgContentField): boolean;
    beginObject(): number | undefined;
    endObject(token: number, entryCount: number): boolean;
}

function isSnapshotObjectChild(value: unknown): boolean {
    return value !== undefined && typeof value !== "function" && typeof value !== "symbol";
}

function visitMessageContentFields(value: unknown, visitor: MessageContentFieldVisitor): boolean {
    if (value === null) return visitor.field(LKG_SNAPSHOT_NULL);
    if (typeof value === "string") {
        return visitor.field(LKG_SNAPSHOT_STRING) && visitor.field(value);
    }
    if (typeof value === "number") {
        return visitor.field(LKG_SNAPSHOT_NUMBER) && visitor.field(value);
    }
    if (typeof value === "boolean") {
        return visitor.field(LKG_SNAPSHOT_BOOLEAN) && visitor.field(value);
    }
    if (value === undefined || typeof value === "function" || typeof value === "symbol") {
        return visitor.field(LKG_SNAPSHOT_UNDEFINED);
    }
    if (Array.isArray(value)) {
        if (!visitor.field(LKG_SNAPSHOT_ARRAY) || !visitor.field(value.length)) return false;
        for (const item of value) {
            if (!visitMessageContentFields(item, visitor)) return false;
        }
        return true;
    }
    if (typeof value === "object") {
        if (!visitor.field(LKG_SNAPSHOT_OBJECT)) return false;
        const objectToken = visitor.beginObject();
        if (objectToken === undefined) return false;
        let entryCount = 0;
        for (const key in value) {
            if (!Object.hasOwn(value, key)) continue;
            const child = (value as Record<string, unknown>)[key];
            if (!isSnapshotObjectChild(child)) continue;
            entryCount += 1;
            if (
                !visitor.field(LKG_SNAPSHOT_KEY) ||
                !visitor.field(key) ||
                !visitMessageContentFields(child, visitor)
            ) {
                return false;
            }
        }
        return visitor.endObject(objectToken, entryCount);
    }
    return visitor.field(LKG_SNAPSHOT_UNDEFINED);
}

function messageContentFields(message: MessageLike): LkgContentField[] {
    const fields: LkgContentField[] = [];
    const complete = visitMessageContentFields(message, {
        field(value) {
            fields.push(value);
            return true;
        },
        beginObject() {
            const countIndex = fields.length;
            fields.push(0);
            return countIndex;
        },
        endObject(countIndex, entryCount) {
            fields[countIndex] = entryCount;
            return true;
        },
    });
    if (!complete) throw new Error("message content snapshot traversal stopped unexpectedly");
    return fields;
}

function signatureForFields(fields: readonly LkgContentField[]): string {
    let hash = FNV1A_32_OFFSET;
    for (const field of fields) {
        const value = typeof field === "symbol" ? (field.description ?? "") : String(field);
        hash = updateFnv1a32(hash, `${typeof field}:${value.length}:`);
        hash = updateFnv1a32(hash, value);
        hash = updateFnv1a32(hash, "\0");
    }
    return hash.toString(16).padStart(8, "0");
}

/** Capture an exact field snapshot plus its compact content-sensitive rolling hash. */
function messageContentSnapshot(message: MessageLike): MessageContentSnapshot {
    const fields = messageContentFields(message);
    return { signature: signatureForFields(fields), fields };
}

function contentSnapshotsFor(messages: readonly MessageLike[]): MessageContentSnapshot[] {
    return messages.map(messageContentSnapshot);
}

function messageMatchesContentSnapshot(
    message: MessageLike,
    snapshot: MessageContentSnapshot,
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
    prefixGuard: number;
    ordinalResolve: number;
    stateSync: number;
    clone: number;
    wireBuild: number;
    wireMessages: number;
    transport: number;
    transportPages: number;
    transportBytes: number;
    apply: number;
    lkgSnapshot: number;
    mirrorPull: number;
    compartmentMirror: number;
}

function emptyRustPassTimings(): RustPassTimings {
    return {
        prefixGuard: 0,
        ordinalResolve: 0,
        stateSync: 0,
        clone: 0,
        wireBuild: 0,
        wireMessages: 0,
        transport: 0,
        transportPages: 0,
        transportBytes: 0,
        apply: 0,
        lkgSnapshot: 0,
        mirrorPull: 0,
        compartmentMirror: 0,
    };
}

function formatRustPassLog(args: {
    decision: string;
    reason: string;
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
        timings.prefixGuard +
        timings.ordinalResolve +
        timings.stateSync +
        timings.clone +
        timings.wireBuild +
        timings.transport +
        timings.apply +
        timings.lkgSnapshot;
    // Mirror stages run after appliedAt and are excluded from elapsed, so they
    // must not be subtracted into `other` or they would hide leftover serve work.
    const unattributed = Math.max(0, args.elapsedMs - measured);
    const rowVersion = Number.isSafeInteger(args.rowVersion) ? args.rowVersion : 0;
    return `rust pass: decision=${args.decision} reason=${args.reason} served_from=${args.servedFrom} in=${args.inputCount} out=${args.outputCount} applied=${args.applied} row_version=${rowVersion} elapsed=${args.elapsedMs.toFixed(1)} ms module=${args.moduleElapsedMs.toFixed(1)} ms stages=prefix_guard:${timings.prefixGuard.toFixed(1)} ordinal_resolve:${timings.ordinalResolve.toFixed(1)} state_sync:${timings.stateSync.toFixed(1)} clone:${timings.clone.toFixed(1)} wire_build:${timings.wireBuild.toFixed(1)} wire_messages:${timings.wireMessages} transport:${timings.transport.toFixed(1)} transport_pages:${timings.transportPages} transport_bytes:${timings.transportBytes} apply:${timings.apply.toFixed(1)} lkg_snapshot:${timings.lkgSnapshot.toFixed(1)} mirror_pull:${timings.mirrorPull.toFixed(1)} compartment_mirror:${timings.compartmentMirror.toFixed(1)} other:${unattributed.toFixed(1)}`;
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
    // The failure arm names WHICH clause failed and what the head actually was:
    // without it, every violation reads identically and the defect is
    // undiagnosable from logs alone (a live incident required a binary
    // bisect that a single log line would have answered).
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
            authorityMemorySyncSkipLogged: false,
            lkgCaptureSequence: 0,
            lkgLastCapturedRowVersion: 0,
            lkgSyncCaptureRequired: false,
            lkgRepresentationFrozen: false,
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
            await prepareAuthority({
                db,
                projectPath,
                domains: preparing,
                module: authorityModule,
                seedPages: async (domain) => authoritySeedRows(db, projectPath, domain),
                checksum: (_domain, rows) => checksumAuthoritySeedRows(rows),
            });
        }
    }

    await reconcileAuthorityProject({ db, projectPath, module: authorityModule });
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
    systemPromptHash: string;
    upgradeState: string;
    midTurn: boolean;
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
        // Model/provider and system-prompt changes are provider-cache eviction signals;
        // send the same identity inputs used by the TypeScript materializer instead of
        // leaving the native identity blank.
        render_config: [
            args.providerId ? `provider:${args.providerId}` : "",
            args.modelKey ? `model:${args.modelKey}` : "",
            args.systemPromptHash ? `system:${args.systemPromptHash}` : "",
        ]
            .filter(Boolean)
            .join("|"),
        system_prompt_hash: args.systemPromptHash,
        upgrade_state: args.upgradeState,
        is_subagent: args.passInputs.is_subagent === true,
        protected_tags: args.passInputs.protected_tags ?? DEFAULT_PROTECTED_TAGS,
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
        mid_turn: args.midTurn,
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
        prompt_surface_preset: args.passInputs.prompt_surface_preset ?? "full",
        prompt_surface_model_key: args.passInputs.prompt_surface_model_key,
        prompt_surface_config_identity: args.passInputs.prompt_surface_config_identity,
        prompt_surface_tool_descriptions: args.passInputs.prompt_surface_tool_descriptions ?? {},
        prompt_surface_guidance_override: args.passInputs.prompt_surface_guidance_override,
        mural: args.passInputs.mural,
        effective_execute_threshold: args.passInputs.effective_execute_threshold,
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
    clearSession: (sessionId: string) => void;
    invalidateWireState: (sessionId: string) => void;
    getState: (sessionId: string) => Readonly<RustSessionState>;
} {
    const states = new Map<string, RustSessionState>();
    const wireCaches = new Map<string, RustWireCache>();
    const scheduleLkgCapture =
        options.scheduleLkgCapture ?? ((capture: () => void) => setImmediate(capture));
    const rawFallbackEstimator =
        options.rawFallbackEstimatorForTests ?? estimateFinalWireInputTokens;
    const timeoutMs = Math.max(1, options.moduleTimeoutMs ?? RUST_SEND_TIMEOUT_MS);

    const logStage = (
        sessionId: string,
        stage: keyof RustPassTimings,
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
        attemptTimeoutMs = timeoutMs,
    ): Promise<unknown> => {
        const controller = new AbortController();
        const timer = setTimeout(
            () => controller.abort(new Error("rust module request timed out")),
            attemptTimeoutMs,
        );
        try {
            return await options.moduleClient.call({ ...args, signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
    };

    const markFailure = (sessionId: string, state: RustSessionState, error: unknown): void => {
        state.consecutiveFailures += 1;
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
        wireCaches.delete(sessionId);
        const state = states.get(sessionId);
        if (!state) return;
        resetOrdinalMemo(state);
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
            sessionLog(sessionId, replay.reason);
            return false;
        }
        const replayModel =
            modelFromMessages(currentMessages) ?? findLastAssistantModelFromOpenCodeDb(sessionId);
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
        input: MessageLike[],
        inputSnapshots: readonly MessageContentSnapshot[],
        nativeMessages: readonly unknown[],
        responseRowVersion: number,
    ): RustLkgCapturePlan | null => {
        state.lkgCaptureSequence += 1;
        const inputIds = input.map((message) => message.info.id);
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
        const keys = resolveLkgModelKeys(input);
        return {
            sessionId,
            inputIds: inputIds as string[],
            inputSnapshots,
            jsonPrefix,
            modelKey: keys.modelKey,
            providerKey: keys.providerKey,
            capturedAt: Date.now(),
            rowVersion: responseRowVersion,
            captureSequence: state.lkgCaptureSequence,
        };
    };

    const commitRustCapture = (
        state: RustSessionState,
        plan: RustLkgCapturePlan,
    ): "captured" | "superseded" => {
        if (
            states.get(plan.sessionId) !== state ||
            plan.captureSequence !== state.lkgCaptureSequence ||
            plan.rowVersion < state.lkgLastCapturedRowVersion
        ) {
            return "superseded";
        }
        // Steady passes append one message onto an unchanged prefix. Reuse the
        // previous slot's digests for every id+content-signature match and hash
        // only from the first changed entry so the deferred commit stays off the
        // event-loop budget.
        const prior = getSlot(plan.sessionId);
        const inputContentSignatures = plan.inputSnapshots.map((snapshot) => snapshot.signature);
        const { digests: inputContentDigests } = incrementalLkgContentDigests(
            plan.inputIds.map((id, index) => ({
                id,
                signature: inputContentSignatures[index] ?? "",
                fields: plan.inputSnapshots[index]?.fields ?? [],
            })),
            prior?.inputContentSignatures
                ? {
                      ids: prior.inputIdSeq,
                      signatures: prior.inputContentSignatures,
                      digests: prior.inputContentDigests,
                  }
                : undefined,
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
        // Durability across restarts: store the exact accepted snapshot (the
        // jsonPrefix string is reused as-is, never re-serialized). Best-effort —
        // a write failure leaves the in-memory slot serving this process.
        saveLkgSlotToDb(deps.db, plan.sessionId, slot);
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
        let servedFrom = "none";
        let moduleElapsedMs = 0;
        let rowVersion = 0;
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
            ? piModelRefToCanonical(resolveModelKey(model.providerID, model.modelID) ?? "")
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
            hardWallUsagePercentage(passUsageSnapshot, transformGeometry) >=
                RUST_EMERGENCY_WALL_PCT && hasTrustedEmergencyWall;
        if (overflowState) {
            const detectedLimitMatchesModel =
                overflowState.detectedContextLimitModelKey === null ||
                piModelRefToCanonical(overflowState.detectedContextLimitModelKey) ===
                    piModelRefToCanonical(modelKey ?? "");
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
                formatRustPassLog({
                    decision,
                    reason: materializeReason,
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
        const reduceAvailability = resolveCtxReduceAvailability(sessionId);
        // Freeze the native todo-tool map verdict before state sync reads it, then combine it
        // with OpenCode's live permission decision. The module receives one authoritative bool;
        // provisional or missing host evidence fails closed for synthesis.
        resolveTodowriteAvailabilityFromMessages(sessionId, messages);
        const todoAvailability = resolveTodowriteAvailability(sessionId);
        const toolPresent = reduceAvailability.frozen && reduceAvailability.callable;
        let todoToolPresent = false;
        try {
            todoToolPresent = await resolveCombinedTodowriteVerdict(
                deps,
                sessionId,
                messages,
                todoAvailability,
            );
        } catch (error) {
            preflightError ??= error;
        }
        try {
            if (preflightError) throw preflightError;
            if (!overflowState) throw new Error("rust overflow state unavailable");
            const { directory, resolvedFromHost } = await getSessionDirectory(deps, sessionId);
            if (resolvedFromHost) {
                const sessionProjectIdentity = resolveProjectIdentityForSession(
                    directory,
                    deps.allowHomeProject,
                );
                if (
                    sessionProjectIdentity &&
                    state.recordedSessionProjectIdentity !== sessionProjectIdentity
                ) {
                    // Missing chunk embeddings are restored through the session's
                    // host-owned project binding, not through Rust module state.
                    recordSessionProjectIdentity(deps.db, sessionId, sessionProjectIdentity);
                    state.recordedSessionProjectIdentity = sessionProjectIdentity;
                }
            }
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
            const midTurn = isMidTurn(deps, sessionId);
            const requestObservedAtMs = Date.now();
            const recoveryNoHeadEscape =
                overflowState.needsEmergencyRecovery &&
                loadProtectedTailMeta(deps.db, sessionId).recoveryNoEligibleHeadCount >=
                    RECOVERY_NO_HEAD_LIMIT;
            const promptSurfaceGuidance = deps.promptSurfaceRuntime?.resolveGuidance(
                deps.promptSurface,
                modelKey ?? undefined,
            );
            const promptSurface =
                promptSurfaceGuidance ??
                resolvePromptSurface(deps.promptSurface, modelKey ?? undefined);
            const resolvedMural =
                !sessionMeta.isSubagent && deps.muralEnabled === true
                    ? resolveMuralWire(
                          deps.db,
                          deps.projectPath,
                          modelKey ?? undefined,
                          true,
                          deps.memoryConfig?.injectionBudgetTokens,
                      )
                    : undefined;
            const mural = muralInputForWire(resolvedMural);
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
                mid_turn: midTurn,
                is_subagent: sessionMeta.isSubagent,
                system_prompt_hash: sessionMeta.systemPromptHash ?? "",
                upgrade_state: readUpgradeState(deps.db, sessionId),
                tool_present: toolPresent,
                todo_tool_present: todoToolPresent,
                prompt_surface_preset: promptSurface.preset,
                prompt_surface_model_key: modelKey,
                prompt_surface_config_identity: promptSurfaceConfigIdentity(deps.promptSurface),
                prompt_surface_tool_descriptions: deps.promptSurface?.tool_descriptions ?? {},
                prompt_surface_guidance_override: promptSurfaceGuidance?.primaryOverride,
                mural,
                protected_tags: deps.protectedTags ?? DEFAULT_PROTECTED_TAGS,
                temporal_awareness: deps.experimentalTemporalAwareness === true,
                channel2_nudge_state: getChannel2NudgeState(deps.db, sessionId),
                emergency_recovery_armed:
                    overflowState.needsEmergencyRecovery || isEmergencyRecoveryArmed(sessionId),
                emergency_recovery_no_head_escape: recoveryNoHeadEscape,
                detected_context_limit: overflowState.detectedContextLimit,
                detected_context_limit_model_key: overflowState.detectedContextLimitModelKey,
            };
            const previousWireCache = wireCaches.get(sessionId);
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
                projectPath:
                    deps.memoryConfig?.enabled && directory.length > 0
                        ? resolveProjectIdentity(directory)
                        : deps.projectPath,
                nowMs: Date.now(),
            };
            const projectRoot = options.projectRoot ?? directory;
            const memoryProjectPath =
                deps.memoryConfig?.enabled && directory.length > 0
                    ? resolveProjectIdentity(directory)
                    : deps.projectPath;
            const stateSyncStartedAt = performance.now();
            const authoritySeqAdoption = { used: false };
            let stateSyncRetryBusy = false;
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
                if (options.memorySyncRequestedSessions?.delete(sessionId)) {
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
                    },
                });
                stateSyncRetryBusy = stateSyncResult.status === "retry_busy";
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
                systemPromptHash: sessionMeta.systemPromptHash ?? "",
                upgradeState: String(passInputs.upgrade_state ?? ""),
                midTurn,
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
                const pages = buildPagedModuleTransformPayloads(payload);
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
                                ? TRANSFORM_COLD_START_EXECUTE_TIMEOUT_MS
                                : attemptClass === "transform_page_upload"
                                  ? TRANSFORM_PAGE_UPLOAD_TIMEOUT_MS
                                  : timeoutMs);
                        moduleResponse = await callModule(
                            {
                                sessionId,
                                projectRoot,
                                method: "transform",
                                body: page,
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
                    // A module restart can retain durable state while changing the accepted
                    // state-sync shape, so the next sync must re-probe its capabilities.
                    options.moduleClient.invalidateStateSyncCapabilities?.();
                } else {
                    sessionLog(
                        sessionId,
                        "native_delta_fallback_reason=adapter_response_omitted_native_content retry=full",
                    );
                }
                // A wire-cache miss or an invalid successful response says nothing about
                // context.db state. Retry the transform with complete arrays, but do not
                // re-seed durable state; that costs tens of seconds on giant sessions.
                state.forceFullWire = true;
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
                        midTurn,
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
                const retryWireBuildStartedAt = performance.now();
                response = await sendTransformSeriesWithSingleRestart(body, " retry=full");
                logStage(sessionId, "wireBuild", retryWireBuildStartedAt, timings, "retry=full");
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
                typeof response.decision === "string" ||
                typeof response.action === "string" ||
                typeof response.cache_bust === "boolean";
            const decisionUpper = decision.toUpperCase();
            const cacheBustingPass =
                response.cache_bust === true ||
                decisionUpper === "HARD" ||
                decisionUpper === "MIGRATE_HARD" ||
                decisionUpper === "EXECUTE" ||
                // SOFT re-renders m1 (delta folds, coverage folds): the served bytes changed,
                // so the previous last-known-good (LKG) snapshot is already stale.
                decisionUpper === "SOFT" ||
                !explicitDecision;
            let appliedMessages: unknown[];
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
                let replayedFrozenRepresentation = false;
                if (state.lkgRepresentationFrozen && !cacheBustingPass) {
                    const keys = resolveLkgModelKeys(messages);
                    const frozen = replayLkg({
                        sessionId,
                        messages,
                        modelKey: keys.modelKey,
                        providerKey: keys.providerKey,
                    });
                    if (!frozen.ok) {
                        throw new Error(
                            `frozen LKG representation cannot replay on a defer pass: ${frozen.reason}`,
                        );
                    }
                    appliedMessages = frozen.messages;
                    replayedFrozenRepresentation = true;
                    servedFrom = "lkg_frozen";
                    sessionLog(sessionId, "lkg_frozen_replay_served");
                } else {
                    appliedMessages = moduleMessages;
                }
                pendingWireCache.nativeOutput = appliedMessages;
                // LKG captures postprocessed output, so running postprocess again would stop the
                // fallback artifact from being an exact replay.
                if (!replayedFrozenRepresentation) {
                    runRustModePostprocess({
                        db: deps.db,
                        sessionId,
                        messages: appliedMessages as MessageLike[],
                        projectPath: memoryProjectPath,
                        fullFeatureMode: !sessionMeta.isSubagent,
                        compactionOff: deps.compactionOff,
                        tagger: deps.tagger,
                        ctxReduceAvailability: reduceAvailability,
                    });
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
                const lkgSnapshotStartedAt = performance.now();
                // When the response changes the served bytes, discard the previous last-known-good
                // snapshot before scheduling the new capture. Otherwise, a transport failure on the
                // next turn could replay obsolete output.
                if (cacheBustingPass) {
                    dropSlot(sessionId, "lkg_cache_bust_pending_capture");
                }
                // Reuse the wire-cache field snapshots for this input. Serialize the served
                // response here, but defer hashing so LKG work does not block installing the result.
                const capturePlan = prepareRustCapture(
                    state,
                    sessionId,
                    messages,
                    pendingWireCache.rawContentSnapshots,
                    appliedMessages,
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
                    state.lkgSyncCaptureRequired = true;
                    sessionLog(
                        sessionId,
                        `LKG ${mode.toUpperCase()} CAPTURE FAILED; forcing synchronous capture on the next applied pass:`,
                        error,
                    );
                };
                if (!capturePlan) {
                    captureMode = "declined";
                    captureFailed("async", new Error("LKG snapshot preparation was rejected"));
                } else if (state.lkgSyncCaptureRequired) {
                    captureMode = "sync_recovery";
                    try {
                        commitRustCapture(state, capturePlan);
                    } catch (error) {
                        captureFailed("sync", error);
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
                const applyReplaceStartedAt = performance.now();
                replaceMessagesInPlace(output, appliedMessages);
                logStage(sessionId, "apply", applyReplaceStartedAt, timings);
            } catch (error) {
                logStage(sessionId, "apply", applyStartedAt, timings, "failed=true");
                try {
                    await sendNoteDeliveryDisposition("transform.nack");
                } catch (nackError) {
                    sessionLog(sessionId, "rust note delivery nack failed (ignored):", nackError);
                }
                throw error;
            }
            if (cacheBustingPass) {
                state.lkgRepresentationFrozen = false;
            }
            try {
                mirrorRustRenderedMemoryIds({ db: deps.db, sessionId, response });
            } catch (error) {
                sessionLog(sessionId, "rust rendered-memory mirror write failed (ignored):", error);
            }
            if (deliveryPassIds.length > 0) {
                try {
                    await sendNoteDeliveryDisposition("transform.ack");
                } catch (ackError) {
                    // Leave the delivery unacknowledged when the acknowledgement transport
                    // fails; the module will re-serve those bytes on a later natural bust.
                    sessionLog(sessionId, "rust note delivery ack failed (will retry):", ackError);
                }
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
            wireCaches.set(sessionId, pendingWireCache);
            appliedAt = performance.now();
            // Mirrors feed later RPC reads and tolerate seconds of staleness. Run the two pulls in
            // their established order, but do not keep the transform hook pending while a backlog
            // page or SQLite apply is slow. pullMemoryMirrorOnce still coalesces overlapping passes.
            const getCompartmentsAfter = options.moduleClient.getCompartmentsAfter;
            if (options.moduleClient.mirrorPull || getCompartmentsAfter) {
                void (async () => {
                    if (options.moduleClient.mirrorPull) {
                        const mirrorPullStartedAt = performance.now();
                        try {
                            await pullMemoryMirrorOnce({
                                db: deps.db,
                                module: options.moduleClient as AuthorityModuleClient,
                            });
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
                    if (getCompartmentsAfter) {
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
                })();
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
            state.lkgRepresentationFrozen = replayed;
            if (replayed) state.forceFullWire = true;
            servedFrom = replayed ? "lkg" : "raw";
            if (decision.toLowerCase() !== "need_full_sync") decision = "error";
            materializeReason = "none";
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
        clearSession(sessionId: string): void {
            const projectRoot =
                states.get(sessionId)?.memoryAuthorityRoot ?? options.projectRoot ?? null;
            dropSlot(sessionId, "session-deleted");
            states.delete(sessionId);
            wireCaches.delete(sessionId);
            clearCompartmentMirrorCursor(sessionId);
            if (projectRoot && options.moduleClient.deleteSession) {
                void options.moduleClient
                    .deleteSession(sessionId, projectRoot)
                    .catch((error) => {
                        sessionLog(sessionId, "rust module session deletion failed:", error);
                    })
                    .finally(() => options.moduleClient.closeSession?.(sessionId));
            } else {
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
    shouldDisarmRustEmergencyRecovery,
    createRustModeTransform,
    directiveTextOf,
    prepareRustMemoryAuthority,
};
