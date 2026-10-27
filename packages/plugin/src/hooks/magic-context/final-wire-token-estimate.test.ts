import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    __resetToolDefinitionMeasurements,
    getSessionToolDefinitionTokens,
    loadToolDefinitionMeasurements,
    recordToolDefinition,
    setDatabase,
} from "../../features/magic-context/tool-definition-tokens";
import * as logger from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { outgoingContextRefusal } from "./emergency-fail-closed";
import {
    createFinalWireUsageTracker,
    describeFinalWireTail,
    estimateFinalWireInputTokens,
    estimateOutgoingWireForRefusal,
    type FinalWireTokenEstimate,
} from "./final-wire-token-estimate";
import { estimateTokens } from "./read-session-formatting";
import type { MessageLike } from "./tag-messages";

const MODEL = { providerID: "test-provider", modelID: "test-model", agentName: "build" };

afterEach(() => __resetToolDefinitionMeasurements());

it("healthy refusal settles over and under byte bounds without token counts", () => {
    recordToolDefinition(MODEL.providerID, MODEL.modelID, MODEL.agentName, "read", "Read", {});
    const huge = estimateOutgoingWireForRefusal(
        {
            messages: [toolMessage("x".repeat(12 * 1024 * 1024 + 1000))],
            systemPromptTokens: 100,
            ...MODEL,
        },
        16000,
    );
    expect(huge.refusalBasis).toBe("byte-bound");
    expect(huge.refusalGrade).toBe(true);
    expect(huge.messageTokens).toEqual({ conversation: 0, toolCall: 0 });
    const small = estimateOutgoingWireForRefusal(
        { messages: [toolMessage("x".repeat(4000))], systemPromptTokens: 100, ...MODEL },
        16000,
    );
    expect(small.refusalBasis).toBe("byte-bound");
    expect(small.refusalGrade).toBe(false);
    expect(small.messageTokens).toEqual({ conversation: 0, toolCall: 0 });
});

it("uncertain refusal bounds pathological text without changing shared tokenization", () => {
    const ordinary = estimateTokens("ordinary words");
    recordToolDefinition(MODEL.providerID, MODEL.modelID, MODEL.agentName, "read", "Read", {});
    const text = "x".repeat(16385);
    const startedAt = performance.now();
    const result = estimateOutgoingWireForRefusal(
        { messages: [toolMessage(text)], systemPromptTokens: 100, ...MODEL },
        10000,
    );
    expect(result.messageTokens.toolCall).toBeGreaterThanOrEqual(Buffer.byteLength(text));
    expect(result.refusalGrade).toBe(false);
    expect(performance.now() - startedAt).toBeLessThan(1000);
    expect(estimateTokens("ordinary words")).toBe(ordinary);
});

it("borrowed tool definitions and family fallback are admission-only even on complete over-limit envelopes", () => {
    // The session's last request flew another route; this route is unmeasured.
    recordToolDefinition("other", "route", "build", "probe", "word ".repeat(20000), {}, "session");
    const messages = [toolMessage("word ".repeat(20000))];
    const borrowed = estimateFinalWireInputTokens({
        messages,
        systemPromptTokens: 100,
        providerID: "anthropic",
        modelID: "claude-fable-5-1",
        agentName: "build",
        sessionId: "session",
    });
    expect(borrowed.trusted).toBe(true);
    expect(borrowed.tokens).toBeGreaterThan(16000);
    expect(borrowed.toolDefinitionsMeasured).toBe(false);
    expect(borrowed.refusalGrade).toBe(false);
    expect(outgoingContextRefusal(borrowed, 16000)).toBeUndefined();
    recordToolDefinition("anthropic", "claude-fable-5-2", "build", "probe", "A probe", {});
    const inherited = estimateFinalWireInputTokens({
        messages,
        systemPromptTokens: 100,
        providerID: "anthropic",
        modelID: "claude-fable-5-2",
        agentName: "build",
    });
    expect(inherited.trusted).toBe(true);
    expect(inherited.toolDefinitionsMeasured).toBe(true);
    expect(inherited.refusalGrade).toBe(false);
    expect(outgoingContextRefusal(inherited, 16000)).toBeUndefined();
});

