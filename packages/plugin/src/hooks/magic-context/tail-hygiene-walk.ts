import { protectedToolTagNumbers } from "../../features/magic-context/reclaim-protection";
import type { TagEntry } from "../../features/magic-context/types";
import { isRecord } from "../../shared/record-type-guard";
import { stableStringify } from "../../shared/stable-json";
import { contentTagOwnerMessageId } from "../../shared/tag-owner-id";
import {
    estimateImageTokensFromDataUrl,
    estimateToolAttachmentImageTokens,
} from "./image-token-estimate";
import { providerVisibleMessage, providerVisiblePart } from "./provider-visible-parts";
import { estimateTokens } from "./read-session-formatting";
import type { MessageLike } from "./tag-messages";
import { isSyntheticTodoPart } from "./todo-view";

export interface TailHygieneDeltas {
    u: number;
    t: number;
}

export type TailHygienePartKind = "text" | "toolInput" | "toolOutput" | "file" | "excluded";

export interface TailHygienePartMeasurement {
    key: string;
    contentHash: string;
    kind: TailHygienePartKind;
    tokens: number;
    uTokens: number;
    tagNumber: number | null;
    tagStatus: TagEntry["status"] | null;
    protected: boolean;
    /** The agent already requested this drop; it remains in the rendered token total until the next cache-busting render applies it. */
    queuedForDrop: boolean;
}

export interface TailHygieneMeasurement {
    u: number;
    t: number;
    contentSignature: string;
    parts: TailHygienePartMeasurement[];
    /** First index in `parts` that belongs to the newest message; the frozen prefix stops here. */
    newestMessagePartStart: number;
}

/**
 * Which measured field of a frozen prefix part stopped matching. `shorter` means
 * the measured array no longer reaches the end of the frozen prefix at all.
 */
export type TailHygienePrefixMismatchField =
    | "shorter"
    | "key"
    | "contentHash"
    | "kind"
    | "tokens"
    | "tagNumber"
    | "tagStatus"
    | "protection-entered"
    | "protection-exit-inactive"
    | "queued-drop-inactive"
    | "uTokens";

/** First point where a defer pass stopped matching the frozen prefix. */
export interface TailHygienePrefixMismatch {
    /** Index into the frozen prefix; for `shorter` it is the first index the measured array lacks. */
    partIndex: number;
    /** Message the mismatching part belongs to, so the cause can be attributed to a message shape. */
    messageId: string;
    field: TailHygienePrefixMismatchField;
    frozenParts: number;
    measuredParts: number;
}

/**
 * Cheap served-array shape used in production to catch a write after the tail
 * walk without repeating its content hashing and token accounting.
 */
export interface TailHygieneStructuralSignature {
    messageCount: number;
    partCounts: number[];
    /** Legacy field name: a structural size proxy, not a UTF-8 byte count. */
    totalBytes: number;
}

export type TailHygieneChannel1Level = "" | "gentle" | "firm" | "urgent";

export interface TailHygienePostReduceGrace {
    /** True between the ctx_reduce call and the first post-drop tail measurement. */
    pending: boolean;
    /** Reclaimable mass after queued drops have already been excluded from U. */
    baselineU?: number;
    /** Channel-1 band observed immediately before ctx_reduce ran. */
    preReduceLevel: TailHygieneChannel1Level;
}

export interface TailHygieneBaseline {
    /** Keep counts adopted on the last rebuilding pass; absent on legacy baselines. */
    protectedToolsPolicy?: Readonly<Record<string, number>>;
    baselineU: number;
    baselineT: number;
    turnDeltaU: number;
    turnDeltaT: number;
    /** Unit epoch and frozen ratios used for every baseline/delta value in this generation. */
    hygieneUnitsVersion: number;
    toolsRatio: number;
    proseRatio: number;
    baselineGeneration: number;
    computedAt: number;
    evaluable: boolean;
    generationInvalidated: boolean;
    /** Measurements from the last full walk; defer passes compare against this immutable prefix. */
    baselineParts: TailHygienePartMeasurement[];
    /** Signature of the array served by the current pass, including valid appended deltas. */
    contentSignature: string;
    /** Live mirror of the durable nudge grace state; it never contributes rendered bytes. */
    channel1PostReduceGrace?: TailHygienePostReduceGrace;
    /**
     * Set only on the pass that found a mismatch and re-measured, so a caller can
     * log one line per invalidation event instead of one line per pass.
     */
    lastPrefixMismatch?: TailHygienePrefixMismatch;
}

interface ToolPartIdentity {
    callId: string;
    ownerMessageId: string;
    messageIndex: number;
    kind: "native" | "invocation" | "result";
}

interface ContentMemoEntry {
    hash: string;
    tokens: number | undefined;
    keyBytes: number;
    kind: TailHygienePartKind;
    content: string;
}

const MAX_CONTENT_MEMO_ENTRIES = 100_000;
// Every pass measures the whole rendered tail, and a miss tokenizes the text
// again, which costs about a second per 50 MB. The memo holds each session's
// tail across passes, so it must fit the tails of the sessions a process serves
// in turn: at 64 MiB, two sessions with about 30 MB of tool output each evicted
// each other's entries and every pass tokenized everything again.
const MAX_CONTENT_MEMO_BYTES = 256 * 1024 * 1024;
const contentMemo = new Map<TailHygienePartKind, Map<string, ContentMemoEntry>>();
const contentMemoOrder = new Set<ContentMemoEntry>();
let contentMemoBytes = 0;
const FNV1A_32_OFFSET = 0x811c9dc5;
const FNV1A_32_PRIME = 0x01000193;
const TAG_PREFIX = /^§\d+§\s*/;
const DROP_PREFIXES = ["[dropped", "[truncated"] as const;
const CHANNEL1_REMINDER_OPEN = "\n\n<system-reminder>\n";
const CHANNEL1_REMINDER_CLOSE = "\n</system-reminder>";
const TODO_HEAD_ANCHOR_ID = "__magic_context_todo_head__";

function fnv1a32(value: string): string {
    let hash = FNV1A_32_OFFSET;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, FNV1A_32_PRIME) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
}

