import { expect, test } from "bun:test";
import fixture from "../../../../../crates/mc-module/testdata/historian-tool-expansions.json";
import { MagicContextConfigSchema } from "../../config/schema/magic-context";
import { DEFAULT_TOOL_EXPANSIONS, expandToolPart } from "../../shared/historian-tool-expansions";
import { renderToolTemplate, toolTemplateError } from "../../shared/historian-tool-template";
import { renderVerboseRange } from "../../tools/ctx-expand/render";
import { readSessionChunk, withRawMessageProvider } from "./read-session-chunk";
import { estimateTokens } from "./read-session-formatting";

const expandTools = {
    peer_send: "PM to ${input.agent}: ${input.message}",
    ask: "Asked user: ${input.question} → ${output.answer}",
};

test("historian retains peer_send alongside assistant text", () => {
    const messages = [
        {
            ordinal: 1,
            id: "a1",
            role: "assistant",
            parts: [
                { type: "text", text: "Delegating the review." },
                {
                    type: "tool",
                    tool: "peer_send",
                    state: {
                        input: { agent: "Ada", message: "Check the parser." },
                        output: "sent",
                    },
                },
            ],
        },
    ];
    const chunk = withRawMessageProvider(
        "expansion",
        { readMessages: () => messages, getMessageCount: () => messages.length },
        () => readSessionChunk("expansion", 10_000, 1, undefined, { expandTools }),
    );
    expect(chunk.text).toBe("[1] A: Delegating the review. / TC: PM to Ada: Check the parser.");
});

test("shared golden covers every default's actual fields and result shape", () => {
    expect(fixture.defaults.map((c) => c.tool).sort()).toEqual(
        Object.keys(DEFAULT_TOOL_EXPANSIONS).sort(),
    );
    for (const c of fixture.defaults) {
        expect(
            expandToolPart({
                type: "tool",
                tool: c.tool,
                state: { input: c.input, output: c.output },
            }),
        ).toBe(c.expected);
    }
    for (const c of fixture.variants) {
        expect(expandToolPart({ type: "tool", tool: c.tool, state: { input: c.input } })).toBe(
            c.expected,
        );
    }
});

test("historian keeps long room posts and peer replies whole instead of host titles", () => {
    const body =
        fixture.longMessage.sentence.repeat(fixture.longMessage.count) + fixture.longMessage.tail;
    expect(body.length).toBeGreaterThan(1000);
    const parts = [
        {
            type: "tool",
            tool: "room",
            callID: "r",
            state: {
                input: { action: "post", room_id: "rm_review", text: body },
                title: "Room title…",
                metadata: { description: "Room description…" },
            },
        },
        {
            type: "tool",
            tool: "peer_send",
            callID: "p",
            state: {
                input: { reply_to_pmid: "pm_42", message: body },
                metadata: { description: "PM title…" },
            },
        },
        { type: "text", text: "Tail text." },
    ];
    const messages = [{ ordinal: 1, id: "a", role: "assistant", parts }];
    const original = JSON.stringify(messages);
    const chunk = withRawMessageProvider(
        "whole-post",
        { readMessages: () => messages, getMessageCount: () => 1 },
        () => readSessionChunk("whole-post", 10_000),
    );
    expect(chunk.text).toBe(
        `[1] A: TC: Room post rm_review: ${body} / TC: PM reply to pm_42: ${body} / Tail text.`,
    );
    expect(JSON.stringify(messages)).toBe(original);
});

test("verbose ctx_expand preserves legacy preview bytes and custom template limits", () => {
    const body = "word ".repeat(300);
    const part = {
        type: "tool",
        tool: "room",
        state: { input: { action: "post", room_id: "rm_review", text: body } },
    };
    const messages = [{ ordinal: 1, id: "a", role: "assistant", parts: [part] }];
    withRawMessageProvider(
        "legacy-preview",
        { readMessages: () => messages, getMessageCount: () => 1 },
        () => {
            const preview = renderVerboseRange("legacy-preview", 1, 1, 10_000);
            expect(preview.text).toContain(
                `    • tool room: Room post rm_review: ${"word ".repeat(80)}…`,
            );
            expect(preview.text).not.toContain("more characters]");
        },
    );
    expect(expandToolPart(part, { room: "${input.text}" }, true)).toBe(`${"word ".repeat(60)}…`);
    expect(expandToolPart(part, { room: "${input.text}" })).toBe(body);
});

