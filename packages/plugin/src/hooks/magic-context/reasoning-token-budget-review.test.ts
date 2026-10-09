import { describe, expect, it } from "bun:test";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { getReasoningTokenEstimatesByMessage } from "../../features/magic-context/storage-tags";
import { createTagger } from "../../features/magic-context/tagger";
import { Database } from "../../shared/sqlite";
import { estimateTokens } from "./read-session-formatting";
import { opencodeReasoningBudgetCutoff, resolveKeepReasoningTokens } from "./reasoning-budget";
import { removeReasoningParts, selectReasoningRemovals } from "./reasoning-removal";
import {
    findMergedReasoningStripDecisions,
    stripReasoningFromMergedAssistants,
} from "./strip-content";
import { type MessageLike, tagMessages } from "./tag-messages";

function assistant(id: string, text: string, reported = 100): MessageLike {
    return {
        info: { id, role: "assistant", tokens: { reasoning: reported } },
        parts: [
            { type: "reasoning", text, metadata: { anthropic: { signature: `sig-${id}` } } },
            {
                type: "tool",
                tool: "read",
                callID: `call-${id}`,
                state: { status: "completed", input: {}, output: "result" },
            },
        ],
    } as unknown as MessageLike;
}

describe("reasoning token budget adversarial review", () => {
    it("review: stored tool estimates charge each assistant's own reasoning exactly once", () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        try {
            const texts = ["large old thought ".repeat(100), "short thought", "new thought"];
            const messages = texts.map((text, i) => assistant(`a${i}`, text, 0));
            const tagged = tagMessages("review-estimates", messages, createTagger(), db);
            const budget = texts.reduce((total, text) => total + estimateTokens(text), 0);
            // With a budget equal to all three plaintext steps, there is no non-fitting step.
            // The tagger associates a tool's reasoning estimate with the preceding step;
            // the new budget adapter must not mistake that for the tool owner's own cost.
            expect(
                opencodeReasoningBudgetCutoff({
                    messages,
                    messageTagNumbers: tagged.messageTagNumbers,
                    budget,
                    textEstimateByMessageId: getReasoningTokenEstimatesByMessage(
                        db,
                        "review-estimates",
                        1,
                    ),
                }),
            ).toBe(0);
        } finally {
            db.close();
        }
    });

    it("review: a saved removal never restores signed thinking when its message becomes exempt", () => {
        const a = assistant("a", "old thinking");
        const b = assistant("b", "new thinking");
        const ids = new Set(["a"]);
        removeReasoningParts([a, b], ids, "google-vertex-anthropic");
        expect(a.parts.some((part) => (part as { type: string }).type === "reasoning")).toBe(false);
        const served = JSON.stringify(a.parts);
        // Undo or a transient host subset makes a previously removed assistant newest.
        // Replaying the same frozen id must not put its signed bytes back on the wire.
        const subset = [assistant("a", "old thinking")];
        removeReasoningParts(subset, ids, "google-vertex-anthropic");
        expect(JSON.stringify(subset[0].parts)).toBe(served);
    });

    it("review: a frozen merged-assistant strip never restores thinking on a host subset", () => {
        const history = [assistant("a", "one"), assistant("b", "two"), assistant("c", "three")];
        const frozen = new Set(
            findMergedReasoningStripDecisions(history, "anthropic", new Set(), {
                mutationExemptMessage: history[2],
            }),
        );
        expect(frozen.has("b")).toBe(true);
        stripReasoningFromMergedAssistants(history, "anthropic", {
            mutationExemptMessage: history[2],
            frozenMessageIds: frozen,
        });
        expect(history[1].parts[0]).toEqual({ type: "text", text: "" });
        const served = JSON.stringify(history[1].parts);
        const subset = [assistant("b", "two")];
        stripReasoningFromMergedAssistants(subset, "anthropic", {
            mutationExemptMessage: subset[0],
            frozenMessageIds: frozen,
        });
        expect(JSON.stringify(subset[0].parts)).toBe(served);
    });

    it("review: issue 630 leaves all thinking in the active Anthropic turn unchanged", () => {
        const user = {
            info: { id: "u", role: "user" },
            parts: [{ type: "text", text: "work" }],
        } as MessageLike;
        const messages = [
            user,
            assistant("a", "one"),
            assistant("b", "two"),
            assistant("c", "three"),
        ];
        const tags = new Map(messages.map((message, i) => [message, i + 1]));
        const cutoff = opencodeReasoningBudgetCutoff({
            messages,
            messageTagNumbers: tags,
            budget: 0,
        });
        expect(
            selectReasoningRemovals({
                messages,
                messageTagNumbers: tags,
                cutoff,
                alreadyRemoved: new Set(),
                prefixBound: true,
            }),
        ).toEqual([]);
    });

    it("review control: TS uses positive reported costs even with an empty summary", () => {
        const messages = [assistant("a0", ""), assistant("a1", ""), assistant("a2", "")];
        for (const message of messages)
            delete (message.parts[0] as Record<string, unknown>).metadata;
        expect(
            opencodeReasoningBudgetCutoff({
                messages,
                messageTagNumbers: new Map(messages.map((message, i) => [message, i + 2])),
                budget: 200,
            }),
        ).toBe(2);
    });

    it("review control: TS aliases resolve canonical provider wildcards first", () => {
        const values = { "openai/*": 250, "openai-codex/*": 500, "google/*": 750 };
        expect(resolveKeepReasoningTokens(values, "openai-codex/gpt-6.1-sol")).toBe(250);
        expect(resolveKeepReasoningTokens(values, "google-antigravity/gemini-3.8-flash")).toBe(750);
    });

    it("review control: an untagged signed step stops prefix selection", () => {
        const messages = [assistant("a", "one"), assistant("b", "two"), assistant("c", "three")];
        const tags = new Map([
            [messages[0], 1],
            [messages[2], 3],
        ]);
        expect(
            selectReasoningRemovals({
                messages,
                messageTagNumbers: tags,
                cutoff: 2,
                alreadyRemoved: new Set(),
                prefixBound: true,
            }),
        ).toEqual(["a"]);
    });
});
