/// <reference types="bun-types" />
// An idle expiry only means the provider forgot its prompt cache. The request's
// bytes before the conversation are unchanged, so resending them costs the same
// re-read as a rebuild and keeps every signed thinking block valid. These cases
// run the production OpenCode 1 and OpenCode 2 transform and check that such a
// pass replays the request byte for byte: queued drops stay queued, signed
// thinking stays, and nothing folds. A pass whose surface really changes (a new
// system prompt) still folds and drains, and a subagent's queued drops wait for
// its next execute pass.
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
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import { resetLkgSlotsForTest } from "./lkg-slot";
import { requestPendingMaterialization } from "./pending-materialization";
import { bindSystemDateRequestIdentity, registerSystemDateRefresh } from "./system-date-refresh";
import { createSystemPromptHashHandler } from "./system-prompt-hash";
import { createTransform } from "./transform";

const PREFIX_BOUND = { providerID: "anthropic", modelID: "claude-opus-5-5" };
const PLAIN = { providerID: "openai", modelID: "gpt-4.1" };
type Model = typeof PREFIX_BOUND;
type Part = Record<string, unknown>;
type Message = { info: Record<string, unknown>; parts: Part[] };
// About 2,000 tokens per tool output, so the oldest outputs fall outside the
// derived protected-token floor (8,000 tokens here).
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

const signatures = (messages: Message[]) =>
    messages.flatMap((message) =>
        message.parts
            .filter((part) => part.type === "reasoning" && part.metadata !== undefined)
            .map((part) =>
                String(
                    (part.metadata as { anthropic?: { signature?: unknown } }).anthropic?.signature,
                ),
            ),
    );

interface SessionOptions {
    model?: Model;
    subagent?: boolean;
}

/**
 * One OpenCode session served through the production messages wrapper. `pass()`
 * runs the system-prompt hook too when given a system text, before the messages
 * transform when `systemFirst` is set (OpenCode 2's order) and after it
 * otherwise. Usage starts at 30%, below the 65% execute threshold.
 */
