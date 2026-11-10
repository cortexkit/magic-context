import { expect, spyOn, test } from "bun:test";
import { estimateTokens } from "../../hooks/magic-context/read-session-formatting";
import * as instructionSupersession from "../fold/instruction-supersession";
import { retiredLiveInstructionIDs } from "../fold/instruction-supersession";
import { NativeFoldReplay } from "../fold/native-replay";
import { addCodeModeEntries, replaceCodeModeCatalog } from "./__tests__/code-mode-catalog.fixture";
import { installBusyAdmission, oc2ContextFixture } from "./__tests__/oc2-context.fixture";

const options = { area: "issue-879", instructions: false, temporal: false, cacheTtl: "never" };
const both = { instructionSources: ["core/codemode", "core/mcp-guidance"] };
const code = { instructionSources: ["core/codemode"] };
const mcp = { instructionSources: ["core/mcp-guidance"] };
const guidance = (name: string) =>
    `<mcp_instructions>\n  <server name="review">\n    ${name}\n  </server>\n</mcp_instructions>`;
const fullGuidance = (name: string) =>
    `The available MCP server instructions have changed. This list supersedes the previous one.\n${guidance(name)}`;
const delta =
    'New MCP server instructions are available in addition to those previously listed:\n  <server name="new">\n    NEW_SERVER\n  </server>';
const combined = (name: string) => `${replaceCodeModeCatalog([name])}\n\n${fullGuidance(name)}`;
const instructionTexts = (
    pass: Awaited<ReturnType<Awaited<ReturnType<typeof oc2ContextFixture>>["pass"]>>,
) =>
    pass.draft.messages
        .filter((message) => message.role === "system")
        .flatMap((message) => message.content.map((part) => part.text));

test("a retired catalog remains omitted byte-for-byte on a busy request replay", async () => {
    const f = await oc2ContextFixture(29879, options);
    const busy = installBusyAdmission();
    try {
        f.compartment(4);
        await f.pass();
        f.instruction(combined("RETIRED_WIRE_CATALOG"), both);
        f.instruction(combined("CURRENT_WIRE_CATALOG"), both);
        f.respond(1, 900000);
        const retired = await f.pass();
        expect(instructionTexts(retired)).toEqual([combined("CURRENT_WIRE_CATALOG")]);
        busy.state.busyNext = true;
        const replay = await f.pass();
        expect(replay.logs.some((line) => line.endsWith("lkg_replay_served"))).toBe(true);
        expect(replay.bytes).toBe(retired.bytes);
    } finally {
        busy.restore();
        await f.cleanup();
    }
}, 60000);

test("force-band rebuild reclaims sixty combined catalogs by native row identity and replays after restart", async () => {
    const f = await oc2ContextFixture(20879, options);
    const pass = () =>
        f.pass((draft) => {
            draft.model.limit = { context: 302000 };
        });
    try {
        await pass();
        const texts = Array.from({ length: 60 }, (_, i) =>
            combined(`CATALOG_${i} ${"tool description ".repeat(770)}`),
        );
        for (const text of texts) f.instruction(text, both);
        const held = await pass();
        expect(instructionTexts(held)).toEqual(texts);
        const unchanged = await pass();
        expect(unchanged.bytes).toBe(held.bytes);
        const docBefore = f.db
            .prepare("SELECT trailing_blank_decisions AS doc FROM session_meta WHERE session_id=?")
            .get(f.session);
        f.respond(1, 260000);
        const rebuilt = await pass();
        expect(instructionTexts(rebuilt)).toEqual([texts.at(-1)]);
        const reclaimed = texts
            .slice(0, -1)
            .reduce((sum, text) => sum + JSON.stringify(text).length, 0);
        expect(held.bytes.length - rebuilt.bytes.length).toBeGreaterThan(reclaimed - 1000);
        console.log(
            "REPORTER_CATALOG_RECLAIM",
            JSON.stringify({
                contextLimit: 302000,
                providerInputTokens: 260000,
                rowsBefore: texts.length,
                rowsAfter: instructionTexts(rebuilt).length,
                instructionTokens: estimateTokens(texts.join("")),
                expectedReclaimedBytes: reclaimed,
                requestBytesRemoved: held.bytes.length - rebuilt.bytes.length,
            }),
        );
        expect(retiredLiveInstructionIDs(f.db, f.session).size).toBe(59);
        expect(
            f.db
                .prepare(
                    "SELECT trailing_blank_decisions AS doc FROM session_meta WHERE session_id=?",
                )
                .get(f.session),
        ).not.toEqual(docBefore);
        const saved = f.db
            .prepare("SELECT trailing_blank_decisions AS doc FROM session_meta WHERE session_id=?")
            .get(f.session);
        await f.restart();
        expect((await pass()).bytes).toBe(rebuilt.bytes);
        expect(
            f.db
                .prepare(
                    "SELECT trailing_blank_decisions AS doc FROM session_meta WHERE session_id=?",
                )
                .get(f.session),
        ).toEqual(saved);
    } finally {
        await f.cleanup();
    }
}, 60000);

