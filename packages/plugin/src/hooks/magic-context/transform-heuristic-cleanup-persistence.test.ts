/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Scheduler } from "../../features/magic-context/scheduler";
import {
    closeDatabase,
    getTagsBySession,
    openDatabase,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import type { ContextUsage } from "../../features/magic-context/types";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { createTransform } from "./transform";

type TestPart =
    | { type: "text"; text: string }
    | {
          type: "tool";
          callID: string;
          state: { output: string; tool?: string; input?: Record<string, string> };
      };

type TestMessage = {
    info: { id?: string; role: string; sessionID?: string };
    parts: TestPart[];
};

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

function useTempDataHome(prefix: string): void {
    const dir = createTestTempDirFromPath(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

function makeTempDir(prefix: string): string {
    const dir = createTestTempDirFromPath(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function buildMessages(): TestMessage[] {
    return [
        {
            info: { id: "m-user", role: "user", sessionID: "ses-heuristic-persist" },
            parts: [{ type: "text", text: "continue" }],
        },
        {
            info: { id: "m-injection", role: "assistant" },
            parts: [
                {
                    type: "text",
                    text: "[Category+Skill Reminder]\nUse task()\n\nVisible answer",
                },
            ],
        },
        {
            info: { id: "m-tool", role: "assistant" },
            parts: [
                {
                    type: "tool",
                    callID: "call-1",
                    state: {
                        // Large enough that the tiered emergency drop reclaims it.
                        // Realistic content, not a single repeated char (that is a
                        // ~17s BPE tokenizer pathology under the per-tag token store).
                        output: "const value = compute(input, options); // line\n".repeat(4200),
                        tool: "mcp_read",
                        input: { path: "a.ts" },
                    },
                },
            ],
        },
        {
            info: { id: "m-tail", role: "assistant" },
            parts: [{ type: "text", text: "Newest assistant message" }],
        },
    ];
}

function buildInjectionOnlyMessages(): TestMessage[] {
    return [
        {
            info: { id: "m-user", role: "user", sessionID: "ses-heuristic-persist-empty" },
            parts: [{ type: "text", text: "continue" }],
        },
        {
            info: { id: "m-injection-only", role: "assistant" },
            parts: [
                {
                    type: "text",
                    text: "[Category+Skill Reminder]\nUse task()",
                },
            ],
        },
        {
            info: { id: "m-tail", role: "assistant" },
            parts: [{ type: "text", text: "Newest assistant message" }],
        },
    ];
}

function getMessage(messages: TestMessage[], id: string): TestMessage | undefined {
    return messages.find((message) => message.info.id === id);
}

function getTextPart(message: TestMessage): Extract<TestPart, { type: "text" }> {
    const part = message.parts[0];
    if (part?.type !== "text") {
        throw new Error(`expected text part for ${message.info.id ?? "unknown message"}`);
    }

    return part;
}

function stripTagPrefix(value: string): string {
    return value.replace(/^§\d+§\s*/, "");
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

function makeTestDirectory(prefix: string): string {
    return makeTempDir(prefix);
}

describe("createTransform heuristic cleanup persistence", () => {
    it("replays caveman compression before inline reasoning strips on defer", async () => {
        useTempDataHome("context-transform-caveman-inline-");
        const sessionId = "ses-caveman-inline";
        const schedulerDecision = mock<Scheduler["shouldExecute"]>(() => "execute");
        const db = openDatabase();
        const pendingMaterializationSessions = new Set([sessionId]);
        const transform = createTransform({
            tagger: createTagger(),
            scheduler: { shouldExecute: schedulerDecision },
            contextUsageMap: new Map([
                [
                    sessionId,
                    { usage: { percentage: 90, inputTokens: 180_000 }, updatedAt: Date.now() },
                ],
            ]),
            db,
            historyRefreshSessions: new Set(),
            pendingMaterializationSessions,
            lastHeuristicsTurnId: new Map(),
            keepReasoningTokens: 0,
            protectedTokens: 1,
            cavemanTextCompression: { enabled: true, minChars: 20 },
            directory: makeTestDirectory("context-transform-caveman-inline-dir-"),
            getHistorianChunkTokens: () => 20_000,
        });
        const messages = (): TestMessage[] => [
            {
                info: { id: "u1", role: "user", sessionID: sessionId },
                parts: [
                    {
                        type: "text",
                        text: "Please review the implementation and verify the results carefully.",
                    },
                ],
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
            {
                info: { id: "u2", role: "user" },
                parts: [
                    {
                        type: "text",
                        text: "Continue with the implementation and review the results carefully.",
                    },
                ],
            },
            {
                info: { id: "a2", role: "assistant" },
                parts: [{ type: "text", text: "latest answer" }],
            },
            { info: { id: "u3", role: "user" }, parts: [{ type: "text", text: "latest request" }] },
        ];
        const executed = messages();
        await transform({}, { messages: executed });
        expect(JSON.stringify(executed)).not.toContain("stale private thought");
        expect(getTagsBySession(db, sessionId).some((tag) => tag.cavemanDepth > 0)).toBe(true);
        schedulerDecision.mockImplementation(() => "defer");
        const deferred = messages();
        await transform({}, { messages: deferred });
        expect(JSON.stringify(deferred)).toBe(JSON.stringify(executed));
    });

    it("keeps execute-time heuristic truncation on the execute pass before later defer replay", async () => {
        useTempDataHome("context-transform-heuristic-persist-");
        const testDirectory = makeTestDirectory("context-transform-heuristic-dir-");

        const schedulerDecision = mock<Scheduler["shouldExecute"]>(() => "defer");
        const scheduler: Scheduler = { shouldExecute: schedulerDecision };
        // Three-set cache-busting signals replace the old single
        // `flushedSessions`. To simulate a `/ctx-flush` we add to the
        // persistent `pendingMaterializationSessions` set (read by
        // postprocess `isExplicitFlush`). History/system sets are not
        // needed for this heuristic test.
        const historyRefreshSessions = new Set<string>();
        const pendingMaterializationSessions = new Set<string>();
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    "ses-heuristic-persist",
                    // >=85% so the tiered emergency drop fires on the execute pass.
                    { usage: { percentage: 86, inputTokens: 172_000 }, updatedAt: Date.now() },
                ],
            ]),
            db: openDatabase(),
            historyRefreshSessions,
            pendingMaterializationSessions,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTokens: 1,
            client: undefined,
            directory: testDirectory,
            getHistorianChunkTokens: () => 20_000,
        });

        await transform({}, { messages: buildMessages() });

        schedulerDecision.mockImplementation(() => "execute");
        pendingMaterializationSessions.add("ses-heuristic-persist");
        const executePass = buildMessages();
        await transform({}, { messages: executePass });

        // The newest-window emergency arm keeps a skeleton for the tool arc.
        expect(getMessage(executePass, "m-tool")).toBeDefined();
        const executeInjection = getMessage(executePass, "m-injection");
        expect(executeInjection).toBeDefined();
        expect(stripTagPrefix(getTextPart(executeInjection!).text)).toBe("Visible answer");

        schedulerDecision.mockImplementation(() => "defer");
        const deferPass = buildMessages();
        await transform({}, { messages: deferPass });

        expect(getMessage(deferPass, "m-tool")).toBeDefined();
        const deferredInjection = getMessage(deferPass, "m-injection");
        expect(deferredInjection).toBeDefined();
        expect(stripTagPrefix(getTextPart(deferredInjection!).text)).toBe("Visible answer");
        expect(getTextPart(deferredInjection!).text).not.toContain("[Category+Skill Reminder]");
    });

    it("keeps injection-only messages dropped across a later defer pass", async () => {
        useTempDataHome("context-transform-heuristic-persist-empty-");
        const testDirectory = makeTestDirectory("context-transform-heuristic-dir-empty-");

        const schedulerDecision = mock<Scheduler["shouldExecute"]>(() => "defer");
        const scheduler: Scheduler = { shouldExecute: schedulerDecision };
        const historyRefreshSessions = new Set<string>();
        const pendingMaterializationSessions = new Set<string>();
        const transform = createTransform({
            tagger: createTagger(),
            scheduler,
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    "ses-heuristic-persist-empty",
                    { usage: { percentage: 45, inputTokens: 90_000 }, updatedAt: Date.now() },
                ],
            ]),
            db: openDatabase(),
            historyRefreshSessions,
            pendingMaterializationSessions,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTokens: 1,
            client: undefined,
            directory: testDirectory,
            getHistorianChunkTokens: () => 20_000,
        });

        await transform({}, { messages: buildInjectionOnlyMessages() });

        schedulerDecision.mockImplementation(() => "execute");
        pendingMaterializationSessions.add("ses-heuristic-persist-empty");
        const executePass = buildInjectionOnlyMessages();
        await transform({}, { messages: executePass });

        // Sentinel-based stripping preserves array length; the injection-only
        // message is kept in the array but neutralized to a single sentinel.
        // Test doesn't set providerID → `[dropped]` text (non-anthropic safe).
        // Anthropic-only optimization (text="") is covered in dedicated tests.
        const executeInjection = getMessage(executePass, "m-injection-only");
        expect(executeInjection?.parts).toEqual([{ type: "text", text: "[dropped]" }]);

        schedulerDecision.mockImplementation(() => "defer");
        const deferPass = buildInjectionOnlyMessages();
        await transform({}, { messages: deferPass });

        // Replay on defer: same neutralization persists without re-mutating array.
        const deferredInjection = getMessage(deferPass, "m-injection-only");
        expect(deferredInjection?.parts).toEqual([{ type: "text", text: "[dropped]" }]);
    });
});
