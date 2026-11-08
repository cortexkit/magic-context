/// <reference types="bun-types" />

/**
 * The first transform pass after a process restart (GitHub issue 752).
 *
 * Magic Context keeps live provider usage in memory. After a restart that map
 * is empty and the first pass resets the persisted usage reading, so a pass
 * that is already allowed to rewrite the prefix has to size the session some
 * other way. These cases compare that boot pass with the same pass in a
 * process that still holds the live reading.
 *
 * The model is absent from the tokenizer calibration table, as any model Magic
 * Context has no measurements for is. The fit checks count such a model at
 * twice its local token count; that envelope must never be read as the
 * session's pressure. The sizing cases request a /ctx-flush with the scheduler
 * deferring, on a session the provider last measured at 60% of its usable
 * window, with a drop queued on the newest tool output. At 60% the protected
 * tail keeps that output, so it must stay active on both the warm pass and the
 * first pass after a restart. Only a reading at 95% or more lifts that
 * protection.
 *
 * The boot pass sizes the session in this order, and each order has a case
 * that fails without it:
 * - the provider's saved reading, when it is for this model and limit, however
 *   long the session sat idle ("prefers the saved provider reading", "an
 *   expired restart prices from the saved provider reading"), unless the
 *   local count is past the 95% emergency line ("a request that grew past the
 *   emergency line");
 * - otherwise a calibrated local count, neutral for an unseeded model ("a
 *   restart without a usable saved reading sizes ... with calibrated counts");
 * - and a reading from that count alone never grants the force ride below 95%
 *   ("an estimate in the force band ... leaves the queued drop queued").
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    closeDatabase,
    getPendingOps,
    getTagsBySession,
    openDatabase,
    queuePendingOp,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import {
    getEmergencyInputSample,
    setEmergencyDropSample,
} from "../../features/magic-context/storage-meta-persisted";
import { createTagger } from "../../features/magic-context/tagger";
import type { ContextUsage } from "../../features/magic-context/types";
import * as logger from "../../shared/logger";
import { clearModelsDevCache, refreshModelLimitsFromApi } from "../../shared/models-dev-cache";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { resolveContextLimit, resolveContextWindowGeometry } from "./event-resolvers";
import { requestPendingMaterialization } from "./pending-materialization";
import { createTransform } from "./transform";

type Model = { providerID: string; modelID: string };
const MODEL: Model = { providerID: "issue-752-provider", modelID: "issue-752-model" };
// A model in the tokenizer calibration table, with ratios close to 1.
const SEEDED_MODEL: Model = { providerID: "google", modelID: "gemini-3.8-flash" };
const TRUE_PERCENTAGE = 60;

type TestMessage = {
    info: { id: string; role: string; sessionID: string };
    parts: Array<
        | { type: "text"; text: string }
        | {
              type: "tool";
              callID: string;
              tool: string;
              state: { status: "completed"; input: Record<string, string>; output: string };
          }
    >;
};

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

function useTempDataHome(prefix: string): void {
    const dir = createTestTempDirFromPath(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

beforeEach(async () => {
    await refreshModelLimitsFromApi({
        config: {
            providers: async () => ({
                data: {
                    providers: [
                        {
                            id: MODEL.providerID,
                            models: {
                                [MODEL.modelID]: { limit: { context: 20_000, output: 2_000 } },
                            },
                        },
                        {
                            id: SEEDED_MODEL.providerID,
                            models: {
                                [SEEDED_MODEL.modelID]: {
                                    limit: { context: 20_000, output: 2_000 },
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
    clearModelsDevCache();
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
});

/** Varied prose so the tokenizer estimate stays near four characters a token. */
function prose(chars: number, seed: number): string {
    const words = ["boundary", "session", "window", "pressure", "replay", "baseline", "ordinal"];
    const out: string[] = [];
    let length = 0;
    for (let i = seed; length < chars; i++) {
        const word = words[i % words.length]!;
        out.push(word);
        length += word.length + 1;
    }
    return out.join(" ");
}

type Shape = { tools: number; chars: number };
const FEW_LARGE: Shape = { tools: 8, chars: 12_000 };
const MANY_SMALL: Shape = { tools: 60, chars: 1_400 };

