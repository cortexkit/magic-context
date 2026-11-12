/// <reference types="bun-types" />

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { isNeutralizedReasoningPart } from "./sentinel";
import type { MessageLike, ThinkingLikePart } from "./tag-messages";
import {
    createToolDropTarget,
    extractToolCallObservation,
    hasMeaningfulPart,
    partHasCompletedResult,
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
                // Mirror production (tag-messages.ts): an OpenCode `{ type: "tool" }`
                // part is a "result" observation by type even while pending, so gate
                // hasResult on an actual completed result.
                if (observation.kind === "result" && partHasCompletedResult(part))
                    entry.hasResult = true;
                index.set(observation.callId, entry);
            }
        }
    }
    return index;
}

describe("tool-drop-target", () => {
    it("compacts many removed wrappers in place while preserving survivor references and order", () => {
        const messages: MessageLike[] = Array.from({ length: 6000 }, (_, index) => ({
            info: { id: `compact-${index}`, role: "user" },
            parts: [{ type: "text", text: `content-${index}` }],
        }));
        const survivors = messages.filter((_, index) => index % 2 === 1);
        const original = messages;
        const batch = new ToolMutationBatch(messages, true);
        for (let index = 0; index < messages.length; index += 2) {
            batch.markForRemoval({
                message: messages[index],
                part: messages[index].parts[0],
                kind: "result",
            });
        }
        batch.finalize();
        expect(messages).toBe(original);
        expect(messages).toEqual(survivors);
        expect(messages[0]).toBe(survivors[0]);
        expect(messages[messages.length - 1]).toBe(survivors[survivors.length - 1]);
        batch.finalize();
        expect(messages).toEqual(survivors);
    });

    it("strips attachments on a newly selected skeleton but preserves legacy replay", () => {
        const attachment = { type: "file", mime: "image/png", url: "data:image/png;base64,abcd" };
        const original = {
            type: "tool",
            callID: "c1",
            state: { input: { path: "a" }, output: "large output", attachments: [attachment] },
        };
        const row = message("m1", "assistant", [original]);
        const target = createToolDropTarget(
            "c1",
            [],
            buildIndex([row]),
            new ToolMutationBatch([row]),
            7,
        );
        expect(target.hasAttachments()).toBe(true);
        expect(target.skeletonStripped()).toBe("truncated");
        expect((row.parts[0] as typeof original).state.attachments).toEqual([]);
        expect(original.state.attachments).toEqual([attachment]);
        const replay = message("m1", "assistant", [structuredClone(original)]);
        createToolDropTarget(
            "c1",
            [],
            buildIndex([replay]),
            new ToolMutationBatch([replay]),
            7,
        ).skeletonReal();
        expect((replay.parts[0] as typeof original).state.attachments).toEqual([attachment]);
    });
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

    describe("partHasCompletedResult", () => {
        it("counts a completed OpenCode tool part (output string) as closed", () => {
            expect(
                partHasCompletedResult({ type: "tool", callID: "c", state: { output: "done" } }),
            ).toBe(true);
        });

        it("counts an errored OpenCode tool part (status error, no output) as closed", () => {
            expect(
                partHasCompletedResult({
                    type: "tool",
                    callID: "c",
                    state: { status: "error", error: "boom", input: { content: "x".repeat(600) } },
                }),
            ).toBe(true);
        });

        it("keeps a running OpenCode tool part (no output, no error) open", () => {
            expect(
                partHasCompletedResult({
                    type: "tool",
                    callID: "c",
                    state: { status: "running", input: { prompt: "p" } },
                }),
            ).toBe(false);
        });

        it("keeps a pending OpenCode tool part open", () => {
            expect(
                partHasCompletedResult({ type: "tool", callID: "c", state: { status: "pending" } }),
            ).toBe(false);
        });

        it("counts an Anthropic tool_result part as closed", () => {
            expect(partHasCompletedResult({ type: "tool_result", tool_use_id: "c" })).toBe(true);
        });

        it("excludes invocation-shaped parts and non-records", () => {
            expect(partHasCompletedResult({ type: "tool-invocation", callID: "c" })).toBe(false);
            expect(partHasCompletedResult({ type: "tool_use", id: "c" })).toBe(false);
            expect(partHasCompletedResult(null)).toBe(false);
            expect(partHasCompletedResult({ type: "tool" })).toBe(false);
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

                    const target = createToolDropTarget("call-1", thinkingParts, index, batch, 1);
                    const result = target.drop();

                    expect(result).toBe("removed");
                    expect(buildOutput).toHaveBeenCalledTimes(2);

                    batch.finalize();

                    expect(hasCall(messages, "call-1")).toBe(false);
                    expect(messages).toHaveLength(1);
                    expect(messages[0]?.info.id).toBe("m-keep");
                    // A drop takes the reasoning off the wire whole instead of writing "[cleared]" into it.
                    expect(thinkingParts[0]).toEqual({ type: "text", text: "" });
                    expect(isNeutralizedReasoningPart(thinkingParts[0])).toBe(true);
                    // A drop takes the reasoning off the wire whole instead of writing "[cleared]" into it.
                    expect(thinkingParts[1]).toEqual({ type: "text", text: "" });
                    expect(isNeutralizedReasoningPart(thinkingParts[1])).toBe(true);
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

                    const target = createToolDropTarget(
                        "call-orphan",
                        thinkingParts,
                        index,
                        batch,
                        2,
                    );
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
                        3,
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
                        // A later prompt, so this call does not end the conversation
                        // (drop() keeps that one as a skeleton instead of removing it).
                        message("m-next", "user", [{ type: "text", text: "next prompt" }]),
                    ];
                    const thinkingParts: ThinkingLikePart[] = [
                        { type: "thinking", thinking: "to clear" },
                    ];
                    const index = buildIndex(messages);
                    const batch = new ToolMutationBatch(messages);
                    const target = createToolDropTarget("call-2", thinkingParts, index, batch, 4);

                    target.setContent("replacement-content");

                    expect(toolPart.state.output).toBe("replacement-content");
                    expect(toolResultPart.content).toBe("replacement-content");
                    expect(hasCall(messages, "call-2")).toBe(true);

                    target.setContent("[dropped §2§]");
                    batch.finalize();

                    expect(hasCall(messages, "call-2")).toBe(false);
                    // A drop takes the reasoning off the wire whole instead of writing "[cleared]" into it.
                    expect(thinkingParts[0]).toEqual({ type: "text", text: "" });
                    expect(isNeutralizedReasoningPart(thinkingParts[0])).toBe(true);
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
                        // A later prompt, so this call does not end the conversation.
                        message("m-next", "user", [{ type: "text", text: "next prompt" }]),
                    ];
                    const index = buildIndex(messages);
                    const batch = new ToolMutationBatch(messages);
                    const target = createToolDropTarget("call-1", [], index, batch, 5);

                    expect(target.drop()).toBe("removed");
                    expect(target.drop()).toBe("absent");
                });
            });
        });

        describe("#given the call whose result ends the conversation", () => {
            describe("#when dropping it", () => {
                it("#then it keeps a skeleton so the request still ends with a tool result", () => {
                    const toolPart = {
                        type: "tool",
                        tool: "bash",
                        callID: "call-last",
                        state: { status: "completed", input: { command: "cat f" }, output: "big" },
                    };
                    const messages: MessageLike[] = [
                        message("m-user", "user", [{ type: "text", text: "go" }]),
                        message("m-last", "assistant", [
                            { type: "step-start" },
                            { type: "text", text: "Reading." },
                            toolPart,
                            { type: "step-finish", reason: "tool-calls" },
                        ]),
                        // A blank pending assistant shell is not what the request ends with.
                        message("m-shell", "assistant", [{ type: "step-start" }]),
                    ];
                    const index: ToolCallIndex = new Map([
                        [
                            "call-last",
                            {
                                occurrences: [
                                    { message: messages[1]!, part: toolPart, kind: "result" },
                                ],
                                hasResult: true,
                            },
                        ],
                    ]);
                    const batch = new ToolMutationBatch(messages);
                    const target = createToolDropTarget("call-last", [], index, batch, 9);

                    expect(target.drop()).toBe("truncated");
                    batch.finalize();

                    const kept = messages[1]?.parts.find(
                        (part) => (part as { type?: string }).type === "tool",
                    ) as { callID: string; state: { output: string } } | undefined;
                    expect(kept?.callID).toBe("call-last");
                    expect(kept?.state.output).toBe("[dropped \u00a79\u00a7]");
                });
            });
        });

        describe("#given a complete tool pair with structured input", () => {
            describe("#when truncate is called", () => {
                it("#then it replaces small inputs while truncating result content", () => {
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
                    const target = createToolDropTarget("call-3", thinkingParts, index, batch, 7);

                    expect(target.truncate()).toBe("truncated");

                    batch.finalize();

                    expect(hasCall(messages, "call-3")).toBe(true);
                    expect(messages).toHaveLength(3);

                    // The wire copies now in the message array carry the sentinel...
                    const wireToolPart = messages[1]?.parts[0] as {
                        state: Record<string, unknown>;
                    };
                    expect(wireToolPart.state).toEqual({
                        input: { dropped: "[dropped \u00a77\u00a7]" },
                        output: "[dropped \u00a77\u00a7]",
                    });
                    const wireResultPart = messages[2]?.parts[0] as { content: string };
                    expect(wireResultPart.content).toBe("[dropped \u00a77\u00a7]");

                    // ...while the LIVE part objects OpenCode handed us stay
                    // byte-identical: the clamp swaps in a clone and never touches
                    // the originals (mutation-safety guarantee).
                    expect(toolPart.state as Record<string, unknown>).toEqual({
                        input: {
                            query: "abcdef",
                            short: "abc",
                            files: ["a", "b"],
                            metadata: { nested: true },
                            exact: true,
                            limit: 2,
                        },
                        output: "old-tool",
                    });
                    expect(toolResultPart.content).toBe("old-result");
                    expect(wireToolPart).not.toBe(toolPart);
                    expect(wireResultPart).not.toBe(toolResultPart);
                    // A drop takes the reasoning off the wire whole instead of writing "[cleared]" into it.
                    expect(thinkingParts[0]).toEqual({ type: "text", text: "" });
                    expect(isNeutralizedReasoningPart(thinkingParts[0])).toBe(true);
                    // A drop takes the reasoning off the wire whole instead of writing "[cleared]" into it.
                    expect(thinkingParts[1]).toEqual({ type: "text", text: "" });
                    expect(isNeutralizedReasoningPart(thinkingParts[1])).toBe(true);
                });

                it("#then replaces reporter-shaped inputs with one non-executable marker", () => {
                    const sentinel = "[dropped §431§]";
                    const cases = [
                        {
                            tool: "bash",
                            input: { command: `which ${"x".repeat(700)}` },
                            legacyFragment: "which...[truncated]",
                            realKeys: ["command"],
                        },
                        {
                            tool: "edit",
                            input: {
                                filePath: "/tmp/example.ts",
                                oldString: `const ${"x".repeat(700)}`,
                                newString: `const ${"y".repeat(700)}`,
                            },
                            legacyFragment: "const...[truncated]",
                            realKeys: ["filePath", "oldString", "newString"],
                        },
                        {
                            tool: "write",
                            input: {
                                filePath: `/tmp/${"x".repeat(700)}`,
                                content: "payload",
                            },
                            legacyFragment: "/tmp/...[truncated]",
                            realKeys: ["filePath", "content"],
                        },
                        {
                            tool: "ctx_memory",
                            input: {
                                action: "write",
                                category: "ARCHITECTURE",
                                content: `write${"x".repeat(700)}`,
                            },
                            legacyFragment: "write...[truncated]",
                            realKeys: ["action", "category", "content"],
                        },
                    ];

                    for (const [index, testCase] of cases.entries()) {
                        const callId = `reporter-${testCase.tool}`;
                        const toolPart = {
                            type: "tool",
                            tool: testCase.tool,
                            callID: callId,
                            state: {
                                status: "completed",
                                input: testCase.input,
                                output: "completed",
                            },
                        };
                        const messages: MessageLike[] = [
                            message(`m-${index}`, "assistant", [toolPart]),
                        ];
                        const target = createToolDropTarget(
                            callId,
                            [],
                            buildIndex(messages),
                            new ToolMutationBatch(messages),
                            431,
                        );

                        expect(target.truncate()).toBe("truncated");
                        const wire = messages[0]?.parts[0] as {
                            state: { input: Record<string, unknown>; output: string };
                        };
                        expect(wire.state.input).toEqual({ dropped: sentinel });
                        expect(Object.keys(wire.state.input)).toEqual(["dropped"]);
                        for (const key of testCase.realKeys) {
                            expect(wire.state.input).not.toHaveProperty(key);
                        }
                        const serialized = JSON.stringify(wire.state.input);
                        expect(serialized).not.toContain("...[truncated]");
                        expect(serialized).not.toContain(testCase.legacyFragment);
                    }
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
                    const target = createToolDropTarget("call-4", [], index, batch, 9);

                    expect(target.truncate()).toBe("truncated");

                    // The wire copy now in the message array carries the clamp...
                    const wireToolPart = messages[1]?.parts[0] as {
                        state: Record<string, unknown>;
                    };
                    expect(wireToolPart.state).toEqual({
                        input: { dropped: "[dropped \u00a79\u00a7]" },
                        output: "[dropped \u00a79\u00a7]",
                    });

                    // ...while the LIVE part object stays byte-identical (long
                    // prompt intact) so a still-executing tool is never corrupted.
                    expect(toolPart.state as Record<string, unknown>).toEqual({
                        input: {
                            query: largeQuery,
                            files: ["a", "b"],
                            metadata: { nested: true },
                        },
                        output: "old-tool",
                    });
                    expect(wireToolPart).not.toBe(toolPart);
                });
            });
        });

        describe("#given a pending/running OpenCode tool part (no result output yet)", () => {
            describe("#when any drop/clamp selector runs", () => {
                it("#then it is treated as an open arc: never targeted and left byte-identical", () => {
                    const longPrompt = `Fix the auth bug and add coverage. ${"x".repeat(600)}`;
                    const taskPart = {
                        type: "tool",
                        tool: "task",
                        callID: "call-task",
                        state: {
                            status: "running",
                            input: { prompt: longPrompt, subagent_type: "mason" },
                        },
                    };
                    const pristine = JSON.stringify(taskPart);
                    const messages: MessageLike[] = [message("m-task", "assistant", [taskPart])];
                    const index = buildIndex(messages);
                    const batch = new ToolMutationBatch(messages);
                    const target = createToolDropTarget("call-task", [], index, batch, 11);

                    // Open arc (invocation with no completed result) is excluded
                    // from EVERY selector: canDrop, drop, truncate, editMarker.
                    expect(target.canDrop()).toBe(false);
                    expect(target.truncate()).toBe("incomplete");
                    expect(target.drop()).toBe("incomplete");
                    expect(target.editMarker()).toBe("incomplete");

                    // The live part object is byte-identical and still the same
                    // reference in the wire array.
                    expect(JSON.stringify(taskPart)).toBe(pristine);
                    expect(messages[0]?.parts[0]).toBe(taskPart);
                });
            });
        });

        describe("#given a completed tool part with a long argument (background task shape)", () => {
            describe("#when truncate runs", () => {
                it("#then the wire copy carries the clamp while the live object stays intact", () => {
                    const longPrompt = `Investigate and fix the regression. ${"y".repeat(600)}`;
                    const taskPart = {
                        type: "tool",
                        tool: "task",
                        callID: "call-bg",
                        state: {
                            status: "completed",
                            input: { prompt: longPrompt, subagent_type: "mason" },
                            output: '<task state="running">started</task>',
                        },
                    };
                    const pristine = JSON.stringify(taskPart);
                    const messages: MessageLike[] = [message("m-bg", "assistant", [taskPart])];
                    const index = buildIndex(messages);
                    const batch = new ToolMutationBatch(messages);
                    const target = createToolDropTarget("call-bg", [], index, batch, 12);

                    expect(target.canDrop()).toBe(true);
                    expect(target.truncate()).toBe("truncated");

                    // The wire copy now in the array is clamped + sentinelled...
                    const wire = messages[0]?.parts[0] as {
                        state: { input: Record<string, unknown>; output: string };
                    };
                    expect(wire).not.toBe(taskPart);
                    expect(wire.state.output).toBe("[dropped \u00a712\u00a7]");
                    expect(wire.state.input).toEqual({ dropped: "[dropped §12§]" });

                    // ...but the LIVE object OpenCode still holds is byte-identical
                    // to before the reclaim pass — the long prompt is intact, so a
                    // child agent spawning from it is never corrupted.
                    expect(JSON.stringify(taskPart)).toBe(pristine);
                    expect(taskPart.state.input.prompt).toBe(longPrompt);
                });
            });
        });

        describe("#given an errored OpenCode tool part (status error, no output, large input)", () => {
            describe("#when the selectors run", () => {
                it("#then it IS clamp-eligible (closed arm) and the clamp stays on the wire only", () => {
                    const bigContent = "z".repeat(600);
                    const failedWrite = {
                        type: "tool",
                        tool: "write",
                        callID: "call-err",
                        state: {
                            status: "error",
                            error: "permission denied",
                            input: { filePath: "/spec.md", content: bigContent },
                        },
                    };
                    const pristine = JSON.stringify(failedWrite);
                    const messages: MessageLike[] = [message("m-err", "assistant", [failedWrite])];
                    const index = buildIndex(messages);
                    const batch = new ToolMutationBatch(messages);
                    const target = createToolDropTarget("call-err", [], index, batch, 13);

                    // Errored arm is closed → eligible for every selector (this is
                    // the reclaim the old type-based gate also allowed; the new
                    // gate must NOT leak it).
                    expect(target.canDrop()).toBe(true);
                    expect(target.truncate()).toBe("truncated");

                    // Wire copy carries the clamp + sentinel...
                    const wire = messages[0]?.parts[0] as {
                        state: { input: Record<string, unknown>; output: string };
                    };
                    expect(wire).not.toBe(failedWrite);
                    expect(wire.state.output).toBe("[dropped \u00a713\u00a7]");
                    expect(wire.state.input).toEqual({ dropped: "[dropped §13§]" });

                    // ...live object stays byte-identical: reclaimed via a clone,
                    // never by mutating the original part.
                    expect(JSON.stringify(failedWrite)).toBe(pristine);
                    expect(failedWrite.state.input.content).toBe(bigContent);
                });
            });
        });
    });

    describe("hasMeaningfulPart", () => {
        it("returns false for empty text", () => {
            expect(hasMeaningfulPart({ type: "text", text: "" })).toBe(false);
            expect(hasMeaningfulPart({ type: "text", text: "   " })).toBe(false);
        });

        it("returns false for text containing only tag prefixes", () => {
            expect(hasMeaningfulPart({ type: "text", text: "§424§ " })).toBe(false);
            expect(hasMeaningfulPart({ type: "text", text: "§424§" })).toBe(false);
            expect(hasMeaningfulPart({ type: "text", text: "§424§   " })).toBe(false);
            expect(hasMeaningfulPart({ type: "text", text: "§1§ §2§ " })).toBe(false);
            expect(hasMeaningfulPart({ type: "text", text: '§15298">§15298§ ' })).toBe(false);
            expect(hasMeaningfulPart({ type: "text", text: '§15298">§ ' })).toBe(false);
        });

        it("returns true for text with actual content", () => {
            expect(hasMeaningfulPart({ type: "text", text: "hello" })).toBe(true);
            expect(hasMeaningfulPart({ type: "text", text: "§424§ hello" })).toBe(true);
            expect(hasMeaningfulPart({ type: "text", text: '§15298">§15298§ hello' })).toBe(true);
        });

        it("returns true for tools", () => {
            expect(hasMeaningfulPart({ type: "tool" })).toBe(true);
            expect(hasMeaningfulPart({ type: "tool_result" })).toBe(true);
        });

        it("returns false for non-record types", () => {
            expect(hasMeaningfulPart(null)).toBe(false);
            expect(hasMeaningfulPart(undefined)).toBe(false);
            expect(hasMeaningfulPart("string")).toBe(false);
            expect(hasMeaningfulPart(123)).toBe(false);
        });

        it("returns false for ignored part types", () => {
            expect(hasMeaningfulPart({ type: "step-start" })).toBe(false);
            expect(hasMeaningfulPart({ type: "step-finish" })).toBe(false);
            expect(hasMeaningfulPart({ type: "thinking" })).toBe(false);
            expect(hasMeaningfulPart({ type: "reasoning" })).toBe(false);
            expect(hasMeaningfulPart({ type: "redacted_thinking" })).toBe(false);
            expect(hasMeaningfulPart({ type: "meta" })).toBe(false);
        });
    });
});

