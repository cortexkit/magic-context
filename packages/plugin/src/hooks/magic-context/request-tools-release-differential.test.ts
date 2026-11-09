/// <reference types="bun-types" />

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
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
import * as loggerModule from "../../shared/logger";
import { clearModelsDevCache } from "../../shared/models-dev-cache";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { resetLkgSlotsForTest } from "./lkg-slot";
import { __ignoredNotificationTest } from "./send-session-notification";
import { createTransform } from "./transform";

// Differential for the request-tools release on a prefix-bound model: when the
// tools never change, wiring OpenCode 2's tool fingerprint into the transform
// must not change a single served byte on any pass of a long session, and must
// never release. The same scripted session runs twice, on separate databases,
// once without the fingerprint (the behaviour before the release existed) and
// once with it. The script mixes completed turns with signed thinking, held
// tool loops after heavy reasoning, and usage that climbs through the execute
// threshold and the force band, so defer passes, holds and rides all occur.

const MODEL = { providerID: "anthropic", modelID: "claude-fable-5-2" } as const;
const PASSES = 72;

type Part = Record<string, unknown>;
type Message = { info: Record<string, unknown> & { id: string; role: string }; parts: Part[] };
type UsageEntry = { usage: ContextUsage; updatedAt: number; hasUsageTokens: boolean };
type Mode = "primary" | "subagent" | "compaction-off";

const TOOLS: Record<string, { description: string; input: unknown }> = {
    read: {
        description: "Read a file from the workspace",
        input: {
            type: "object",
            properties: { path: { type: "string" }, offset: { type: "number" } },
            required: ["path"],
        },
    },
    edit: {
        description: "Edit a file",
        input: {
            type: "object",
            properties: { path: { type: "string" }, oldString: { type: "string" } },
        },
    },
    ctx_reduce: { description: "Drop tagged items", input: { type: "object" } },
};

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;

function resetProcessState(): void {
    __ignoredNotificationTest.reset();
    __resetMessageIndexAsyncForTests();
    __resetToolDefinitionMeasurements();
    transformDecisionTest.reset();
    resetLkgSlotsForTest();
    closeDatabase();
    clearModelsDevCache();
}

beforeEach(() => {
    __ignoredNotificationTest.setHoldDetector(() => false);
});

afterEach(() => {
    resetProcessState();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
    const parent = join(tmpdir(), "magic-context", "request-tools-release-differential");
    mkdirSync(parent, { recursive: true });
    const dir = createTestTempDirFromPath(join(parent, prefix));
    tempDirs.push(dir);
    return dir;
}

/** The scripted session's raw messages up to pass `index`. */
function script(sessionId: string, index: number): Message[] {
    const messages: Message[] = [];
    let turn = 0;
    for (let step = 0; step <= index; step++) {
        if (step % 6 === 0) {
            turn += 1;
            messages.push({
                info: { id: `p${turn}`, role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: `task ${turn}: ${"detail ".repeat(40)}` }],
            });
            continue;
        }
        // Every third turn's steps reason heavily, so its tool loop is held.
        const heavy = turn % 3 === 0;
        const id = `a${turn}-${step % 6}`;
        messages.push({
            info: {
                id,
                role: "assistant",
                sessionID: sessionId,
                ...MODEL,
                tokens: { input: 0, output: 80, reasoning: heavy ? 1_600 : 200 },
            },
            parts: [
                {
                    type: "reasoning",
                    text: `thinking ${id}`,
                    metadata: { anthropic: { signature: `sig-${id}` } },
                },
                {
                    type: "tool",
                    tool: "read",
                    callID: `call-${id}`,
                    state: {
                        status: "completed",
                        input: { path: `src/${id}.ts` },
                        output: `contents of ${id}\n${"line\n".repeat(60)}`,
                    },
                },
            ],
        });
    }
    return messages;
}

