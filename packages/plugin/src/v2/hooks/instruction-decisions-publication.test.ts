// On OpenCode 2 a pass that retires instruction rows saves that decision in its
// publication, the last step before it returns its request, in one transaction
// with the served-prefix record and the capture's certificate. The publication
// can still refuse the pass after the capture: then the capture is discarded and
// the decision must not be saved either, or the next pass would replay the
// retirement as already served although the provider last received the older
// request. These tests refuse a retiring pass at its publication and compare
// what the next pass serves with a run where the refused pass never happened.
// A refused publication also puts back the capture served before the pass, so
// the wrapper replays the last request actually sent in place of the refused
// one; with no earlier capture the turn is refused.
import { expect, spyOn, test } from "bun:test";
import { readReplayEnvelope } from "../../features/magic-context/storage-replay-document";
import * as lkgServedMarker from "../../hooks/magic-context/lkg-served-marker";
import { getInMemorySlot } from "../../hooks/magic-context/lkg-slot";
import { readServedPrefix } from "../../hooks/magic-context/served-prefix";
import { retiredLiveInstructionIDs } from "../fold/instruction-supersession";
import { replaceCodeModeCatalog } from "./__tests__/code-mode-catalog.fixture";
import { oc2ContextFixture } from "./__tests__/oc2-context.fixture";

const options = {
    area: "publication-refusal",
    instructions: false,
    temporal: false,
    cacheTtl: "never",
};
const both = { instructionSources: ["core/codemode", "core/mcp-guidance"] };
const guidance = (name: string) =>
    `<mcp_instructions>\n  <server name="publication">\n    ${name}\n  </server>\n</mcp_instructions>`;
const fullGuidance = (name: string) =>
    `The available MCP server instructions have changed. This list supersedes the previous one.\n${guidance(name)}`;
const combined = (name: string) => `${replaceCodeModeCatalog([name])}\n\n${fullGuidance(name)}`;

type Fixture = Awaited<ReturnType<typeof oc2ContextFixture>>;
const systemTexts = (draft: { messages: Array<{ role: string; content: unknown[] }> }) =>
    draft.messages
        .filter((message) => message.role === "system")
        .flatMap((message) => message.content.map((part) => (part as { text?: string }).text));
const decisionNamespaces = (f: Fixture) => {
    const envelope = readReplayEnvelope(f.db, f.session);
    return JSON.stringify([
        envelope.instructionSupersession,
        envelope.coveredInstructionSupersession,
        envelope.hostInstructionRetention,
    ]);
};

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

/** A pass refused at its publication: the served-capture certificate cannot be written. */
async function refusedAtPublication(f: Fixture) {
    let publications = 0;
    const spy = spyOn(lkgServedMarker, "recordServedCapture").mockImplementation(() => {
        publications += 1;
        throw new Error("injected publication failure");
    });
    try {
        const refused = await f.attempt();
        // The refusal must come from the publication, not from an earlier site.
        expect(publications).toBeGreaterThan(0);
        return refused;
    } finally {
        spy.mockRestore();
    }
}

test("a retiring pass refused at its publication saves no retirement, and the next pass serves what it serves when no pass was refused", async () => {
    const seed = 32179;
    let withoutRefusal: string;
    let withoutRefusalFirst: string;
    {
        const f = await oc2ContextFixture(seed, options);
        try {
            withoutRefusalFirst = (await upToRetirement(f)).bytes;
            const retiring = await f.pass();
            // Without the refusal this pass retires the older catalog.
            expect(systemTexts(retiring.draft as never)).toEqual([
                combined("CURRENT_WIRE_CATALOG"),
            ]);
            expect(retiredLiveInstructionIDs(f.db, f.session).size).toBe(1);
            withoutRefusal = retiring.bytes;
        } finally {
            await f.cleanup();
        }
    }
    const f = await oc2ContextFixture(seed, options);
    try {
        const first = await upToRetirement(f);
        expect(first.bytes).toBe(withoutRefusalFirst);
        const before = decisionNamespaces(f);
        const prefixBefore = JSON.stringify(readServedPrefix(f.db, f.session));
        const servedBefore = getInMemorySlot(f.session);
        expect(servedBefore?.servedCaptureWithheld).toBeUndefined();
        const refused = await refusedAtPublication(f);
        // The capture served before the refused pass is back in place, as it
        // was, and the wrapper replays it.
        expect(refused.error).toBeUndefined();
        expect(refused.logs.some((line) => line.endsWith("lkg_replay_served"))).toBe(true);
        expect(getInMemorySlot(f.session)?.capturedAt).toBe(servedBefore?.capturedAt);
        expect(getInMemorySlot(f.session)?.servedCaptureWithheld).toBeUndefined();
        // Nothing the refused pass decided about instruction rows is saved, and
        // neither is the served prefix it would have published.
        expect(retiredLiveInstructionIDs(f.db, f.session).size).toBe(0);
        expect(decisionNamespaces(f)).toBe(before);
        expect(JSON.stringify(readServedPrefix(f.db, f.session))).toBe(prefixBefore);
        const next = await f.pass();
        expect(systemTexts(next.draft as never)).toEqual([combined("CURRENT_WIRE_CATALOG")]);
        expect(next.bytes).toBe(withoutRefusal);
        expect(retiredLiveInstructionIDs(f.db, f.session).size).toBe(1);
    } finally {
        await f.cleanup();
    }
}, 60000);

test("a session's first pass refused at its publication leaves no capture to replay, and the turn is refused", async () => {
    const f = await oc2ContextFixture(32189, options);
    try {
        f.compartment(4);
        expect(getInMemorySlot(f.session)).toBeUndefined();
        const refused = await refusedAtPublication(f);
        expect(refused.error).toBeDefined();
        expect(refused.logs.some((line) => line.endsWith("lkg_replay_served"))).toBe(false);
        expect(getInMemorySlot(f.session)).toBeUndefined();
        // The next pass, with a working publication, serves normally.
        const next = await f.pass();
        expect(next.bytes.length).toBeGreaterThan(0);
    } finally {
        await f.cleanup();
    }
}, 60000);
