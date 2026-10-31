import { afterEach, expect, it, spyOn } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    openDatabase,
    setPendingCompactionMarkerState,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import {
    getPersistedCompactionMarkerState,
    setPersistedCompactionMarkerState,
} from "../../features/magic-context/storage-meta-persisted";
import { createTagger } from "../../features/magic-context/tagger";
import * as logger from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { MARKER_SUMMARY_TEXT } from "./compaction-marker-manager";
import {
    clearCtxReduceAvailability,
    resolveCtxReduceAvailabilityFromMessages,
} from "./ctx-reduce-availability";
import {
    estimateFinalWireInputTokens,
    estimateMessageTokens,
    opaqueThinkingFallbackSteps,
} from "./final-wire-token-estimate";
import * as injection from "./inject-compartments";
import {
    capturePrefixTrimSourceOrder,
    clearInjectionCache,
    injectM0M1,
    materializeM0,
    prepareCompartmentInjection,
} from "./inject-compartments";
import {
    clearPendingMaterialization,
    pendingMaterializationOrigin,
    requestPendingMaterialization,
} from "./pending-materialization";
import { closeReadOnlySessionDb } from "./read-session-db";
import { finishSystemDateRefresh, registerSystemDateRefresh } from "./system-date-refresh";
import { createSystemPromptHashHandler } from "./system-prompt-hash";
import type { MessageLike } from "./tag-messages";
import { createTransform } from "./transform";

const sessionId = "ses-post-flush-reproduction";
const model = { providerID: "anthropic", modelID: "claude-opus-5-5" };
const originalDataHome = process.env.XDG_DATA_HOME;
let root: string | undefined;

function setup() {
    root = createTestTempDirFromPath(join(tmpdir(), "post-flush-reproduction-"));
    process.env.XDG_DATA_HOME = root;
    const db = openDatabase();
    getOrCreateSessionMeta(db, sessionId);
    updateSessionMeta(db, sessionId, { cacheTtl: "never", lastResponseTime: Date.now() });
    resolveCtxReduceAvailabilityFromMessages(sessionId, [message("user", "user")] as never);
    return db;
}

afterEach(() => {
    __resetToolDefinitionMeasurements();
    clearInjectionCache(sessionId);
    clearCtxReduceAvailability(sessionId);
    closeReadOnlySessionDb();
    closeDatabase();
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalDataHome;
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
});

function message(id: string, role: "user" | "assistant"): MessageLike {
    return { info: { id, role, sessionID: sessionId }, parts: [{ type: "text", text: id }] };
}

function promptHandler(
    db: ReturnType<typeof setup>,
    consumeMessagesPrepared?: (sessionId: string) => boolean,
) {
    const historyRefreshSessions = new Set<string>();
    const systemPromptRefreshSessions = new Set<string>();
    const pendingMaterializationSessions = new Set<string>();
    const { handler } = createSystemPromptHashHandler({
        db,
        dreamerEnabled: false,
        resolveModel: () => model,
        historyRefreshSessions,
        systemPromptRefreshSessions,
        pendingMaterializationSessions,
        lastHeuristicsTurnId: new Map(),
        consumeMessagesPrepared,
    });
    return {
        handler,
        historyRefreshSessions,
        systemPromptRefreshSessions,
        pendingMaterializationSessions,
    };
}

it("recognized date freezes on warm passes and advances with a refresh signal", async () => {
    const db = setup();
    const { handler, systemPromptRefreshSessions, pendingMaterializationSessions } =
        promptHandler(db);
    await handler({ sessionID: sessionId }, { system: ["Base\nToday's date: 2026-10-12"] });
    const warm = { system: ["Base\nToday's date: 2026-10-13"] };
    await handler({ sessionID: sessionId }, warm);
    expect(warm.system.join("\n")).toContain("Today's date: 2026-10-12");
    expect(pendingMaterializationSessions.size).toBe(0);
    systemPromptRefreshSessions.add(sessionId);
    const refresh = { system: ["Base\nToday's date: 2026-10-13"] };
    await handler({ sessionID: sessionId }, refresh);
    expect(refresh.system.join("\n")).toContain("Today's date: 2026-10-13");
    expect(systemPromptRefreshSessions.size).toBe(0);
});

