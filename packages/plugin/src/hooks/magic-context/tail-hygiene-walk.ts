import { newestCtxReduceTagNumbers } from "../../features/magic-context/reclaim-protection";
import type { TagEntry } from "../../features/magic-context/types";
import { isRecord } from "../../shared/record-type-guard";
import { stableStringify } from "../../shared/stable-json";
import { estimateImageTokensFromDataUrl } from "./image-token-estimate";
import { estimateTokens } from "./read-session-formatting";
import { byteSize } from "./tag-content-primitives";
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
}

/**
 * Cheap served-array shape used in production to catch a write after the tail
 * walk without repeating its content hashing and token accounting.
 */
export interface TailHygieneStructuralSignature {
    messageCount: number;
    partCounts: number[];
    totalBytes: number;
}

export interface TailHygieneBaseline {
    baselineU: number;
    baselineT: number;
    turnDeltaU: number;
    turnDeltaT: number;
    baselineGeneration: number;
    computedAt: number;
    evaluable: boolean;
    generationInvalidated: boolean;
    /** Measurements from the last full walk; defer passes compare against this immutable prefix. */
    baselineParts: TailHygienePartMeasurement[];
    /** Signature of the array served by the current pass, including valid appended deltas. */
    contentSignature: string;
}

interface ToolPartIdentity {
    callId: string;
    ownerMessageId: string;
    messageIndex: number;
    kind: "native" | "invocation" | "result";
}

interface ContentMemoEntry {
    hash: string;
    tokens: number;
    keyBytes: number;
}

const MAX_CONTENT_MEMO_ENTRIES = 100_000;
const MAX_CONTENT_MEMO_BYTES = 64 * 1024 * 1024;
const contentMemo = new Map<string, ContentMemoEntry>();
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
    const key = `${kind}\0${content}`;
    const cached = contentMemo.get(key);
    if (cached) return cached;
    const measured = {
        hash: fnv1a32(key),
        tokens: kind === "excluded" ? 0 : estimateTokens(content),
        keyBytes: key.length * 2 + 32,
    };
    contentMemo.set(key, measured);
    contentMemoBytes += measured.keyBytes;
    while (
        contentMemo.size > MAX_CONTENT_MEMO_ENTRIES ||
        contentMemoBytes > MAX_CONTENT_MEMO_BYTES
    ) {
        const oldest = contentMemo.keys().next().value;
        if (typeof oldest !== "string") break;
        const removed = contentMemo.get(oldest);
        if (removed) contentMemoBytes -= removed.keyBytes;
        contentMemo.delete(oldest);
    }
    return measured;
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
    const stripped = content.trimStart().replace(TAG_PREFIX, "").trimStart().toLowerCase();
    return DROP_PREFIXES.some((prefix) => stripped.startsWith(prefix));
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
    return tag.messageId.replace(/:(?:p|file)\d+$/, "");
}

function protectedTagNumbers(tags: readonly TagEntry[], protectedTags: number): Set<number> {
    const active = Array.from(
        new Set(tags.filter((tag) => tag.status === "active").map((tag) => tag.tagNumber)),
    )
        .sort((left, right) => right - left)
        .slice(0, Math.max(0, protectedTags));
    const protectedNumbers = new Set(active);
    const protectedCtxReduceTags = newestCtxReduceTagNumbers(
        tags.filter((tag) => tag.status === "active" && tag.type === "tool"),
    );
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
    protectedTags: number;
}): {
    protectedNumbers: ReadonlySet<number>;
    messageTags: ReadonlyMap<string, TagEntry>;
    toolTagsByPart: ReadonlyMap<unknown, TagEntry>;
} {
    const protectedNumbers = protectedTagNumbers(args.tags, args.protectedTags);
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
    const memo = memoizedContent("file", content);
    return { content, tokens: memo.tokens };
}

function contentSignature(parts: readonly TailHygienePartMeasurement[]): string {
    return fnv1a32(parts.map((part) => `${part.key}:${part.contentHash}`).join("\0"));
}

/**
 * Capture a low-cost structural signature of the exact messages about to be
 * served. It intentionally does not hash content: production needs a cheap
 * last-writer alarm, while the full content-hash assertion remains a dev check.
 */
