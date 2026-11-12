import { expect, test } from "bun:test";
import * as configLoader from "../../config";
import { setHostInstructionRetentionEnabledForTests } from "../../features/magic-context/storage-host-instruction-retention";
import { clearCachedM0M1 } from "../../features/magic-context/storage-meta-shared";
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
// history summary covers. On a prefix-bound model a signed thinking block is
// valid only while every byte in front of it is unchanged, so a pass must
// never serve an edit in front of signed thinking it keeps.
//
// With the execute threshold at 80% the hold's cap is 90% and the force band
// starts at 85%. The hold never applies in the force band, so a pass there
// after heavy signed reasoning is unheld: it may edit the prefix, and strips
// the turn's signed thinking when it does. A pass still held but permitted to
// rewrite exists only on a first render whose new head changes no bytes (a
// host-checkpoint head change or a changed tool list strips the thinking
// instead), and such a pass may change nothing in front of the held thinking.

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

async function heavyThinkingFixture(seed: number) {
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
        /**
         * The provider answers with heavy signed reasoning; by default at 86% of
         * the window, in the force band.
         */
        respondWithHeavyThinking(inputTokens = 260000) {
            f.respond(1, inputTokens);
            signedID = f.rows.at(-1)!.id;
        },
    };
}

/** The force-band pass after heavy reasoning: unheld, and permitted to rewrite. */
function expectUnheldForceBandPass(logs: readonly string[]) {
    expect(
        logs.some((line) => line.includes("signed thinking hold: held=false reason=force_band")),
    ).toBe(true);
    expect(logs.some((line) => line.includes("thinking_hold=false"))).toBe(true);
    expect(logs.some((line) => line.includes("rewrite permission: allowed=true"))).toBe(true);
}

/** A first render after heavy reasoning: held, and still permitted to rewrite. */
function expectHeldFirstRenderPass(logs: readonly string[]) {
    expect(logs.some((line) => line.includes("thinking_hold=true"))).toBe(true);
    expect(logs.some((line) => line.includes("first_render=true"))).toBe(true);
    expect(logs.some((line) => line.includes("rewrite permission: allowed=true"))).toBe(true);
}

/**
 * The covered-row scenario: a summary covers a row that drops github, and a
 * newer row names github again. `beforeNewerRow` runs once the covered row is
 * served alone; the reply after the newer row carries heavy signed reasoning.
 */
async function coveredRowScenario(
    fixture: Awaited<ReturnType<typeof heavyThinkingFixture>>,
    inputTokens: number,
    beforeHeavyPass: () => void = () => {},
) {
    const { f, pass, respondWithHeavyThinking } = fixture;
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
    const previous = await pass();
    expect(instructionTexts(previous.draft)).toEqual([githubGone]);
    // A newer row restates the catalog and names github again, and the reply
    // carries heavy signed reasoning.
    const githubBack = catalogRow("LIVE_BACK", [docs], [docs, github]);
    f.instruction(githubBack, both);
    f.user("Third batch.", 1000);
    respondWithHeavyThinking(inputTokens);
    beforeHeavyPass();
    const heavy = await pass();
    return { githubGone, githubBack, previous, heavy };
}

/** The same edit on a row after the cut (no summary covers it). */
async function uncoveredRowScenario(
    fixture: Awaited<ReturnType<typeof heavyThinkingFixture>>,
    inputTokens: number,
    beforeHeavyPass: () => void = () => {},
) {
    const { f, pass, respondWithHeavyThinking } = fixture;
    await pass();
    const githubGone = catalogRow("UNCOVERED_GONE", [docs, github], [docs]);
    f.instruction(githubGone, both);
    f.user("First batch.", 1000);
    f.respond();
    const previous = await pass();
    const githubBack = catalogRow("LIVE_BACK", [docs], [docs, github]);
    f.instruction(githubBack, both);
    f.user("Second batch.", 1000);
    respondWithHeavyThinking(inputTokens);
    beforeHeavyPass();
    const heavy = await pass();
    return { githubGone, githubBack, previous, heavy };
}

// Witnesses. Their hold and permission preconditions are asserted too, so a
// failing run shows which part fails. The invariant in each (never a retired
// row together with kept thinking) is the property; the force-band tests then
// also pin the outcome the unheld pass has.
test("a force-band pass after heavy reasoning is unheld: it retires a covered row in front of the turn's signed thinking and strips that thinking in the same pass", async () => {
    const fixture = await heavyThinkingFixture(37886);
    try {
        const { githubGone, heavy } = await coveredRowScenario(fixture, 260000);
        expectUnheldForceBandPass(heavy.logs);
        const coveredGone = !instructionTexts(heavy.draft).includes(githubGone);
        const thinkingKept = heavy.bytes.includes("HELD_SIGNED_REASONING");
        // Serving the edit with the signed block bound to the old bytes is what
        // a prefix-bound model rejects.
        expect({ coveredGone, thinkingKept }).not.toEqual({
            coveredGone: true,
            thinkingKept: true,
        });
        expect({ coveredGone, thinkingKept }).toEqual({ coveredGone: true, thinkingKept: false });
    } finally {
        await fixture.f.cleanup();
    }
}, 60000);