test("automatic checkpoint adoption preserves the first wire request and bounds the live retirement namespace", async () => {
    const firstRequests: string[] = [];
    for (const adopt of [false, true]) {
        const f = await oc2ContextFixture(27879, options);
        let restoreSuppression: (() => void) | undefined;
        try {
            f.compartment(4);
            await f.pass();
            f.instruction(combined("AUTO_OLD"), both);
            const oldID = f.rows.at(-1)!.id;
            f.instruction(combined("AUTO_NEW"), both);
            f.respond(1, 900000);
            const before = await f.pass();
            expect(instructionTexts(before)).not.toContain(combined("AUTO_OLD"));
            if (!adopt) {
                const suppress = spyOn(
                    instructionSupersession,
                    "retiredLiveInstructionIDs",
                ).mockReturnValue(new Set());
                restoreSuppression = () => {
                    suppress.mockRestore();
                };
            }
            await f.nativeFold(3, 0, "");
            restoreSuppression?.();
            restoreSuppression = undefined;
            firstRequests.push((await f.pass()).bytes);
            expect(retiredLiveInstructionIDs(f.db, f.session).has(oldID)).toBe(true);
            if (adopt) {
                f.instruction(combined("AUTO_NEXT_OLD"), both);
                const nextID = f.rows.at(-1)!.id;
                f.instruction(combined("AUTO_NEXT_NEW"), both);
                f.respond(1, 900000);
                await f.pass();
                expect(retiredLiveInstructionIDs(f.db, f.session).has(oldID)).toBe(false);
                expect(retiredLiveInstructionIDs(f.db, f.session).has(nextID)).toBe(true);
                await f.restart();
                expect(instructionTexts(await f.pass())).not.toContain(combined("AUTO_OLD"));
            }
        } finally {
            restoreSuppression?.();
            await f.cleanup();
        }
    }
    expect(firstRequests[1]).toBe(firstRequests[0]);
}, 60000);

test("a checkpoint cannot adopt a live retirement for a row still present in its wire input", async () => {
    const f = await oc2ContextFixture(28879, options);
    const original = NativeFoldReplay.prototype.supply;
    const supply = spyOn(NativeFoldReplay.prototype, "supply").mockImplementation(function (
        this: NativeFoldReplay,
        args,
    ) {
        args.draft.messages.push({
            role: "system",
            content: [{ type: "text", text: combined("STILL_PRESENT") }],
        });
        return original.call(this, args);
    });
    try {
        f.compartment(4);
        await f.pass();
        f.instruction(combined("STILL_PRESENT"), both);
        const oldID = f.rows.at(-1)!.id;
        f.instruction(combined("ACTUAL_NEWEST"), both);
        f.respond(1, 900000);
        await f.pass();
        await f.nativeFold(3, 0, "");
        supply.mockRestore();
        await f.pass();
        f.instruction(combined("GUARD_NEXT_OLD"), both);
        f.instruction(combined("GUARD_NEXT_NEW"), both);
        f.respond(1, 900000);
        await f.pass();
        expect(retiredLiveInstructionIDs(f.db, f.session).has(oldID)).toBe(true);
    } finally {
        supply.mockRestore();
        await f.cleanup();
    }
}, 60000);

test("incremental Code Mode and MCP deltas preserve their bases while independent fully restated rows retire", async () => {
    const f = await oc2ContextFixture(21879, options);
    try {
        await f.pass();
        const old = combined("SUPERSEDED");
        const base = combined("DELTA_BASE");
        const incremental = addCodeModeEntries(["INCREMENTAL_TOOL"]);
        for (const text of [old, base]) f.instruction(text, both);
        f.instruction(incremental, code);
        f.instruction(delta, mcp);
        f.respond(1, 900000);
        expect(instructionTexts(await f.pass())).toEqual([base, incremental, delta]);
    } finally {
        await f.cleanup();
    }
}, 60000);

test("a combined catalog with an MCP delta stays until a newer catalog and a newer MCP list or mention of its server restate it", async () => {
    const f = await oc2ContextFixture(22879, options);
    try {
        await f.pass();
        const base = combined("GUIDANCE_BASE");
        const mixed = `${replaceCodeModeCatalog(["MIXED"])}\n\n${delta}`;
        const latestCode = replaceCodeModeCatalog(["LATEST_CODE"]);
        f.instruction(base, both);
        f.instruction(mixed, both);
        f.instruction(latestCode, code);
        f.respond(1, 900000);
        expect(instructionTexts(await f.pass())).toEqual([base, mixed, latestCode]);
        f.instruction(fullGuidance("LATEST_GUIDANCE"), mcp);
        f.respond(1, 900000);
        expect(instructionTexts(await f.pass())).toEqual([
            latestCode,
            fullGuidance("LATEST_GUIDANCE"),
        ]);
    } finally {
        await f.cleanup();
    }
}, 60000);

