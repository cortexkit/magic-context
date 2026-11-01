import { afterEach, expect, it, spyOn } from "bun:test";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    getTagsBySession,
    openDatabase,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import {
    __resetToolDefinitionMeasurements,
    recordToolDefinition,
} from "../../features/magic-context/tool-definition-tokens";
import { createTestTempDir } from "../../shared/test-temp-dir";
import {
    clearCtxReduceAvailability,
    resolveCtxReduceAvailabilityFromMessages,
} from "./ctx-reduce-availability";
import { SIGNED_TURN_OVER_LIMIT, signedTurnContextRefusal } from "./emergency-fail-closed";
import {
    createFinalWireUsageTracker,
    estimateFinalWireInputTokens,
    estimateMessageTokens,
} from "./final-wire-token-estimate";
import {
    beginSystemDateRequest,
    finishSystemDateRefresh,
    registerSystemDateRefresh,
    systemDateRefreshPermission,
} from "./system-date-refresh";
import { systemPromptDates } from "./system-prompt-dates";
import { createSystemPromptHashHandler } from "./system-prompt-hash";
import type { MessageLike } from "./tag-messages";

const route = { providerID: "anthropic", modelID: "claude-opus-5-5", agentName: "build" };
const user = (id = "user"): MessageLike => ({
    info: { id, role: "user" },
    parts: [{ type: "text", text: "Continue" }],
});
const opaque = (tokens?: { reasoning?: number; output?: number }): MessageLike => ({
    info: { id: "opaque", role: "assistant", tokens } as MessageLike["info"],
    parts: [{ type: "redacted_thinking", data: "encrypted" }] as unknown as MessageLike["parts"],
});
const envelope = { ...route, systemPromptTokens: 100, systemPromptHash: "system-a" };
const registerTools = () =>
    recordToolDefinition(route.providerID, route.modelID, route.agentName, "read", "Read a file", {
        type: "object",
    });
function reply(input = 6_000): MessageLike {
    return {
        info: {
            id: "reply",
            role: "assistant",
            parentID: "user",
            ...route,
            finish: "stop",
            time: { completed: Date.now() + 1 },
            tokens: { input, cache: { read: 0, write: 0 } },
        },
        parts: [{ type: "text", text: "Done" }],
    } as unknown as MessageLike;
}

afterEach(() => __resetToolDefinitionMeasurements());

it("review: opaque estimate fallback order prefers reasoning, output, then heuristic", () => {
    expect(estimateMessageTokens(opaque({ reasoning: 37, output: 901 })).conversation).toBe(37);
    expect(estimateMessageTokens(opaque({ output: 901 })).conversation).toBe(901);
    expect(estimateMessageTokens(opaque()).conversation).toBe(1_000);
    expect(estimateMessageTokens(opaque({ reasoning: Number.NaN, output: 901 })).conversation).toBe(
        901,
    );
    expect(estimateMessageTokens(opaque({ reasoning: -1, output: 0 })).conversation).toBe(1_000);
    registerTools();
    const tracker = createFinalWireUsageTracker();
    const prefix = [opaque({ reasoning: 80_000, output: 90_000 }), user()];
    tracker.capture("fallback-order", { ...envelope, messages: prefix });
    const measured = tracker.estimate("fallback-order", {
        ...envelope,
        messages: [...prefix, reply()],
    });
    expect(measured.refusalBasis).toBe("provider-prefix");
    expect(measured.tokens).toBeGreaterThan(80_000);
    expect(measured.refusalTokens).toBeGreaterThanOrEqual(6_000);
    expect(measured.refusalTokens).toBeLessThan(6_100);
});