for (const order of ["system-first", "messages-first"] as const) {
    it(`environment dates share the actual rewrite permission (${order})`, async () => {
        const db = setup();
        const signals = promptHandler(db, () => order === "messages-first");
        registerSystemDateRefresh(signals.historyRefreshSessions);
        const prompt = (date: string) => [
            `Base\n<plugin-env>\n  Date: ${date}\n</plugin-env>\n<document>\nDate: 1999-12-31\n</document>`,
            `<env>\r\nDate: ${date}\r\n</env>`,
            `Today's date: ${date} (UTC+14)`,
        ];
        const base = { system: prompt("2026-10-12") };
        await signals.handler({ sessionID: sessionId }, base);
        signals.systemPromptRefreshSessions.add(sessionId);
        const held = { system: prompt("2026-10-13") };
        const heldMessages = () =>
            beginSystemDateRequest(
                signals.historyRefreshSessions,
                sessionId,
                "messages",
                "user",
                held,
            );
        if (order === "messages-first")
            finishSystemDateRefresh(signals.historyRefreshSessions, heldMessages(), false);
        await signals.handler({ sessionID: sessionId, dateRefreshRequest: held }, held);
        if (order === "system-first")
            finishSystemDateRefresh(signals.historyRefreshSessions, heldMessages(), false);
        expect(held.system).toEqual(base.system);
        expect(signals.systemPromptRefreshSessions.has(sessionId)).toBe(true);
        expect(signals.pendingMaterializationSessions.size).toBe(0);
        const paid = { system: prompt("2026-10-13") };
        const paidMessages = () =>
            beginSystemDateRequest(
                signals.historyRefreshSessions,
                sessionId,
                "messages",
                "user",
                paid,
            );
        if (order === "messages-first")
            finishSystemDateRefresh(signals.historyRefreshSessions, paidMessages(), true);
        await signals.handler({ sessionID: sessionId, dateRefreshRequest: paid }, paid);
        if (order === "system-first")
            finishSystemDateRefresh(signals.historyRefreshSessions, paidMessages(), true);
        expect(paid.system.join("\n")).toContain("Date: 2026-10-13");
        expect(paid.system.join("\n")).toContain("Date: 1999-12-31");
        expect(signals.systemPromptRefreshSessions.has(sessionId)).toBe(false);
        const replay = { system: prompt("2026-10-13") };
        await signals.handler({ sessionID: sessionId }, replay);
        expect(replay.system).toEqual(paid.system);
        expect(signals.pendingMaterializationSessions.size).toBe(0);
    });
}

it("opaque thinking uses assistant usage, then a signature-length-independent fallback", () => {
    const row = (
        type: "thinking" | "redacted_thinking",
        usage?: { reasoning?: number; output?: number },
    ) =>
        ({
            info: { id: "hidden", role: "assistant", tokens: usage },
            parts: [
                type === "thinking"
                    ? { type, thinking: "", signature: "opaque" }
                    : { type, data: "opaque" },
            ],
        }) as unknown as MessageLike;
    for (const type of ["thinking", "redacted_thinking"] as const) {
        const small = row(type);
        const large = row(type);
        Object.assign(
            large.parts[0]!,
            type === "thinking"
                ? { signature: "opaque".repeat(10000) }
                : { data: "opaque".repeat(10000) },
        );
        expect(estimateMessageTokens(small).conversation).toBe(1000);
        expect(estimateMessageTokens(large)).toEqual(estimateMessageTokens(small));
        expect(estimateMessageTokens(row(type, { reasoning: 23, output: 100 })).conversation).toBe(
            23,
        );
        expect(estimateMessageTokens(row(type, { output: 456 })).conversation).toBe(456);
        expect(opaqueThinkingFallbackSteps([small, row(type, { output: 456 })])).toBe(1);
    }
    const sdkRedacted = {
        info: { id: "sdk-redacted", role: "assistant" },
        parts: [
            {
                type: "reasoning",
                text: "opaque".repeat(100_000),
                metadata: { anthropic: { redactedData: "encrypted" } },
            },
        ],
    } as unknown as MessageLike;
    const flagged = {
        info: { id: "flagged", role: "assistant" },
        parts: [
            {
                type: "thinking",
                thinking: "opaque".repeat(100_000),
                redacted: true,
            },
        ],
    } as unknown as MessageLike;
    expect(estimateMessageTokens(sdkRedacted).conversation).toBe(1000);
    expect(estimateMessageTokens(flagged).conversation).toBe(1000);
    expect(opaqueThinkingFallbackSteps([sdkRedacted, flagged])).toBe(2);
});