test("unknown sources, unrecognized text and unresolved native identities survive a permitted pass", async () => {
    const f = await oc2ContextFixture(23879, options);
    try {
        await f.pass();
        const old = combined("OLD_KNOWN");
        const unknown = combined("UNKNOWN_SOURCE");
        const unrecognized = "Unrecognized Code Mode instruction rendering";
        const newest = combined("NEWEST_KNOWN");
        f.instruction(old, both);
        f.instruction(unknown, {
            instructionSources: [...both.instructionSources, "plugin/policy"],
        });
        f.instruction(unrecognized, code);
        f.instruction(newest, both);
        f.respond(1, 900000);
        const result = await f.pass((draft) => {
            draft.messages.push({
                role: "system",
                content: [{ type: "text", text: combined("UNRESOLVED") }],
            });
        });
        expect(instructionTexts(result)).toEqual([
            unknown,
            unrecognized,
            newest,
            combined("UNRESOLVED"),
        ]);
    } finally {
        await f.cleanup();
    }
}, 60000);

test("a mid-conversation catalog retirement strips a kept later signed block on a prefix-bound model", async () => {
    const f = await oc2ContextFixture(24879, {
        ...options,
        provider: "anthropic",
        model: "claude-opus-5-5",
    });
    try {
        await f.pass();
        f.instruction(combined("BEFORE_THINKING"), both);
        f.respond();
        const signedID = f.rows.at(-1)!.id;
        const addThinking = (draft: Parameters<NonNullable<Parameters<typeof f.pass>[0]>>[0]) => {
            draft.messages
                .find((message) => message.id === signedID)!
                .content.unshift({
                    type: "reasoning",
                    text: "KEEP_SIGNED_REASONING",
                    native: { anthropic: { signature: "signed-block" } },
                });
        };
        const before = await f.pass(addThinking);
        expect(before.bytes).toContain("KEEP_SIGNED_REASONING");
        f.instruction(combined("AFTER_THINKING"), both);
        f.user("Continue after the completed signed turn.", 1000);
        f.respond(1, 900000);
        const after = await f.pass(addThinking);
        expect(instructionTexts(after)).toEqual([combined("AFTER_THINKING")]);
        expect(after.bytes).not.toContain("KEEP_SIGNED_REASONING");
        expect((await f.pass(addThinking)).bytes).toBe(after.bytes);
    } finally {
        await f.cleanup();
    }
}, 60000);

test("manual fold retires a combined row after its boundary using the same per-source rule", async () => {
    const f = await oc2ContextFixture(25879, options);
    const prepare = spyOn(NativeFoldReplay.prototype, "prepareManualFold");
    try {
        f.compartment(4);
        await f.pass();
        f.instruction(combined("MANUAL_OLD"), both);
        const oldID = f.rows.at(-1)!.id;
        f.instruction(replaceCodeModeCatalog(["MANUAL_CODE"]), code);
        f.instruction(guidance("MANUAL_GUIDANCE"), mcp);
        const held = await f.pass();
        expect(instructionTexts(held)).toContain(combined("MANUAL_OLD"));
        await f.nativeFold(3, 0, "", "manual");
        const replay = await prepare.mock.results.at(-1)!.value;
        expect(replay.retiredInstructionIDs).toContain(oldID);
        expect(instructionTexts(await f.pass())).not.toContain(combined("MANUAL_OLD"));
    } finally {
        prepare.mockRestore();
        await f.cleanup();
    }
}, 60000);

test("folds preserve live retirements and prune covered ids only with the next new retirement", async () => {
    const f = await oc2ContextFixture(26879, options);
    try {
        f.compartment(4);
        await f.pass();
        f.instruction(combined("LIVE_OLD"), both);
        const oldID = f.rows.at(-1)!.id;
        f.instruction(combined("LIVE_NEW"), both);
        f.respond(1, 900000);
        await f.pass();
        expect(retiredLiveInstructionIDs(f.db, f.session).has(oldID)).toBe(true);
        await f.nativeFold(3, 0, "", "manual");
        const folded = await f.pass();
        expect(instructionTexts(folded)).not.toContain(combined("LIVE_OLD"));
        expect(retiredLiveInstructionIDs(f.db, f.session).has(oldID)).toBe(true);
        f.instruction(combined("POST_FOLD_OLD"), both);
        const postFoldID = f.rows.at(-1)!.id;
        f.instruction(combined("POST_FOLD_NEW"), both);
        f.respond(1, 900000);
        await f.pass();
        expect([...retiredLiveInstructionIDs(f.db, f.session)]).toContain(postFoldID);
        expect(retiredLiveInstructionIDs(f.db, f.session).has(oldID)).toBe(false);
        await f.restart();
        const restarted = await f.pass();
        expect(instructionTexts(restarted)).not.toContain(combined("LIVE_OLD"));
        expect(instructionTexts(restarted)).not.toContain(combined("POST_FOLD_OLD"));
    } finally {
        await f.cleanup();
    }
}, 60000);
