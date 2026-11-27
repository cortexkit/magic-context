/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import {
    createFailClosedController,
    FAIL_CLOSED_DOCTOR_COMMAND,
    isFailClosedBlockingError,
} from "../features/magic-context/fail-closed-block";
import { getOrCreateSessionMeta, updateSessionMeta } from "../features/magic-context/storage";
import {
    __resetSchemaFenceStateForTests,
    closeDatabase,
    getPersistedSchemaVersion,
    initializeDatabase,
    LATEST_SUPPORTED_VERSION,
    openDatabase,
} from "../features/magic-context/storage-db";
import {
    addTrailingBlankDecisions,
    recordDetectedContextLimit,
    recordOverflowDetected,
    resetEmergencyRecoveryRegistryForTest,
} from "../features/magic-context/storage-meta-persisted";
import {
    __resetToolDefinitionMeasurements,
    recordToolDefinition,
} from "../features/magic-context/tool-definition-tokens";
import { DegradedPassRefusalError } from "../hooks/magic-context/degraded-pass-refusal";
import { EmergencyFailClosedError } from "../hooks/magic-context/emergency-fail-closed";
import {
    clearLkgMeasuredRequest,
    noteLkgProviderResponse,
} from "../hooks/magic-context/lkg-measured-request";
import { saveLkgSlotToDb } from "../hooks/magic-context/lkg-persist";
import { captureLkgSlot } from "../hooks/magic-context/lkg-replay";
import { dropSlot, getSlot } from "../hooks/magic-context/lkg-slot";
import { RawFallbackContextLimitError } from "../hooks/magic-context/raw-fallback-context-limit";
import {
    STORAGE_BUSY_MESSAGE,
    StorageBusyRefusalError,
} from "../hooks/magic-context/storage-busy-refusal";
import { finalizeMessageRepresentation } from "../hooks/magic-context/transform-postprocess-phase";
import { UnmanagedOverWindowError } from "../hooks/magic-context/unmanaged-over-window";
import { UnresolvedHistoryBoundaryError } from "../hooks/magic-context/unresolved-history-boundary";
import * as logger from "../shared/logger";
import { Database } from "../shared/sqlite";
import {
    AssistantTerminalRetryError,
    createMessagesTransformHandler,
    IncompleteUserMessageError,
} from "./messages-transform";

afterEach(() => {
    resetEmergencyRecoveryRegistryForTest();
});

describe("TypeScript wrapper measured LKG admission", () => {
    for (const [label, inputTokens, tailText, serves] of [
        ["small measured tail is served", 633_258, "continue", true],
        [
            "near-limit measured input plus a big tail is refused",
            871_000,
            "big tail ".repeat(20_000),
            false,
        ],
        ["unmeasured request uses the full estimate", 0, "continue", false],
    ] as const) {
        it(label, async () => {
            const sessionId = `ts-measured-${inputTokens}`;
            const model = { providerID: "wrapper-fit", modelID: "unknown-tokenizer" };
            const modelKey = `${model.providerID}/${model.modelID}`;
            const db = openDatabase();
            if (!db) throw new Error("throwaway database unavailable");
            getOrCreateSessionMeta(db, sessionId);
            updateSessionMeta(db, sessionId, { systemPromptTokens: 100 });
            recordDetectedContextLimit(db, sessionId, 872_000, modelKey);
            recordToolDefinition(
                model.providerID,
                model.modelID,
                undefined,
                "read",
                "read fixture",
                {},
            );
            const raw = [
                {
                    info: {
                        id: "input",
                        role: "user",
                        sessionID: sessionId,
                        model,
                        time: { created: 1 },
                    },
                    parts: [{ type: "text", text: "x ".repeat(500_000) }],
                },
            ];
            const served = structuredClone(raw);
            served[0]!.parts[0]!.text += " transformed prefix";
            noteLkgProviderResponse({ sessionId, modelKey, responseId: "reply", inputTokens: 0 });
            expect(
                captureLkgSlot({
                    sessionId,
                    input: raw as never,
                    output: served as never,
                    modelKey,
                    providerKey: model.providerID,
                    systemPromptTokens: 100,
                }),
            ).toBe(true);
            expect(
                saveLkgSlotToDb(db, sessionId, getSlot(sessionId)!, undefined, { rebuild: true }),
            ).toBe(true);
            if (inputTokens)
                noteLkgProviderResponse({
                    sessionId,
                    modelKey,
                    responseId: "reply",
                    inputTokens,
                    finish: "stop",
                });
            const tail = [
                {
                    info: {
                        id: "reply",
                        role: "assistant",
                        sessionID: sessionId,
                        time: { created: 2 },
                    },
                    parts: [{ type: "text", text: "small reply" }],
                },
                {
                    info: {
                        id: "next",
                        role: "user",
                        sessionID: sessionId,
                        model,
                        time: { created: 3 },
                    },
                    parts: [{ type: "text", text: tailText }],
                },
            ];
            const output = { messages: [...raw, ...tail] };
            let replayed = false;
            const handler = createMessagesTransformHandler({
                magicContext: {
                    "experimental.chat.messages.transform": async () => {
                        throw new StorageBusyRefusalError(
                            new Error("fixture busy"),
                            "typescript-transform",
                        );
                    },
                },
                rustReplayParticipant: () => null,
                onLkgReplay: () => {
                    replayed = true;
                },
            });
            try {
                if (serves) {
                    await handler({}, output as never);
                    expect(output.messages).toEqual([...served, ...tail]);
                } else
                    await expect(handler({}, output as never)).rejects.toBeInstanceOf(
                        StorageBusyRefusalError,
                    );
                expect(replayed).toBe(serves);
            } finally {
                dropSlot(sessionId);
                clearLkgMeasuredRequest(sessionId);
                __resetToolDefinitionMeasurements();
                closeDatabase();
            }
        });
    }
});

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