it("OpenCode 2 advances copied system blocks on the paid rewrite, not its replay", async () => {
    const db = setup();
    const signals = promptHandler(db);
    registerSystemDateRefresh(signals.historyRefreshSessions);
    const draft = (date: string) => ({
        sessionID: sessionId,
        model: { providerID: model.providerID, id: model.modelID },
        messages: [{ id: "user", role: "user", parts: [] }],
        tools: { ctx_reduce: {} },
        system: [{ type: "text", text: `<plugin-env>\nDate: ${date}\n</plugin-env>` }],
    });
    const base = draft("2026-10-12");
    await applyV2SystemPrompt(signals, base as never);
    signals.systemPromptRefreshSessions.add(sessionId);
    const held = draft("2026-10-13");
    await applyV2SystemPrompt(signals, held as never);
    finishSystemDateRefresh(
        signals.historyRefreshSessions,
        beginSystemDateRequest(signals.historyRefreshSessions, sessionId, "messages", "user", held),
        false,
    );
    expect(held.system).toEqual(base.system);
    const paid = draft("2026-10-13");
    await applyV2SystemPrompt(signals, paid as never);
    expect(paid.system).toEqual(base.system);
    finishSystemDateRefresh(
        signals.historyRefreshSessions,
        beginSystemDateRequest(signals.historyRefreshSessions, sessionId, "messages", "user", paid),
        true,
    );
    expect(paid.system[0]?.text).toContain("Date: 2026-10-13");
    const replay = draft("2026-10-13");
    await applyV2SystemPrompt(signals, replay as never);
    expect(replay.system).toEqual(paid.system);
    expect(signals.pendingMaterializationSessions.size).toBe(0);
    expect(signals.systemPromptRefreshSessions.size).toBe(0);
});

it("pending materialization retains its true origin while held and clears it on drain", () => {
    const pending = new Set<string>();
    requestPendingMaterialization(pending, sessionId, "system_hash");
    requestPendingMaterialization(pending, sessionId, "thinking_hold");
    expect(pendingMaterializationOrigin(pending, sessionId)).toBe("system_hash");
    requestPendingMaterialization(pending, sessionId, "fit_retry");
    expect(pendingMaterializationOrigin(pending, sessionId)).toBe("fit_retry");
    clearPendingMaterialization(pending, sessionId);
    pending.add(sessionId);
    expect(pendingMaterializationOrigin(pending, sessionId)).toBe("pending_materialization");
    requestPendingMaterialization(pending, sessionId, "user_flush");
    expect(pendingMaterializationOrigin(pending, sessionId)).toBe("user_flush");
});

it("plugin-env Date stays frozen on a warm signed-loop request", async () => {
    const db = setup();
    const { handler } = promptHandler(db);
    const prompt = (date: string) => `Base\n<plugin-env>\n  Date: ${date}\n</plugin-env>`;
    await handler({ sessionID: sessionId }, { system: [prompt("2026-10-12")] });
    const warm = { system: [prompt("2026-10-13")] };
    await handler({ sessionID: sessionId }, warm);
    expect(warm.system.join("\n")).toContain("Date: 2026-10-12");
});

