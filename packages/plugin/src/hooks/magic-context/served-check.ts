/**
 * The served check: a per-process record of the request each session last
 * returned to its host, and a comparison of every new request with it.
 *
 * It only measures. It never changes a byte of a request or any decision: a
 * pass without rebuild permission must only append to the request served
 * before it, and this check counts and logs how often that rule is broken and
 * where, so the next design step can be built on numbers.
 *
 * The record holds numbers only, never message content: for each
 * provider-visible message one 32-bit shape fingerprint and one 64-bit content
 * digest, plus the model key, the kind of request (a pass result, a last-good
 * replay, or the host's own input passed through) and the pass's rebuild
 * permission. A session this process has not served yet, and every session
 * after a restart, has no record: its state is unknown, never equal.
 *
 * The comparison has two tiers, because the host rebuilds every message object
 * on every pass and the pass edits them in place, so no message can be trusted
 * unchanged without being read again:
 *
 * - Tier 1, every pass, every message: a shape fingerprint mixed from the
 *   message's id and role, its part count, and per part its id, its type and
 *   the lengths of its strings (text, reasoning and its signature, tool output
 *   as it is sent, attachments). A tool's input is read shallowly (its type,
 *   or its length when it is a string or an array). It reads lengths and mixes
 *   integers; it hashes no content. It sees every edit that changes a length
 *   or a part (a drop placeholder, a stripped or cleared reasoning part, a
 *   removed image, a tag prefix, a re-rendered history head, a message added,
 *   removed or moved). It cannot see an edit that keeps every length, or one
 *   inside a tool's input object.
 * - Content digests of a handful of messages on every pass: the head (the first
 *   two messages and any further leading synthetic or summary rows), the last
 *   recorded message, the first message with kept signed thinking, and every
 *   new message.
 * - Tier 2, a content digest of every message: on every replay, on the first
 *   pass after a replay, whenever tier 1 or the handful of digests shows a
 *   difference (to name the first changed index precisely), and on every
 *   100th pass of a session, which samples tier 1's blind spot. A difference
 *   only tier 2 or the handful saw is logged as a same-shape change.
 *
 * Digests use the projection the last-good slot uses (`contentSnapshotValue`),
 * so tool state the provider never receives makes no difference.
 */
import { createHash } from "node:crypto";
import { isPrefixBoundThinkingModel } from "../../features/magic-context/overflow-detection";
import { BoundedSessionMap } from "../../shared/bounded-session-map";
import { sessionLog } from "../../shared/logger";
import { contentSnapshotValue } from "./lkg-slot";

export type ServedHost = "opencode" | "opencode2" | "pi";

/** What a request returned to the host was. */
export type ServedKind = "pass" | "replay" | "input";

/** A pass's rebuild permission as the pass computed it, with its inputs. */
export interface ServedPassPermission {
    /** `reclaimRidePermitted` (`publishedWorkDrainAllowed` in postprocess). */
    permitted: boolean;
    /** The ride signals that were set, as `reclaimRideLabel` prints them. */
    rides: string;
    signedThinkingHold: boolean;
    firstRender: boolean;
    hostCheckpointHead: boolean;
    emergency: boolean;
    schedulerDecision: string;
}

export type ServedComparisonClass =
    | "unknown"
    | "model_change"
    | "append_only"
    | "changed"
    | "shorter"
    | "refused";

/** Which part of the check first saw a difference. */
export type ServedSeenBy = "shape" | "digest" | "full" | "length";

export interface ServedComparison {
    class: ServedComparisonClass;
    kind: ServedKind;
    /** First changed index; for a shorter request, the new length. */
    firstIndex: number | null;
    recorded: number;
    served: number;
    seenBy: ServedSeenBy | null;
    /** Index of the first message with kept signed thinking in the new request, or -1. */
    keptThinkingIndex: number;
    /** The same index in the recorded request, or -1. */
    recordedThinkingIndex: number;
    permitted: boolean | null;
    events: string[];
}

interface ServedRecord {
    count: number;
    shapes: Uint32Array;
    /** Two words per message; 0,0 means the message could not be digested. */
    digests: Uint32Array;
    modelKey: string | null;
    kind: ServedKind;
    keptThinkingIndex: number;
    passesSinceFull: number;
}