it("OpenCode correlated provider usage wins over full-prefix estimates and rejects stale evidence", () => {
    const route = { providerID: "anthropic", modelID: "claude-fable-5-1", agentName: "build" };
    recordToolDefinition(route.providerID, route.modelID, route.agentName, "probe", "A probe", {});
    const tracker = createFinalWireUsageTracker();
    const prefix = [
        {
            info: { id: "input", role: "user" },
            parts: [{ type: "text", text: "word ".repeat(20000) }],
        },
    ] as MessageLike[];
    const envelope = { systemPromptTokens: 100, systemPromptHash: "system-v1", ...route };
    tracker.capture("session", { messages: prefix, ...envelope });
    const reply = {
        info: {
            id: "reply",
            role: "assistant",
            parentID: "input",
            ...route,
            finish: "stop",
            time: { completed: Date.now() + 1 },
            tokens: { input: 100, cache: { read: 20, write: 10 } },
        },
        parts: [{ type: "text", text: "New reply" }],
    } as unknown as MessageLike;
    const messages = [...prefix, reply];
    const measured = tracker.estimate("session", { messages, ...envelope });
    expect(measured.tokens).toBeGreaterThan(16000);
    expect(measured.refusalBasis).toBe("provider-prefix");
    expect(measured.refusalTokens).toBeGreaterThanOrEqual(130);
    expect(measured.refusalTokens).toBeLessThan(200);
    expect(outgoingContextRefusal(measured, 16000)).toBeUndefined();
    for (const input of [
        { messages, ...envelope, systemPromptHash: "system-v2" },
        {
            messages: [{ ...prefix[0], parts: [{ type: "text", text: "changed prefix" }] }, reply],
            ...envelope,
        },
        {
            messages: [...prefix, { ...reply, info: { ...reply.info, parentID: "other" } }],
            ...envelope,
        },
        {
            messages: [...prefix, { ...reply, info: { ...reply.info, providerID: "other" } }],
            ...envelope,
        },
    ])
        expect(tracker.estimate("session", input).refusalBasis).toBe("calibrated");
    recordToolDefinition(
        route.providerID,
        route.modelID,
        route.agentName,
        "probe",
        "Changed schema",
        {},
    );
    expect(tracker.estimate("session", { messages, ...envelope }).refusalBasis).toBe("calibrated");
});

it("rows reloaded at startup stop disabling provider-measured evidence once the route flies", () => {
    // Before a restart the route offered read and lsp. After it, the host
    // offers only read: the reloaded lsp row, whose content this process never
    // measured, must not keep every later request from reusing provider usage.
    const route = { providerID: "anthropic", modelID: "claude-fable-5-1", agentName: "build" };
    const db = new Database(":memory:");
    try {
        initializeDatabase(db);
        runMigrations(db);
        setDatabase(db);
        for (const tool of ["read", "lsp"])
            recordToolDefinition(route.providerID, route.modelID, route.agentName, tool, tool, {});
        __resetToolDefinitionMeasurements();
        loadToolDefinitionMeasurements(db);
        setDatabase(db);
        recordToolDefinition(route.providerID, route.modelID, route.agentName, "read", "read", {});
        const tracker = createFinalWireUsageTracker();
        const prefix = [
            { info: { id: "input", role: "user" }, parts: [{ type: "text", text: "hello" }] },
        ] as MessageLike[];
        const envelope = { systemPromptTokens: 100, systemPromptHash: "system-v1", ...route };
        tracker.capture("restarted", { messages: prefix, ...envelope });
        const reply = {
            info: {
                id: "reply",
                role: "assistant",
                parentID: "input",
                ...route,
                finish: "stop",
                time: { completed: Date.now() + 1 },
                tokens: { input: 100, cache: { read: 20, write: 10 } },
            },
            parts: [{ type: "text", text: "New reply" }],
        } as unknown as MessageLike;
        const measured = tracker.estimate("restarted", {
            messages: [...prefix, reply],
            ...envelope,
        });
        expect(measured.refusalBasis).toBe("provider-prefix");
    } finally {
        closeQuietly(db);
    }
});

