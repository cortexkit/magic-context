/**
 * Detect whether the agent currently has a visible `ctx_note(action="read")`
 * tool call in their conversation context.
 *
 * Scope and timing
 * ----------------
 * Run this AFTER all message-array drops have been materialized in the
 * transform pipeline (i.e. inside `runPostTransformPhase`, not inside
 * `tagMessages`). By that point:
 *   - queued user `ctx_reduce` ops have been applied
 *   - heuristic cleanup (auto_drop_tool_age, clear_reasoning_age) ran
 *   - sentinel/replay logic neutralized previously-stripped parts
 * So if a `ctx_note` read is still a real, non-sentinel part in the
 * messages array we're about to send, the agent will actually see it.
 *
 * Why this matters
 * ----------------
 * Note nudges are normally suppressed when the agent already ran
 * `ctx_note(read)` since the latest note activity (see `note-nudger.ts`).
 * That suppression is correct ONLY while the read result is still in
 * context. Once the read tool call is dropped (compartmentalized, aged
 * out, or removed by `ctx_reduce`) the agent no longer has visibility
 * into the notes — re-surfacing them at the next work-boundary trigger
 * is the right thing to do.
 *
 * Implementation
 * --------------
 * Single backward pass over the messages array. Scans newest-first because
 * the most recent reads are the ones most likely to still be visible; we
 * can return as soon as one survives.
 *
 * `isSentinel` skips parts that have been neutralized to an empty-text
 * placeholder by the strip/replay pipeline — those parts are present in
 * the array (for cache-key stability) but invisible to the LLM.
 */

import { isRecord } from "../../shared/record-type-guard";
import { isSentinel } from "./sentinel";
import type { MessageLike } from "./tag-messages";

const NOTE_TOOL_NAMES = new Set(["ctx_note"]);
const READ_ACTION = "read";

/**
 * Returns true if the messages array contains at least one non-stripped
 * `ctx_note(action="read")` tool call/result pair. Order doesn't matter for
 * correctness — any visible read counts.
 */
export function hasVisibleNoteReadCall(messages: MessageLike[]): boolean {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const parts = messages[i]?.parts;
        if (!Array.isArray(parts)) continue;
        for (const part of parts) {
            if (isSentinel(part)) continue;
            if (isVisibleNoteReadPart(part)) return true;
        }
    }
    return false;
}

/**
 * Detect a `ctx_note(action="read")` tool call across the three OpenCode
 * part shapes (mirrors the dispatch table in `drop-stale-reduce-calls.ts`):
 *
 *   - `{ type: "tool", tool: "ctx_note", state: { input: { action: "read" } } }`
 *   - `{ type: "tool_use", name: "ctx_note", input: { action: "read" } }`
 *   - `{ type: "tool-invocation", toolName: "ctx_note", args|input: { action: "read" } }`
 *
 * We intentionally only count `action: "read"` because that is the only
 * `ctx_note` invocation that surfaces note content to the agent. Writes,
 * updates, and dismisses do not put the note list in front of the agent,
 * so they should not suppress a future "review your notes" nudge.
 */
function isVisibleNoteReadPart(part: unknown): boolean {
    if (!isRecord(part)) return false;

    // OpenCode tool format. The agent-visible input lives at `state.input`
    // for completed calls; in-flight calls may not have state populated yet
    // but those don't surface a result anyway, so they shouldn't count.
    if (part.type === "tool" && typeof part.tool === "string" && NOTE_TOOL_NAMES.has(part.tool)) {
        const state = part.state;
        if (isRecord(state) && isRecord(state.input)) {
            return state.input.action === READ_ACTION;
        }
        return false;
    }

    // tool_use format used by some provider serializers.
    if (
        part.type === "tool_use" &&
        typeof part.name === "string" &&
        NOTE_TOOL_NAMES.has(part.name)
    ) {
        if (isRecord(part.input)) {
            return part.input.action === READ_ACTION;
        }
        return false;
    }

    // tool-invocation format — args may be under `args` or `input` depending
    // on serializer version; check both for forward-compat.
    if (
        part.type === "tool-invocation" &&
        typeof part.toolName === "string" &&
        NOTE_TOOL_NAMES.has(part.toolName)
    ) {
        const argsCandidate = part.args ?? part.input;
        if (isRecord(argsCandidate)) {
            return argsCandidate.action === READ_ACTION;
        }
        return false;
    }

    return false;
}
