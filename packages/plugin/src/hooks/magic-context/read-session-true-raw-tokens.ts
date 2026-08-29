import { isRecord } from "../../shared/record-type-guard";
import { stableStringify } from "../../shared/stable-json";
import { estimateTokens } from "./read-session-formatting";
import type { RawMessage } from "./read-session-raw";

export interface TrueRawTokenBreakdown {
    text: number;
    reasoning: number;
    toolInput: number;
    toolOutput: number;
    image: number;
    other: number;
    total: number;
}

export interface TrueRawEstimateOptions {
    providerShapeVersion: "opencode-v1" | "pi-folded-v1";
    imageTokenHeuristic?: (part: unknown) => number;
}

export interface TrueRawTokenIndex {
    readonly sessionId: string;
    readonly providerShapeVersion: string;
    readonly rawMessageCount: number;
    tokenForOrdinal(ordinal: number): number;
    messageIdAtOrdinal(ordinal: number): string | null;
    suffixTokensFromOrdinal(ordinal: number): number;
    rangeTokens(startInclusive: number, endExclusive: number): number;
    findSuffixStartForTokens(tokens: number): number;
    findHeadEndForCap(startInclusive: number, endExclusive: number, capTokens: number): number;
}

export interface ToolArc {
    callId: string;
    invOrdinal: number;
    resOrdinal: number | null;
}

/** True when a tail beginning at `boundary` would retain a completed result without its call. */
export function completedToolArcCrossesBoundary(
    invOrdinal: number,
    resOrdinal: number,
    boundary: number,
): boolean {
    return invOrdinal < boundary && boundary <= resOrdinal;
}

export interface TrueRawTokenIndexBuildOptions extends TrueRawEstimateOptions {
    cacheNamespace: string;
    /**
     * Durable per-message token source. When provided and it returns a non-null
     * value for a message, that value is used as the message's total instead of
     * live-tokenizing its parts — this is how the protected-tail boundary reads
     * the precomputed `tags.token_count` store (restart-durable) rather than
     * re-tokenizing the whole raw session every cold pass. Returning null falls
     * back to live tokenization for that message (untagged / legacy-NULL rows),
     * which converges to the stored path once the tagger backfills.
     */
    storedTotalForMessage?: (message: RawMessage) => number | null;
    /**
     * Absolute total message count for the session, when `messages` is a
     * TAIL-ONLY slice carrying absolute ordinals (e.g. only messages after the
     * last compartment boundary). The prefix/suffix machinery is sized to this
     * count and ordinals outside the supplied slice contribute zero tokens —
     * which is exactly correct for every offset-forward query the protected-tail
     * boundary makes (its candidate, suffix, range, and head-cap reads never
     * cross below the eligible offset). Lets the boundary resolve from only the
     * eligible tail instead of reading the whole session every pass.
     *
     * Omitted for whole-session callers: defaults to `messages.length`, and with
     * contiguous 1..N ordinals the result is byte-identical to the prior
     * index-positional fill.
     */
    absoluteMessageCount?: number;
}

interface CachedMessageEstimate {
    breakdown: TrueRawTokenBreakdown;
    keyEstimateBytes: number;
}

interface ToolSignal {
    callId: string;
    hasInput: boolean;
    hasOutput: boolean;
    inputText: string;
    outputText: string;
}

const MAX_MESSAGE_CACHE_ENTRIES = 100_000;
const MAX_MESSAGE_CACHE_KEY_BYTES = 64 * 1024 * 1024;
const FNV1A_32_OFFSET = 0x811c9dc5;
const FNV1A_32_PRIME = 0x01000193;
const messageEstimateCache = new Map<string, CachedMessageEstimate>();
let messageEstimateCacheBytes = 0;

const EMPTY_BREAKDOWN: TrueRawTokenBreakdown = {
    text: 0,
    reasoning: 0,
    toolInput: 0,
    toolOutput: 0,
    image: 0,
    other: 0,
    total: 0,
};

function addBreakdown(
    target: TrueRawTokenBreakdown,
    kind: keyof TrueRawTokenBreakdown,
    value: number,
): void {
    if (kind === "total") return;
    const safeValue = Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
    target[kind] += safeValue;
    target.total += safeValue;
}

function estimateStructured(value: unknown): number {
    if (typeof value === "string") return estimateTokens(value);
    if (value === undefined || value === null) return 0;
    return estimateTokens(stableStringify(value));
}