it("review: provider prefix invalidates on model, system and prefix changes but survives cache expiry", () => {
    registerTools();
    const tracker = createFinalWireUsageTracker();
    const prefix = [user()];
    tracker.capture("staleness", { ...envelope, messages: prefix });
    const messages = [...prefix, reply()];
    expect(tracker.estimate("staleness", { ...envelope, messages }).refusalBasis).toBe(
        "provider-prefix",
    );
    expect(
        tracker.estimate("staleness", { ...envelope, systemPromptHash: "system-b", messages })
            .refusalBasis,
    ).toBe("calibrated");
    expect(
        tracker.estimate("staleness", { ...envelope, messages: [user("changed"), reply()] })
            .refusalBasis,
    ).toBe("calibrated");
    recordToolDefinition(
        route.providerID,
        "claude-sonnet-4-5",
        route.agentName,
        "read",
        "Read",
        {},
    );
    expect(
        tracker.estimate("staleness", { ...envelope, modelID: "claude-sonnet-4-5", messages })
            .refusalBasis,
    ).not.toBe("provider-prefix");
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now + 7 * 24 * 60 * 60 * 1_000);
    try {
        const expired = tracker.estimate("staleness", { ...envelope, messages });
        expect(expired.refusalBasis).toBe("provider-prefix");
        expect(expired.refusalTokens).toBeLessThan(6_100);
    } finally {
        clock.mockRestore();
    }
});

it("review: measured genuinely oversized prefix and appended plaintext still refuse", () => {
    registerTools();
    const tracker = createFinalWireUsageTracker();
    const prefix = [user()];
    tracker.capture("over-window", { ...envelope, messages: prefix });
    const measured = tracker.estimate(
        "over-window",
        { ...envelope, messages: [...prefix, reply(17_000)] },
        16_000,
    );
    expect(measured.refusalGrade).toBe(true);
    expect(measured.refusalTokens).toBeGreaterThan(16_000);
    expect(signedTurnContextRefusal(measured, 16_000)).toBe(SIGNED_TURN_OVER_LIMIT);
    const long = {
        info: { id: "large-user", role: "user" },
        parts: [{ type: "text", text: "This is genuine required user content. ".repeat(20_000) }],
    } as MessageLike;
    const appended = tracker.estimate(
        "over-window",
        { ...envelope, messages: [...prefix, reply(), long] },
        16_000,
    );
    expect(appended.refusalBasis).toBe("byte-bound");
    expect(appended.refusalGrade).toBe(true);
    expect(signedTurnContextRefusal(appended, 16_000)).toBe(SIGNED_TURN_OVER_LIMIT);
});

it("review: unknown opaque thinking remains a heuristic, not a capacity upper bound", () => {
    registerTools();
    const estimate = estimateFinalWireInputTokens({ ...envelope, messages: [opaque()] });
    expect(estimate.messageTokens.conversation).toBe(1_000);
    expect(estimate.refusalGrade).toBe(true);
    expect(signedTurnContextRefusal(estimate, 16_000)).toBeUndefined();
    // An opaque reply may have cost 32k tokens; removing its unavailable usage
    // does not make the ciphertext reveal that cost to the local estimator.
    const withUsage = estimateFinalWireInputTokens({
        ...envelope,
        messages: [opaque({ reasoning: 32_000 })],
    });
    expect(withUsage.refusalTokens).toBeGreaterThan(16_000);
});

it("review: all recognized host date formats preserve every non-date byte", () => {
    const prompt = (date: string) =>
        `Preamble\r\n<plugin-env>\r\n\tDate: ${date} (UTC+14)\r\n  Directory: /work\r\n</plugin-env>\r\n<environment>\nDate: ${date}\nMode: Rust\n</environment>\n<env>\n  Today's date: ${date}\n</env>\nToday's date: ${date} (UTC-12)\n<document>\nDate: 1999-12-31\n</document>\nDate: ordinary prose`;
    const first = systemPromptDates(prompt("2026-10-12"));
    expect(JSON.parse(first.live!)).toHaveLength(4);
    expect(systemPromptDates(prompt("2026-10-19"), first.live).stable).toBe(prompt("2026-10-12"));
});

