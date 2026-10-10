/**
 * The part of a host message the provider receives, for comparisons and
 * snapshots that must follow provider bytes and nothing else.
 *
 * Only a tool part's `state` is reduced; every other field of every part, and
 * the message info, is kept as it is. The kept state fields are an explicit
 * allowlist of what the hosts' model conversions read:
 *
 * - OpenCode 1 builds the request from the transformed messages only through
 *   `MessageV2.toModelMessagesEffect` (called right after the
 *   `experimental.chat.messages.transform` hook in
 *   packages/opencode/src/session/prompt.ts at v1.18.35). Its tool branch
 *   (packages/opencode/src/session/message-v2.ts) reads `state.status`,
 *   `state.input`, `state.output`, `state.error`, `state.attachments`,
 *   `state.time.compacted`, and on an `error` state `state.metadata.interrupted`
 *   and `state.metadata.output`.
 * - OpenCode 2 receives the transformed messages back through the context
 *   hook's commit (src/v2/hooks/payload.ts), which reads `state.input`,
 *   `state.status`, `state.output`, `state.error` and `state.content`; its own
 *   lowering (packages/core/src/session/runner/to-llm-message.ts at v2.0.24)
 *   reads tool `input`, `content` and `error`.
 *
 * Everything else in a tool state is UI data: edit and write tools store
 * workspace-wide LSP diagnostics, diffs and file snapshots in `state.metadata`,
 * often several MiB per part and nearly all of a long coding session's bytes,
 * plus `title`, the start and end times and the raw streamed input. Walking,
 * copying, hashing or storing that on every pass cost tens of seconds, and a
 * change to it, which no provider sees, must not count as a content change.
 *
 * A state field a future host version starts sending must be added to the
 * allowlist; the provider-request test vendors the conversions above to catch
 * a difference.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Tool state fields copied as they are. */
const KEPT_TOOL_STATE_FIELDS = new Set([
    "status",
    "input",
    "output",
    "error",
    "attachments",
    "content",
]);
/** Of `state.time`, only this field is read (and `time` itself must stay an object). */
const KEPT_TOOL_STATE_TIME_FIELD = "compacted";
/** Of `state.metadata`, only these fields are read, and only on an `error` state. */
const KEPT_ERROR_METADATA_FIELDS = ["interrupted", "output"] as const;

function providerVisibleToolState(state: Record<string, unknown>): Record<string, unknown> {
    const view: Record<string, unknown> = {};
    for (const key of Object.keys(state)) {
        const value = state[key];
        if (KEPT_TOOL_STATE_FIELDS.has(key)) {
            view[key] = value;
        } else if (key === "time" && isRecord(value)) {
            view.time =
                value[KEPT_TOOL_STATE_TIME_FIELD] === undefined
                    ? {}
                    : { [KEPT_TOOL_STATE_TIME_FIELD]: value[KEPT_TOOL_STATE_TIME_FIELD] };
        } else if (key === "metadata" && state.status === "error" && isRecord(value)) {
            const kept: Record<string, unknown> = {};
            for (const field of KEPT_ERROR_METADATA_FIELDS) {
                if (Object.hasOwn(value, field)) kept[field] = value[field];
            }
            view.metadata = kept;
        }
    }
    return view;
}

/** Whether reducing the state would change it; most states are already reduced. */
function toolStateIsReduced(state: Record<string, unknown>): boolean {
    for (const key of Object.keys(state)) {
        if (KEPT_TOOL_STATE_FIELDS.has(key)) continue;
        const value = state[key];
        if (key === "time" && isRecord(value)) {
            const keys = Object.keys(value);
            if (keys.length === 0) continue;
            if (keys.length === 1 && keys[0] === KEPT_TOOL_STATE_TIME_FIELD) continue;
            return false;
        }
        if (key === "metadata" && state.status === "error" && isRecord(value)) {
            const extra = Object.keys(value).some(
                (field) => !(KEPT_ERROR_METADATA_FIELDS as readonly string[]).includes(field),
            );
            if (!extra) continue;
        }
        return false;
    }
    return true;
}

/**
 * The part as the provider sees it. Returns the same object when nothing needs
 * removing, otherwise a shallow copy with a reduced `state`; the input is never
 * changed.
 */
export function providerVisiblePart(part: unknown): unknown {
    if (!isRecord(part) || part.type !== "tool" || !isRecord(part.state)) return part;
    if (toolStateIsReduced(part.state)) return part;
    return { ...part, state: providerVisibleToolState(part.state) };
}

/**
 * The message with each part reduced by {@link providerVisiblePart}. Returns the
 * same object when no part changes.
 */
export function providerVisibleMessage<T>(message: T): T {
    if (!isRecord(message) || !Array.isArray(message.parts)) return message;
    let parts: unknown[] | undefined;
    for (let index = 0; index < message.parts.length; index += 1) {
        const part = message.parts[index];
        const view = providerVisiblePart(part);
        if (view !== part) {
            parts ??= message.parts.slice(0, index);
            parts.push(view);
        } else if (parts) {
            parts.push(part);
        }
    }
    return parts ? ({ ...message, parts } as T) : message;
}