interface PendingServe {
    permission?: ServedPassPermission;
    model?: { providerID: string; modelID: string };
    replay?: boolean;
    input?: boolean;
    refused?: boolean;
}

interface ServedCounters {
    commits: number;
    compared: number;
    unknown: number;
    refused: number;
    appendOnly: number;
    changed: number;
    shorter: number;
    modelChanged: number;
    unpermittedChange: number;
    mixedReplay: number;
    thinkingPrefixChange: number;
    sameShapeChange: number;
    fullChecks: number;
}

/** Work one comparison did, for the deterministic cost tests. */
export interface ServedCheckWork {
    fingerprinted: number;
    digested: number;
    full: boolean;
    /** Wall time of the comparison and of its tier-1 part; for the timing script, never asserted. */
    ms: number;
    shapeMs: number;
}

// One record costs 12 bytes per message (a 10,000-message session holds about
// 120 KB), so the cap bounds the maps at a few tens of MB in the worst case.
const RECORD_SESSIONS = 256;
const records = new BoundedSessionMap<ServedRecord>(RECORD_SESSIONS);
const pending = new BoundedSessionMap<PendingServe>(1_000);
const counters = new BoundedSessionMap<ServedCounters>(1_000);
/** Passes between two full content checks of one session, the tier-1 blind-spot sample. */
export const SERVED_FULL_CHECK_INTERVAL = 100;
/** Commits between two count lines of one session. */
const COUNT_LOG_INTERVAL = 100;
/** Leading messages whose content is digested on every pass. */
const HEAD_MIN = 2;
const HEAD_MAX = 4;

let lastWork: ServedCheckWork = { fingerprinted: 0, digested: 0, full: false, ms: 0, shapeMs: 0 };

function emptyCounters(): ServedCounters {
    return {
        commits: 0,
        compared: 0,
        unknown: 0,
        refused: 0,
        appendOnly: 0,
        changed: 0,
        shorter: 0,
        modelChanged: 0,
        unpermittedChange: 0,
        mixedReplay: 0,
        thinkingPrefixChange: 0,
        sameShapeChange: 0,
        fullChecks: 0,
    };
}

function countersFor(sessionId: string): ServedCounters {
    let value = counters.get(sessionId);
    if (!value) {
        value = emptyCounters();
        counters.set(sessionId, value);
    }
    return value;
}

function pendingFor(sessionId: string): PendingServe {
    let value = pending.get(sessionId);
    if (!value) {
        value = {};
        pending.set(sessionId, value);
    }
    return value;
}

// ── notes a request leaves before it is returned ───────────────────────────

/** A new request for the session starts: forget what an earlier one noted. */
export function beginServedRequest(sessionId: string): void {
    pending.delete(sessionId);
}

/** The pass computed its rebuild permission (the last value a pass notes wins). */
export function noteServedPassPermission(
    sessionId: string,
    permission: ServedPassPermission,
): void {
    pendingFor(sessionId).permission = permission;
}

/** The model the pass serves the request to, when the pass knows it. */
export function noteServedModel(
    sessionId: string,
    model: { providerID: string; modelID: string } | undefined,
): void {
    if (model) pendingFor(sessionId).model = model;
}

/** The request about to be returned is a last-good replay. */
export function noteServedReplay(sessionId: string): void {
    pendingFor(sessionId).replay = true;
}

/** The request about to be returned is the host's own input, passed through unmanaged. */
export function noteServedHostInput(sessionId: string): void {
    pendingFor(sessionId).input = true;
}

/**
 * The turn was refused: nothing reaches the provider, so the record stays as
 * it is. Hosts whose refusal returns normally (OpenCode 2 interrupts the turn)
 * note it here and the commit counts it; a refusal that throws is counted by
 * {@link countServedRefusal}.
 */
export function noteServedRefusal(sessionId: string): void {
    pendingFor(sessionId).refused = true;
}

/** Count a refused turn whose request never reached the host. */
export function countServedRefusal(sessionId: string): void {
    try {
        pending.delete(sessionId);
        countersFor(sessionId).refused += 1;
    } catch {
        // Measurement only; never let it affect the turn.
    }
}

