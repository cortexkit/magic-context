/// <reference types="bun-types" />

/**
 * Write `testdata/revision-gates.json`: what the plugin's deterministic
 * gates (`planMemoryRevision` in `memory/lifecycle-gates.ts`) decide for a
 * set of historian revisions, and the checks they plan.
 * `summary::two_pass::gates` tests the Rust port against it.
 *
 *   bun crates/mc-module/gen/gen-revision-gates.ts <plugin root> > crates/mc-module/testdata/revision-gates.json
 *
 * The plugin root must hold the memory-levels card's plugin, where the
 * two-pass historian lives.
 */

import { resolve } from "node:path";

const root = resolve(process.argv[2] ?? resolve(import.meta.dir, "../../../packages/plugin"));
const { planMemoryRevision } = await import(
    `${root}/src/features/magic-context/memory/lifecycle-gates.ts`
);

const block = (start: number, role: string, parts: string[]) => ({
    startOrdinal: start,
    endOrdinal: start,
    role,
    parts,
    joinedText: parts.join(" / "),
});
const blocks = [
    block(10, "U", ["The deploy port is 8443 now, not 8080."]),
    block(12, "U", ["Use pnpm for every package install."]),
    block(14, "A", ["Retries are capped at 5 attempts in v2."]),
];
const source = (id: number, revision: number, content: string, status = "active") => ({
    id,
    revision,
    projectPath: "pj-test",
    status,
    content,
});
const memoryA = source(1, 3, "The deploy port is 8080. Deploys run from main.");
// A clause keeps the whitespace after it, so a kept or added clause matches
// the final text only at the same place: clauses that end with a space come
// before the last one.
const memoryB = source(2, 1, "Lockfiles are committed. Use npm for installs.");
const memoryC = source(3, 2, "CI caches node_modules. Installs use npm.");

const changed = (memoryId: number, ordinal: number, block: number, excerpt: string, replacement = true) => ({
    memoryId,
    ordinal,
    replacement,
    evidence: { blockStartOrdinal: block, excerpt },
});
const added = (text: string, block: number, excerpt: string) => ({
    text,
    evidence: { blockStartOrdinal: block, excerpt },
});

interface Case {
    name: string;
    decision: Record<string, unknown>;
    sources: ReturnType<typeof source>[];
    anchorKnown?: boolean;
    memoryEnabled?: boolean;
    autoPromote?: boolean;
}

const edit = (overrides: Record<string, unknown> = {}) => ({
    key: "k-edit",
    action: "edit",
    projectPath: "pj-test",
    expectedSources: [{ id: 1, revision: 3 }],
    survivorId: 1,
    finalText: "The deploy port is 8443. Deploys run from main.",
    changes: [changed(1, 1, 10, "The deploy port is 8443 now, not 8080")],
    added: [added("The deploy port is 8443. ", 10, "The deploy port is 8443 now")],
    ...overrides,
});

