import { expect, test } from "bun:test";
import * as configLoader from "../../config";
import { setHostInstructionRetentionEnabledForTests } from "../../features/magic-context/storage-host-instruction-retention";
import { setCoveredInstructionSupersessionEnabledForTests } from "../fold/instruction-supersession";
import {
    instructionRow,
    type McpServerFixture,
    replaceCodeModeCatalog,
    updateMcpGuidance,
} from "./__tests__/code-mode-catalog.fixture";
import { oc2ContextFixture } from "./__tests__/oc2-context.fixture";
import type { SessionContext } from "./types";

// Review witnesses for OpenCode 2 instruction supersession over rows the
// history summary covers. A pass held for recent heavy signed reasoning may
// still rebuild in the force band when the execute threshold sits within ten
// points of it (here 80%: the hold cap is 90%, the force band starts at 85%).
// Such a pass may not strip the held turn's signed thinking, so it must not
// change any byte in front of it either.

const options = {
    area: "issue-886-review",
    instructions: false,
    temporal: false,
    cacheTtl: "never",
    provider: "anthropic",
    model: "claude-opus-5-5",
};
const both = { notice: "instructions", instructionSources: ["core/codemode", "core/mcp-guidance"] };
const docs: McpServerFixture = { server: "docs", instructions: "DOCS_SERVER_GUIDANCE" };
const github: McpServerFixture = {
    server: "github",
    instructions: "GITHUB_SERVER_GUIDANCE\nCheck the open pull requests first.",
};
const catalogRow = (
    label: string,
    previous: readonly McpServerFixture[],
    current: readonly McpServerFixture[],
) =>
    instructionRow(
        replaceCodeModeCatalog([`${label} ${"tool description ".repeat(300)}`], "2.2.3"),
        updateMcpGuidance(previous, current, "2.2.3"),
    );
const instructionTexts = (draft: SessionContext) =>
    draft.messages
        .filter((message) => message.role === "system")
        .flatMap((message) => message.content.map((part) => part.text));

// About 2,900 tokens of signed reasoning: above the 1,500-token heavy step.
const HELD = `HELD_SIGNED_REASONING ${"Weighing the cache invalidation order step by step. ".repeat(220)}`;

async function heldForceBandFixture(seed: number) {
    const f = await oc2ContextFixture(seed, options);
    // The fixture's config object is the one the mocked loader returns; the
    // hook reads it again on restart.
    const config = configLoader.loadPluginConfigDetailed(".").config;
    config.execute_threshold_percentage = 80;
    await f.restart();
    let signedID: string | undefined;
    const pass = () =>
        f.pass((draft) => {
            draft.model.limit = { context: 302000 };
            if (signedID === undefined) return;
            const signed = draft.messages.find((message) => message.id === signedID);
            signed?.content.unshift({
                type: "reasoning",
                text: HELD,
                native: { anthropic: { signature: "held-signature" } },
            });
        });
    return {
        f,
        pass,
        /** The provider answers with heavy signed reasoning, at 86% of the window. */
        respondWithHeldThinking() {
            f.respond(1, 260000);
            signedID = f.rows.at(-1)!.id;
        },
    };
}

