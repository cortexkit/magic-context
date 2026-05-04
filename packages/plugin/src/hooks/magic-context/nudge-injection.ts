import { sessionLog } from "../../shared/logger";
import type { NudgePlacementStore } from "./nudge-placement-store";
import type { MessageLike } from "./tag-messages";
import { isTextPart } from "./tag-part-guards";

const TRAILING_CONTEXT_NUDGE_PATTERN =
    /(?:\s*<instruction name="(?:context_[^"]+|deferred_notes)">[\s\S]*?<\/instruction>\s*)+$/;
const TRAILING_DEFERRED_NOTES_PATTERN =
    /(?:\s*<instruction name="deferred_notes">[\s\S]*?<\/instruction>\s*)+$/;

function isToolProtocolPart(part: unknown): boolean {
    if (part === null || typeof part !== "object") return false;
    const p = part as Record<string, unknown>;
    return (
        p.type === "tool" ||
        p.type === "tool-invocation" ||
        p.type === "tool_use" ||
        p.type === "tool_result"
    );
}

function hasToolProtocolParts(message: MessageLike): boolean {
    return message.parts.some(isToolProtocolPart);
}

/**
 * Assistant messages with thinking/reasoning/redacted_thinking parts carry
 * signed signatures from the Anthropic API. Any mutation to their content
 * (text, tool calls, thinking) invalidates those signatures and causes
 * Anthropic to reject the request with:
 *   "thinking or redacted_thinking blocks in the latest assistant message
 *    cannot be modified"
 *
 * Treat such messages as immutable from the nudge-injection perspective:
 * never anchor a nudge to them, never rewrite their existing text.
 */
function hasThinkingBearingParts(message: MessageLike): boolean {
    return message.parts.some((part) => {
        if (part === null || typeof part !== "object") return false;
        const p = part as Record<string, unknown>;
        return p.type === "thinking" || p.type === "reasoning" || p.type === "redacted_thinking";
    });
}

function isMessageDropped(message: MessageLike): boolean {
    const textParts = message.parts.filter(isTextPart);
    if (textParts.length === 0) return true;
    return textParts.every(
        (part) => part.text.startsWith("[dropped ") || part.text.startsWith("[cleared]"),
    );
}

function stripTrailingExactNudge(text: string, nudgeText: string): string {
    return text.endsWith(nudgeText) ? text.slice(0, -nudgeText.length) : text;
}

function stripTrailingContextNudges(text: string): string {
    return text.replace(TRAILING_CONTEXT_NUDGE_PATTERN, "");
}

function stripTrailingDeferredNotes(text: string): string {
    return text.replace(TRAILING_DEFERRED_NOTES_PATTERN, "");
}

function isAppendableAssistantMessage(message: MessageLike): boolean {
    return (
        message.info.role === "assistant" &&
        !hasToolProtocolParts(message) &&
        !isMessageDropped(message) &&
        !hasThinkingBearingParts(message)
    );
}

function mergeNudgeText(text: string, currentNudgeText: string, nextNudgeText: string): string {
    const withoutCurrentNudge = stripTrailingExactNudge(text, currentNudgeText);
    const withoutManagedNudges = stripTrailingContextNudges(withoutCurrentNudge);
    return `${withoutManagedNudges}${nextNudgeText}`;
}

