/// <reference types="bun-types" />

/**
 * The last-known-good snapshot stores the served messages as the provider
 * receives them (provider-visible-parts.ts). These tests run whole and reduced
 * messages through OpenCode 1.18.35's conversion (run from a verbatim, hash-pinned
 * copy of its source, AI SDK step included) and through Magic Context's
 * OpenCode 2 commit, and show the resulting messages are the same, for tool
 * parts in every state and the other part kinds a request carries.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { adaptPayload } from "../../v2/hooks/payload";
import type { SessionContext, V2Message } from "../../v2/hooks/types";
import { estimateFinalWireInputTokens } from "./final-wire-token-estimate";
import { captureLkgSlot, projectLkgEntry, replayLkg } from "./lkg-replay";
import { getSlot, resetLkgSlotsForTest } from "./lkg-slot";
import {
    type Opencode1Model,
    opencode1ToModelMessages,
} from "./opencode1-to-model-messages.fixture";
import { providerVisibleMessage } from "./provider-visible-parts";
import type { MessageLike } from "./transform-operations";

const MODEL = {
    providerID: "anthropic",
    id: "claude-sonnet-4-5",
    api: { npm: "@ai-sdk/anthropic", id: "claude-sonnet-4-5" },
};
const PNG =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Workspace diagnostics like those edit and write tools attach. */
function diagnostics(files: number): Record<string, unknown[]> {
    const result: Record<string, unknown[]> = {};
    for (let file = 0; file < files; file += 1) {
        result[`/repo/src/file-${file}.ts`] = Array.from({ length: 30 }, (_, line) => ({
            range: { start: { line, character: 0 }, end: { line, character: 3 } },
            severity: 1,
            message: `Cannot find name 'x${line}'.`,
        }));
    }
    return result;
}

function tool(callID: string, toolName: string, state: Record<string, unknown>) {
    return {
        id: `part-${callID}`,
        sessionID: "session",
        messageID: "a1",
        type: "tool",
        callID,
        tool: toolName,
        metadata: { anthropic: { cacheControl: "x" } },
        state,
    };
}

function session(): MessageLike[] {
    const time = { start: 10, end: 20 };
    return [
        {
            info: {
                id: "u1",
                role: "user",
                sessionID: "session",
                time: { created: 1 },
                model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
            } as never,
            parts: [
                { type: "text", text: "fix the build", time: { start: 1, end: 1 } },
                { type: "text", text: "ignored note", ignored: true },
                { type: "file", mime: "image/png", filename: "shot.png", url: PNG },
                { type: "compaction", auto: true },
                { type: "subtask", prompt: "check", description: "check", agent: "explore" },
            ],
        },
        {
            info: {
                id: "a1",
                role: "assistant",
                sessionID: "session",
                time: { created: 2, completed: 3 },
                providerID: "anthropic",
                modelID: "claude-sonnet-4-5",
                finish: "tool-calls",
            } as never,
            parts: [
                { type: "step-start" },
                {
                    type: "reasoning",
                    text: "thinking",
                    metadata: { anthropic: { signature: "sig-1" } },
                    time: { start: 2, end: 2 },
                },
                { type: "text", text: "Editing.", metadata: { anthropic: { id: "t1" } } },
                tool("call-edit", "edit", {
                    status: "completed",
                    input: { filePath: "/repo/a.ts", oldString: "a", newString: "b" },
                    output: "Edit applied successfully.",
                    title: "a.ts",
                    time,
                    metadata: { diagnostics: diagnostics(40), diff: "-a\n+b" },
                    attachments: [{ type: "file", mime: "image/png", url: PNG, filename: "a.png" }],
                }),
                tool("call-old", "read", {
                    status: "completed",
                    input: { filePath: "/repo/b.ts" },
                    output: "old content",
                    title: "b.ts",
                    time: { ...time, compacted: 30 },
                    metadata: { preview: "old" },
                }),
                tool("call-error", "bash", {
                    status: "error",
                    input: { command: "false" },
                    error: "exit 1",
                    time,
                    metadata: { exit: 1 },
                }),
                tool("call-interrupted", "bash", {
                    status: "error",
                    input: { command: "sleep 100" },
                    error: "aborted",
                    time,
                    metadata: { interrupted: true, output: "partial output", description: "sleep" },
                }),
                tool("call-pending", "write", {
                    status: "pending",
                    input: { filePath: "/repo/c.ts" },
                    raw: '{"filePath": "/repo/c.ts"',
                }),
                tool("call-running", "bash", {
                    status: "running",
                    input: { command: "bun test" },
                    title: "bun test",
                    time: { start: 40 },
                    metadata: { output: "running..." },
                }),
                { type: "step-finish", reason: "tool-calls", cost: 0.1, tokens: { input: 1 } },
            ],
        },
        {
            info: {
                id: "u2",
                role: "user",
                sessionID: "session",
                time: { created: 50 },
                model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
            } as never,
            parts: [{ type: "text", text: "continue" }],
        },
    ];
}

/** What a replay parses back: plain JSON objects. */
function roundTrip<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

