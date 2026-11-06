import { expect, test } from "bun:test";
import {
    getAllStatusTagTokenTotalsFlat,
    getOrCreateSessionMeta,
    insertTag,
    markProtectedTailPolicyV3Seeded,
    reserveProtectedTailDrainTokens,
    updateTagStatus,
} from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { checkCompartmentTrigger } from "./compartment-trigger";
import { resolveOpenCodeProtectedTailBoundary, selectPerRunCap } from "./protected-tail-boundary";
import { withRawMessageProvider } from "./read-session-chunk";
import type { RawMessage } from "./read-session-raw";
import {
    buildTrueRawTokenIndex,
    estimateTrueRawMessageTokens,
} from "./read-session-true-raw-tokens";

function tool(id: string, output: string) {
    return {
        type: "tool",
        callID: id,
        tool: "read",
        state: { status: "completed", input: { path: id }, output },
    };
}

test("summary cap and drain admit a small head followed by large tool outputs, kept or dropped", () => {
    const db = new Database(":memory:");
    initializeDatabase(db);
    const sessionId = "summary-removed-weight";
    const messages: RawMessage[] = [
        { id: "m1", ordinal: 1, role: "assistant", parts: [{ type: "text", text: "seed" }] },
        {
            id: "m2",
            ordinal: 2,
            role: "assistant",
            parts: [tool("large", "result ".repeat(20_000))],
        },
        { id: "m3", ordinal: 3, role: "assistant", parts: [tool("tail", "tail ".repeat(8_000))] },
    ];
    const options = { providerShapeVersion: "opencode-v1" as const };
    markProtectedTailPolicyV3Seeded(db, sessionId, 1);
    try {
        withRawMessageProvider(sessionId, { readMessages: () => messages }, () => {
            const resolve = () => ({
                ...resolveOpenCodeProtectedTailBoundary({
                    db,
                    sessionId,
                    mode: "trigger",
                    contextLimit: 100_000,
                    executeThresholdPercentage: 65,
                    usage: { percentage: 64, inputTokens: 64_000 },
                }),
                createdAt: 1,
            });
            const live = resolve();
            expect(live.protectedTailStart).toBe(3);
            expect(live.eligibleEndOrdinal).toBe(3);
            expect(live.trueRawEligibleTokens).toBeGreaterThan(16_250);
            const first = estimateTrueRawMessageTokens(messages[0], options);
            const second = estimateTrueRawMessageTokens(messages[1], options);
            expect(live.summaryRemovedEligibleTokens).toBe(first.text + second.toolInput);
            expect(live.oversizeAtomicUnit).toBe(false);
            messages.forEach((message, i) => {
                const raw = estimateTrueRawMessageTokens(message, options);
                insertTag(
                    db,
                    sessionId,
                    message.id,
                    i ? "tool" : "message",
                    1,
                    i + 1,
                    0,
                    null,
                    0,
                    i ? message.id : null,
                    null,
                    {
                        tokenCount: i ? raw.toolOutput : raw.text,
                        inputTokenCount: raw.toolInput,
                        reasoningTokenCount: 0,
                    },
                );
            });
            expect(resolve()).toEqual(live);
            for (let tag = 1; tag <= 3; tag++) updateTagStatus(db, sessionId, tag, "dropped");
            expect(resolve()).toEqual(live);
            const reservation = reserveProtectedTailDrainTokens({
                db,
                sessionId,
                runId: "run",
                now: 1,
                trueRawTokens: live.summaryRemovedEligibleTokens,
                usable: 65_000,
                perRunCap: selectPerRunCap(live),
                usagePercentage: 64,
                executeThresholdPercentage: 65,
            });
            expect(reservation.reservedTokens).toBe(first.text + second.toolInput);
        });
    } finally {
        db.close();
    }
});

test("meaningful history still counts full tool output at the 6000-token threshold", () => {
    const db = new Database(":memory:");
    initializeDatabase(db);
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
        for (const [id, repeats, meaningful] of [
            ["large", 10_000, true],
            ["small", 4_000, false],
        ] as const) {
            const messages: RawMessage[] = [
                {
                    id: "m1",
                    ordinal: 1,
                    role: "assistant",
                    parts: [{ type: "text", text: "seed" }],
                },
                {
                    id: "m2",
                    ordinal: 2,
                    role: "assistant",
                    parts: [tool("head", "result ".repeat(repeats))],
                },
                {
                    id: "m3",
                    ordinal: 3,
                    role: "assistant",
                    parts: [tool("tail", "tail ".repeat(8_000))],
                },
            ];
            markProtectedTailPolicyV3Seeded(db, id, 1);
            const usage = { percentage: 64, inputTokens: 64_000 };
            const result = withRawMessageProvider(id, { readMessages: () => messages }, () =>
                checkCompartmentTrigger(
                    db,
                    id,
                    getOrCreateSessionMeta(db, id),
                    usage,
                    64,
                    65,
                    5_000,
                    10_000,
                    { enabled: false, min_clusters: 3 },
                    undefined,
                    100_000,
                ),
            );
            expect(result.shouldFire).toBe(meaningful);
        }
    } finally {
        if (originalEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = originalEnv;
        db.close();
    }
});

