/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import {
    createFailClosedController,
    FAIL_CLOSED_DOCTOR_COMMAND,
    isFailClosedBlockingError,
} from "../features/magic-context/fail-closed-block";
import { RawFallbackContextLimitError } from "../hooks/magic-context/raw-fallback-context-limit";
import { finalizeMessageRepresentation } from "../hooks/magic-context/transform-postprocess-phase";
import { createMessagesTransformHandler } from "./messages-transform";

// Minimal fake message shape — just needs info + parts.
function makeOutput(overrides?: { agent?: string; sessionID?: string }): any {
    return {
        messages: [
            {
                info: {
                    id: "m1",
                    role: "user",
                    sessionID: overrides?.sessionID ?? "ses_test",
                    ...(overrides?.agent ? { agent: overrides.agent } : {}),
                },
                parts: [{ type: "text", text: "hello" }],
            },
        ],
    };
}

describe("createMessagesTransformHandler — error boundary (issue #23)", () => {
    it("swallows SQLITE_BUSY from inner transform so prompt loop proceeds", async () => {
        const handler = createMessagesTransformHandler({
            magicContext: {
                "experimental.chat.messages.transform": async () => {
                    const err = new Error("database is locked") as Error & {
                        code: string;
                        errno: number;
                    };
                    err.code = "SQLITE_BUSY";
                    err.errno = 5;
                    throw err;
                },
            },
        });

        const output = makeOutput();
        // Should NOT throw — wrapper catches all errors.
        await expect(handler({}, output)).resolves.toBeDefined();

        // Messages are left untouched when transform fails.
        expect(output.messages).toHaveLength(1);
        expect(output.messages[0].info.id).toBe("m1");
    });

    it("swallows unexpected non-SQLITE errors too", async () => {
        const handler = createMessagesTransformHandler({
            magicContext: {
                "experimental.chat.messages.transform": async () => {
                    throw new TypeError("unexpected undefined access");
                },
            },
        });

        const output = makeOutput();
        await expect(handler({}, output)).resolves.toBeDefined();
    });

    it("surfaces an oversized raw-fallback refusal to the prompt loop", async () => {
        const handler = createMessagesTransformHandler({
            magicContext: {
                "experimental.chat.messages.transform": async () => {
                    throw new RawFallbackContextLimitError(3_300_000, 1_000_000);
                },
            },
        });

        await expect(handler({}, makeOutput())).rejects.toBeInstanceOf(
            RawFallbackContextLimitError,
        );
    });

    it("passes through non-error transforms normally", async () => {
        let called = false;
        const handler = createMessagesTransformHandler({
            magicContext: {
                "experimental.chat.messages.transform": async (_input, out) => {
                    called = true;
                    (out.messages as any).push({
                        info: { id: "injected", role: "user", sessionID: "ses_test" },
                        parts: [{ type: "text", text: "injected" }],
                    });
                },
            },
        });

        const output = makeOutput();
        await handler({}, output);
        expect(called).toBe(true);
        expect(output.messages).toHaveLength(2);
    });

    it("no-ops when magicContext is null (disabled plugin path)", async () => {
        const handler = createMessagesTransformHandler({ magicContext: null });
        const output = makeOutput();
        await expect(handler({}, output)).resolves.toBeDefined();
        expect(output.messages).toHaveLength(1);
    });
});

