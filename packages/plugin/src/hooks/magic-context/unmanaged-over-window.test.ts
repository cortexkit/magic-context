/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { createScheduler } from "../../features/magic-context/scheduler";
import {
    closeDatabase,
    openDatabase,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import {
    __resetToolDefinitionMeasurements,
    loadToolDefinitionMeasurements,
    recordToolDefinition,
    recordToolDefinitionSet,
} from "../../features/magic-context/tool-definition-tokens";
import type { ContextUsage } from "../../features/magic-context/types";
import { createMessagesTransformHandler } from "../../plugin/messages-transform";
import {
    clearModelsDevCache,
    refreshModelLimitsFromApi,
    setOutputReserveConfig,
} from "../../shared/models-dev-cache";
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import { resolveContextWindowGeometry, resolveTrustedContextLimit } from "./event-resolvers";
import * as wire from "./final-wire-token-estimate";
import { estimateFinalWireInputTokens } from "./final-wire-token-estimate";
import { resetLkgSlotsForTest } from "./lkg-slot";
import { createTransform } from "./transform";
import {
    isClearlyOverWindow,
    UNMANAGED_OVER_WINDOW_FACTOR,
    UnmanagedOverWindowError,
} from "./unmanaged-over-window";

// Issue 608: a session Magic Context has no state for (a fork whose parent
// left nothing to inherit, or a long session it meets for the first time)
// used to send its whole raw history on its first pass, whatever its size:
// nothing measured the request, because the usage reading is reset on a
// first pass and the over-limit refusals needed a provider-measured limit.

type Message = { info: Record<string, unknown>; parts: Array<Record<string, unknown>> };
type Output = Parameters<ReturnType<typeof createMessagesTransformHandler>>[1];

const PROVIDER = "openai";
const MODEL = "over-window-fixture";
const WINDOW = 40_000;
const LINE = "HISTORY-LINE the session kept working on the same module for hours\n";

/** Lines per turn that put ten turns between the window and the margin. */
const LINES_WITHIN_MARGIN = 285;

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    resetLkgSlotsForTest();
    __resetToolDefinitionMeasurements();
    closeDatabase();
    clearModelsDevCache();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) cleanupTestTempDir(dir);
    tempDirs.length = 0;
});

/** A history of `turns` user/assistant pairs, each carrying `linesPerTurn` lines. */
function history(sessionId: string, turns: number, linesPerTurn: number): Message[] {
    const messages: Message[] = [];
    for (let index = 0; index < turns; index++) {
        messages.push(
            {
                info: {
                    id: `u${index}`,
                    time: { created: index * 2 + 1 },
                    role: "user",
                    sessionID: sessionId,
                    model: { providerID: PROVIDER, modelID: MODEL },
                },
                parts: [{ type: "text", text: `turn ${index}\n${LINE.repeat(linesPerTurn)}` }],
            },
            {
                info: {
                    id: `a${index}`,
                    time: { created: index * 2 + 2 },
                    role: "assistant",
                    sessionID: sessionId,
                    providerID: PROVIDER,
                    modelID: MODEL,
                    finish: "stop",
                },
                parts: [{ type: "text", text: `answer ${index}` }],
            },
        );
    }
    messages.push({
        info: {
            id: "u-last",
            time: { created: turns * 2 + 1 },
            role: "user",
            sessionID: sessionId,
            model: { providerID: PROVIDER, modelID: MODEL },
        },
        parts: [{ type: "text", text: "the newest question" }],
    });
    return messages;
}

/** The history's local token count, as the over-window check counts it. */
function historyTokens(messages: Message[]): number {
    const estimate = estimateFinalWireInputTokens({
        messages: messages as never,
        systemPromptTokens: 0,
        providerID: PROVIDER,
        modelID: MODEL,
        agentName: undefined,
    });
    return estimate.messageTokens.conversation + estimate.messageTokens.toolCall;
}

/** The request's local count as the estimate gives it, tool-definition figure included. */
function requestTokens(messages: Message[], sessionId?: string): number {
    const estimate = estimateFinalWireInputTokens({
        messages: messages as never,
        systemPromptTokens: 0,
        providerID: PROVIDER,
        modelID: MODEL,
        agentName: undefined,
        sessionId,
    });
    return estimate.rawTokens ?? estimate.tokens;
}

