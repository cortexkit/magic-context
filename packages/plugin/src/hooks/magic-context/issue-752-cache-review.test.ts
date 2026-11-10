/// <reference types="bun-types" />

/**
 * The first transform pass after a host restart, on a session whose last
 * request the provider rejected as too large (GitHub issue 752 follow-up).
 * The case asserts the behavior the pass should
 * have: overflow recovery sizes its emergency reclaim from the request that
 * overflowed, not from the provider's earlier, smaller accepted reading. It
 * fails if the restart pass prefers that saved reading.
 *
 * The case drives a real createTransform and a real event handler over one
 * context.db, and simulates a host restart by building a new pair with empty
 * in-memory state over the same database.
 */

import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScheduler } from "../../features/magic-context/scheduler";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import * as logger from "../../shared/logger";
import { clearModelsDevCache, refreshModelLimitsFromApi } from "../../shared/models-dev-cache";
import { openTestDatabase } from "../../shared/test-db";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { providerMass, resolveDecisionCalibration } from "./decision-calibration";
import { createEventHandler } from "./event-handler";
import { resolveContextWindowGeometry } from "./event-resolvers";
import { estimateFinalWireInputTokens } from "./final-wire-token-estimate";
import { createTransform } from "./transform";

// A model in the tokenizer calibration table with ratios close to 1. A seeded
// model is the case where the code before the fix sized this pass from the
// calibrated count of the request; an unseeded one was sized from the doubled
// fit envelope, which made the emergency planner skip.
const MODEL = { providerID: "google", modelID: "gemini-3.8-flash" };
const SYSTEM_TOKENS = 1_200;

type Msg = { info: Record<string, unknown>; parts: Record<string, unknown>[] };

const tempDirs: string[] = [];
const originalXdg = process.env.XDG_DATA_HOME;

beforeEach(async () => {
    const dir = createTestTempDirFromPath(join(tmpdir(), "issue-752-review-"));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    await refreshModelLimitsFromApi({
        config: {
            providers: async () => ({
                data: {
                    providers: [
                        {
                            id: MODEL.providerID,
                            models: {
                                [MODEL.modelID]: { limit: { context: 24_000, output: 2_000 } },
                            },
                        },
                    ],
                },
            }),
        },
    });
});

afterEach(async () => {
    clearModelsDevCache();
    await closeDatabase();
    if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdg;
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
});

function prose(chars: number, seed: number): string {
    const words = ["boundary", "session", "window", "pressure", "replay", "baseline", "ordinal"];
    const out: string[] = [];
    let length = 0;
    for (let i = seed; length < chars; i++) {
        const word = words[(i * 3 + seed) % words.length]!;
        out.push(word);
        length += word.length + 1;
    }
    return out.join(" ");
}

async function harness(sessionId: string) {
    const db = await openTestDatabase();
    getOrCreateSessionMeta(db, sessionId);
    updateSessionMeta(db, sessionId, { systemPromptTokens: SYSTEM_TOKENS, cacheTtl: "1h" });
    const history: Msg[] = [];
    let ordinal = 0;
    const id = () => `m-${String(ordinal++).padStart(5, "0")}`;
    const user = (text: string) =>
        history.push({
            info: { id: id(), role: "user", sessionID: sessionId, model: { ...MODEL } },
            parts: [{ type: "text", text }],
        });
    const tool = (chars: number) => {
        const messageId = id();
        history.push({
            info: { id: messageId, role: "assistant", sessionID: sessionId, ...MODEL },
            parts: [
                {
                    type: "tool",
                    callID: `call-${messageId}`,
                    tool: "bash",
                    state: {
                        status: "completed",
                        input: { command: `listing ${messageId}` },
                        output: prose(chars, ordinal),
                    },
                },
            ],
        });
    };
    /** The plugin's own calibrated count of a request (the seeded ratios of this model). */
    const count = (messages: Msg[]) => {
        const estimate = estimateFinalWireInputTokens({
            messages: messages as never,
            systemPromptTokens: SYSTEM_TOKENS,
            providerID: MODEL.providerID,
            modelID: MODEL.modelID,
        });
        return providerMass(
            estimate.rawComponents!,
            resolveDecisionCalibration(MODEL.providerID, MODEL.modelID),
        );
    };
    const usableHard = () =>
        resolveContextWindowGeometry(MODEL.providerID, MODEL.modelID, {
            db,
            sessionID: sessionId,
        })!.usableHard;
    const lines: string[] = [];
    const spy = spyOn(logger, "sessionLog").mockImplementation(
        (sid: string, ...rest: unknown[]) => {
            if (sid === sessionId) lines.push(rest.map(String).join(" "));
        },
    );
    const newProcess = () => {
        const usage = new Map();
        const live = new Map<string, typeof MODEL>();
        const tagger = createTagger();
        const transform = createTransform({
            tagger,
            scheduler: createScheduler({ executeThresholdPercentage: 65 }),
            contextUsageMap: usage,
            db,
            liveModelBySession: live,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTokens: 2_000,
            executeThresholdPercentage: 65,
            cacheTtlConfig: "1h",
            cacheTtlConfigured: true,
            getModelKey: (sid: string) => {
                const model = live.get(sid);
                return model ? `${model.providerID}/${model.modelID}` : undefined;
            },
        } as never);
        const events = createEventHandler({
            contextUsageMap: usage,
            compactionHandler: { onCompacted: () => {} },
            config: { cache_ttl: "1h", cacheTtlConfigured: true, execute_threshold_percentage: 65 },
            tagger,
            db,
        } as never);
        return { transform, events };
    };
    let proc = newProcess();
    let replies = 0;
    return {
        db,
        history,
        user,
        tool,
        count,
        usableHard,
        lines,
        restore: () => spy.mockRestore(),
        restart: () => {
            proc = newProcess();
        },
        /** One transform pass over a fresh copy of the host's history. */
        pass: async () => {
            const messages = structuredClone(history);
            const from = lines.length;
            let error: unknown = null;
            try {
                await proc.transform({}, { messages } as never);
            } catch (caught) {
                error = caught;
            }
            return { messages, error, log: lines.slice(from) };
        },
        /** The provider answers the served request and reports `input` prompt tokens. */
        reply: async (input: number) => {
            const now = Date.now();
            await proc.events({
                event: {
                    type: "message.updated",
                    properties: {
                        info: {
                            id: `r-${String(replies++).padStart(5, "0")}`,
                            role: "assistant",
                            sessionID: sessionId,
                            ...MODEL,
                            finish: "stop",
                            time: { created: now, completed: now },
                            tokens: { input, output: 10, cache: { read: 0, write: 0 } },
                        },
                    },
                },
            });
        },
        /** The provider rejects the request as too large, reporting no limit. */
        /**
         * With no argument the error reports no token count and no limit (the
         * OpenAI shape); with `counted`, it carries both, as Anthropic's does.
         */
        overflow: async (counted?: { tokens: number; maximum: number }) => {
            await proc.events({
                event: {
                    type: "session.error",
                    properties: {
                        sessionID: sessionId,
                        error: counted
                            ? `prompt is too long: ${counted.tokens} tokens > ${counted.maximum} maximum`
                            : "prompt is too long",
                    },
                },
            });
        },
    };
}