describe("createMessagesTransformHandler — refusal notices", () => {
    for (const [refusal, notice] of [
        [
            new DegradedPassRefusalError("image-strip-exception", {
                cause: new Error("strip failed"),
            }),
            "Magic Context could not safely prepare this turn [MC-S06] (image-strip-exception: strip failed). This request was not sent.",
        ],
        [new UnresolvedHistoryBoundaryError(6_200_000, 500_000), /(MC-H04)/],
        [new UnmanagedOverWindowError(6_200_000, 500_000), /(MC-H06)/],
        [
            new EmergencyFailClosedError("Emergency recovery failed"),
            "Emergency recovery failed [EMERGENCY_FAIL_CLOSED]",
        ],
        [new RawFallbackContextLimitError(3_300_000, 1_000_000), /\[RAW_FALLBACK_CONTEXT_LIMIT\]$/],
        [new AssistantTerminalRetryError(), /\[ASSISTANT_TERMINAL_RETRY\]$/],
        [
            new StorageBusyRefusalError(new Error("fixture busy"), "messages-transform"),
            `${STORAGE_BUSY_MESSAGE} [STORAGE_BUSY_REFUSAL]`,
        ],
    ] as const) {
        it(`notifies before rejecting with ${refusal.name}`, async () => {
            const onRefusal = mock(
                async (_sessionId: string, _message: string, _refusal: Error) => {},
            );
            const args = {
                magicContext: {
                    "experimental.chat.messages.transform": async () => {
                        throw refusal;
                    },
                },
                onRefusal,
            };
            const output = makeOutput();
            const before = structuredClone(output);

            await expect(createMessagesTransformHandler(args)({}, output)).rejects.toBe(refusal);

            expect(onRefusal).toHaveBeenCalledTimes(1);
            expect(onRefusal.mock.calls[0]).toEqual([
                "ses_test",
                typeof notice === "string" ? notice : expect.stringMatching(notice),
                refusal,
            ]);
            expect(output).toEqual(before);
        });
    }

    it("logs a failed notice and still rejects with the original refusal", async () => {
        const refusal = new DegradedPassRefusalError("failed-strip");
        const deliveryError = new Error("notification unavailable");
        const log = spyOn(logger, "sessionLog");
        const onRefusal = mock(async () => {
            throw deliveryError;
        });
        const args = {
            magicContext: {
                "experimental.chat.messages.transform": async () => {
                    throw refusal;
                },
            },
            onRefusal,
        };

        try {
            await expect(createMessagesTransformHandler(args)({}, makeOutput())).rejects.toBe(
                refusal,
            );
            expect(onRefusal).toHaveBeenCalledTimes(1);
            expect(log).toHaveBeenCalledWith(
                "ses_test",
                "host refusal notice failed:",
                deliveryError,
            );
        } finally {
            log.mockRestore();
        }
    });
});

