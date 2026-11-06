/// <reference types="bun-types" />

import { describe, expect, it, spyOn } from "bun:test";
import { Message, ToolResultValue } from "@opencode/ai/schema/messages";
import { estimateMessageTokens } from "../../hooks/magic-context/final-wire-token-estimate";
import type { MessageLike } from "../../hooks/magic-context/tag-messages";
import {
    createToolDropTarget,
    extractToolCallObservation,
    partHasCompletedResult,
    type ToolCallIndex,
    ToolMutationBatch,
} from "../../hooks/magic-context/tool-drop-target";
import * as logger from "../../shared/logger";
import { rememberHostMedia, resetHostMediaForTests } from "../fold/host-media";
import { restoreRow } from "../fold/restore";
import type { StoreRow } from "../store-reader";
import { adaptPayload } from "./payload";
import { rawMessages } from "./store";
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
    it("render review: 400 timestamp observations preserve exact provider-visible bytes", () => {
        let seed = 4910;
        const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
        for (let pass = 0; pass < 400; pass++) {
            const messages: V2Message[] = [
                {
                    id: `u${pass}`,
                    role: "user",
                    content: [
                        { type: "text", text: `Question ${next()}`, cache: { type: "ephemeral" } },
                    ],
                },
                ...toolTurn(`a${pass}`, `call${pass}`, "read", `Contents ${next()}`),
                {
                    id: `tail${pass}`,
                    role: "user",
                    content: [{ type: "text", text: `Follow-up ${next()}` }],
                },
            ];
            const untimed = draft(structuredClone(messages));
            const timed = draft(structuredClone(messages));
            const times = new Map(
                messages
                    .filter((m) => m.id)
                    .map((m) => [m.id!, { created: next(), completed: next() }]),
            );
            const plain = adaptPayload(untimed);
            const observed = adaptPayload(timed, new Set(), times);
            expect(observed.messages[0].info.time).toEqual(times.get(`u${pass}`));
            if (next() % 2) {
                plain.messages[0].parts[0].text += " Edited by the pipeline.";
                observed.messages[0].parts[0].text += " Edited by the pipeline.";
            }
            for (const message of observed.messages)
                message.info.time = { created: next(), completed: next() };
            plain.commit();
            observed.commit();
            expect(JSON.stringify(timed), `timestamp pass ${pass}`).toBe(JSON.stringify(untimed));
            expect(timed.messages.some((m) => "info" in m)).toBe(false);
        }
    });

    it("observes store timestamps internally without serializing info to the host draft", () => {
        const context = draft([
            { id: "timed", role: "user", content: [{ type: "text", text: "hello" }] },
            { role: "assistant", content: [{ type: "text", text: "world" }] },
        ]);
        const before = JSON.stringify(context);
        const time = { created: 1700000000000, completed: 1700000001000 };
        const payload = adaptPayload(context, new Set(), new Map([["timed", time]]));
        expect(payload.messages[0].info.time).toEqual(time);
        expect(payload.messages[1].info.time).toBeUndefined();
        payload.messages[0].info.time = { created: 42, completed: 43 };
        payload.commit();
        expect(JSON.stringify(context)).toBe(before);
        expect(context.messages.every((message) => !("info" in message))).toBe(true);
    });

    it("preserves restored and normalized tool errors as errors with identical tagged text", () => {
        const failure = {
            error: { type: "tool.execution", message: "File not found: missing.txt" },
            content: [],
        };
        for (const result of [
            { result: failure, resultType: "error" },
            { result: { type: "error", value: failure } },
        ]) {
            const context = draft(toolTurn("msg-error", "call-error", "read", ""));
            Object.assign(context.messages[1].content[0], result);
            const payload = adaptPayload(context);
            const state = payload.messages[0].parts[1].state as Record<string, unknown>;
            expect(state.status).toBe("error");
            expect(state.output).toBe(JSON.stringify(failure));
            state.output = `§2§ ${state.output}`;
            payload.commit();
            expect(callsAndResults(context.messages).results[0].result).toEqual({
                type: "error",
                value: `§2§ ${JSON.stringify(failure)}`,
            });
            expect(() => Message.make(context.messages[1])).not.toThrow();
        }
    });

    it("preserves converted store errors and unbridged replay errors", () => {
        const failure = { error: { type: "tool.execution", message: "missing" }, content: [] };
        const context = draft([
            {
                id: "converted",
                role: "assistant",
                content: [
                    {
                        type: "tool",
                        id: "call-error",
                        name: "read",
                        state: { status: "error", input: { path: "missing" }, ...failure },
                    },
                ],
            },
        ]);
        const payload = adaptPayload(context);
        const state = payload.messages[0].parts[0].state as Record<string, unknown>;
        expect(state.status).toBe("error");
        expect(state.output).toBe(JSON.stringify(failure));
        state.output = `§2§ ${state.output}`;
        payload.messages.push({
            info: { role: "assistant", id: "replay" },
            parts: [
                {
                    type: "tool",
                    tool: "read",
                    callID: "replay-call",
                    state: { status: "error", input: {}, output: "§3§ replay error" },
                },
            ],
        });
        payload.commit();
        expect(callsAndResults(context.messages).results.map((part) => part.result)).toEqual([
            { type: "error", value: `§2§ ${JSON.stringify(failure)}` },
            { type: "error", value: "§3§ replay error" },
        ]);
    });

    it("store-reader projection and checkpoint replay retain error text and status", () => {
        const failure = {
            error: { type: "tool.execution", message: "missing" },
            content: [{ type: "text", text: "details" }],
        };
        const row: StoreRow = {
            id: "error-owner",
            session_id: "ses-1",
            type: "assistant",
            seq: 2,
            data: {
                model: { providerID: "provider", id: "model" },
                content: [
                    {
                        type: "tool",
                        id: "call-error",
                        name: "read",
                        state: { status: "error", input: { path: "missing" }, ...failure },
                    },
                ],
            },
        };
        expect(rawMessages([row])[0].parts[0]).toMatchObject({
            state: { status: "error", output: JSON.stringify(failure) },
        });
        const context = draft(restoreRow(row, { providerID: "provider", id: "model" }));
        const payload = adaptPayload(context);
        expect(payload.messages[0].parts[0]).toMatchObject({
            state: { status: "error", output: JSON.stringify(failure) },
        });
        payload.commit();
        const restored = callsAndResults(context.messages).results[0];
        // A restored failed call must already be in the host's finished shape;
        // OpenCode 2.2 validates the request against it and refuses otherwise.
        expect(restored.result).toEqual({ type: "error", value: failure });
        expect("resultType" in restored).toBe(false);
        expect(ToolResultValue.is(restored.result)).toBe(true);
    });

    it("keeps error drop marker bytes and call pairing", () => {
        const context = draft(toolTurn("msg-error", "call-error", "read", ""));
        Object.assign(context.messages[1].content[0], {
            resultType: "error",
            result: { error: "missing", content: [] },
        });
        const payload = adaptPayload(context);
        const owner = payload.messages[0];
        const target = createToolDropTarget(
            "call-error",
            [],
            indexMessage(owner),
            new ToolMutationBatch(payload.messages),
            7,
        );
        expect(target.truncate()).toBe("truncated");
        payload.commit();
        const { calls, results } = callsAndResults(context.messages);
        expect(calls[0].input).toEqual({ dropped: "[dropped §7§]" });
        expect(results[0].result).toEqual({ type: "error", value: "[dropped §7§]" });
    });
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
            for (const message of context.messages)
                expect(() => Message.make(message)).not.toThrow();
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
            for (const message of context.messages)
                expect(() => Message.make(message)).not.toThrow();
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
            for (const message of context.messages)
                expect(() => Message.make(message)).not.toThrow();
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
            for (const message of context.messages)
                expect(() => Message.make(message)).not.toThrow();
            expect(context.messages.map((message) => [message.id, message.role])).toEqual([
                ["msg-1", "assistant"],
                [undefined, "tool"],
            ]);
            const { calls, results } = callsAndResults(context.messages);
            expect(calls[0]).toMatchObject({ id: "call-1", input: { dropped: "[dropped §5§]" } });
            expect(results[0]).toMatchObject({ result: { type: "text", value: "[dropped §5§]" } });
        });
    });

    describe("#given a converted OpenCode 1 tool part with state.content", () => {
        it("#then the drop pipeline measures and rewrites the converted output", () => {
            const context = draft([
                {
                    id: "msg-converted",
                    role: "assistant",
                    content: [
                        {
                            type: "tool",
                            id: "call-converted",
                            name: "read",
                            state: {
                                status: "completed",
                                input: { path: "large.log" },
                                content: [
                                    { type: "text", text: "converted output".repeat(20_000) },
                                ],
                            },
                        },
                    ],
                },
            ]);
            const payload = adaptPayload(context);
            const owner = payload.messages[0];
            const projected = owner.parts[0] as { state: { output: string } };
            expect(projected.state.output.length).toBeGreaterThan(100_000);
            const target = createToolDropTarget(
                "call-converted",
                [],
                indexMessage(owner),
                new ToolMutationBatch(payload.messages),
                11,
            );

            expect(target.truncate()).toBe("truncated");
            payload.commit();

            expect(context.messages[0]?.content[0]).toMatchObject({
                type: "tool-call",
                id: "call-converted",
                name: "read",
                input: { dropped: "[dropped §11§]" },
            });
            expect(context.messages[1]?.content[0]).toMatchObject({
                type: "tool-result",
                id: "call-converted",
                name: "read",
                result: { type: "text", value: "[dropped §11§]" },
            });
            for (const message of context.messages)
                expect(() => Message.make(message)).not.toThrow();
        });
    });

    describe("#given a migrated OpenCode 1 assistant row with a surviving tool skeleton", () => {
        it("#then the returned draft passes the OpenCode 2.0.15 LLM message schema", () => {
            const context = draft([
                {
                    id: "msg-converted",
                    role: "assistant",
                    content: [
                        { type: "text", text: "before" },
                        { type: "reasoning", text: "thinking" },
                        {
                            type: "tool",
                            id: "call-converted",
                            name: "read",
                            state: {
                                status: "completed",
                                input: { path: "large.log" },
                                content: [{ type: "text", text: "converted output".repeat(100) }],
                            },
                        },
                    ],
                },
            ]);
            const payload = adaptPayload(context);
            const target = createToolDropTarget(
                "call-converted",
                [],
                indexMessage(payload.messages[0]),
                new ToolMutationBatch(payload.messages),
                11,
            );
            expect(target.truncate()).toBe("truncated");
            payload.commit();
            for (const message of context.messages)
                expect(() => Message.make(message)).not.toThrow();
        });
    });

    describe("#given an injected system row removed alongside a fully dropped tool arc", () => {
        it("#then commit() leaves only host-schema-valid content", () => {
            const context = draft([
                {
                    id: "msg-injection",
                    role: "system",
                    content: [{ type: "text", text: "temporary" }],
                },
                ...toolTurn("msg-old", "call-old", "read", "old output"),
                { id: "msg-user", role: "user", content: [{ type: "text", text: "continue" }] },
            ]);
            const payload = adaptPayload(context);
            const owner = payload.messages[1];
            const batch = new ToolMutationBatch(payload.messages);
            const target = createToolDropTarget("call-old", [], indexMessage(owner), batch, 4);
            expect(target.drop()).toBe("removed");
            batch.finalize();
            payload.messages.splice(0, 1);
            payload.commit();
            for (const message of context.messages)
                expect(() => Message.make(message)).not.toThrow();
            expect(context.messages.some((message) => message.id === "msg-injection")).toBe(false);
        });
    });

    describe("#given a synthetic todowrite reminder without a host bridge", () => {
        it("#then commits a host tool-call and result on both priced and replayed passes", () => {
            const synthetic = {
                type: "tool",
                tool: "todowrite",
                callID: "mc_synthetic_todo_0123456789abcdef",
                state: {
                    status: "completed",
                    input: { todos: [{ content: "Finish", status: "pending", priority: "high" }] },
                    output: "1 todos",
                },
                syntheticTodoMarker: true,
            };
            for (const pass of ["priced", "cache_hit"]) {
                const context = draft([
                    {
                        id: "msg-assistant",
                        role: "assistant",
                        content: [{ type: "text", text: pass }],
                    },
                ]);
                const payload = adaptPayload(context);
                payload.messages[0].parts.push(structuredClone(synthetic));
                payload.commit();
                expect(context.messages[0]?.content[1]).toEqual({
                    type: "tool-call",
                    id: synthetic.callID,
                    name: "todowrite",
                    input: synthetic.state.input,
                });
                expect(context.messages[1]?.content[0]).toEqual({
                    type: "tool-result",
                    id: synthetic.callID,
                    name: "todowrite",
                    result: { type: "text", value: "1 todos" },
                });
                for (const message of context.messages)
                    expect(() => Message.make(message)).not.toThrow();
            }
        });
    });

    describe("#given a pipeline-created mural image and an unknown part", () => {
        it("#then uses the host's Media.Asset and refuses unknown content rather than forwarding it", () => {
            resetHostMediaForTests();
            rememberHostMedia([
                Message.make({ role: "user", content: [{ type: "text", text: "seed schema" }] }),
            ]);
            const context = draft([
                { id: "msg-user", role: "user", content: [{ type: "text", text: "m0" }] },
            ]);
            const payload = adaptPayload(context);
            const png =
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
            payload.messages[0].parts.push({
                type: "file",
                mime: "image/png",
                url: `data:image/png;base64,${png}`,
            });
            payload.messages[0].parts.push({ type: "unknown_future_content", value: "bad" });
            const warnings: string[] = [];
            const logSpy = spyOn(logger, "sessionLog").mockImplementation((_session, message) => {
                warnings.push(message);
            });
            try {
                payload.commit();
            } finally {
                logSpy.mockRestore();
                resetHostMediaForTests();
            }
            expect(context.messages[0]?.content[1]).toMatchObject({ type: "media" });
            expect(context.messages[0]?.content).toHaveLength(2);
            expect(warnings).toHaveLength(1);
            expect(warnings[0]).toContain("type=unknown_future_content");
            expect(() => Message.make(context.messages[0])).not.toThrow();
        });
    });

    describe("#given a mural image with no host Media.Asset constructor", () => {
        it("#then omits it with a logged reason instead of emitting an invalid file part", () => {
            resetHostMediaForTests();
            const context = draft([
                { id: "msg-user", role: "user", content: [{ type: "text", text: "m0" }] },
            ]);
            const payload = adaptPayload(context);
            payload.messages[0].parts.push({
                type: "file",
                mime: "image/png",
                url: "data:image/png;base64,AA==",
            });
            const warnings: string[] = [];
            const logSpy = spyOn(logger, "sessionLog").mockImplementation((_session, message) => {
                warnings.push(message);
            });
            try {
                payload.commit();
            } finally {
                logSpy.mockRestore();
                resetHostMediaForTests();
            }
            expect(context.messages[0]?.content).toEqual([{ type: "text", text: "m0" }]);
            expect(warnings[0]).toContain("type=file");
            expect(warnings[0]).toContain("host media unavailable");
            expect(() => Message.make(context.messages[0])).not.toThrow();
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

    // OpenCode 2.0.15 carries an attachment's bytes in a `Media.Asset` class instance, and
    // after the context hook the host rebuilds each message with Message.make, whose schema
    // accepts only a real instance. A plain-object copy fails with "Schema validation failed"
    // and the turn never reaches the provider.
    describe("#given a user attachment whose media payload is a host class instance", () => {
        class HostAsset {
            constructor(
                readonly source: { type: string; data: string; mediaType: string },
                readonly mediaType: string,
            ) {}
        }
        const attachmentTurn = (): V2Message[] => [
            {
                id: "msg-image",
                role: "user",
                content: [
                    { type: "text", text: "what is in this image?" },
                    {
                        type: "media",
                        media: new HostAsset(
                            { type: "base64", data: "iVBORw0KGgo=", mediaType: "image/png" },
                            "image/png",
                        ),
                        filename: "pixel.png",
                    },
                ],
            },
        ];
        const mediaOf = (context: SessionContext) =>
            context.messages[0]?.content.find((part) => part.type === "media")?.media;

        it("#then commit() hands the host back the same class instance", () => {
            const context = draft(attachmentTurn());
            const payload = adaptPayload(context);
            payload.commit();

            expect(mediaOf(context)).toBeInstanceOf(HostAsset);
        });

        it("#then the adapted draft already holds the instance, and a pipeline edit to the part keeps it", () => {
            const context = draft(attachmentTurn());
            const payload = adaptPayload(context);
            const adapted = payload.messages[0].parts[1] as { media: unknown; filename: string };
            expect(adapted.media).toBeInstanceOf(HostAsset);
            // An edited part no longer matches the host's original, so commit() cannot swap
            // the original back in; only the adapted copy can carry the instance through.
            adapted.filename = "renamed.png";
            payload.commit();

            const media = context.messages[0]?.content[1];
            expect(media?.filename).toBe("renamed.png");
            expect(media?.media).toBeInstanceOf(HostAsset);
        });

        it("#then an unchanged part copied by a later pipeline stage still gets the instance back", () => {
            const context = draft(attachmentTurn());
            const payload = adaptPayload(context);
            // Some pipeline stages swap a structuredClone of a message's parts into place,
            // which flattens any class instance into a plain object.
            const owner = payload.messages[0];
            owner.parts = structuredClone(owner.parts);
            (owner.parts[0] as { text: string }).text = "§1§ what is in this image?";
            payload.commit();

            expect(mediaOf(context)).toBeInstanceOf(HostAsset);
            expect(context.messages[0]?.content[0]).toEqual({
                type: "text",
                text: "§1§ what is in this image?",
            });
        });
    });

    // OpenCode 2's `read` tool returns an image as a `content` result: a text entry plus a
    // `file` entry holding a data URI, which the host sends to the provider as an image block.
    describe("#given a tool result that carries an image", () => {
        // A PNG header for a 100x100 image followed by 30 KB of padding, so the base64
        // payload is far larger than the image's pixel-based token cost.
        const pngHeader = Buffer.from(
            "89504e470d0a1a0a0000000d4948445200000064000000640806000000",
            "hex",
        );
        const PNG = Buffer.concat([pngHeader, Buffer.alloc(30_000)]).toString("base64");
        const fileEntry = {
            type: "file",
            uri: `data:image/png;base64,${PNG}`,
            mime: "image/png",
            name: "/work/pixel.png",
        };
        const imageResult = {
            type: "content",
            value: [{ type: "text", text: "Image read successfully" }, fileEntry],
        };
        const imageTurn = (): V2Message[] => [
            {
                id: "msg-read",
                role: "assistant",
                content: [
                    {
                        type: "tool-call",
                        id: "call-read",
                        name: "read",
                        input: { path: "pixel.png" },
                    },
                ],
            },
            {
                role: "tool",
                content: [
                    { type: "tool-result", id: "call-read", name: "read", result: imageResult },
                ],
            },
        ];
        const projected = (payload: ReturnType<typeof adaptPayload>) =>
            payload.messages[0]?.parts[0] as {
                state: { output: string; attachments?: Array<Record<string, unknown>> };
            };
        const resultOf = (context: SessionContext) => callsAndResults(context.messages).results[0];

        it("#then the pipeline sees the text as output and the image as an attachment, not base64 text", () => {
            const payload = adaptPayload(draft(imageTurn()));
            const { state } = projected(payload);

            expect(state.output).toBe("Image read successfully");
            expect(state.output).not.toContain(PNG.slice(0, 40));
            expect(state.attachments).toEqual([
                {
                    type: "file",
                    mime: "image/png",
                    url: fileEntry.uri,
                    filename: "/work/pixel.png",
                },
            ]);
        });

        it("#then an unchanged result reaches the host as the same object", () => {
            const context = draft(imageTurn());
            adaptPayload(context).commit();

            expect(resultOf(context)?.result).toBe(imageResult);
        });

        it("#then a tagged result keeps the host's file entry, by reference, next to the tagged text", () => {
            const context = draft(imageTurn());
            const payload = adaptPayload(context);
            const { state } = projected(payload);
            state.output = `§4§ ${state.output}`;
            payload.commit();

            expect(resultOf(context)?.result).toEqual({
                type: "content",
                value: [{ type: "text", text: "§4§ Image read successfully" }, fileEntry],
            });
            const value = (resultOf(context)?.result as { value: unknown[] }).value;
            expect(value[1]).toBe(fileEntry);
            for (const message of context.messages)
                expect(() => Message.make(message)).not.toThrow();
        });

        it("#then a pipeline copy of the owning parts still rebuilds the same result", () => {
            const context = draft(imageTurn());
            const payload = adaptPayload(context);
            const owner = payload.messages[0]!;
            owner.parts = structuredClone(owner.parts);
            projected(payload).state.output = `§4§ Image read successfully`;
            payload.commit();

            expect(resultOf(context)?.result).toEqual({
                type: "content",
                value: [{ type: "text", text: "§4§ Image read successfully" }, fileEntry],
            });
        });

        it("#then a dropped result loses the image with the text", () => {
            const context = draft(imageTurn());
            const payload = adaptPayload(context);
            const owner = payload.messages[0]!;
            const target = createToolDropTarget(
                "call-read",
                [],
                indexMessage(owner),
                new ToolMutationBatch(payload.messages),
                6,
            );
            expect(target.truncate()).toBe("truncated");
            payload.commit();

            expect(resultOf(context)?.result).toEqual({ type: "text", value: "[dropped §6§]" });
        });

        it("#then the token estimate counts the image by its pixels, not its base64 length", () => {
            const payload = adaptPayload(draft(imageTurn()));
            const estimate = estimateMessageTokens(payload.messages[0]!);
            const text = estimateMessageTokens({
                info: payload.messages[0]!.info,
                parts: [
                    {
                        ...projected(payload),
                        type: "tool",
                        state: { ...projected(payload).state, attachments: [] },
                    },
                ],
            });

            // 100x100 pixels bill ceil(10000 / 750) = 14 image tokens.
            expect(estimate.toolCall - text.toolCall).toBe(14);
            expect(estimate.toolCall).toBeLessThan(200);
        });
    });
});

it("OpenCode 2 question fallback vetoes automatic drops but preserves explicit reduction", () => {
    const payload = draft(toolTurn("m", "q", "question", "user decision"));
    const mapped = adaptPayload(payload);
    const message = mapped.messages.find((m) => indexMessage(m).has("q"))!;
    const target = createToolDropTarget(
        "q",
        [],
        indexMessage(message),
        new ToolMutationBatch(mapped.messages),
        1,
    );
    expect(target.canDrop()).toBe(false);
    expect(target.skeletonReal()).toBe("truncated");
    mapped.commit();
    expect(JSON.stringify(payload.messages)).toContain("[dropped §1§]");
});

describe("adaptPayload commit on canonical Anthropic", () => {
    // Anthropic answers an empty text block with HTTP 400, and OpenCode 2 sends a
    // `system` row to it as an in-conversation system message with its text
    // blocks as they are. The whole-message lanes leave such a row with no parts;
    // commit omits it, and a final guard takes out any empty text part left.
    const HINT = { type: "ephemeral" };

    function anthropicDraft(sessionID: string, messages: V2Message[]): SessionContext {
        return {
            ...draft(messages),
            sessionID,
            model: { providerID: "anthropic", id: "claude-opus-5-5" },
        };
    }

    function rows(): V2Message[] {
        // The host stores assistant replies without tag notation; adaptPayload strips
        // any it finds there (a model-copied tag), so the assistant row starts plain.
        return [
            { id: "u1", role: "user", content: [{ type: "text", text: "§1§ start" }] },
            { id: "s1", role: "system", content: [{ type: "text", text: "[dropped §2§]" }] },
            { id: "a1", role: "assistant", content: [{ type: "text", text: "reply" }] },
            { id: "u2", role: "user", content: [{ type: "text", text: "§4§ next" }] },
        ];
    }

    function commitWith(
        context: SessionContext,
        edit: (byId: Map<unknown, MessageLike>) => void,
    ): string[] {
        const mapped = adaptPayload(context);
        edit(new Map(mapped.messages.map((message) => [message.info.id, message])));
        const logged: string[] = [];
        const logSpy = spyOn(logger, "sessionLog").mockImplementation((_session, message) => {
            logged.push(message);
        });
        try {
            mapped.commit();
        } finally {
            logSpy.mockRestore();
        }
        return logged.filter((line) => line.includes("v2 payload: left out"));
    }

    it("omits a system row left with no parts and records it once per session", () => {
        const first = anthropicDraft("ses-662-omit", rows());
        const logged = commitWith(first, (byId) => {
            byId.get("s1")!.parts.length = 0;
        });
        expect(first.messages.map((message) => message.id)).toEqual(["u1", "a1", "u2"]);
        expect(logged).toHaveLength(1);
        expect(logged[0]).toContain("left out 1 emptied messages and 0 empty text parts");

        // The next ordinary pass serves the same bytes and does not log again.
        const second = anthropicDraft("ses-662-omit", rows());
        expect(
            commitWith(second, (byId) => {
                byId.get("s1")!.parts.length = 0;
            }),
        ).toEqual([]);
        expect(JSON.stringify(second.messages)).toBe(JSON.stringify(first.messages));
    });

    it("takes out empty text parts and puts a removed cache hint where OpenCode 2 would", () => {
        const context = anthropicDraft("ses-662-guard", rows());
        const logged = commitWith(context, (byId) => {
            // An empty system row whose sentinel carries the host's cache hint.
            byId.get("s1")!.parts.splice(0, 1, { type: "text", text: "", cache: HINT });
            // An assistant row with empty parts around its text, the last one hinted.
            byId.get("a1")!.parts.unshift({ type: "text", text: "" });
            byId.get("a1")!.parts.push({ type: "text", text: "§5§ more" });
            byId.get("a1")!.parts.push({ type: "text", text: "", cache: HINT });
        });
        expect(context.messages).toEqual([
            // OpenCode 2's cache policy (packages/ai cache-policy.ts, markMessageAt)
            // marks a message's last text part, else its last part.
            { id: "u1", role: "user", content: [{ type: "text", text: "§1§ start", cache: HINT }] },
            {
                id: "a1",
                role: "assistant",
                content: [
                    { type: "text", text: "reply" },
                    { type: "text", text: "§5§ more", cache: HINT },
                ],
            },
            { id: "u2", role: "user", content: [{ type: "text", text: "§4§ next" }] },
        ]);
        expect(logged).toHaveLength(1);
        expect(logged[0]).toContain("left out 1 emptied messages and 3 empty text parts");
    });

    it("never adds a second breakpoint to a message that already has one", () => {
        const context = anthropicDraft("ses-662-existing", rows());
        commitWith(context, (byId) => {
            const assistant = byId.get("a1")!;
            assistant.parts.unshift({ type: "text", text: "kept", cache: HINT });
            assistant.parts.push({ type: "text", text: "", cache: { type: "other" } });
        });
        expect(context.messages.find((message) => message.id === "a1")?.content).toEqual([
            { type: "text", text: "kept", cache: HINT },
            { type: "text", text: "reply" },
        ]);
    });

    it("leaves other providers' rows and empty parts exactly as the pipeline produced them", () => {
        const context = {
            ...anthropicDraft("ses-662-openai", rows()),
            model: { providerID: "openai", id: "gpt" },
        };
        const logged = commitWith(context, (byId) => {
            byId.get("s1")!.parts.splice(0, 1, { type: "text", text: "[dropped]" });
            byId.get("a1")!.parts.push({ type: "text", text: "" });
        });
        expect(logged).toEqual([]);
        expect(context.messages.find((message) => message.id === "s1")?.content).toEqual([
            { type: "text", text: "[dropped]" },
        ]);
        expect(context.messages.find((message) => message.id === "a1")?.content).toEqual([
            { type: "text", text: "reply" },
            { type: "text", text: "" },
        ]);
    });
});