function memoizedContent(kind: TailHygienePartKind, content: string): ContentMemoEntry {
    let byContent = contentMemo.get(kind);
    if (!byContent) {
        byContent = new Map();
        contentMemo.set(kind, byContent);
    }
    const cached = byContent.get(content);
    if (cached) return cached;
    // Stream the original kind/NUL/content sequence so signatures stay identical
    // without allocating a second copy of every tool output as a composite key.
    let hash = FNV1A_32_OFFSET;
    for (const segment of [kind, "\0", content]) {
        for (let index = 0; index < segment.length; index += 1) {
            hash ^= segment.charCodeAt(index);
            hash = Math.imul(hash, FNV1A_32_PRIME) >>> 0;
        }
    }
    const measured = {
        hash: hash.toString(16).padStart(8, "0"),
        tokens: kind === "excluded" ? 0 : undefined,
        keyBytes: (kind.length + 1 + content.length) * 2 + 32,
        kind,
        content,
    };
    byContent.set(content, measured);
    contentMemoOrder.add(measured);
    contentMemoBytes += measured.keyBytes;
    while (
        contentMemoOrder.size > MAX_CONTENT_MEMO_ENTRIES ||
        contentMemoBytes > MAX_CONTENT_MEMO_BYTES
    ) {
        const oldest = contentMemoOrder.values().next().value;
        if (!oldest) break;
        contentMemoBytes -= oldest.keyBytes;
        contentMemo.get(oldest.kind)?.delete(oldest.content);
        contentMemoOrder.delete(oldest);
    }
    return measured;
}

function memoizedTokens(kind: TailHygienePartKind, content: string): number {
    const measured = memoizedContent(kind, content);
    if (measured.tokens === undefined) {
        measured.tokens = estimateTokens(content);
    }
    return measured.tokens;
}

function safeStableStringify(value: unknown): string {
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    try {
        return stableStringify(value);
    } catch {
        return String(value);
    }
}

function firstString(record: Record<string, unknown>, fields: readonly string[]): string {
    for (const field of fields) {
        const value = record[field];
        if (typeof value === "string") return value;
    }
    return "";
}

function callIdFromPart(part: Record<string, unknown>): string {
    const direct = firstString(part, ["callID", "callId", "toolCallId", "tool_call_id", "id"]);
    if (direct) return direct;
    const state = isRecord(part.state) ? part.state : null;
    return state
        ? firstString(state, ["callID", "callId", "toolCallId", "tool_call_id", "id"])
        : "";
}

function toolResultCallId(part: Record<string, unknown>): string {
    return firstString(part, ["tool_use_id", "toolUseId", "callID", "callId"]);
}

function messageIdentity(message: MessageLike, messageIndex: number): string {
    return typeof message.info.id === "string"
        ? message.info.id
        : `ordinal:${messageIndex}:${message.info.role ?? "unknown"}`;
}

function collectToolPartIdentities(
    messages: readonly MessageLike[],
): Map<unknown, ToolPartIdentity> {
    const identities = new Map<unknown, ToolPartIdentity>();
    const pendingOwners = new Map<string, string[]>();
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
        const message = messages[messageIndex];
        const currentOwner = messageIdentity(message, messageIndex);
        for (const part of message.parts) {
            if (!isRecord(part)) continue;
            if (part.type === "tool-invocation" || part.type === "tool_use") {
                const callId = callIdFromPart(part);
                if (!callId) continue;
                const owners = pendingOwners.get(callId) ?? [];
                owners.push(currentOwner);
                pendingOwners.set(callId, owners);
                identities.set(part, {
                    callId,
                    ownerMessageId: currentOwner,
                    messageIndex,
                    kind: "invocation",
                });
                continue;
            }
            if (part.type === "tool_result") {
                const callId = toolResultCallId(part);
                if (!callId) continue;
                const owners = pendingOwners.get(callId);
                const ownerMessageId = owners?.shift() ?? currentOwner;
                identities.set(part, {
                    callId,
                    ownerMessageId,
                    messageIndex,
                    kind: "result",
                });
                continue;
            }
            if (part.type === "tool") {
                const callId = callIdFromPart(part);
                if (!callId) continue;
                identities.set(part, {
                    callId,
                    ownerMessageId: currentOwner,
                    messageIndex,
                    kind: "native",
                });
            }
        }
    }
    return identities;
}

function isMachineGeneratedUserPart(part: unknown): boolean {
    if (!isRecord(part)) return false;
    const metadata = isRecord(part.metadata) ? part.metadata : null;
    const marker = metadata && isRecord(metadata.marker) ? metadata.marker : null;
    // Keep the all-parts predicate aligned with hasNewerRealUserMessage: a
    // row is synthetic only when every part is machine-generated. A real
    // prompt can carry one synthetic @mention part without becoming injected.
    return (
        part.synthetic === true ||
        part.ignored === true ||
        marker?.kind != null ||
        isSyntheticTodoPart(part)
    );
}

export function isSyntheticMessage(message: MessageLike): boolean {
    const syntheticUserRow =
        message.info.role === "user" &&
        message.parts.length > 0 &&
        message.parts.every(isMachineGeneratedUserPart);
    return (
        syntheticUserRow || message.info.summary === true || message.info.id === TODO_HEAD_ANCHOR_ID
    );
}

/**
 * Counts user turns with the same all-parts synthetic predicate used by the
 * mid-turn release valve. MC's reminder, Channel-2, and m0/m1 rows are
 * injected user-shaped messages and must not advance a user-turn cadence.
 */
export function countRealUserMessages(messages: readonly MessageLike[]): number {
    let count = 0;
    for (const message of messages) {
        if (message.info.role === "user" && !isSyntheticMessage(message)) count += 1;
    }
    return count;
}

function isSyntheticPart(part: unknown): boolean {
    return isMachineGeneratedUserPart(part);
}

export function stripChannel1ReminderSpans(output: string): string {
    let stripped = output;
    while (stripped.endsWith(CHANNEL1_REMINDER_CLOSE)) {
        const opener = stripped.lastIndexOf(CHANNEL1_REMINDER_OPEN);
        if (opener < 0) break;
        stripped = stripped.slice(0, opener);
    }
    return stripped;
}

function isDropSentinel(content: string): boolean {
    // Only the head can match. Lowercasing the whole text copied every tool
    // output on every pass; the prefixes are ASCII, so lowercasing their
    // length of the head gives the same answer.
    let stripped = content.trimStart();
    const tag = TAG_PREFIX.exec(stripped);
    if (tag) stripped = stripped.slice(tag[0].length).trimStart();
    return DROP_PREFIXES.some(
        (prefix) => stripped.slice(0, prefix.length).toLowerCase() === prefix,
    );
}

