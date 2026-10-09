import { expect, test } from "bun:test";
import { runMigrations } from "../../features/magic-context/migrations";
import { createScheduler } from "../../features/magic-context/scheduler";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { addMergedReasoningStrippedIds } from "../../features/magic-context/storage-meta-persisted";
import { createTagger } from "../../features/magic-context/tagger";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    armLatestThinkingRecovery,
    captureLatestTurnOriginals,
    prepareLatestThinkingRecovery,
} from "./latest-thinking-recovery";
import type { MessageLike } from "./tag-messages";
import { createTransform } from "./transform";

function database() {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function originals(sessionId = "review"): MessageLike[] {
    const model = { providerID: "anthropic", modelID: "claude-opus-5-5" };
    return [
        {
            info: { id: "u", role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: "task" }],
        },
        {
            info: {
                id: "a",
                role: "assistant",
                sessionID: sessionId,
                ...model,
            },
            parts: [
                {
                    type: "reasoning",
                    text: "original",
                    metadata: { anthropic: { signature: "sig-original" } },
                },
                {
                    type: "tool",
                    tool: "read",
                    callID: "t",
                    state: { status: "completed", input: {}, output: "spent" },
                },
            ],
        },
    ];
}

for (const generation of ["v1", "v2"] as const) {
    test(`review issue630 ${generation} 95 percent without unsafe work still serves a fitting unchanged turn`, async () => {
        const db = database();
        const sessionId = `review-95-${generation}`;
        const usage = new Map();
        getOrCreateSessionMeta(db, sessionId);
        const transform = createTransform({
            db,
            storeGeneration: generation,
            tagger: createTagger(),
            scheduler: createScheduler({ executeThresholdPercentage: 65 }),
            liveModelBySession: new Map([
                [sessionId, { providerID: "anthropic", modelID: "claude-opus-5-5" }],
            ]),
            contextUsageMap: usage,
            clearReasoningAge: 1000,
            protectedTokens: 4000,
            historyRefreshSessions: new Set(),
            pendingMaterializationSessions: new Set(),
            lastHeuristicsTurnId: new Map(),
        });
        const pass = async () => {
            const messages = structuredClone(originals(sessionId));
            await transform({}, { messages });
            return messages;
        };
        try {
            const before = await pass();
            usage.set(sessionId, {
                usage: { percentage: 95, inputTokens: 95_000 },
                updatedAt: Date.now(),
                hasUsageTokens: true,
            });
            // There is no queued edit and only one signed response. The provider's
            // existing usage still fits its window; 95% is not an overflow receipt.
            expect(JSON.stringify(await pass())).toBe(JSON.stringify(before));
        } finally {
            closeQuietly(db);
        }
    });
}

test("review issue630 recovery cannot bind a rejection to a later real user turn", () => {
    const db = database();
    const messages = originals();
    try {
        armLatestThinkingRecovery(db, "review");
        // The host resumes only after the user has started a different turn.
        messages.push(
            { info: { id: "next-u", role: "user" }, parts: [{ type: "text", text: "new task" }] },
            {
                info: { id: "next-a", role: "assistant" },
                parts: [{ type: "reasoning", text: "new thinking", signature: "sig-new" }],
            },
        );
        const recovery = prepareLatestThinkingRecovery({
            db,
            sessionId: "review",
            messages,
            id: (m) => (m as MessageLike).info.id,
            parts: (m) => (m as MessageLike).parts,
        });
        expect(recovery.restore).toBe(false);
    } finally {
        closeQuietly(db);
    }
});

test("review issue630 envelope restoration leaves historical thinking omitted", () => {
    const messages = originals();
    messages.unshift(
        { info: { id: "old-u", role: "user" }, parts: [{ type: "text", text: "old task" }] },
        {
            info: { id: "old-a", role: "assistant" },
            parts: [{ type: "text", text: "historical thinking already omitted" }],
        },
    );
    const historical = JSON.stringify(messages.slice(0, 2));
    const restore = captureLatestTurnOriginals(messages);
    messages[3]!.parts = [];
    restore();
    expect(JSON.stringify(messages.slice(0, 2))).toBe(historical);
    expect(messages[3]!.parts).toEqual(originals()[1]!.parts);
});

test("review issue630 recovery restores an envelope after an already frozen tool drop", async () => {
    const db = database();
    const sessionId = "review-envelope";
    getOrCreateSessionMeta(db, sessionId);
    const transform = createTransform({
        db,
        tagger: createTagger(),
        scheduler: createScheduler({ executeThresholdPercentage: 65 }),
        liveModelBySession: new Map([
            [sessionId, { providerID: "anthropic", modelID: "claude-opus-5-5" }],
        ]),
        contextUsageMap: new Map(),
        clearReasoningAge: 1000,
        protectedTokens: 0,
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
    });
    try {
        const baseline = structuredClone(originals(sessionId));
        await transform({}, { messages: baseline });
        addMergedReasoningStrippedIds(db, sessionId, ["binding_mismatch:a"]);
        // Persist an accepted legacy truncation of the tool envelope. Restoring
        // thinking alone is insufficient on a prefix-bound provider.
        db.prepare("UPDATE tags SET status = 'dropped' WHERE session_id = ? AND type = 'tool'").run(
            sessionId,
        );
        armLatestThinkingRecovery(db, sessionId);
        const replay = structuredClone(originals(sessionId));
        await transform({}, { messages: replay });
        expect(JSON.stringify(replay)).toBe(JSON.stringify(baseline));
    } finally {
        closeQuietly(db);
    }
});