function firstStringField(
    record: Record<string, unknown>,
    fields: readonly string[],
): string | null {
    for (const field of fields) {
        const value = record[field];
        if (typeof value === "string" && value.length > 0) return value;
    }
    return null;
}

function stringValue(value: unknown): string {
    if (typeof value === "string") return value;
    if (value === undefined || value === null) return "";
    return stableStringify(value);
}

function textFromToolResultContent(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        const pieces: string[] = [];
        for (const entry of content) {
            if (typeof entry === "string") {
                pieces.push(entry);
            } else if (isRecord(entry)) {
                const text = firstStringField(entry, ["text", "content", "value"]);
                pieces.push(text ?? stableStringify(entry));
            } else if (entry !== null && entry !== undefined) {
                pieces.push(String(entry));
            }
        }
        return pieces.join("\n");
    }
    return stringValue(content);
}

function looksImageLike(part: Record<string, unknown>): boolean {
    const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
    const mime = typeof part.mime === "string" ? part.mime.toLowerCase() : "";
    const mediaType = typeof part.mediaType === "string" ? part.mediaType.toLowerCase() : "";
    return (
        type.includes("image") ||
        mime.startsWith("image/") ||
        mediaType.startsWith("image/") ||
        part.image_url !== undefined ||
        part.imageUrl !== undefined ||
        part.image !== undefined
    );
}

function defaultImageTokenHeuristic(part: unknown): number {
    if (isRecord(part)) {
        const width = part.width;
        const height = part.height;
        if (typeof width === "number" && typeof height === "number" && width > 0 && height > 0) {
            return Math.max(256, Math.min(4096, Math.ceil((width * height) / 750)));
        }
    }
    return 1024;
}

function partType(part: Record<string, unknown>): string {
    return typeof part.type === "string" ? part.type : "";
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
    return Object.hasOwn(record, key);
}

function recursiveByteLength(value: unknown): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === "string") return value.length;
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
        return String(value).length;
    }
    if (Array.isArray(value)) {
        return value.reduce((sum, item) => sum + recursiveByteLength(item), value.length);
    }
    if (isRecord(value)) {
        let total = Object.keys(value).length;
        for (const [key, child] of Object.entries(value)) {
            total += key.length + recursiveByteLength(child);
        }
        return total;
    }
    return String(value).length;
}

function updateFnv1a32(hash: number, text: string): number {
    let next = hash;
    for (let index = 0; index < text.length; index += 1) {
        next ^= text.charCodeAt(index);
        next = Math.imul(next, FNV1A_32_PRIME) >>> 0;
    }
    return next;
}

function contentStringsHash(fields: readonly string[]): string {
    let hash = FNV1A_32_OFFSET;
    for (const field of fields) {
        hash = updateFnv1a32(hash, `${field.length}:`);
        hash = updateFnv1a32(hash, field);
        hash = updateFnv1a32(hash, "\0");
    }
    return hash.toString(16).padStart(8, "0");
}

function rawPartVersion(part: Record<string, unknown>): unknown {
    return (
        part.__magicContextPartUpdatedAt ??
        part.updated_at ??
        part.updatedAt ??
        part.version ??
        part.revision ??
        ""
    );
}

function callIdFromPart(part: Record<string, unknown>): string {
    const direct = firstStringField(part, ["callID", "callId", "toolCallId", "tool_call_id", "id"]);
    if (direct) return direct;
    const state = isRecord(part.state) ? part.state : null;
    return state
        ? (firstStringField(state, ["callID", "callId", "toolCallId", "tool_call_id", "id"]) ?? "")
        : "";
}