/**
 * Forget the session's record, logging its counts first. Called where the
 * session's served history ends in this process: it was deleted, natively
 * compacted, or the host removed messages from it (a revert or an edit). The
 * next pass of the session is then not compared, and the line logged here
 * tells a reader of the log "not compared" apart from "no difference seen".
 * The last-good slot's invalidations do not drop the record: the record says
 * what the provider last received, not what may be replayed.
 */
export function dropServedRecord(sessionId: string, reason: string): void {
    try {
        const value = counters.peek(sessionId);
        if (value && value.commits + value.refused > 0) logCounts(sessionId, value, reason);
        if (records.has(sessionId))
            sessionLog(
                sessionId,
                `served check: record dropped reason=${reason}; the next request is not compared`,
            );
    } catch {
        // Measurement only.
    }
    records.delete(sessionId);
    pending.delete(sessionId);
    counters.delete(sessionId);
}

/** Forget a record without logging: the session left this check's scope (Rust mode). */
export function forgetServedRecord(sessionId: string): void {
    records.delete(sessionId);
    pending.delete(sessionId);
}

function logCounts(sessionId: string, value: ServedCounters, reason: string): void {
    sessionLog(
        sessionId,
        `served check counts: compared=${value.compared} unknown=${value.unknown} refused=${value.refused} append_only=${value.appendOnly} changed=${value.changed} shorter=${value.shorter} model_changed=${value.modelChanged} unpermitted_change=${value.unpermittedChange} mixed_replay=${value.mixedReplay} thinking_prefix_change=${value.thinkingPrefixChange} same_shape_change=${value.sameShapeChange} full_checks=${value.fullChecks} reason=${reason}`,
    );
}

// ── tier 1: shape fingerprints ─────────────────────────────────────────────

/**
 * One step of FNV-1a over 32-bit values. Each step is a bijection of the
 * running hash for a fixed value, so two sequences that differ in exactly one
 * value always end in different hashes.
 */
function mix(hash: number, value: number): number {
    return Math.imul(hash ^ (value | 0), 0x01000193);
}

/** A string's length and two of its code units (type and role names). */
function mixName(hash: number, value: unknown): number {
    if (typeof value !== "string") return mix(hash, value === undefined ? -1 : -2);
    const length = value.length;
    const h = mix(hash, length);
    return length === 0
        ? h
        : mix(h, (value.charCodeAt(length - 1) << 16) | value.charCodeAt(length >> 1));
}

/** An id's length and its last eight code units: ids of one session differ at their end. */
function mixId(hash: number, value: unknown): number {
    if (typeof value !== "string") return mix(hash, value === undefined ? -1 : -2);
    const length = value.length;
    let h = mix(hash, length);
    const stop = length > 8 ? length - 8 : 0;
    let index = length - 1;
    for (; index > stop; index -= 2)
        h = mix(h, (value.charCodeAt(index) << 16) | value.charCodeAt(index - 1));
    if (index === stop && length > 0) h = mix(h, value.charCodeAt(index));
    return h;
}

function mixNumber(hash: number, value: number): number {
    const whole = Math.trunc(value);
    return mix(mix(mix(hash, whole), whole / 4294967296), Math.round((value - whole) * 1e6));
}

function mixLength(hash: number, value: unknown): number {
    return typeof value === "string"
        ? mix(hash, value.length)
        : mix(hash, value === undefined ? -1 : -2);
}

/**
 * A field read without enumerating it: a string by its length, an array or
 * binary by its length, a number by value, any other object only by being
 * there. Enumerating object keys (a tool's input, say) on every message more
 * than doubled tier 1's cost; edits inside such an object are left to the
 * content digests.
 */
