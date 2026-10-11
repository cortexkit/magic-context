import { describe, expect, test } from "bun:test";
import { createEditAdmission, isAdmissionUser, thinkingAnchor } from "./edit-admission";
import { stripDroppedPlaceholderMessages, stripSystemInjectedMessages } from "./strip-content";
import type { MessageLike } from "./tag-messages";

const review = process.env.MC_S03A_REVIEW === "1" ? describe : describe.skip;

review("signed-thinking s03a review: OpenCode strip coordinates", () => {
    for (const lane of ["placeholder", "system"] as const) {
        test(`${lane} holds before thinking, admits tail, then releases at the next user`, () => {
            const text =
                lane === "placeholder"
                    ? "[dropped §998§]"
                    : "<system-reminder>Background task bg-7 completed</system-reminder>";
            const retained = {
                type: "reasoning",
                text: "kept",
                metadata: { anthropic: { signature: "signed" } },
            };
            const user: MessageLike = {
                info: { id: "u", role: "user" },
                parts: [{ type: "text", text: "inspect parser" }],
            };
            const before: MessageLike = {
                info: { id: "before", role: "assistant" },
                parts: [{ type: "text", text }],
            };
            const signed: MessageLike = {
                info: { id: "signed", role: "assistant" },
                parts: [retained, { type: "text", text: "continue" }],
            };
            const tail: MessageLike = {
                info: { id: "tail", role: "assistant" },
                parts: [{ type: "text", text }],
            };
            const messages = [user, before, signed, tail];
            const frame = () =>
                createEditAdmission({
                    messages,
                    stableId: (m) => m.info.id,
                    partsOf: (m) => m.parts,
                    isRealUser: isAdmissionUser,
                    prefixBound: true,
                    isRetainedThinking: (_m, p) => p === retained,
                    anchorOf: thinkingAnchor,
                });
            const strip = (admission: ReturnType<typeof frame>, first: string[]) => {
                const applied = (m: MessageLike) => {
                    first.push(m.info.id!);
                };
                const admit = (m: MessageLike) =>
                    admission.admit({ kind: "message", id: m.info.id, block: "whole" });
                return lane === "placeholder"
                    ? stripDroppedPlaceholderMessages(messages, "anthropic", applied, admit)
                    : stripSystemInjectedMessages(
                          messages,
                          messages.length,
                          "anthropic",
                          applied,
                          admit,
                      );
            };
            const prefix = JSON.stringify([user, before, signed]);
            const applications: string[] = [];
            expect(strip(frame(), applications).sentineledIds).toEqual(["tail"]);
            expect(applications).toEqual(["tail"]);
            expect(JSON.stringify([user, before, signed])).toBe(prefix);
            expect(strip(frame(), applications).stripped).toBe(0);
            messages.push({
                info: { id: "next-user", role: "user" },
                parts: [{ type: "text", text: "continue" }],
            });
            expect(strip(frame(), applications).sentineledIds).toEqual(["before"]);
            expect(strip(frame(), applications).stripped).toBe(0);
        });
    }

    test("stripping only messages hidden at the compaction seam cannot edit the visible array", () => {
        const retained = {
            type: "reasoning",
            text: "kept",
            metadata: { anthropic: { signature: "signed" } },
        };
        const visible: MessageLike[] = [
            { info: { id: "u", role: "user" }, parts: [{ type: "text", text: "continue" }] },
            { info: { id: "a", role: "assistant" }, parts: [retained] },
        ];
        const hidden: MessageLike[] = [
            {
                info: { id: "hidden-placeholder", role: "assistant" },
                parts: [{ type: "text", text: "[dropped §3§]" }],
            },
            {
                info: { id: "hidden-system", role: "assistant" },
                parts: [
                    {
                        type: "text",
                        text: "<system-reminder>Background task completed</system-reminder>",
                    },
                ],
            },
        ];
        const sentBytes = JSON.stringify(visible);
        expect(stripDroppedPlaceholderMessages(hidden, "anthropic").sentineledIds).toEqual([
            "hidden-placeholder",
        ]);
        expect(
            stripSystemInjectedMessages(hidden, hidden.length, "anthropic").sentineledIds,
        ).toEqual(["hidden-system"]);
        expect(JSON.stringify(visible)).toBe(sentBytes);
    });
});
