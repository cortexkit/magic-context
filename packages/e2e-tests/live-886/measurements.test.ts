import { expect, test } from "bun:test";
import { billed, chatUsage, cost, csvCell, telemetry, toolOutputBytes, type UsageRow } from "./evidence";
import { Guard } from "./guard";
import { composition } from "./composition";

const row = (id: string, sessionID = "head"): UsageRow => ({ id, session_id: sessionID, seq: 1,
    data: JSON.stringify({ tokens: { input: 100000, output: 1000, reasoning: 100,
        cache: { read: 200000, write: 0 } } }) });

test("billing includes cache reads without counting them twice; reasoning is priced output", () => {
    const usage = JSON.parse(row("one").data).tokens;
    expect(billed(usage)).toBe(300000);
    expect(cost(usage)).toBeCloseTo(0.01626, 10);
});

test("DeepSeek HTTP usage normalizes cache and reasoning the same way as stored usage", () => {
    expect(chatUsage({ prompt_tokens: 300000, prompt_cache_hit_tokens: 200000,
        completion_tokens: 1100, completion_tokens_details: { reasoning_tokens: 100 } }))
        .toEqual({ input: 100000, output: 1000, reasoning: 100, cache: { read: 200000, write: 0 } });
    expect(() => chatUsage({})).toThrow("Invalid/missing");
});

test("step cap rejects the next head pass but counts hidden-session spend separately", () => {
    const guard = new Guard(2, 8, 0.065);
    guard.mainID = "head";
    expect(guard.authorize("head", [])).toBe(true);
    expect(guard.authorize("head", [row("one")])).toBe(true);
    expect(guard.authorize("historian", [row("one"), row("two")])).toBe(true);
    expect(guard.authorize("head", [row("one"), row("two")])).toBe(false);
    expect(guard.reason).toBe("step_cap");
    expect(guard.mainPasses).toBe(2);
});

test("spend guard reserves the next request before it can reach a provider", () => {
    const guard = new Guard(400, 0.08, 0.065);
    guard.mainID = "head";
    expect(guard.authorize("head", [])).toBe(true);
    expect(guard.authorize("head", [row("one")])).toBe(false);
    expect(guard.reason).toBe("spend_guard");
});

test("concurrent hidden calls cannot reuse the head's cost reservation", () => {
    const guard = new Guard(400, 0.1, 0.065);
    expect(guard.authorize("head", [])).toBe(true);
    expect(guard.authorize("historian", [])).toBe(false);
    expect(guard.reason).toBe("spend_guard");
});

test("completed auxiliary requests remain priced without double-counting persisted primary usage", () => {
    const guard = new Guard(400, 8, 0.065);
    const usage = JSON.parse(row("one").data).tokens;
    expect(guard.authorize("head", [], "primary", "primary")).toBe(true);
    guard.result("primary", usage);
    expect(guard.extraCost([])).toBeCloseTo(0.01626, 10);
    expect(guard.extraCost([row("one")])).toBe(0);
    expect(guard.authorize("head", [row("one")], "generate", "historian")).toBe(true);
    guard.result("historian", usage);
    expect(guard.extraCost([row("one")])).toBeCloseTo(0.01626, 10);
});

test("missing persisted usage fails closed instead of underestimating cost", () => {
    const guard = new Guard(400, 8, 0.065);
    expect(guard.authorize("head", [])).toBe(true);
    expect(() => guard.authorize("head", [])).toThrow("not persisted");
});

test("CSV escaping, telemetry and tool-output share use independent inputs", () => {
    expect(csvCell('a,"b"\nc')).toBe('"a,""b""\nc"');
    expect(telemetry("transform: final-wire telemetry estimate=528630 trusted=true conversation=222208 tools=11725 system=11913 toolDefinitions=36938"))
        .toEqual({ estimate: 528630, conversation: 222208, tools: 11725, system: 11913, definitions: 36938 });
    expect(telemetry("not recorded")).toBeNull();
    const tool = { role: "tool", content: "printed source" };
    expect(toolOutputBytes({ messages: [{ role: "user", content: "not tool output" }, tool] }))
        .toBe(Buffer.byteLength(JSON.stringify(tool)));
});

test("composition separates merged instructions, history, tools, and the raw tail", () => {
    const instruction = "Issue886 instruction revision 2";
    const result = composition({ messages: [
        { role: "system", content: `base ${instruction}` },
        { role: "user", content: "<session-history>old</session-history>" },
        { role: "user", content: "current task" },
    ], tools: [{ name: "shell" }] }, { messages: [{ role: "system", content: [{ type: "text", text: instruction }] }] },
    [{ id: "system-row", seq: 3, type: "system", data: JSON.stringify({ text: instruction }) }], (text) => text.length);
    expect(result.systemTokens).toBe(5);
    expect(result.instructionCount).toBe(1);
    expect(result.instructionTokens).toBe(31);
    expect(result.historyTokens).toBe(38);
    expect(result.rawTokens).toBe(12);
    expect(result.dbInstructionRows).toBe(1);
    expect(result.dbInstructionBytes).toBe(31);
    expect(result.dbRevisionRows).toBe(1);
});

test("DeepSeek system-update wrappers stay separate when merged into m1 user content", () => {
    const result = composition({ messages: [{ role: "user",
        content: "<session-history-since>summary</session-history-since>\n<system-update>rule</system-update>" }] },
    { messages: [{ role: "system", content: [{ type: "text", text: "rule" }] }] }, [], (text) => text.length);
    expect(result.historyCount).toBe(1);
    expect(result.instructionCount).toBe(1);
    expect(result.instructionTokens).toBe(35);
    expect(result.historyTokens).toBe(55);
    expect(result.rawTokens).toBe(0);
});

test("a combined MCP catalog/guidance row is attributed to both sources but counted once overall", () => {
    const result = composition({ messages: [{ role: "user", content: "<system-update>catalog</system-update>" }] },
        { messages: [{ role: "system", content: [{ type: "text", text: "catalog" }] }] },
        [{ id: "catalog-row", seq: 1, type: "system", data: JSON.stringify({ text: "catalog",
            metadata: { instructionSources: ["core/codemode", "core/mcp-guidance"] } }) }], (text) => text.length);
    expect(result.instructionCount).toBe(1);
    expect(result.instructionTokens).toBe(38);
    expect(result.dbCodemodeRows).toBe(1);
    expect(result.dbMcpGuidanceRows).toBe(1);
    expect(result.servedCodemodeCount).toBe(1);
    expect(result.servedMcpGuidanceCount).toBe(1);
    expect(result.servedCodemodeTokens).toBe(38);
    expect(result.servedMcpGuidanceTokens).toBe(38);
});