// The same edit on a row after the cut. Unlike the covered case, this one
// predates covered rows following supersession: it also fails when only rows
// after the cut are reclaimed.
test("a force-band pass after heavy reasoning is unheld: it retires an uncovered row in front of the turn's signed thinking and strips that thinking in the same pass", async () => {
    const fixture = await heavyThinkingFixture(38886);
    try {
        const { githubGone, heavy } = await uncoveredRowScenario(fixture, 260000);
        expectUnheldForceBandPass(heavy.logs);
        const rowGone = !instructionTexts(heavy.draft).includes(githubGone);
        const thinkingKept = heavy.bytes.includes("HELD_SIGNED_REASONING");
        expect({ rowGone, thinkingKept }).not.toEqual({ rowGone: true, thinkingKept: true });
        expect({ rowGone, thinkingKept }).toEqual({ rowGone: true, thinkingKept: false });
    } finally {
        await fixture.f.cleanup();
    }
}, 60000);

// A pass held for heavy reasoning may still be permitted to rewrite on a first
// render: the cached history head is gone (cleared here, as after a lost cache
// row), so the pass renders it again. At 70% the pass is below the cap and
// outside the force band. With a summary in the head, the new head changes
// bytes in front of the turn's thinking, so the pass releases that thinking
// (strips it) instead of staying held.
test("a first-render pass after heavy reasoning that renders a changed head releases the signed thinking before it retires a covered row", async () => {
    const fixture = await heavyThinkingFixture(43886);
    try {
        const { githubGone, heavy } = await coveredRowScenario(fixture, 211000, () =>
            clearCachedM0M1(fixture.f.db, fixture.f.session),
        );
        expect(
            heavy.logs.some((line) =>
                line.includes("signed thinking hold: held=true reason=heavy_reasoning"),
            ),
        ).toBe(true);
        expect(
            heavy.logs.some(
                (line) =>
                    line.includes("rewrite permission: allowed=true") &&
                    line.includes("signed_prefix_release=true") &&
                    line.includes("first_render=true"),
            ),
        ).toBe(true);
        const coveredGone = !instructionTexts(heavy.draft).includes(githubGone);
        const thinkingKept = heavy.bytes.includes("HELD_SIGNED_REASONING");
        expect({ coveredGone, thinkingKept }).not.toEqual({
            coveredGone: true,
            thinkingKept: true,
        });
        expect(thinkingKept).toBe(false);
    } finally {
        await fixture.f.cleanup();
    }
}, 60000);

// The same first render without a summary in the head: the head bytes do not
// change, so the pass stays held while the first render permits it to rewrite.
test("a held first-render pass does not retire an uncovered row in front of the held signed thinking", async () => {
    const fixture = await heavyThinkingFixture(44886);
    try {
        const { githubGone, heavy } = await uncoveredRowScenario(fixture, 211000, () =>
            clearCachedM0M1(fixture.f.db, fixture.f.session),
        );
        expectHeldFirstRenderPass(heavy.logs);
        const rowGone = !instructionTexts(heavy.draft).includes(githubGone);
        const thinkingKept = heavy.bytes.includes("HELD_SIGNED_REASONING");
        expect({ rowGone, thinkingKept }).not.toEqual({ rowGone: true, thinkingKept: true });
    } finally {
        await fixture.f.cleanup();
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
test("the pass that turns host instruction retention on strips the signed thinking after the rows it puts back", async () => {
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

// A held pass permitted to rewrite (a first render: the cached history head is
// gone, here cleared as after a lost cache row) may not rewrite anything in
// front of the held signed block, so it serves exactly the instruction rows of
// the request before it. A retirement it would have selected waits for the
// next pass that may rewrite the whole prefix. In the force band no pass is
// held any more, so the first render is where this can still happen.
test("a held first-render pass serves the previous request's rows and leaves the retirement to the next whole-prefix pass", async () => {
    const fixture = await heavyThinkingFixture(42886);
    const { f, pass } = fixture;
    try {
        const { githubGone, githubBack, previous, heavy } = await uncoveredRowScenario(
            fixture,
            211000,
            () => clearCachedM0M1(f.db, f.session),
        );
        expectHeldFirstRenderPass(heavy.logs);
        expect(instructionTexts(heavy.draft)).toEqual([githubGone, githubBack]);
        expect(JSON.stringify(heavy.draft.system)).toBe(JSON.stringify(previous.draft.system));
        expect(JSON.stringify(heavy.draft.messages.slice(0, previous.draft.messages.length))).toBe(
            JSON.stringify(previous.draft.messages),
        );
        expect(heavy.bytes).toContain("HELD_SIGNED_REASONING");
        // A later turn without heavy reasoning ends the hold; that pass, in the
        // force band, may rewrite the whole prefix, retires the row and strips
        // the older signed block in front of which it edits.
        f.user("Third batch.", 1000);
        f.respond(1, 260000);
        const unheld = await pass();
        expect(unheld.logs.some((line) => line.includes("thinking_hold=false"))).toBe(true);
        expect(instructionTexts(unheld.draft)).toEqual([githubBack]);
        expect(unheld.bytes).not.toContain("HELD_SIGNED_REASONING");
    } finally {
        await f.cleanup();
    }
}, 60000);
