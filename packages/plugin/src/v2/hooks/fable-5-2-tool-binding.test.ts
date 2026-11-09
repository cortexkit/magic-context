import { expect, test } from "bun:test";
import type { SessionContext } from "./types";
import { oc2ContextFixture } from "./__tests__/oc2-context.fixture";

// Claude 5.1 and later models bind every signed thinking block to the `system`
// prompt, the `tools` array and the messages sent before it. Anthropic's edit
// table lists "Add, remove, rename, or edit a tool in `tools`" as invalidating
// those blocks, and Claude Fable 5.2 returns a 400 for an invalid block on
// every account. A request whose tool list changed therefore has to go out
// without the thinking earlier requests served.
//
// These tests drive the real OpenCode 2 context hook. The kept block belongs to
// a completed earlier turn, so no signed-thinking hold is involved: the pass
// after the tool change is an ordinary request of a new turn.

const THINKING = "SIGNED_AGAINST_THE_FIRST_TOOL_LIST";

type Tools = SessionContext["tools"];

async function serveAcrossToolChange(seed: number, change: (tools: Tools) => void) {
    const f = await oc2ContextFixture(seed, {
        area: "fable-5-2-tool-binding",
        instructions: false,
        temporal: false,
        cacheTtl: "never",
        provider: "anthropic",
        model: "claude-fable-5-2",
    });
    try {
        await f.pass();
        f.respond();
        const signedID = f.rows.at(-1)!.id;
        // The fixture rebuilds each draft from its stored rows, so the signed
        // block is put back on every request, as the host would replay it.
        const withThinking = (draft: SessionContext) => {
            draft.messages
                .find((message) => message.id === signedID)!
                .content.unshift({
                    type: "reasoning",
                    text: THINKING,
                    native: { anthropic: { signature: "signed-block" } },
                });
        };
        f.user("Next task.", 1000);
        const kept = await f.pass(withThinking);
        f.respond();
        f.user("Another task.", 1000);
        const unchanged = await f.pass(withThinking);
        f.respond();
        f.user("A task after the tool list changed.", 1000);
        const changed = await f.pass((draft) => {
            withThinking(draft);
            change(draft.tools);
        });
        return { kept: kept.bytes, unchanged: unchanged.bytes, changed: changed.bytes };
    } finally {
        await f.cleanup();
    }
}

test("OpenCode 2, claude-fable-5-2: a tool added mid-session strips the kept signed thinking", async () => {
    const served = await serveAcrossToolChange(52001, (tools) => {
        tools.mcp_search = {
            description: "Search the connected MCP server",
            input: { type: "object", properties: { query: { type: "string" } } },
        };
    });
    expect(served.kept).toContain(THINKING);
    expect(served.unchanged).toContain(THINKING);
    expect(served.changed).not.toContain(THINKING);
}, 60000);

test("OpenCode 2, claude-fable-5-2: a changed tool description strips the kept signed thinking", async () => {
    const served = await serveAcrossToolChange(52002, (tools) => {
        tools.read!.description = "Read a file from the workspace";
    });
    expect(served.kept).toContain(THINKING);
    expect(served.unchanged).toContain(THINKING);
    expect(served.changed).not.toContain(THINKING);
}, 60000);

// Known gap: the OpenCode 2 tool identity hashes names and descriptions only
// (request-tool-definitions.ts), so a request whose only change is a tool's
// input schema keeps the signed thinking, and Claude Fable 5.2 rejects it.
// Remove `.failing` when a schema change strips that thinking.
test.failing("OpenCode 2, claude-fable-5-2: a schema-only tool change strips the kept signed thinking", async () => {
    const served = await serveAcrossToolChange(52003, (tools) => {
        tools.read!.input = {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
        };
    });
    expect(served.kept).toContain(THINKING);
    expect(served.unchanged).toContain(THINKING);
    expect(served.changed).not.toContain(THINKING);
}, 60000);