function mixShallow(hash: number, value: unknown): number {
    switch (typeof value) {
        case "string":
            return mix(mix(hash, 1), value.length);
        case "number":
            return mixNumber(mix(hash, 2), value);
        case "boolean":
            return mix(hash, value ? 5 : 4);
        case "undefined":
            return mix(hash, -1);
        case "object":
            if (value === null) return mix(hash, 3);
            if (Array.isArray(value)) return mix(mix(hash, 9), value.length);
            {
                // Binary content (an image, a file) by its size; reading one
                // property is cheaper than ArrayBuffer.isView on every object.
                const size = (value as { byteLength?: unknown }).byteLength;
                return typeof size === "number" ? mix(mix(hash, 7), size) : mix(hash, 10);
            }
        default:
            return mix(hash, 6);
    }
}

/**
 * OpenCode 1's tool state as the provider receives it: status, input, output,
 * error, attachments, the compacted time and an interrupted error's partial
 * output (see provider-visible-parts.ts). OpenCode 2's adapted state adds
 * `content`. Metadata, titles and timings are UI data and are not read.
 */
function mixToolState(hash: number, state: Record<string, unknown>): number {
    let h = mixName(hash, state.status);
    h = mixShallow(h, state.input);
    h = mixShallow(h, state.output);
    if (state.error !== undefined) h = mixShallow(h, state.error);
    if (state.attachments !== undefined) h = mixShallow(h, state.attachments);
    if (state.content !== undefined) h = mixShallow(h, state.content);
    const time = state.time as Record<string, unknown> | undefined;
    h = mix(h, time && typeof time === "object" && time.compacted !== undefined ? 1 : 0);
    if (state.status === "error") {
        const metadata = state.metadata as Record<string, unknown> | undefined;
        if (metadata && typeof metadata === "object" && metadata.interrupted === true)
            h = mixShallow(h, metadata.output);
    }
    return h;
}

function isThinkingType(type: unknown): boolean {
    return type === "reasoning" || type === "thinking" || type === "redacted_thinking";
}

/** True for a thinking part that reaches the provider, whether or not it is signed. */
function isKeptThinkingPart(part: Record<string, unknown>): boolean {
    if (!isThinkingType(part.type) || part.ignored === true) return false;
    if (part.type === "redacted_thinking" || part.redacted === true) return true;
    if (typeof part.text === "string" && part.text !== "") return true;
    if (typeof part.thinking === "string" && part.thinking !== "") return true;
    const metadata = part.metadata;
    if (metadata && typeof metadata === "object")
        for (const record of Object.values(metadata))
            if (record && typeof record === "object" && "redactedData" in record) return true;
    return false;
}

/**
 * The fields any host's parts carry to the provider, besides type and id: text
 * and thinking, signatures, files and images, tool calls and results across
 * OpenCode 2 and Pi. Read by name rather than enumerated.
 */
const PART_FIELDS = [
    "text",
    "thinking",
    "thinkingSignature",
    "signature",
    "redacted",
    "data",
    "url",
    "mime",
    "mimeType",
    "mediaType",
    "filename",
    "name",
    "tool",
    "callID",
    "toolCallId",
    "input",
    "arguments",
    "output",
    "error",
    "isError",
    "providerExecuted",
    "synthetic",
    "ignored",
] as const;

/**
 * What {@link mixPart} and {@link messageShape} report besides the hash, in one
 * constant object: module-level `let` bindings cost a check on every access.
 */
const walkOut = { partThinking: false, messageThinking: false, messageHead: false };

function mixPart(hash: number, rawPart: unknown): number {
    walkOut.partThinking = false;
    if (!rawPart || typeof rawPart !== "object") return mix(hash, 11);
    const part = rawPart as Record<string, unknown>;
    const type = part.type;
    let h = mixId(mixName(hash, type), part.id);
    if (type === "text") {
        // The common case: a tag prefix or a drop placeholder changes the
        // text's length.
        h = mixLength(h, part.text);
        return mix(h, (part.synthetic === true ? 1 : 0) | (part.ignored === true ? 2 : 0));
    }
    if (type === "tool" && part.state && typeof part.state === "object")
        return mixToolState(
            mixId(mixName(h, part.tool), part.callID),
            part.state as Record<string, unknown>,
        );
    for (let index = 0; index < PART_FIELDS.length; index += 1) {
        const value = part[PART_FIELDS[index] as string];
        if (value !== undefined) h = mixShallow(mix(h, index), value);
    }
    // OpenCode 2's tool result carries its value one level down.
    const result = part.result;
    if (result && typeof result === "object") {
        h = mixName(h, (result as { type?: unknown }).type);
        h = mixShallow(h, (result as { value?: unknown }).value);
    }
    if (isThinkingType(type)) {
        walkOut.partThinking = isKeptThinkingPart(part);
        // OpenCode keeps the signature in the part's metadata.
        const metadata = part.metadata as Record<string, unknown> | undefined;
        const anthropic =
            metadata && typeof metadata === "object"
                ? (metadata.anthropic as Record<string, unknown> | undefined)
                : undefined;
        if (anthropic && typeof anthropic === "object") {
            h = mixShallow(h, anthropic.signature);
            h = mixShallow(h, anthropic.redactedData);
        } else h = mix(h, metadata && typeof metadata === "object" ? 17 : 18);
    }
    return h;
}

