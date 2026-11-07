import { expect, it, spyOn } from "bun:test";
import * as logger from "../../shared/logger";
import {
    createFinalWireIncompleteLogger,
    incompleteWirePartFields,
    incompleteWireParts,
} from "./final-wire-completeness";
import { estimateFinalWireInputTokens } from "./final-wire-token-estimate";
import type { MessageLike } from "./tag-messages";

it.each([
    [null, ["part"]],
    [{ type: "text", id: "text-part" }, ["text"]],
    [{ type: "reasoning" }, ["text"]],
    [{ type: "thinking" }, ["thinking"]],
    [{ type: "redacted_thinking" }, ["data"]],
    [{ type: "tool", state: { output: "private output" } }, ["input"]],
    [{ type: "tool", state: { input: {} } }, ["result"]],
    [{ type: "tool-call" }, ["input"]],
    [{ type: "tool_use" }, ["input"]],
    [{ type: "tool-invocation" }, ["input", "result"]],
    [{ type: "tool-result" }, ["result"]],
    [{ type: "tool_result" }, ["result"]],
    [{ type: "file", url: "file:///private/attachment.pdf" }, ["url (data:image/)"]],
    [{ type: "media", data: "private content" }, ["supported type"]],
] as const)("names missing fields without changing the untrusted policy (%#)", (part, fields) => {
    expect(incompleteWirePartFields(part)).toEqual([...fields]);
    expect(
        estimateFinalWireInputTokens({
            messages: [{ info: { id: "m" }, parts: [part] }],
            systemPromptTokens: 100,
            toolDefinitionTokens: 0,
        }).trusted,
    ).toBe(false);
});

it.each([
    { type: "text", text: "" },
    { type: "reasoning", text: "" },
    { type: "thinking", thinking: "" },
    { type: "redacted_thinking", data: "" },
    { type: "unknown", ignored: true },
    { type: "step-start" },
    { type: "step-finish" },
    { type: "file", url: "data:image/png;base64,AA==" },
    { type: "tool", input: null, state: { error: "failed" } },
    { type: "tool-call", args: null },
    { type: "tool_use", input: {} },
    { type: "tool-invocation", args: {}, state: {} },
    { type: "tool-result", result: null },
    { type: "tool_result", content: "" },
])("keeps previously countable parts complete (%#)", (part) => {
    expect(incompleteWirePartFields(part)).toEqual([]);
    expect(
        estimateFinalWireInputTokens({
            messages: [{ info: { id: "m" }, parts: [part] }],
            systemPromptTokens: 100,
            toolDefinitionTokens: 0,
        }).trusted,
    ).toBe(true);
});

it("logs only incomplete part metadata once per pass, never content", () => {
    const messages: MessageLike[] = [
        {
            info: { id: "message-1", role: "assistant" },
            parts: [
                { type: "tool", id: "part-1", state: { output: "SECRET TOOL OUTPUT" } },
                { type: "file", id: "part-2", url: "file:///SECRET-PATH.pdf" },
                { type: "text", text: "SECRET CONVERSATION" },
            ],
        },
    ];
    expect(incompleteWireParts(messages)).toEqual([
        {
            messageId: "message-1",
            partId: "part-1",
            partIndex: 0,
            type: "tool",
            missingFields: ["input"],
        },
        {
            messageId: "message-1",
            partId: "part-2",
            partIndex: 1,
            type: "file",
            missingFields: ["url (data:image/)"],
        },
    ]);
    const log = spyOn(logger, "sessionLog").mockImplementation(() => {});
    try {
        const pass = createFinalWireIncompleteLogger("session");
        pass({ trusted: true }, messages);
        expect(log).not.toHaveBeenCalled();
        pass({ trusted: false }, messages);
        pass(undefined, messages);
        expect(log).toHaveBeenCalledTimes(1);
        const text = String(log.mock.calls[0]?.[1]);
        expect(text).toContain('"messageId":"message-1"');
        expect(text).toContain('"partId":"part-1"');
        expect(text).toContain('"missingFields":["input"]');
        expect(text).not.toContain("SECRET");
        createFinalWireIncompleteLogger("session")({ trusted: false }, messages);
        expect(log).toHaveBeenCalledTimes(2);
    } finally {
        log.mockRestore();
    }
});

it("reports absent ids by index without serializing malformed parts", () => {
    expect(
        incompleteWireParts([{ info: {}, parts: [undefined, { type: "audio", data: "SECRET" }] }]),
    ).toEqual([
        { messageId: null, partId: null, partIndex: 0, type: "unknown", missingFields: ["part"] },
        {
            messageId: null,
            partId: null,
            partIndex: 1,
            type: "audio",
            missingFields: ["supported type"],
        },
    ]);
});