it("signed requests use exact provider-prefix fit and emit one estimate drift line", () => {
    const route = { providerID: "anthropic", modelID: "claude-opus-5-5", agentName: "build" };
    recordToolDefinition(route.providerID, route.modelID, route.agentName, "probe", "A probe", {});
    const tracker = createFinalWireUsageTracker();
    const prefix = [
        {
            info: { id: "signed", role: "assistant" },
            parts: [
                {
                    type: "thinking",
                    thinking: "A kept thought",
                    signature: "opaque".repeat(50_000),
                },
            ],
        },
        { info: { id: "input", role: "user" }, parts: [{ type: "text", text: "Continue" }] },
    ] as unknown as MessageLike[];
    const envelope = { ...route, systemPromptTokens: 100, systemPromptHash: "stable" };
    tracker.capture("signed-session", { ...envelope, messages: prefix });
    const reply = {
        info: {
            id: "reply",
            role: "assistant",
            parentID: "input",
            ...route,
            finish: "tool-calls",
            time: { completed: Date.now() + 1 },
            tokens: { input: 657_477, cache: { read: 0, write: 0 } },
        },
        parts: [{ type: "thinking", thinking: "Next thought", signature: "opaque".repeat(50_000) }],
    } as unknown as MessageLike;
    const log = spyOn(logger, "sessionLog");
    try {
        const estimate = tracker.estimate("signed-session", {
            ...envelope,
            messages: [...prefix, reply],
        });
        expect(estimate.refusalBasis).toBe("provider-prefix");
        expect(estimate.refusalTokens).toBeGreaterThanOrEqual(657_477);
        expect(estimate.refusalTokens).toBeLessThan(658_477);
        const drift = log.mock.calls.filter((call) =>
            String(call[1]).includes("thinking estimate drift:"),
        );
        expect(drift).toHaveLength(1);
        expect(String(drift[0]?.[1])).toContain("provider=657477 ratio=");
        tracker.capture("signed-session", { ...envelope, messages: [...prefix, reply] });
        expect(
            log.mock.calls.filter((call) => String(call[1]).includes("thinking estimate drift:")),
        ).toHaveLength(1);
        log.mockClear();
        const warm = createFinalWireUsageTracker();
        warm.capture("warm-session", { ...envelope, messages: prefix });
        const changed = structuredClone(prefix);
        (changed[0]!.parts[0] as { thinking: string }).thinking = "Changed head on this request";
        warm.capture("warm-session", {
            ...envelope,
            messages: [
                ...changed,
                {
                    ...reply,
                    info: { ...reply.info, time: { completed: Date.now() + 1 } },
                } as unknown as MessageLike,
            ],
        });
        expect(
            log.mock.calls.filter((call) => String(call[1]).includes("thinking estimate drift:")),
        ).toHaveLength(1);
    } finally {
        log.mockRestore();
    }
});

it("opaque fallback telemetry logs once on execute and warm capture", () => {
    const route = { providerID: "anthropic", modelID: "claude-opus-5-5", agentName: "build" };
    recordToolDefinition(route.providerID, route.modelID, route.agentName, "probe", "A probe", {});
    const input = {
        ...route,
        systemPromptTokens: 100,
        systemPromptHash: "stable",
        messages: [
            { info: { id: "input", role: "user" }, parts: [{ type: "text", text: "Continue" }] },
            {
                info: { id: "hidden", role: "assistant" },
                parts: [{ type: "thinking", thinking: "", signature: "opaque" }],
            },
        ] as unknown as MessageLike[],
    };
    const tracker = createFinalWireUsageTracker();
    const log = spyOn(logger, "sessionLog");
    try {
        tracker.estimate("opaque-session", input, 872_000);
        tracker.capture("opaque-session", input);
        expect(
            log.mock.calls.filter((call) => String(call[1]).includes("opaque thinking fallback:")),
        ).toHaveLength(1);
        log.mockClear();
        tracker.capture("opaque-session", input);
        expect(
            log.mock.calls.filter((call) => String(call[1]).includes("opaque thinking fallback:")),
        ).toHaveLength(1);
        expect(String(log.mock.calls[0]?.[1])).toContain("steps=1 tokensPerStep=1000");
    } finally {
        log.mockRestore();
    }
});

it("OpenCode measured preceding overflow does not refuse a fitting protected subset", () => {
    const route = { providerID: "anthropic", modelID: "claude-fable-5-1", agentName: "build" };
    recordToolDefinition(route.providerID, route.modelID, route.agentName, "probe", "A probe", {});
    const tracker = createFinalWireUsageTracker();
    const envelope = { systemPromptTokens: 100, systemPromptHash: "system-v1", ...route };
    const prefix = [
        { info: { id: "input", role: "user" }, parts: [{ type: "text", text: "hello" }] },
    ] as MessageLike[];
    tracker.capture("session", { messages: prefix, ...envelope });
    const reply = {
        info: {
            id: "reply",
            role: "assistant",
            parentID: "input",
            ...route,
            finish: "stop",
            time: { completed: Date.now() + 1 },
            tokens: { input: 15000, cache: { read: 900, write: 200 } },
        },
        parts: [{ type: "text", text: "hello" }],
    } as unknown as MessageLike;
    const estimate = tracker.estimate("session", { messages: [...prefix, reply], ...envelope });
    expect(estimate.tokens).toBeLessThan(1000);
    expect(estimate.refusalTokens).toBeGreaterThan(16000);
    expect(outgoingContextRefusal(estimate, 16000, 0)).toBeUndefined();
    expect(outgoingContextRefusal(estimate, 16000, 10)).toBeUndefined();
});