it("reclaim preview counts the retained skeleton without mutating the served parts", () => {
    const messages = [
        message("m", "assistant", [
            {
                type: "tool",
                callID: "c",
                tool: "read",
                state: {
                    input: { path: "sample.txt" },
                    output: "word ".repeat(999),
                    status: "completed",
                },
            },
        ]),
    ];
    const bytes = JSON.stringify(messages);
    const target = createToolDropTarget(
        "c",
        [],
        buildIndex(messages),
        new ToolMutationBatch(messages),
        12,
    );
    const full = target.measureReclaim(false);
    const skeleton = target.measureReclaim(true);
    expect(full.beforeTools).toBeGreaterThan(1000);
    expect(full.afterTools).toBe(0);
    expect(skeleton.afterTools).toBeGreaterThan(0);
    expect(skeleton.afterTools).toBeLessThan(skeleton.beforeTools);
    expect(JSON.stringify(messages)).toBe(bytes);
});

it("reclaim preview measures what a call already cut to a skeleton this pass still serves", () => {
    const messages = [
        message("m", "assistant", [
            {
                type: "tool",
                callID: "c",
                tool: "read",
                state: {
                    input: { path: "sample.txt" },
                    output: "word ".repeat(999),
                    status: "completed",
                },
            },
        ]),
    ];
    const target = createToolDropTarget(
        "c",
        [],
        buildIndex(messages),
        new ToolMutationBatch(messages),
        12,
    );
    const preview = target.measureReclaim(true);
    expect(target.skeletonReal()).toBe("truncated");
    // The request now carries the skeleton, so that is what the call serves.
    const after = target.measureReclaim(false);
    expect(after.beforeTools).toBe(preview.afterTools);
    expect(after.beforeTools).toBeLessThan(preview.beforeTools);
});