function sessionMessages(sessionId: string, shape: Shape): TestMessage[] {
    const messages: TestMessage[] = [
        {
            info: { id: "u-0", role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: "run the listings" }],
        },
    ];
    for (let i = 0; i < shape.tools; i++) {
        messages.push({
            info: { id: `a-${i}`, role: "assistant", sessionID: sessionId },
            parts: [
                {
                    type: "tool",
                    callID: `call-${i}`,
                    tool: "bash",
                    state: {
                        status: "completed",
                        input: { command: `listing ${i}` },
                        output: prose(shape.chars, i),
                    },
                },
            ],
        });
    }
    messages.push({
        info: { id: "u-1", role: "user", sessionID: sessionId },
        parts: [{ type: "text", text: "continue" }],
    });
    return messages;
}

function newProcess(args: {
    db: ReturnType<typeof openDatabase>;
    sessionId: string;
    pending: Set<string>;
    model: Model;
    liveUsage?: ContextUsage;
    usageMap?: Map<string, unknown>;
}) {
    return createTransform({
        tagger: createTagger(),
        scheduler: { shouldExecute: mock(() => "defer" as const) },
        contextUsageMap:
            (args.usageMap as never) ??
            new Map(
                args.liveUsage
                    ? [
                          [
                              args.sessionId,
                              {
                                  usage: args.liveUsage,
                                  updatedAt: Date.now(),
                                  hasUsageTokens: true,
                              },
                          ],
                      ]
                    : [],
            ),
        db: args.db,
        liveModelBySession: new Map([[args.sessionId, args.model]]),
        historyRefreshSessions: new Set<string>(),
        pendingMaterializationSessions: args.pending,
        lastHeuristicsTurnId: new Map<string, string>(),
        clearReasoningAge: 50,
        protectedTokens: 0,
    });
}

type PassOptions = {
    shape?: Shape;
    origin?: "user_flush" | "boundary_repair";
    target?: "newest" | "oldest";
    /** How long before the measured pass the provider's last reply landed. */
    lastResponseAgeMs?: number;
    /**
     * The limit the saved reading was taken against, when it differs from the
     * model's current one (a catalog change while the host was down).
     */
    savedReadingLimit?: number;
    /** The provider's last reading, as a percentage of the usable window. */
    providerPercentage?: number;
    model?: Model;
    /** The request the measured pass sees, when it grew while the host was down. */
    measuredShape?: Shape;
    /**
     * After the measured pass, the provider's reading of that request (as a
     * percentage of the usable window); a second pass then runs in the same
     * process with it, as the next turn would.
     */
    providerReadingAfter?: number;
    /** An emergency episode latched before the restart (its recorded input sample). */
    latchedEmergencySample?: number;
};

/**
 * Seeds a session in one process, then runs a pass carrying a materialization
 * request (a /ctx-flush unless stated) with one queued drop, either in that
 * same process (live usage present) or in a fresh one (the first pass after a
 * restart).
 */