function toolOutputText(part: Record<string, unknown>): string | null {
    if (part.type === "tool") {
        const state = isRecord(part.state) ? part.state : null;
        if (!state) return null;
        if (state.output !== undefined) return safeStableStringify(state.output);
        if (state.error !== undefined) return safeStableStringify(state.error);
        if (state.result !== undefined) return safeStableStringify(state.result);
        return null;
    }
    if (part.type === "tool_result") {
        const value = part.content ?? part.output ?? part.result;
        return value === undefined ? null : safeStableStringify(value);
    }
    return null;
}

function toolInputText(part: Record<string, unknown>): string | null {
    if (part.type === "tool") {
        const state = isRecord(part.state) ? part.state : null;
        if (!state || state.input === undefined) return null;
        return safeStableStringify(state.input);
    }
    if (part.type === "tool-invocation") {
        const value = part.args ?? part.input;
        return value === undefined ? null : safeStableStringify(value);
    }
    if (part.type === "tool_use") {
        return part.input === undefined ? null : safeStableStringify(part.input);
    }
    return null;
}

function messageIdForTag(tag: TagEntry): string | null {
    if (tag.type === "tool") return tag.toolOwnerMessageId;
    return contentTagOwnerMessageId(tag.messageId);
}

/**
 * Union projection form: protectedTagNumbers (tag-number set form).
 * Coordinate space: tag-number space (Set<number>).
 * Empty-window behavior: an empty set means zero tool tags are protected by the window;
 * non-tool tags are not window members and remain governed solely by independent protections.
 */
function resolveProtectedTagNumbers(
    tags: readonly TagEntry[],
    protectedTagNumbersInput: ReadonlySet<number>,
    protectedToolTags?: ReadonlySet<number>,
): Set<number> {
    const protectedNumbers = new Set(protectedTagNumbersInput);
    const protectedCtxReduceTags = protectedToolTags ?? protectedToolTagNumbers(tags);
    for (const tagNumber of protectedCtxReduceTags) protectedNumbers.add(tagNumber);
    return protectedNumbers;
}

function neighborhoodConsistent(args: {
    orphanTagNumber: number;
    messageIndex: number;
    boundsByMessageIndex: ReadonlyMap<number, { min: number; max: number }>;
    messageCount: number;
}): boolean {
    let previousMax: number | null = null;
    for (let index = 0; index <= args.messageIndex; index += 1) {
        const bound = args.boundsByMessageIndex.get(index);
        if (bound)
            previousMax = previousMax === null ? bound.max : Math.max(previousMax, bound.max);
    }
    let nextMin: number | null = null;
    for (let index = args.messageIndex + 1; index < args.messageCount; index += 1) {
        const bound = args.boundsByMessageIndex.get(index);
        if (bound) nextMin = nextMin === null ? bound.min : Math.min(nextMin, bound.min);
    }
    if (previousMax === null || nextMin === null) return false;
    return args.orphanTagNumber >= previousMax && args.orphanTagNumber <= nextMin;
}

function buildTagAttribution(args: {
    messages: readonly MessageLike[];
    tags: readonly TagEntry[];
    toolIdentities: ReadonlyMap<unknown, ToolPartIdentity>;
    protectedTagNumbers: ReadonlySet<number>;
    protectedToolTags?: ReadonlySet<number>;
}): {
    protectedNumbers: ReadonlySet<number>;
    messageTags: ReadonlyMap<string, TagEntry>;
    toolTagsByPart: ReadonlyMap<unknown, TagEntry>;
} {
    const protectedNumbers = resolveProtectedTagNumbers(
        args.tags,
        args.protectedTagNumbers,
        args.protectedToolTags,
    );
    const messageTags = new Map<string, TagEntry>();
    const exactToolTags = new Map<string, TagEntry>();
    const orphanTagsByCall = new Map<string, TagEntry[]>();
    const messageIndexById = new Map<string, number>();
    for (let index = 0; index < args.messages.length; index += 1) {
        const id = args.messages[index].info.id;
        if (typeof id === "string") messageIndexById.set(id, index);
    }
    const boundsByMessageIndex = new Map<number, { min: number; max: number }>();
    for (const tag of args.tags) {
        if (tag.type === "tool") {
            if (tag.toolOwnerMessageId === null) {
                const rows = orphanTagsByCall.get(tag.messageId) ?? [];
                rows.push(tag);
                orphanTagsByCall.set(tag.messageId, rows);
            } else {
                exactToolTags.set(`${tag.toolOwnerMessageId}\0${tag.messageId}`, tag);
            }
        } else {
            messageTags.set(tag.messageId, tag);
        }
        const ownerId = messageIdForTag(tag);
        const index = ownerId === null ? undefined : messageIndexById.get(ownerId);
        if (index === undefined) continue;
        const existing = boundsByMessageIndex.get(index);
        boundsByMessageIndex.set(index, {
            min: existing ? Math.min(existing.min, tag.tagNumber) : tag.tagNumber,
            max: existing ? Math.max(existing.max, tag.tagNumber) : tag.tagNumber,
        });
    }

    const toolTagsByPart = new Map<unknown, TagEntry>();
    const orphanCandidateOwners = new Map<string, Map<string, ToolPartIdentity[]>>();
    for (const [part, identity] of args.toolIdentities) {
        const exact = exactToolTags.get(`${identity.ownerMessageId}\0${identity.callId}`);
        if (exact) {
            toolTagsByPart.set(part, exact);
            continue;
        }
        const orphans = orphanTagsByCall.get(identity.callId);
        if (orphans?.length !== 1) continue;
        if (
            !neighborhoodConsistent({
                orphanTagNumber: orphans[0].tagNumber,
                messageIndex: identity.messageIndex,
                boundsByMessageIndex,
                messageCount: args.messages.length,
            })
        ) {
            continue;
        }
        const byOwner = orphanCandidateOwners.get(identity.callId) ?? new Map();
        const ownerParts = byOwner.get(identity.ownerMessageId) ?? [];
        ownerParts.push(identity);
        byOwner.set(identity.ownerMessageId, ownerParts);
        orphanCandidateOwners.set(identity.callId, byOwner);
    }
    for (const [callId, byOwner] of orphanCandidateOwners) {
        if (byOwner.size !== 1) continue;
        const orphan = orphanTagsByCall.get(callId)?.[0];
        if (!orphan) continue;
        const ownerId = byOwner.keys().next().value;
        if (typeof ownerId !== "string") continue;
        for (const [part, identity] of args.toolIdentities) {
            if (identity.callId === callId && identity.ownerMessageId === ownerId) {
                toolTagsByPart.set(part, orphan);
            }
        }
    }
    return { protectedNumbers, messageTags, toolTagsByPart };
}

