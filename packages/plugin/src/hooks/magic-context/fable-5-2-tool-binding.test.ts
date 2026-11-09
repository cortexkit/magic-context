/// <reference types="bun-types" />

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __resetMessageIndexAsyncForTests } from "../../features/magic-context/message-index-async";
import { v2ToolDefinitionsHash } from "../../features/magic-context/request-tool-definitions";
import { createScheduler } from "../../features/magic-context/scheduler";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    openDatabase,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import {
    __resetToolDefinitionMeasurements,
    getCurrentToolSetHash,
    recordToolDefinition,
} from "../../features/magic-context/tool-definition-tokens";
import { __test as transformDecisionTest } from "../../features/magic-context/transform-decision-log";
import type { ContextUsage } from "../../features/magic-context/types";
import * as loggerModule from "../../shared/logger";
import { clearModelsDevCache } from "../../shared/models-dev-cache";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { resetLkgSlotsForTest } from "./lkg-slot";
import { __ignoredNotificationTest } from "./send-session-notification";
import { createTransform } from "./transform";

// Claude 5.1 and later models bind every signed thinking block to the `system`
// prompt, the `tools` array and the messages sent before it. Anthropic's edit
// table lists "Add, remove, rename, or edit a tool in `tools`" as invalidating
// those blocks, and Claude Fable 5.2 returns a 400 for an invalid block on
// every account. A request whose tool list changed therefore has to go out
// without the thinking earlier requests served.
//
// These tests run the shared transform with the tool signals each OpenCode
// adapter wires into it: OpenCode 1 passes only the names-only, route-wide
// hash its `tool.definition` hook records (hook.ts), and OpenCode 2 also
// passes the request's own name-and-description identity (v2/hooks/context.ts).

const MODEL = { providerID: "anthropic", modelID: "claude-fable-5-2" } as const;
const AGENT = "build";
const THINKING = "SIGNED_AGAINST_THE_FIRST_TOOL_LIST";

type Part = Record<string, unknown>;
type Message = { info: Record<string, unknown> & { id: string; role: string }; parts: Part[] };
type UsageEntry = { usage: ContextUsage; updatedAt: number; hasUsageTokens: boolean };
type RequestTools = Record<string, { description: string; input: unknown }>;

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;

beforeEach(() => {
    __ignoredNotificationTest.setHoldDetector(() => false);
});