describe("createMessagesTransformHandler — error boundary (issue #23)", () => {
    it("refuses SQLITE_BUSY without LKG instead of sending raw", async () => {
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
        await expect(handler({}, output)).rejects.toThrow("Magic Context's database is busy");

        // Messages are left untouched when transform fails.
        expect(output.messages).toHaveLength(1);
        expect(output.messages[0].info.id).toBe("m1");
    });

    it("fails closed instead of serving raw when emergency recovery meets SQLITE_BUSY", async () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        recordOverflowDetected(db, "ses_test", 100_000, "anthropic/fable-5-1");
        const handler = createMessagesTransformHandler({
            magicContext: {
                "experimental.chat.messages.transform": async () => {
                    const err = new Error("database is locked") as Error & { code: string };
                    err.code = "SQLITE_BUSY";
                    throw err;
                },
            },
        });

        try {
            await expect(handler({}, makeOutput())).rejects.toBeInstanceOf(StorageBusyRefusalError);
        } finally {
            db.close();
        }
    });

    it("refuses unexpected non-SQLITE errors without a last-good replay", async () => {
        const handler = createMessagesTransformHandler({
            magicContext: {
                "experimental.chat.messages.transform": async () => {
                    throw new TypeError("unexpected undefined access");
                },
            },
        });

        const output = makeOutput();
        await expect(handler({}, output)).rejects.toMatchObject({
            name: "DegradedPassRefusalError",
            site: "messages-transform-failed",
            cause: new TypeError("unexpected undefined access"),
        });
    });

    it("refuses ordinary errors after partial mutation even without a session id", async () => {
        const handler = createMessagesTransformHandler({
            magicContext: {
                "experimental.chat.messages.transform": async (_input, output) => {
                    output.messages[0].parts.length = 0;
                    throw new Error("half replayed");
                },
            },
        });
        const output = makeOutput();
        delete output.messages[0].info.sessionID;
        await expect(handler({}, output)).rejects.toBeInstanceOf(DegradedPassRefusalError);
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

    it("refuses an uncut over-window request when no last good request can stand in", async () => {
        // Unlike an ordinary transform error, this one must not fall through to
        // the input messages: they are the same uncut, over-window
        // conversation the transform refused to send.
        const handler = createMessagesTransformHandler({
            magicContext: {
                "experimental.chat.messages.transform": async () => {
                    throw new UnresolvedHistoryBoundaryError(6_200_000, 500_000);
                },
            },
        });

        const refusal = handler({}, makeOutput());
        await expect(refusal).rejects.toBeInstanceOf(UnresolvedHistoryBoundaryError);
        await expect(refusal).rejects.toThrow("(MC-H04)");
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

    it("refuses SQLITE_BUSY even while fail-closed is unarmed", async () => {
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
        await expect(handler({}, output)).rejects.toThrow("Magic Context's database is busy");
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

/**
 * A long-lived process opened context.db while its schema was within this
 * build's fence, then another process migrated it past that fence. The process
 * keeps its cached handle, and its inner transform writes through that handle
 * (replay decisions, LKG slots). The per-pass admission open re-runs the fence
 * against the cached handle; a rejection there must stop the pass before any
 * write, not just skip the admission.
 */
describe("createMessagesTransformHandler — schema fence on a cached handle", () => {
    const FENCE_ENV = "MAGIC_CONTEXT_LATEST_SUPPORTED_VERSION";
    let savedFence: string | undefined;

    function openStaleProcessDb(): Database {
        closeDatabase();
        __resetSchemaFenceStateForTests();
        // This open migrates the throwaway test database to the current schema
        // and caches the handle, as a process does at startup.
        const db = openDatabase();
        if (!db) throw new Error("test database did not open");
        expect(getPersistedSchemaVersion(db)).toBe(LATEST_SUPPORTED_VERSION);
        // From here on this process behaves like the previous build: its code
        // fence is one version below the schema another process migrated to.
        savedFence = process.env[FENCE_ENV];
        process.env[FENCE_ENV] = String(LATEST_SUPPORTED_VERSION - 1);
        return db;
    }

    afterEach(() => {
        if (savedFence === undefined) delete process.env[FENCE_ENV];
        else process.env[FENCE_ENV] = savedFence;
        savedFence = undefined;
        closeDatabase();
        __resetSchemaFenceStateForTests();
    });

    function writingTransform(db: Database, calls: { inner: number }) {
        return {
            "experimental.chat.messages.transform": async () => {
                calls.inner += 1;
                addTrailingBlankDecisions(db, "ses_test", [["assistant-stale", "strip"]]);
            },
        };
    }

    function decisionRows(db: Database): number {
        return (
            db
                .prepare("SELECT COUNT(*) AS n FROM session_replay_decisions WHERE session_id = ?")
                .get("ses_test") as { n: number }
        ).n;
    }

    it("blocks the turn before the inner transform writes, and keeps blocking", async () => {
        const db = openStaleProcessDb();
        const calls = { inner: 0 };
        const failClosed = createFailClosedController();
        const handler = createMessagesTransformHandler({
            magicContext: writingTransform(db, calls),
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
        expect(failClosed.getReason()).toEqual({
            kind: "schema_fence",
            persistedVersion: LATEST_SUPPORTED_VERSION,
            supportedVersion: LATEST_SUPPORTED_VERSION - 1,
        });
        await expect(handler({}, makeOutput())).rejects.toThrow();
        expect(calls.inner).toBe(0);
        expect(decisionRows(db)).toBe(0);
    });

    it("passes the input through without writing when blocking is disabled", async () => {
        const db = openStaleProcessDb();
        const calls = { inner: 0 };
        const handler = createMessagesTransformHandler({
            magicContext: writingTransform(db, calls),
            failClosed: createFailClosedController(),
            failClosedBlockingEnabled: false,
        });
        const output = makeOutput();
        await handler({}, output);
        expect(calls.inner).toBe(0);
        expect(decisionRows(db)).toBe(0);
        expect(output.messages).toHaveLength(1);
        expect(output.messages[0].info.id).toBe("m1");
    });

    it("still runs the inner transform while the schema is within the fence", async () => {
        const db = openStaleProcessDb();
        process.env[FENCE_ENV] = String(LATEST_SUPPORTED_VERSION);
        const calls = { inner: 0 };
        const handler = createMessagesTransformHandler({
            magicContext: writingTransform(db, calls),
            failClosed: createFailClosedController(),
            failClosedBlockingEnabled: true,
        });
        await handler({}, makeOutput());
        expect(calls.inner).toBe(1);
        expect(decisionRows(db)).toBe(1);
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

describe("incomplete arriving user message", () => {
    for (const compactionOff of [false, true]) {
        it(`refuses user:none before transform or fallback (compactionOff=${compactionOff})`, async () => {
            let calls = 0;
            const handler = createMessagesTransformHandler({
                compactionOff,
                magicContext: {
                    "experimental.chat.messages.transform": async () => {
                        calls++;
                    },
                },
            });
            const output = makeOutput();
            output.messages[0].parts = [];
            const before = JSON.stringify(output);
            await expect(handler({}, output)).rejects.toBeInstanceOf(IncompleteUserMessageError);
            expect(calls).toBe(0);
            expect(JSON.stringify(output)).toBe(before);
        });
    }
    for (const [name, mutate] of [
        ["text", () => {}],
        [
            "file only",
            (m: any) => {
                m.parts = [{ type: "file", mime: "image/png", url: "data:image/png;base64,AA==" }];
            },
        ],
        [
            "tool result only",
            (m: any) => {
                m.parts = [{ type: "tool", state: { status: "completed", output: "result" } }];
            },
        ],
        [
            "synthetic m[0]/m[1]",
            (m: any) => {
                delete m.info.id;
                m.parts = [];
            },
        ],
        [
            "summary",
            (m: any) => {
                m.info.summary = true;
                m.parts = [];
            },
        ],
        [
            "compaction",
            (m: any) => {
                m.parts = [{ type: "compaction", auto: true }];
            },
        ],
        [
            "assistant tool continuation",
            (m: any) => {
                m.info.role = "assistant";
                m.parts = [{ type: "tool", state: { status: "completed", output: "result" } }];
            },
        ],
    ] as const) {
        it(`passes ${name} unchanged`, async () => {
            let calls = 0;
            const handler = createMessagesTransformHandler({
                magicContext: {
                    "experimental.chat.messages.transform": async () => {
                        calls++;
                    },
                },
            });
            const output = makeOutput();
            mutate(output.messages[0]);
            const before = JSON.stringify(output);
            await handler({}, output);
            expect(calls).toBe(1);
            expect(JSON.stringify(output)).toBe(before);
        });
    }
});