function snapshot(args: {
    key: string;
    kind: TailHygienePartKind;
    content: string;
    tokens: number;
    tag: TagEntry | undefined;
    protectedNumbers: ReadonlySet<number>;
    pendingDropTagNumbers: ReadonlySet<number>;
}): TailHygienePartMeasurement {
    const memo = memoizedContent(args.kind, args.content);
    const tag = args.tag;
    const isProtected = tag ? args.protectedNumbers.has(tag.tagNumber) : false;
    const queuedForDrop = tag ? args.pendingDropTagNumbers.has(tag.tagNumber) : false;
    const uTokens =
        tag?.status === "active" && !isProtected && !queuedForDrop && args.kind !== "excluded"
            ? args.tokens
            : 0;
    return {
        key: args.key,
        contentHash: memo.hash,
        kind: args.kind,
        tokens: args.tokens,
        uTokens,
        tagNumber: tag?.tagNumber ?? null,
        tagStatus: tag?.status ?? null,
        protected: isProtected,
        queuedForDrop,
    };
}

function excludedSnapshot(key: string, part: unknown): TailHygienePartMeasurement {
    const content = safeStableStringify(part);
    return snapshot({
        key,
        kind: "excluded",
        content,
        tokens: 0,
        tag: undefined,
        protectedNumbers: new Set(),
        pendingDropTagNumbers: new Set(),
    });
}

function fileContentAndTokens(part: Record<string, unknown>): { content: string; tokens: number } {
    const mime = typeof part.mime === "string" ? part.mime : "";
    const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
    const url = typeof part.url === "string" ? part.url : "";
    if (mime.startsWith("image/") || type.includes("image")) {
        return {
            content: url,
            tokens: url.startsWith("data:") ? estimateImageTokensFromDataUrl(url) : 1200,
        };
    }
    const content = firstString(part, ["content", "text", "source", "url"]);
    const tokens = memoizedTokens("file", content);
    return { content, tokens };
}

function contentSignature(parts: readonly TailHygienePartMeasurement[]): string {
    return fnv1a32(parts.map((part) => `${part.key}:${part.contentHash}`).join("\0"));
}

function structuralSize(value: unknown): number {
    if (typeof value === "string") return value.length;
    if (Array.isArray(value)) {
        let size = value.length;
        for (let index = 0; index < value.length; index += 1) {
            size += structuralSize(value[index]);
        }
        return size;
    }
    if (value !== null && typeof value === "object") {
        let size = 0;
        for (const key in value) {
            if (Object.hasOwn(value, key)) {
                size += 1 + structuralSize((value as Record<string, unknown>)[key]);
            }
        }
        return size;
    }
    return 0;
}

/**
 * Capture a last-writer alarm, not a content hash. The legacy totalBytes field
 * now sums string-leaf UTF-16 lengths and counts keys/array elements in one
 * allocation-free tree walk, instead of materializing JSON and UTF-8 buffers.
 * Like the old byte-length signature, it can miss same-length substitutions;
 * the size proxy does not promise the same collision set or exact byte counts.
 * The full content-hash assertion remains a separate opt-in debug check. Only the
 * returned signature and per-message part-count array need to be allocated.
 */
export function tailHygieneStructuralSignature(
    messages: readonly MessageLike[],
): TailHygieneStructuralSignature {
    const partCounts: number[] = [];
    let totalBytes = 0;
    for (const message of messages) {
        partCounts.push(message.parts.length);
        // Fields the provider never receives (tool metadata such as LSP
        // diagnostics) are left out: they do not change what is measured, and
        // walking them cost seconds per pass on diagnostics-heavy sessions.
        totalBytes += structuralSize(providerVisibleMessage(message));
    }
    return { messageCount: messages.length, partCounts, totalBytes };
}

export function sameTailHygieneStructuralSignature(
    expected: TailHygieneStructuralSignature,
    actual: TailHygieneStructuralSignature,
): boolean {
    if (
        expected.messageCount !== actual.messageCount ||
        expected.totalBytes !== actual.totalBytes ||
        expected.partCounts.length !== actual.partCounts.length
    ) {
        return false;
    }
    return expected.partCounts.every((count, index) => count === actual.partCounts[index]);
}

type MeasurementInput = {
    messages: readonly MessageLike[];
    tags: readonly TagEntry[];
    /**
     * Canonical membership from computeProtectionWindow(persistedRows, snapshottedFloor).
     * Coordinate space: tag-number. An empty set means the token window has no tool rows.
     */
    protectedTagNumbers: ReadonlySet<number>;
    /** Active tags whose drop is queued but not yet materialized into the rendered tail. */
    pendingDropTagNumbers?: ReadonlySet<number>;
    protectedToolTags?: ReadonlySet<number>;
};

interface ReplayMeasurement extends TailHygieneMeasurement {
    messagePartStarts: number[];
    toolOutputs: Array<Array<string | null>>;
    toolOwners: Map<unknown, ToolPartIdentity>;
    droppedToolOwners: Set<string>;
}

export function measureTailHygiene(input: MeasurementInput): TailHygieneMeasurement {
    return measureWithReplay(input);
}

