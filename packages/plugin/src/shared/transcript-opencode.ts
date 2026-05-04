/**
 * OpenCode adapter for the harness-agnostic transcript interface.
 *
 * This is a thin proxy over OpenCode's `MessageLike[]` (i.e. `{ info,
 * parts: unknown[] }[]`) — it does NOT copy data. Mutations through
 * `setText`/`setToolOutput`/`replaceWithSentinel` write directly into
 * the source `parts[]` arrays, exactly as the existing OpenCode-only
 * transform code does today. `commit()` is a no-op because OpenCode's
 * AI SDK reads `parts[]` back from the same array we mutated.
 *
 * This module is the boundary that lets the rest of the transform code
 * (which moves to use the Transcript interface in 4b.2) work both for
 * OpenCode and Pi without branching on harness type. By the end of 4b
 * the only OpenCode-aware code in the plugin is this file plus
 * `messages-transform.ts`.
 *
 * ## Mutation contract recap
 *
 * Magic Context's transform mutates message parts in three ways:
 *
 *  1. **Tag prefix injection** — prepends `§N§ ` to text parts and
 *     tool result outputs. Repeated tagging is idempotent because
 *     `prependTag` strips any existing prefix first.
 *
 *  2. **Sentinel replacement** — when a queued drop fires, the part is
 *     replaced with a `[dropped §N§]` or `[truncated §N§]` placeholder.
 *     The original tag number is preserved so the agent's mental
 *     model of "what was here" survives.
 *
 *  3. **Structural noise stripping** — `step-start`/`step-finish`
 *     wrappers and similar structural metadata are replaced with empty
 *     sentinel parts so they don't consume tag numbers or get tagged
 *     themselves.
 *
 * The OpenCode adapter implements (1) and (2) by editing `part.text` /
 * `part.state.output` in place. For (3), structural parts surface as
 * `kind: "structural"` so callers can filter them out. Adapter does NOT
 * itself perform stripping — that's the transform pipeline's job, called
 * after the adapter wraps the messages.
 *
 * Step 4b.1 ships the adapter alone. The existing OpenCode transform
 * code keeps using `MessageLike[]` directly until 4b.2 migrates the
 * tagging+drops layer to use Transcript instances.
 */

import { isRecord } from "./record-type-guard";
import type {
    Transcript,
    TranscriptMessage,
    TranscriptPart,
    TranscriptPartKind,
} from "./transcript";

/**
 * The OpenCode `MessageLike` shape. Re-declared here to avoid a circular
 * import with `tag-messages.ts` (which lives in the magic-context hooks
 * tree and depends on storage). Keeping a local minimal type also makes
 * the adapter trivially unit-testable without booting OpenCode SDK
 * types.
 *
 * MUST stay structurally compatible with `tag-messages.ts MessageLike` —
 * if that file's MessageLike adds a required field, this one needs to
 * add it too. The build will fail loudly if the shapes diverge.
 */
export interface OpenCodeMessageLike {
    info: { id?: string; role?: string; sessionID?: string };
    parts: unknown[];
}

/**
 * Wrap an existing `MessageLike[]` as a Transcript. Zero copies — every
 * `TranscriptPart` returned proxies the matching entry in the source
 * `parts` array, and mutations are reflected immediately.
 */
export function createOpenCodeTranscript(messages: OpenCodeMessageLike[]): Transcript {
    const transcriptMessages: TranscriptMessage[] = messages.map((message) => ({
        info: {
            id: message.info.id,
            role: message.info.role ?? "unknown",
            sessionId: message.info.sessionID,
        },
        // `parts` is a getter so newly-replaced sentinels inside the
        // underlying array are surfaced on the next read. Cheap; allocs
        // one wrapper per part per access. Adapter callers iterate
        // `messages` once per pass so the cost is O(parts) per pass —
        // same as before the adapter existed.
        get parts(): TranscriptPart[] {
            return message.parts.map((part, index) => createOpenCodePart(message, index, part));
        },
    }));

    return {
        messages: transcriptMessages,
        harness: "opencode",
        // OpenCode reads parts back from the same `parts[]` array we
        // mutated, so there's nothing to flush. Adapters that buffer
        // mutations (Pi) override this.
        commit(): void {
            /* no-op for OpenCode */
        },
    };
}

/**
 * Construct a TranscriptPart proxy over a single OpenCode part.
 *
 * Held by `parts` getter calls only; never cached because the underlying
 * `parts[]` array can be mutated in place (sentinel replacement) and
 * cached proxies would point at stale data. The constructor cost is
 * trivial — small object literal, no allocations beyond the closure.
 */