/**
 * A message's tier-1 fingerprint.
 *
 * Measured on the Linux build server (packages/plugin/scripts/served-check-timing.ts)
 * over a long coding session's shape, this loop over every message is almost
 * all of an appending pass's cost: about 0.2 ms at 1,000 messages and 2.4 ms at
 * 10,000, about 1.2% of the transform pass it follows. The time is memory
 * access, reading each message's info, parts and tool state, not the integer
 * mixing: the same loop over objects already in cache takes 0.7 ms at 10,000,
 * and a walk that reads only message ids takes about 0.1 ms. It cannot be made
 * cheaper without going blind to the edit passes make most often, a tool
 * output replaced by a placeholder inside the same part, so it reads every
 * part. Three things that were measured to cost more are deliberately absent:
 * hashing ids character by character (only the last eight code units are
 * mixed), enumerating object keys (a tool's input is read shallowly) and
 * module-level `let` bindings (results go through `walkOut`).
 */
function messageShape(message: unknown): number {
    const record =
        message && typeof message === "object" ? (message as Record<string, unknown>) : {};
    const info =
        record.info && typeof record.info === "object"
            ? (record.info as Record<string, unknown>)
            : record;
    const parts = Array.isArray(record.parts) ? record.parts : record.content;
    const role = info.role;
    let hash = mixId(0x811c9dc5, info.id);
    hash = mixName(hash, role);
    // Pi messages have no id; their timestamp and tool call id identify them.
    if (typeof record.timestamp === "number") hash = mixNumber(hash, record.timestamp);
    if (typeof record.toolCallId === "string") hash = mixId(hash, record.toolCallId);
    if (record.isError === true) hash = mix(hash, 12);
    if (info.summary === true) hash = mix(hash, 13);
    let thinking = false;
    let synthetic = info.synthetic === true || info.summary === true;
    if (typeof parts === "string") {
        hash = mix(mix(hash, 14), parts.length);
    } else if (Array.isArray(parts)) {
        hash = mix(mix(hash, 15), parts.length);
        let allSynthetic = parts.length > 0;
        for (const part of parts) {
            hash = mixPart(hash, part);
            if (walkOut.partThinking) thinking = true;
            if (allSynthetic && (part as { synthetic?: unknown } | null)?.synthetic !== true)
                allSynthetic = false;
        }
        if (allSynthetic) synthetic = true;
    } else {
        hash = mix(hash, 16);
    }
    walkOut.messageThinking = thinking && role === "assistant";
    walkOut.messageHead =
        synthetic || role === "system" || role === "compactionSummary" || role === "branchSummary";
    return hash >>> 0;
}

// ── content digests ────────────────────────────────────────────────────────

/**
 * sha256 of the provider-visible message's JSON, truncated to 64 bits. JSON is
 * an unambiguous encoding of the same value the last-good slot digests, and
 * serializing and hashing it natively is several times faster than flattening
 * it into tokens first.
 */
function digestInto(message: unknown, out: Uint32Array, index: number): void {
    let json: string | undefined;
    try {
        json = JSON.stringify(contentSnapshotValue(message));
    } catch {
        json = undefined;
    }
    if (json === undefined) {
        out[2 * index] = 0;
        out[2 * index + 1] = 0;
        return;
    }
    const digest = createHash("sha256").update(json).digest();
    out[2 * index] = digest.readUInt32LE(0);
    out[2 * index + 1] = digest.readUInt32LE(4);
}