describe("createMessagesTransformHandler — fail-closed blocking (note #906)", () => {
    it("throws fence mismatch with both versions + recovery command on primary sessions", async () => {
        const failClosed = createFailClosedController();
        failClosed.arm({
            kind: "schema_fence",
            persistedVersion: 65,
            supportedVersion: 64,
        });
        let innerCalled = false;
        const handler = createMessagesTransformHandler({
            magicContext: {
                "experimental.chat.messages.transform": async () => {
                    innerCalled = true;
                },
            },
            failClosed,
            failClosedBlockingEnabled: true,
        });

        let thrown: unknown;
        try {
            await handler({}, makeOutput());
        } catch (error) {
            thrown = error;
        }
        expect(isFailClosedBlockingError(thrown)).toBe(true);
        const message = thrown instanceof Error ? thrown.message : String(thrown);
        expect(message).toContain("v65");
        expect(message).toContain("v64");
        expect(message).toContain(FAIL_CLOSED_DOCTOR_COMMAND);
        expect(innerCalled).toBe(false);
    });

    it("bypasses magic-context child sessions and OpenCode title/summary agents", async () => {
        const failClosed = createFailClosedController();
        failClosed.arm({
            kind: "schema_fence",
            persistedVersion: 65,
            supportedVersion: 64,
        });
        const internalChildSessions = new Set<string>(["ses_mc_child"]);
        let calls = 0;
        const handler = createMessagesTransformHandler({
            magicContext: {
                "experimental.chat.messages.transform": async () => {
                    calls += 1;
                },
            },
            failClosed,
            failClosedBlockingEnabled: true,
            internalChildSessions,
        });

        await expect(handler({}, makeOutput({ sessionID: "ses_mc_child" }))).resolves.toBeDefined();
        await expect(handler({}, makeOutput({ agent: "title" }))).resolves.toBeDefined();
        await expect(handler({}, makeOutput({ agent: "summary" }))).resolves.toBeDefined();
        expect(calls).toBe(3);
    });

    it("still passes SQLITE_BUSY through unmodified while fail-closed is unarmed", async () => {
        const handler = createMessagesTransformHandler({
            magicContext: {
                "experimental.chat.messages.transform": async () => {
                    const err = new Error("database is locked") as Error & { code: string };
                    err.code = "SQLITE_BUSY";
                    throw err;
                },
            },
            failClosed: createFailClosedController(),
            failClosedBlockingEnabled: true,
        });
        const output = makeOutput();
        await expect(handler({}, output)).resolves.toBeDefined();
        expect(output.messages[0].info.id).toBe("m1");
    });

    it("re-probe heals and resumes the inner transform without restart", async () => {
        const failClosed = createFailClosedController({ reprobeEveryN: 1 });
        failClosed.arm({ kind: "storage_failure", cause: "migration lock" });
        let openAttempts = 0;
        let innerCalls = 0;
        const handler = createMessagesTransformHandler({
            magicContext: null,
            getMagicContext: () =>
                openAttempts >= 1
                    ? {
                          "experimental.chat.messages.transform": async () => {
                              innerCalls += 1;
                          },
                      }
                    : null,
            failClosed,
            failClosedBlockingEnabled: true,
            tryReopenStorage: async () => {
                openAttempts += 1;
                return openAttempts >= 1;
            },
        });

        await expect(handler({}, makeOutput())).resolves.toBeDefined();
        expect(openAttempts).toBe(1);
        expect(innerCalls).toBe(1);
        expect(failClosed.isArmed()).toBe(false);
    });

    it("fail_closed_blocking=false restores degrade-silently pass-through", async () => {
        const failClosed = createFailClosedController();
        failClosed.arm({
            kind: "schema_fence",
            persistedVersion: 65,
            supportedVersion: 64,
        });
        const handler = createMessagesTransformHandler({
            magicContext: null,
            failClosed,
            failClosedBlockingEnabled: false,
        });
        await expect(handler({}, makeOutput())).resolves.toBeDefined();
    });
});

describe("createMessagesTransformHandler — compaction-off fail-closed inertness (issue #266 S3)", () => {
    it("storage-unavailable (armed fail-closed) degrades to passthrough: no throw, input messages unchanged", async () => {
        const failClosed = createFailClosedController();
        failClosed.arm({
            kind: "schema_fence",
            persistedVersion: 65,
            supportedVersion: 64,
        });
        let innerCalled = false;
        const handler = createMessagesTransformHandler({
            magicContext: {
                "experimental.chat.messages.transform": async () => {
                    innerCalled = true;
                },
            },
            failClosed,
            failClosedBlockingEnabled: true,
            compactionOff: true,
        });

        const output = makeOutput();
        // In compaction-off mode fail_closed_blocking is inert BY DESIGN: no
        // blocking error, no cancelled request — the input comes back as-is.
        await expect(handler({}, output)).resolves.toBeDefined();
        expect(innerCalled).toBe(false);
        expect(output.messages).toHaveLength(1);
        expect(output.messages[0].info.id).toBe("m1");
        expect((output.messages[0].parts[0] as { text: string }).text).toBe("hello");
    });

    it("an unexpected throw mid-pass restores the exact input messages (no partial mutation leaks)", async () => {
        const handler = createMessagesTransformHandler({
            magicContext: {
                "experimental.chat.messages.transform": async (_input, out) => {
                    // Mutate the array in place (as the real transform does),
                    // then blow up — the wrapper must hand back the INPUT.
                    (out.messages as unknown[]).unshift({
                        info: { id: "injected", role: "user", sessionID: "ses_test" },
                        parts: [{ type: "text", text: "injected head" }],
                    });
                    throw new TypeError("unexpected failure after partial mutation");
                },
            },
            compactionOff: true,
        });

        const output = makeOutput();
        await expect(handler({}, output)).resolves.toBeDefined();
        expect(output.messages).toHaveLength(1);
        expect(output.messages[0].info.id).toBe("m1");
    });

    it("SQLITE_BUSY also restores the input shape in compaction-off mode", async () => {
        const handler = createMessagesTransformHandler({
            magicContext: {
                "experimental.chat.messages.transform": async (_input, out) => {
                    (out.messages as unknown[]).push({
                        info: { id: "extra", role: "user", sessionID: "ses_test" },
                        parts: [{ type: "text", text: "extra" }],
                    });
                    const err = new Error("database is locked") as Error & { code: string };
                    err.code = "SQLITE_BUSY";
                    throw err;
                },
            },
            compactionOff: true,
        });

        const output = makeOutput();
        await expect(handler({}, output)).resolves.toBeDefined();
        expect(output.messages).toHaveLength(1);
        expect(output.messages[0].info.id).toBe("m1");
    });

    it("REGRESSION: with compaction ON the same armed fail-closed state still blocks loudly", async () => {
        const failClosed = createFailClosedController();
        failClosed.arm({
            kind: "schema_fence",
            persistedVersion: 65,
            supportedVersion: 64,
        });
        const handler = createMessagesTransformHandler({
            magicContext: null,
            failClosed,
            failClosedBlockingEnabled: true,
            compactionOff: false,
        });

        let thrown: unknown;
        try {
            await handler({}, makeOutput());
        } catch (error) {
            thrown = error;
        }
        expect(isFailClosedBlockingError(thrown)).toBe(true);
    });
});

