/// <reference types="bun-types" />
// The execute decision of a session whose provider never reports usage.
//
// Such a session has no provider reading, so the scheduler reads the local
// count of the last request the transform served (local-wire-reading.ts).
// When that count says "execute", the pass is also treated as a priced pass,
// and a priced pass with no provider reading is sized from a local count of
// its own request (transform.ts, the wire-estimate fallback). That sized
// reading is what the postprocess phase compares with the force band:
// - between the force band and 95%, the rebuild permission the force band
//   grants (its "force ride" in ARCHITECTURE.md) waits for a provider
//   measurement, because the reading is only a local count; a usage-less
//   provider never sends one;
// - so the execute pass's own bounded rebuild (invariant 3 in ARCHITECTURE.md)
//   stays available there. Were it cut off at the force band, as it is for a
//   provider-measured reading, a queued ctx_reduce drop would wait until the
//   local count reached 95%.
// The control case shows the same drop landing just below the force band.
//
// The model here is described by the catalog, as a usage-less provider with a
// configured `limit.context` is. Without catalog metadata the transform has no
// window geometry, the sized reading stays at 0%, and the band never appears.
import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createScheduler } from "../../features/magic-context/scheduler";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    getPendingOps,
    getTagsBySession,
    openDatabase,
    queuePendingOp,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import { createMessagesTransformHandler } from "../../plugin/messages-transform";
import * as loggerModule from "../../shared/logger";
import {
    clearModelsDevCache,
    getSdkWindowGeometry,
    refreshModelLimitsFromApi,
} from "../../shared/models-dev-cache";
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import { resetLkgSlotsForTest } from "./lkg-slot";
import { createTransform } from "./transform";

const MODEL = { providerID: "usageless-review", modelID: "usageless-model" };
const CONTEXT = 80_000;
const OUTPUT = 8_000;
// A model whose output reserve makes the two usable windows differ: the
// provider reading's limit reserves min(64K, 25% of 200K) = 50K for output
// (150K usable), while the hard request wall reserves only the 32K OpenCode
// output cap (168K).
const RESERVED_MODEL = { providerID: "usageless-review", modelID: "usageless-reserved" };
const RESERVED_CONTEXT = 200_000;
const RESERVED_OUTPUT = 64_000;
const RESERVED_USABLE_SOFT = 150_000;
const RESERVED_USABLE_HARD = 168_000;
const EXECUTE_THRESHOLD = 65;
// escalationBands(65): max(85, 65 + 2).
const FORCE_BAND = 85;

type Part = Record<string, unknown>;
type Message = { info: Record<string, unknown>; parts: Part[] };

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

beforeEach(async () => {
    // The catalog entry gives the transform a window geometry for the model.
    await refreshModelLimitsFromApi({
        config: {
            providers: async () => ({
                data: {
                    providers: [
                        {
                            id: MODEL.providerID,
                            models: {
                                [MODEL.modelID]: { limit: { context: CONTEXT, output: OUTPUT } },
                                [RESERVED_MODEL.modelID]: {
                                    limit: { context: RESERVED_CONTEXT, output: RESERVED_OUTPUT },
                                },
                            },
                        },
                    ],
                },
            }),
        },
    });
});

afterEach(() => {
    resetLkgSlotsForTest();
    clearModelsDevCache();
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) cleanupTestTempDir(dir);
    tempDirs.length = 0;
});

/**
 * One OpenCode 1 primary session on a provider that never reports usage: the
 * usage map stays empty and only the response clock advances, as the event
 * handler does for a reply without token counts. No historian can run, so no
 * summary can come and an execute pass may rebuild for queued drops.
 */