function toolSignalFromPart(part: unknown): ToolSignal | null {
    if (!isRecord(part)) return null;
    const type = partType(part);
    const state = isRecord(part.state) ? part.state : null;
    const callId = callIdFromPart(part);
    if (!callId && type !== "tool") return null;

    if (type === "tool") {
        const hasInput = state !== null && hasOwn(state, "input");
        const outputKey = state
            ? hasOwn(state, "output")
                ? "output"
                : hasOwn(state, "error")
                  ? "error"
                  : hasOwn(state, "result")
                    ? "result"
                    : null
            : null;
        const hasOutput = outputKey !== null;
        const outputValue = outputKey && state ? state[outputKey] : undefined;
        const providerExecuted = part.providerExecuted === true;
        const openInvocation = !providerExecuted && !hasOutput;
        return {
            callId,
            hasInput: hasInput || openInvocation,
            hasOutput,
            inputText: hasInput && state ? stringValue(state.input) : "",
            outputText: hasOutput ? stringValue(outputValue) : "",
        };
    }

    if (type === "tool-invocation") {
        const args = part.args ?? part.input;
        return {
            callId,
            hasInput: args !== undefined,
            hasOutput: false,
            inputText: args !== undefined ? stringValue(args) : "",
            outputText: "",
        };
    }

    if (type === "tool_use") {
        const input = part.input;
        return {
            callId,
            hasInput: input !== undefined,
            hasOutput: false,
            inputText: input !== undefined ? stringValue(input) : "",
            outputText: "",
        };
    }

    if (type === "tool_result") {
        const content = part.content ?? part.output ?? part.result;
        return {
            callId,
            hasInput: false,
            hasOutput: content !== undefined,
            inputText: "",
            outputText: content !== undefined ? textFromToolResultContent(content) : "",
        };
    }

    return null;
}

function partCheapFingerprint(part: unknown): string {
    if (!isRecord(part)) return `${typeof part}:${recursiveByteLength(part)}`;
    const version = rawPartVersion(part);
    const type = typeof part.type === "string" ? part.type : "";
    return `${type}:${String(version)}:${recursiveByteLength(part)}`;
}

function messageCacheKey(
    message: RawMessage,
    options: TrueRawTokenIndexBuildOptions | TrueRawEstimateOptions,
): string {
    const namespace = "cacheNamespace" in options ? options.cacheNamespace : "estimate";
    const cheapFingerprint = message.parts.map(partCheapFingerprint).join("|");
    return [
        namespace,
        options.providerShapeVersion,
        message.id || `ordinal:${message.ordinal}`,
        message.role,
        message.parts.length,
        cheapFingerprint,
    ].join("\0");
}

function setCachedEstimate(key: string, breakdown: TrueRawTokenBreakdown): void {
    const keyEstimateBytes = key.length * 2 + 64;
    const existing = messageEstimateCache.get(key);
    if (existing) messageEstimateCacheBytes -= existing.keyEstimateBytes;
    messageEstimateCache.set(key, { breakdown, keyEstimateBytes });
    messageEstimateCacheBytes += keyEstimateBytes;
    while (
        messageEstimateCache.size > MAX_MESSAGE_CACHE_ENTRIES ||
        messageEstimateCacheBytes > MAX_MESSAGE_CACHE_KEY_BYTES
    ) {
        const first = messageEstimateCache.keys().next().value;
        if (typeof first !== "string") break;
        const removed = messageEstimateCache.get(first);
        if (removed) messageEstimateCacheBytes -= removed.keyEstimateBytes;
        messageEstimateCache.delete(first);
    }
}

function cloneBreakdown(value: TrueRawTokenBreakdown): TrueRawTokenBreakdown {
    return { ...value };
}

function estimateNonToolPart(
    part: unknown,
    options: TrueRawEstimateOptions,
    breakdown: TrueRawTokenBreakdown,
): boolean {
    if (!isRecord(part)) {
        if (part !== null && part !== undefined)
            addBreakdown(breakdown, "other", estimateStructured(part));
        return true;
    }
    const type = partType(part);
    if (
        type === "step-start" ||
        type === "step-finish" ||
        (type === "meta" && Object.keys(part).length <= 1)
    ) {
        return true;
    }
    if (type === "text") {
        const text = firstStringField(part, ["text", "content"]);
        if (text) addBreakdown(breakdown, "text", estimateTokens(text));
        return true;
    }
    if (type === "reasoning" || type === "thinking" || type === "redacted_thinking") {
        const text = firstStringField(part, ["thinking", "text", "content", "reasoning"]);
        if (text) {
            addBreakdown(breakdown, "reasoning", estimateTokens(text));
        } else {
            addBreakdown(breakdown, "other", estimateStructured(part));
        }
        return true;
    }
    const reasoningText = firstStringField(part, ["thinking", "reasoning"]);
    if (reasoningText && type.length === 0) {
        addBreakdown(breakdown, "reasoning", estimateTokens(reasoningText));
        return true;
    }
    if (looksImageLike(part)) {
        addBreakdown(
            breakdown,
            "image",
            options.imageTokenHeuristic?.(part) ?? defaultImageTokenHeuristic(part),
        );
        const altText = firstStringField(part, ["alt", "text", "description"]);
        if (altText) addBreakdown(breakdown, "text", estimateTokens(altText));
        return true;
    }
    if (type.includes("file") || type === "source") {
        const content = firstStringField(part, ["content", "text", "source"]);
        if (content) addBreakdown(breakdown, "text", estimateTokens(content));
        else addBreakdown(breakdown, "other", estimateStructured(part));
        return true;
    }
    return false;
}

