/// <reference types="bun-types" />

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { MessageLike, ThinkingLikePart } from "./tag-messages";
import {
    createToolDropTarget,
    extractToolCallObservation,
    type ToolCallIndex,
    ToolMutationBatch,
} from "./tool-drop-target";

function message(id: string, role: string, parts: unknown[]): MessageLike {
    return {
        info: { id, role, sessionID: "ses-1" },
        parts,
    };
}

function hasCall(messages: MessageLike[], callId: string): boolean {
    for (const msg of messages) {
        for (const part of msg.parts) {
            const observation = extractToolCallObservation(part);
            if (observation?.callId === callId) {
                return true;
            }
        }
    }

    return false;
}

function buildIndex(messages: MessageLike[]): ToolCallIndex {
    const index: ToolCallIndex = new Map();
    for (const msg of messages) {
        for (const part of msg.parts) {
            const observation = extractToolCallObservation(part);
            if (observation) {
                const entry = index.get(observation.callId) ?? {
                    occurrences: [],
                    hasResult: false,
                };
                entry.occurrences.push({ message: msg, part, kind: observation.kind });
                if (observation.kind === "result") entry.hasResult = true;
                index.set(observation.callId, entry);
            }
        }
    }
    return index;
}

describe("tool-drop-target", () => {
    let buildOutput: ReturnType<typeof mock<(suffix: string) => string>>;

    beforeEach(() => {
        buildOutput = mock((suffix: string) => `output-${suffix}`);
    });

    describe("extractToolCallObservation", () => {
        describe("#given supported and unsupported tool part shapes", () => {
            describe("#when extracting tool call observations", () => {
                it("#then it classifies invocation/result parts and ignores invalid shapes", () => {
                    expect(extractToolCallObservation({ type: "tool", callID: "call-a" })).toEqual({
                        callId: "call-a",
                        kind: "result",
                    });
                    expect(
                        extractToolCallObservation({ type: "tool-invocation", callID: "call-b" }),
                    ).toEqual({
                        callId: "call-b",
                        kind: "invocation",
                    });
                    expect(extractToolCallObservation({ type: "tool_use", id: "call-c" })).toEqual({
                        callId: "call-c",
                        kind: "invocation",
                    });
                    expect(
                        extractToolCallObservation({ type: "tool_result", tool_use_id: "call-d" }),
                    ).toEqual({
                        callId: "call-d",
                        kind: "result",
                    });
                    expect(
                        extractToolCallObservation({ type: "tool_result", tool_use_id: "" }),
                    ).toBeNull();
                    expect(extractToolCallObservation({ type: "text", text: "plain" })).toBeNull();
                });
            });
        });
    });

    describe("createToolDropTarget", () => {
        describe("#given a complete invocation/result tool pair", () => {
            describe("#when dropping the call", () => {
                it("#then it marks for removal, and finalize removes parts, prunes empty wrappers, and clears thinking", () => {
                    const messages: MessageLike[] = [
                        message("m-inv", "assistant", [
                            { type: "tool-invocation", callID: "call-1" },
                        ]),
                        message("m-tool", "tool", [
                            {
                                type: "tool",
                                callID: "call-1",
                                state: { output: buildOutput("tool") },
                            },
                        ]),
                        message("m-wrapper", "assistant", [
                            { type: "step-start", snapshot: "snap-1" },
                            { type: "tool_use", id: "call-1" },
                            {
                                type: "tool_result",
                                tool_use_id: "call-1",
                                content: buildOutput("result"),
                            },
                            { type: "step-finish", reason: "tool-calls" },
                        ]),
                        message("m-keep", "assistant", [{ type: "text", text: "keep me" }]),
                    ];
                    const thinkingParts: ThinkingLikePart[] = [
                        { type: "thinking", thinking: "private" },
                        { type: "reasoning", text: "trace" },
                    ];
                    const index = buildIndex(messages);
                    const batch = new ToolMutationBatch(messages);

                    const target = createToolDropTarget("call-1", thinkingParts, index, batch);
                    const result = target.drop();

                    expect(result).toBe("removed");
                    expect(buildOutput).toHaveBeenCalledTimes(2);

                    batch.finalize();

                    expect(hasCall(messages, "call-1")).toBe(false);
                    expect(messages).toHaveLength(1);
                    expect(messages[0]?.info.id).toBe("m-keep");
                    expect(thinkingParts[0]?.thinking).toBe("[cleared]");
                    expect(thinkingParts[1]?.text).toBe("[cleared]");
                });
            });
        });

        describe("#given only a tool invocation without any result", () => {
            describe("#when dropping the call", () => {
                it("#then it reports incomplete and leaves messages unchanged", () => {
                    const messages: MessageLike[] = [
                        message("m-inv", "assistant", [
                            { type: "tool-invocation", callID: "call-orphan" },
                        ]),
                    ];
                    const thinkingParts: ThinkingLikePart[] = [
                        { type: "thinking", thinking: "keep" },
                    ];
                    const index = buildIndex(messages);
                    const batch = new ToolMutationBatch(messages);

                    const target = createToolDropTarget("call-orphan", thinkingParts, index, batch);
                    const result = target.drop();

                    expect(result).toBe("incomplete");
                    expect(hasCall(messages, "call-orphan")).toBe(true);
                    expect(thinkingParts[0]?.thinking).toBe("keep");
                });
            });
        });

        describe("#given no matching tool call id exists", () => {
            describe("#when dropping the call", () => {
                it("#then it reports absent without mutation", () => {
                    const messages: MessageLike[] = [
                        message("m-other", "assistant", [
                            { type: "tool-invocation", callID: "call-other" },
                        ]),
                    ];
                    const thinkingParts: ThinkingLikePart[] = [
                        { type: "thinking", thinking: "unchanged" },
                    ];
                    const index: ToolCallIndex = new Map();
                    const batch = new ToolMutationBatch(messages);

                    const target = createToolDropTarget(
                        "call-missing",
                        thinkingParts,
                        index,
                        batch,
                    );
                    const result = target.drop();

                    expect(result).toBe("absent");
                    expect(hasCall(messages, "call-other")).toBe(true);
                    expect(thinkingParts[0]?.thinking).toBe("unchanged");
                });
            });
        });

        describe("#given a complete tool pair with both tool and tool_result outputs", () => {
            describe("#when setContent is called", () => {
                it("#then it updates only result content and supports dropped-content removal", () => {
                    const toolResultPart = {
                        type: "tool_result",
                        tool_use_id: "call-2",
                        content: "old-result",
                    };
                    const toolPart = {
                        type: "tool",
                        callID: "call-2",
                        state: { output: "old-tool" },
                    };
                    const messages: MessageLike[] = [
                        message("m-inv", "assistant", [{ type: "tool_use", id: "call-2" }]),
                        message("m-res", "tool", [toolPart]),
                        message("m-res-2", "assistant", [toolResultPart]),
                    ];
                    const thinkingParts: ThinkingLikePart[] = [
                        { type: "thinking", thinking: "to clear" },
                    ];
                    const index = buildIndex(messages);
                    const batch = new ToolMutationBatch(messages);
                    const target = createToolDropTarget("call-2", thinkingParts, index, batch);

                    target.setContent("replacement-content");

                    expect(toolPart.state.output).toBe("replacement-content");
                    expect(toolResultPart.content).toBe("replacement-content");
                    expect(hasCall(messages, "call-2")).toBe(true);

                    target.setContent("[dropped §2§]");
                    batch.finalize();

                    expect(hasCall(messages, "call-2")).toBe(false);
                    expect(thinkingParts[0]?.thinking).toBe("[cleared]");
                });
            });
        });

        describe("#given drop is called twice on the same callId", () => {
            describe("#when the second drop runs", () => {
                it("#then it returns absent (idempotent)", () => {
                    const messages: MessageLike[] = [
                        message("m-inv", "assistant", [
                            { type: "tool-invocation", callID: "call-1" },
                        ]),
                        message("m-tool", "tool", [
                            { type: "tool", callID: "call-1", state: { output: "out" } },
                        ]),
                    ];
                    const index = buildIndex(messages);
                    const batch = new ToolMutationBatch(messages);
                    const target = createToolDropTarget("call-1", [], index, batch);

                    expect(target.drop()).toBe("removed");
                    expect(target.drop()).toBe("absent");
                });
            });
        });

        describe("#given a complete tool pair with structured input", () => {
            describe("#when truncate is called", () => {
                it("#then it keeps small inputs intact while truncating result content", () => {
                    const toolResultPart = {
                        type: "tool_result",
                        tool_use_id: "call-3",
                        content: "old-result",
                    };
                    const toolPart = {
                        type: "tool",
                        callID: "call-3",
                        state: {
                            input: {
                                query: "abcdef",
                                short: "abc",
                                files: ["a", "b"],
                                metadata: { nested: true },
                                exact: true,
                                limit: 2,
                            },
                            output: "old-tool",
                        },
                    };
                    const messages: MessageLike[] = [
                        message("m-inv", "assistant", [{ type: "tool_use", id: "call-3" }]),
                        message("m-res", "tool", [toolPart]),
                        message("m-res-2", "assistant", [toolResultPart]),
                    ];
                    const thinkingParts: ThinkingLikePart[] = [
                        { type: "thinking", thinking: "to clear" },
                        { type: "reasoning", text: "trace" },
                    ];
                    const index = buildIndex(messages);
                    const batch = new ToolMutationBatch(messages);
                    const target = createToolDropTarget("call-3", thinkingParts, index, batch);

                    expect(target.truncate()).toBe("truncated");

                    batch.finalize();

                    expect(hasCall(messages, "call-3")).toBe(true);
                    expect(messages).toHaveLength(3);
                    expect(toolPart.state as Record<string, unknown>).toEqual({
                        input: {
                            query: "abcdef",
                            short: "abc",
                            files: ["a", "b"],
                            metadata: { nested: true },
                            exact: true,
                            limit: 2,
                        },
                        output: "[truncated]",
                    });
                    expect(toolResultPart.content).toBe("[truncated]");
                    expect(thinkingParts[0]?.thinking).toBe("[cleared]");
                    expect(thinkingParts[1]?.text).toBe("[cleared]");
                });

                it("#then truncates large inputs before keeping the tool structure", () => {
                    const largeQuery = "x".repeat(600);
                    const toolPart = {
                        type: "tool",
                        callID: "call-4",
                        state: {
                            input: {
                                query: largeQuery,
                                files: ["a", "b"],
                                metadata: { nested: true },
                            },
                            output: "old-tool",
                        },
                    };
                    const messages: MessageLike[] = [
                        message("m-inv", "assistant", [
                            {
                                type: "tool-invocation",
                                callID: "call-4",
                                args: { query: largeQuery },
                            },
                        ]),
                        message("m-res", "tool", [toolPart]),
                    ];
                    const index = buildIndex(messages);
                    const batch = new ToolMutationBatch(messages);
                    const target = createToolDropTarget("call-4", [], index, batch);

                    expect(target.truncate()).toBe("truncated");

                    expect(toolPart.state as Record<string, unknown>).toEqual({
                        input: {
                            query: "xxxxx...[truncated]",
                            files: "[2 items]",
                            metadata: "[object]",
                        },
                        output: "[truncated]",
                    });
                });
            });
        });
    });
});
