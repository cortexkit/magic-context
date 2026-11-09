/// <reference types="bun-types" />
// Review witnesses for the rule "an expired provider cache grants nothing".
// They drive the production OpenCode 1 messages wrapper and system-prompt hook
// the same way idle-expiry-no-rebuild.test.ts does.
//
// 1. A date rollover that only the idle expiry allows. On a model that is not
//    prefix-bound, the system hook moves the frozen date because the cache
//    expired, and when it runs before the messages transform that move queues a
//    full fold, which lands queued ctx_reduce drops below the execute threshold.
//    With the messages transform first, the same move is adopted without a fold.
// 2. A session whose provider never reports usage. Without a reading the
//    scheduler saw 0% on every pass that did not already rebuild, so it never
//    reached the execute threshold, and the idle expiry was its only automatic
//    rebuild. The execute decision now reads the local count of the last
//    served request instead, and the execute pass is sized from a local count
//    of its own request. Between the force band and 95% that sized reading
//    gets no force ride, so the execute pass's own bounded rebuild lands the
//    drop there.
import { afterEach, expect, it, spyOn } from "bun:test";
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
import { estimateFinalWireInputTokens } from "./final-wire-token-estimate";
import { resetLkgSlotsForTest } from "./lkg-slot";
import { bindSystemDateRequestIdentity, registerSystemDateRefresh } from "./system-date-refresh";
import { createSystemPromptHashHandler } from "./system-prompt-hash";
import { createTransform } from "./transform";

const MODEL = { providerID: "openai", modelID: "gpt-4.1" };
// A model the catalog describes (an 80K window with an 8K output reserve, so
// 72K usable), as a usage-less provider with a configured `limit.context` is.
// Without catalog metadata the transform has no window geometry, and an
// execute pass with no provider reading cannot be sized.
const USAGELESS_MODEL = { providerID: "usageless-idle-review", modelID: "usageless-model" };
const USAGELESS_USABLE = 72_000;

async function registerUsagelessModel() {
    await refreshModelLimitsFromApi({
        config: {
            providers: async () => ({
                data: {
                    providers: [
                        {
                            id: USAGELESS_MODEL.providerID,
                            models: {
                                [USAGELESS_MODEL.modelID]: {
                                    limit: { context: 80_000, output: 8_000 },
                                },
                            },
                        },
                    ],
                },
            }),
        },
    });
}

type Part = Record<string, unknown>;
type Message = { info: Record<string, unknown>; parts: Part[] };
const BULK = "ROW value = compute(input, options); // generated line\n".repeat(160);
const HOSTS = ["opencode1", "opencode2"] as const;

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;
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
 * One OpenCode session on a model that is not prefix-bound. `usage` is the
 * provider's last reading; null models a provider that never reports usage
 * (its completions still advance the idle clock, as event-handler.ts does).
 */