export function estimateTrueRawMessageTokens(
    message: RawMessage,
    options: TrueRawEstimateOptions,
): TrueRawTokenBreakdown {
    const breakdown = cloneBreakdown(EMPTY_BREAKDOWN);
    const countedInput = new Set<string>();
    const countedOutput = new Set<string>();
    let ordinalToolIndex = 0;

    for (const part of message.parts) {
        const signal = toolSignalFromPart(part);
        if (signal) {
            const localKey = `${signal.callId || "tool"}:${message.ordinal}:${ordinalToolIndex}`;
            ordinalToolIndex += 1;
            if (signal.hasInput) {
                const key = `${signal.callId}:input:${message.ordinal}`;
                if (!countedInput.has(key)) {
                    countedInput.add(key);
                    addBreakdown(breakdown, "toolInput", estimateTokens(signal.inputText));
                }
            }
            if (signal.hasOutput) {
                const key = `${signal.callId}:output:${message.ordinal}:${localKey}`;
                if (!countedOutput.has(key)) {
                    countedOutput.add(key);
                    addBreakdown(breakdown, "toolOutput", estimateTokens(signal.outputText));
                }
            }
            continue;
        }
        if (!estimateNonToolPart(part, options, breakdown)) {
            addBreakdown(breakdown, "other", estimateStructured(part));
        }
    }
    return breakdown;
}

export function buildToolArcs(messages: readonly RawMessage[]): ToolArc[] {
    const openQueues = new Map<string, number[]>();
    const arcs: ToolArc[] = [];
    for (const message of messages) {
        for (const part of message.parts) {
            const signal = toolSignalFromPart(part);
            if (!signal || signal.callId.length === 0) continue;
            if (signal.hasInput && signal.hasOutput) {
                arcs.push({
                    callId: signal.callId,
                    invOrdinal: message.ordinal,
                    resOrdinal: message.ordinal,
                });
                continue;
            }
            if (signal.hasInput) {
                const queue = openQueues.get(signal.callId) ?? [];
                queue.push(message.ordinal);
                openQueues.set(signal.callId, queue);
                continue;
            }
            if (signal.hasOutput) {
                const queue = openQueues.get(signal.callId) ?? [];
                const invOrdinal = queue.shift();
                if (queue.length === 0) openQueues.delete(signal.callId);
                else openQueues.set(signal.callId, queue);
                if (invOrdinal !== undefined) {
                    arcs.push({ callId: signal.callId, invOrdinal, resOrdinal: message.ordinal });
                }
            }
        }
    }
    for (const [callId, queue] of openQueues) {
        for (const invOrdinal of queue) {
            arcs.push({ callId, invOrdinal, resOrdinal: null });
        }
    }
    return arcs.sort(
        (a, b) =>
            a.invOrdinal - b.invOrdinal ||
            (a.resOrdinal ?? Number.MAX_SAFE_INTEGER) - (b.resOrdinal ?? Number.MAX_SAFE_INTEGER),
    );
}

export function fenceBoundaryForCompletedToolArcs(
    candidate: number,
    arcs: readonly ToolArc[],
    publicationFloorOrdinal: number,
): number {
    const completed = arcs
        .filter((arc): arc is ToolArc & { resOrdinal: number } => arc.resOrdinal !== null)
        .map((arc) => ({ invocation: arc.invOrdinal, result: arc.resOrdinal }));
    const component = completed.filter((arc) =>
        completedToolArcCrossesBoundary(arc.invocation, arc.result, candidate),
    );
    if (component.length === 0) return candidate;

    // Overlapping arcs are one atomic interval. Expand the whole component before
    // selecting its safe side so moving around one pair cannot split its neighbor.
    for (let pass = 0; pass <= completed.length; pass += 1) {
        const minInvocation = Math.min(...component.map((arc) => arc.invocation));
        const maxResult = Math.max(...component.map((arc) => arc.result));
        const before = component.length;
        for (const arc of completed) {
            if (
                arc.invocation <= maxResult &&
                arc.result >= minInvocation &&
                !component.includes(arc)
            ) {
                component.push(arc);
            }
        }
        if (component.length === before) break;
    }

    const minInvocation = Math.min(...component.map((arc) => arc.invocation));
    const maxResult = Math.max(...component.map((arc) => arc.result));
    return minInvocation < publicationFloorOrdinal ? maxResult + 1 : minInvocation;
}

