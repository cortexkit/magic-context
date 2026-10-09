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
    if (!anthropic) return false;
    for (let user = messages.length - 1; user >= 0; user--) {
        const message = messages[user];
        if (!isRecord(message)) continue;
        const info = isRecord(message.info) ? message.info : message;
        if (info.role !== "user" || info.synthetic === true || message.synthetic === true) continue;
        const id = typeof info.id === "string" ? info.id : "";
        if (id.startsWith("synth-user-")) continue;
        const parts = Array.isArray(message.parts)
            ? message.parts
            : Array.isArray(message.content)
              ? message.content
              : [];
        if (
            parts.length > 0 &&
            parts.every(
                (part) =>
                    isRecord(part) &&
                    (part.synthetic === true ||
                        part.ignored === true ||
                        ["tool_result", "toolResult", "tool-result"].includes(String(part.type))),
            )
        )
            continue;
        return index > user;
    }
    return false;
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