/** Record a measured tool set of roughly `tokens` tokens for a route. */
function measureToolSet(
    providerID: string,
    modelID: string,
    tokens: number,
    sessionId?: string,
): void {
    recordToolDefinition(
        providerID,
        modelID,
        undefined,
        "big-tool",
        "word ".repeat(tokens),
        {},
        sessionId,
    );
}

async function knownWindowTransform(
    sessionId: string,
    usage?: Map<string, { usage: ContextUsage; updatedAt: number; hasUsageTokens: boolean }>,
    modelID = MODEL,
    replayFits?: () => boolean,
) {
    const { dir } = createTestTempDir("mc-unmanaged-over-window-");
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    // A catalog limit is what a session has before any provider measurement.
    await refreshModelLimitsFromApi({
        config: {
            providers: async () => ({
                data: {
                    providers: [
                        {
                            id: PROVIDER,
                            models: { [modelID]: { limit: { context: WINDOW, output: 1_024 } } },
                        },
                    ],
                },
            }),
        },
    });
    const transform = createTransform({
        tagger: createTagger(),
        scheduler: usage
            ? createScheduler({ executeThresholdPercentage: 65 })
            : { shouldExecute: mock(() => "defer" as const) },
        contextUsageMap: usage ?? new Map<string, { usage: ContextUsage; updatedAt: number }>(),
        db: openDatabase(),
        historyRefreshSessions: new Set<string>(),
        pendingMaterializationSessions: new Set<string>(),
        lastHeuristicsTurnId: new Map<string, string>(),
        clearReasoningAge: 50,
        protectedTokens: 0,
        historianRunnable: false,
        liveModelBySession: new Map([[sessionId, { providerID: PROVIDER, modelID }]]),
    });
    const handler = createMessagesTransformHandler({
        magicContext: { "experimental.chat.messages.transform": transform },
        replayFits,
    });
    return async (messages: Message[]) => {
        const output = { messages } as unknown as Output;
        await handler({}, output);
        return output.messages as unknown as Message[];
    };
}

for (const pass of ["carried over-window pass", "warm append"] as const) {
    it(`${pass} counts only this session's exact tools for the current model, without scaling`, async () => {
        // Run the control cases first so they are exercised even without the fix.
        for (const tools of [
            "none",
            "other-model",
            "other-provider",
            "other-session",
            "per-tool",
            "fits",
            "over",
        ]) {
            const sessionId = `ses-${pass.replaceAll(" ", "-")}-${tools}`;
            const usage = new Map<
                string,
                { usage: ContextUsage; updatedAt: number; hasUsageTokens: boolean }
            >();
            const serve = await knownWindowTransform(sessionId, usage);
            const limit = resolveTrustedContextLimit(PROVIDER, MODEL)!;
            const messages = history(sessionId, 0, 0);
            if (pass === "warm append") {
                await serve(history(sessionId, 0, 0));
                usage.set(sessionId, {
                    usage: { inputTokens: 1_000, percentage: (1_000 / limit) * 100 },
                    updatedAt: Date.now(),
                    hasUsageTokens: true,
                });
                messages.push({
                    info: { ...messages[0]!.info, id: "new-paste" },
                    parts: [{ type: "text", text: LINE.repeat(500) }],
                });
            } else {
                await expect(serve(history(sessionId, 20, 430))).rejects.toBeInstanceOf(
                    UnmanagedOverWindowError,
                );
            }
            const definition = {
                id: "big-tool",
                description: "word ".repeat(tools === "fits" ? 25_000 : WINDOW + 10_000),
                parameters: {},
            };
            // OpenCode 2 records the draft under its agent; the transform has no agent.
            if (tools === "per-tool") {
                recordToolDefinition(
                    PROVIDER,
                    MODEL,
                    "build",
                    definition.id,
                    definition.description,
                    definition.parameters,
                    sessionId,
                );
            } else if (tools !== "none") {
                recordToolDefinitionSet(
                    tools === "other-provider" ? "another-provider" : PROVIDER,
                    tools === "other-model" ? "another-model" : MODEL,
                    "build",
                    [definition],
                    tools === "other-session" ? `${sessionId}-sibling` : sessionId,
                );
            }
            const estimate = estimateFinalWireInputTokens({
                messages: messages as never,
                systemPromptTokens: 0,
                providerID: PROVIDER,
                modelID: MODEL,
                sessionId,
            });
            expect(estimate.toolDefinitionsMeasured).toBe(false);
            expect(historyTokens(messages)).toBeLessThan(limit);
            if (tools === "fits")
                expect(estimate.tokens).toBeGreaterThan(WINDOW * UNMANAGED_OVER_WINDOW_FACTOR);
            if (tools === "over") {
                await expect(serve(messages)).rejects.toBeInstanceOf(UnmanagedOverWindowError);
            } else {
                const served = await serve(messages);
                expect(served.at(-1)?.parts[0]?.text).toContain(
                    pass === "warm append" ? LINE.repeat(500) : "the newest question",
                );
            }
            closeDatabase();
            __resetToolDefinitionMeasurements();
        }
    }, 30_000);
}