export function fenceBoundaryForToolArcs(
    candidate: number,
    arcs: readonly ToolArc[],
    lastCompartmentEndOrdinal: number,
    recentOpenArcCutoff: number,
): number {
    let boundary = fenceBoundaryForCompletedToolArcs(
        candidate,
        arcs,
        lastCompartmentEndOrdinal + 1,
    );
    for (const arc of arcs) {
        if (arc.resOrdinal !== null) continue;
        // Open arc (a tool invocation with no matching result in the window).
        // Only an open arc inside the live protected-tail window
        // (invOrdinal >= recentOpenArcCutoff, the size-walk start) is treated as
        // the current in-flight call and protected. An open arc OLDER than the
        // window is an interrupted/abandoned invocation whose result will never
        // arrive — protecting it would let one dead call at the eligible-head
        // edge fence off the entire eligible region and freeze the historian
        // indefinitely. Compacting it is safe: OpenCode mutates the tool part in
        // place on completion (no later standalone tool_result to orphan), and
        // the historian replaces the whole raw range with narration, so no
        // dangling tool_use survives on the wire.
        if (arc.invOrdinal < recentOpenArcCutoff) continue;
        if (arc.invOrdinal >= lastCompartmentEndOrdinal + 1 && arc.invOrdinal < boundary) {
            return arc.invOrdinal;
        }
        if (arc.invOrdinal >= boundary) {
            return arc.invOrdinal;
        }
    }
    return boundary;
}

function tokenForMessage(
    message: RawMessage,
    options: TrueRawTokenIndexBuildOptions,
): TrueRawTokenBreakdown {
    const key = messageCacheKey(message, options);
    const cached = messageEstimateCache.get(key);
    if (cached) return cloneBreakdown(cached.breakdown);
    const breakdown = estimateTrueRawMessageTokens(message, options);
    setCachedEstimate(key, breakdown);
    return cloneBreakdown(breakdown);
}