function session(
    host: (typeof HOSTS)[number],
    sessionId: string,
    usage: number | null = 30,
    model: typeof MODEL = MODEL,
) {
    const dataHome = createTestTempDir("mc-idle-review-data-").dir;
    const directory = createTestTempDir("mc-idle-review-session-").dir;
    tempDirs.push(dataHome, directory);
    process.env.XDG_DATA_HOME = dataHome;
    writeFileSync(join(directory, "ARCHITECTURE.md"), "# Architecture\n\nv1\n");
    const db = openDatabase();
    getOrCreateSessionMeta(db, sessionId);
    updateSessionMeta(db, sessionId, { cacheTtl: "5m", lastResponseTime: Date.now() });
    const usageMap = new Map(
        usage === null
            ? []
            : [
                  [
                      sessionId,
                      {
                          usage: { percentage: usage, inputTokens: usage * 1000 },
                          updatedAt: Date.now(),
                          hasUsageTokens: true,
                      },
                  ],
              ],
    );
    const pending = new Set<string>();
    const historyRefreshSessions = new Set<string>();
    const systemPromptRefreshSessions = new Set<string>();
    registerSystemDateRefresh(historyRefreshSessions);
    const transform = createTransform({
        db,
        tagger: createTagger(),
        scheduler: createScheduler({ executeThresholdPercentage: 65 }),
        contextUsageMap: usageMap,
        historyRefreshSessions,
        pendingMaterializationSessions: pending,
        lastHeuristicsTurnId: new Map(),
        liveModelBySession: new Map([[sessionId, model]]),
        protectedTokens: 2000,
        protectedTools: { bash: 0 },
        historianRunnable: false,
        directory,
        sessionDirectoryBySession: new Map([[sessionId, directory]]),
        ...(host === "opencode2"
            ? {
                  storeGeneration: "v2" as const,
                  hostCleanupCompactionMarkers: () => ({
                      verified: true,
                      removedLineages: 0,
                      removedRows: 0,
                      retainedLineages: 0,
                  }),
              }
            : {}),
    } as never);
    const handler = createMessagesTransformHandler({
        magicContext: {
            "experimental.chat.messages.transform": (input: unknown, output: unknown) =>
                transform(input as never, output as never),
        },
    } as never) as unknown as (input: unknown, output: unknown) => Promise<unknown>;
    const systemHandler = createSystemPromptHashHandler({
        db,
        dreamerEnabled: false,
        resolveModel: () => model,
        historyRefreshSessions,
        systemPromptRefreshSessions,
        pendingMaterializationSessions: pending,
        lastHeuristicsTurnId: new Map(),
    } as never).handler as unknown as (input: unknown, output: unknown) => Promise<unknown>;
    const source: Message[] = [];
    let clock = 1;
    return {
        db,
        source,
        user(text: string) {
            source.push({
                info: {
                    id: `u${clock}`,
                    role: "user",
                    sessionID: sessionId,
                    time: { created: clock++ },
                },
                parts: [{ type: "text", text }],
            });
        },
        step(n: number) {
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
                            input: { command: `seq ${n}` },
                            output: `${n}\n${BULK}`,
                        },
                    },
                ],
            });
        },
        /** The 5m provider cache lifetime passed two hours ago. */
        idle() {
            db.prepare(
                "UPDATE session_meta SET cached_m0_materialized_at = ? WHERE session_id = ?",
            ).run(Date.now() - 3 * 60 * 60 * 1000, sessionId);
            updateSessionMeta(db, sessionId, { lastResponseTime: Date.now() - 2 * 60 * 60 * 1000 });
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
        /** Serves one request and records it as answered now. */
        async pass(system?: { text: string; systemFirst?: boolean }) {
            const logs: string[] = [];
            const log = spyOn(loggerModule, "sessionLog").mockImplementation(
                (...args: unknown[]) => {
                    logs.push(args.slice(1).map(String).join(" "));
                },
            );
            try {
                const messages = structuredClone(source);
                const output = { messages };
                const identity = {};
                bindSystemDateRequestIdentity(output, identity);
                const prompt = system ? { system: [system.text] } : undefined;
                const runSystem = async () => {
                    if (prompt)
                        await systemHandler(
                            { sessionID: sessionId, dateRefreshRequest: identity },
                            prompt,
                        );
                };
                if (system?.systemFirst) await runSystem();
                await handler({}, output);
                if (!system?.systemFirst) await runSystem();
                updateSessionMeta(db, sessionId, { lastResponseTime: Date.now() });
                return {
                    messages,
                    system: prompt?.system,
                    bytes: JSON.stringify({ messages }),
                    logs,
                };
            } finally {
                log.mockRestore();
            }
        },
    };
}

function seed(s: ReturnType<typeof session>, steps = 8) {
    s.user("long task");
    for (let n = 1; n <= steps; n++) s.step(n);
    s.user("next task");
}

const dated = (day: string, systemFirst: boolean) => ({
    text: `Base instructions\nToday's date: ${day}`,
    systemFirst,
});

// The usage-less case grows to this many steps, so that the local count of its
// served request is between the force band (85%) and 95% of the 72K usable
// window.
const USAGELESS_BAND_STEPS = 31;

/** The calibrated local count the transform records for the served request. */
function calibratedTokens(s: ReturnType<typeof session>, sessionId: string, messages: unknown) {
    return estimateFinalWireInputTokens({
        messages: messages as never,
        systemPromptTokens: getOrCreateSessionMeta(s.db, sessionId).systemPromptTokens,
        providerID: USAGELESS_MODEL.providerID,
        modelID: USAGELESS_MODEL.modelID,
        sessionId,
    }).pressureTokens;
}

/** The reading a priced pass with no provider reading was sized at, if it was. */
function sizedPercentage(logs: string[]): number | undefined {
    const line = logs.find((entry) => entry.includes("using wire estimate for priced pass"));
    const match = /percentage=([\d.]+)/.exec(line ?? "");
    return match ? Number(match[1]) : undefined;
}

/**
 * A session on the catalog model whose first request (a first render) is below
 * the execute threshold and whose second is grown into the force band, so the
 * band is first reached on an ordinary pass rather than on the first render.
 * Returns the session and the second served request.
 */