async function prepareFitRequest(pass: "carried" | "warm", sessionId: string, modelID = MODEL) {
    const usage = new Map<
        string,
        { usage: ContextUsage; updatedAt: number; hasUsageTokens: boolean }
    >();
    // Test the admission check itself, not whether a previous request is a fallback.
    const serve = await knownWindowTransform(sessionId, usage, modelID, () => false);
    const initial = () =>
        history(sessionId, 0, 0).map((message) => ({
            ...message,
            info: { ...message.info, model: { providerID: PROVIDER, modelID } },
        }));
    const messages: Message[] = initial();
    if (pass === "warm") {
        await serve(initial());
        const limit = resolveTrustedContextLimit(PROVIDER, modelID)!;
        usage.set(sessionId, {
            usage: { inputTokens: 1_000, percentage: (1_000 / limit) * 100 },
            updatedAt: Date.now(),
            hasUsageTokens: true,
        });
        messages.push({
            info: { ...messages[0]!.info, id: "new-paste" },
            parts: [{ type: "text", text: LINE.repeat(500) }],
        });
    } else {
        await expect(serve(history(sessionId, 20, 430))).rejects.toBeInstanceOf(
            UnmanagedOverWindowError,
        );
    }
    return { serve, messages };
}

function loadStaleDefaultTools(modelID: string, tokens: number): void {
    const db = openDatabase()!;
    db.prepare(
        `INSERT INTO tool_definition_measurements
         (provider_id, model_id, agent_name, tool_id, token_count, recorded_at)
         VALUES (?, ?, 'default', 'old-tool', ?, ?)`,
    ).run(PROVIDER, modelID, tokens, Date.now());
    loadToolDefinitionMeasurements(db);
}

function recordDraftTools(sessionId: string, modelID: string, tokens: number): void {
    recordToolDefinitionSet(
        PROVIDER,
        modelID,
        "build",
        tokens === 0
            ? []
            : [{ id: "current-tool", description: "word ".repeat(tokens), parameters: {} }],
        sessionId,
    );
}

for (const pass of ["carried", "warm"] as const) {
    for (const { shape, stale, exact, refuse } of [
        { shape: "replaces a smaller persisted route", stale: 10, exact: 50_000, refuse: true },
        {
            shape: "replaces a larger persisted route with an empty draft",
            stale: 50_000,
            exact: 0,
            refuse: false,
        },
        {
            shape: "does not add the exact tools on top of a measured route",
            stale: 22_000,
            exact: 22_000,
            refuse: false,
        },
        {
            shape: "still counts the measured route without an exact record",
            stale: 50_000,
            exact: undefined,
            refuse: true,
        },
    ]) {
        it(`${pass} ${shape}`, async () => {
            const sessionId = `ses-${pass}-${shape.replaceAll(" ", "-")}`;
            const { serve, messages } = await prepareFitRequest(pass, sessionId);
            loadStaleDefaultTools(MODEL, stale);
            if (exact !== undefined) recordDraftTools(sessionId, MODEL, exact);
            const measured = estimateFinalWireInputTokens({
                messages: messages as never,
                systemPromptTokens: 0,
                providerID: PROVIDER,
                modelID: MODEL,
                sessionId,
            });
            expect(measured.toolDefinitionsMeasured).toBe(true);
            expect(measured.rawComponents!.tools - measured.messageTokens.toolCall).toBe(stale);
            if (refuse)
                await expect(serve(messages)).rejects.toBeInstanceOf(UnmanagedOverWindowError);
            else
                expect((await serve(messages)).at(-1)?.parts[0]?.text).toContain(
                    pass === "warm" ? LINE.repeat(500) : "the newest question",
                );
        });
    }
}