// Witnesses: `test.failing` until fixed, then plain tests. Their hold and
// permission preconditions are asserted too, so a plain run shows which part
// fails.
test.failing("a held force-band pass does not retire a covered row in front of the held signed thinking", async () => {
    const { f, pass, respondWithHeldThinking } = await heldForceBandFixture(37886);
    try {
        await pass();
        const githubGone = catalogRow("COVERED_GONE", [docs, github], [docs]);
        f.instruction(githubGone, both);
        f.user("First batch.", 1000);
        f.respond();
        // The summary covers the row; the force-band rebuild after it moves the
        // cut (no signed thinking yet, so nothing is held).
        f.compartment(f.rows.length - 1);
        f.user("Second batch.", 1000);
        f.respond(1, 260000);
        await pass();
        f.respond();
        const covered = await pass();
        expect(instructionTexts(covered.draft)).toEqual([githubGone]);
        // A newer row restates the catalog and names github again, and the
        // reply carries heavy signed reasoning: the next pass is held, but it
        // is in the force band, so it may rebuild.
        const githubBack = catalogRow("LIVE_BACK", [docs], [docs, github]);
        f.instruction(githubBack, both);
        f.user("Third batch.", 1000);
        respondWithHeldThinking();
        const held = await pass();
        expect(held.logs.some((line) => line.includes("thinking_hold=true"))).toBe(true);
        expect(held.logs.some((line) => line.includes("rewrite permission: allowed=true"))).toBe(
            true,
        );
        const coveredGone = !instructionTexts(held.draft).includes(githubGone);
        const thinkingKept = held.bytes.includes("HELD_SIGNED_REASONING");
        // Either the covered row stays until a pass that may strip the held
        // thinking, or the thinking leaves with it. Serving the edit with the
        // held block bound to the old bytes is what a prefix-bound model rejects.
        expect({ coveredGone, thinkingKept }).not.toEqual({
            coveredGone: true,
            thinkingKept: true,
        });
    } finally {
        await f.cleanup();
    }
}, 60000);

// The same edit on a row after the cut. Unlike the covered case, this one
// predates covered rows following supersession: it also fails when only rows
// after the cut are reclaimed.
test.failing("a held force-band pass does not retire an uncovered row in front of the held signed thinking", async () => {
    const { f, pass, respondWithHeldThinking } = await heldForceBandFixture(38886);
    try {
        await pass();
        const githubGone = catalogRow("UNCOVERED_GONE", [docs, github], [docs]);
        f.instruction(githubGone, both);
        f.user("First batch.", 1000);
        f.respond();
        await pass();
        const githubBack = catalogRow("LIVE_BACK", [docs], [docs, github]);
        f.instruction(githubBack, both);
        f.user("Second batch.", 1000);
        respondWithHeldThinking();
        const held = await pass();
        expect(held.logs.some((line) => line.includes("thinking_hold=true"))).toBe(true);
        expect(held.logs.some((line) => line.includes("rewrite permission: allowed=true"))).toBe(
            true,
        );
        const rowGone = !instructionTexts(held.draft).includes(githubGone);
        const thinkingKept = held.bytes.includes("HELD_SIGNED_REASONING");
        expect({ rowGone, thinkingKept }).not.toEqual({ rowGone: true, thinkingKept: true });
    } finally {
        await f.cleanup();
    }
}, 60000);

// Coverage for the signed-thinking order of covered rows; no other test
// combines covered rows with signed thinking. Both tests below pass. Both
// fail if a covered row's first omission stops counting as an edit in front
// of every newer signed block; the second also fails if only the omission
// made on the pass that turns the switch on stops counting.
async function signedFixture(seed: number) {
    const f = await oc2ContextFixture(seed, options);
    let signedID: string | undefined;
    const pass = () =>
        f.pass((draft) => {
            draft.model.limit = { context: 302000 };
            if (signedID === undefined) return;
            draft.messages
                .find((message) => message.id === signedID)
                ?.content.unshift({
                    type: "reasoning",
                    text: "KEPT_SIGNED_REASONING",
                    native: { anthropic: { signature: "kept-signature" } },
                });
        });
    return {
        f,
        pass,
        /** Give the newest reply a short signed block (light, so never held). */
        sign() {
            signedID = f.rows.at(-1)!.id;
        },
    };
}