it("fresh prefix and replay cut at the same removed assistant seam", () => {
    const db = setup();
    appendCompartments(db, sessionId, [
        {
            sequence: 0,
            startMessage: 1,
            endMessage: 2,
            startMessageId: "covered-user",
            endMessageId: "assistant-boundary",
            title: "Covered history",
            content: "The previous request completed.",
        },
    ]);
    const options = {
        db,
        sessionId,
        state: getOrCreateSessionMeta(db, sessionId),
        injectDocs: false,
    };
    const rendered = materializeM0(options);
    const source = [
        message("covered-user", "user"),
        message("assistant-boundary", "assistant"),
        message("retained-user", "user"),
    ];
    // Simulate cleanup deleting the assistant at the end of summarized
    // history, after recording its position in the original message order.
    const fresh = source.filter((m) => m.info.id !== "assistant-boundary");
    const delivered = injectM0M1({
        ...options,
        messages: fresh,
        isCacheBustingPass: true,
        prefixTrimSourceOrder: capturePrefixTrimSourceOrder(source),
        preparedPrefix: {
            injected: true,
            prependedMessageCount: 0,
            m0RematerializedThisPass: true,
            materializationContentionRetryExhausted: false,
            decision: { value: true, reason: "explicit_flush" },
            m0Bytes: rendered.m0Bytes,
            m1Text: rendered.m1Text,
            preparedMessages: [],
            preparedTrimBoundaryId: "assistant-boundary",
        },
    });
    const replay = structuredClone(source);
    prepareCompartmentInjection(db, sessionId, replay, false, []);
    expect(replay.map((m) => m.info.id)).toEqual(["retained-user"]);
    expect(delivered.preparedTrimBoundaryId).toBe("assistant-boundary");
    expect(fresh.map((m) => m.info.id)).toEqual(replay.map((m) => m.info.id));
});

it("mural image estimation is independent of base64 payload length", () => {
    setup();
    const image = (payload: string) =>
        ({
            info: { id: "mural", role: "user" },
            parts: [{ type: "file", mime: "image/png", url: `data:image/png;base64,${payload}` }],
        }) as unknown as MessageLike;
    const tiny = estimateMessageTokens(image("AAAA"));
    const large = estimateMessageTokens(image("AAAA".repeat(32_000)));
    expect(tiny).toEqual(large);
    expect(large.conversation).toBeLessThan(10_000);
});

it("opaque thinking signatures do not turn a fitting request into refusal evidence", () => {
    setup();
    const plain = {
        info: { id: "thinking", role: "assistant" },
        parts: [
            {
                type: "reasoning",
                text: "A short thought",
                metadata: { anthropic: { signature: "" } },
            },
        ],
    } as unknown as MessageLike;
    const signed = structuredClone(plain);
    const signature = Buffer.from(
        Array.from({ length: 6000 }, (_, i) => (i * 73 + (i >> 2)) % 256),
    ).toString("base64");
    (
        signed.parts[0] as unknown as { metadata: { anthropic: { signature: string } } }
    ).metadata.anthropic.signature = signature;
    const envelope = { ...model, systemPromptTokens: 100, toolDefinitionTokens: 100 };
    const baseline = estimateFinalWireInputTokens({ ...envelope, messages: [plain] });
    const withSignature = estimateFinalWireInputTokens({ ...envelope, messages: [signed] });
    expect(baseline.tokens).toBeLessThan(1_000);
    expect(withSignature.refusalGrade).toBe(true);
    expect(withSignature.refusalTokens).toBeLessThan(1_000);
});