function digestsDiffer(a: Uint32Array, ai: number, b: Uint32Array, bi: number): boolean {
    const a0 = a[2 * ai];
    const a1 = a[2 * ai + 1];
    const b0 = b[2 * bi];
    const b1 = b[2 * bi + 1];
    // A message that could not be digested compares as unknown, not as changed.
    if ((a0 === 0 && a1 === 0) || (b0 === 0 && b1 === 0)) return false;
    return a0 !== b0 || a1 !== b1;
}

// ── the comparison ─────────────────────────────────────────────────────────

export interface CommitServedRequestArgs {
    sessionId: string;
    host: ServedHost;
    /** The request exactly as it is returned to the host. Read only. */
    messages: readonly unknown[];
    providerID: string | null | undefined;
    modelID: string | null | undefined;
    /** Compaction-off mode has no rebuild permission at all. */
    compactionOff?: boolean;
}

function permittedLabel(permitted: boolean | null): string {
    return permitted === null ? "unknown" : String(permitted);
}

/**
 * Compare the request about to be returned with the session's record, log
 * what the comparison found, and make the request the new record. Never throws
 * and never touches the messages it reads.
 */
export function commitServedRequest(args: CommitServedRequestArgs): ServedComparison | null {
    try {
        return commit(args);
    } catch (error) {
        try {
            records.delete(args.sessionId);
            sessionLog(args.sessionId, "served check failed; the record is unknown again:", error);
        } catch {
            // Measurement only.
        }
        return null;
    }
}