test("tiny rows before an oversized inline image do not pin the meaningful head", () => {
    const db = new Database(":memory:");
    initializeDatabase(db);
    const sessionId = "inline-image-summary-head";
    const messages: RawMessage[] = [
        ...[1, 2, 3].map((ordinal) => ({
            id: `m${ordinal}`,
            ordinal,
            role: "assistant" as const,
            parts: [{ type: "text", text: "quote" }],
        })),
        {
            id: "m4",
            ordinal: 4,
            role: "user",
            parts: [{ type: "file", data: `/9j/${"a".repeat(222_708)}` }],
        },
        {
            id: "m5",
            ordinal: 5,
            role: "assistant",
            parts: [tool("large", "result ".repeat(20_000))],
        },
        { id: "m6", ordinal: 6, role: "assistant", parts: [tool("tail", "tail ".repeat(8_000))] },
    ];
    markProtectedTailPolicyV3Seeded(db, sessionId, 1);
    try {
        withRawMessageProvider(sessionId, { readMessages: () => messages }, () => {
            const snapshot = resolveOpenCodeProtectedTailBoundary({
                db,
                sessionId,
                mode: "trigger",
                contextLimit: 100_000,
                executeThresholdPercentage: 65,
                usage: { percentage: 64, inputTokens: 64_000 },
            });
            expect(snapshot.eligibleEndOrdinal).toBe(6);
            expect(snapshot.summaryRemovedEligibleTokens).toBeLessThan(100);
            expect(snapshot.trueRawEligibleTokens).toBeGreaterThan(6_000);
            expect(snapshot.oversizeAtomicUnit).toBe(false);
        });
    } finally {
        db.close();
    }
});

test("stored and live summary weights apply separate ratios and exclude reasoning and media", () => {
    const db = new Database(":memory:");
    initializeDatabase(db);
    const sessionId = "calibrated-summary-weight";
    const message: RawMessage = {
        id: "m1",
        ordinal: 1,
        role: "assistant",
        parts: [
            { type: "text", text: "some prose" },
            tool("read", "large output"),
            { type: "reasoning", text: "private reasoning" },
            { type: "image", width: 1024, height: 768 },
        ],
    };
    const options = {
        providerShapeVersion: "opencode-v1" as const,
        cacheNamespace: sessionId,
        measure: "summary-removed" as const,
        calibration: { proseRatio: 2, toolsRatio: 3, systemRatio: 1 },
    };
    const raw = estimateTrueRawMessageTokens(message, options);
    const expected = raw.text * 2 + raw.toolInput * 3;
    try {
        insertTag(db, sessionId, "m1:p0", "message", 1, 1, 0, null, 0, null, null, {
            tokenCount: raw.text,
            inputTokenCount: 0,
            reasoningTokenCount: raw.reasoning,
        });
        insertTag(db, sessionId, "read", "tool", 1, 2, 0, null, 0, "m1", null, {
            tokenCount: raw.toolOutput,
            inputTokenCount: raw.toolInput,
            reasoningTokenCount: 0,
        });
        insertTag(db, sessionId, "m1:file0", "file", 1, 3, 0, null, 0, null, null, {
            tokenCount: raw.image,
            inputTokenCount: 0,
            reasoningTokenCount: 0,
        });
        const live = buildTrueRawTokenIndex(sessionId, [message], options);
        expect(live.rangeTokens(1, 2)).toBe(expected);
        for (const status of ["active", "dropped"] as const) {
            for (let tag = 1; tag <= 3; tag++) updateTagStatus(db, sessionId, tag, status);
            const stored = getAllStatusTagTokenTotalsFlat(db, sessionId, 0, options.calibration);
            expect(stored.summaryRemovedTotals.get("m1")).toBe(expected);
            const index = buildTrueRawTokenIndex(sessionId, [message], {
                ...options,
                storedTotalForMessage: (m) => stored.summaryRemovedTotals.get(m.id) ?? null,
            });
            expect(index.rangeTokens(1, 2)).toBe(expected);
        }
        db.prepare("UPDATE tags SET input_token_count = NULL WHERE type = 'tool'").run();
        expect(getAllStatusTagTokenTotalsFlat(db, sessionId).summaryRemovedTotals.has("m1")).toBe(
            false,
        );
    } finally {
        db.close();
    }
});
