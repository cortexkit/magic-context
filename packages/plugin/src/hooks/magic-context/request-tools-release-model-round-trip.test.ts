/// <reference types="bun-types" />

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __resetMessageIndexAsyncForTests } from "../../features/magic-context/message-index-async";
import {
    v2RequestToolsFingerprint,
    v2ToolDefinitionsHash,
} from "../../features/magic-context/request-tool-definitions";
import { createScheduler } from "../../features/magic-context/scheduler";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    openDatabase,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import { __resetToolDefinitionMeasurements } from "../../features/magic-context/tool-definition-tokens";
import { __test as transformDecisionTest } from "../../features/magic-context/transform-decision-log";
import type { ContextUsage } from "../../features/magic-context/types";
import { clearModelsDevCache } from "../../shared/models-dev-cache";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { resetLkgSlotsForTest } from "./lkg-slot";
import { __ignoredNotificationTest } from "./send-session-notification";
import { createTransform } from "./transform";

// The request-tools release keeps one fingerprint per session, tagged with the
// model it was served on, and replaces a fingerprint recorded for another model
// without comparing. A session that goes from one prefix-bound model (A) to
// another (B) and back to A therefore compares A's request with B's last list,
// finds a different model, and adopts. When the tools changed while the session
// was away from A, A's own signed thinking from before the switch is still
// bound to A's old tool list, and nothing on the return pass releases it.
//
// On a primary session with compaction on, the model switch folds the history
// head and that fold strips every signed block, so the control below passes.
// Compaction-off sessions and subagents never fold on a model switch.

const MODEL_A = { providerID: "anthropic", modelID: "claude-fable-5-2" } as const;
const MODEL_B = { providerID: "anthropic", modelID: "claude-mythos-5-2" } as const;
const THINKING = "SIGNED_ON_MODEL_A_AGAINST_THE_FIRST_TOOL_LIST";

type Part = Record<string, unknown>;
type Message = { info: Record<string, unknown> & { id: string; role: string }; parts: Part[] };
type UsageEntry = { usage: ContextUsage; updatedAt: number; hasUsageTokens: boolean };
type RequestTools = Record<string, { description: string; input: unknown }>;
type Model = { providerID: string; modelID: string };

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
    const parent = join(tmpdir(), "magic-context", "request-tools-model-round-trip");
    mkdirSync(parent, { recursive: true });
    const dir = createTestTempDirFromPath(join(parent, prefix));
    tempDirs.push(dir);
    return dir;
}

function user(sessionId: string, id: string, text: string): Message {
    return { info: { id, role: "user", sessionID: sessionId }, parts: [{ type: "text", text }] };
}

function assistant(sessionId: string, id: string, model: Model, parts: Part[]): Message {
    return {
        info: {
            id,
            role: "assistant",
            sessionID: sessionId,
            ...model,
            tokens: { input: 0, output: 50, reasoning: 0 },
        },
        parts,
    };
}

function signed(text: string): Part {
    return { type: "reasoning", text, metadata: { anthropic: { signature: `sig-${text}` } } };
}

/**
 * The shared transform with OpenCode 2's tool signals, read from `tools` on
 * every pass as the adapter reads the draft, and a live model the test switches.
 */
function setup(name: string, tools: RequestTools, mode: "primary" | "subagent" | "compaction-off") {
    process.env.XDG_DATA_HOME = tempDir(`${name}-data-`);
    process.env.XDG_CACHE_HOME = process.env.XDG_DATA_HOME;
    const db = openDatabase();
    if (!db) throw new Error("isolated database unavailable");
    const sessionId = `request-tools-round-trip-${name}`;
    getOrCreateSessionMeta(db, sessionId);
    updateSessionMeta(db, sessionId, {
        systemPromptHash: "system-v1",
        ...(mode === "subagent" ? { isSubagent: true } : {}),
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
    const liveModels = new Map<string, Model>([[sessionId, { ...MODEL_A }]]);
    const transform = createTransform({
        db,
        directory: tempDir(`${name}-project-`),
        tagger: createTagger(),
        scheduler: createScheduler({ executeThresholdPercentage: 65 }),
        liveModelBySession: liveModels,
        contextUsageMap: usage,
        protectedTokens: 0,
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        compactionOff: mode === "compaction-off",
        getToolDefinitionsHash: () => v2ToolDefinitionsHash(tools),
        getRequestToolsFingerprint: () => v2RequestToolsFingerprint(tools),
    });
    const pass = async (model: Model, messages: Message[]) => {
        liveModels.set(sessionId, { ...model });
        const served = structuredClone(messages);
        await transform({}, { messages: served } as never);
        return JSON.stringify(served);
    };
    return { db, sessionId, pass };
}

/**
 * A completed turn on model A keeps its signed thinking on the wire; the
 * session then runs one turn on model B with the same tools, and the next
 * prompt goes back to model A after a tool was added. The added tool is the
 * only edit before A's kept block on that last request.
 */
async function roundTrip(mode: "primary" | "subagent" | "compaction-off") {
    const tools: RequestTools = { read: { description: "Read a file", input: { type: "object" } } };
    const f = setup(mode, tools, mode);
    try {
        const raw: Message[] = [user(f.sessionId, "p1", "first task")];
        await f.pass(MODEL_A, raw);
        raw.push(
            assistant(f.sessionId, "a1", MODEL_A, [
                signed(THINKING),
                { type: "text", text: "first done" },
            ]),
            user(f.sessionId, "p2", "second task"),
        );
        const keptOnA = await f.pass(MODEL_A, raw);
        raw.push(
            assistant(f.sessionId, "a2", MODEL_A, [{ type: "text", text: "second done" }]),
            user(f.sessionId, "p3", "a task for model B"),
        );
        await f.pass(MODEL_B, raw);
        tools.search = { description: "Search the workspace", input: { type: "object" } };
        raw.push(
            assistant(f.sessionId, "b1", MODEL_B, [{ type: "text", text: "model B done" }]),
            user(f.sessionId, "p4", "back on model A after a tool was added"),
        );
        const backOnA = await f.pass(MODEL_A, raw);
        return { keptOnA, backOnA };
    } finally {
        closeQuietly(f.db);
    }
}

test("control: primary session, Fable 5.2 -> Mythos 5.2 -> Fable 5.2 with a tool added: the return request carries no thinking bound to the old tools", async () => {
    const served = await roundTrip("primary");
    expect(served.keptOnA).toContain(THINKING);
    expect(served.backOnA).not.toContain(THINKING);
});

// Known gap, kept failing on purpose until the release compares against the
// list last served on the same model (one record per model key).
test.failing("compaction-off, Fable 5.2 -> Mythos 5.2 -> Fable 5.2 with a tool added: the return request carries no thinking bound to the old tools", async () => {
    const served = await roundTrip("compaction-off");
    expect(served.keptOnA).toContain(THINKING);
    expect(served.backOnA).not.toContain(THINKING);
});

test.failing("subagent, Fable 5.2 -> Mythos 5.2 -> Fable 5.2 with a tool added: the return request carries no thinking bound to the old tools", async () => {
    const served = await roundTrip("subagent");
    expect(served.keptOnA).toContain(THINKING);
    expect(served.backOnA).not.toContain(THINKING);
});