async function run(mode: Mode, withFingerprint: boolean, schemaChangeAt?: number) {
    const name = `${mode}-${withFingerprint ? "with" : "without"}${schemaChangeAt === undefined ? "" : "-changed"}`;
    const tools = structuredClone(TOOLS);
    process.env.XDG_DATA_HOME = tempDir(`${name}-data-`);
    process.env.XDG_CACHE_HOME = process.env.XDG_DATA_HOME;
    const db = openDatabase();
    if (!db) throw new Error("isolated database unavailable");
    const sessionId = `tools-diff-${name}`;
    getOrCreateSessionMeta(db, sessionId);
    updateSessionMeta(db, sessionId, {
        systemPromptHash: "system-v1",
        ...(mode === "subagent" ? { isSubagent: true } : {}),
    });
    const usage = new Map<string, UsageEntry>();
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
        compactionOff: mode === "compaction-off",
        getToolDefinitionsHash: () => v2ToolDefinitionsHash(tools),
        ...(withFingerprint
            ? { getRequestToolsFingerprint: () => v2RequestToolsFingerprint(tools) }
            : {}),
    });
    const logs = spyOn(loggerModule, "sessionLog").mockImplementation(() => {});
    const served: string[] = [];
    try {
        for (let index = 0; index < PASSES; index++) {
            if (index === schemaChangeAt)
                tools.read!.input = { type: "object", properties: { path: { type: "string" } } };
            // Usage climbs from 10% through the execute threshold into the force band.
            const percentage = Math.min(90, 10 + index * 1.2);
            usage.set(sessionId, {
                usage: { percentage, inputTokens: Math.round(percentage * 2_000) },
                updatedAt: Date.now(),
                hasUsageTokens: true,
            });
            const messages = structuredClone(script(sessionId, index));
            await transform({}, { messages } as never);
            served.push(JSON.stringify(messages).replaceAll(sessionId, "SESSION"));
        }
        const lines = logs.mock.calls.map((call) => String(call[1]));
        return {
            served,
            releases: lines.filter((line) => line.startsWith("request tools changed")).length,
            adoptions: lines.filter((line) => line.startsWith("request tools fingerprint adopted"))
                .length,
            holds: lines.filter((line) => line.startsWith("signed thinking hold: held=true"))
                .length,
            rewrites: lines.filter((line) => line.startsWith("rewrite permission: allowed=true"))
                .length,
        };
    } finally {
        logs.mockRestore();
        closeQuietly(db);
        resetProcessState();
    }
}

for (const mode of ["primary", "subagent", "compaction-off"] as const) {
    test(`claude-fable-5-2 ${mode}: unchanged tools serve every pass byte for byte and never release`, async () => {
        const without = await run(mode, false);
        const withFingerprint = await run(mode, true);
        expect(withFingerprint.served).toHaveLength(PASSES);
        for (let index = 0; index < PASSES; index++) {
            expect({ pass: index, bytes: withFingerprint.served[index] }).toEqual({
                pass: index,
                bytes: without.served[index],
            });
        }
        expect(withFingerprint.releases).toBe(0);
        expect(withFingerprint.adoptions).toBe(1);
        expect(without.adoptions).toBe(0);
        // The script reaches held passes and permitted rewrites, not only defers.
        expect(withFingerprint.holds).toBeGreaterThan(0);
        if (mode !== "compaction-off") expect(withFingerprint.rewrites).toBeGreaterThan(0);
    }, 300_000);
}

// Control: the same comparison does see a release. A schema-only change, which
// never folds the history head, makes the run with the fingerprint differ from
// the pass it lands on, and only from there.
test("claude-fable-5-2 primary: a schema-only change is the first pass that differs, and releases once", async () => {
    const changeAt = 40;
    const without = await run("primary", false, changeAt);
    const withFingerprint = await run("primary", true, changeAt);
    for (let index = 0; index < changeAt; index++)
        expect(withFingerprint.served[index]).toBe(without.served[index]!);
    expect(withFingerprint.served[changeAt]).not.toBe(without.served[changeAt]!);
    expect(withFingerprint.releases).toBe(1);
}, 300_000);
