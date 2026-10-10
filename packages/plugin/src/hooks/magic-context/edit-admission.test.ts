import { describe, expect, it } from "bun:test";
import corpus from "../../../../../crates/mc-module/testdata/edit-admission.json";
import { assertAdmissionParity } from "./__tests__/admission-parity.test";
import {
    admitCompound,
    createEditAdmission,
    type EditCoord,
    isAdmissionUser,
    thinkingAnchor,
} from "./edit-admission";
import { protectNewTagMutations, retainedActiveThinkingParts } from "./latest-assistant-turn";
import type { MessageLike, TagTarget } from "./tag-messages";

function messagesOf(row: (typeof corpus)[number]): MessageLike[] {
    return row.messages.map((m) => ({
        info: { ...m },
        parts: "parts" in m ? (m.parts ?? []) : [],
    }));
}

describe("served-occurrence admission corpus", () => {
    for (const row of corpus) {
        it(row.name, () => {
            const messages = messagesOf(row);
            const prefixBound = !("prefixBound" in row) || row.prefixBound !== false;
            const admission = createEditAdmission({
                messages,
                prefixBound,
                stableId: (m) => m.info.id,
                partsOf: (m) => m.parts,
                isRealUser: isAdmissionUser,
                anchorOf: thinkingAnchor,
                isRetainedThinking: (m, p) =>
                    m.info.role === "assistant" &&
                    ["reasoning", "thinking", "redacted_thinking", "redacted_reasoning"].includes(
                        (p as { type: string }).type,
                    ) &&
                    (p as { retained?: boolean }).retained !== false,
            });
            for (const edit of row.edits)
                expect(admission.admit(edit.coord as EditCoord)).toBe(edit.admit);
            if ("compound" in row)
                for (const edit of row.compound ?? [])
                    expect(admitCompound(admission, edit.coords as EditCoord[])).toBe(edit.admit);
            if (!row.name.includes("not retained")) assertAdmissionParity(messages, prefixBound);
        });
    }
});

it("replayed skeleton identity regression holds a clone the old map cannot locate", () => {
    const row = corpus.find((r) => r.name === "replayed skeleton clone before boundary")!;
    const messages = messagesOf(row);
    const clone = structuredClone(messages[1]);
    const thinking = messages[2].parts[0];
    const target: TagTarget = {
        message: clone,
        mutationParts: [{ message: clone, part: clone.parts[0] }],
        setContent: () => true,
    };
    const old = protectNewTagMutations(messages, new Map([[1, target]]), new Set([thinking]), true);
    expect(old.get(1)?.thinkingRewriteProtected).not.toBe(true);
    const admission = createEditAdmission({
        messages,
        prefixBound: true,
        stableId: (m) => m.info.id,
        partsOf: (m) => m.parts,
        isRealUser: isAdmissionUser,
        isRetainedThinking: (_m, p) => p === thinking,
        anchorOf: thinkingAnchor,
    });
    expect(admission.admit({ kind: "message", id: clone.info.id, block: 0 })).toBe(false);
});

it("rejected models still protect drops of either retained thinking part", () => {
    const messages = messagesOf(
        corpus.find((r) => r.name === "two OpenCode signed parts and tail")!,
    );
    const protectedParts = new Set([messages[1].parts[0], messages[1].parts[2]]);
    for (const part of protectedParts) {
        const target: TagTarget = {
            message: messages[1],
            dropReasoningParts: [part],
            setContent: () => true,
        };
        const protectedTarget = protectNewTagMutations(
            messages,
            new Map([[1, target]]),
            protectedParts,
            false,
        ).get(1)!;
        expect(protectedTarget.thinkingDropProtected).toBe(true);
        expect(protectedTarget.thinkingRewriteProtected).toBe(false);
        expect(protectedTarget.canDrop?.()).toBe(false);
        for (const mutator of [
            protectedTarget.drop,
            protectedTarget.truncate,
            protectedTarget.skeletonReal,
            protectedTarget.skeletonStripped,
            protectedTarget.editMarker,
            protectedTarget.editMarkerStripped,
        ])
            expect(mutator?.()).toBe("incomplete");
        expect(protectedTarget.setContent("replacement")).toBe(false);
        expect(protectedTarget.setContent("replacement", { keepReasoning: true })).toBe(true);
    }
});

it("persisted binding and merged omissions are absent from the retained replay view", () => {
    const messages = messagesOf(corpus.find((r) => r.name === "merged consecutive assistants")!);
    const retained = retainedActiveThinkingParts({
        messages,
        providerID: "anthropic",
        modelID: "claude-opus-5-5",
        bindingIds: new Set(["assistant-b"]),
        mergedIds: new Set(['__merged_reasoning_parts_v1__:["assistant-a",[0]]']),
    });
    expect(retained.size).toBe(0);
    expect(messages[1].parts.length).toBe(2);
    expect(messages[2].parts.length).toBe(2);
});

it("frame visits only the tail and boundary on a 2000-message history", () => {
    const messages = Array.from({ length: 2000 }, (_, i) => ({
        info: { id: `m-${i}`, role: "assistant" },
        parts: [] as unknown[],
    }));
    messages[0].info.role = "user";
    messages[1996].parts.push({ type: "reasoning", signature: "signed" });
    let visits = 0;
    const args = {
        messages,
        prefixBound: true,
        stableId: (m: MessageLike) => m.info.id,
        partsOf: (m: MessageLike) => m.parts,
        isRealUser: (m: MessageLike) => {
            visits++;
            return isAdmissionUser(m);
        },
        isRetainedThinking: (_m: MessageLike, p: unknown) =>
            (p as { type?: string })?.type === "reasoning",
        anchorOf: thinkingAnchor,
    };
    expect(createEditAdmission(args).frame.kind).toBe("boundary");
    expect(visits).toBe(4);
    messages[1996].parts = [];
    messages[1990].info.role = "user";
    visits = 0;
    expect(createEditAdmission(args).frame.kind).toBe("none");
    expect(visits).toBe(10);
});