function estimate(messages: MessageLike[]): FinalWireTokenEstimate {
    recordToolDefinition(MODEL.providerID, MODEL.modelID, MODEL.agentName, "read", "Read a file", {
        type: "object",
        properties: { path: { type: "string" } },
    });
    return estimateFinalWireInputTokens({
        messages,
        systemPromptTokens: 10_000,
        ...MODEL,
    });
}

function toolMessage(output: string): MessageLike {
    return {
        info: { id: "tool-owner", role: "assistant" },
        parts: [
            {
                type: "tool",
                state: { input: { path: "large.log" }, output },
            },
        ],
    } as unknown as MessageLike;
}

describe("final outgoing-wire token estimate", () => {
    it("invalidates exact-content counts for in-place historical text and nested tool edits", () => {
        const row = toolMessage("cache original");
        const state = (row.parts[0] as { state: { input: { path: string }; output: string } })
            .state;
        const first = estimate([row]);
        expect(estimate(structuredClone([row]))).toEqual(first);
        state.input.path = "different/new/path.ts";
        state.output = "edited output with many additional words";
        expect(estimate([row]).messageTokens.toolCall).toBe(
            estimateTokens(JSON.stringify(state.input)) + estimateTokens(state.output),
        );
        state.output = "cache original";
        state.input.path = "large.log";
        expect(estimate([row])).toEqual(first);
    });

    it("counts attachments still sent with a legacy dropped skeleton", () => {
        const row = toolMessage("[dropped §7§]");
        const state = (row.parts[0] as { state: { attachments?: unknown[] } }).state;
        const without = estimate([row]).messageTokens.toolCall;
        state.attachments = [
            { type: "file", mime: "image/png", url: "https://example.com/image.png" },
        ];
        expect(estimate([row]).messageTokens.toolCall - without).toBe(1200);
        state.attachments = [];
        expect(estimate([row]).messageTokens.toolCall).toBe(without);
    });
    it("describes the final three post-transform message tails compactly", () => {
        const messages = [
            { info: { role: "assistant" }, parts: [{ type: "text" }] },
            { info: { role: "user" }, parts: [{ type: "tool" }] },
            { info: { role: "assistant" }, parts: [{ type: "tool" }, { type: "text" }] },
            { info: { role: "user" }, parts: [{ type: "tool_result" }] },
        ] as MessageLike[];

        expect(describeFinalWireTail(messages)).toBe(
            "[user:toolresult, assistant:tool+text, user:toolresult]",
        );
    });

    it("reflects a flushed pending drop in telemetry", () => {
        const largeOutput = Array.from({ length: 40_000 }, (_, index) => `token_${index}`).join(
            " ",
        );
        const message = toolMessage(largeOutput);
        const beforeDrop = estimate([message]);
        (message.parts[0] as { state: { output: string } }).state.output = "[dropped]";
        const afterDrop = estimate([message]);
        const inputLimit = Math.floor((beforeDrop.tokens + afterDrop.tokens) / 2.1);

        expect(beforeDrop.trusted).toBe(true);
        expect(afterDrop.tokens).toBeLessThan(inputLimit);
        expect(beforeDrop.tokens).toBeGreaterThan(inputLimit * 1.05);
    });

    it("reports telemetry for an unchanged rebuilt fold", () => {
        const unchanged = estimate([
            toolMessage(Array.from({ length: 20_000 }, (_, index) => `fold_${index}`).join(" ")),
        ]);
        const inputLimit = Math.floor(unchanged.tokens / 1.1);

        expect(unchanged.tokens).toBeGreaterThan(inputLimit);
    });

    it("counts every OpenCode 2 tool-part representation", () => {
        const convertedOutput = "converted-tool-output ".repeat(20_000);
        const result = estimate([
            {
                info: { id: "v2-parts", role: "assistant" },
                parts: [
                    { type: "tool-call", input: { path: "converted.log" } },
                    { type: "tool-result", result: { type: "text", value: convertedOutput } },
                    {
                        type: "tool-invocation",
                        args: { path: "legacy.log" },
                        result: convertedOutput,
                    },
                    { type: "tool_use", input: { path: "anthropic.log" } },
                    { type: "tool_result", content: convertedOutput },
                    {
                        type: "tool",
                        state: { input: { path: "native.log" }, output: convertedOutput },
                    },
                    {
                        type: "tool",
                        state: {
                            input: { path: "converted.log" },
                            content: [{ type: "text", text: convertedOutput }],
                        },
                    },
                ],
            } as unknown as MessageLike,
        ]);

        expect(result.trusted).toBe(true);
        expect(result.messageTokens.toolCall).toBeGreaterThan(100_000);
    });

    it("reports a compact completed recomp refresh", () => {
        const trimmed = estimate([
            {
                info: { id: "summary", role: "user" },
                parts: [
                    { type: "text", text: "<session-history>compact summary</session-history>" },
                ],
            } as MessageLike,
        ]);

        expect(trimmed.trusted).toBe(true);
        expect(trimmed.messageTokens.conversation).toBeGreaterThan(0);
    });
});

