import { describe, expect, test } from "bun:test";
import { lifecycleTextHash } from "../../src/features/magic-context/memory/lifecycle-text";
import {
    buildTurnTwoPrompt,
    fitTurnTwoPrompt,
    type TurnTwoPromptFact,
} from "../../src/features/magic-context/memory/turn-two-envelope";
import {
    buildCompartmentAgentPrompt,
    historianSystemPrompt,
} from "../../src/hooks/magic-context/compartment-prompt";
import { TWO_PASS_TURN_TWO } from "../../src/hooks/magic-context/two-pass-prompts/prompts.generated";
import { mockCases, mockReply } from "./mock";
import { memoryDrafts, turnOne, turnTwo } from "./prompts";

const fixture = mockCases([0])[0]!;
function fact(id: number, content = `Fact ${id}`): TurnTwoPromptFact {
    return {
        factId: id,
        category: "CONSTRAINTS",
        content,
        sourceSessionId: "session-a",
        anchorKnown: false,
        backlog: false,
        blocks: [],
        neighbours: [],
    };
}

describe("two-pass prompt fixes", () => {
    test("one-pass prompts stay pinned with exact continuation prefix", async () => {
        const first = turnOne(fixture);
        expect(lifecycleTextHash(historianSystemPrompt(false))).toBe(
            "590649b1f6b2428940cb925586342be58bdecc3ee4d64153d2f73ec5251532bd",
        );
        expect(
            lifecycleTextHash(
                buildCompartmentAgentPrompt({
                    seedExamples: "",
                    sessionReferences: "",
                    projectMemory: "",
                    inputSource: "Messages 1-1:\n\n[1] user: Always serialize DeepSeek requests.",
                    memoryEnabled: true,
                }),
            ),
        ).toBe("671405f3e2f1a05fd48786068098d1444c963037cabdde715506baa97af9f590");
        const reply = mockReply(first).choices[0]!.message.content;
        const second = await turnTwo(fixture, first, reply);
        expect(JSON.stringify(second.request.messages.slice(0, 3))).toBe(
            JSON.stringify([...first.messages, { role: "assistant", content: reply }]),
        );
        expect(second.request.messages).toHaveLength(4);
        expect({ ...second.request, messages: first.messages }).toEqual(first);
    });

    test("allowed ids come only from the final fitted facts", () => {
        const fitted = fitTurnTwoPrompt({
            facts: [fact(41), fact(92, "x".repeat(4000))],
            items: [],
            lexicalOnly: true,
            maxLength: 2500,
        });
        expect(fitted.facts.map((f) => f.factId)).toEqual([41]);
        expect(fitted.prompt).toContain("allowed_fact_ids: [41]\n");
        expect(fitted.prompt).not.toContain("## Fact 92");
        expect(fitted.prompt).toContain(TWO_PASS_TURN_TWO.replace("{{ALLOWED_FACT_IDS}}", "[41]"));
    });

    test("turn-two instruction text comes from the dedicated source", () => {
        const prompt = buildTurnTwoPrompt({ facts: [fact(1)], items: [], lexicalOnly: false });
        expect(prompt.startsWith(TWO_PASS_TURN_TWO.replace("{{ALLOWED_FACT_IDS}}", "[1]"))).toBe(
            true,
        );
        expect(historianSystemPrompt(false)).not.toContain(TWO_PASS_TURN_TWO);
    });

    test("runner ignores and reports extra ids while retaining known drafts", async () => {
        const first = turnOne(fixture);
        const second = await turnTwo(fixture, first, mockReply(first).choices[0]!.message.content);
        const diagnostics = { extraFactIds: [] as number[] };
        const drafts = memoryDrafts(
            JSON.stringify({
                result: {
                    step: "turn_two",
                    decisions: [
                        { fact_id: 1, check: "Audit fixture.", action: "new" },
                        { fact_id: 3, check: "Audit fixture.", action: "new" },
                        { fact_id: 4, check: "Audit fixture.", action: "abstain" },
                    ],
                },
            }),
            second.facts,
            fixture,
            diagnostics,
        );
        expect(drafts).toEqual([
            {
                factId: 1,
                action: "new",
                category: "CONSTRAINTS",
                text: "Always serialize DeepSeek requests.",
            },
        ]);
        expect(diagnostics.extraFactIds).toEqual([3, 4]);
    });

    test("oversized oldest backlog is serviced instead of being skipped forever", () => {
        const old = { ...fact(1, "old".repeat(4000)), backlog: true };
        const fitted = fitTurnTwoPrompt({
            facts: [fact(9), old, { ...fact(2), backlog: true }],
            items: [],
            lexicalOnly: false,
            maxLength: 5000,
        });
        expect(fitted.facts.map((f) => f.factId)).toEqual([1]);
        expect(fitted.deferred.facts).toBe(2);
    });

    test("fresh facts cannot borrow unused reserved backlog capacity", () => {
        const fitted = fitTurnTwoPrompt({
            facts: [fact(9, "x".repeat(121000)), { ...fact(1), backlog: true }],
            items: [],
            lexicalOnly: false,
            maxLength: 160000,
        });
        expect(fitted.facts.map((f) => f.factId)).toEqual([1]);
        expect(fitted.deferred.facts).toBe(1);
    });

    test("decided true prefixes new drafts; false leaves text alone", async () => {
        const first = turnOne(fixture);
        const second = await turnTwo(fixture, first, mockReply(first).choices[0]!.message.content);
        const decided = (value: unknown) =>
            memoryDrafts(
                JSON.stringify({
                    result: {
                        step: "turn_two",
                        decisions: [
                            {
                                fact_id: 1,
                                check: "Audit fixture.",
                                action: "new",
                                decided: value,
                            },
                        ],
                    },
                }),
                second.facts,
                fixture,
            );
        expect(decided(true)).toEqual([
            {
                factId: 1,
                action: "new",
                category: "CONSTRAINTS",
                text: "Decided: Always serialize DeepSeek requests.",
            },
        ]);
        expect(decided(false)).toEqual([
            {
                factId: 1,
                action: "new",
                category: "CONSTRAINTS",
                text: "Always serialize DeepSeek requests.",
            },
        ]);
    });
});