async function overflowRestartCase(counted: boolean) {
    const h = await harness(`ses-review-752-overflow-${counted ? "counted" : "bare"}`);
    try {
        // A managed session the provider last measured at about 60%.
        h.user("start the listings");
        while (h.count(h.history) < 0.6 * h.usableHard()) h.tool(2_400);
        h.user("continue");
        const warm = await h.pass();
        expect(warm.error).toBeNull();
        const accepted = h.count(warm.messages);
        await h.reply(accepted);
        // One large tool output takes the request to about 88% by the
        // plugin's count. An overflow event with no token count or limit in
        // its message follows, as when a provider whose tokenizer is denser
        // than the local count rejects the request.
        const target = 0.88 * h.usableHard();
        const before = h.count(h.history);
        // Measure the local count per character of tool output, then size it.
        h.tool(40_000);
        const perChar = (h.count(h.history) - before) / 40_000;
        h.history.pop();
        h.tool(Math.round((target - before) / perChar));
        h.user("summarize the output");
        const rejected = await h.pass();
        expect(rejected.error).toBeNull();
        const rejectedCount = h.count(rejected.messages);
        expect(rejectedCount / h.usableHard()).toBeGreaterThan(0.8);
        expect(rejectedCount / h.usableHard()).toBeLessThan(0.95);
        await h.overflow(
            counted
                ? { tokens: Math.round(rejectedCount * 1.15), maximum: h.usableHard() }
                : undefined,
        );

        // The host restarts inside the cache window and retries the turn.
        h.restart();
        const boot = await h.pass();
        const reading = boot.log
            .map((line) =>
                /unknown provider usage; using (.*?) for priced pass inputTokens=(\d+) percentage=([\d.]+)/.exec(
                    line,
                ),
            )
            .find(Boolean);
        expect(boot.log.some((line) => line.includes("bumping percentage to 95%"))).toBe(true);
        expect(reading).toBeDefined();
        console.log(
            `REVIEW_752_OVERFLOW${counted ? "_COUNTED" : ""}`,
            JSON.stringify({
                accepted,
                rejectedCount,
                reading: reading![0],
                reclaim: boot.log.filter((line) =>
                    /emergency tiered drop|EMERGENCY|pending ops WILL/.test(line),
                ),
            }),
        );
        // The emergency planner reads inputTokens as the size of the request it
        // must shrink. That size should cover the plugin's own count of the
        // request that overflowed (within 5%: the pass counts its array
        // mid-transform). The last accepted reading (about 60%) predates the
        // large tool output and understates it.
        const covers = Number(reading![2]) >= 0.95 * rejectedCount;
        expect(`${reading![1]}: ${covers ? "covers" : "below"} the rejected request`).toBe(
            `${reading![1]}: covers the rejected request`,
        );
    } finally {
        h.restore();
    }
}

it(
    "an overflow-recovery pass after a restart sizes the emergency reclaim from the rejected request, not the last accepted reading",
    () => overflowRestartCase(false),
    60_000,
);

// The counted error (Anthropic's shape) records the rejected size and a
// detected limit, so the saved reading never qualified here; this case holds
// that path to the same outcome.
it(
    "an overflow-recovery pass after a restart, when the overflow error carries its token count, sizes from the rejected request",
    () => overflowRestartCase(true),
    60_000,
);