async function grownSession(host: (typeof HOSTS)[number], sessionId: string, usage: number | null) {
    const s = session(host, sessionId, usage, USAGELESS_MODEL);
    // After `session` points the data home at its own temporary directory,
    // where the catalog refresh saves its copy.
    await registerUsagelessModel();
    seed(s, 12);
    await s.pass();
    for (let n = 13; n <= USAGELESS_BAND_STEPS; n++) s.step(n);
    s.user("another task");
    const grown = await s.pass();
    return { s, grown };
}

for (const host of HOSTS) {
    for (const systemFirst of [true, false])
        it(`${host}: a date rollover that only the idle expiry allows lands no queued drop (${systemFirst ? "system hook first" : "messages transform first"})`, async () => {
            const s = session(host, `review-date-${systemFirst}-${host}`);
            seed(s);
            await s.pass(dated("Mon Oct 20 2026", systemFirst));
            await s.pass(dated("Mon Oct 20 2026", systemFirst));
            const warm = await s.pass(dated("Mon Oct 20 2026", systemFirst));
            const tag = s.dropOldestTool();
            s.idle();
            // The host's prompt now carries the next day. Nothing else changed:
            // same prompt text, same model, same tools, usage 30%.
            const expired = await s.pass(dated("Tue Oct 21 2026", systemFirst));
            const folded = expired.logs.find((line) => /rematerialized=true/.test(line));
            expect({
                folded: folded ?? null,
                pendingOps: s.pendingOps(),
                status: s.status(tag),
                messagesUnchanged: expired.bytes === warm.bytes,
            }).toEqual({ folded: null, pendingOps: 1, status: "active", messagesUnchanged: true });
        });

    it(`${host}: a session whose provider reports no usage lands a queued drop on its first execute pass, also between the force band and 95%`, async () => {
        const sessionId = `review-usageless-${host}`;
        const { s, grown } = await grownSession(host, sessionId, null);
        // The execute decision reads the calibrated count of the served request
        // (what the provider would likely report), and the provider never says
        // otherwise. The grown request is in the force band by that count.
        expect(calibratedTokens(s, sessionId, grown.messages)).toBeGreaterThanOrEqual(
            0.85 * USAGELESS_USABLE,
        );
        const tag = s.dropOldestTool();
        const passes: Array<{
            sized: number | undefined;
            status: string | undefined;
            droppedTools: number[];
        }> = [];
        for (let pass = 0; pass < 3; pass++) {
            const served = await s.pass();
            passes.push({
                sized: sizedPercentage(served.logs),
                status: s.status(tag),
                droppedTools: getTagsBySession(s.db, sessionId)
                    .filter((row) => row.type === "tool" && row.status === "dropped")
                    .map((row) => row.tagNumber),
            });
        }
        // The first pass after the drop is queued executes from that count and
        // is sized from a local count of its own request, inside the force
        // band. A local count below 95% gets no force ride, so the execute
        // pass's own rebuild lands the drop: on that first pass, with no idle
        // expiry. Without the local count every pass read 0%, and once an
        // expired cache no longer triggered a rebuild the drop waited for
        // /ctx-flush or a provider overflow error.
        expect(passes[0]?.sized).toBeGreaterThanOrEqual(85);
        expect(passes[0]?.sized).toBeLessThan(95);
        expect(passes.map((pass) => pass.status)).toEqual(["dropped", "dropped", "dropped"]);
        expect(s.pendingOps()).toBe(0);
        // Nor does a local count below 95% run the tiered emergency tool drop:
        // that rebuild drops the queued tool output and nothing else.
        expect(passes[0]?.droppedTools).toEqual([tag]);
    });

    it(`${host}: control: a session whose provider reports usage below the threshold keeps its queued drop, whatever the local count`, async () => {
        const sessionId = `review-usage-${host}`;
        // The provider measures this session at 30%.
        const { s, grown } = await grownSession(host, sessionId, 30);
        expect(calibratedTokens(s, sessionId, grown.messages)).toBeGreaterThanOrEqual(
            0.85 * USAGELESS_USABLE,
        );
        const tag = s.dropOldestTool();
        await s.pass();
        await s.pass();
        s.idle();
        await s.pass();
        await s.pass();
        await s.pass();
        // The provider's reading decides the execute threshold; the local count
        // is never read while a provider reading exists.
        expect({ pendingOps: s.pendingOps(), status: s.status(tag) }).toEqual({
            pendingOps: 1,
            status: "active",
        });
    });
}