export function tailHygieneStructuralSignature(
    messages: readonly MessageLike[],
): TailHygieneStructuralSignature {
    const partCounts: number[] = [];
    let totalBytes = 0;
    for (const message of messages) {
        partCounts.push(message.parts.length);
        totalBytes += byteSize(JSON.stringify(message) ?? "");
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

export function measureTailHygiene(input: {
    messages: readonly MessageLike[];
    tags: readonly TagEntry[];
    protectedTags: number;
    /** Active tags whose drop is queued but not yet materialized into the rendered tail. */
    pendingDropTagNumbers?: ReadonlySet<number>;
}): TailHygieneMeasurement {
    const pendingDropTagNumbers = input.pendingDropTagNumbers ?? new Set<number>();
    const toolIdentities = collectToolPartIdentities(input.messages);
    const attribution = buildTagAttribution({
        messages: input.messages,
        tags: input.tags,
        toolIdentities,
        protectedTags: input.protectedTags,
    });
    const droppedToolOwners = new Set<string>();
    for (const [part, identity] of toolIdentities) {
        if (!isRecord(part)) continue;
        const output = toolOutputText(part);
        if (output !== null && isDropSentinel(output)) {
            droppedToolOwners.add(`${identity.ownerMessageId}\0${identity.callId}`);
        }
    }

    const parts: TailHygienePartMeasurement[] = [];
    let t = 0;
    let u = 0;
    for (let messageIndex = 0; messageIndex < input.messages.length; messageIndex += 1) {
        const message = input.messages[messageIndex];
        const messageKey = messageIdentity(message, messageIndex);
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
                const memo = memoizedContent("text", content);
                const tag = attribution.messageTags.get(`${message.info.id}:p${partIndex}`);
                const measured = snapshot({
                    key: `${key}\0text`,
                    kind: "text",
                    content,
                    tokens: memo.tokens,
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
                    const memo = memoizedContent("toolInput", inputText);
                    const measured = snapshot({
                        key: `${key}\0toolInput`,
                        kind: "toolInput",
                        content: inputText,
                        tokens: memo.tokens,
                        tag,
                        protectedNumbers: attribution.protectedNumbers,
                        pendingDropTagNumbers,
                    });
                    parts.push(measured);
                    t += measured.tokens;
                    u += measured.uTokens;
                }
                const rawOutput = toolOutputText(part);
                if (rawOutput !== null) {
                    const output = stripChannel1ReminderSpans(rawOutput);
                    if (isDropSentinel(output)) {
                        parts.push(excludedSnapshot(`${key}\0excludedOutput`, output));
                    } else {
                        const memo = memoizedContent("toolOutput", output);
                        const measured = snapshot({
                            key: `${key}\0toolOutput`,
                            kind: "toolOutput",
                            content: output,
                            tokens: memo.tokens,
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
    };
}

function sameMeasuredPrefix(
    baseline: readonly TailHygienePartMeasurement[],
    current: readonly TailHygienePartMeasurement[],
): { valid: boolean; boundaryAdvanceU: number; queuedDropDeltaU: number } {
    if (current.length < baseline.length) {
        return { valid: false, boundaryAdvanceU: 0, queuedDropDeltaU: 0 };
    }
    let boundaryAdvanceU = 0;
    let queuedDropDeltaU = 0;
    for (let index = 0; index < baseline.length; index += 1) {
        const before = baseline[index];
        const after = current[index];
        if (
            before.key !== after.key ||
            before.contentHash !== after.contentHash ||
            before.kind !== after.kind ||
            before.tokens !== after.tokens ||
            before.tagNumber !== after.tagNumber ||
            before.tagStatus !== after.tagStatus
        ) {
            return { valid: false, boundaryAdvanceU: 0, queuedDropDeltaU: 0 };
        }
        if (!before.protected && after.protected) {
            return { valid: false, boundaryAdvanceU: 0, queuedDropDeltaU: 0 };
        }
        if (before.protected && !after.protected) {
            if (after.tagStatus !== "active") {
                return { valid: false, boundaryAdvanceU: 0, queuedDropDeltaU: 0 };
            }
            boundaryAdvanceU += after.uTokens;
        } else if (before.queuedForDrop !== after.queuedForDrop) {
            if (before.tagStatus !== "active" || after.tagStatus !== "active") {
                return { valid: false, boundaryAdvanceU: 0, queuedDropDeltaU: 0 };
            }
            queuedDropDeltaU += after.uTokens - before.uTokens;
        } else if (before.uTokens !== after.uTokens) {
            return { valid: false, boundaryAdvanceU: 0, queuedDropDeltaU: 0 };
        }
    }
    return { valid: true, boundaryAdvanceU, queuedDropDeltaU };
}

export function refreshTailHygieneBaseline(input: {
    messages: readonly MessageLike[];
    tags: readonly TagEntry[];
    protectedTags: number;
    pendingDropTagNumbers?: ReadonlySet<number>;
    cacheBusting: boolean;
    previous?: TailHygieneBaseline;
    now?: number;
}): TailHygieneBaseline {
    const measured = measureTailHygiene(input);
    const now = input.now ?? Date.now();
    if (!input.cacheBusting && input.previous?.generationInvalidated) {
        return { ...input.previous, contentSignature: measured.contentSignature };
    }
    if (input.cacheBusting || !input.previous) {
        return {
            baselineU: measured.u,
            baselineT: measured.t,
            turnDeltaU: 0,
            turnDeltaT: 0,
            baselineGeneration: (input.previous?.baselineGeneration ?? 0) + 1,
            computedAt: now,
            evaluable: true,
            generationInvalidated: false,
            baselineParts: measured.parts,
            contentSignature: measured.contentSignature,
        };
    }

    const prefix = sameMeasuredPrefix(input.previous.baselineParts, measured.parts);
    if (!prefix.valid) {
        return {
            ...input.previous,
            evaluable: false,
            generationInvalidated: true,
            contentSignature: measured.contentSignature,
        };
    }
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
        // The recency reserve always contains the newest completed tool output,
        // so that output grows total mass T without growing reclaimable mass U.
        if (part.kind !== "toolOutput") turnDeltaU += part.uTokens;
    }
    return {
        ...input.previous,
        turnDeltaU,
        turnDeltaT,
        evaluable: true,
        generationInvalidated: false,
        contentSignature: measured.contentSignature,
    };
}

export function effectiveTailHygiene(
    baseline: Pick<TailHygieneBaseline, "baselineU" | "baselineT" | "turnDeltaU" | "turnDeltaT">,
): { u: number; t: number } {
    const t = Math.max(0, baseline.baselineT + baseline.turnDeltaT);
    const u = Math.min(t, Math.max(0, baseline.baselineU + baseline.turnDeltaU));
    return { u, t };
}

export function assertTailHygieneContentUnchanged(input: {
    messages: readonly MessageLike[];
    tags: readonly TagEntry[];
    protectedTags: number;
    expectedSignature: string;
}): void {
    const actual = measureTailHygiene(input).contentSignature;
    if (actual !== input.expectedSignature) {
        throw new Error(
            `tail hygiene walk was not the last byte-affecting operation: expected ${input.expectedSignature}, got ${actual}`,
        );
    }
}