for (const contentChange of [false, true]) {
    it(
        contentChange
            ? "system-first real content miss holds its fold and marker write until the next user turn"
            : "75% signed session folds once, replays on defer and holds its date across midnight",
        async () => {
            const db = setup();
            recordDetectedContextLimit(
                db,
                sessionId,
                872_000,
                `${model.providerID}/${model.modelID}`,
            );
            const oldBoundary = "msg_01";
            const oldSummary = "msg_02";
            const newBoundary = "msg_03";
            const newEnd = "msg_04";
            const tailUser = "msg_05";
            const thinking = "msg_06";
            // A long plaintext tail approximates the measured input. Short parts
            // use tokenizer counts scaled to this model, rather than the separate
            // large-text shortcut that estimates token mass from byte size.
            const longText = "one two three four ".repeat(256);
            const tailParts = contentChange
                ? [{ type: "text", text: tailUser }]
                : Array.from({ length: 400 }, () => ({ type: "text", text: longText }));
            if (!contentChange)
                recordToolDefinition(
                    model.providerID,
                    model.modelID,
                    undefined,
                    "read",
                    "Read a file",
                    { type: "object" },
                );
            mkdirSync(join(root!, "opencode"), { recursive: true });
            const hostDb = new Database(join(root!, "opencode", "opencode.db"));
            // Create the fixture in WAL mode like OpenCode. Schema writes create the
            // -wal/-shm files; without them, macOS SQLite can reject a readonly worker's
            // first read after a late switch from rollback journaling to WAL.
            hostDb.exec("PRAGMA journal_mode=WAL");
            hostDb.exec(
                "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT); CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
            );
            for (const [index, id] of [
                oldBoundary,
                oldSummary,
                newBoundary,
                newEnd,
                tailUser,
                thinking,
            ].entries()) {
                const role = [oldSummary, newEnd, thinking].includes(id) ? "assistant" : "user";
                hostDb.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
                    id,
                    sessionId,
                    index * 1000,
                    index * 1000,
                    JSON.stringify({
                        role,
                        ...(id === oldSummary
                            ? {
                                  summary: true,
                                  parentID: oldBoundary,
                                  providerID: "magic-context",
                                  modelID: "magic-context",
                              }
                            : {}),
                        ...(role === "assistant" ? { finish: "stop" } : {}),
                    }),
                );
                hostDb.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
                    `${id}-text`,
                    id,
                    sessionId,
                    index * 1000,
                    index * 1000,
                    JSON.stringify({
                        type: "text",
                        text:
                            id === oldSummary
                                ? MARKER_SUMMARY_TEXT
                                : id === tailUser
                                  ? tailParts[0]!.text
                                  : id,
                    }),
                );
            }
            hostDb
                .prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)")
                .run(
                    "old-compaction",
                    oldBoundary,
                    sessionId,
                    0,
                    0,
                    JSON.stringify({ type: "compaction", auto: true }),
                );
            for (const [partIndex, part] of tailParts.entries()) {
                if (partIndex === 0) continue;
                hostDb
                    .prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)")
                    .run(
                        `${tailUser}-text-${partIndex}`,
                        tailUser,
                        sessionId,
                        4_000 + partIndex,
                        4_000 + partIndex,
                        JSON.stringify(part),
                    );
            }
            hostDb.close();
            setPersistedCompactionMarkerState(db, sessionId, {
                boundaryMessageId: oldBoundary,
                summaryMessageId: oldSummary,
                compactionPartId: "old-compaction",
                summaryPartId: `${oldSummary}-text`,
                boundaryOrdinal: 1,
                targetEndMessageId: oldBoundary,
            });
            const signals = promptHandler(db);
            const prompt = (date: string) => `Base\n<plugin-env>\n  Date: ${date}\n</plugin-env>`;
            await signals.handler({ sessionID: sessionId }, { system: [prompt("2026-10-12")] });
            appendCompartments(db, sessionId, [
                {
                    sequence: 0,
                    startMessage: 1,
                    endMessage: 1,
                    startMessageId: oldBoundary,
                    endMessageId: oldBoundary,
                    title: "Old",
                    content: "Old history",
                },
            ]);
            const deferredHistoryRefreshSessions = new Set<string>();
            let decision: "execute" | "defer" = "defer";
            // The content-miss case runs a held signed turn: its thinking step spent
            // 1,600 reasoning tokens and usage stays below the hold cap (65% + 10).
            const usage = new Map([
                [
                    sessionId,
                    {
                        usage: contentChange
                            ? { percentage: 70, inputTokens: 610_400 }
                            : { percentage: 75.4, inputTokens: 657_477 },
                        updatedAt: Date.now(),
                    },
                ],
            ]);
            const log = spyOn(logger, "sessionLog");
            const transform = createTransform({
                db,
                tagger: createTagger(),
                scheduler: { shouldExecute: () => decision },
                contextUsageMap: usage,
                liveModelBySession: new Map([[sessionId, model]]),
                historyRefreshSessions: signals.historyRefreshSessions,
                pendingMaterializationSessions: signals.pendingMaterializationSessions,
                deferredHistoryRefreshSessions,
                lastHeuristicsTurnId: new Map(),
                directory: root!,
                sessionDirectoryBySession: new Map([[sessionId, root!]]),
                protectedTokens: 0,
            });
            const source = () => [
                message(oldBoundary, "user"),
                {
                    ...message(oldSummary, "assistant"),
                    info: {
                        id: oldSummary,
                        role: "assistant",
                        sessionID: sessionId,
                        summary: true,
                        finish: "stop",
                    },
                    parts: [{ type: "text", text: MARKER_SUMMARY_TEXT }],
                },
                message(newBoundary, "user"),
                message(newEnd, "assistant"),
                { ...message(tailUser, "user"), parts: structuredClone(tailParts) },
            ];
            await transform({}, { messages: source() });
            const signedSource = () =>
                [
                    ...source(),
                    {
                        info: {
                            id: thinking,
                            role: "assistant",
                            sessionID: sessionId,
                            finish: "tool-calls",
                            ...(contentChange
                                ? { tokens: { input: 0, output: 0, reasoning: 1_600 } }
                                : {}),
                        },
                        parts: [
                            ...Array.from({ length: 98 }, (_, index) => ({
                                type: "reasoning",
                                text: `Signed thought ${index}`,
                                metadata: {
                                    anthropic: {
                                        signature: Buffer.from(
                                            Array.from(
                                                { length: contentChange ? 2_062 : 6_000 },
                                                (_, i) => (i * 73 + (i >> 2) + index) % 256,
                                            ),
                                        ).toString("base64"),
                                    },
                                },
                            })),
                            {
                                type: "tool",
                                callID: "read-call",
                                tool: "read",
                                state: { status: "completed", input: {}, output: "small result" },
                            },
                        ],
                    },
                ] as unknown as MessageLike[];
            const baseline = signedSource();
            if (!contentChange) {
                usage.set(sessionId, {
                    usage: { percentage: 75.4, inputTokens: 657_477 },
                    updatedAt: Date.now(),
                });
                decision = "execute";
            }
            await transform({}, { messages: baseline });
            if (!contentChange) {
                const fitting = estimateFinalWireInputTokens({
                    ...model,
                    messages: baseline,
                    systemPromptTokens: getOrCreateSessionMeta(db, sessionId).systemPromptTokens,
                });
                expect(fitting.tokens).toBeGreaterThan(600_000);
                expect(fitting.refusalTokens ?? fitting.tokens).toBeLessThan(872_000);
                expect(
                    baseline
                        .flatMap((row) => row.parts)
                        .filter((part) => part.type === "reasoning"),
                ).toHaveLength(98);
                decision = "defer";
            }
            const summaryText = (rows: MessageLike[]) =>
                rows.find((row) => row.info.summary)?.parts[0]?.text;
            const before = summaryText(baseline);
            expect(before).toContain(MARKER_SUMMARY_TEXT);
            appendCompartments(db, sessionId, [
                {
                    sequence: 1,
                    startMessage: 2,
                    endMessage: 4,
                    startMessageId: newBoundary,
                    endMessageId: newEnd,
                    title: "New",
                    content: "New history",
                },
            ]);
            setPendingCompactionMarkerState(db, sessionId, {
                ordinal: 4,
                endMessageId: newEnd,
                publishedAt: Date.now(),
            });
            deferredHistoryRefreshSessions.add(sessionId);
            if (contentChange)
                await signals.handler(
                    { sessionID: sessionId },
                    { system: [`Changed instructions\n${prompt("2026-10-13")}`] },
                );
            else {
                // A real user ends the protected tool loop; published history can now fold.
                usage.set(sessionId, {
                    usage: { percentage: 75.4, inputTokens: 657_477 },
                    updatedAt: Date.now(),
                });
                decision = "execute";
                const folded = [...signedSource(), message("msg_07", "user")];
                await transform({}, { messages: folded });
                expect(summaryText(folded)).not.toBe(before);
                decision = "defer";
                const defer = [...signedSource(), message("msg_07", "user")];
                await transform({}, { messages: defer });
                expect(JSON.stringify(defer)).toBe(JSON.stringify(folded));
                const heldSource = () =>
                    [
                        ...signedSource(),
                        message("msg_07", "user"),
                        {
                            info: {
                                id: "msg_08",
                                role: "assistant",
                                sessionID: sessionId,
                                finish: "tool-calls",
                            },
                            parts: [
                                {
                                    type: "reasoning",
                                    text: "New signed loop",
                                    metadata: { anthropic: { signature: "loop-signature" } },
                                },
                                {
                                    type: "tool",
                                    callID: "new-call",
                                    tool: "read",
                                    state: {
                                        status: "completed",
                                        input: {},
                                        output: "small result",
                                    },
                                },
                            ],
                        },
                    ] as unknown as MessageLike[];
                const warmSystem = { system: [prompt("2026-10-12")] };
                await signals.handler({ sessionID: sessionId }, warmSystem);
                const warmHeld = heldSource();
                await transform({}, { messages: warmHeld });
                const midnightSystem = { system: [prompt("2026-10-13")] };
                await signals.handler({ sessionID: sessionId }, midnightSystem);
                const midnightHeld = heldSource();
                await transform({}, { messages: midnightHeld });
                expect(JSON.stringify(midnightSystem)).toBe(JSON.stringify(warmSystem));
                expect(JSON.stringify(midnightHeld)).toBe(JSON.stringify(warmHeld));
                expect(signals.pendingMaterializationSessions.has(sessionId)).toBe(false);
                expect(deferredHistoryRefreshSessions.has(sessionId)).toBe(false);
                const logs = log.mock.calls.map((call) => call.slice(1).join(" ")).join("\n");
                expect(logs).not.toContain("context=95.0%");
                expect(logs).not.toContain("origin=fit_retry");
                const folds = logs
                    .split("\n")
                    .filter((line) => line.includes("m[0] HARD") && line.includes("executed=true"));
                expect(folds).toHaveLength(1);
                log.mockRestore();
                return;
            }
            expect(signals.pendingMaterializationSessions.has(sessionId)).toBe(true);
            const held = signedSource();
            await transform({}, { messages: held });
            expect(summaryText(held)).toBe(before);
            expect(signals.pendingMaterializationSessions.has(sessionId)).toBe(true);
            expect(getPersistedCompactionMarkerState(db, sessionId)?.summaryMessageId).toBe(
                oldSummary,
            );
            const released = [...signedSource(), message("msg_07", "user")];
            await transform({}, { messages: released });
            expect(signals.pendingMaterializationSessions.has(sessionId)).toBe(false);
            expect(getPersistedCompactionMarkerState(db, sessionId)?.summaryMessageId).not.toBe(
                oldSummary,
            );
            expect(summaryText(released)).not.toBe(before);
            expect(summaryText(released)).toContain(MARKER_SUMMARY_TEXT);
            expect(log.mock.calls.map((call) => call.slice(1).join(" ")).join("\n")).toContain(
                "pending ops WILL APPLY — reason=pending_materialization origin=system_hash",
            );
            log.mockRestore();
        },
    );
}