function measureWithReplay(
    input: MeasurementInput,
    replay?: BaselineMeasurementMemo,
): ReplayMeasurement {
    const pendingDropTagNumbers = input.pendingDropTagNumbers ?? new Set<number>();
    const unchanged = input.messages.map((message, index) => {
        const previous = replay?.messages[index];
        return previous !== undefined && sameReplayMessage(previous, message);
    });
    const toolIdentities = collectToolPartIdentities(input.messages);
    const attribution = buildTagAttribution({
        messages: input.messages,
        tags: input.tags,
        toolIdentities,
        protectedTagNumbers: input.protectedTagNumbers,
        protectedToolTags: input.protectedToolTags,
    });
    const toolOutputs = input.messages.map((message, index) =>
        message.parts.map((part, partIndex) =>
            unchanged[index]
                ? (replay?.measured.toolOutputs[index][partIndex] ?? null)
                : isRecord(part)
                  ? toolOutputText(part)
                  : null,
        ),
    );
    const outputByPart = new Map<unknown, string | null>();
    input.messages.forEach((message, index) => {
        message.parts.forEach((part, partIndex) => {
            outputByPart.set(part, toolOutputs[index][partIndex]);
        });
    });
    const droppedToolOwners = new Set<string>();
    for (const [part, identity] of toolIdentities) {
        if (!isRecord(part)) continue;
        const output = outputByPart.get(part) ?? null;
        if (output !== null && isDropSentinel(output)) {
            droppedToolOwners.add(`${identity.ownerMessageId}\0${identity.callId}`);
        }
    }

    const parts: TailHygienePartMeasurement[] = [];
    let t = 0;
    let u = 0;
    let newestMessagePartStart = 0;
    const messagePartStarts: number[] = [];
    for (let messageIndex = 0; messageIndex < input.messages.length; messageIndex += 1) {
        const message = input.messages[messageIndex];
        messagePartStarts.push(parts.length);
        if (messageIndex === input.messages.length - 1) newestMessagePartStart = parts.length;
        const messageKey = messageIdentity(message, messageIndex);
        const priorMessage = replay?.messages[messageIndex];
        // Content equality is exact, including historical edits through reused host
        // objects. Tool ownership and paired sentinels are contextual, so validate
        // them separately before borrowing this message's hashes and token counts.
        const reusable =
            unchanged[messageIndex] &&
            priorMessage &&
            message.parts.every((part, index) => {
                const current = toolIdentities.get(part);
                const prior = replay?.measured.toolOwners.get(priorMessage.parts[index]);
                if (!current || !prior) return current === prior;
                const currentKey = `${current.ownerMessageId}\0${current.callId}`;
                const priorKey = `${prior.ownerMessageId}\0${prior.callId}`;
                return (
                    currentKey === priorKey &&
                    droppedToolOwners.has(currentKey) ===
                        replay?.measured.droppedToolOwners.has(priorKey)
                );
            });
        if (reusable && replay) {
            const start = replay.measured.messagePartStarts[messageIndex];
            const end =
                replay.measured.messagePartStarts[messageIndex + 1] ?? replay.measured.parts.length;
            for (let index = start; index < end; index += 1) {
                const prior = replay.measured.parts[index];
                const partIndex = Number(prior.key.slice(messageKey.length + 1).split("\0")[0]);
                const tag =
                    prior.kind === "text"
                        ? attribution.messageTags.get(`${message.info.id}:p${partIndex}`)
                        : prior.kind === "file"
                          ? attribution.messageTags.get(`${message.info.id}:file${partIndex}`)
                          : prior.kind === "toolInput" || prior.kind === "toolOutput"
                            ? attribution.toolTagsByPart.get(message.parts[partIndex])
                            : undefined;
                const protectedPart = tag ? attribution.protectedNumbers.has(tag.tagNumber) : false;
                const queuedForDrop = tag ? pendingDropTagNumbers.has(tag.tagNumber) : false;
                const uTokens =
                    tag?.status === "active" &&
                    !protectedPart &&
                    !queuedForDrop &&
                    prior.kind !== "excluded"
                        ? prior.tokens
                        : 0;
                const measured =
                    prior.tagNumber === (tag?.tagNumber ?? null) &&
                    prior.tagStatus === (tag?.status ?? null) &&
                    prior.protected === protectedPart &&
                    prior.queuedForDrop === queuedForDrop &&
                    prior.uTokens === uTokens
                        ? prior
                        : {
                              ...prior,
                              tagNumber: tag?.tagNumber ?? null,
                              tagStatus: tag?.status ?? null,
                              protected: protectedPart,
                              queuedForDrop,
                              uTokens,
                          };
                parts.push(measured);
                t += measured.tokens;
                u += measured.uTokens;
            }
            continue;
        }
        const messageSynthetic = isSyntheticMessage(message);
        for (let partIndex = 0; partIndex < message.parts.length; partIndex += 1) {
            const part = message.parts[partIndex];
            const key = `${messageKey}\0${partIndex}`;
            if (messageSynthetic || isSyntheticPart(part) || !isRecord(part)) {
                parts.push(excludedSnapshot(`${key}\0excluded`, part));
                continue;
            }
            const type = typeof part.type === "string" ? part.type : "";
            if (
                type === "reasoning" ||
                type === "thinking" ||
                type === "redacted_thinking" ||
                type === "signature"
            ) {
                parts.push(excludedSnapshot(`${key}\0excluded`, part));
                continue;
            }
            if (type === "text") {
                const rawContent = firstString(part, ["text", "content"]);
                const content = rawContent === null ? null : stripChannel1ReminderSpans(rawContent);
                if (!content || isDropSentinel(content)) {
                    parts.push(excludedSnapshot(`${key}\0excluded`, part));
                    continue;
                }
                const tokens = memoizedTokens("text", content);
                const tag = attribution.messageTags.get(`${message.info.id}:p${partIndex}`);
                const measured = snapshot({
                    key: `${key}\0text`,
                    kind: "text",
                    content,
                    tokens,
                    tag,
                    protectedNumbers: attribution.protectedNumbers,
                    pendingDropTagNumbers,
                });
                parts.push(measured);
                t += measured.tokens;
                u += measured.uTokens;
                continue;
            }
            if (type === "file" || type.includes("image") || type === "source") {
                const file = fileContentAndTokens(part);
                if (!file.content || isDropSentinel(file.content)) {
                    parts.push(excludedSnapshot(`${key}\0excluded`, part));
                    continue;
                }
                const tag = attribution.messageTags.get(`${message.info.id}:file${partIndex}`);
                const measured = snapshot({
                    key: `${key}\0file`,
                    kind: "file",
                    content: file.content,
                    tokens: file.tokens,
                    tag,
                    protectedNumbers: attribution.protectedNumbers,
                    pendingDropTagNumbers,
                });
                parts.push(measured);
                t += measured.tokens;
                u += measured.uTokens;
                continue;
            }
            const toolIdentity = toolIdentities.get(part);
            if (toolIdentity) {
                const ownerKey = `${toolIdentity.ownerMessageId}\0${toolIdentity.callId}`;
                if (droppedToolOwners.has(ownerKey)) {
                    parts.push(excludedSnapshot(`${key}\0excluded`, part));
                    continue;
                }
                const tag = attribution.toolTagsByPart.get(part);
                const inputText = toolInputText(part);
                if (inputText !== null) {
                    const tokens = memoizedTokens("toolInput", inputText);
                    const measured = snapshot({
                        key: `${key}\0toolInput`,
                        kind: "toolInput",
                        content: inputText,
                        tokens,
                        tag,
                        protectedNumbers: attribution.protectedNumbers,
                        pendingDropTagNumbers,
                    });
                    parts.push(measured);
                    t += measured.tokens;
                    u += measured.uTokens;
                }
                const rawOutput = outputByPart.get(part) ?? null;
                if (rawOutput !== null) {
                    const output = stripChannel1ReminderSpans(rawOutput);
                    if (isDropSentinel(output)) {
                        parts.push(excludedSnapshot(`${key}\0excludedOutput`, output));
                    } else {
                        // Images the tool returned beside its text are billed as images.
                        const tokens =
                            memoizedTokens("toolOutput", output) +
                            (part.type === "tool"
                                ? estimateToolAttachmentImageTokens(part.state)
                                : 0);
                        const measured = snapshot({
                            key: `${key}\0toolOutput`,
                            kind: "toolOutput",
                            content: output,
                            tokens,
                            tag,
                            protectedNumbers: attribution.protectedNumbers,
                            pendingDropTagNumbers,
                        });
                        parts.push(measured);
                        t += measured.tokens;
                        u += measured.uTokens;
                    }
                }
                if (inputText === null && rawOutput === null) {
                    parts.push(excludedSnapshot(`${key}\0excluded`, part));
                }
                continue;
            }
            parts.push(excludedSnapshot(`${key}\0excluded`, part));
        }
    }

    return {
        u: Math.min(Math.max(0, u), Math.max(0, t)),
        t: Math.max(0, t),
        contentSignature: contentSignature(parts),
        parts,
        newestMessagePartStart,
        messagePartStarts,
        toolOutputs,
        toolOwners: toolIdentities,
        droppedToolOwners,
    };
}

