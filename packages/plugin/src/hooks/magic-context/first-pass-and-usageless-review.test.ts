/// <reference types="bun-types" />
// Review witnesses for the execute decision of a session whose provider never
// reports usage. Skipped unless MC_REVIEW_USAGELESS=1, because the first case
// records a known defect and fails until it is fixed.
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
// - an execute pass may originate its own rebuild (invariant 3 in
//   ARCHITECTURE.md) only while the reading is below the force band, because
//   above it the force band's permission is expected to take over.
// So in that band neither rule lets the pass rebuild, and a queued ctx_reduce
// drop waits until the local count reaches 95%. Just below the force band the
// same drop lands on the first execute pass, which the control case shows.
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
import { clearModelsDevCache, refreshModelLimitsFromApi } from "../../shared/models-dev-cache";
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import { resetLkgSlotsForTest } from "./lkg-slot";
import { createTransform } from "./transform";

const ENABLED = process.env.MC_REVIEW_USAGELESS === "1";

const MODEL = { providerID: "usageless-review", modelID: "usageless-model" };
const CONTEXT = 80_000;
const OUTPUT = 8_000;
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
function usagelessSession(sessionId: string) {
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
        liveModelBySession: new Map([[sessionId, MODEL]]),
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
                        ...MODEL,
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
                const local = /reads the local count of the last served request percentage=([\d.]+)/
                    .exec(logs.find((line) => line.includes("reads the local count")) ?? "")
                    ?.at(1);
                const sized = /using wire estimate for priced pass .*percentage=([\d.]+)/
                    .exec(logs.find((line) => line.includes("using wire estimate")) ?? "")
                    ?.at(1);
                return {
                    decision: /decision=(\w+)/.exec(
                        logs.find((line) => line.startsWith("transform scheduler:")) ?? "",
                    )?.[1],
                    localPercentage: local === undefined ? undefined : Number(local),
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
    const passes = [await s.pass(), await s.pass(), await s.pass()];
    return { passes, pendingOps: s.pendingOps(), status: s.status(tag) };
}

it.skipIf(!ENABLED)(
    "a usage-less session whose local count is between the force band and 95% lands a queued drop on its execute passes",
    async () => {
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
        // The drop is worth more than 2% of the window and no summary can
        // come, so an execute pass should land it, as it does below the band.
        expect({
            heldOnEveryPass: result.passes.every((pass) => pass.held),
            pendingOps: result.pendingOps,
            status: result.status,
        }).toEqual({ heldOnEveryPass: false, pendingOps: 0, status: "dropped" });
    },
);

it.skipIf(!ENABLED)(
    "control: just below the force band the same queued drop lands on the first execute pass",
    async () => {
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
    },
);