function createOpenCodePart(
    parent: OpenCodeMessageLike,
    index: number,
    rawPart: unknown,
): TranscriptPart {
    const kind = classifyOpenCodePart(rawPart);
    const id = extractPartId(rawPart);

    return {
        kind,
        id,
        getText(): string | undefined {
            return readOpenCodePartText(rawPart);
        },
        setText(newText: string): boolean {
            return writeOpenCodePartText(rawPart, newText);
        },
        setToolOutput(newText: string): boolean {
            return writeOpenCodeToolOutput(rawPart, newText);
        },
        getToolMetadata(): { toolName: string | undefined; inputByteSize: number } {
            return readOpenCodeToolMetadata(rawPart);
        },
        replaceWithSentinel(sentinelText: string): boolean {
            // Build a synthetic text part that carries the sentinel as
            // its content. Subsequent passes see this as a normal text
            // part with kind="text" — but the existing tagging code is
            // idempotent and won't double-tag a part that already has
            // the right prefix, so re-processing is safe.
            //
            // We DON'T preserve the original part type. Sentinels are
            // always text — that's the contract the existing
            // apply-operations code expects.
            const sentinelPart = { type: "text", text: sentinelText };
            parent.parts[index] = sentinelPart;
            return true;
        },
    };
}

/** Classify part kind based on `type` field. Falls back to "unknown". */
function classifyOpenCodePart(part: unknown): TranscriptPartKind {
    if (!isRecord(part)) return "unknown";
    const type = part.type;
    if (typeof type !== "string") return "unknown";
    switch (type) {
        case "text":
            return "text";
        case "reasoning":
            return "thinking";
        case "tool":
            return "tool_use";
        case "file":
            return "file";
        case "image":
            return "image";
        case "step-start":
        case "step-finish":
            return "structural";
        default:
            return "unknown";
    }
}

/**
 * Extract a stable per-part identifier when present. Used by the dropped-
 * placeholder watermark to track which sentinels are already replayed
 * across passes.
 */
function extractPartId(part: unknown): string | undefined {
    if (!isRecord(part)) return undefined;
    if (typeof part.id === "string" && part.id.length > 0) return part.id;
    if (typeof part.callID === "string" && part.callID.length > 0) return part.callID;
    return undefined;
}

function readOpenCodePartText(part: unknown): string | undefined {
    if (!isRecord(part)) return undefined;
    if (typeof part.text === "string") return part.text;
    if (typeof part.thinking === "string") return part.thinking;
    if (part.type === "tool") {
        const state = isRecord(part.state) ? part.state : null;
        const output = state && typeof state.output === "string" ? state.output : "";
        return output;
    }
    return undefined;
}

function writeOpenCodePartText(part: unknown, newText: string): boolean {
    if (!isRecord(part)) return false;
    const writable = part as Record<string, unknown>;
    if (typeof writable.text === "string") {
        if (writable.text === newText) return false;
        writable.text = newText;
        return true;
    }
    if (typeof writable.thinking === "string") {
        if (writable.thinking === newText) return false;
        writable.thinking = newText;
        return true;
    }
    return false;
}

function writeOpenCodeToolOutput(part: unknown, newText: string): boolean {
    if (!isRecord(part)) return false;
    if (part.type !== "tool") return false;
    const state = isRecord(part.state) ? (part.state as Record<string, unknown>) : null;
    if (!state) return false;
    if (typeof state.output !== "string") return false;
    if (state.output === newText) return false;
    state.output = newText;
    return true;
}

function readOpenCodeToolMetadata(part: unknown): {
    toolName: string | undefined;
    inputByteSize: number;
} {
    if (!isRecord(part)) return { toolName: undefined, inputByteSize: 0 };
    if (part.type !== "tool") return { toolName: undefined, inputByteSize: 0 };

    // OpenCode parts use `tool` as the tool name field; some legacy
    // shapes use `toolName` or `name`. Match all three for forward
    // compatibility with shape evolution.
    const toolName =
        typeof part.tool === "string"
            ? part.tool
            : typeof part.toolName === "string"
              ? part.toolName
              : typeof part.name === "string"
                ? part.name
                : undefined;

    const state = isRecord(part.state) ? part.state : null;
    const input = state?.input ?? part.args ?? part.input;

    let inputByteSize = 0;
    if (input !== undefined && input !== null) {
        try {
            inputByteSize = JSON.stringify(input).length;
        } catch {
            inputByteSize = 0;
        }
    }

    return { toolName, inputByteSize };
}
