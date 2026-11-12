import { isRecord } from "../../shared/record-type-guard";
import { isAnthropicFamilyRoute } from "./sentinel";

/** The active turn starts at the last actual user request, not at a tool-result
 * carrier or a synthesized context message. Keep this predicate independent of
 * retention and replay so every first-selection lane can use the same boundary.
 */
export function isInActiveAnthropicTurn<T>(
    messages: readonly T[],
    index: number,
    anthropic: boolean,
): boolean {
    const start = activeAnthropicTurnStart(messages, anthropic);
    return start !== undefined && index >= start;
}

/** Resolve the shared user boundary once when classifying many messages. */
export function activeAnthropicTurnStart<T>(
    messages: readonly T[],
    anthropic: boolean,
): number | undefined {
    if (!anthropic) return undefined;
    for (let user = messages.length - 1; user >= 0; user--) {
        if (isRealUserRequest(messages[user])) return user + 1;
    }
    return undefined;
}

/**
 * A user message the person (not the host or Magic Context) sent: not a
 * synthesized context message and not a carrier holding only tool results or
 * ignored parts. Such a message opens a new Anthropic turn.
 */
export function isRealUserRequest(message: unknown): boolean {
    if (!isRecord(message)) return false;
    const info = isRecord(message.info) ? message.info : message;
    if (info.role !== "user" || info.synthetic === true || message.synthetic === true) return false;
    const id = typeof info.id === "string" ? info.id : "";
    if (id.startsWith("synth-user-")) return false;
    const parts = Array.isArray(message.parts)
        ? message.parts
        : Array.isArray(message.content)
          ? message.content
          : [];
    return !(
        parts.length > 0 &&
        parts.every(
            (part) =>
                isRecord(part) &&
                (part.synthetic === true ||
                    part.ignored === true ||
                    ["tool_result", "toolResult", "tool-result"].includes(String(part.type))),
        )
    );
}

/** Host-independent inference for pure adapters; live callers also supply their route. */
export function hasAnthropicReasoning(messages: readonly unknown[]): boolean {
    return messages.some((message) => {
        if (!isRecord(message)) return false;
        const info = isRecord(message.info) ? message.info : message;
        if (
            isAnthropicFamilyRoute(
                typeof info.providerID === "string"
                    ? info.providerID
                    : typeof info.provider === "string"
                      ? info.provider
                      : undefined,
                typeof info.modelID === "string"
                    ? info.modelID
                    : typeof info.model === "string"
                      ? info.model
                      : undefined,
            )
        )
            return true;
        const parts = Array.isArray(message.parts) ? message.parts : [];
        return parts.some(
            (part) =>
                isRecord(part) && isRecord(part.metadata) && isRecord(part.metadata.anthropic),
        );
    });
}