it("unknown-model fit inflates raw mass instead of admitting a locally-fitting request", () => {
    const result = estimate([
        {
            info: { id: "m", role: "user" },
            parts: [{ type: "text", text: "hello" }],
        } as MessageLike,
    ]);
    expect(result.tokens).toBeGreaterThanOrEqual(20000);
    expect(result.rawTokens).toBeLessThan(11000);
    expect(result.trusted).toBe(true);
});
it("uses a conservative measured tool-definition envelope when the current model is unmeasured", () => {
    recordToolDefinition(
        "test-provider",
        "measured-model",
        "build",
        "read",
        "A".repeat(4000),
        {},
        "switching-session",
    );
    const result = estimateFinalWireInputTokens({
        messages: [
            {
                info: { id: "m", role: "user" },
                parts: [{ type: "text", text: "hello" }],
            } as MessageLike,
        ],
        systemPromptTokens: 10_000,
        providerID: "test-provider",
        modelID: "unmeasured-model",
        agentName: "build",
        sessionId: "switching-session",
    });
    expect(result.trusted).toBe(true);
    expect(result.toolDefinitionTokens).toBeGreaterThanOrEqual(
        2 * (getSessionToolDefinitionTokens("switching-session") ?? 0),
    );
});

it("a route with no measurement never borrows another session's or the largest stored tool set", () => {
    // Another session's request on another route carried a very large tool set.
    recordToolDefinition(
        "test-provider",
        "measured-model",
        "build",
        "mcp_everything",
        "word ".repeat(20_000),
        {},
        "other-session",
    );
    const request = {
        messages: [
            {
                info: { id: "m", role: "user" },
                parts: [{ type: "text", text: "hello" }],
            } as MessageLike,
        ],
        systemPromptTokens: 10_000,
        providerID: "test-provider",
        modelID: "unmeasured-model",
        agentName: "build",
    };
    for (const result of [
        estimateFinalWireInputTokens({ ...request, sessionId: "new-session" }),
        estimateFinalWireInputTokens(request),
    ]) {
        expect(result.toolDefinitionsMeasured).toBe(false);
        expect(result.toolDefinitionTokens).toBeUndefined();
        // Pressure counts the request's own content only.
        expect(result.pressureTokens ?? 0).toBeLessThan(11_000);
        expect(result.trusted).toBe(false);
    }
});

it("unsupported nontext parts never produce a trusted fit estimate", () => {
    const result = estimate([
        {
            info: { id: "m", role: "user" },
            parts: [{ type: "audio", data: "unknown" }],
        } as unknown as MessageLike,
    ]);
    expect(result.trusted).toBe(false);
    expect(result.completeness).toBe("partial");
});
it("an inline image (like the memory mural in m[0]) keeps the estimate trusted", () => {
    const result = estimate([
        {
            info: { id: "m0", role: "user" },
            parts: [
                { type: "text", text: "<memory-mural>" },
                { type: "file", mime: "image/png", url: "data:image/png;base64,iVBORw0KGgo=" },
            ],
        } as unknown as MessageLike,
    ]);
    expect(result.trusted).toBe(true);
});

it("a non-image attachment still leaves the estimate untrusted", () => {
    const result = estimate([
        {
            info: { id: "m", role: "user" },
            parts: [{ type: "file", mime: "application/pdf", url: "file:///tmp/spec.pdf" }],
        } as unknown as MessageLike,
    ]);
    expect(result.trusted).toBe(false);
});

it("nonfinite system mass cannot be trusted even with known tool definitions", () => {
    estimate([]);
    const result = estimateFinalWireInputTokens({
        messages: [],
        ...MODEL,
        systemPromptTokens: Number.POSITIVE_INFINITY,
    });
    expect(result.trusted).toBe(false);
});
