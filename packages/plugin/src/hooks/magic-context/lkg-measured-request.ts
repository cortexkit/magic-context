import { createHash } from "node:crypto";
import { getMeasuredToolDefinitionTokens } from "../../features/magic-context/tool-definition-tokens";
import { BoundedSessionMap } from "../../shared/bounded-session-map";
import { providerResponseFailed } from "../../shared/provider-response-completion";
import type { LkgSlot } from "./lkg-slot";
import {
    acknowledgeSystemPromptDelivery,
    clearSystemPromptDelivery,
} from "./system-prompt-delivery";
import type { MessageLike } from "./transform-operations";

export type LkgRequestIdentity =
    | { kind: "v1"; responseId: string; modelKey: string }
    | {
          kind: "v2";
          previousResponseId: string | undefined;
          startedAt: number;
          modelKey: string;
          responseAfterSequence?: number;
      };

const requests = new BoundedSessionMap<LkgRequestIdentity>(1000);
const claimedRequests = new WeakSet<LkgRequestIdentity>();
/** The identity each session's current request replaced. Only the newest link is
 * kept: the replaced identity's own link is dropped, so older identities are not
 * retained through a chain. */
const predecessors = new WeakMap<LkgRequestIdentity, LkgRequestIdentity>();

function setRequest(sessionId: string, request: LkgRequestIdentity): void {
    const previous = requests.get(sessionId);
    if (previous) {
        predecessors.set(request, previous);
        predecessors.delete(previous);
    }
    requests.set(sessionId, request);
}

/** True when `candidate` is `request` or the identity `request` directly replaced
 * as its session's current request. */
export function isSameOrPreviousLkgRequest(
    request: LkgRequestIdentity | undefined,
    candidate: LkgRequestIdentity | undefined,
): boolean {
    if (!request || !candidate) return false;
    return candidate === request || candidate === predecessors.get(request);
}
/** Identity of a served request's system/tool envelope, compared before its usage
 * may bound a later request's envelope (see standalone-marker-envelope.ts). */
export interface LkgMarkerIdentity {
    model: string;
    systemDigest: string;
    toolNames: readonly string[];
}

const captures = new BoundedSessionMap<{
    request: LkgRequestIdentity;
    slot: string;
    prefixCount: number;
    envelope: string;
    /** The exact message array returned to the host for this request. Set only when
     * `marker` is, so a reading never subtracts messages the host did not receive. */
    jsonPrefix?: string;
    marker?: LkgMarkerIdentity;
    usage?: { responseId: string; inputTokens: number };
}>(1000);

export function lkgProviderInputTotal(tokens?: {
    input?: number;
    cache?: { read?: number; write?: number };
}): number {
    const counts = [tokens?.input ?? 0, tokens?.cache?.read ?? 0, tokens?.cache?.write ?? 0];
    return counts.every((count) => Number.isSafeInteger(count) && count >= 0)
        ? counts.reduce((sum, count) => sum + count, 0)
        : Number.NaN;
}

function identity(slot: LkgSlot): string {
    return createHash("sha256")
        .update(
            JSON.stringify([
                slot.capturedAt,
                slot.captureSequence,
                slot.rowVersion,
                slot.modelKey,
                slot.providerKey,
                slot.inputIdSeq,
                slot.inputContentDigests,
            ]),
        )
        .update(slot.jsonPrefix)
        .digest("hex");
}

function envelope(
    modelKey: string,
    systemPromptTokens: number,
    agentName: string | undefined,
    sessionId: string,
): string {
    const slash = modelKey.indexOf("/");
    return JSON.stringify([
        modelKey,
        systemPromptTokens,
        agentName,
        getMeasuredToolDefinitionTokens(
            modelKey.slice(0, slash),
            modelKey.slice(slash + 1),
            agentName,
            sessionId,
        ),
    ]);
}

/** On OpenCode 2 the assistant reply row for a request is only created after the
 * context hook has run, so the request is remembered by the reply row that came
 * before it. Usage read later from that earlier row belongs to the previous
 * request and must never be credited to this one. */
