import { sessionLog } from "../../shared/logger";
import { appendNudgeToAssistant, reinjectNudgeAtAnchor } from "./nudge-injection";
import type { NudgePlacementStore } from "./nudge-placement-store";
import type { ContextNudge } from "./nudger";
import type { MessageLike } from "./tag-messages";

export function applyContextNudge(
    messages: MessageLike[],
    nudge: ContextNudge | null,
    nudgePlacements: NudgePlacementStore,
    sessionId: string,
): void {
    if (nudge?.type !== "assistant") {
        nudgePlacements.clear(sessionId);
        return;
    }

    const existingPlacement = nudgePlacements.get(sessionId);
    if (!existingPlacement) {
        appendNudgeToAssistant(messages, nudge.text, nudgePlacements, sessionId);
        return;
    }

    if (existingPlacement.nudgeText !== nudge.text) {
        sessionLog(
            sessionId,
            `keeping anchored nudge stable to avoid cache bust: messageId=${existingPlacement.messageId}`,
        );
    }

    const reinjected = reinjectNudgeAtAnchor(
        messages,
        existingPlacement.nudgeText,
        nudgePlacements,
        sessionId,
    );
    if (!reinjected) {
        sessionLog(
            sessionId,
            `preserving anchored nudge without re-anchor to avoid cache bust: messageId=${existingPlacement.messageId}`,
        );
        return;
    }
}
