/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import type { MessageLike } from "../../hooks/magic-context/tag-messages";
import {
    createToolDropTarget,
    extractToolCallObservation,
    partHasCompletedResult,
    type ToolCallIndex,
    ToolMutationBatch,
} from "../../hooks/magic-context/tool-drop-target";
import { adaptPayload } from "./payload";
import type { SessionContext, V2Message } from "./types";

// Content part types the OpenCode 2 request schema accepts (LLM.Content.*).
const V2_CONTENT_TYPES = new Set([
    "text",
    "media",
    "tool-call",
    "tool-result",
    "reasoning",
    "compaction",
    "effort",
]);

function draft(messages: V2Message[]): SessionContext {
    return {
        sessionID: "ses-1",
        model: { providerID: "provider", id: "model" },
        agent: "build",
        messages,
        system: [],
        tools: {},
        options: {},
    };
}

function toolTurn(id: string, callID: string, name: string, output: string): V2Message[] {
    return [
        {
            id,
            role: "assistant",
            content: [
                { type: "text", text: `running ${name}` },
                { type: "tool-call", id: callID, name, input: { command: `${name} --all` } },
            ],
        },
        {
            role: "tool",
            content: [
                { type: "tool-result", id: callID, name, result: { type: "text", value: output } },
            ],
        },
    ];
}

// Same shape as tool-drop-target.test.ts: index the adapted parts per owning message.
function indexMessage(message: MessageLike): ToolCallIndex {
    const index: ToolCallIndex = new Map();
    for (const part of message.parts) {
        const observation = extractToolCallObservation(part);
        if (!observation) continue;
        const entry = index.get(observation.callId) ?? { occurrences: [], hasResult: false };
        entry.occurrences.push({ message, part, kind: observation.kind });
        if (observation.kind === "result" && partHasCompletedResult(part)) entry.hasResult = true;
        index.set(observation.callId, entry);
    }
    return index;
}

function nonV2Parts(messages: V2Message[]): Array<Record<string, unknown>> {
    return messages.flatMap((message) =>
        message.content.filter((part) => !V2_CONTENT_TYPES.has(String(part.type))),
    );
}

function callsAndResults(messages: V2Message[]) {
    const parts = messages.flatMap((message) => message.content);
    return {
        calls: parts.filter((part) => part.type === "tool-call"),
        results: parts.filter((part) => part.type === "tool-result"),
    };
}

describe("adaptPayload", () => {
    describe("#given a tool arc that the drop pipeline truncates", () => {
        it("#then commit() maps the cloned tool part back to a V2 tool-call/tool-result pair", () => {
            const context = draft(toolTurn("msg-1", "call-1", "shell", "a very long output"));
            const payload = adaptPayload(context);
            const owner = payload.messages[0];
            const target = createToolDropTarget(
                "call-1",
                [],
                indexMessage(owner),
                new ToolMutationBatch(payload.messages),
                7,
            );

            expect(target.truncate()).toBe("truncated");
            payload.commit();

            expect(nonV2Parts(context.messages)).toEqual([]);
            const { calls, results } = callsAndResults(context.messages);
            expect(calls).toEqual([
                {
                    type: "tool-call",
                    id: "call-1",
                    name: "shell",
                    input: { dropped: "[dropped §7§]" },
                },
            ]);
            expect(results).toHaveLength(1);
            expect(results[0]).toMatchObject({
                type: "tool-result",
                id: "call-1",
                result: { type: "text", value: "[dropped §7§]" },
            });
            // The result stays in its own tool-role carrier after the assistant row.
            expect(context.messages.map((message) => message.role)).toEqual(["assistant", "tool"]);
        });
    });

    describe("#given a tool arc that the pipeline edit-marks", () => {
        it("#then commit() still emits V2 parts for the cloned part", () => {
            const context = draft(toolTurn("msg-1", "call-1", "edit", "applied"));
            const payload = adaptPayload(context);
            const target = createToolDropTarget(
                "call-1",
                [],
                indexMessage(payload.messages[0]),
                new ToolMutationBatch(payload.messages),
                9,
            );

            expect(target.editMarker()).toBe("truncated");
            payload.commit();

            expect(nonV2Parts(context.messages)).toEqual([]);
            const { results } = callsAndResults(context.messages);
            expect(results[0]).toMatchObject({ result: { type: "text", value: "[dropped §9§]" } });
        });
    });

    describe("#given two assistant turns that reuse one callID", () => {
        it("#then a truncated clone in the first turn keeps the first turn's call", () => {
            const context = draft([
                ...toolTurn("msg-1", "call-1", "first_tool", "first output"),
                ...toolTurn("msg-2", "call-1", "second_tool", "second output"),
            ]);
            const payload = adaptPayload(context);
            const first = payload.messages[0];
            const target = createToolDropTarget(
                "call-1",
                [],
                indexMessage(first),
                new ToolMutationBatch(payload.messages),
                3,
            );

            expect(target.truncate()).toBe("truncated");
            payload.commit();

            expect(nonV2Parts(context.messages)).toEqual([]);
            const { calls } = callsAndResults(context.messages);
            expect(calls.map((call) => [call.name, call.input])).toEqual([
                ["first_tool", { dropped: "[dropped §3§]" }],
                ["second_tool", { command: "second_tool --all" }],
            ]);
        });
    });

    describe("#given a later pass that replaces the owning message with a copy", () => {
        it("#then commit() still maps the cloned part and keeps the host message", () => {
            const context = draft(toolTurn("msg-1", "call-1", "shell", "a very long output"));
            const payload = adaptPayload(context);
            const target = createToolDropTarget(
                "call-1",
                [],
                indexMessage(payload.messages[0]),
                new ToolMutationBatch(payload.messages),
                5,
            );
            expect(target.truncate()).toBe("truncated");
            // strip-content's trailing-blank normalization copies a message (and its parts
            // array) before splicing, replacing the object the adapter mapped.
            const owner = payload.messages[0];
            payload.messages[0] = { ...owner, parts: [...owner.parts] };
            payload.commit();

            expect(nonV2Parts(context.messages)).toEqual([]);
            expect(context.messages.map((message) => [message.id, message.role])).toEqual([
                ["msg-1", "assistant"],
                [undefined, "tool"],
            ]);
            const { calls, results } = callsAndResults(context.messages);
            expect(calls[0]).toMatchObject({ id: "call-1", input: { dropped: "[dropped §5§]" } });
            expect(results[0]).toMatchObject({ result: { type: "text", value: "[dropped §5§]" } });
        });
    });

    describe("#given no pipeline changes", () => {
        it("#then commit() round-trips the host messages", () => {
            const original = toolTurn("msg-1", "call-1", "shell", "output");
            const context = draft(structuredClone(original));
            adaptPayload(context).commit();
            expect(context.messages).toEqual(original);
        });
    });
});