function messageIdFromPartKey(key: string): string {
    const separator = key.indexOf("\0");
    return separator > 0 ? key.slice(0, separator) : key;
}

function prefixMismatch(
    baseline: readonly TailHygienePartMeasurement[],
    current: readonly TailHygienePartMeasurement[],
    partIndex: number,
    field: TailHygienePrefixMismatchField,
): TailHygienePrefixComparison {
    return {
        valid: false,
        boundaryAdvanceU: 0,
        queuedDropDeltaU: 0,
        mismatch: {
            partIndex,
            messageId: messageIdFromPartKey(baseline[partIndex]?.key ?? ""),
            field,
            frozenParts: baseline.length,
            measuredParts: current.length,
        },
    };
}

/** Result of comparing a frozen prefix against the current measurement. */
export interface TailHygienePrefixComparison {
    valid: boolean;
    boundaryAdvanceU: number;
    queuedDropDeltaU: number;
    /** Present only when the comparison failed; names the first part that stopped matching. */
    mismatch?: TailHygienePrefixMismatch;
}

/**
 * Lane-neutral: both TypeScript walks (OpenCode and Pi) compare their measured
 * parts through this one implementation so their defer-window rules cannot drift.
 */
export function compareMeasuredTailPrefix(
    baseline: readonly TailHygienePartMeasurement[],
    current: readonly TailHygienePartMeasurement[],
): TailHygienePrefixComparison {
    if (current.length < baseline.length) {
        return prefixMismatch(baseline, current, current.length, "shorter");
    }
    let boundaryAdvanceU = 0;
    let queuedDropDeltaU = 0;
    for (let index = 0; index < baseline.length; index += 1) {
        const before = baseline[index];
        const after = current[index];
        const changedField = comparedField(before, after);
        if (changedField) return prefixMismatch(baseline, current, index, changedField);
        if (before.protected && !after.protected) {
            boundaryAdvanceU += after.uTokens;
        } else if (before.queuedForDrop !== after.queuedForDrop) {
            queuedDropDeltaU += after.uTokens - before.uTokens;
        }
    }
    return { valid: true, boundaryAdvanceU, queuedDropDeltaU };
}

/**
 * Name the first field of a frozen part that a defer pass cannot explain, or
 * null when the part still matches. Protection release and queue membership are
 * explainable state moves; they are only a mismatch when the tag is no longer
 * active, because then the U they carry cannot be attributed.
 */
function comparedField(
    before: TailHygienePartMeasurement,
    after: TailHygienePartMeasurement,
): TailHygienePrefixMismatchField | null {
    if (before.key !== after.key) return "key";
    if (before.contentHash !== after.contentHash) return "contentHash";
    if (before.kind !== after.kind) return "kind";
    if (before.tokens !== after.tokens) return "tokens";
    if (before.tagNumber !== after.tagNumber) return "tagNumber";
    if (before.tagStatus !== after.tagStatus) return "tagStatus";
    if (!before.protected && after.protected) return "protection-entered";
    if (before.protected && !after.protected) {
        return after.tagStatus === "active" ? null : "protection-exit-inactive";
    }
    if (before.queuedForDrop !== after.queuedForDrop) {
        return before.tagStatus === "active" && after.tagStatus === "active"
            ? null
            : "queued-drop-inactive";
    }
    return before.uTokens === after.uTokens ? null : "uTokens";
}

/** One line per invalidation event: where it happened, which field moved, and what was done about it. */
export function formatTailHygienePrefixMismatch(
    mismatch: TailHygienePrefixMismatch,
    baselineGeneration: number,
): string {
    return [
        "tail hygiene prefix invalidated:",
        `part_index=${mismatch.partIndex}`,
        `message=${mismatch.messageId || "unknown"}`,
        `field=${mismatch.field}`,
        `frozen_parts=${mismatch.frozenParts}`,
        `measured_parts=${mismatch.measuredParts}`,
        "action=re-measured",
        `generation=${baselineGeneration}`,
    ].join(" ");
}

function sameReplayValue(before: unknown, after: unknown): boolean {
    if (before === after) return true;
    if (!before || !after || typeof before !== "object" || typeof after !== "object") {
        return false;
    }
    if (Array.isArray(before)) {
        if (!Array.isArray(after) || before.length !== after.length) return false;
        for (let index = 0; index < before.length; index += 1) {
            if (!sameReplayValue(before[index], after[index])) return false;
        }
        return true;
    }
    if (Array.isArray(after)) return false;
    const prototype = Object.getPrototypeOf(before);
    if (
        (prototype !== Object.prototype && prototype !== null) ||
        Object.getPrototypeOf(after) !== prototype
    )
        return false;
    const left = before as Record<string, unknown>;
    const right = after as Record<string, unknown>;
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) return false;
    for (const key of keys) {
        if (!Object.hasOwn(right, key) || !sameReplayValue(left[key], right[key])) return false;
    }
    return true;
}