it("review: warm dates can remain stale for a week without scheduling a rebuild", async () => {
    const root = createTestTempDir("review-date-week-");
    const db = openDatabase(`${root.dir}/context.db`)!;
    const sessionId = "review-week";
    const history = new Set<string>();
    const refresh = new Set<string>();
    const pending = new Set<string>();
    getOrCreateSessionMeta(db, sessionId);
    updateSessionMeta(db, sessionId, { cacheTtl: "never", lastResponseTime: Date.now() });
    resolveCtxReduceAvailabilityFromMessages(sessionId, [user()] as never);
    const { handler } = createSystemPromptHashHandler({
        db,
        dreamerEnabled: false,
        resolveModel: () => route,
        historyRefreshSessions: history,
        systemPromptRefreshSessions: refresh,
        pendingMaterializationSessions: pending,
        lastHeuristicsTurnId: new Map(),
    });
    registerSystemDateRefresh(history);
    const prompt = (day: string) => [`Base\n<plugin-env>\nDate: 2026-10-${day}\n</plugin-env>`];
    try {
        const base = { system: prompt("12") };
        await handler({ sessionID: sessionId }, base);
        for (const day of ["13", "14", "15", "16", "17", "18", "19"]) {
            const warm = { system: prompt(day) };
            await handler({ sessionID: sessionId }, warm);
            expect(warm.system).toEqual(base.system);
            expect(pending.size).toBe(0);
            expect(history.size).toBe(0);
            expect(refresh.size).toBe(0);
        }
        refresh.add(sessionId);
        const paid = { system: prompt("19") };
        const paidIdentity = {};
        await handler({ sessionID: sessionId, dateRefreshRequest: paidIdentity }, paid);
        expect(paid.system).toEqual(base.system);
        finishSystemDateRefresh(
            history,
            beginSystemDateRequest(history, sessionId, "messages", "user", paidIdentity),
            true,
        );
        expect(paid.system.join("\n")).toContain("2026-10-19");
        expect(pending.size).toBe(0);
    } finally {
        clearCtxReduceAvailability(sessionId);
        closeDatabase();
        root.cleanup();
    }
});

it("review: concurrent same-session date waiters are request scoped", async () => {
    const root = createTestTempDir("review-date-concurrent-");
    const db = openDatabase(`${root.dir}/context.db`)!;
    const sessionId = "review-concurrent";
    const history = new Set<string>();
    const refresh = new Set<string>();
    const pending = new Set<string>();
    getOrCreateSessionMeta(db, sessionId);
    updateSessionMeta(db, sessionId, { cacheTtl: "never", lastResponseTime: Date.now() });
    resolveCtxReduceAvailabilityFromMessages(sessionId, [user()] as never);
    const { handler } = createSystemPromptHashHandler({
        db,
        dreamerEnabled: false,
        resolveModel: () => route,
        historyRefreshSessions: history,
        systemPromptRefreshSessions: refresh,
        pendingMaterializationSessions: pending,
        lastHeuristicsTurnId: new Map(),
    });
    registerSystemDateRefresh(history);
    const prompt = (day: string) => [`Base\n<plugin-env>\nDate: 2026-10-${day}\n</plugin-env>`];
    try {
        await handler({ sessionID: sessionId }, { system: prompt("12") });
        refresh.add(sessionId);
        const requestA = { system: prompt("13") };
        const requestB = { system: prompt("14") };
        const identityA = {};
        const identityB = {};
        await handler({ sessionID: sessionId, dateRefreshRequest: identityA }, requestA);
        refresh.add(sessionId);
        await handler({ sessionID: sessionId, dateRefreshRequest: identityB }, requestB);
        const messagesA = beginSystemDateRequest(history, sessionId, "messages", "user", identityA);
        const messagesB = beginSystemDateRequest(history, sessionId, "messages", "user", identityB);
        // Request A's rebuilding pass may release only request A's date.
        // Request B still carries its original date through the held tool loop.
        finishSystemDateRefresh(history, messagesA, true);
        expect(requestB.system.join("\n")).toContain("2026-10-12");
        expect(requestA.system.join("\n")).toContain("2026-10-13");
        expect(systemDateRefreshPermission(history, messagesB)).toBeUndefined();
        finishSystemDateRefresh(history, messagesB, false);
        expect(requestB.system.join("\n")).toContain("2026-10-12");
    } finally {
        clearCtxReduceAvailability(sessionId);
        closeDatabase();
        root.cleanup();
    }
});

