import { describe, expect, it } from "bun:test";
import {
    buildSeedRequest,
    MAX_SEED_TURNS,
    MIN_SIGNED_BLOCKS,
    prepareRecordedSeed,
    recordedThinkingVariants,
    replaceLastUserText,
    requireSignedHistory,
    restoreFirstSignedBlock,
    runRecordedCells,
    seedPrompt,
    shouldRetryRefusal,
    shouldSeedTurn,
    thinkingVariants,
    THINKING_MAX_TOKENS,
    type ThinkingRequest,
} from "./thinking-matrix";

const fixture = (): ThinkingRequest => ({
    model: "fixture", thinking: { type: "adaptive" }, system: "fixed", tools: ["echo"],
    messages: [
        { role: "user", content: [{ type: "text", text: "first user" }] },
        { role: "assistant", content: [{ type: "thinking", thinking: "t0", signature: "s0" }, { type: "tool_use", id: "a", input: { value: "original" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "original" }] },
        { role: "assistant", content: [{ type: "thinking", thinking: "t1", signature: "s1" }, { type: "text", text: "done 1" }] },
        { role: "user", content: [{ type: "text", text: "second user" }] },
        { role: "assistant", content: [{ type: "thinking", thinking: "t2", signature: "s2" }, { type: "tool_use", id: "b", input: { value: "next" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "b", content: "next" }] },
        { role: "assistant", content: [{ type: "thinking", thinking: "t3", signature: "s3" }, { type: "text", text: "done 2" }] },
        { role: "user", content: [{ type: "text", text: "next request" }] },
    ],
});

const recordedFixture = (): ThinkingRequest => {
    const request = fixture();
    request.model = "claude-opus-5-5";
    request.output_config = { effort: "high" };
    request.thinking = { type: "adaptive", display: "summarized" };
    request.messages.splice(8, 0,
        { role: "user", content: [{ type: "text", text: "third user" }] },
        { role: "assistant", content: [{ type: "thinking", thinking: "t4", signature: "s4" }, { type: "tool_use", id: "c", input: { value: "third" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "c", content: "third" }] },
        { role: "assistant", content: [{ type: "thinking", thinking: "t5", signature: "s5" }, { type: "text", text: "done 3" }] },
    );
    return request;
};

describe("recorded signed-thinking matrix", () => {
    it("preserves seed history and effort while changing only caps and strict binding", () => {
        const original = recordedFixture();
        const prepared = prepareRecordedSeed(original, "claude-opus-5-5");
        expect(prepared.messages).toEqual(original.messages);
        expect(prepared.output_config).toEqual({ effort: "high" });
        expect(prepared.thinking).toEqual({ type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "error" } });
        expect(prepared.max_tokens).toBe(64);
        expect(prepared.stream).toBe(false);
        expect(original).toEqual(recordedFixture());
    });
    it("rejects insufficient, mismatched or unsupported recorded seeds", () => {
        expect(() => prepareRecordedSeed(fixture(), "fixture")).toThrow("six signed blocks");
        expect(() => prepareRecordedSeed(recordedFixture(), "claude-sonnet-5-5")).toThrow("model does not match");
        const enabled = recordedFixture();
        enabled.thinking = { type: "enabled" };
        expect(() => prepareRecordedSeed(enabled, "claude-opus-5-5")).toThrow("adaptive thinking and output_config.effort");
        const noEffort = recordedFixture();
        delete noEffort.output_config;
        expect(() => prepareRecordedSeed(noEffort, "claude-opus-5-5")).toThrow("output_config.effort");
        const concentrated = recordedFixture();
        const signed = concentrated.messages.flatMap((m) => m.content).filter((b) => b.type === "thinking");
        for (const m of concentrated.messages) m.content = m.content.filter((b) => b.type !== "thinking");
        concentrated.messages[1]!.content.unshift(...signed);
        expect(() => prepareRecordedSeed(concentrated, "claude-opus-5-5")).toThrow("three assistant messages");
        const noTools = recordedFixture();
        for (const m of noTools.messages) m.content = m.content.filter((b) => b.type !== "tool_use");
        expect(() => prepareRecordedSeed(noTools, "claude-opus-5-5")).toThrow("tool calls between");
    });
    it("uses exact independent prefix, suffix, all and middle mutations", () => {
        const seed = recordedFixture();
        const rows = recordedThinkingVariants(seed);
        expect(rows.map((r) => r.variant)).toEqual(["control", "oldest-1", "middle-suffix-stripped", "all-stripped", "middle-kept",
            "tool-result-edit-kept", "first-user-edit-kept", "cleared-text"]);
        expect(signatures(rows[0]!.request)).toEqual(["s0", "s1", "s2", "s3", "s4", "s5"]);
        expect(signatures(rows[1]!.request)).toEqual(["s1", "s2", "s3", "s4", "s5"]);
        expect(signatures(rows[2]!.request)).toEqual(["s0"]);
        expect(signatures(rows[3]!.request)).toEqual([]);
        expect(signatures(rows[4]!.request)).toEqual(["s0", "s2", "s3", "s4", "s5"]);
        for (const row of rows.slice(0, 5)) expect(nonThinking(row.request)).toEqual(nonThinking(seed));
        expect(seed).toEqual(recordedFixture());
    });
    it("runs nine one-shot cells and restores only after a newly signed prefix response", async () => {
        const sent: Array<{ variant: string; request: ThinkingRequest }> = [];
        const result = await runRecordedCells(recordedFixture(), async (variant, request) => {
            sent.push({ variant, request });
            return { status: 200, accepted: true, error: null, content: [
                { type: "thinking", thinking: "branch reasoning", signature: `${variant}-new` },
                { type: "tool_use", id: "not-executed", name: "echo", input: { value: "test" } },
            ] };
        });
        expect(result.calls).toBe(9);
        expect(result.completed).toBe(true);
        expect(sent.map((s) => s.variant)).toEqual(["control", "oldest-1", "middle-suffix-stripped", "all-stripped", "middle-kept",
            "restore-removed-prefix", "tool-result-edit-kept", "first-user-edit-kept", "cleared-text"]);
        const restored = sent[5]!.request;
        expect(signatures(restored)).toEqual(["s0", "s1", "s2", "s3", "s4", "s5", "oldest-1-new"]);
        expect(restored.messages.at(-1)!.content[0]).toEqual({ type: "tool_result", tool_use_id: "not-executed",
            content: "Tool not executed by the signature-validation harness.", is_error: true });
        for (const row of sent.filter((s) => s.variant !== "restore-removed-prefix")) {
            expect(row.request.messages.length).toBe(recordedFixture().messages.length);
        }
    });
    it("marks restore not reached without claiming completion when no new signature exists", async () => {
        let calls = 0;
        const result = await runRecordedCells(recordedFixture(), async () => {
            calls++;
            return { status: 200, accepted: true, error: null, content: [{ type: "text", text: "OK" }] };
        });
        expect(calls).toBe(8);
        expect(result.completed).toBe(false);
        expect(result.cells.find((c) => c.variant === "restore-removed-prefix")).toEqual(expect.objectContaining({ status: null, accepted: null }));
    });
    it("stops after a rejected control without sending any mutation", async () => {
        const sent: string[] = [];
        const result = await runRecordedCells(recordedFixture(), async (variant) => {
            sent.push(variant);
            return { status: 400, accepted: false, error: "invalid signature", content: null };
        });
        expect(sent).toEqual(["control"]);
        expect(result.completed).toBe(false);
        expect(result.reason).toContain("Unchanged control rejected");
    });
    it("stops immediately on 429 or quota errors without retries", async () => {
        for (const [status, error] of [[429, "rate_limit_error"], [400, "quota exceeded"], [400, "credit balance too low"]] as const) {
            const sent: string[] = [];
            const result = await runRecordedCells(recordedFixture(), async (variant) => {
                sent.push(variant);
                return variant === "control" ? { status: 200, accepted: true, error: null, content: [] } :
                    { status, accepted: false, error, content: null };
            });
            expect(sent).toEqual(["control", "oldest-1"]);
            expect(result.completed).toBe(false);
            expect(result.reason).toContain("provider interruption");
        }
    });
});
const signatures = (r: ThinkingRequest) => r.messages.flatMap((m) => m.content).filter((b) => b.type === "thinking").map((b) => b.signature);
const nonThinking = (r: ThinkingRequest) => r.messages.map((m) => ({ ...m, content: m.content.filter((b) => b.type !== "thinking") }));

describe("signed-thinking request matrix", () => {
    it("uses supported high-effort adaptive reasoning with neutral seed prompts", () => {
        const request = buildSeedRequest("claude-opus-5-5", "subscription prefix");
        expect(request.thinking).toEqual({
            type: "adaptive",
            block_binding: { prefix_mismatch_behavior: "error" },
        });
        expect(request.output_config).toEqual({ effort: "high" });
        expect(request.max_tokens).toBe(THINKING_MAX_TOKENS);
        expect(request.tools).toEqual([expect.objectContaining({ name: "record_note" })]);
        expect(seedPrompt(2, "tool")).toContain("three-step arithmetic");
        expect(seedPrompt(2, "tool-retry")).toContain("different harmless arithmetic");
        expect(seedPrompt(2, "tool-retry")).not.toBe(seedPrompt(2, "tool"));
        expect(seedPrompt(2, "final")).toBe("Reply with exactly OK. Do not use a tool.");
        expect(seedPrompt(2, "final-retry")).not.toBe(seedPrompt(2, "final"));
        request.messages.push({ role: "user", content: [
            { type: "tool_result", tool_use_id: "note-2", content: "note-2" },
            { type: "text", text: seedPrompt(2, "final") },
        ] });
        replaceLastUserText(request, seedPrompt(2, "final-retry"));
        expect(request.messages.at(-1)!.content).toEqual([
            { type: "tool_result", tool_use_id: "note-2", content: "note-2" },
            { type: "text", text: seedPrompt(2, "final-retry") },
        ]);
    });

    it("continues seeding until the signed-block and completed-turn targets or eight rounds", () => {
        expect(shouldSeedTurn(0, 0, 1)).toBe(true);
        expect(shouldSeedTurn(MIN_SIGNED_BLOCKS, 1, 2)).toBe(true);
        expect(shouldSeedTurn(MIN_SIGNED_BLOCKS, 2, 3)).toBe(false);
        expect(shouldSeedTurn(MIN_SIGNED_BLOCKS - 1, 2, MAX_SEED_TURNS)).toBe(true);
        expect(shouldSeedTurn(MIN_SIGNED_BLOCKS - 1, 2, MAX_SEED_TURNS + 1)).toBe(false);
    });

    it("retries only a first refusal and never retries a second refusal", () => {
        expect(shouldRetryRefusal("refusal", false)).toBe(true);
        expect(shouldRetryRefusal("refusal", true)).toBe(false);
        expect(shouldRetryRefusal("end_turn", false)).toBe(false);
        expect(shouldRetryRefusal("tool_use", false)).toBe(false);
    });

    it("refuses insufficient or unsigned history before constructing variants", () => {
        const short = fixture();
        short.messages[7]!.content.shift();
        expect(() => requireSignedHistory(short)).toThrow("got 3");
        const unsigned = fixture();
        unsigned.messages[1]!.content[0]!.signature = "";
        expect(() => requireSignedHistory(unsigned)).toThrow("got 3");
        const oneRound = fixture();
        oneRound.messages[6]!.content = [];
        expect(() => requireSignedHistory(oneRound)).toThrow("Need at least 2 completed tool rounds");
    });
    it("constructs exact prefix, middle, suffix and full removals without changing other content", () => {
        const original = fixture();
        const rows = thinkingVariants(original);
        const expected: Record<string, string[]> = {
            control: ["s0", "s1", "s2", "s3"], "oldest-1": ["s1", "s2", "s3"],
            "oldest-2": ["s2", "s3"], "middle-kept": ["s0", "s2", "s3"],
            "middle-suffix-stripped": ["s0"], "all-stripped": [],
        };
        for (const row of rows.filter((r) => r.variant in expected)) {
            expect(signatures(row.request)).toEqual(expected[row.variant]!);
            expect(nonThinking(row.request)).toEqual(nonThinking(original));
            expect(row.request.system).toBe("fixed");
            expect(row.request.tools).toEqual(["echo"]);
        }
        expect(original).toEqual(fixture());
    });
    it("builds the complete common matrix for either model", () => {
        const names = thinkingVariants(fixture()).map((row) => row.variant);
        expect(names).toEqual([
            "control", "oldest-1", "oldest-2", "middle-kept", "middle-suffix-stripped", "all-stripped",
            "tool-result-edit-kept", "tool-result-edit-suffix-stripped", "tool-input-edit-kept",
            "tool-input-edit-suffix-stripped", "first-user-edit-kept", "first-user-edit-suffix-stripped", "cleared-text",
        ]);
    });
    it("edits tool inputs and results independently and strips only later signed blocks", () => {
        const rows = thinkingVariants(fixture());
        const inputKept = rows.find((r) => r.variant === "tool-input-edit-kept")!.request;
        const inputStripped = rows.find((r) => r.variant === "tool-input-edit-suffix-stripped")!.request;
        const resultKept = rows.find((r) => r.variant === "tool-result-edit-kept")!.request;
        const resultStripped = rows.find((r) => r.variant === "tool-result-edit-suffix-stripped")!.request;
        expect(signatures(inputKept)).toEqual(["s0", "s1", "s2", "s3"]);
        expect(signatures(inputStripped)).toEqual(["s0"]);
        expect(inputKept.messages[1]!.content[1]!.input).toEqual({ value: "original", note: "edited earlier record note input" });
        expect(inputKept.messages[2]!.content[0]!.content).toBe("original");
        expect(nonThinking(inputKept)).toEqual(nonThinking(inputStripped));
        expect(signatures(resultKept)).toEqual(["s0", "s1", "s2", "s3"]);
        expect(signatures(resultStripped)).toEqual(["s0"]);
        expect(resultKept.messages[1]!.content[1]!.input).toEqual({ value: "original" });
        expect(resultKept.messages[2]!.content[0]!.content).toBe("edited earlier record note result");
        expect(resultKept.messages[6]!.content[0]!.content).toBe("next");
        expect(nonThinking(resultKept)).toEqual(nonThinking(resultStripped));
    });

    it("restores the removed prefix in a copy after a signed block was generated without it", () => {
        const seed = fixture();
        const prefixRemoved = thinkingVariants(seed).find((row) => row.variant === "oldest-1")!.request;
        prefixRemoved.messages.push(
            { role: "assistant", content: [{ type: "thinking", thinking: "generated while absent", signature: "new-signature" }] },
            { role: "user", content: [{ type: "text", text: "restore check" }] },
        );
        const restored = restoreFirstSignedBlock(seed, prefixRemoved);
        expect(signatures(prefixRemoved)).toEqual(["s1", "s2", "s3", "new-signature"]);
        expect(signatures(restored)).toEqual(["s0", "s1", "s2", "s3", "new-signature"]);
        expect(restored.messages[1]!.content[0]).toEqual(seed.messages[1]!.content[0]);
        expect(signatures(seed)).toEqual(["s0", "s1", "s2", "s3"]);
    });
    it("re-renders the first user text, with all later thinking stripped only in its paired request", () => {
        const rows = thinkingVariants(fixture());
        const kept = rows.find((r) => r.variant === "first-user-edit-kept")!.request;
        const stripped = rows.find((r) => r.variant === "first-user-edit-suffix-stripped")!.request;
        expect(kept.messages[0]!.content[0]!.text).toBe("first user\nRendered context marker: m0 -> m1.");
        expect(signatures(kept)).toEqual(["s0", "s1", "s2", "s3"]);
        expect(signatures(stripped)).toEqual([]);
        expect(nonThinking(kept)).toEqual(nonThinking(stripped));
    });
    it("writes literal cleared text without replacing its original signature", () => {
        const row = thinkingVariants(fixture()).find((r) => r.variant === "cleared-text")!;
        expect(row.request.messages[1]!.content[0]).toEqual({ type: "thinking", thinking: "[cleared]", signature: "s0" });
        expect(row.request.messages.slice(2)).toEqual(fixture().messages.slice(2));
    });
});