test("shared golden templates cover arrays, caps, missing fields and newlines", () => {
    for (const c of fixture.templates) {
        const input =
            "repeatInput" in c
                ? { [c.repeatInput.field]: c.repeatInput.text.repeat(c.repeatInput.count) }
                : "repeatArray" in c
                  ? { [c.repeatArray.field]: [c.repeatArray.text.repeat(c.repeatArray.count)] }
                  : c.input;
        const expected =
            "expectedRepeat" in c
                ? c.expectedRepeat.text.repeat(c.expectedRepeat.count) + c.expectedRepeat.suffix
                : c.expected;
        expect(renderToolTemplate(c.template, input, "output" in c ? c.output : undefined)).toBe(
            expected,
        );
    }
});

test("invalid templates are config errors and never runtime historian failures", () => {
    for (const template of fixture.invalid) {
        expect(toolTemplateError(template)).toBeDefined();
        expect(
            MagicContextConfigSchema.safeParse({ historian: { expand_tools: { ask: template } } })
                .success,
        ).toBe(false);
        expect(renderToolTemplate(template, {})).toBeNull();
    }
    expect(
        MagicContextConfigSchema.safeParse({
            historian: { expand_tools: { ask: false, custom: '${input.ops.each("${op}")}' } },
        }).success,
    ).toBe(true);
});

test("shared golden chunk preserves part order, legacy noise behavior and expansion budget", () => {
    const messages = fixture.messages;
    withRawMessageProvider(
        "golden-expansion",
        { readMessages: () => messages, getMessageCount: () => messages.length },
        () => {
            const after = readSessionChunk("golden-expansion", 10_000);
            const before = readSessionChunk("golden-expansion", 10_000, 1, undefined, {
                expand: false,
            });
            expect(after.text).toBe(fixture.chunk);
            expect(before.text).toBe(fixture.legacyChunk);
            expect(after.tokenEstimate).toBeGreaterThan(before.tokenEstimate);
            const budget = before.tokenEstimate;
            expect(readSessionChunk("golden-expansion", budget).endIndex).toBeLessThan(
                after.endIndex,
            );
            const verbose = renderVerboseRange("golden-expansion", 1, 3, 10_000);
            expect(verbose.text).toContain("PM to Ada: Check the parser.");
            expect(verbose.text).toContain("→ Strict");
            console.log(
                `golden chunk tokens: ${estimateTokens(before.text)} before / ${estimateTokens(after.text)} after`,
            );
        },
    );
});

test("false restores a default's legacy summary and exact names do not alias", () => {
    expect(
        expandToolPart(
            { type: "tool", tool: "ask", state: { input: { question: "mode" } } },
            { ask: false },
        ),
    ).toBeNull();
    expect(
        expandToolPart({
            type: "tool",
            tool: "functions.ask",
            state: { input: { question: "mode" } },
        }),
    ).toBeNull();
});

test("split Pi invocation gets its answer once without changing raw messages", () => {
    const messages = [
        {
            ordinal: 1,
            id: "a",
            role: "assistant",
            parts: [
                {
                    type: "tool",
                    tool: "ask",
                    callID: "q",
                    state: { input: { question: "Which mode?" } },
                },
            ],
        },
        {
            ordinal: 2,
            id: "r",
            role: "user",
            parts: [{ type: "tool", tool: "ask", callID: "q", state: { output: "Strict" } }],
        },
        { ordinal: 3, id: "u", role: "user", parts: [{ type: "text", text: "Continue" }] },
    ];
    const original = JSON.stringify(messages);
    withRawMessageProvider(
        "split-expansion",
        { readMessages: () => messages, getMessageCount: () => messages.length },
        () => {
            const chunk = readSessionChunk("split-expansion", 10_000);
            expect(chunk.text.match(/→ Strict/g)?.length).toBe(1);
            expect(chunk.text).toContain("Asked: Which mode?");
        },
    );
    expect(JSON.stringify(messages)).toBe(original);
});

test("historian includes the ask answer from structured result text", () => {
    const messages = [
        {
            ordinal: 1,
            id: "a1",
            role: "assistant",
            parts: [
                {
                    type: "tool",
                    tool: "ask",
                    state: { input: { question: "Which mode?" }, output: '{"answer":"Strict"}' },
                },
            ],
        },
    ];
    const chunk = withRawMessageProvider(
        "expansion",
        { readMessages: () => messages, getMessageCount: () => messages.length },
        () => readSessionChunk("expansion", 10_000, 1, undefined, { expandTools }),
    );
    expect(chunk.text).toBe("[1] A: TC: Asked user: Which mode? → Strict");
});