it("review: messages-first permissions are owned by their request, not the last completion", async () => {
    const root = createTestTempDir("review-date-messages-first-");
    const db = openDatabase(`${root.dir}/context.db`)!;
    const sessionId = "review-messages-first";
    const history = new Set<string>();
    const refresh = new Set<string>();
    getOrCreateSessionMeta(db, sessionId);
    updateSessionMeta(db, sessionId, { cacheTtl: "never", lastResponseTime: Date.now() });
    resolveCtxReduceAvailabilityFromMessages(sessionId, [user()] as never);
    const system = createSystemPromptHashHandler({
        db,
        dreamerEnabled: false,
        resolveModel: () => route,
        historyRefreshSessions: history,
        systemPromptRefreshSessions: refresh,
        pendingMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        consumeMessagesPrepared: () => true,
    });
    registerSystemDateRefresh(history);
    const prompt = (day: string) => [`<plugin-env>\nDate: 2026-10-${day}\n</plugin-env>`];
    try {
        await system.handler({ sessionID: sessionId }, { system: prompt("12") });
        const a = {};
        const b = {};
        finishSystemDateRefresh(
            history,
            beginSystemDateRequest(history, sessionId, "messages", "user", a),
            true,
        );
        finishSystemDateRefresh(
            history,
            beginSystemDateRequest(history, sessionId, "messages", "user", b),
            false,
        );
        refresh.add(sessionId);
        const held = { system: prompt("14") };
        await system.handler({ sessionID: sessionId, dateRefreshRequest: b }, held);
        expect(held.system.join("\n")).toContain("2026-10-12");
        const paid = { system: prompt("13") };
        await system.handler({ sessionID: sessionId, dateRefreshRequest: a }, paid);
        expect(paid.system.join("\n")).toContain("2026-10-13");
        expect(held.system.join("\n")).toContain("2026-10-12");
    } finally {
        system.clearSession(sessionId);
        clearCtxReduceAvailability(sessionId);
        closeDatabase();
        root.cleanup();
    }
});

it("review: unidentified hooks pair on the issue-665 real-user anchor and fail closed on overlap", () => {
    const history = new Set<string>();
    registerSystemDateRefresh(history);
    const anchor = systemDateTurnId([
        user("real-user"),
        {
            info: { id: "synth-user-context", role: "user", synthetic: true },
            parts: [],
        },
        { info: { id: "result-carrier", role: "user" }, parts: [{ type: "tool-result" }] },
    ]);
    expect(anchor).toBe("real-user");
    const a = beginSystemDateRequest(history, "session", "system", anchor);
    const b = beginSystemDateRequest(history, "session", "system", "next-user");
    const released: string[] = [];
    waitForSystemDateRefresh(history, a, (allowed) => {
        if (allowed) released.push("A");
    });
    waitForSystemDateRefresh(history, b, (allowed) => {
        if (allowed) released.push("B");
    });
    finishSystemDateRefresh(
        history,
        beginSystemDateRequest(history, "session", "messages", anchor),
        true,
    );
    expect(released).toEqual(["A"]);
    expect(systemDateRefreshPermission(history, b)).toBeUndefined();
    const first = beginSystemDateRequest(history, "overlap", "system", anchor);
    const second = beginSystemDateRequest(history, "overlap", "system", anchor);
    waitForSystemDateRefresh(history, first, (allowed) => {
        if (allowed) released.push("first");
    });
    waitForSystemDateRefresh(history, second, (allowed) => {
        if (allowed) released.push("second");
    });
    finishSystemDateRefresh(
        history,
        beginSystemDateRequest(history, "overlap", "messages", anchor),
        true,
    );
    finishSystemDateRefresh(
        history,
        beginSystemDateRequest(history, "overlap", "messages", anchor),
        false,
    );
    expect(released).toEqual(["A"]);
});

