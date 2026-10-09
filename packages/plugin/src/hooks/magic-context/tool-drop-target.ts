import { isRecord } from "../../shared/record-type-guard";
import { toolPartHasUserAnswer } from "../../shared/user-answer";
import { droppedInputMarker } from "./dropped-input-guard";
import { applyEditMarkerToInput } from "./edit-marker";
import { estimateMessageTokens } from "./final-wire-token-estimate";
import { neutralizeDroppedReasoningPart } from "./sentinel";
import { stripTagPrefix } from "./tag-content-primitives";
import type { MessageLike, ThinkingLikePart } from "./tag-messages";
import { toolInputStringBytes } from "./tool-input-size";

export type ToolDropResult = "removed" | "truncated" | "absent" | "incomplete";

interface ToolCallObservation {
    callId: string;
    kind: "invocation" | "result";
}

export interface IndexedOccurrence {
    message: MessageLike;
    part: unknown;
    kind: "invocation" | "result";
    /**
     * The rewritten clone currently standing in for `part` in the message's
     * parts array, when a clamp swapped one in this pass. `part` itself stays
     * the untouched host object, so a later rewrite in the same pass (a legacy
     * skeleton converted on a HARD fold) still starts from the real input and
     * knows which array entry to replace or remove.
     */
    served?: unknown;
}

export interface ToolCallIndexEntry {
    occurrences: IndexedOccurrence[];
    hasResult: boolean;
}

export type ToolCallIndex = Map<string, ToolCallIndexEntry>;

const DROP_PREFIX = "[dropped";
const IGNORE_PART_TYPES = new Set([
    "thinking",
    "reasoning",
    "redacted_thinking",
    "meta",
    "step-start",
    "step-finish",
]);