export function beginV2LkgRequest(
    sessionId: string,
    modelKey: string,
    previousResponseId?: string,
    responseAfterSequence?: number,
): void {
    setRequest(sessionId, {
        kind: "v2",
        previousResponseId,
        startedAt: Date.now(),
        modelKey,
        responseAfterSequence,
    });
}

/** Take the request identity when the request is prepared, not when its saved
 * copy (last-known-good request) is committed: in Rust mode that commit can
 * finish after the next turn has already started, and that turn's identity
 * must not be attached to this request's copy. */
export function claimLkgRequestIdentity(sessionId: string): LkgRequestIdentity | undefined {
    const request = requests.get(sessionId);
    if (!request || claimedRequests.has(request)) return;
    claimedRequests.add(request);
    return request;
}

export function currentLkgRequestIdentity(sessionId: string): LkgRequestIdentity | undefined {
    return requests.get(sessionId);
}

/** True when `request` is the session's current request identity or the one it
 * directly replaced. The system-prompt hook records each request's final system
 * strings under the identity current at that moment, and the messages transform
 * reads them back. On OpenCode 1 the messages transform runs before the system
 * hook, so it can only read what the previous request's hook recorded. On
 * OpenCode 2 the context hook starts a second identity after its system stage and
 * before the transform, so the recording carries the identity just replaced. */
export function isCurrentOrPreviousLkgRequest(
    sessionId: string,
    request: LkgRequestIdentity | undefined,
): boolean {
    const current = requests.get(sessionId);
    if (!request || !current) return false;
    return request === current || request === predecessors.get(current);
}

export function noteCapturedLkgRequest(args: {
    sessionId: string;
    slot: LkgSlot;
    /** Length of the plain output array serialized into this slot, when already known. */
    prefixMessageCount?: number;
    request?: LkgRequestIdentity;
    systemPromptTokens: number;
    agentName?: string;
    /** Only for the array actually returned to the host. Once this request completes,
     * its usage can bound the system/tool envelope of later requests. */
    marker?: LkgMarkerIdentity;
}): void {
    const request = args.request;
    if (!request || request.modelKey !== args.slot.modelKey) {
        captures.delete(args.sessionId);
        return;
    }
    captures.set(args.sessionId, {
        request,
        slot: identity(args.slot),
        prefixCount:
            args.prefixMessageCount ?? (JSON.parse(args.slot.jsonPrefix) as unknown[]).length,
        envelope: envelope(
            request.modelKey,
            args.systemPromptTokens,
            args.agentName,
            args.sessionId,
        ),
        ...(args.marker ? { marker: args.marker, jsonPrefix: args.slot.jsonPrefix } : {}),
    });
}

interface LkgMarkerReading {
    responseId: string;
    inputTokens: number;
    jsonPrefix: string;
    marker: LkgMarkerIdentity;
}

// The most recent successfully completed request per session, frozen when its
// usage is attributed. A newer request that has only been captured leaves it in
// place; the next successful completion replaces it, or clears it when that
// request's returned array or envelope identity is unknown.
const markerReadings = new BoundedSessionMap<LkgMarkerReading>(1000);

/** Usage, returned message array and envelope identity of the session's most
 * recent successfully completed request, when all three are known. */
export function lkgMarkerReading(sessionId: string): LkgMarkerReading | undefined {
    return markerReadings.get(sessionId);
}

/** Test helper: install a completed-request reading without a provider response. */
export function __setLkgMarkerReadingForTests(sessionId: string, reading: LkgMarkerReading): void {
    markerReadings.set(sessionId, reading);
}

/** Record the provider's measured input size (cache reads and writes, system
 * prompt and tools included) against the exact request whose bytes were saved
 * as the last-known-good request. The session's most recent usage reading may
 * belong to a different request, so it is never used in its place. */