// Strings are immutable: retain their values instead of copying large text/tool
// bodies. Copy every mutable container so an in-place edit cannot poison replay.
function copyReplayValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(copyReplayValue);
    if (value !== null && typeof value === "object") {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) return structuredClone(value);
        const copy: Record<string, unknown> = Object.create(prototype);
        for (const key of Object.keys(value))
            copy[key] = copyReplayValue((value as Record<string, unknown>)[key]);
        return copy;
    }
    return value;
}

function sameNumbers(before: ReadonlySet<number>, after: ReadonlySet<number>): boolean {
    if (before.size !== after.size) return false;
    for (const number of before) if (!after.has(number)) return false;
    return true;
}

/**
 * `left` is a snapshot made by {@link replaySnapshotParts}; `right` is a live
 * message, compared through the same provider-visible view.
 */
function sameReplayMessage(left: MessageLike, right: MessageLike): boolean {
    return (
        left.info.id === right.info.id &&
        left.info.role === right.info.role &&
        left.info.summary === right.info.summary &&
        sameReplayValue(left.parts, right.parts.map(providerVisiblePart))
    );
}

/**
 * The parts a replay snapshot keeps: what the provider sees of each part (see
 * provider-visible-parts.ts), copied so a later in-place edit cannot change the
 * snapshot. Nothing the measurement reads is left out.
 */
function replaySnapshotParts(parts: readonly unknown[]): unknown[] {
    return copyReplayValue(parts.map(providerVisiblePart)) as unknown[];
}

function sameReplayMessages(
    before: readonly MessageLike[],
    after: readonly MessageLike[],
): boolean {
    if (before.length !== after.length) return false;
    for (let index = 0; index < before.length; index += 1) {
        const left = before[index];
        const right = after[index];
        if (!sameReplayMessage(left, right)) return false;
    }
    return true;
}

interface BaselineMeasurementMemo {
    messages: readonly MessageLike[];
    tags: readonly TagEntry[];
    protectedTagNumbers: ReadonlySet<number>;
    pendingDropTagNumbers: ReadonlySet<number>;
    measured: ReplayMeasurement;
    size: number;
}

// Keep at most eight immutable message/tag snapshots, bounded by an estimated 128 MiB.
// Recompute the measurement when message parts, tag ownership/status, protected
// tag numbers, or queued drops change. Comparing copied values catches historical
// edits through reused host objects. Only id/role/summary and parts affect token
// accounting; unrelated host metadata is not part of this cache key.
const baselineMeasurementMemo = new Map<TailHygienePartMeasurement[], BaselineMeasurementMemo>();
const MAX_BASELINE_MEMO_SIZE = 128 * 1024 * 1024;
let baselineMemoSize = 0;

function retainBaselineMeasurement(
    key: TailHygienePartMeasurement[],
    memo: BaselineMeasurementMemo,
): void {
    const previous = baselineMeasurementMemo.get(key);
    if (previous) baselineMemoSize -= previous.size;
    baselineMeasurementMemo.delete(key);
    if (memo.size > MAX_BASELINE_MEMO_SIZE) return;
    baselineMeasurementMemo.set(key, memo);
    baselineMemoSize += memo.size;
    while (baselineMemoSize > MAX_BASELINE_MEMO_SIZE || baselineMeasurementMemo.size > 8) {
        const oldest = baselineMeasurementMemo.keys().next().value;
        if (!oldest) break;
        baselineMemoSize -= baselineMeasurementMemo.get(oldest)?.size ?? 0;
        baselineMeasurementMemo.delete(oldest);
    }
}

/**
 * Freeze a measurement into a baseline prefix plus this pass's delta.
 *
 * The newest message is deliberately left out of the frozen prefix: while it is
 * newest its parts are still in flight (text absorbs a trailing blank, reasoning
 * is demoted once it stops being newest, new parts arrive mid-turn), so freezing
 * them guarantees a mismatch on the very next pass. Everything after the cut is
 * re-measured on every pass, so the reported totals are unchanged.
 */
export function freezeTailHygieneMeasurement(measured: TailHygieneMeasurement): {
    baselineU: number;
    baselineT: number;
    turnDeltaU: number;
    turnDeltaT: number;
    baselineParts: TailHygienePartMeasurement[];
} {
    const cut = Math.min(Math.max(0, measured.newestMessagePartStart), measured.parts.length);
    let baselineT = 0;
    let baselineU = 0;
    for (let index = 0; index < cut; index += 1) {
        baselineT += measured.parts[index].tokens;
        baselineU += measured.parts[index].uTokens;
    }
    let turnDeltaT = 0;
    let turnDeltaU = 0;
    for (let index = cut; index < measured.parts.length; index += 1) {
        const part = measured.parts[index];
        turnDeltaT += part.tokens;
        if (part.kind !== "toolOutput" || !part.protected) turnDeltaU += part.uTokens;
    }
    baselineT = Math.max(0, baselineT);
    return {
        baselineU: Math.min(Math.max(0, baselineU), baselineT),
        baselineT,
        turnDeltaU,
        turnDeltaT,
        baselineParts:
            cut === measured.parts.length ? measured.parts : measured.parts.slice(0, cut),
    };
}

