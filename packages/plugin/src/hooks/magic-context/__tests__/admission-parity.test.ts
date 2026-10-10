import { expect } from "bun:test";
import { createEditAdmission, isAdmissionUser, thinkingAnchor } from "../edit-admission";
import { latestAssistantTurnStart, protectNewTagMutations } from "../latest-assistant-turn";
import type { MessageLike, TagTarget } from "../tag-messages";

/** Compare every served part, not just the lane selected for mutation in this pass. */
export function assertAdmissionParity(messages: MessageLike[], prefixBound: boolean): void {
    const retained = new Set<unknown>();
    for (const message of messages.slice(latestAssistantTurnStart(messages))) {
        if (message.info.role !== "assistant") continue;
        for (const part of message.parts) {
            const type = (part as { type?: string })?.type;
            if (["reasoning", "thinking", "redacted_thinking"].includes(type ?? ""))
                retained.add(part);
        }
    }
    const admission = createEditAdmission({
        messages,
        prefixBound,
        stableId: (m) => m.info.id,
        partsOf: (m) => m.parts,
        isRealUser: isAdmissionUser,
        isRetainedThinking: (_m, p) => retained.has(p),
        anchorOf: thinkingAnchor,
    });
    let tag = 0;
    const targets = new Map<number, TagTarget>();
    for (const message of messages)
        for (const part of message.parts) {
            targets.set(++tag, {
                message,
                mutationParts: [{ message, part }],
                setContent: () => true,
            });
        }
    const old = protectNewTagMutations(messages, targets, retained, prefixBound);
    for (const [number, target] of targets) {
        if (!old.get(number)?.thinkingRewriteProtected) continue;
        expect(
            admission.admit({
                kind: "message",
                id: target.message!.info.id,
                block: target.message!.parts.indexOf(target.mutationParts![0].part),
            }),
        ).toBe(false);
    }
}