export function noteLkgProviderResponse(args: {
    sessionId: string;
    responseId?: string;
    modelKey?: string;
    inputTokens: number;
    completedAt?: number;
    finish?: string;
    error?: unknown;
    v2?: boolean;
    createdAt?: number;
}): void {
    if (!args.responseId || !args.modelKey) return;
    if (!args.v2 && args.inputTokens === 0 && !args.completedAt && !args.finish && !args.error) {
        const previous = requests.get(args.sessionId);
        if (
            previous?.kind === "v1" &&
            previous.responseId === args.responseId &&
            previous.modelKey === args.modelKey
        )
            return;
        setRequest(args.sessionId, {
            kind: "v1",
            responseId: args.responseId,
            modelKey: args.modelKey,
        });
        return;
    }
    acknowledgeSystemPromptDelivery({ ...args, request: requests.get(args.sessionId) });
    const succeeded =
        Number.isSafeInteger(args.inputTokens) &&
        args.inputTokens > 0 &&
        !providerResponseFailed(args) &&
        Boolean(args.completedAt || args.finish);
    // Any other successful completion becomes the most recent completed request;
    // an unattributable one leaves no envelope reading. Repeated updates of the
    // reading's own response keep it.
    if (succeeded && markerReadings.get(args.sessionId)?.responseId !== args.responseId)
        markerReadings.delete(args.sessionId);
    const capture = captures.get(args.sessionId);
    if (
        !capture ||
        capture.usage ||
        capture.request.modelKey !== args.modelKey ||
        !Number.isSafeInteger(args.inputTokens) ||
        args.inputTokens <= 0 ||
        providerResponseFailed(args) ||
        (!args.completedAt && !args.finish)
    )
        return;
    const request = capture.request;
    if (request.kind === "v1") {
        if (args.v2 || request.responseId !== args.responseId) return;
    } else if (
        !args.v2 ||
        requests.get(args.sessionId) !== request ||
        request.previousResponseId === args.responseId ||
        args.createdAt === undefined ||
        args.createdAt < request.startedAt
    )
        return;
    capture.usage = { responseId: args.responseId, inputTokens: args.inputTokens };
    if (capture.marker && capture.jsonPrefix !== undefined)
        markerReadings.set(args.sessionId, {
            responseId: args.responseId,
            inputTokens: args.inputTokens,
            jsonPrefix: capture.jsonPrefix,
            marker: capture.marker,
        });
}

export function measuredLkgPrefix(args: {
    sessionId: string;
    slot: LkgSlot | undefined;
    messages: readonly MessageLike[];
    modelKey: string;
    systemPromptTokens: number;
    agentName?: string;
}): { inputTokens: number; appendedMessages: readonly MessageLike[] } | undefined {
    const capture = captures.get(args.sessionId);
    if (
        !capture?.usage ||
        !args.slot ||
        capture.slot !== identity(args.slot) ||
        capture.request.modelKey !== args.modelKey ||
        capture.envelope !==
            envelope(args.modelKey, args.systemPromptTokens, args.agentName, args.sessionId)
    )
        return;
    const appendedMessages = args.messages.slice(capture.prefixCount);
    // The reply whose usage was recorded is itself new input on the replay. The
    // exact prefix check also rejects a reasoning strip or any other prefix edit.
    if (
        appendedMessages[0]?.info.id !== capture.usage.responseId ||
        appendedMessages[0]?.info.role !== "assistant" ||
        JSON.stringify(args.messages.slice(0, capture.prefixCount)) !== args.slot.jsonPrefix
    )
        return;
    return { inputTokens: capture.usage.inputTokens, appendedMessages };
}

export function clearLkgMeasuredRequest(sessionId: string): void {
    requests.delete(sessionId);
    captures.delete(sessionId);
    markerReadings.delete(sessionId);
    clearSystemPromptDelivery(sessionId);
}

/** A pass that rebuilds the cached prefix discards the previously saved request
 * before saving the current one. Only the saved measurement is cleared here: the
 * current response identity stays, so the new saved request can still be
 * matched to its usage when the reply arrives. */
export function clearCapturedLkgMeasurement(sessionId: string): void {
    captures.delete(sessionId);
}