describe("createMessagesTransformHandler — issue #327 wire tail", () => {
    it("keeps a user-ended input user-terminated when a pending blank assistant appears mid-pass", async () => {
        const handler = createMessagesTransformHandler({
            magicContext: {
                "experimental.chat.messages.transform": async (_input, out) => {
                    await Promise.resolve();
                    (out.messages as any).push({
                        info: {
                            id: "assistant-pending",
                            role: "assistant",
                            sessionID: "ses_test",
                        },
                        parts: [],
                    });
                    finalizeMessageRepresentation(out.messages as any, "anthropic", {
                        trailingBlankDecisions: new Map([["assistant-pending", "keep"]]),
                    });
                },
            },
        });
        const output = makeOutput();

        await handler({}, output);

        expect(output.messages.map((message: any) => message.info.role)).toEqual([
            "assistant",
            "user",
        ]);
        expect(output.messages.at(-1)?.info.id).toBe("m1");
        // Re-anchoring preserves the pending shell without letting `keep`
        // manufacture content that was absent from the harness object.
        expect(output.messages[0].parts).toEqual([]);
    });

    it("re-anchors a persisted error-only assistant shell without deleting it", async () => {
        let called = false;
        const handler = createMessagesTransformHandler({
            magicContext: {
                "experimental.chat.messages.transform": async () => {
                    called = true;
                },
            },
        });
        const output = makeOutput();
        output.messages.push({
            info: {
                id: "assistant-error-shell",
                role: "assistant",
                sessionID: "ses_test",
                error: { name: "APIError" },
            },
            parts: [{ type: "text", text: " \n\t" }],
        });

        await handler({}, output);

        expect(called).toBe(true);
        expect(output.messages.map((message: any) => message.info.id)).toEqual([
            "assistant-error-shell",
            "m1",
        ]);
    });

    it("rejects a completed assistant-terminal retry instead of reordering its prompt", async () => {
        let called = false;
        const handler = createMessagesTransformHandler({
            magicContext: {
                "experimental.chat.messages.transform": async () => {
                    called = true;
                },
            },
        });
        const output = makeOutput();
        output.messages.push({
            info: { id: "assistant-completed", role: "assistant", sessionID: "ses_test" },
            parts: [
                { type: "reasoning", text: "completed thought", signature: "sig" },
                {
                    type: "tool",
                    tool: "bash",
                    state: { status: "completed", input: {}, output: "done" },
                },
            ],
        });

        // Mid-turn continuation shape: the streaming assistant (with completed
        // tool parts) legitimately terminates the array. The wrapper must pass it
        // through untouched and still run the inner transform.
        await handler({}, output);
        expect(called).toBe(true);
        expect(output.messages.at(-1)?.info.id).toBe("assistant-completed");
    });

    it("rejects real content appended after the input user during an asynchronous pass", async () => {
        const handler = createMessagesTransformHandler({
            magicContext: {
                "experimental.chat.messages.transform": async (_input, out) => {
                    await Promise.resolve();
                    (out.messages as any).push({
                        info: {
                            id: "assistant-completed-late",
                            role: "assistant",
                            sessionID: "ses_test",
                        },
                        parts: [{ type: "text", text: "completed answer" }],
                    });
                },
            },
        });

        const output = makeOutput();
        await handler({}, output);
        // Completed content appended mid-transform stays exactly where OpenCode
        // put it — never reordered below its prompt, never refused.
        expect(output.messages.at(-1)?.info.id).toBe("assistant-completed-late");
    });
});

describe("createMessagesTransformHandler — user-tail removal defense", () => {
    it("restores the input user after an inner transform removes it behind an assistant", async () => {
        const handler = createMessagesTransformHandler({
            magicContext: {
                "experimental.chat.messages.transform": async (_input, out) => {
                    out.messages.pop();
                },
            },
        });
        const output = makeOutput();
        output.messages.unshift({
            info: { id: "assistant-before", role: "assistant", sessionID: "ses_test" },
            parts: [{ type: "text", text: "previous answer" }],
        });

        await handler({}, output);

        expect(output.messages.map((message: any) => message.info.role)).toEqual([
            "assistant",
            "user",
        ]);
        expect(output.messages.at(-1)?.info.id).toBe("m1");
    });
});