for (const staleSmaller of [true, false]) {
    for (const basis of ["calibrated", "provider-prefix"] as const) {
        const direction = staleSmaller ? "smaller" : "larger";
        it(`warm fit with ${basis} evidence and a ${direction} persisted route`, async () => {
            const modelID = "gpt-5.5";
            const sessionId = `ses-fit-${basis}-${direction}`;
            const { serve, messages } = await prepareFitRequest("warm", sessionId, modelID);
            loadStaleDefaultTools(modelID, staleSmaller ? 10 : 50_000);
            recordDraftTools(sessionId, modelID, staleSmaller ? 50_000 : 0);
            updateSessionMeta(openDatabase()!, sessionId, { systemPromptTokens: 100 });
            const request = {
                messages: messages as never,
                systemPromptTokens: 100,
                providerID: PROVIDER,
                modelID,
                sessionId,
            };
            const geometry = resolveContextWindowGeometry(PROVIDER, modelID)!;
            const measure = wire.estimateFinalWireInputTokens;
            const measuredPrefix = {
                inputTokens: staleSmaller ? 1_000 : 50_000,
                appendedMessages: [],
            };
            const evidence = measure({
                ...request,
                measuredPrefix: basis === "provider-prefix" ? measuredPrefix : undefined,
            });
            expect(evidence.refusalBasis).toBe(basis);
            expect(evidence.refusalTokens! > geometry.usableHard).toBe(!staleSmaller);
            // These fit callers have no provider-prefix snapshot today. Supply one
            // to check that a proven prefix still outranks the local tool estimate.
            const spy =
                basis === "provider-prefix"
                    ? spyOn(wire, "estimateFinalWireInputTokens").mockImplementation((input) =>
                          measure({ ...input, measuredPrefix }),
                      )
                    : undefined;
            try {
                const refuse = basis === "provider-prefix" ? !staleSmaller : staleSmaller;
                if (refuse)
                    await expect(serve(messages)).rejects.toBeInstanceOf(UnmanagedOverWindowError);
                else
                    expect((await serve(messages)).at(-1)?.parts[0]?.text).toContain(
                        LINE.repeat(500),
                    );
            } finally {
                spy?.mockRestore();
            }
        });
    }
}

it("checks a warm defer whose newly appended user prompt dwarfs the window", async () => {
    const sessionId = "ses-over-window-after-warm-defer";
    const usage = new Map<
        string,
        { usage: ContextUsage; updatedAt: number; hasUsageTokens: boolean }
    >();
    const serve = await knownWindowTransform(sessionId, usage);
    await serve(history(sessionId, 0, 0));
    const limit = resolveTrustedContextLimit(PROVIDER, MODEL)!;
    expect(limit).toBeGreaterThan(0);
    usage.set(sessionId, {
        usage: { inputTokens: 1000, percentage: (1000 / limit) * 100 },
        updatedAt: Date.now(),
        hasUsageTokens: true,
    });
    const messages = history(sessionId, 0, 0);
    messages.push(
        {
            info: {
                id: "first-answer",
                role: "assistant",
                sessionID: sessionId,
                providerID: PROVIDER,
                modelID: MODEL,
                finish: "stop",
            },
            parts: [{ type: "text", text: "hello" }],
        },
        {
            info: {
                id: "large-paste",
                role: "user",
                sessionID: sessionId,
                model: { providerID: PROVIDER, modelID: MODEL },
            },
            parts: [{ type: "text", text: LINE.repeat(9000) }],
        },
    );
    expect(historyTokens(messages)).toBeGreaterThan(limit * 2);
    const output = await serve(messages).catch((error) => {
        if (!(error instanceof Error) || !/over|window|context limit|fit/i.test(error.message))
            throw error;
        return undefined;
    });
    if (output) expect(historyTokens(output)).toBeLessThanOrEqual(limit);
}, 30_000);