function commit(args: CommitServedRequestArgs): ServedComparison {
    const { sessionId, messages, host } = args;
    const startedAt = performance.now();
    const note = pending.peek(sessionId) ?? {};
    pending.delete(sessionId);
    const count = countersFor(sessionId);
    const kind: ServedKind = note.replay ? "replay" : note.input ? "input" : "pass";
    const permission = note.permission;
    const permitted =
        permission?.permitted ?? (args.compactionOff ? false : kind === "input" ? false : null);
    const prior = records.get(sessionId);
    if (note.refused) {
        count.refused += 1;
        return {
            class: "refused",
            kind,
            firstIndex: null,
            recorded: prior?.count ?? 0,
            served: messages.length,
            seenBy: null,
            keptThinkingIndex: -1,
            recordedThinkingIndex: prior?.keptThinkingIndex ?? -1,
            permitted,
            events: [],
        };
    }
    count.commits += 1;
    const m = messages.length;
    const providerID = note.model?.providerID ?? args.providerID;
    const modelID = note.model?.modelID ?? args.modelID;
    const prefixBound = isPrefixBoundThinkingModel(providerID, modelID);
    const modelKey = modelID ? `${providerID ?? ""}/${modelID}` : null;

    // Tier 1 over every message, finding the head and the first kept thinking.
    const shapes = new Uint32Array(m);
    let keptThinkingIndex = -1;
    let headCount = Math.min(HEAD_MIN, m);
    let leading = true;
    for (let index = 0; index < m; index += 1) {
        shapes[index] = messageShape(messages[index]);
        if (prefixBound && keptThinkingIndex < 0 && walkOut.messageThinking)
            keptThinkingIndex = index;
        if (leading && index >= HEAD_MIN) {
            if (walkOut.messageHead && index < HEAD_MAX) headCount = index + 1;
            else leading = false;
        }
    }
    const shapeMs = performance.now() - startedAt;

    const digests = new Uint32Array(2 * m);
    const computed = new Uint8Array(m);
    let digested = 0;
    const digest = (index: number) => {
        if (index < 0 || index >= m || computed[index]) return;
        computed[index] = 1;
        digested += 1;
        digestInto(messages[index], digests, index);
    };
    const finish = (
        comparison: Omit<ServedComparison, "kind" | "permitted" | "served">,
        full: boolean,
        passesSinceFull: number,
    ): ServedComparison => {
        records.set(sessionId, {
            count: m,
            shapes,
            digests,
            modelKey: modelKey ?? prior?.modelKey ?? null,
            kind,
            keptThinkingIndex,
            passesSinceFull,
        });
        lastWork = { fingerprinted: m, digested, full, ms: 0, shapeMs };
        if (count.commits % COUNT_LOG_INTERVAL === 0) logCounts(sessionId, count, "periodic");
        lastWork.ms = performance.now() - startedAt;
        return { ...comparison, kind, permitted, served: m };
    };

    // A model change rewrites the whole request legitimately. A side whose
    // model is unknown (OpenCode 1's first message carries none) is compared.
    const modelChanged =
        prior !== undefined &&
        prior.modelKey !== null &&
        modelKey !== null &&
        prior.modelKey !== modelKey;
    if (!prior || modelChanged) {
        // Nothing to compare with (or a model change, which legitimately
        // rewrites everything): digest everything once to start the record.
        for (let index = 0; index < m; index += 1) digest(index);
        if (prior) count.modelChanged += 1;
        else count.unknown += 1;
        return finish(
            {
                class: prior ? "model_change" : "unknown",
                firstIndex: null,
                recorded: prior?.count ?? 0,
                seenBy: null,
                keptThinkingIndex,
                recordedThinkingIndex: prior?.keptThinkingIndex ?? -1,
                events: [],
            },
            true,
            0,
        );
    }
    count.compared += 1;
    const n = prior.count;
    const overlap = Math.min(n, m);

    let shapeDiff = -1;
    for (let index = 0; index < overlap; index += 1)
        if (shapes[index] !== prior.shapes[index]) {
            shapeDiff = index;
            break;
        }

    // The handful of content digests every pass computes.
    for (let index = 0; index < headCount; index += 1) digest(index);
    digest(n - 1);
    digest(prior.keptThinkingIndex);
    digest(keptThinkingIndex);
    for (let index = n; index < m; index += 1) digest(index);
    let handfulDiff = -1;
    for (let index = 0; index < overlap; index += 1)
        if (computed[index] && digestsDiffer(digests, index, prior.digests, index)) {
            handfulDiff = index;
            break;
        }

    const full =
        kind === "replay" ||
        prior.kind === "replay" ||
        shapeDiff >= 0 ||
        handfulDiff >= 0 ||
        m < n ||
        prior.passesSinceFull + 1 >= SERVED_FULL_CHECK_INTERVAL;
    let contentDiff = handfulDiff;
    if (full) {
        count.fullChecks += 1;
        for (let index = 0; index < m; index += 1) digest(index);
        contentDiff = -1;
        for (let index = 0; index < overlap; index += 1)
            if (digestsDiffer(digests, index, prior.digests, index)) {
                contentDiff = index;
                break;
            }
    } else {
        // Messages tier 1 found unchanged and this pass did not digest keep
        // their recorded digest; a same-length edit there stays unseen until
        // a full check samples it.
        for (let index = 0; index < overlap; index += 1)
            if (!computed[index]) {
                digests[2 * index] = prior.digests[2 * index] as number;
                digests[2 * index + 1] = prior.digests[2 * index + 1] as number;
            }
    }

    const candidates = [shapeDiff, contentDiff].filter((value) => value >= 0);
    const firstIndex = candidates.length > 0 ? Math.min(...candidates) : -1;
    let comparisonClass: ServedComparisonClass;
    let seenBy: ServedSeenBy | null = null;
    if (firstIndex >= 0) {
        comparisonClass = "changed";
        count.changed += 1;
        seenBy =
            shapeDiff >= 0 && shapeDiff === firstIndex
                ? "shape"
                : handfulDiff === firstIndex
                  ? "digest"
                  : "full";
    } else if (m < n) {
        comparisonClass = "shorter";
        count.shorter += 1;
        seenBy = "length";
    } else {
        comparisonClass = "append_only";
        count.appendOnly += 1;
    }
    const reportedIndex = firstIndex >= 0 ? firstIndex : comparisonClass === "shorter" ? m : null;
    const events: string[] = [];
    const permissionInputs = permission
        ? `decision=${permission.schedulerDecision} ${permission.rides} thinking_hold=${permission.signedThinkingHold} first_render=${permission.firstRender} host_checkpoint_head=${permission.hostCheckpointHead} emergency=${permission.emergency}`
        : "decision=unknown ride=unknown";

    if (reportedIndex !== null) {
        const after = n - reportedIndex;
        if (kind === "replay") {
            events.push("mixed_replay");
            count.mixedReplay += 1;
            sessionLog(
                sessionId,
                `served check: a replay differed from the request served before it first_index=${reportedIndex} recorded=${n} after_first=${after} served=${m} class=${comparisonClass} seen_by=${seenBy} refused_pass_permitted=${permittedLabel(permitted)} host=${host}`,
            );
        } else if (permitted !== true) {
            events.push("unpermitted_change");
            count.unpermittedChange += 1;
            sessionLog(
                sessionId,
                `served check: a pass without rebuild permission changed served messages first_index=${reportedIndex} recorded=${n} after_first=${after} served=${m} class=${comparisonClass} seen_by=${seenBy} kind=${kind} permitted=${permittedLabel(permitted)} ${permissionInputs} previous_kind=${prior.kind} host=${host}`,
            );
        }
    }
    if (firstIndex >= 0 && shapeDiff !== firstIndex) {
        events.push("same_shape_change");
        count.sameShapeChange += 1;
        sessionLog(
            sessionId,
            `served check: content changed with the same shape first_index=${firstIndex} seen_by=${seenBy} kind=${kind} permitted=${permittedLabel(permitted)} host=${host}`,
        );
    }
    if (prefixBound && firstIndex >= 0) {
        // Kept thinking at or after the first change sits behind bytes it was
        // not produced behind: the provider rejects it. Thinking the recorded
        // request kept there and this one no longer serves was stripped with
        // the change, which is fine on a pass that may rebuild.
        const unstripped = keptThinkingIndex >= 0 && firstIndex <= keptThinkingIndex;
        const stripped =
            !unstripped && prior.keptThinkingIndex >= 0 && firstIndex <= prior.keptThinkingIndex;
        if (unstripped || (stripped && permitted !== true)) {
            events.push("thinking_prefix_change");
            count.thinkingPrefixChange += 1;
            sessionLog(
                sessionId,
                `served check: a change in front of kept signed thinking on a prefix-bound model first_index=${firstIndex} kept_thinking_index=${keptThinkingIndex} recorded_thinking_index=${prior.keptThinkingIndex} thinking_stripped=${stripped} kind=${kind} permitted=${permittedLabel(permitted)} seen_by=${seenBy} host=${host}`,
            );
        }
    }
    return finish(
        {
            class: comparisonClass,
            firstIndex: reportedIndex,
            recorded: n,
            seenBy,
            keptThinkingIndex,
            recordedThinkingIndex: prior.keptThinkingIndex,
            events,
        },
        full,
        full ? 0 : prior.passesSinceFull + 1,
    );
}

// ── test support ───────────────────────────────────────────────────────────

/** @internal Work the last comparison did. */
export function getServedCheckWorkForTest(): ServedCheckWork {
    return { ...lastWork };
}

/** @internal The session's counters, or undefined. */
export function getServedCheckCountersForTest(sessionId: string): ServedCounters | undefined {
    const value = counters.peek(sessionId);
    return value ? { ...value } : undefined;
}

/** @internal Whether the session has a record, and its length. */
export function getServedRecordForTest(
    sessionId: string,
): { count: number; kind: ServedKind; keptThinkingIndex: number } | undefined {
    const record = records.peek(sessionId);
    return record
        ? { count: record.count, kind: record.kind, keptThinkingIndex: record.keptThinkingIndex }
        : undefined;
}

/** @internal Forget every record, as a process restart does. */
export function resetServedCheckForTest(): void {
    records.clear();
    pending.clear();
    counters.clear();
    lastWork = { fingerprinted: 0, digested: 0, full: false, ms: 0, shapeMs: 0 };
}

export const SERVED_RECORD_SESSION_LIMIT = RECORD_SESSIONS;

/** @internal A message's tier-1 shape fingerprint. */
export function servedShapeForTest(message: unknown): number {
    return messageShape(message);
}