export function buildTrueRawTokenIndex(
    sessionId: string,
    messages: readonly RawMessage[],
    options: TrueRawTokenIndexBuildOptions,
): TrueRawTokenIndex {
    const ordered = [...messages].sort((a, b) => a.ordinal - b.ordinal);
    // `rawMessageCount` is the ABSOLUTE session message count. When the caller
    // passes a tail-only slice it supplies the real total via
    // absoluteMessageCount; otherwise it equals the slice length (whole-session
    // path — unchanged). The prefix array is sized to the absolute count and
    // filled BY ORDINAL (not by array position), so a tail slice with absolute
    // ordinals base+1..N leaves the pre-base prefix flat at 0. Every
    // offset-forward query (the only kind the boundary makes) is byte-identical
    // because the pre-offset prefix term cancels in the suffix/range subtraction.
    const sliceCount = ordered.length;
    const firstOrdinal = ordered.length > 0 ? ordered[0].ordinal : 1;
    const terminalOrdinal = ordered.length > 0 ? ordered[ordered.length - 1].ordinal : 0;
    // Keep the public count compatible with absolute-session callers, but index token sums
    // over the represented ordinal span. A continued lineage can begin at prior_last+1;
    // treating its absolute ordinal as an array index would clamp every tail lookup to the
    // same final element and silently collapse boundary token math.
    const rawMessageCount = Math.max(
        sliceCount,
        terminalOrdinal,
        options.absoluteMessageCount ?? sliceCount,
    );
    const ordinalSpan = terminalOrdinal >= firstOrdinal ? terminalOrdinal - firstOrdinal + 1 : 0;
    const tokensByOrdinal = new Map<number, number>();
    const idsByOrdinal = new Map<number, string>();
    const prefix = new Array<number>(ordinalSpan + 1).fill(0);
    for (const message of ordered) {
        // Prefer the durable stored total (tags.token_count) when available; it
        // equals the live tokenization of the same content (the tagger stores
        // estimateTokens of each part), so the prefix sums and cut point are
        // identical to the live path while skipping per-message tokenization.
        const stored = options.storedTotalForMessage?.(message);
        const total =
            stored !== undefined && stored !== null
                ? stored
                : tokenForMessage(message, options).total;
        tokensByOrdinal.set(message.ordinal, total);
        idsByOrdinal.set(message.ordinal, message.id);
        // Park the token in the dense span while retaining its absolute ordinal key.
        const relative = message.ordinal - firstOrdinal + 1;
        if (relative >= 1 && relative <= ordinalSpan) {
            prefix[relative] = total;
        }
    }
    // Convert the per-ordinal tokens into a cumulative prefix sum. O(N) integer
    // adds (no I/O, no parse) — negligible versus the avoided full-session read.
    for (let k = 1; k <= ordinalSpan; k += 1) {
        prefix[k] += prefix[k - 1];
    }
    const ordinalToIndex = (ordinal: number): number =>
        Math.max(0, Math.min(ordinalSpan, ordinal - firstOrdinal));
    return {
        sessionId,
        providerShapeVersion: options.providerShapeVersion,
        rawMessageCount,
        tokenForOrdinal(ordinal: number): number {
            return tokensByOrdinal.get(ordinal) ?? 0;
        },
        messageIdAtOrdinal(ordinal: number): string | null {
            return idsByOrdinal.get(ordinal) ?? null;
        },
        suffixTokensFromOrdinal(ordinal: number): number {
            if (ordinal <= firstOrdinal) return prefix[ordinalSpan];
            if (ordinal > terminalOrdinal) return 0;
            return prefix[ordinalSpan] - prefix[ordinalToIndex(ordinal)];
        },
        rangeTokens(startInclusive: number, endExclusive: number): number {
            const start = Math.max(firstOrdinal, startInclusive);
            const end = Math.max(start, Math.min(terminalOrdinal + 1, endExclusive));
            return prefix[end - firstOrdinal] - prefix[start - firstOrdinal];
        },
        findSuffixStartForTokens(tokens: number): number {
            if (!Number.isFinite(tokens) || tokens <= 0) return terminalOrdinal + 1;
            const target = Math.max(0, Math.floor(tokens));
            const total = prefix[ordinalSpan];
            if (total < target) return firstOrdinal;
            const cut = total - target;
            let lo = 0;
            let hi = ordinalSpan;
            let best = 0;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                if (prefix[mid] <= cut) {
                    best = mid;
                    lo = mid + 1;
                } else {
                    hi = mid - 1;
                }
            }
            return firstOrdinal + best;
        },
        findHeadEndForCap(startInclusive: number, endExclusive: number, capTokens: number): number {
            const start = Math.max(firstOrdinal, Math.min(terminalOrdinal + 1, startInclusive));
            const end = Math.max(start, Math.min(terminalOrdinal + 1, endExclusive));
            if (!Number.isFinite(capTokens) || capTokens <= 0) return start;
            const startIndex = start - firstOrdinal;
            const endIndex = end - firstOrdinal;
            const cut = prefix[startIndex] + Math.floor(capTokens);
            let lo = startIndex + 1;
            let hi = endIndex;
            let bestEndIndex = startIndex;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                if (prefix[mid] <= cut) {
                    bestEndIndex = mid;
                    lo = mid + 1;
                } else {
                    hi = mid - 1;
                }
            }
            let bestEnd = firstOrdinal + bestEndIndex;
            if (bestEnd === start && start < end) bestEnd = start + 1;
            return Math.min(bestEnd, end);
        },
    };
}

/**
 * Content-stable part fingerprint for the boundary-staleness check.
 *
 * Deliberately hashes ONLY the content-bearing fields the tokenizer counts
 * (text / thinking / tool input+output text), NOT the JSON envelope or
 * updated-at metadata. The same logical message is observed through two
 * different views — the DB rows (`readRawSession*FromDb`) and the transform's
 * in-memory `args.messages` (which carries extra runtime fields and no
 * timestamps) — and the fingerprint computed at trigger time from one view
 * must match the one recomputed at historian-start from the other, or every
 * memory-derived snapshot would be rejected as stale. Content edits and
 * message insertion/removal still change the fingerprint (content hashes/ids/
 * ordinals), which is exactly the staleness the check exists to catch;
 * metadata-only drift never affects the historian's chunk content.
 */