async function flushPass(restarted: boolean, options: PassOptions = {}) {
    const shape = options.shape ?? FEW_LARGE;
    const origin = options.origin ?? "user_flush";
    const target = options.target ?? "newest";
    const providerPercentage = options.providerPercentage ?? TRUE_PERCENTAGE;
    const model = options.model ?? MODEL;
    useTempDataHome(`issue-752-${restarted ? "boot" : "warm"}-`);
    const sessionId = `ses-issue-752-${restarted ? "boot" : "warm"}-${origin}`;
    const db = openDatabase();
    const liveLimit = resolveContextLimit(model.providerID, model.modelID, {
        db,
        sessionID: sessionId,
    });
    const usableHard = resolveContextWindowGeometry(model.providerID, model.modelID, {
        db,
        sessionID: sessionId,
    })?.usableHard;
    const liveUsage = {
        percentage: providerPercentage,
        inputTokens: Math.round((liveLimit * providerPercentage) / 100),
    };
    const pending = new Set<string>();
    const first = newProcess({ db, sessionId, pending, model, liveUsage });
    await first({}, { messages: sessionMessages(sessionId, shape) });
    // What the event handler persists after the provider measured the last reply.
    updateSessionMeta(db, sessionId, {
        lastContextPercentage: liveUsage.percentage,
        lastInputTokens: liveUsage.inputTokens,
        lastUsageContextLimit: options.savedReadingLimit ?? liveLimit,
        lastObservedModelKey: `${model.providerID}/${model.modelID}`,
        lastResponseTime: Date.now() - (options.lastResponseAgeMs ?? 60_000),
        cacheTtl: "1h",
    });
    const tools = getTagsBySession(db, sessionId)
        .filter((tag) => tag.type === "tool")
        .sort((a, b) => b.tagNumber - a.tagNumber);
    const newestTool = tools[0]!;
    // The newest tool output sits in the protected tail; the oldest does not.
    const queued = target === "newest" ? newestTool : tools.at(-1)!;
    queuePendingOp(db, sessionId, queued.tagNumber, "drop");
    if (options.latchedEmergencySample !== undefined) {
        setEmergencyDropSample(db, sessionId, options.latchedEmergencySample);
    }

    const bootUsage = new Map<string, unknown>();
    const pass = restarted
        ? newProcess({ db, sessionId, pending, model, usageMap: bootUsage })
        : first;
    requestPendingMaterialization(pending, sessionId, origin);
    const measuredShape = options.measuredShape ?? shape;
    const lines: string[] = [];
    const spy = spyOn(logger, "sessionLog").mockImplementation((id: string, ...rest: unknown[]) => {
        if (id === sessionId) lines.push(rest.map(String).join(" "));
    });
    let latchAfterFirst: number | null = null;
    let second: {
        pendingAfterFirst: number;
        pendingAfter: number;
        droppedTools: number;
        passLog: string[];
    } | null = null;
    try {
        await pass({}, { messages: sessionMessages(sessionId, measuredShape) });
        latchAfterFirst = getEmergencyInputSample(db, sessionId);
        if (options.providerReadingAfter !== undefined) {
            const pendingAfterFirst = getPendingOps(db, sessionId).length;
            const now = Date.now();
            // What the event handler records when the provider answers.
            bootUsage.set(sessionId, {
                usage: {
                    percentage: options.providerReadingAfter,
                    inputTokens: Math.round((liveLimit * options.providerReadingAfter) / 100),
                },
                updatedAt: now,
                lastResponseTime: now,
                hasUsageTokens: true,
            });
            updateSessionMeta(db, sessionId, { lastResponseTime: now });
            const firstLines = lines.length;
            await pass({}, { messages: sessionMessages(sessionId, measuredShape) });
            second = {
                pendingAfterFirst,
                pendingAfter: getPendingOps(db, sessionId).length,
                droppedTools: getTagsBySession(db, sessionId).filter(
                    (tag) => tag.type === "tool" && tag.status === "dropped",
                ).length,
                passLog: lines
                    .slice(firstLines)
                    .filter((line) =>
                        /transform scheduler:|heuristics WILL|pending ops/.test(line),
                    ),
            };
            lines.splice(firstLines);
        }
    } finally {
        spy.mockRestore();
    }
    const after = getTagsBySession(db, sessionId).find(
        (tag) => tag.tagNumber === newestTool.tagNumber,
    );
    const bootReading = lines
        .map((line) => /unknown provider usage;.*percentage=([\d.]+)/.exec(line)?.[1])
        .find((value) => value !== undefined);
    return {
        liveLimit,
        usableHard,
        bootReading: bootReading === undefined ? null : Number(bootReading),
        newestToolStatus: after?.status,
        droppedTools: getTagsBySession(db, sessionId).filter(
            (tag) => tag.type === "tool" && tag.status === "dropped",
        ).length,
        pendingAfter: getPendingOps(db, sessionId).length,
        latchAfterFirst,
        latchAfter: getEmergencyInputSample(db, sessionId),
        second,
        passLog: lines.filter((line) =>
            /over-window first pass|unknown provider usage|transform scheduler:|first pass reset|heuristics WILL|pending ops|emergency tiered drop/.test(
                line,
            ),
        ),
    };
}

// Sized so the calibrated local count of the request reads just under 100% of
// the usable window, while staying under the 110% margin of the over-window
// check.
const NEAR_WINDOW: Shape = { tools: 8, chars: 17_600 };
// Many small tool outputs whose calibrated local count reads inside the force
// band (85% here) and below 95% on the unseeded model.
const MANY_SMALL_FORCE_BAND: Shape = { tools: 60, chars: 2_050 };
// Sized so the calibrated local count reads inside the force band and below
// 95% on the seeded model.
const FORCE_BAND_SHAPE: Shape = { tools: 8, chars: 18_800 };
// FEW_LARGE grown by three more tool outputs: about 90% by calibrated count.
const GROWN_TO_FORCE_BAND: Shape = { tools: 11, chars: 12_000 };
// FEW_LARGE grown to clearly past the window (over the 110% margin).
const GROWN_PAST_WINDOW: Shape = { tools: 16, chars: 12_000 };
const TWO_HOURS = 2 * 60 * 60 * 1000;