function session(host: (typeof HOSTS)[number], sessionId: string, options: SessionOptions = {}) {
    const MODEL = options.model ?? PLAIN;
    const signed = MODEL === PREFIX_BOUND;
    const dataHome = createTestTempDir("mc-idle-data-").dir;
    const directory = createTestTempDir("mc-idle-session-").dir;
    tempDirs.push(dataHome, directory);
    process.env.XDG_DATA_HOME = dataHome;
    writeFileSync(join(directory, "ARCHITECTURE.md"), "# Architecture\n\nv1\n");
    const db = openDatabase();
    getOrCreateSessionMeta(db, sessionId);
    updateSessionMeta(db, sessionId, {
        cacheTtl: "5m",
        lastResponseTime: Date.now(),
        ...(options.subagent ? { isSubagent: true } : {}),
    });
    const usage = new Map([
        [
            sessionId,
            {
                usage: { percentage: 30, inputTokens: 30_000 },
                updatedAt: Date.now(),
                hasUsageTokens: true,
            },
        ],
    ]);
    const pending = new Set<string>();
    const historyRefreshSessions = new Set<string>();
    const systemPromptRefreshSessions = new Set<string>();
    registerSystemDateRefresh(historyRefreshSessions);
    const transform = createTransform({
        db,
        tagger: createTagger(),
        scheduler: createScheduler({ executeThresholdPercentage: 65 }),
        contextUsageMap: usage,
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
        /** One tool-calling step; on the prefix-bound model it carries signed thinking. */
        step(n: number, reasoning = 200) {
            source.push({
                info: {
                    id: `step-${n}`,
                    role: "assistant",
                    sessionID: sessionId,
                    time: { created: clock++ },
                    finish: "tool-calls",
                    ...MODEL,
                    tokens: { input: 0, output: 300, reasoning: signed ? reasoning : 0 },
                },
                parts: [
                    ...(signed
                        ? [
                              {
                                  type: "reasoning",
                                  text: `step ${n}: run the next command`,
                                  metadata: { anthropic: { signature: `sig-${n}` } },
                              },
                          ]
                        : []),
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
        /**
         * The provider cache lifetime (5m) passed two hours ago, after a response
         * that followed the last history-head render (as in a real session).
         */
        idle() {
            db.prepare(
                "UPDATE session_meta SET cached_m0_materialized_at = ? WHERE session_id = ?",
            ).run(Date.now() - 3 * 60 * 60 * 1000, sessionId);
            updateSessionMeta(db, sessionId, { lastResponseTime: Date.now() - 2 * 60 * 60 * 1000 });
        },
        setUsage(percentage: number) {
            usage.set(sessionId, {
                usage: { percentage, inputTokens: percentage * 1000 },
                updatedAt: Date.now(),
                hasUsageTokens: true,
            });
        },
        flush() {
            requestPendingMaterialization(pending, sessionId, "user_flush");
        },
        /** Queues a drop for the oldest active tool output and returns its tag. */
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
                    bytes: JSON.stringify({ system: prompt?.system, messages }),
                    logs,
                };
            } finally {
                log.mockRestore();
            }
        },
    };
}

/**
 * A finished task of tool steps, then a new user turn, so the oldest output is
 * neither in the latest turn nor in the protected tail.
 */
function seed(s: ReturnType<typeof session>, steps = 8) {
    s.user("long task");
    for (let n = 1; n <= steps; n++) s.step(n);
    s.user("next task");
}

for (const host of HOSTS) {
    it(`${host}: an idle expiry below the execute threshold replays the request byte-identically and keeps queued drops queued`, async () => {
        const s = session(host, `idle-replay-${host}`);
        seed(s);
        await s.pass();
        const warm = await s.pass();
        const tag = s.dropOldestTool();
        // A warm pass with the drop queued replays: the baseline the expiry must match.
        expect((await s.pass()).bytes).toBe(warm.bytes);
        s.idle();
        const expired = await s.pass();
        expect(expired.bytes).toBe(warm.bytes);
        expect(expired.logs.join("\n")).not.toMatch(/rematerialized=true/);
        expect(s.pendingOps()).toBe(1);
        expect(s.status(tag)).toBe("active");
        // The queued drop waits for a real rebuild and lands on it.
        s.flush();
        await s.pass();
        expect(s.status(tag)).toBe("dropped");
        expect(s.pendingOps()).toBe(0);
    });

    for (const held of [false, true])
        it(`${host}: an idle expiry on a prefix-bound Anthropic model keeps the signed thinking (${held ? "held" : "unheld"} pass)`, async () => {
            const s = session(host, `idle-signed-${held}-${host}`, { model: PREFIX_BOUND });
            seed(s, 7);
            await s.pass();
            // Heavy reasoning on the newest step holds the next passes' prefix.
            s.step(8, held ? 2_400 : 200);
            const warm = await s.pass();
            const tag = s.dropOldestTool();
            s.idle();
            const expired = await s.pass();
            expect(signatures(expired.messages)).toContain("sig-8");
            expect(signatures(expired.messages)).toEqual(signatures(warm.messages));
            expect(expired.bytes).toBe(warm.bytes);
            expect(s.pendingOps()).toBe(1);
            expect(s.status(tag)).toBe("active");
        });

    it(`${host}: a system-prompt change after an idle expiry still folds and drains`, async () => {
        const s = session(host, `idle-system-${host}`);
        const v1 = { text: "Base instructions v1", systemFirst: true };
        seed(s);
        await s.pass(v1);
        await s.pass(v1);
        await s.pass(v1);
        const tag = s.dropOldestTool();
        s.idle();
        const changed = await s.pass({ text: "Base instructions v2", systemFirst: true });
        // The prompt change, not the expiry, is what folds this pass.
        expect(changed.logs.join("\n")).toMatch(/rematerialized=true, reason=system_hash/);
        expect(s.status(tag)).toBe("dropped");
        expect(s.pendingOps()).toBe(0);
    });

    it(`${host}: a subagent's queued drops wait through an idle expiry and land at its next execute pass`, async () => {
        const s = session(host, `idle-subagent-${host}`, { subagent: true });
        seed(s);
        await s.pass();
        const warm = await s.pass();
        const tag = s.dropOldestTool();
        s.idle();
        const expired = await s.pass();
        expect(expired.logs.join("\n")).toMatch(/transform scheduler: .*decision=defer/);
        expect(expired.bytes).toBe(warm.bytes);
        expect(s.pendingOps()).toBe(1);
        expect(s.status(tag)).toBe("active");
        s.setUsage(70);
        const execute = await s.pass();
        expect(execute.logs.join("\n")).toMatch(/transform scheduler: .*decision=execute/);
        expect(s.status(tag)).toBe("dropped");
        expect(s.pendingOps()).toBe(0);
    });
}