export function reinjectNudgeAtAnchor(
    messages: MessageLike[],
    nudgeText: string,
    nudgePlacements: NudgePlacementStore,
    sessionId: string,
): boolean {
    const placement = nudgePlacements.get(sessionId);
    if (!placement) return false;

    for (const message of messages) {
        if (message.info.id !== placement.messageId) continue;
        if (message.info.role !== "assistant") continue;
        if (isMessageDropped(message)) {
            nudgePlacements.clear(sessionId);
            return false;
        }
        if (hasToolProtocolParts(message)) {
            nudgePlacements.clear(sessionId);
            return false;
        }
        if (hasThinkingBearingParts(message)) {
            // Anchor message was signed by Anthropic (has thinking/reasoning/
            // redacted_thinking). Mutating its content would invalidate the
            // signature on the next request. Drop the anchor so we stop
            // targeting it; a future nudge will re-anchor to a safe message.
            sessionLog(
                sessionId,
                `nudge anchor abandoned: message ${message.info.id} now contains thinking/reasoning parts (signed, immutable)`,
            );
            nudgePlacements.clear(sessionId);
            return false;
        }

        for (let j = message.parts.length - 1; j >= 0; j--) {
            const part = message.parts[j];
            if (isTextPart(part)) {
                const nextText = mergeNudgeText(part.text, placement.nudgeText, nudgeText);
                if (nextText !== part.text) {
                    part.text = nextText;
                }
                nudgePlacements.set(sessionId, placement.messageId, nudgeText);
                return true;
            }
        }

        message.parts.push({ type: "text", text: nudgeText } as MessageLike["parts"][number]);
        nudgePlacements.set(sessionId, placement.messageId, nudgeText);
        return true;
    }

    // Anchor message no longer found (deleted/compacted)
    return false;
}

export function appendNudgeToAssistant(
    messages: MessageLike[],
    nudge: string,
    nudgePlacements: NudgePlacementStore,
    sessionId: string,
): void {
    if (messages.length === 0) return;

    // Walk backwards to find the last suitable assistant message
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message.info.role !== "assistant") continue;
        if (hasToolProtocolParts(message)) continue;
        if (isMessageDropped(message)) continue;
        // Skip signed assistant messages (thinking/reasoning parts present):
        // mutating their content invalidates the Anthropic signature.
        if (hasThinkingBearingParts(message)) continue;

        for (let j = message.parts.length - 1; j >= 0; j--) {
            const part = message.parts[j];
            if (isTextPart(part)) {
                const nextText = mergeNudgeText(part.text, nudge, nudge);
                if (nextText === part.text) {
                    if (message.info.id) {
                        nudgePlacements.set(sessionId, message.info.id, nudge);
                    }
                    return;
                }
                part.text = nextText;
                if (message.info.id) {
                    nudgePlacements.set(sessionId, message.info.id, nudge);
                    sessionLog(
                        sessionId,
                        `nudge placed on assistant message ${message.info.id} (index ${i}/${messages.length})`,
                    );
                }
                return;
            }
        }

        // No text part found on this assistant message — push one
        message.parts.push({ type: "text", text: nudge } as MessageLike["parts"][number]);
        if (message.info.id) {
            nudgePlacements.set(sessionId, message.info.id, nudge);
            sessionLog(
                sessionId,
                `nudge pushed as new part on assistant message ${message.info.id} (index ${i}/${messages.length})`,
            );
        }
        return;
    }

    sessionLog(
        sessionId,
        `nudge placement failed: no suitable assistant message found (${messages.length} messages)`,
    );
}

export function appendSupplementalNudgeToAssistant(
    messages: MessageLike[],
    nudge: string,
    nudgePlacements: NudgePlacementStore,
    sessionId: string,
): boolean {
    const appendToMessage = (message: MessageLike): boolean => {
        if (!isAppendableAssistantMessage(message)) return false;

        for (let j = message.parts.length - 1; j >= 0; j--) {
            const part = message.parts[j];
            if (isTextPart(part)) {
                const nextText = `${stripTrailingDeferredNotes(part.text)}${nudge}`;
                if (nextText !== part.text) {
                    part.text = nextText;
                }
                return true;
            }
        }

        message.parts.push({ type: "text", text: nudge } as MessageLike["parts"][number]);
        return true;
    };

    const placement = nudgePlacements.get(sessionId);
    if (!placement) return false;

    for (const message of messages) {
        if (message.info.id !== placement.messageId) continue;
        return appendToMessage(message);
    }

    return false;
}

export function canAppendSupplementalNudgeToAssistant(
    messages: MessageLike[],
    nudgePlacements: NudgePlacementStore,
    sessionId: string,
): boolean {
    const placement = nudgePlacements.get(sessionId);
    if (!placement) return false;

    const anchoredMessage = messages.find((message) => message.info.id === placement.messageId);
    return anchoredMessage ? isAppendableAssistantMessage(anchoredMessage) : false;
}