describe("issue 752: first pass after a restart", () => {
    // The issue claims a materialization request that is not a user /ctx-flush
    // (here the compartment boundary repair a host replay can raise) lets queued
    // drops apply. It must not: only a user /ctx-flush, a fold that changes the
    // served prefix, freshly published history or a genuine force-band reading
    // authorizes them, so on a deferred pass the queued drop stays queued.
    it("a non-user materialization request on a defer pass leaves the queued drop queued", async () => {
        const result = await flushPass(false, { origin: "boundary_repair", target: "oldest" });
        console.log("ISSUE_752_UNIT warm-boundary-repair", JSON.stringify(result));
        expect(result.pendingAfter).toBe(1);
        expect(result.droppedTools).toBe(0);
    });

    it("control: a /ctx-flush with live usage keeps the protected newest tool output", async () => {
        const result = await flushPass(false);
        console.log("ISSUE_752_UNIT warm", JSON.stringify(result));
        expect(result.newestToolStatus).toBe("active");
    });

    it("a /ctx-flush on the first pass after a restart keeps the protected newest tool output", async () => {
        const result = await flushPass(true);
        console.log("ISSUE_752_UNIT boot", JSON.stringify(result));
        expect(result.bootReading ?? 0).toBeLessThan(85);
        expect(result.newestToolStatus).toBe("active");
    });

    it("control: a /ctx-flush with live usage over many tool outputs drops only what was queued", async () => {
        const result = await flushPass(false, { shape: MANY_SMALL });
        console.log("ISSUE_752_UNIT warm-many", JSON.stringify(result));
        expect(result.droppedTools).toBeLessThanOrEqual(1);
    });

    it("a /ctx-flush after a restart over many tool outputs runs no emergency tool drop", async () => {
        const result = await flushPass(true, { shape: MANY_SMALL });
        console.log("ISSUE_752_UNIT boot-many", JSON.stringify(result));
        expect(result.passLog.some((line) => /emergency tiered drop: /.test(line))).toBe(false);
        expect(result.droppedTools).toBeLessThanOrEqual(1);
    });

    // The provider measured this session at 60%, while the local count of the
    // same request reads inside the force band: a local tokenizer can
    // overstate a provider. Inside the cache window the provider's reading is
    // the truth, so the /ctx-flush drops only what was queued and no
    // emergency tool drop rides it.
    it("the first pass after a restart prefers the saved provider reading over a local count", async () => {
        const result = await flushPass(true, { shape: MANY_SMALL_FORCE_BAND });
        console.log("ISSUE_752_UNIT boot-saved-reading", JSON.stringify(result));
        expect(result.bootReading).toBe(TRUE_PERCENTAGE);
        expect(result.passLog.some((line) => /emergency tiered drop: /.test(line))).toBe(false);
        expect(result.droppedTools).toBeLessThanOrEqual(1);
    });

    // The saved reading is warm, but the local count of this request is past
    // the 95% emergency line: the request grew after the provider measured it
    // (here the reading is simply lower than the request). The count wins, so
    // the emergency path still reduces the request before it is sent.
    it("a request that grew past the emergency line since the saved reading is still sized from its count", async () => {
        const result = await flushPass(true, { shape: NEAR_WINDOW });
        console.log("ISSUE_752_UNIT boot-grown", JSON.stringify(result));
        expect(result.passLog.some((line) => /grewPastSavedReading=60\.0/.test(line))).toBe(true);
        expect(result.bootReading ?? 0).toBeGreaterThanOrEqual(95);
        expect(result.newestToolStatus).toBe("dropped");
    });

    // Two hours idle: the provider forgot its cache, but an expired cache
    // rebuilds nothing, so the reading the provider took of the last request is
    // still the best basis for this one and the pass prices from it.
    it("an expired restart prices from the saved provider reading", async () => {
        const result = await flushPass(true, { lastResponseAgeMs: TWO_HOURS });
        console.log("ISSUE_752_UNIT boot-expired", JSON.stringify(result));
        expect(result.passLog.some((line) => /using saved provider reading/.test(line))).toBe(true);
        expect(result.bootReading).toBe(TRUE_PERCENTAGE);
        expect(result.newestToolStatus).toBe("active");
    });

    // The saved reading was taken against another limit, so the pass counts the
    // request locally. A calibrated count of an unseeded model is its neutral
    // local count, about 66% here; the fit envelope would read twice that and
    // lift the protected tail.
    it("a restart without a usable saved reading sizes a 60% session with calibrated counts, not the fit envelope", async () => {
        const result = await flushPass(true, { savedReadingLimit: 40_000 });
        console.log("ISSUE_752_UNIT boot-other-limit", JSON.stringify(result));
        expect(result.passLog.some((line) => /using wire estimate/.test(line))).toBe(true);
        expect(result.bootReading ?? 0).toBeGreaterThan(0);
        expect(result.bootReading ?? 0).toBeLessThan(85);
        expect(result.newestToolStatus).toBe("active");
    });

    // The saved reading was taken against another limit, so it is not used, and
    // the calibrated count reads inside the force band but below 95%. The
    // pending boundary repair prices the pass but grants no cache rewrite of
    // its own. A reading from a local count alone must not open one: the
    // queued drop on the oldest (unprotected) tool output stays queued until
    // the provider measures the session. The model is a seeded one, whose fit
    // count and calibrated count agree, so this case holds the force-ride rule
    // apart from the choice of count.
    it("an estimate in the force band below 95% alone leaves the queued drop queued", async () => {
        const result = await flushPass(true, {
            shape: FORCE_BAND_SHAPE,
            origin: "boundary_repair",
            target: "oldest",
            savedReadingLimit: 40_000,
            model: SEEDED_MODEL,
        });
        console.log("ISSUE_752_UNIT boot-force-band-estimate", JSON.stringify(result));
        expect(result.bootReading ?? 0).toBeGreaterThanOrEqual(85);
        expect(result.bootReading ?? 0).toBeLessThan(95);
        expect(result.pendingAfter).toBe(1);
        expect(result.droppedTools).toBe(0);
    });
    // The session grew from 60% to about 90% while the host was down. On the
    // first pass the reading comes from the local count alone (the saved one
    // was taken against another limit), so the pending boundary repair prices
    // the pass but nothing rewrites the cache: the queued drop waits. That
    // request still fits the window. The provider then measures it at 90%, and
    // the next pass, carrying that real reading, arms the force band and
    // applies the queued drop.
    it("a session that grew to about 90% during downtime waits for the provider's reading before force reclaims", async () => {
        const result = await flushPass(true, {
            origin: "boundary_repair",
            target: "oldest",
            savedReadingLimit: 40_000,
            measuredShape: GROWN_TO_FORCE_BAND,
            providerReadingAfter: 90,
        });
        console.log("ISSUE_752_UNIT boot-grown-force-band", JSON.stringify(result));
        expect(result.bootReading ?? 0).toBeGreaterThanOrEqual(85);
        expect(result.bootReading ?? 0).toBeLessThan(95);
        expect(result.second?.pendingAfterFirst).toBe(1);
        expect(result.second?.passLog.some((line) => /pending ops WILL APPLY/.test(line))).toBe(
            true,
        );
        expect(result.pendingAfter).toBe(0);
        expect(result.droppedTools).toBeGreaterThanOrEqual(1);
    });

    // A session Magic Context holds no state for, whose history grew clearly
    // past the window while the host was down, is caught by the over-window
    // first-pass check: it reads at least 95% and the force ride applies the
    // queued drop on the same pass.
    it("a session that grew past the window during downtime is still put in the emergency band on its first pass", async () => {
        const result = await flushPass(true, {
            origin: "boundary_repair",
            target: "oldest",
            measuredShape: GROWN_PAST_WINDOW,
        });
        console.log("ISSUE_752_UNIT boot-grown-over-window", JSON.stringify(result));
        expect(result.passLog.some((line) => /over-window first pass/.test(line))).toBe(true);
        expect(result.passLog.some((line) => /pending ops WILL APPLY/.test(line))).toBe(true);
        expect(result.pendingAfter).toBe(0);
    });

    // An emergency episode latched before the restart. The first pass after it
    // is priced but has no usable saved reading (taken against another limit),
    // so its reading is the local count, about 66%: below the band where the
    // latch is released, but only a count. The latch survives that pass and is
    // released on the next one, when the provider measures the session at 60%.
    it("an estimate-sized first pass keeps a latched emergency episode until a provider reading releases it", async () => {
        const result = await flushPass(true, {
            origin: "boundary_repair",
            target: "oldest",
            savedReadingLimit: 40_000,
            latchedEmergencySample: 17_000,
            providerReadingAfter: 60,
        });
        console.log("ISSUE_752_UNIT boot-latched", JSON.stringify(result));
        expect(result.passLog.some((line) => /using wire estimate/.test(line))).toBe(true);
        expect(result.bootReading ?? 0).toBeGreaterThan(0);
        expect(result.bootReading ?? 100).toBeLessThan(80);
        expect(result.latchAfterFirst).toBe(17_000);
        expect(result.latchAfter).toBe(0);
    });
});