export function refreshTailHygieneBaseline(input: {
    messages: readonly MessageLike[];
    tags: readonly TagEntry[];
    /** Canonical tag-number membership from persisted row mass and the floor snapshot. */
    protectedTagNumbers: ReadonlySet<number>;
    protectedToolTags?: ReadonlySet<number>;
    pendingDropTagNumbers?: ReadonlySet<number>;
    cacheBusting: boolean;
    protectedTools?: Readonly<Record<string, number>>;
    previous?: TailHygieneBaseline;
    /** Frozen decision ratios. They change only on an authorized bust. */
    calibration?: { toolsRatio: number; proseRatio: number };
    hygieneUnitsVersion?: number;
    now?: number;
}): TailHygieneBaseline {
    const protectedToolsPolicy = adoptedProtectedToolsPolicy(
        input.protectedTools,
        input.previous?.protectedToolsPolicy,
        input.cacheBusting,
        !!input.previous,
    );
    const protectedToolTags = protectedToolTagNumbers(input.tags, protectedToolsPolicy);
    input = {
        ...input,
        protectedToolTags,
        protectedTagNumbers: new Set([...input.protectedTagNumbers, ...protectedToolTags]),
    };
    const pendingDropTagNumbers = input.pendingDropTagNumbers ?? new Set<number>();
    const cached = input.previous
        ? baselineMeasurementMemo.get(input.previous.baselineParts)
        : undefined;
    const hit =
        !input.cacheBusting &&
        cached &&
        sameReplayMessages(cached.messages, input.messages) &&
        sameReplayValue(cached.tags, input.tags) &&
        sameNumbers(cached.protectedTagNumbers, input.protectedTagNumbers) &&
        sameNumbers(cached.pendingDropTagNumbers, pendingDropTagNumbers);
    const rawMeasured = hit ? cached.measured : measureWithReplay(input, cached);
    const frozenCalibration =
        !input.cacheBusting && input.previous
            ? {
                  toolsRatio: input.previous.toolsRatio,
                  proseRatio: input.previous.proseRatio,
                  hygieneUnitsVersion: input.previous.hygieneUnitsVersion,
              }
            : {
                  toolsRatio: input.calibration?.toolsRatio ?? 1,
                  proseRatio: input.calibration?.proseRatio ?? 1,
                  hygieneUnitsVersion: input.hygieneUnitsVersion ?? 1,
              };
    const ratioFor = (kind: TailHygienePartKind): number =>
        kind === "toolInput" || kind === "toolOutput"
            ? frozenCalibration.toolsRatio
            : kind === "text" || kind === "file"
              ? frozenCalibration.proseRatio
              : 1;
    // Keep fractional part mass and round once in effectiveTailHygiene.
    const measured: TailHygieneMeasurement = {
        ...rawMeasured,
        parts: rawMeasured.parts.map((part) => {
            const ratio = ratioFor(part.kind);
            return { ...part, tokens: part.tokens * ratio, uTokens: part.uTokens * ratio };
        }),
    };
    const memo = hit
        ? cached
        : {
              messages: input.messages.map((message, index) =>
                  cached?.messages[index] && sameReplayMessage(cached.messages[index], message)
                      ? cached.messages[index]
                      : {
                            info: {
                                id: message.info.id,
                                role: message.info.role,
                                summary: message.info.summary,
                            },
                            parts: replaySnapshotParts(message.parts),
                        },
              ),
              tags: structuredClone(input.tags),
              protectedTagNumbers: new Set(input.protectedTagNumbers),
              pendingDropTagNumbers: new Set(pendingDropTagNumbers),
              measured: rawMeasured,
              size:
                  2 * structuralSize(input.messages.map(providerVisibleMessage)) +
                  512 * input.tags.length,
          };
    // The replay snapshot owns separate wrappers; associate contextual identities
    // with those wrappers, not mutable host parts from the pass just served.
    if (!hit) {
        const owners = new Map<unknown, ToolPartIdentity>();
        input.messages.forEach((message, index) => {
            message.parts.forEach((part, partIndex) => {
                const identity = rawMeasured.toolOwners.get(part);
                if (identity) owners.set(memo.messages[index].parts[partIndex], identity);
            });
        });
        rawMeasured.toolOwners = owners;
    }
    const now = input.now ?? Date.now();
    const refrozen = (mismatch?: TailHygienePrefixMismatch): TailHygieneBaseline => {
        const frozen = freezeTailHygieneMeasurement(measured);
        retainBaselineMeasurement(frozen.baselineParts, memo);
        return {
            ...frozen,
            protectedToolsPolicy,
            hygieneUnitsVersion: frozenCalibration.hygieneUnitsVersion,
            toolsRatio: frozenCalibration.toolsRatio,
            proseRatio: frozenCalibration.proseRatio,
            baselineGeneration: (input.previous?.baselineGeneration ?? 0) + 1,
            computedAt: now,
            evaluable: true,
            generationInvalidated: false,
            contentSignature: measured.contentSignature,
            channel1PostReduceGrace: input.previous?.channel1PostReduceGrace,
            lastPrefixMismatch: mismatch,
        };
    };
    if (input.cacheBusting || !input.previous) return refrozen();

    const prefix = compareMeasuredTailPrefix(input.previous.baselineParts, measured.parts);
    // A defer pass cannot attribute this change to an append, and this walk measures
    // the rendered tail rather than producing wire bytes, so re-measure instead of
    // holding the stale baseline until the next cache-busting pass. Holding left the
    // reclaim reminders unevaluable for as long as the session went without a bust.
    if (!prefix.valid) return refrozen(prefix.mismatch);
    retainBaselineMeasurement(input.previous.baselineParts, memo);
    let turnDeltaT = 0;
    // Queue membership is an action-state delta: it reduces the actionable token
    // backlog without changing the frozen baseline or still-rendered token total.
    let turnDeltaU = prefix.boundaryAdvanceU + prefix.queuedDropDeltaU;
    for (
        let index = input.previous.baselineParts.length;
        index < measured.parts.length;
        index += 1
    ) {
        const part = measured.parts[index];
        turnDeltaT += part.tokens;
        // Tool-output tokens are not reclaimable while their parts are protected. As new
        // outputs extend the measured tail, include outputs that have aged out of protection.
        if (part.kind !== "toolOutput" || !part.protected) turnDeltaU += part.uTokens;
    }
    return {
        ...input.previous,
        protectedToolsPolicy,
        turnDeltaU,
        turnDeltaT,
        evaluable: true,
        generationInvalidated: false,
        contentSignature: measured.contentSignature,
        lastPrefixMismatch: undefined,
    };
}

export function effectiveTailHygiene(
    baseline: Pick<TailHygieneBaseline, "baselineU" | "baselineT" | "turnDeltaU" | "turnDeltaT">,
): { u: number; t: number } {
    const t = Math.ceil(Math.max(0, baseline.baselineT + baseline.turnDeltaT));
    const u = Math.min(t, Math.ceil(Math.max(0, baseline.baselineU + baseline.turnDeltaU)));
    return { u, t };
}

export function assertTailHygieneContentUnchanged(input: {
    messages: readonly MessageLike[];
    tags: readonly TagEntry[];
    protectedTagNumbers: ReadonlySet<number>;
    expectedSignature: string;
}): void {
    const actual = measureTailHygiene(input).contentSignature;
    if (actual !== input.expectedSignature) {
        throw new Error(
            `tail hygiene walk was not the last byte-affecting operation: expected ${input.expectedSignature}, got ${actual}`,
        );
    }
}

/** Opt-in diagnostics must not add a second hashing/token walk to shipped passes. */
export function assertTailHygieneContentUnchangedIfEnabled(
    input: Parameters<typeof assertTailHygieneContentUnchanged>[0],
): void {
    if (process.env.MAGIC_CONTEXT_DEBUG_ASSERTIONS === "1") {
        assertTailHygieneContentUnchanged(input);
    }
}

import { adoptedProtectedToolsPolicy } from "../../features/magic-context/reclaim-protection";