const cases: Case[] = [
    { name: "edit passes", decision: edit(), sources: [memoryA] },
    { name: "memory off", decision: edit(), sources: [memoryA], memoryEnabled: false },
    { name: "auto promote off", decision: edit(), sources: [memoryA], autoPromote: false },
    { name: "append only", decision: edit({ changes: [] }), sources: [memoryA] },
    { name: "empty final text", decision: edit({ finalText: "" }), sources: [memoryA] },
    {
        name: "edit names two sources",
        decision: edit({ expectedSources: [{ id: 1, revision: 3 }, { id: 2, revision: 1 }] }),
        sources: [memoryA, memoryB],
    },
    { name: "stale source revision", decision: edit(), sources: [source(1, 4, memoryA.content)] },
    { name: "archived source", decision: edit(), sources: [source(1, 3, memoryA.content, "archived")] },
    {
        name: "kept clause rewritten",
        decision: edit({ finalText: "The deploy port is 8443. Deploys run from release." }),
        sources: [memoryA],
    },
    {
        name: "same clause changed twice",
        decision: edit({
            changes: [
                changed(1, 1, 10, "The deploy port is 8443 now"),
                changed(1, 1, 10, "The deploy port is 8443 now"),
            ],
        }),
        sources: [memoryA],
    },
    { name: "unknown anchor", decision: edit(), sources: [memoryA], anchorKnown: false },
    {
        name: "excerpt not in the cited block",
        decision: edit({ changes: [changed(1, 1, 10, "The port moved to 9000")] }),
        sources: [memoryA],
    },
    {
        name: "removed token kept nowhere",
        decision: edit({
            changes: [changed(1, 1, 12, "Use pnpm for every package install")],
            added: [added("Use pnpm for every package install. ", 12, "Use pnpm for every package install")],
            finalText: "Use pnpm for every package install. Deploys run from main.",
        }),
        sources: [memoryA],
    },
    {
        name: "added token not in evidence",
        decision: edit({
            added: [added("The deploy port is 9443. ", 10, "The deploy port is 8443 now")],
            finalText: "The deploy port is 9443. Deploys run from main.",
        }),
        sources: [memoryA],
    },
    {
        name: "replaces passes",
        decision: {
            ...edit(),
            key: "k-replaces",
            action: "replaces",
        },
        sources: [memoryA],
    },
    {
        name: "merge passes",
        decision: {
            key: "k-merge",
            action: "merge",
            projectPath: "pj-test",
            expectedSources: [
                { id: 2, revision: 1 },
                { id: 3, revision: 2 },
            ],
            survivorId: 2,
            finalText: "Lockfiles are committed. CI caches node_modules. Use pnpm for every package install.",
            changes: [
                changed(2, 2, 12, "Use pnpm for every package install"),
                changed(3, 2, 12, "Use pnpm for every package install"),
            ],
            added: [added("Use pnpm for every package install.", 12, "Use pnpm for every package install")],
        },
        sources: [memoryB, memoryC],
    },
    {
        name: "merge that only paraphrases",
        decision: {
            key: "k-paraphrase",
            action: "merge",
            projectPath: "pj-test",
            expectedSources: [
                { id: 2, revision: 1 },
                { id: 3, revision: 2 },
            ],
            survivorId: 2,
            finalText: "Lockfiles are committed. CI caches node_modules. Use npm for installs.",
            changes: [changed(3, 2, 12, "Use pnpm for every package install", false)],
            added: [],
        },
        sources: [memoryB, memoryC],
    },
    {
        name: "merge drops a source token",
        decision: {
            key: "k-drop",
            action: "merge",
            projectPath: "pj-test",
            expectedSources: [
                { id: 1, revision: 3 },
                { id: 3, revision: 2 },
            ],
            survivorId: 1,
            finalText: "The deploy port is 8443. CI caches node_modules. Deploys run from main.",
            changes: [
                changed(1, 1, 10, "The deploy port is 8443 now"),
                changed(3, 2, 12, "Use pnpm for every package install"),
            ],
            added: [added("The deploy port is 8443. ", 10, "The deploy port is 8443 now")],
        },
        sources: [memoryA, memoryC],
    },
    {
        name: "added clause holds two clauses",
        decision: edit({
            added: [added("The deploy port is 8443. It changed. ", 10, "The deploy port is 8443 now")],
            finalText: "The deploy port is 8443. It changed. Deploys run from main.",
        }),
        sources: [memoryA],
    },
];

const output = cases.map((testCase) => {
    const plan = planMemoryRevision(testCase.decision, {
        enabled: true,
        memoryEnabled: testCase.memoryEnabled ?? true,
        autoPromote: testCase.autoPromote ?? true,
        anchorKnown: testCase.anchorKnown ?? true,
        blocks,
        sources: testCase.sources,
        historianProfile: {},
        validatedProfiles: [],
    });
    return {
        name: testCase.name,
        decision: testCase.decision,
        sources: testCase.sources,
        anchorKnown: testCase.anchorKnown ?? true,
        memoryEnabled: testCase.memoryEnabled ?? true,
        autoPromote: testCase.autoPromote ?? true,
        plan: plan.ok
            ? {
                  ok: true,
                  kept: plan.kept.map((operand: { id: string }) => operand.id),
                  checks: plan.checks.map(
                      (check: {
                          kind: string;
                          operands: Array<{ id: string }>;
                          pairs: Array<{ id: string }>;
                          input: string;
                      }) => ({
                          kind: check.kind,
                          operands: check.operands.map((operand) => operand.id),
                          pairs: check.pairs.map((pair) => pair.id),
                          input: check.input,
                      }),
                  ),
              }
            : { ok: false, reason: plan.reason },
    };
});

process.stdout.write(`${JSON.stringify({ blocks, cases: output }, null, 2)}\n`);
