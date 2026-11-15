import type { TagEntry } from "../../features/magic-context/types";
import { toolPartHasUserAnswer } from "../../shared/user-answer";
import type { MessageLike } from "./tag-messages";

/** Rule-based drops of tool results the agent no longer needs; every rule is opt-in. */
export interface AutoDropConfig {
    /** Drop a read once a later read of the same file covers its range. */
    reread: boolean;
    /** Drop a failed call once a later call of the same tool succeeds. */
    retriedErrors: boolean;
}

const READ_TOOLS = new Set(["read", "mcp_read"]);
// OpenCode's error text for a call the user declined; it can carry the user's feedback.
const USER_REJECTION = /user rejected|rejected permission/i;

interface ToolCall {
    tag: TagEntry;
    tool: string;
    status: unknown;
    input: Record<string, unknown>;
    hasUserAnswer: boolean;
    rejected: boolean;
}

/**
 * Tag numbers of tool results the rules mark as no longer needed. `messages`
 * is in conversation order; `tagsByCompositeKey` maps `<ownerMsgId>\x00<callId>`
 * to the active tool tag.
 */
export function selectAutoDropTags(
    messages: readonly MessageLike[],
    tagsByCompositeKey: ReadonlyMap<string, TagEntry>,
    config: AutoDropConfig,
): Set<number> {
    const calls: ToolCall[] = [];
    for (const message of messages) {
        if (message.info.role !== "assistant" || typeof message.info.id !== "string") continue;
        for (const part of message.parts) {
            const record = part as Record<string, unknown>;
            if (record.type !== "tool" || typeof record.tool !== "string") continue;
            if (typeof record.callID !== "string") continue;
            const tag = tagsByCompositeKey.get(`${message.info.id}\x00${record.callID}`);
            if (!tag) continue;
            const state = (record.state ?? {}) as Record<string, unknown>;
            // OpenCode 2 hands failed calls over with the error text in `output`.
            const result = typeof state.output === "string" ? state.output : state.error;
            calls.push({
                tag,
                tool: record.tool,
                status: state.status,
                input: (state.input ?? {}) as Record<string, unknown>,
                hasUserAnswer: toolPartHasUserAnswer(record),
                rejected: typeof result === "string" && USER_REJECTION.test(result),
            });
        }
    }

    const selected = new Set<number>();
    calls.forEach((call, index) => {
        if (call.hasUserAnswer) return;
        const later = calls.slice(index + 1);
        if (config.reread && call.status === "completed" && READ_TOOLS.has(call.tool)) {
            if (later.some((next) => next.status === "completed" && covers(next, call))) {
                selected.add(call.tag.tagNumber);
                return;
            }
        }
        if (config.retriedErrors && call.status === "error" && !call.rejected) {
            if (later.some((next) => next.tool === call.tool && next.status === "completed")) {
                selected.add(call.tag.tagNumber);
            }
        }
    });
    return selected;
}

// A later read covers an earlier one of the same file when it reads the whole
// file or exactly the same window.
function covers(later: ToolCall, earlier: ToolCall): boolean {
    if (!READ_TOOLS.has(later.tool)) return false;
    const path = readPath(earlier.input);
    if (path === undefined || readPath(later.input) !== path) return false;
    if (later.input.offset === undefined && later.input.limit === undefined) return true;
    return later.input.offset === earlier.input.offset && later.input.limit === earlier.input.limit;
}

// OpenCode 2's read takes `path`; OpenCode 1 took `filePath`.
function readPath(input: Record<string, unknown>): string | undefined {
    const path = input.path ?? input.filePath;
    return typeof path === "string" ? path : undefined;
}