afterEach(() => {
    __ignoredNotificationTest.reset();
    __resetMessageIndexAsyncForTests();
    __resetToolDefinitionMeasurements();
    transformDecisionTest.reset();
    resetLkgSlotsForTest();
    closeDatabase();
    clearModelsDevCache();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
    const parent = join(tmpdir(), "magic-context", "fable-5-2-tool-binding");
    mkdirSync(parent, { recursive: true });
    const dir = createTestTempDirFromPath(join(parent, prefix));
    tempDirs.push(dir);
    return dir;
}

function user(sessionId: string, id: string, text: string): Message {
    return { info: { id, role: "user", sessionID: sessionId }, parts: [{ type: "text", text }] };
}

/** An assistant step; `reasoningTokens` above the hold threshold makes it heavy. */
function assistant(
    sessionId: string,
    id: string,
    parts: Part[],
    reasoningTokens = 0,
): Message {
    return {
        info: {
            id,
            role: "assistant",
            sessionID: sessionId,
            ...MODEL,
            tokens: { input: 0, output: 50, reasoning: reasoningTokens },
        },
        parts,
    };
}

function signed(text: string): Part {
    return { type: "reasoning", text, metadata: { anthropic: { signature: `sig-${text}` } } };
}

function setup(
    name: string,
    signals: {
        getToolSetHash?: (sessionId: string) => string;
        getToolDefinitionsHash?: (sessionId: string) => string | undefined;
    },
    subagent = false,
) {
    process.env.XDG_DATA_HOME = tempDir(`${name}-data-`);
    process.env.XDG_CACHE_HOME = process.env.XDG_DATA_HOME;
    const db = openDatabase();
    if (!db) throw new Error("isolated database unavailable");
    const sessionId = `fable-5-2-tools-${name}`;
    getOrCreateSessionMeta(db, sessionId);
    updateSessionMeta(db, sessionId, {
        systemPromptHash: "system-v1",
        ...(subagent ? { isSubagent: true } : {}),
    });
    const usage = new Map<string, UsageEntry>([
        [
            sessionId,
            {
                usage: { percentage: 10, inputTokens: 20_000 },
                updatedAt: Date.now(),
                hasUsageTokens: true,
            },
        ],
    ]);
    const transform = createTransform({
        db,
        directory: tempDir(`${name}-project-`),
        tagger: createTagger(),
        scheduler: createScheduler({ executeThresholdPercentage: 65 }),
        liveModelBySession: new Map([[sessionId, { ...MODEL }]]),
        contextUsageMap: usage,
        protectedTokens: 0,
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        ...signals,
    });
    const pass = async (messages: Message[]) => {
        const served = structuredClone(messages);
        await transform({}, { messages: served } as never);
        return JSON.stringify(served);
    };
    return { db, sessionId, pass };
}

/** OpenCode 1's tool signal: the route-wide names-only hash its tool.definition hook feeds. */
function openCode1Signals() {
    return {
        getToolSetHash: (sessionId: string) =>
            getCurrentToolSetHash(MODEL.providerID, MODEL.modelID, AGENT, sessionId),
    };
}

/** OpenCode 2's tool signals: the request's own name-and-description identity. */
function openCode2Signals(tools: RequestTools) {
    return { getToolDefinitionsHash: () => v2ToolDefinitionsHash(tools) };
}

/**
 * A completed turn whose signed thinking stays on the wire, two later requests
 * with the same tools, then `change` and one more request. The tool change is
 * the only edit before the kept block on that last request.
 */
async function completedTurnAcrossChange(
    f: ReturnType<typeof setup>,
    change: () => void,
): Promise<{ kept: string; unchanged: string; changed: string }> {
    const raw: Message[] = [user(f.sessionId, "p1", "first task")];
    // Cache m[0]/m[1] before any signed thinking exists.
    await f.pass(raw);
    raw.push(
        assistant(f.sessionId, "a1", [signed(THINKING), { type: "text", text: "first done" }]),
        user(f.sessionId, "p2", "second task"),
    );
    const kept = await f.pass(raw);
    raw.push(
        assistant(f.sessionId, "a2", [{ type: "text", text: "second done" }]),
        user(f.sessionId, "p3", "third task"),
    );
    const unchanged = await f.pass(raw);
    change();
    raw.push(
        assistant(f.sessionId, "a3", [{ type: "text", text: "third done" }]),
        user(f.sessionId, "p4", "a task after the tool list changed"),
    );
    const changed = await f.pass(raw);
    return { kept, unchanged, changed };
}

test("OpenCode 1, claude-fable-5-2: a system prompt change strips the kept signed thinking", async () => {
    // Control for the fixture below: a change the transform already treats as
    // a prefix rebuild removes the kept block.
    recordToolDefinition(MODEL.providerID, MODEL.modelID, AGENT, "read", "Read a file", {
        type: "object",
    });
    const f = setup("oc1-system", openCode1Signals());
    try {
        const served = await completedTurnAcrossChange(f, () =>
            updateSessionMeta(f.db, f.sessionId, { systemPromptHash: "system-v2" }),
        );
        expect(served.kept).toContain(THINKING);
        expect(served.unchanged).toContain(THINKING);
        expect(served.changed).not.toContain(THINKING);
    } finally {
        closeQuietly(f.db);
    }
});

// Known gap: OpenCode 1 has no per-request tool signal. Its names-only hash is
// route-wide and only attributes a bust; it never triggers one, and MCP tools
// never reach the tool.definition hook at all. Remove `.failing` when a tool
// change strips the kept thinking.
test.failing("OpenCode 1, claude-fable-5-2: a tool added mid-session strips the kept signed thinking", async () => {
    recordToolDefinition(MODEL.providerID, MODEL.modelID, AGENT, "read", "Read a file", {
        type: "object",
    });
    const f = setup("oc1-tool", openCode1Signals());
    try {
        const served = await completedTurnAcrossChange(f, () =>
            recordToolDefinition(
                MODEL.providerID,
                MODEL.modelID,
                AGENT,
                "search",
                "Search the workspace",
                { type: "object", properties: { query: { type: "string" } } },
                f.sessionId,
            ),
        );
        expect(served.kept).toContain(THINKING);
        expect(served.unchanged).toContain(THINKING);
        expect(served.changed).not.toContain(THINKING);
    } finally {
        closeQuietly(f.db);
    }
});

test("OpenCode 2 signals, claude-fable-5-2: a tool added mid-session strips the kept signed thinking", async () => {
    // Control for the subagent and held cases below: the same harness with
    // OpenCode 2's tool identity strips on a primary session's unheld pass.
    const tools: RequestTools = { read: { description: "Read a file", input: { type: "object" } } };
    const f = setup("oc2-primary", openCode2Signals(tools));
    try {
        const served = await completedTurnAcrossChange(f, () => {
            tools.search = { description: "Search the workspace", input: { type: "object" } };
        });
        expect(served.kept).toContain(THINKING);
        expect(served.unchanged).toContain(THINKING);
        expect(served.changed).not.toContain(THINKING);
    } finally {
        closeQuietly(f.db);
    }
});

// Known gap: the tool-definition change is only a fold trigger, and a
// subagent never folds (it renders no m[0]/m[1] history), so its kept thinking
// survives the change. Remove `.failing` when it is stripped.
test.failing("OpenCode 2 signals, claude-fable-5-2 subagent: a tool added mid-session strips the kept signed thinking", async () => {
    const tools: RequestTools = { read: { description: "Read a file", input: { type: "object" } } };
    const f = setup("oc2-subagent", openCode2Signals(tools), true);
    try {
        const served = await completedTurnAcrossChange(f, () => {
            tools.search = { description: "Search the workspace", input: { type: "object" } };
        });
        expect(served.kept).toContain(THINKING);
        expect(served.unchanged).toContain(THINKING);
        expect(served.changed).not.toContain(THINKING);
    } finally {
        closeQuietly(f.db);
    }
});

// Known gap: a pass held for recent heavy signed reasoning freezes m[0]/m[1]
// and never asks whether a fold is due, so a tool change between two steps of
// the held turn leaves that turn's thinking on the wire. Remove `.failing`
// when the held turn's thinking is stripped.
test.failing("OpenCode 2 signals, claude-fable-5-2: a tool added between two held steps strips the turn's signed thinking", async () => {
    const tools: RequestTools = { read: { description: "Read a file", input: { type: "object" } } };
    const f = setup("oc2-held", openCode2Signals(tools));
    const logs = spyOn(loggerModule, "sessionLog").mockImplementation(() => {});
    try {
        const raw: Message[] = [user(f.sessionId, "p1", "the task")];
        await f.pass(raw);
        const step = (n: number): Message =>
            assistant(
                f.sessionId,
                `step-${n}`,
                [
                    signed(`${THINKING} ${n}`),
                    {
                        type: "tool",
                        tool: "read",
                        callID: `call-${n}`,
                        state: { status: "completed", output: `result ${n}` },
                    },
                ],
                1_600,
            );
        raw.push(step(1));
        const first = await f.pass(raw);
        raw.push(step(2));
        const second = await f.pass(raw);
        tools.search = { description: "Search the workspace", input: { type: "object" } };
        raw.push(step(3));
        const changed = await f.pass(raw);
        expect(first).toContain(`${THINKING} 1`);
        expect(second).toContain(`${THINKING} 1`);
        expect(
            logs.mock.calls.some((call) =>
                String(call[1]).startsWith("m[0]/m[1] frozen: recent heavy reasoning"),
            ),
        ).toBe(true);
        expect(changed).not.toContain(`${THINKING} 1`);
        expect(changed).not.toContain(`${THINKING} 2`);
        expect(changed).not.toContain(`${THINKING} 3`);
    } finally {
        logs.mockRestore();
        closeQuietly(f.db);
    }
});
