/// <reference types="bun-types" />

/**
 * Write `envelope_goldens.json` from the plugin's turn-two envelope, the
 * reference the Rust port (`envelope.rs`) must match: how each reply parses,
 * and the exact prompt and fit for fixed facts.
 *
 *   bun crates/mc-module/src/summary/two_pass/envelope_goldens.ts [plugin root] > crates/mc-module/src/summary/two_pass/envelope_goldens.json
 *
 * The plugin root defaults to this repository's `packages/plugin`; pass the
 * root of a checkout that carries the two-pass historian when this one does
 * not yet.
 */

import { resolve } from "node:path";

const root = resolve(process.argv[2] ?? resolve(import.meta.dir, "../../../../../packages/plugin"));
const envelope = await import(`${root}/src/features/magic-context/memory/turn-two-envelope.ts`);

const replies: Array<{ name: string; text: string; lengthCapped?: boolean; toolActivity?: boolean }> = [
    { name: "tool_activity", text: "{}", toolActivity: true },
    { name: "length_capped", text: '{"result":{"step":"turn_two","decisions":[]}}', lengthCapped: true },
    { name: "prose", text: "Here is my answer: {}" },
    { name: "wrong_step", text: '{"result":{"step":"turn_one","decisions":[]}}' },
    { name: "no_decisions", text: '{"result":{"step":"turn_two"}}' },
    { name: "scores_not_array", text: '{"result":{"step":"turn_two","decisions":[],"scores":{}}}' },
    {
        name: "every_action",
        text: JSON.stringify({
            result: {
                step: "turn_two",
                decisions: [
                    { fact_id: 1, check: "ok", action: "new", decided: true },
                    { fact_id: 2, check: "ok", action: "abstain" },
                    { fact_id: 3, check: "ok", action: "conflict", target_id: 7 },
                    { fact_id: 4, check: "ok", action: "covered", target_id: 7, revision: 2, clauses: [1, 3], excerpt: "q" },
                    {
                        fact_id: 5,
                        check: "ok",
                        action: "edit",
                        target_id: 7,
                        revision: 2,
                        kept: [{ memory_id: 7, clause: 1 }],
                        removed: [{ memory_id: 7, clause: 2, block: 10, excerpt: "e" }],
                        added: [{ text: "New clause.", block: 10, excerpt: "f" }],
                        final_text: "A. New clause.",
                    },
                    {
                        fact_id: 6,
                        check: "ok",
                        action: "merge",
                        sources: [
                            { id: 7, revision: 2 },
                            { id: 8, revision: 1 },
                        ],
                        survivor_id: 7,
                        kept: [],
                        replaced: [{ memory_id: 8, clause: 1, block: 11, excerpt: "g" }],
                        final_text: "Merged.",
                    },
                    { fact_id: 9, check: "ok", action: "retire", target_id: 7 },
                ],
                scores: [
                    { item: 1, importance: 70, class: "rule" },
                    { item: 2, importance: 0, class: "rule" },
                    { item: 3, importance: 50, class: "x" },
                    { item: 3, importance: 60, class: "y" },
                ],
            },
        }),
    },
    {
        name: "malformed_and_duplicates",
        text: JSON.stringify({
            result: {
                step: "turn_two",
                decisions: [
                    { fact_id: 1, check: "ok", action: "abstain", decided: false },
                    { fact_id: 2, check: "ok", action: "covered", target_id: 7, revision: 2, clauses: [] },
                    { fact_id: 3, check: "ok", action: "edit", target_id: 7, revision: 2, kept: [], final_text: "x", removed: null },
                    { fact_id: 4, check: "ok", action: "new" },
                    { fact_id: 4, check: "ok", action: "abstain" },
                    { check: "no fact" },
                    { fact_id: 5.0, check: "ok", action: "merge", sources: [{ id: 1, revision: 1 }], survivor_id: 1, kept: [], final_text: "x" },
                    { fact_id: 6, action: "new" },
                    { fact_id: 7, check: "ok", action: "new", decided: "yes" },
                ],
            },
        }),
    },
];

