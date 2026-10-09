/// <reference types="bun-types" />

// Caveman compression and inline-thinking removal across an execute pass and
// the defer pass that follows it. Each test drives the real transform; the
// cache contract requires the defer pass to send the same bytes the execute
// pass sent.

import { afterEach, describe, expect, it, mock } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Scheduler } from "../../features/magic-context/scheduler";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    getTagsBySession,
    openDatabase,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { createTransform } from "./transform";

type TestMessage = {
    info: { id?: string; role: string; sessionID?: string };
    parts: Array<{ type: "text"; text: string }>;
};

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

function makeTempDir(prefix: string): string {
    const dir = createTestTempDirFromPath(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* Ignore EBUSY on Windows */
        }
    }
    tempDirs.length = 0;
});

const PROSE =
    "Please review the implementation and verify the results carefully before we continue with the next step.";

function longText(label: string): string {
    return `${label}: ${PROSE}`;
}

// Turns 1-2 carry an assistant answer with inline <think> markup, the shape some
// OpenAI-compatible routes return. Later turns only add caveman-eligible prose.
function conversation(sessionId: string, extraTurns: number): TestMessage[] {
    const messages: TestMessage[] = [
        {
            info: { id: "u1", role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: longText("first request") }],
        },
        {
            info: { id: "a1", role: "assistant" },
            parts: [
                {
                    type: "text",
                    text: "The implementation has been completed <think>stale private thought</think> and the verification results are available for the reviewer.",
                },
            ],
        },
    ];
    for (let turn = 2; turn < 2 + extraTurns; turn++) {
        messages.push(
            {
                info: { id: `u${turn}`, role: "user" },
                parts: [{ type: "text", text: longText(`request ${turn}`) }],
            },
            {
                info: { id: `a${turn}`, role: "assistant" },
                parts: [{ type: "text", text: longText(`answer ${turn}`) }],
            },
        );
    }
    messages.push(
        {
            info: { id: "u-last", role: "user" },
            parts: [{ type: "text", text: "Continue with the implementation." }],
        },
        { info: { id: "a-last", role: "assistant" }, parts: [{ type: "text", text: "ok" }] },
        { info: { id: "u-now", role: "user" }, parts: [{ type: "text", text: "latest request" }] },
    );
    return messages;
}

function a1Text(messages: TestMessage[]): string {
    const message = messages.find((candidate) => candidate.info.id === "a1");
    return message?.parts[0]?.text ?? "";
}

function makeTransform(
    sessionId: string,
    db: ReturnType<typeof openDatabase>,
    schedulerDecision: Scheduler["shouldExecute"],
    clearReasoningAge: number,
) {
    return createTransform({
        tagger: createTagger(),
        scheduler: { shouldExecute: schedulerDecision },
        contextUsageMap: new Map([
            [sessionId, { usage: { percentage: 90, inputTokens: 180_000 }, updatedAt: Date.now() }],
        ]),
        db,
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set([sessionId]),
        lastHeuristicsTurnId: new Map(),
        keepReasoningTokens: clearReasoningAge === 1 ? 0 : 100_000,
        protectedTokens: 1,
        cavemanTextCompression: { enabled: true, minChars: 20 },
        directory: makeTempDir("context-caveman-order-review-dir-"),
        getHistorianChunkTokens: () => 20_000,
    });
}

describe("caveman replay order review", () => {
    it("serves the same a1 bytes on the defer pass after a raised clear_reasoning_age lets an execute pass deepen caveman below the persisted watermark", async () => {
        process.env.XDG_DATA_HOME = makeTempDir("context-caveman-order-review-");
        const sessionId = "ses-caveman-age-raise";
        const schedulerDecision = mock<Scheduler["shouldExecute"]>(() => "execute");
        const db = openDatabase();

        // Execute with clear_reasoning_age=1: the inline strip removes a1's
        // <think> block, persists the shared reasoning watermark, and caveman
        // compresses a1.
        const before = makeTransform(sessionId, db, schedulerDecision, 1);
        const first = conversation(sessionId, 1);
        await before({}, { messages: first });
        expect(a1Text(first)).not.toContain("stale private thought");
        const watermark = getOrCreateSessionMeta(db, sessionId).clearedReasoningThroughTag;
        const a1Tag = getTagsBySession(db, sessionId).find((tag) => tag.messageId === "a1:p0");
        expect(watermark).toBeGreaterThanOrEqual(a1Tag?.tagNumber ?? Number.POSITIVE_INFINITY);
        const firstDepth = a1Tag?.cavemanDepth ?? 0;
        expect(firstDepth).toBeGreaterThan(0);

        // Restart with clear_reasoning_age=100. The persisted watermark still
        // covers a1, but this pass's fresh inline strip no longer reaches it.
        // More turns move a1 into a deeper caveman tier, and fresh compression
        // rebuilds its text from source, <think> block included.
        const after = makeTransform(sessionId, db, schedulerDecision, 100);
        const executed = conversation(sessionId, 6);
        await after({}, { messages: executed });
        const deepened = getTagsBySession(db, sessionId).find((tag) => tag.messageId === "a1:p0");
        expect(deepened?.cavemanDepth ?? 0).toBeGreaterThan(firstDepth);
        expect(getOrCreateSessionMeta(db, sessionId).clearedReasoningThroughTag).toBe(watermark);

        schedulerDecision.mockImplementation(() => "defer");
        const deferred = conversation(sessionId, 6);
        await after({}, { messages: deferred });

        expect(a1Text(deferred)).toBe(a1Text(executed));
    });
});