function usagelessSession(sessionId: string, model: typeof MODEL = MODEL) {
    const dataHome = createTestTempDir("mc-usageless-review-data-").dir;
    const directory = createTestTempDir("mc-usageless-review-session-").dir;
    tempDirs.push(dataHome, directory);
    process.env.XDG_DATA_HOME = dataHome;
    writeFileSync(join(directory, "ARCHITECTURE.md"), "# Architecture\n\nv1\n");
    const db = openDatabase();
    getOrCreateSessionMeta(db, sessionId);
    updateSessionMeta(db, sessionId, { cacheTtl: "5m", lastResponseTime: Date.now() });
    const transform = createTransform({
        db,
        tagger: createTagger(),
        scheduler: createScheduler({ executeThresholdPercentage: EXECUTE_THRESHOLD }),
        executeThresholdPercentage: EXECUTE_THRESHOLD,
        contextUsageMap: new Map(),
        historyRefreshSessions: new Set<string>(),
        pendingMaterializationSessions: new Set<string>(),
        lastHeuristicsTurnId: new Map(),
        liveModelBySession: new Map([[sessionId, model]]),
        protectedTokens: 2000,
        protectedTools: { bash: 0 },
        historianRunnable: false,
        directory,
        sessionDirectoryBySession: new Map([[sessionId, directory]]),
    } as never);
    const handler = createMessagesTransformHandler({
        magicContext: {
            "experimental.chat.messages.transform": (input: unknown, output: unknown) =>
                transform(input as never, output as never),
        },
    } as never) as unknown as (input: unknown, output: unknown) => Promise<unknown>;

    const source: Message[] = [];
    let clock = 1;
    let step = 0;
    const user = (text: string) =>
        source.push({
            info: {
                id: `u${clock}`,
                role: "user",
                sessionID: sessionId,
                time: { created: clock++ },
            },
            parts: [{ type: "text", text }],
        });
    user("long task");

    return {
        /**
         * Appends tool steps and a new user prompt. Every output is distinct,
         * so routine duplicate cleanup has nothing to remove.
         */
        grow(steps: number) {
            for (let i = 0; i < steps; i++) {
                const n = ++step;
                source.push({
                    info: {
                        id: `step-${n}`,
                        role: "assistant",
                        sessionID: sessionId,
                        time: { created: clock++ },
                        finish: "tool-calls",
                        ...model,
                        tokens: { input: 0, output: 300, reasoning: 0 },
                    },
                    parts: [
                        {
                            type: "tool",
                            callID: `call-${n}`,
                            tool: "bash",
                            state: {
                                status: "completed",
                                input: { command: `listing ${n}` },
                                output: Array.from(
                                    { length: 160 },
                                    (_, line) =>
                                        `ROW ${n}.${line} value = compute(input_${n}, row_${line});`,
                                ).join("\n"),
                            },
                        },
                    ],
                });
            }
            user(`next task ${step}`);
        },
        dropOldestTool(): number {
            const tool = getTagsBySession(db, sessionId)
                .filter((tag) => tag.type === "tool" && tag.status === "active")
                .sort((a, b) => a.tagNumber - b.tagNumber)[0];
            if (!tool) throw new Error("no active tool tag to drop");
            queuePendingOp(db, sessionId, tool.tagNumber, "drop");
            return tool.tagNumber;
        },
        status(tagNumber: number) {
            return getTagsBySession(db, sessionId).find((tag) => tag.tagNumber === tagNumber)
                ?.status;
        },
        /** The tags of every tool output dropped so far, queued or not. */
        droppedTools() {
            return getTagsBySession(db, sessionId)
                .filter((tag) => tag.type === "tool" && tag.status === "dropped")
                .map((tag) => tag.tagNumber);
        },
        pendingOps() {
            return getPendingOps(db, sessionId).length;
        },
        /** Serves one request and records the usage-less reply. */
        async pass() {
            const logs: string[] = [];
            const spy = spyOn(loggerModule, "sessionLog").mockImplementation(
                (id: string, ...rest: unknown[]) => {
                    if (id === sessionId) logs.push(rest.map(String).join(" "));
                },
            );
            try {
                const messages = structuredClone(source);
                await handler({}, { messages });
                updateSessionMeta(db, sessionId, { lastResponseTime: Date.now() });
                const localLine = logs.find((line) => line.includes("reads the local count"));
                const local =
                    /reads the local count of the last served request percentage=([\d.]+) inputTokens=([\d.]+)/.exec(
                        localLine ?? "",
                    );
                const sized = /using wire estimate for priced pass .*percentage=([\d.]+)/
                    .exec(logs.find((line) => line.includes("using wire estimate")) ?? "")
                    ?.at(1);
                return {
                    decision: /decision=(\w+)/.exec(
                        logs.find((line) => line.startsWith("transform scheduler:")) ?? "",
                    )?.[1],
                    localPercentage: local ? Number(local[1]) : undefined,
                    localInputTokens: local ? Number(local[2]) : undefined,
                    sizedPercentage: sized === undefined ? undefined : Number(sized),
                    held: logs.some((line) => line.startsWith("pending ops held")),
                    applied: logs.some((line) => line.startsWith("pending ops WILL APPLY")),
                };
            } finally {
                spy.mockRestore();
            }
        },
    };
}

/**
 * Serves a first request below the execute threshold (a first render, which
 * records the local count), grows the session to `totalSteps` tool steps and
 * serves it once so the local count describes the grown request, queues a
 * drop on the oldest tool output, then serves three more requests, each of
 * which the scheduler decides from the local count.
 */