function decisionView(entry: unknown) {
    if (entry === "malformed") return "malformed";
    const decision = entry as Record<string, unknown>;
    return {
        fact_id: decision.factId,
        ordinal: decision.ordinal,
        action: decision.action,
        target_id: decision.targetId ?? null,
        revision: decision.revision ?? null,
        sources: (decision.sources as Array<{ id: number; revision: number }> | undefined)?.map((s) => [s.id, s.revision]) ?? null,
        survivor_id: decision.survivorId ?? null,
        clauses: decision.clauses ?? null,
        decided: decision.decided ?? null,
        excerpt: decision.excerpt ?? null,
        removed: decision.removed ?? [],
        replaced: decision.replaced ?? [],
        kept: (decision.kept as Array<{ memoryId: number; clause: number }> | undefined)?.map((k) => [k.memoryId, k.clause]) ?? [],
        added: decision.added ?? [],
        final_text: decision.finalText ?? null,
    };
}

const parsed = replies.map(({ name, text, lengthCapped, toolActivity }) => {
    const result = envelope.parseTurnTwoEnvelope(text, lengthCapped ?? false, toolActivity ?? false);
    if (!result.ok) return { name, text, length_capped: !!lengthCapped, tool_activity: !!toolActivity, refused: result.reason };
    return {
        name,
        text,
        length_capped: !!lengthCapped,
        tool_activity: !!toolActivity,
        schema_valid: result.schemaValid,
        decisions: [...result.decisions.entries()].sort(([a], [b]) => a - b).map(([id, entry]) => [id, decisionView(entry)]),
        scores: result.scores.map((s: { item: number; importance: number; proposedClass: string }) => [s.item, s.importance, s.proposedClass]),
    };
});

const block = (start: number, end: number, role: string, parts: string[]) => ({ startOrdinal: start, endOrdinal: end, role, parts });
const fact = (id: number, backlog: boolean, size: number) => ({
    factId: id,
    category: "ARCHITECTURE",
    content: `Fact ${id} ${"word ".repeat(size)}`.trim(),
    sourceSessionId: `ses_${id % 2}`,
    anchorKnown: id % 3 !== 0,
    backlog,
    blocks: id % 3 === 0 ? [] : [block(10 + id, 12 + id, "user", [`part ${id}`, "shared"]), block(40, 40, "assistant", ["same block"])],
    // Every third fact has no evidence and no neighbour, so both "unknown" lines render.
    neighbours:
        id % 3 === 0
            ? []
            : [{ id: 100 + (id % 2), revision: 3, category: "NAMING", content: "First clause. Second clause, e.g. with detail. Third — spaced." }],
});
const items = [
    { item: 1, memoryId: 500, content: "An agent memory.", excerpt: "the excerpt" },
    { item: 2, memoryId: 501, content: "Another agent memory. ".repeat(40), excerpt: "more" },
];
const facts = [fact(1, false, 5), fact(2, false, 200), fact(3, false, 20), fact(4, true, 30), fact(5, true, 400), fact(6, true, 10)];

const prompts = [
    { name: "plain", facts: facts.slice(0, 3), items: [], lexicalOnly: false, deferred: { facts: 0, items: 0 } },
    { name: "lexical_deferred", facts: facts.slice(3), items, lexicalOnly: true, deferred: { facts: 2, items: 1 } },
].map(({ name, facts, items, lexicalOnly, deferred }) => ({
    name,
    facts,
    items,
    lexical_only: lexicalOnly,
    deferred: [deferred.facts, deferred.items],
    prompt: envelope.buildTurnTwoPrompt({ facts, items, lexicalOnly, deferred }),
}));

const fits = [3000, 6000, 12000, 1_000_000].map((maxLength) => {
    const fitted = envelope.fitTurnTwoPrompt({ facts, items, lexicalOnly: false, maxLength });
    return {
        max_length: maxLength,
        facts: fitted.facts.map((f: { factId: number }) => f.factId),
        items: fitted.items.map((i: { item: number }) => i.item),
        deferred: [fitted.deferred.facts, fitted.deferred.items],
        prompt_sha256: new Bun.CryptoHasher("sha256").update(fitted.prompt).digest("hex"),
    };
});

process.stdout.write(`${JSON.stringify({ parsed, prompts, fit_input: { facts, items }, fits }, null, 2)}\n`);