it("serves a warm defer unchanged when an append exceeds the reserve but fits the hard window", async () => {
    const sessionId = "ses-warm-defer-output-reserve";
    const modelID = "gpt-5.5";
    const usage = new Map<
        string,
        { usage: ContextUsage; updatedAt: number; hasUsageTokens: boolean }
    >();
    const serve = await knownWindowTransform(sessionId, usage, modelID);
    const initial = () =>
        history(sessionId, 0, 0).map((message) => ({
            ...message,
            info: { ...message.info, model: { providerID: PROVIDER, modelID } },
        }));
    setOutputReserveConfig(18_000);
    try {
        const warm = await serve(initial());
        measureToolSet(PROVIDER, modelID, 2, sessionId);
        updateSessionMeta(openDatabase()!, sessionId, { systemPromptTokens: 100 });
        const geometry = resolveContextWindowGeometry(PROVIDER, modelID)!;
        usage.set(sessionId, {
            usage: { inputTokens: 1000, percentage: (1000 / geometry.usableSoft) * 100 },
            updatedAt: Date.now(),
            hasUsageTokens: true,
        });
        const messages: Message[] = initial();
        messages.push({
            info: { ...messages[0]!.info, id: "new-paste" },
            parts: [{ type: "text", text: LINE.repeat(1800) }],
        });
        const estimate = estimateFinalWireInputTokens({
            messages: messages as never,
            systemPromptTokens: 100,
            providerID: PROVIDER,
            modelID,
            sessionId,
        });
        expect(estimate.refusalGrade).toBe(true);
        expect(estimate.refusalTokens!).toBeGreaterThan(geometry.usableSoft);
        expect(estimate.refusalTokens!).toBeLessThan(geometry.usableHard);
        const served = await serve(messages);
        expect(served.slice(0, warm.length)).toEqual(warm);
        expect(served.at(-1)?.parts[0]?.text).toContain(LINE.repeat(1800));
    } finally {
        setOutputReserveConfig(undefined);
    }
}, 30_000);