test("a covered row newly retired on an unheld rebuilding pass strips the signed thinking after it", async () => {
    const { f, pass, sign } = await signedFixture(39886);
    try {
        await pass();
        const githubGone = catalogRow("COVERED_GONE", [docs, github], [docs]);
        f.instruction(githubGone, both);
        f.user("First batch.", 1000);
        f.respond();
        f.compartment(f.rows.length - 1);
        f.user("Second batch.", 1000);
        f.respond(1, 260000);
        await pass();
        f.respond();
        expect(instructionTexts((await pass()).draft)).toEqual([githubGone]);
        f.user("Signed turn.", 1000);
        f.respond();
        sign();
        expect((await pass()).bytes).toContain("KEPT_SIGNED_REASONING");
        const githubBack = catalogRow("LIVE_BACK", [docs], [docs, github]);
        f.instruction(githubBack, both);
        f.user("Continue after the signed turn.", 1000);
        f.respond(1, 260000);
        const after = await pass();
        expect(instructionTexts(after.draft)).toEqual([githubBack]);
        expect(after.bytes).not.toContain("KEPT_SIGNED_REASONING");
        expect((await pass()).bytes).toBe(after.bytes);
    } finally {
        await f.cleanup();
    }
}, 60000);

test("the pass that turns covered supersession on strips the signed thinking after the rows it drops", async () => {
    const { f, pass, sign } = await signedFixture(40886);
    setCoveredInstructionSupersessionEnabledForTests(false);
    try {
        await pass();
        const githubGone = catalogRow("RESERVED_BY_RELEASE", [docs, github], [docs]);
        const githubBack = catalogRow("NEWEST", [docs], [docs, github]);
        f.instruction(githubGone, both);
        f.user("First batch.", 1000);
        f.respond();
        f.instruction(githubBack, both);
        f.user("Second batch.", 1000);
        f.respond(1, 260000);
        await pass();
        f.compartment(f.rows.length - 1);
        f.user("Third batch.", 1000);
        f.respond(1, 260000);
        await pass();
        f.respond();
        // The previous release serves the row it retired while uncovered.
        expect(instructionTexts((await pass()).draft)).toEqual([githubGone, githubBack]);
        f.user("Signed turn.", 1000);
        f.respond();
        sign();
        expect((await pass()).bytes).toContain("KEPT_SIGNED_REASONING");
        // Upgrade; the first pass that may rebuild drops the covered row.
        setCoveredInstructionSupersessionEnabledForTests(true);
        f.user("Continue after the signed turn.", 1000);
        f.respond(1, 260000);
        const rebuilt = await pass();
        expect(instructionTexts(rebuilt.draft)).toEqual([githubBack]);
        expect(rebuilt.bytes).not.toContain("KEPT_SIGNED_REASONING");
        expect((await pass()).bytes).toBe(rebuilt.bytes);
    } finally {
        setCoveredInstructionSupersessionEnabledForTests(true);
        await f.cleanup();
    }
}, 60000);

// The pass that turns host instruction retention on puts covered rows back at
// the head of the request, in front of every signed block, without counting
// that as an edit, so a prefix-bound model keeps a signed block bound to the
// bytes before the rows came back. Like the uncovered witness above, this
// one predates covered rows following supersession.
test.failing("the pass that turns host instruction retention on strips the signed thinking after the rows it puts back", async () => {
    const { f, pass, sign } = await signedFixture(41886);
    setHostInstructionRetentionEnabledForTests(false);
    try {
        await pass();
        const row = catalogRow("PUT_BACK", [docs, github], [docs]);
        f.instruction(row, both);
        f.user("First batch.", 1000);
        f.respond();
        f.compartment(f.rows.length - 1);
        f.user("Second batch.", 1000);
        f.respond(1, 260000);
        await pass();
        f.respond();
        // Releases before retention cut the covered row from the request.
        expect(instructionTexts((await pass()).draft)).toEqual([]);
        f.user("Signed turn.", 1000);
        f.respond();
        sign();
        expect((await pass()).bytes).toContain("KEPT_SIGNED_REASONING");
        setHostInstructionRetentionEnabledForTests(true);
        f.user("Continue after the signed turn.", 1000);
        f.respond(1, 260000);
        const after = await pass();
        expect(instructionTexts(after.draft)).toEqual([row]);
        expect(after.bytes).not.toContain("KEPT_SIGNED_REASONING");
    } finally {
        setHostInstructionRetentionEnabledForTests(true);
        await f.cleanup();
    }
}, 60000);