describe("provider-visible last-known-good snapshots", () => {
    beforeEach(() => resetLkgSlotsForTest());

    // Models that route tool-result media differently in OpenCode 1
    // (message-v2.ts 137-170), plus the conversion's two options.
    const routes: Array<{ label: string; model: Opencode1Model; options?: object }> = [
        { label: "anthropic", model: MODEL },
        {
            label: "gemini 3",
            model: {
                providerID: "google",
                id: "gemini-3-pro",
                api: { npm: "@ai-sdk/google", id: "gemini-3-pro" },
            },
        },
        {
            label: "bedrock anthropic",
            model: {
                providerID: "amazon-bedrock",
                id: "anthropic.claude",
                api: { npm: "@ai-sdk/amazon-bedrock", id: "anthropic.claude-sonnet-4" },
            },
        },
        {
            label: "vertex anthropic",
            model: {
                providerID: "google-vertex-anthropic",
                id: "claude",
                api: { npm: "@ai-sdk/google-vertex/anthropic", id: "claude" },
            },
        },
        {
            label: "openai-compatible (media extracted)",
            model: {
                providerID: "local",
                id: "m",
                api: { npm: "@ai-sdk/openai-compatible", id: "m" },
            },
        },
        { label: "stripMedia", model: MODEL, options: { stripMedia: true } },
        { label: "toolOutputMaxChars", model: MODEL, options: { toolOutputMaxChars: 8 } },
    ];

    for (const route of routes) {
        it(`give OpenCode 1 the same provider messages as the whole messages (${route.label})`, async () => {
            const whole = roundTrip(session());
            const reduced = roundTrip(session().map(providerVisibleMessage));
            // The reduction removed the diagnostics and other UI data.
            expect(JSON.stringify(reduced).length).toBeLessThan(JSON.stringify(whole).length / 10);
            const wholeRequest = await opencode1ToModelMessages(whole, route.model, route.options);
            expect(
                JSON.stringify(await opencode1ToModelMessages(reduced, route.model, route.options)),
            ).toBe(JSON.stringify(wholeRequest));
            expect(JSON.stringify(wholeRequest)).toContain("partial output");
        });
    }

    it("covers every tool state and part kind in the provider messages", async () => {
        const request = JSON.stringify(await opencode1ToModelMessages(roundTrip(session()), MODEL));
        for (const expected of [
            "fix the build",
            "thinking",
            "sig-1",
            "Edit applied successfully.",
            "[Old tool result content cleared]",
            "exit 1",
            "partial output",
            "[Tool execution was interrupted]",
            "What did we do so far?",
            "The following tool was executed by the user",
        ]) {
            expect(request).toContain(expected);
        }
    });

    it("replays a stored snapshot that gives OpenCode 1 the same provider messages as the served array", async () => {
        const served = session();
        expect(
            captureLkgSlot({
                sessionId: "session",
                input: projectLkgEntry(served),
                output: served,
                modelKey: "anthropic/claude-sonnet-4-5",
                providerKey: "anthropic",
                capturedAt: 1,
            }),
        ).toBe(true);
        const slot = getSlot("session");
        expect(slot?.jsonPrefix.includes("Cannot find name")).toBe(false);
        // The next request: the same history plus a new turn.
        const next = [
            ...session(),
            {
                info: {
                    id: "u3",
                    role: "user",
                    sessionID: "session",
                    time: { created: 60 },
                } as never,
                parts: [{ type: "text", text: "and now?" }],
            },
        ];
        const replay = replayLkg({
            sessionId: "session",
            messages: next,
            modelKey: "anthropic/claude-sonnet-4-5",
            providerKey: "anthropic",
        });
        expect(replay.ok).toBe(true);
        if (!replay.ok) return;
        expect(
            JSON.stringify(await opencode1ToModelMessages(roundTrip(replay.messages), MODEL)),
        ).toBe(JSON.stringify(await opencode1ToModelMessages(roundTrip(next), MODEL)));
    });

    it("measures a reduced snapshot as the same request size", () => {
        const estimate = (messages: MessageLike[]) =>
            estimateFinalWireInputTokens({
                messages,
                systemPromptTokens: 0,
                providerID: MODEL.providerID,
                modelID: MODEL.id,
                agentName: undefined,
            });
        const whole = estimate(roundTrip(session()));
        const reduced = estimate(roundTrip(session().map(providerVisibleMessage)));
        expect(reduced.tokens).toBe(whole.tokens);
        expect(reduced.messageTokens).toEqual(whole.messageTokens);
        expect(whole.tokens).toBeGreaterThan(0);
    });

    it("gives OpenCode 2 the same messages when a reduced replay is committed", () => {
        const host = (): SessionContext => ({
            sessionID: "ses-v2",
            model: { providerID: "anthropic", id: "claude-sonnet-4-5" },
            agent: "build",
            system: [],
            tools: {},
            options: {},
            messages: [
                { id: "u1", role: "user", content: [{ type: "text", text: "ask me" }] },
                {
                    id: "a1",
                    role: "assistant",
                    content: [
                        { type: "text", text: "Asking." },
                        { type: "tool-call", id: "q1", name: "question", input: { q: "which?" } },
                        { type: "tool-call", id: "b1", name: "bash", input: { command: "ls" } },
                    ],
                },
                {
                    role: "tool",
                    content: [
                        {
                            type: "tool-result",
                            id: "q1",
                            name: "question",
                            result: { type: "text", value: "the first" },
                        },
                        {
                            type: "tool-result",
                            id: "b1",
                            name: "bash",
                            result: { type: "text", value: "a.ts" },
                        },
                    ],
                },
                { id: "u2", role: "user", content: [{ type: "text", text: "go on" }] },
            ] as V2Message[],
        });
        const commit = (reduce: boolean): unknown => {
            const draft = host();
            const mapped = adaptPayload(draft);
            // The projection marks the question result as a user answer in its
            // tool metadata: the field the reduction removes.
            expect(JSON.stringify(mapped.messages)).toContain("userAnswer");
            const replayed = roundTrip(
                reduce
                    ? (mapped.messages as unknown as MessageLike[]).map(providerVisibleMessage)
                    : mapped.messages,
            );
            mapped.messages.splice(0, mapped.messages.length, ...(replayed as never[]));
            mapped.commit();
            return roundTrip(draft.messages);
        };
        const whole = commit(false);
        expect(JSON.stringify(whole)).toContain("the first");
        expect(commit(true)).toEqual(whole);
    });
});