describe("a first pass with no Magic Context state and a history over the window", () => {
    it("is refused before the provider, naming the reason", async () => {
        const sessionId = "ses-unmanaged-over-window";
        const serve = await knownWindowTransform(sessionId);
        // About three times the window, with nothing Magic Context could send
        // in its place: no compartment, no drop, and no historian.
        const messages = history(sessionId, 20, 430);
        const limit = resolveTrustedContextLimit(PROVIDER, MODEL) ?? 0;
        expect(limit).toBeGreaterThan(0);
        expect(historyTokens(messages)).toBeGreaterThan(limit * 2);
        const refusal = serve(messages);
        await expect(refusal).rejects.toBeInstanceOf(UnmanagedOverWindowError);
        await expect(refusal).rejects.toThrow("(MC-H06)");
    }, 30_000);

    it("stays refused on the next pass, whose usage reading still is not this request's", async () => {
        const sessionId = "ses-unmanaged-over-window-again";
        const serve = await knownWindowTransform(sessionId);
        await expect(serve(history(sessionId, 20, 430))).rejects.toBeInstanceOf(
            UnmanagedOverWindowError,
        );
        await expect(serve(history(sessionId, 20, 430))).rejects.toBeInstanceOf(
            UnmanagedOverWindowError,
        );
    }, 30_000);

    it("stays refused once refused, even when the next pass's history is under the margin", async () => {
        const sessionId = "ses-unmanaged-over-window-shrinks";
        const serve = await knownWindowTransform(sessionId);
        await expect(serve(history(sessionId, 20, 430))).rejects.toBeInstanceOf(
            UnmanagedOverWindowError,
        );
        // The host can hand over a shorter history on the next pass (on
        // OpenCode 1 it cuts the visible window at a compaction marker) while
        // the request is still over the window. A session met fresh with this
        // size is served (see the margin test below); one refused before is not.
        const shorter = history(sessionId, 10, LINES_WITHIN_MARGIN);
        const limit = resolveTrustedContextLimit(PROVIDER, MODEL) ?? 0;
        expect(historyTokens(shorter)).toBeGreaterThan(limit);
        expect(historyTokens(shorter)).toBeLessThan(limit * UNMANAGED_OVER_WINDOW_FACTOR);
        await expect(serve(shorter)).rejects.toBeInstanceOf(UnmanagedOverWindowError);
    }, 30_000);

    it("serves a refused session once its request really fits, though its route's tool definitions are unmeasured", async () => {
        const sessionId = "ses-unmanaged-over-window-fits-unmeasured-tools";
        const serve = await knownWindowTransform(sessionId);
        await expect(serve(history(sessionId, 20, 430))).rejects.toBeInstanceOf(
            UnmanagedOverWindowError,
        );
        // The session's last measured request flew another route, so this
        // route's tool-definition figure is an upper envelope built from that
        // request's tool set. That envelope alone takes the estimate over the
        // window, while the history the next pass sends is well inside it.
        const limit = resolveTrustedContextLimit(PROVIDER, MODEL) ?? 0;
        measureToolSet("another-provider", "another-model", limit, sessionId);
        const reduced = history(sessionId, 4, 40);
        expect(historyTokens(reduced)).toBeLessThan(limit / 2);
        expect(requestTokens(reduced, sessionId)).toBeGreaterThan(limit);
        const served = await serve(reduced);
        expect(JSON.stringify(served)).toContain("the newest question");
    }, 30_000);

    it("keeps refusing while the route's own measured tool definitions take the request over the window", async () => {
        const sessionId = "ses-unmanaged-over-window-measured-tools";
        const serve = await knownWindowTransform(sessionId);
        await expect(serve(history(sessionId, 20, 430))).rejects.toBeInstanceOf(
            UnmanagedOverWindowError,
        );
        // Here the tool definitions are this route's own measurement, so the
        // full request is what counts.
        const limit = resolveTrustedContextLimit(PROVIDER, MODEL) ?? 0;
        measureToolSet(PROVIDER, MODEL, limit);
        const reduced = history(sessionId, 4, 40);
        expect(historyTokens(reduced)).toBeLessThan(limit / 2);
        expect(requestTokens(reduced)).toBeGreaterThan(limit);
        await expect(serve(reduced)).rejects.toBeInstanceOf(UnmanagedOverWindowError);
    }, 30_000);

    it("serves a small first pass as before", async () => {
        const sessionId = "ses-unmanaged-small";
        const serve = await knownWindowTransform(sessionId);
        const served = await serve(history(sessionId, 2, 5));
        expect(JSON.stringify(served)).toContain("the newest question");
        expect(JSON.stringify(served)).toContain("HISTORY-LINE");
    }, 30_000);

    it("serves a first pass just over the window, inside the margin, as before", async () => {
        const sessionId = "ses-unmanaged-within-margin";
        const serve = await knownWindowTransform(sessionId);
        // Between the window and the margin: the local count could be a few
        // percent off the provider's, so the provider's answer decides.
        const messages = history(sessionId, 10, LINES_WITHIN_MARGIN);
        const limit = resolveTrustedContextLimit(PROVIDER, MODEL) ?? 0;
        const tokens = historyTokens(messages);
        expect(tokens).toBeGreaterThan(limit);
        expect(tokens).toBeLessThan(limit * UNMANAGED_OVER_WINDOW_FACTOR);
        const served = await serve(messages);
        const text = JSON.stringify(served);
        expect(text).toContain("the newest question");
        expect(text.split("HISTORY-LINE").length - 1).toBe(10 * LINES_WITHIN_MARGIN);
    }, 30_000);
});

describe("isClearlyOverWindow", () => {
    it("flags only counts beyond the margin over a known window", () => {
        expect(UNMANAGED_OVER_WINDOW_FACTOR).toBeGreaterThan(1);
        expect(isClearlyOverWindow(10_000 * UNMANAGED_OVER_WINDOW_FACTOR + 1, 10_000)).toBe(true);
        expect(isClearlyOverWindow(10_000 * UNMANAGED_OVER_WINDOW_FACTOR, 10_000)).toBe(false);
        expect(isClearlyOverWindow(10_500, 10_000)).toBe(false);
        expect(isClearlyOverWindow(50_000, undefined)).toBe(false);
        expect(isClearlyOverWindow(50_000, 0)).toBe(false);
        expect(isClearlyOverWindow(Number.NaN, 10_000)).toBe(false);
    });
});