async function queuedDropAfterExecutePasses(sessionId: string, totalSteps: number) {
    const s = usagelessSession(sessionId);
    s.grow(12);
    await s.pass();
    s.grow(totalSteps - 12);
    await s.pass();
    const tag = s.dropOldestTool();
    const first = await s.pass();
    // Read before the later passes, which may drop more as the session grows.
    const droppedOnFirst = s.droppedTools();
    const passes = [first, await s.pass(), await s.pass()];
    return { passes, tag, droppedOnFirst, pendingOps: s.pendingOps(), status: s.status(tag) };
}

it("a usage-less session whose local count is between the force band and 95% lands a queued drop on its execute passes", async () => {
    // 24 tool steps serve about 91% of the usable window by the local count.
    const result = await queuedDropAfterExecutePasses("usageless-force-band", 24);
    // Preconditions: the first pass after the drop is queued is an execute
    // pass decided from the local count, sized inside the force band but
    // below 95%.
    const first = result.passes[0]!;
    expect(first.decision).toBe("execute");
    expect(first.localPercentage).toBeGreaterThanOrEqual(EXECUTE_THRESHOLD);
    expect(first.sizedPercentage).toBeGreaterThanOrEqual(FORCE_BAND);
    expect(first.sizedPercentage).toBeLessThan(95);
    // The drop is worth more than 2% of the window and no summary can come,
    // so the first execute pass lands it, as it does below the band.
    expect(first.applied).toBe(true);
    expect({
        heldOnEveryPass: result.passes.every((pass) => pass.held),
        pendingOps: result.pendingOps,
        status: result.status,
    }).toEqual({ heldOnEveryPass: false, pendingOps: 0, status: "dropped" });
    // A local count below 95% runs no tiered emergency tool drop: that
    // rebuild drops the queued tool output and nothing else.
    expect(result.droppedOnFirst).toEqual([result.tag]);
});

it("at 95% by a local count the first execute pass also runs the tiered emergency tool drop", async () => {
    // 26 tool steps serve about 99% of the usable window by the local count.
    const result = await queuedDropAfterExecutePasses("usageless-emergency", 26);
    const first = result.passes[0]!;
    expect(first.decision).toBe("execute");
    expect(first.sizedPercentage).toBeGreaterThanOrEqual(95);
    expect(first.applied).toBe(true);
    expect(result.status).toBe("dropped");
    // At 95% or more a local count is force-band pressure, so the emergency
    // tool drop removes unqueued tool outputs on the same rebuild.
    expect(result.droppedOnFirst).toContain(result.tag);
    expect(result.droppedOnFirst.length).toBeGreaterThan(1);
});

it("control: just below the force band the same queued drop lands on the first execute pass", async () => {
    // 22 tool steps serve about 83% of the usable window by the local count.
    const result = await queuedDropAfterExecutePasses("usageless-below-band", 22);
    const first = result.passes[0]!;
    expect(first.decision).toBe("execute");
    expect(first.localPercentage).toBeGreaterThanOrEqual(EXECUTE_THRESHOLD);
    expect(first.sizedPercentage).toBeLessThan(FORCE_BAND);
    expect(first.applied).toBe(true);
    expect({ pendingOps: result.pendingOps, status: result.status }).toEqual({
        pendingOps: 0,
        status: "dropped",
    });
});

it("a usage-less session's local reading is a percentage of the limit a provider reading uses", async () => {
    // Precondition: the two usable windows of this model differ.
    expect(getSdkWindowGeometry(RESERVED_MODEL.providerID, RESERVED_MODEL.modelID)).toMatchObject({
        usableSoft: RESERVED_USABLE_SOFT,
        usableHard: RESERVED_USABLE_HARD,
    });
    const s = usagelessSession("usageless-reserved-window", RESERVED_MODEL);
    s.grow(12);
    await s.pass();
    // The second pass reads the local count of the request the first served.
    const second = await s.pass();
    const tokens = second.localInputTokens;
    expect(tokens).toBeGreaterThan(0);
    // A provider reading is a percentage of the output-reserved limit, so the
    // local reading is too: the same request then reaches the execute
    // threshold whether or not the provider reports usage. Over the larger
    // hard window it would read lower and execute later.
    expect(second.localPercentage).toBe(
        Number((((tokens ?? 0) / RESERVED_USABLE_SOFT) * 100).toFixed(1)),
    );
    expect(second.localPercentage).not.toBe(
        Number((((tokens ?? 0) / RESERVED_USABLE_HARD) * 100).toFixed(1)),
    );
});