function isToolCallId(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

function getToolContent(part: unknown): string | undefined {
    if (!isRecord(part)) return undefined;
    if (part.type === "tool" && isRecord(part.state)) {
        return typeof part.state.output === "string" ? part.state.output : undefined;
    }
    if (part.type === "tool_result") {
        return typeof part.content === "string" ? part.content : undefined;
    }
    return undefined;
}

function setToolContent(part: unknown, content: string): void {
    if (!isRecord(part)) return;
    if (part.type === "tool" && isRecord(part.state)) {
        part.state.output = content;
        return;
    }
    if (part.type === "tool_result") {
        part.content = content;
    }
}

/**
 * Deep-copy a tool part so a clamp/drop can rewrite the copy without touching
 * the original object. The transform receives `args.messages` whose part
 * objects are the LIVE instances OpenCode still holds (it reads the same
 * objects back for the wire and, for a tool that is still executing, for the
 * execution itself). Rewriting one of those in place can corrupt a live run —
 * e.g. clamping a background task part's `input.prompt` while the child agent
 * is still spawning from it. Cloning first confines every byte change to the
 * wire copy that replaces the part in the message array. Parts are plain
 * JSON-serializable data, so structuredClone (with a JSON fallback for
 * runtimes/edge values that reject it) is sufficient.
 */
function clonePart(part: unknown): unknown {
    if (part === null || typeof part !== "object") return part;
    try {
        return structuredClone(part);
    } catch {
        try {
            return JSON.parse(JSON.stringify(part));
        } catch {
            // Non-serializable part: return it as-is rather than throw. The
            // clamp then mutates the original, which is the pre-existing
            // behavior; this branch is only reachable for exotic parts that
            // cannot be cloned or serialized at all.
            return part;
        }
    }
}

/**
 * Apply a clamp to a throwaway clone of the occurrence's part and swap the
 * clone into the message's parts array, leaving the original part object
 * byte-identical. This is the mutation-safety guarantee: the wire (the array
 * OpenCode reads back) carries the clamped copy, while the live object OpenCode
 * may still execute from is never touched. The swap is by reference identity
 * (`indexOf`), so it is a no-op if the part is no longer in the array.
 */
function clampCloneInPlace(occurrence: IndexedOccurrence, clamp: (part: unknown) => void): void {
    const clone = clonePart(occurrence.part);
    clamp(clone);
    const parts = occurrence.message.parts;
    const index = parts.indexOf(servedPart(occurrence));
    if (index >= 0) {
        parts[index] = clone;
        occurrence.served = clone;
    }
}

/** The object that currently represents this occurrence in its message. */
function servedPart(occurrence: IndexedOccurrence): unknown {
    return occurrence.served ?? occurrence.part;
}

/**
 * Real-argument skeleton: keep the call exactly as the host gave it and
 * replace only the output with the canonical `[dropped §N§]`. Nothing is ever
 * written into the argument position, so a model copying this call from its
 * history copies real, executable arguments.
 */
function skeletonRealToolPart(part: unknown, tagId: number, stripAttachments = false): void {
    if (!isRecord(part)) return;
    const sentinel = `[dropped \u00a7${tagId}\u00a7]`;
    if (part.type === "tool" && isRecord(part.state)) {
        part.state.output = sentinel;
        if (stripAttachments) part.state.attachments = [];
        return;
    }
    if (part.type === "tool_result") {
        part.content = sentinel;
    }
}

/** Read a tool part's input of any JSON shape, without touching it. */
function readToolPartRawInput(part: unknown): unknown {
    if (!isRecord(part)) return undefined;
    if (part.type === "tool" && isRecord(part.state)) return part.state.input;
    if (part.type === "tool-invocation") return part.args;
    if (part.type === "tool_use") return part.input;
    return undefined;
}

function truncateToolPart(part: unknown, tagId: number): void {
    if (!isRecord(part)) return;

    // Legacy `truncated` render, kept only so sessions that already serve it
    // replay the same bytes until a HARD fold converts them (see
    // convertLegacyToolSkeletons). New drops never use it. The marker is
    // derived only from the durable tag, so it replays byte-identically.
    const sentinel = `[dropped \u00a7${tagId}\u00a7]`;

    // OpenCode format: { type: "tool", state: { input: {...}, output: "..." } }
    if (part.type === "tool" && isRecord(part.state)) {
        const state = part.state;
        state.output = sentinel;

        state.input = droppedInputMarker(tagId);

        return;
    }

    // Anthropic format: { type: "tool_result", content: "..." }
    if (part.type === "tool_result") {
        part.content = sentinel;
        return;
    }

    // OpenCode invocation format: { type: "tool-invocation", args: {...} }
    if (part.type === "tool-invocation") {
        part.args = droppedInputMarker(tagId);
        return;
    }

    // Anthropic invocation format: { type: "tool_use", input: {...} }
    if (part.type === "tool_use") {
        part.input = droppedInputMarker(tagId);
    }
}

/**
 * Edit-marker variant of `truncateToolPart` for a superseded edit/write: keep
 * the tool_use call, output → `[dropped §N§]`, but preserve `filePath` verbatim
 * and clamp the diff to a region hint (instead of replacing every argument).
 * A SEPARATE path from `truncateToolPart`: it must never alter the existing
 * skeleton bytes. Deterministic + idempotent (see edit-marker.ts).
 */
function editMarkerToolPart(part: unknown, tagId: number, stripAttachments = false): void {
    if (!isRecord(part)) return;
    const sentinel = `[dropped \u00a7${tagId}\u00a7]`;

    if (part.type === "tool" && isRecord(part.state)) {
        part.state.output = sentinel;
        if (stripAttachments) part.state.attachments = [];
        if (isRecord(part.state.input)) applyEditMarkerToInput(part.state.input);
        return;
    }
    if (part.type === "tool_result") {
        part.content = sentinel;
        return;
    }
    if (part.type === "tool-invocation" && isRecord(part.args)) {
        applyEditMarkerToInput(part.args as Record<string, unknown>);
        return;
    }
    if (part.type === "tool_use" && isRecord(part.input)) {
        applyEditMarkerToInput(part.input as Record<string, unknown>);
    }
}

/**
 * Non-mutating read of a tool part's input object across the formats
 * `truncateToolPart` handles. Returns null when the part carries no input.
 * Used by supersession selection (read `ctx_note` action / edit `filePath`)
 * without touching the wire.
 */
function readToolPartInput(part: unknown): Record<string, unknown> | null {
    if (!isRecord(part)) return null;
    if (part.type === "tool" && isRecord(part.state) && isRecord(part.state.input)) {
        return part.state.input;
    }
    if (part.type === "tool-invocation" && isRecord(part.args)) return part.args;
    if (part.type === "tool_use" && isRecord(part.input)) return part.input;
    return null;
}

export function hasMeaningfulPart(part: unknown): boolean {
    if (!isRecord(part)) return false;
    const type = part.type;
    if (type === "text") {
        if (typeof part.text !== "string") return false;
        return stripTagPrefix(part.text).trim().length > 0;
    }
    if (typeof type !== "string") return false;
    if (IGNORE_PART_TYPES.has(type)) return false;
    return true;
}

/**
 * A drop invalidates the reasoning that led to the dropped call. Take it off
 * the wire whole (see neutralizeDroppedReasoningPart); never rewrite its text,
 * which would leave a signature, opaque payload or encrypted content behind.
 */
function clearThinkingParts(thinkingParts: ThinkingLikePart[]): void {
    for (const part of thinkingParts) neutralizeDroppedReasoningPart(part);
}

function messageHasNativeReasoning(message: MessageLike): boolean {
    return message.parts.some((part) => {
        if (!isRecord(part)) return false;
        return ["thinking", "reasoning", "redacted_thinking"].includes(String(part.type));
    });
}

/**
 * True when a tool part carries a COMPLETED result — i.e. the arc is closed and
 * OpenCode will not read its input again. This is the selection gate that keeps
 * open arcs (an invocation with no result yet) out of every drop/clamp selector.
 *
 * OpenCode's single-part `{ type: "tool" }` representation is classified as a
 * "result" observation by its TYPE even while the call is still pending/running
 * (no output written yet). The arc is closed in either of two arms: a completed
 * result (`state.output` is a string) OR an errored call (`state.status ===
 * "error"`, carrying `state.error`). OpenCode serializes an errored part as an
 * `output-error` block built from `state.error` and never reads its input again
 * (opencode message-v2.ts error arm), so it is just as safe to reclaim as a
 * completed one — excluding it would leak bulky inputs (e.g. a failed write with
 * a large content arg). Pending/running parts have neither an output nor an
 * error status and stay excluded. Anthropic's separate `tool_result` part only
 * exists after the call finished, so it always counts. Invocation-shaped parts
 * (`tool-invocation` / `tool_use`) never carry a result and are excluded here.
 */
export function partHasCompletedResult(part: unknown): boolean {
    if (!isRecord(part)) return false;
    if (part.type === "tool") {
        if (!isRecord(part.state)) return false;
        return typeof part.state.output === "string" || part.state.status === "error";
    }
    return part.type === "tool_result";
}

export function extractToolCallObservation(part: unknown): ToolCallObservation | null {
    if (!isRecord(part)) return null;
    if (part.type === "tool" && isToolCallId(part.callID)) {
        return { callId: part.callID, kind: "result" };
    }
    if (part.type === "tool-invocation" && isToolCallId(part.callID)) {
        return { callId: part.callID, kind: "invocation" };
    }
    if (part.type === "tool_use" && isToolCallId(part.id)) {
        return { callId: part.id, kind: "invocation" };
    }
    if (part.type === "tool_result" && isToolCallId(part.tool_use_id)) {
        return { callId: part.tool_use_id, kind: "result" };
    }
    return null;
}

function isDropContent(content: string): boolean {
    return content.startsWith(DROP_PREFIX);
}

/**
 * The two arrays a pre-adoption pass could serve, offered to a variant
 * resolver before either one is applied. `legacy` is what the original
 * session-wide sweep would serve (every row left without a meaningful part is
 * removed, including rows this pass never touched); `scoped` is what the
 * narrow sweep would serve (only the tool-drop owners this pass emptied).
 */
export interface ToolSweepCandidates {
    legacy: MessageLike[];
    scoped: MessageLike[];
}

/** Choose the sweep variant for this pass; `true` selects the scoped sweep. */
export type ToolSweepVariantResolver = (candidates: ToolSweepCandidates) => boolean;

export class ToolMutationBatch {
    private partsToRemove = new Set<unknown>();
    private affectedMessages = new Set<MessageLike>();
    private messages: MessageLike[];
    private resolvedScopedSweep: boolean | undefined;

    /**
     * `servedMessages` is the array that actually goes to the provider when it
     * is not the array being tagged (see `pruneServedRows`). Leave it undefined
     * whenever tagging and serving share one array.
     */
    constructor(
        messages: MessageLike[],
        private readonly scopedSweep: boolean | ToolSweepVariantResolver = false,
        private readonly servedMessages?: MessageLike[],
    ) {
        this.messages = messages;
    }

    markForRemoval(occurrence: IndexedOccurrence): void {
        this.partsToRemove.add(servedPart(occurrence));
        this.affectedMessages.add(occurrence.message);
    }

    /**
     * Would removing `occurrences` (on top of everything already marked in this
     * batch) leave the provider request ending on an assistant turn?
     *
     * The request ends with the newest message that has any content (a blank
     * pending assistant shell after it does not count). When that message is an
     * assistant, its tool results are what the provider sees as the closing user
     * turn, so at least one must survive. Any other role must keep some content,
     * or the sweep removes it and an earlier assistant becomes the end. Models
     * without assistant prefill support reject an assistant-terminated request.
     */
    wouldStrandConversationEnd(occurrences: readonly IndexedOccurrence[]): boolean {
        const served = this.servedMessages ?? this.messages;
        let end: MessageLike | undefined;
        for (let i = served.length - 1; i >= 0 && end === undefined; i -= 1) {
            if (served[i].parts.some(hasMeaningfulPart)) end = served[i];
        }
        if (!end || !occurrences.some((occurrence) => occurrence.message === end)) return false;
        const leaving = new Set(occurrences.map(servedPart));
        const survives = (part: unknown) => !leaving.has(part) && !this.partsToRemove.has(part);
        return end.info.role === "assistant"
            ? !end.parts.some((part) => partHasCompletedResult(part) && survives(part))
            : !end.parts.some((part) => hasMeaningfulPart(part) && survives(part));
    }

    finalize(): void {
        if (this.partsToRemove.size === 0) return;

        for (const message of this.affectedMessages) {
            message.parts = message.parts.filter((p) => !this.partsToRemove.has(p));
        }

        const scopedSweep = this.resolveScopedSweep();
        const removed = new Set<MessageLike>();
        let writeIndex = 0;
        for (let i = 0; i < this.messages.length; i += 1) {
            // Tool removal must not delete unrelated reasoning-only turns. Existing
            // sessions switch from the old global scan only on a cache-busting pass,
            // because restoring previously removed messages also changes cached bytes.
            if (
                (!scopedSweep || this.affectedMessages.has(this.messages[i])) &&
                !this.messages[i].parts.some(hasMeaningfulPart)
            ) {
                removed.add(this.messages[i]);
            } else {
                this.messages[writeIndex++] = this.messages[i];
            }
        }
        this.messages.length = writeIndex;
        this.pruneServedRows(removed);

        this.partsToRemove.clear();
        this.affectedMessages.clear();
    }

    /** Ask the resolver once per batch so every finalize in a pass sweeps alike. */
    private resolveScopedSweep(): boolean {
        if (typeof this.scopedSweep !== "function") return this.scopedSweep;
        if (this.resolvedScopedSweep === undefined) {
            this.resolvedScopedSweep = this.scopedSweep({
                legacy: this.messages.filter((message) => message.parts.some(hasMeaningfulPart)),
                scoped: this.messages.filter(
                    (message) =>
                        !this.affectedMessages.has(message) ||
                        message.parts.some(hasMeaningfulPart),
                ),
            });
        }
        return this.resolvedScopedSweep;
    }

    /**
     * The array being tagged is not always the array that reaches the provider:
     * on a pass that trims a compaction prefix, tagging runs over the pre-trim
     * copy so persisted drops still find rows the trim removed. Splicing only
     * that copy left the served array holding a message whose parts had all
     * been removed, and the next pass — which sweeps the served array directly
     * — removed it, so two passes over the same history served different
     * arrays. Remove the same rows from both.
     */
    private pruneServedRows(removed: ReadonlySet<MessageLike>): void {
        const served = this.servedMessages;
        if (!served || served === this.messages || removed.size === 0) return;
        for (let i = served.length - 1; i >= 0; i -= 1) {
            if (removed.has(served[i])) served.splice(i, 1);
        }
    }
}

/**
 * Build a TagTarget for a single tool composite key
 * (`<ownerMsgId>\x00<callId>`).
 *
 * v3.3.1 Layer C: pre-fix this took a bare `callId`. Two assistant turns
 * reusing the same callId produced two TagTargets that both pointed at
 * the same `index.get(callId)` entry — last-write-wins on `targets.set`
 * silently merged them into one drop target, and a queued drop on the
 * older tag would mutate the newer turn's content. Composite keys
 * guarantee one TagTarget per (owner, callId) pair, so each turn's tag
 * gets its own independent drop scope.
 *
 * The `index` map is keyed by composite key as well — see
 * `tag-messages.ts` for the matching producer.
 */
export function createToolDropTarget(
    compositeKey: string,
    thinkingParts: ThinkingLikePart[],
    index: ToolCallIndex,
    batch: ToolMutationBatch,
    tagId: number,
): {
    dropReasoningParts: readonly unknown[];
    mutationParts: readonly { message: MessageLike; part: unknown }[];
    setContent: (content: string) => boolean;
    drop: () => ToolDropResult;
    truncate: () => ToolDropResult;
    skeletonReal: () => ToolDropResult;
    editMarker: () => ToolDropResult;
    editMarkerStripped: () => ToolDropResult;
    skeletonStripped: () => ToolDropResult;
    hasAttachments: () => boolean;
    inputStringBytes: () => number | null;
    wouldStrandConversationEnd: () => boolean;
    /**
     * Non-mutating predicate: would drop()/truncate() actually remove bytes?
     * False for an absent (compacted-away) or incomplete (invocation present,
     * no result part) entry — both return early without reclaiming anything.
     * The tiered emergency planner must filter on this, not on the mere
     * presence of a drop() function: counting a no-reclaim tag as droppable
     * makes the plan stop early and under-evict below the ceiling.
     */
    canDrop: () => boolean;
    requiresToolArcSkeleton: boolean;
    readInput: () => Record<string, unknown> | null;
    measureReclaim: (skeleton: boolean) => {
        beforeTools: number;
        afterTools: number;
        beforeProse: number;
        afterProse: number;
    };
} {
    const drop = (): ToolDropResult => {
        const entry = index.get(compositeKey);
        if (!entry || entry.occurrences.length === 0) return "absent";
        if (!entry.hasResult) return "incomplete";
        // If removing this call's result would leave the provider request ending
        // on an assistant turn, keep the call with its REAL arguments plus the
        // placeholder result instead. "truncated" tells callers to persist that
        // mode (`skeleton_real`), so later passes serve the same bytes once newer
        // turns follow.
        if (batch.wouldStrandConversationEnd(entry.occurrences)) return skeletonReal();

        for (const occurrence of entry.occurrences) {
            batch.markForRemoval(occurrence);
        }
        clearThinkingParts(thinkingParts);
        index.delete(compositeKey);
        return "removed";
    };

    const truncate = (): ToolDropResult => {
        const entry = index.get(compositeKey);
        if (!entry || entry.occurrences.length === 0) return "absent";
        if (!entry.hasResult) return "incomplete";

        for (const occurrence of entry.occurrences) {
            // Drop result bytes and replace invocation arguments with a
            // non-executable marker. Rewrite a CLONE so the live part object
            // OpenCode may still execute from stays byte-identical.
            clampCloneInPlace(occurrence, (part) => truncateToolPart(part, tagId));
        }
        clearThinkingParts(thinkingParts);
        return "truncated";
    };

    const skeletonReal = (): ToolDropResult => {
        const entry = index.get(compositeKey);
        if (!entry || entry.occurrences.length === 0) return "absent";
        if (!entry.hasResult) return "incomplete";

        for (const occurrence of entry.occurrences) {
            // Invocation-only parts keep their real arguments untouched; a
            // clone still replaces any earlier clamp from this pass.
            clampCloneInPlace(occurrence, (part) => skeletonRealToolPart(part, tagId));
        }
        clearThinkingParts(thinkingParts);
        return "truncated";
    };

    const skeletonStripped = (): ToolDropResult => {
        const entry = index.get(compositeKey);
        if (!entry || entry.occurrences.length === 0) return "absent";
        if (!entry.hasResult) return "incomplete";
        for (const occurrence of entry.occurrences) {
            clampCloneInPlace(occurrence, (part) => skeletonRealToolPart(part, tagId, true));
        }
        clearThinkingParts(thinkingParts);
        return "truncated";
    };

    const hasAttachments = (): boolean =>
        index
            .get(compositeKey)
            ?.occurrences.some(
                ({ part }) =>
                    isRecord(part) &&
                    isRecord(part.state) &&
                    Array.isArray(part.state.attachments) &&
                    part.state.attachments.length > 0,
            ) ?? false;

    const readRawInput = (): unknown => {
        const entry = index.get(compositeKey);
        if (!entry) return undefined;
        for (const occurrence of entry.occurrences) {
            const input = readToolPartRawInput(occurrence.part);
            if (input !== undefined) return input;
        }
        return undefined;
    };

    const applyEditMarker = (stripAttachments: boolean): ToolDropResult => {
        const entry = index.get(compositeKey);
        if (!entry || entry.occurrences.length === 0) return "absent";
        if (!entry.hasResult) return "incomplete";

        for (const occurrence of entry.occurrences) {
            // Same mutation-safety guarantee as truncate(): clamp a clone, never
            // the live part object.
            clampCloneInPlace(occurrence, (part) =>
                editMarkerToolPart(part, tagId, stripAttachments),
            );
        }
        clearThinkingParts(thinkingParts);
        return "truncated";
    };

    return {
        dropReasoningParts: thinkingParts,
        mutationParts:
            index.get(compositeKey)?.occurrences.map(({ message, part }) => ({ message, part })) ??
            [],
        measureReclaim: (skeleton) => {
            const entry = index.get(compositeKey);
            const parts = entry?.occurrences.map((occ) => occ.part) ?? [];
            const count = (parts: unknown[]) =>
                estimateMessageTokens({
                    info: { id: "reclaim", role: "assistant" },
                    parts,
                } as MessageLike);
            const before = count(parts);
            const retained = skeleton ? structuredClone(parts) : [];
            for (const part of retained) skeletonRealToolPart(part, tagId);
            const after = count(retained);
            // Several calls can share one thinking block; credit only tool I/O here to avoid reclaiming it twice.
            return {
                beforeTools: before.toolCall,
                afterTools: after.toolCall,
                beforeProse: 0,
                afterProse: 0,
            };
        },
        setContent: (content: string): boolean => {
            if (isDropContent(content)) {
                drop();
                return true;
            }

            const entry = index.get(compositeKey);
            if (!entry) return false;

            let changed = false;
            for (const occurrence of entry.occurrences) {
                if (occurrence.kind !== "result") continue;
                const prevContent = getToolContent(occurrence.part);
                if (prevContent !== content) {
                    setToolContent(occurrence.part, content);
                    changed = true;
                }
            }
            return changed;
        },
        drop,
        truncate,
        skeletonReal,
        skeletonStripped,
        hasAttachments,
        editMarker: () => applyEditMarker(false),
        editMarkerStripped: () => applyEditMarker(true),
        inputStringBytes: (): number | null => {
            const entry = index.get(compositeKey);
            if (!entry || entry.occurrences.length === 0) return null;
            return toolInputStringBytes(readRawInput());
        },
        wouldStrandConversationEnd: (): boolean => {
            const entry = index.get(compositeKey);
            if (!entry || entry.occurrences.length === 0) return false;
            return batch.wouldStrandConversationEnd(entry.occurrences);
        },
        canDrop: (): boolean => {
            const entry = index.get(compositeKey);
            return (
                !!entry &&
                entry.occurrences.length > 0 &&
                entry.hasResult &&
                !entry.occurrences.some((occurrence) => toolPartHasUserAnswer(occurrence.part))
            );
        },
        requiresToolArcSkeleton:
            thinkingParts.length > 0 ||
            (index
                .get(compositeKey)
                ?.occurrences.some((occurrence) => messageHasNativeReasoning(occurrence.message)) ??
                false),
        readInput: (): Record<string, unknown> | null => {
            const entry = index.get(compositeKey);
            if (!entry) return null;
            // Prefer an invocation occurrence's input, but fall back to ANY
            // occurrence carrying readable input: a COMPLETED OpenCode tool part
            // is `{ type:"tool", state:{ input, output } }`, classified as a
            // "result" occurrence, yet it still holds the call's input, which is
            // where an edit/write's filePath lives once the call finished.
            for (const occurrence of entry.occurrences) {
                if (occurrence.kind !== "invocation") continue;
                const input = readToolPartInput(occurrence.part);
                if (input) return input;
            }
            for (const occurrence of entry.occurrences) {
                const input = readToolPartInput(occurrence.part);
                if (input) return input;
            }
            return null;
        },
    };
}
