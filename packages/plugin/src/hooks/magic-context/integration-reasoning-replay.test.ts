import { expect, spyOn, test } from "bun:test";
import { runMigrations } from "../../features/magic-context/migrations";
import { createScheduler } from "../../features/magic-context/scheduler";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { addMergedReasoningStrippedIds } from "../../features/magic-context/storage-meta-persisted";
import { createTagger } from "../../features/magic-context/tagger";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import type { MessageLike } from "./tag-messages";
import { createTransform } from "./transform";
import * as postprocess from "./transform-postprocess-phase";

// Exercise the registered transform, not just the pure finalizer: a persisted
// omission is not a provider rejection and must never authorize restoration.
test("ordinary defer does not authorize restoring persisted active thinking", async () => {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    const sessionId = "integration-absorbing-defer";
    getOrCreateSessionMeta(db, sessionId);
    const model = { providerID: "anthropic", modelID: "claude-opus-5-5" };
    const source = (): MessageLike[] => [
        {
            info: { id: "u", role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: "task" }],
        },
        {
            info: { id: "a1", role: "assistant", sessionID: sessionId, ...model },
            parts: [
                { type: "reasoning", text: "first original", signature: "sig-first" },
                {
                    type: "tool",
                    tool: "read",
                    callID: "t1",
                    state: { status: "completed", input: {}, output: "spent" },
                },
            ],
        },
        {
            info: { id: "a2", role: "assistant", sessionID: sessionId, ...model },
            parts: [
                { type: "reasoning", text: "last original", signature: "sig-last" },
                { type: "text", text: "answer" },
            ],
        },
    ];
    const transform = createTransform({
        db,
        tagger: createTagger(),
        scheduler: createScheduler({ executeThresholdPercentage: 65 }),
        liveModelBySession: new Map([[sessionId, model]]),
        contextUsageMap: new Map(),
        keepReasoningTokens: 10_000,
        protectedTokens: 0,
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
    });
    const observation = spyOn(postprocess, "runPostTransformPhase");
    try {
        const baseline = source();
        await transform({}, { messages: baseline });
        expect(JSON.stringify(baseline)).toContain("first original");
        addMergedReasoningStrippedIds(db, sessionId, ["binding_mismatch:a1"]);
        observation.mockClear();
        let served = "";
        for (let pass = 0; pass < 3; pass++) {
            const messages = source();
            await transform({}, { messages });
            const args = observation.mock.calls.at(-1)?.[0];
            expect(args).toBeDefined();
            expect(args!.schedulerDecision).toBe("defer");
            expect(args!.restoreThinkingMessageIds).toBeUndefined();
            const bytes = JSON.stringify(messages);
            expect(bytes).not.toContain("first original");
            expect(bytes).not.toContain("sig-first");
            expect(bytes).toContain("last original");
            if (pass > 0) expect(bytes).toBe(served);
            served = bytes;
        }
        expect(observation.mock.calls).toHaveLength(3);
    } finally {
        observation.mockRestore();
        closeQuietly(db);
    }
});
