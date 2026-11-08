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
// 2. A session whose provider never reports usage. Nothing measures its
//    pressure on a pass that does not already rebuild, so it never reaches the
//    execute threshold, and the idle expiry was its only automatic rebuild.
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
import { recordDetectedContextLimit } from "../../features/magic-context/storage-meta-persisted";
import { createTagger } from "../../features/magic-context/tagger";
import { createMessagesTransformHandler } from "../../plugin/messages-transform";
import * as loggerModule from "../../shared/logger";
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import { resetLkgSlotsForTest } from "./lkg-slot";
import { estimateTokens } from "./read-session-formatting";
import { bindSystemDateRequestIdentity, registerSystemDateRefresh } from "./system-date-refresh";
import { createSystemPromptHashHandler } from "./system-prompt-hash";
import { createTransform } from "./transform";

const MODEL = { providerID: "openai", modelID: "gpt-4.1" };
type Part = Record<string, unknown>;
type Message = { info: Record<string, unknown>; parts: Part[] };
const BULK = "ROW value = compute(input, options); // generated line\n".repeat(160);
const HOSTS = ["opencode1", "opencode2"] as const;

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;
afterEach(() => {
    resetLkgSlotsForTest();
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
function session(host: (typeof HOSTS)[number], sessionId: string, usage: number | null = 30) {
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
        liveModelBySession: new Map([[sessionId, MODEL]]),
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
        resolveModel: () => MODEL,
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

    it(`${host}: a session whose provider reports no usage lands queued drops once its request is over the execute threshold`, async () => {
        const s = session(host, `review-usageless-${host}`, null);
        // An 80K window: the seeded history below is far past 65% of it by a
        // local count, but the provider never says so.
        recordDetectedContextLimit(s.db, `review-usageless-${host}`, 80_000, "openai/gpt-4.1");
        seed(s, 26);
        const first = await s.pass();
        const localTokens = estimateTokens(JSON.stringify(first.messages));
        expect(localTokens).toBeGreaterThan(0.65 * 80_000);
        await s.pass();
        const tag = s.dropOldestTool();
        await s.pass();
        await s.pass();
        s.idle();
        await s.pass();
        await s.pass();
        await s.pass();
        // Every pass above reported 0% to the scheduler, because nothing counts
        // the request of a provider that never reports usage unless the pass
        // already rebuilds. When an expired cache still triggered a rebuild, the
        // idle-expired pass landed this drop; without it no pass ever lands it,
        // and the drop waits for /ctx-flush or a provider overflow error.
        expect({ pendingOps: s.pendingOps(), status: s.status(tag) }).toEqual({
            pendingOps: 0,
            status: "dropped",
        });
    });
}