it("review: a later waiter cannot invalidate an already paired unidentified request", () => {
    const history = new Set<string>();
    registerSystemDateRefresh(history);
    const a = beginSystemDateRequest(history, "session", "system", "user");
    const messagesA = beginSystemDateRequest(history, "session", "messages", "user");
    const b = beginSystemDateRequest(history, "session", "system", "user");
    const released: string[] = [];
    waitForSystemDateRefresh(history, a, (allowed) => {
        if (allowed) released.push("A");
    });
    waitForSystemDateRefresh(history, b, (allowed) => {
        if (allowed) released.push("B");
    });
    finishSystemDateRefresh(history, messagesA, true);
    expect(released).toEqual(["A"]);
});

it("review: the OpenCode 1 system hook reads the same real-user anchor as the thinking hold", () => {
    const root = createTestTempDir("review-date-turn-anchor-");
    const previousHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = root.dir;
    mkdirSync(`${root.dir}/opencode`, { recursive: true });
    const host = new Database(`${root.dir}/opencode/opencode.db`);
    host.exec(
        "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, data TEXT)",
    );
    const rows = [
        { info: { id: "real", role: "user" }, parts: [{ type: "text" }] },
        {
            info: { id: "synth-user-date", role: "user" },
            parts: [{ type: "text", synthetic: true }],
        },
        { info: { id: "ignored", role: "user" }, parts: [{ type: "text", ignored: true }] },
        { info: { id: "result", role: "user" }, parts: [{ type: "tool-result" }] },
        { info: { id: "assistant", role: "assistant" }, parts: [{ type: "reasoning" }] },
    ];
    try {
        for (const [index, row] of rows.entries()) {
            host.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(
                row.info.id,
                "session",
                index,
                JSON.stringify(row.info),
            );
            host.prepare("INSERT INTO part VALUES (?, ?, ?)").run(
                `${row.info.id}-part`,
                row.info.id,
                JSON.stringify(row.parts[0]),
            );
        }
        host.close();
        closeReadOnlySessionDb();
        expect(systemDateTurnId(rows)).toBe("real");
        expect(latestRealUserTurnIdFromOpenCodeDb("session")).toBe(systemDateTurnId(rows));
    } finally {
        closeReadOnlySessionDb();
        if (previousHome === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = previousHome;
        root.cleanup();
    }
});

it("review: OpenCode 2 context drafts preserve distinct same-session request identity", async () => {
    const root = createTestTempDir("review-date-v2-concurrent-");
    const db = openDatabase(`${root.dir}/context.db`)!;
    const sessionId = "review-v2-concurrent";
    const history = new Set<string>();
    const refresh = new Set<string>();
    getOrCreateSessionMeta(db, sessionId);
    updateSessionMeta(db, sessionId, { cacheTtl: "never", lastResponseTime: Date.now() });
    const system = createSystemPromptHashHandler({
        db,
        dreamerEnabled: false,
        resolveModel: () => route,
        historyRefreshSessions: history,
        systemPromptRefreshSessions: refresh,
        pendingMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
    });
    registerSystemDateRefresh(history);
    const draft = (day: string) => ({
        sessionID: sessionId,
        model: { providerID: route.providerID, id: route.modelID },
        messages: [{ id: "user", role: "user", content: [] }],
        tools: { ctx_reduce: {} },
        system: [{ type: "text", text: `<plugin-env>\nDate: 2026-10-${day}\n</plugin-env>` }],
    });
    try {
        await applyV2SystemPrompt(system, draft("12") as never);
        refresh.add(sessionId);
        const a = draft("13");
        const b = draft("14");
        await applyV2SystemPrompt(system, a as never);
        refresh.add(sessionId);
        await applyV2SystemPrompt(system, b as never);
        finishSystemDateRefresh(
            history,
            beginSystemDateRequest(history, sessionId, "messages", "user", a),
            true,
        );
        expect(b.system[0]?.text).toContain("2026-10-12");
        expect(a.system[0]?.text).toContain("2026-10-13");
        finishSystemDateRefresh(
            history,
            beginSystemDateRequest(history, sessionId, "messages", "user", b),
            false,
        );
        expect(b.system[0]?.text).toContain("2026-10-12");
    } finally {
        system.clearSession(sessionId);
        clearCtxReduceAvailability(sessionId);
        closeDatabase();
        root.cleanup();
    }
});

import { appendCompartments } from "../../features/magic-context/compartment-storage";
import { recordDetectedContextLimit } from "../../features/magic-context/storage-meta-persisted";
import { createTagger } from "../../features/magic-context/tagger";
import * as logger from "../../shared/logger";
import * as injection from "./inject-compartments";
import { closeReadOnlySessionDb } from "./read-session-db";
import { createTransform } from "./transform";

it("review: 10:32:20 forced thinking release and 10:32:24 replay use one trim seam", async () => {
    const root = createTestTempDir("review-trim-sequence-");
    const db = openDatabase(`${root.dir}/context.db`)!;
    const sessionId = "review-trim-sequence";
    getOrCreateSessionMeta(db, sessionId);
    updateSessionMeta(db, sessionId, { cacheTtl: "never", lastResponseTime: Date.now() });
    recordDetectedContextLimit(db, sessionId, 16_000, `${route.providerID}/${route.modelID}`);
    updateSessionMeta(db, sessionId, { systemPromptTokens: 100, systemPromptHash: "trim-system" });
    recordToolDefinition(route.providerID, route.modelID, undefined, "read", "Read a file", {
        type: "object",
    });
    resolveCtxReduceAvailabilityFromMessages(sessionId, [user()] as never);
    const usage = new Map([
        [
            sessionId,
            {
                usage: { percentage: 75.4, inputTokens: 12_064 },
                updatedAt: Date.now(),
                hasUsageTokens: true,
            },
        ],
    ]);
    const deferred = new Set<string>();
    let decision: "execute" | "defer" = "defer";
    const newTransform = () =>
        createTransform({
            db,
            tagger: createTagger(),
            scheduler: { shouldExecute: () => decision },
            contextUsageMap: usage,
            liveModelBySession: new Map([[sessionId, route]]),
            historyRefreshSessions: new Set(),
            pendingMaterializationSessions: new Set(),
            deferredHistoryRefreshSessions: deferred,
            lastHeuristicsTurnId: new Map(),
            directory: root.dir,
            protectedTokens: 0,
            clearReasoningAge: 0,
            historianRunnable: false,
        });
    let transform = newTransform();
    const msg = (
        id: string,
        role: "user" | "assistant",
        parts: unknown[] = [{ type: "text", text: id }],
    ) =>
        ({
            info: {
                id,
                role,
                sessionID: sessionId,
                ...(role === "assistant"
                    ? { providerID: route.providerID, modelID: route.modelID, finish: "stop" }
                    : {}),
            },
            parts,
        }) as MessageLike;
    const source = () => [
        msg("msg01", "user"),
        msg("msg02", "assistant"),
        msg("msg03", "user"),
        msg("msg04", "assistant", [
            {
                type: "reasoning",
                text: "Covered thought",
                metadata: { anthropic: { signature: "old-signature" } },
            },
        ]),
        msg("msg05", "user"),
    ];
    let toolOutput = "small result";
    const active = () => [
        ...source(),
        {
            ...msg("msg06", "assistant", [
                {
                    type: "reasoning",
                    text: "Active thought",
                    metadata: { anthropic: { signature: "active-signature" } },
                },
                {
                    type: "tool",
                    tool: "read",
                    callID: "read-call",
                    state: { status: "completed", input: {}, output: toolOutput },
                },
            ]),
            // A heavy step: below the 75% cap the bounded hold keeps the turn.
            info: {
                ...msg("msg06", "assistant").info,
                finish: "tool-calls",
                tokens: { input: 0, output: 1_600, reasoning: 1_600 },
            },
        },
    ];
    const compartment = (sequence: number, start: number, end: number) => ({
        sequence,
        startMessage: start,
        endMessage: end,
        startMessageId: `msg0${start}`,
        endMessageId: `msg0${end}`,
        title: "Covered",
        content: `History ${sequence}`,
    });
    const original = injection.injectM0M1;
    const seams: Array<string | null | undefined> = [];
    const spy = spyOn(injection, "injectM0M1").mockImplementation((options) => {
        const result = original(options);
        seams.push(result.preparedTrimBoundaryId);
        return result;
    });
    const clock = spyOn(Date, "now");
    const logs = spyOn(logger, "sessionLog");
    try {
        appendCompartments(db, sessionId, [compartment(0, 1, 2)]);
        await transform({}, { messages: source() });
        const held = active();
        await transform({}, { messages: held });
        expect(JSON.stringify(held)).toContain("Active thought");
        appendCompartments(db, sessionId, [compartment(1, 3, 4)]);
        deferred.add(sessionId);
        decision = "execute";
        const at = Date.parse("2026-10-13T10:32:20Z");
        clock.mockReturnValue(at);
        // Just below the hold cap (65% + 10), so the turn is still held.
        usage.set(sessionId, {
            usage: { percentage: 74.9, inputTokens: 11_984 },
            updatedAt: at,
            hasUsageTokens: true,
        });
        // Below the real 95% wall, fit recovery must refuse an oversized
        // protected result rather than fabricate pressure to erase it.
        toolOutput = "RECLAIMABLE tool result words ".repeat(30_000);
        await expect(transform({}, { messages: active() })).rejects.toMatchObject({
            name: "EmergencyFailClosedError",
        });
        await expect(transform({}, { messages: active() })).rejects.toMatchObject({
            name: "EmergencyFailClosedError",
        });
        // A fresh transform has no recursive retry flag. Persisted refusal must
        // still check the outgoing request, even on a low-pressure defer pass.
        transform = newTransform();
        decision = "defer";
        usage.set(sessionId, {
            usage: { percentage: 20, inputTokens: 3_200 },
            updatedAt: at,
            hasUsageTokens: true,
        });
        await expect(transform({}, { messages: active() })).rejects.toMatchObject({
            name: "EmergencyFailClosedError",
        });
        expect(
            getTagsBySession(db, sessionId).find((tag) => tag.messageId === "read-call")?.status,
        ).toBe("active");
        expect(logs.mock.calls.map((call) => call.slice(1).join(" ")).join("\n")).not.toContain(
            "context=95.0%",
        );
        decision = "execute";
        usage.set(sessionId, {
            usage: { percentage: 96, inputTokens: 15_360 },
            updatedAt: at,
            hasUsageTokens: true,
        });
        const released = active();
        await transform({}, { messages: released });
        expect(logs.mock.calls.map((call) => call.slice(1).join(" ")).join("\n")).toContain(
            "origin=fit_retry",
        );
        expect(JSON.stringify(released)).not.toContain("Active thought");
        expect(JSON.stringify(released)).not.toContain("Covered thought");
        const releasedSeam = seams.at(-1);
        expect(releasedSeam).toBe("msg04");
        decision = "defer";
        clock.mockReturnValue(at + 4_000);
        usage.set(sessionId, {
            usage: { percentage: 20, inputTokens: 3_200 },
            updatedAt: at + 4_000,
            hasUsageTokens: true,
        });
        const replay = active();
        await transform({}, { messages: replay });
        expect(seams.at(-1)).toBe(releasedSeam);
        expect(JSON.stringify(replay)).toBe(JSON.stringify(released));
    } finally {
        clock.mockRestore();
        logs.mockRestore();
        spy.mockRestore();
        injection.clearInjectionCache(sessionId);
        clearCtxReduceAvailability(sessionId);
        closeReadOnlySessionDb();
        closeDatabase();
        root.cleanup();
    }
}, 30_000);

import { mkdirSync } from "node:fs";
import { Database } from "../../shared/sqlite";
import { applyV2SystemPrompt } from "../../v2/hooks/context";
import { latestRealUserTurnIdFromOpenCodeDb } from "./read-session-db";
import { systemDateTurnId, waitForSystemDateRefresh } from "./system-date-refresh";