it("transform captures immutable trim evidence even without a deferred refresh", async () => {
    const db = setup();
    appendCompartments(db, sessionId, [
        {
            sequence: 0,
            startMessage: 1,
            endMessage: 2,
            startMessageId: "covered-user",
            endMessageId: "assistant-boundary",
            title: "Old",
            content: "Covered history",
        },
    ]);
    const signals = promptHandler(db);
    const original = injection.injectM0M1;
    let captured: readonly string[] | undefined;
    const spy = spyOn(injection, "injectM0M1").mockImplementation((options) => {
        captured = options.prefixTrimSourceOrder?.messageIds;
        return original(options);
    });
    try {
        const transform = createTransform({
            db,
            tagger: createTagger(),
            scheduler: { shouldExecute: () => "defer" },
            contextUsageMap: new Map(),
            liveModelBySession: new Map([[sessionId, model]]),
            historyRefreshSessions: signals.historyRefreshSessions,
            pendingMaterializationSessions: signals.pendingMaterializationSessions,
            lastHeuristicsTurnId: new Map(),
            directory: root!,
            sessionDirectoryBySession: new Map([[sessionId, root!]]),
            protectedTokens: 0,
        });
        await transform(
            {},
            {
                messages: [
                    message("covered-user", "user"),
                    message("assistant-boundary", "assistant"),
                    message("tail", "user"),
                ],
            },
        );
        expect(captured).toEqual(["covered-user", "assistant-boundary", "tail"]);
    } finally {
        spy.mockRestore();
    }
});

import { recordDetectedContextLimit } from "../../features/magic-context/storage-meta-persisted";
import {
    __resetToolDefinitionMeasurements,
    recordToolDefinition,
} from "../../features/magic-context/tool-definition-tokens";
import { applyV2SystemPrompt } from "../../v2/hooks/context";

import { beginSystemDateRequest } from "./system-date-refresh";
