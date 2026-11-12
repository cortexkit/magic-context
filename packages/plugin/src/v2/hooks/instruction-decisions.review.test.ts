// Independent review check for "a refused pass leaves no instruction-row
// retirement saved" (OpenCode 2). The change saves a pass's instruction-row
// decisions in its publication, in one transaction with the served records, so
// a pass refused before that transaction commits leaves none of them behind. The existing tests check the stored decisions; these
// compare served bytes across the refusal: what the wrapper replays in place of
// the refused pass, what the next pass serves after it, and what the same next
// pass serves in a run where the refused pass never happened.
import { expect, spyOn, test } from "bun:test";
import * as lkgRecoveryPrefix from "../../hooks/magic-context/lkg-recovery-prefix";
import { retiredLiveInstructionIDs } from "../fold/instruction-supersession";
import { replaceCodeModeCatalog } from "./__tests__/code-mode-catalog.fixture";
import { oc2ContextFixture } from "./__tests__/oc2-context.fixture";

const options = {
    area: "refused-rebuild-review",
    instructions: false,
    temporal: false,
    cacheTtl: "never",
};
const both = { instructionSources: ["core/codemode", "core/mcp-guidance"] };
const guidance = (name: string) =>
    `<mcp_instructions>\n  <server name="review">\n    ${name}\n  </server>\n</mcp_instructions>`;
const fullGuidance = (name: string) =>
    `The available MCP server instructions have changed. This list supersedes the previous one.\n${guidance(name)}`;
const combined = (name: string) => `${replaceCodeModeCatalog([name])}\n\n${fullGuidance(name)}`;

type Fixture = Awaited<ReturnType<typeof oc2ContextFixture>>;
const messagesOf = (draft: { messages: unknown[] }) => draft.messages.map((m) => JSON.stringify(m));
const systemTexts = (draft: { messages: Array<{ role: string; content: unknown[] }> }) =>
    draft.messages
        .filter((message) => message.role === "system")
        .flatMap((message) => message.content.map((part) => (part as { text?: string }).text));

/** A pass refused at the untagged-record write, inside its publication. */
async function refusedAtUntaggedRecord(f: Fixture) {
    const spies = [
        spyOn(lkgRecoveryPrefix, "readPersistedLkgUntaggedInputIds").mockReturnValue([
            "untagged-row-no-longer-served",
        ]),
        spyOn(lkgRecoveryPrefix, "persistLkgUntaggedInputIds").mockReturnValue(false),
    ];
    try {
        return await f.attempt();
    } finally {
        for (const spy of spies) spy.mockRestore();
    }
}

/**
 * The session up to the pass that retires the older catalog: the provider
 * reports usage high enough (900k tokens) that the pass may rewrite the prefix.
 */
async function upToRetirement(f: Fixture) {
    f.compartment(4);
    const first = await f.pass();
    f.instruction(combined("RETIRED_WIRE_CATALOG"), both);
    f.instruction(combined("CURRENT_WIRE_CATALOG"), both);
    f.respond(1, 900000);
    return first;
}

test("after a refused retiring pass, the next pass that may rewrite the prefix serves what it serves when no pass was refused", async () => {
    const seed = 31979;
    let withoutRefusal: string;
    let withoutRefusalFirst: string;
    {
        const f = await oc2ContextFixture(seed, options);
        try {
            withoutRefusalFirst = (await upToRetirement(f)).bytes;
            withoutRefusal = (await f.pass()).bytes;
        } finally {
            await f.cleanup();
        }
    }
    const f = await oc2ContextFixture(seed, options);
    try {
        const first = await upToRetirement(f);
        expect(first.bytes).toBe(withoutRefusalFirst);
        const refused = await refusedAtUntaggedRecord(f);
        expect(refused.error).toBeUndefined();
        expect(refused.logs.some((line) => line.endsWith("lkg_replay_served"))).toBe(true);
        // The replay is the previous request plus the new rows, so it still
        // serves the catalog the refused pass retired.
        expect(systemTexts(refused.draft as never)).toContain(combined("RETIRED_WIRE_CATALOG"));
        expect(retiredLiveInstructionIDs(f.db, f.session).size).toBe(0);
        const next = await f.pass();
        expect(systemTexts(next.draft as never)).toEqual([combined("CURRENT_WIRE_CATALOG")]);
        expect(next.bytes).toBe(withoutRefusal);
    } finally {
        await f.cleanup();
    }
}, 60000);

test("after a refused retiring pass, a next pass that may not rewrite the prefix serves the replay byte for byte and retires nothing", async () => {
    const f = await oc2ContextFixture(31989, options);
    try {
        await upToRetirement(f);
        const refused = await refusedAtUntaggedRecord(f);
        expect(refused.error).toBeUndefined();
        expect(refused.logs.some((line) => line.endsWith("lkg_replay_served"))).toBe(true);
        const replay = messagesOf(refused.draft as never);
        // The provider answers the replay with low usage: no pass may rewrite now.
        f.respond(1, 10000);
        const next = await f.pass();
        const served = messagesOf(next.draft as never);
        expect(served.slice(0, replay.length)).toEqual(replay);
        expect(systemTexts(next.draft as never)).toContain(combined("RETIRED_WIRE_CATALOG"));
        expect(retiredLiveInstructionIDs(f.db, f.session).size).toBe(0);
    } finally {
        await f.cleanup();
    }
}, 60000);