function partContentFingerprint(part: unknown): string {
    if (!isRecord(part)) return `${typeof part}:${recursiveByteLength(part)}`;
    const tool = toolSignalFromPart(part);
    if (tool) {
        return contentStringsHash([tool.inputText, tool.outputText]);
    }
    const text = firstStringField(part, ["text", "thinking", "reasoning", "content", "url"]) ?? "";
    return contentStringsHash([text]);
}

export function computeRawRangeFingerprint(
    messages: readonly RawMessage[],
    startInclusive: number,
    endExclusive: number,
): string {
    const pieces: string[] = [];
    for (const message of messages) {
        if (message.ordinal < startInclusive || message.ordinal >= endExclusive) continue;
        const partFingerprint = message.parts.map(partContentFingerprint).join(",");
        pieces.push(`${message.ordinal}:${message.id}:${message.parts.length}:${partFingerprint}`);
    }
    return pieces.join("|");
}

export function invalidateTrueRawTokenCache(args: {
    sessionId?: string;
    messageId?: string;
    reason:
        | "message.updated"
        | "message.removed"
        | "session.compacted"
        | "session.deleted"
        | "pi.branch.changed"
        | "pi.stable-id-scheme.changed"
        | "provider.unregistered"
        | "schema.migration";
}): void {
    const sessionNeedle = args.sessionId ? `${args.sessionId}` : null;
    const messageNeedle = args.messageId ? `\0${args.messageId}\0` : null;
    for (const [key, value] of messageEstimateCache) {
        const sessionMatches = sessionNeedle === null || key.includes(sessionNeedle);
        const messageMatches = messageNeedle === null || key.includes(messageNeedle);
        if (sessionMatches && messageMatches) {
            messageEstimateCache.delete(key);
            messageEstimateCacheBytes -= value.keyEstimateBytes;
        }
    }
    void args.reason;
}

export function buildTrueRawTokenIndexFromTokenCountsForTest(
    sessionId: string,
    tokens: readonly number[],
): TrueRawTokenIndex {
    const rawMessageCount = tokens.length;
    const prefix = new Array<number>(rawMessageCount + 1).fill(0);
    for (let index = 0; index < rawMessageCount; index += 1) {
        prefix[index + 1] = prefix[index] + Math.max(0, Math.floor(tokens[index] ?? 0));
    }
    return {
        sessionId,
        providerShapeVersion: "test",
        rawMessageCount,
        tokenForOrdinal(ordinal: number): number {
            return tokens[ordinal - 1] ?? 0;
        },
        messageIdAtOrdinal(ordinal: number): string | null {
            return ordinal >= 1 && ordinal <= rawMessageCount ? `m-${ordinal}` : null;
        },
        suffixTokensFromOrdinal(ordinal: number): number {
            if (ordinal <= 1) return prefix[rawMessageCount];
            if (ordinal > rawMessageCount) return 0;
            return prefix[rawMessageCount] - prefix[ordinal - 1];
        },
        rangeTokens(startInclusive: number, endExclusive: number): number {
            const start = Math.max(1, startInclusive);
            const end = Math.max(start, Math.min(rawMessageCount + 1, endExclusive));
            return prefix[end - 1] - prefix[start - 1];
        },
        findSuffixStartForTokens(tokensNeeded: number): number {
            if (!Number.isFinite(tokensNeeded) || tokensNeeded <= 0) return rawMessageCount + 1;
            const target = Math.max(0, Math.floor(tokensNeeded));
            const total = prefix[rawMessageCount];
            if (total < target) return 1;
            const cut = total - target;
            let lo = 0;
            let hi = rawMessageCount;
            let best = 0;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                if (prefix[mid] <= cut) {
                    best = mid;
                    lo = mid + 1;
                } else {
                    hi = mid - 1;
                }
            }
            return best + 1;
        },
        findHeadEndForCap(startInclusive: number, endExclusive: number, capTokens: number): number {
            const start = Math.max(1, Math.min(rawMessageCount + 1, startInclusive));
            const end = Math.max(start, Math.min(rawMessageCount + 1, endExclusive));
            if (!Number.isFinite(capTokens) || capTokens <= 0) return start;
            const cut = prefix[start - 1] + Math.floor(capTokens);
            let result = start;
            for (let ordinal = start; ordinal < end; ordinal += 1) {
                if (prefix[ordinal] <= cut) result = ordinal + 1;
                else break;
            }
            return result === start && start < end ? start + 1 : result;
        },
    };
}
