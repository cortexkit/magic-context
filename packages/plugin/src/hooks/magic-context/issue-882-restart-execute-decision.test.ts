/// <reference types="bun-types" />

/**
 * The scheduler decision on the first transform pass after a process restart
 * (issue 882).
 *
 * That pass clears the saved usage reading, so no pressure check acts on a
 * measurement taken before the restart. When the saved reading was already at
 * or above the execute threshold, the work an execute pass does is owed, and
 * deferring it by one pass makes a session whose provider cache went cold
 * during the restart pay for two full prefix writes instead of one. So the
 * scheduler decides from that reading, when it is for the same model and
 * limit. Everything after the decision follows the ordinary rules: queued drops
 * land only when the pass may rebuild, and they wait while a summary can still
 * come. Every other use of the reading stays cleared, so a saved 90% reading
 * opens neither the force band nor the emergency tool drop on that pass.
 *
 * The cases mirror the reported session: `cache_ttl: "never"` (a keep-warm
 * plugin), a 63% execute threshold, and a host that was stopped for 5.8 hours.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
import type { ContextUsage } from "../../features/magic-context/types";
import * as logger from "../../shared/logger";
import { clearModelsDevCache, refreshModelLimitsFromApi } from "../../shared/models-dev-cache";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { registerActiveCompartmentRun } from "./compartment-runner";
import { resolveContextLimit } from "./event-resolvers";
import { createTransform } from "./transform";

type Model = { providerID: string; modelID: string };
const MODEL: Model = { providerID: "issue-882-provider", modelID: "issue-882-model" };
const OTHER_MODEL: Model = { providerID: "issue-882-provider", modelID: "issue-882-other" };
const EXECUTE_THRESHOLD = 63;
const STOPPED_FOR_MS = 5.8 * 60 * 60 * 1000;

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
                                [OTHER_MODEL.modelID]: {
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

/** A user prompt, eight large tool outputs, and the prompt after the restart. */
function sessionMessages(sessionId: string): TestMessage[] {
    const messages: TestMessage[] = [
        {
            info: { id: "u-0", role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: "run the listings" }],
        },
    ];
    for (let i = 0; i < 8; i++) {
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
                        output: prose(12_000, i),
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

/** One host process: a real scheduler at the execute threshold, no historian executor. */
function newProcess(args: {
    db: ReturnType<typeof openDatabase>;
    sessionId: string;
    model: Model;
    liveUsage?: ContextUsage;
}) {
    return createTransform({
        tagger: createTagger(),
        scheduler: createScheduler({ executeThresholdPercentage: EXECUTE_THRESHOLD }),
        executeThresholdPercentage: EXECUTE_THRESHOLD,
        // A keep-warm plugin holds the provider cache, so idle time never
        // expires it and only pressure can make a pass execute.
        cacheTtlConfig: "never",
        cacheTtlConfigured: true,
        contextUsageMap: new Map(
            args.liveUsage
                ? [
                      [
                          args.sessionId,
                          { usage: args.liveUsage, updatedAt: Date.now(), hasUsageTokens: true },
                      ],
                  ]
                : [],
        ),
        db: args.db,
        liveModelBySession: new Map([[args.sessionId, args.model]]),
        historyRefreshSessions: new Set<string>(),
        pendingMaterializationSessions: new Set<string>(),
        lastHeuristicsTurnId: new Map<string, string>(),
        clearReasoningAge: 50,
        protectedTokens: 0,
    });
}

type Restart = {
    /** The provider's last reading before the host stopped, as saved in session_meta. */
    savedPercentage: number;
    /** The model that reading was taken on (default MODEL). */
    savedModel?: Model;
    /** The limit that reading was taken against (default: the model's limit). */
    savedLimit?: number;
    /** The model the first request after the restart goes to (default MODEL). */
    passModel?: Model;
    /** A historian run is still in progress, so a summary can come. */
    summaryCanCome?: boolean;
};

/**
 * Tags the session in one process, saves the provider reading the host had
 * before it stopped, queues a drop on the oldest tool output (outside the
 * protected tail), then runs the first pass of a new process.
 */
async function firstPassAfterRestart(name: string, restart: Restart) {
    useTempDataHome(`issue-882-${name}-`);
    const sessionId = `ses-issue-882-${name}`;
    const db = openDatabase();
    const savedModel = restart.savedModel ?? MODEL;
    const passModel = restart.passModel ?? MODEL;
    const limit = resolveContextLimit(savedModel.providerID, savedModel.modelID, {
        db,
        sessionID: sessionId,
    });
    const before = newProcess({
        db,
        sessionId,
        model: savedModel,
        liveUsage: { percentage: 40, inputTokens: Math.round(limit * 0.4) },
    });
    await before({}, { messages: sessionMessages(sessionId) });
    // What the event handler saved from the last reply before the host stopped.
    updateSessionMeta(db, sessionId, {
        lastContextPercentage: restart.savedPercentage,
        lastInputTokens: Math.round((limit * restart.savedPercentage) / 100),
        lastUsageContextLimit: restart.savedLimit ?? limit,
        lastObservedModelKey: `${savedModel.providerID}/${savedModel.modelID}`,
        lastResponseTime: Date.now() - STOPPED_FOR_MS,
    });
    const tools = getTagsBySession(db, sessionId)
        .filter((tag) => tag.type === "tool")
        .sort((a, b) => a.tagNumber - b.tagNumber);
    const oldestTool = tools[0]!;
    const newestTool = tools.at(-1)!;
    queuePendingOp(db, sessionId, oldestTool.tagNumber, "drop");

    let finishRun: (() => void) | undefined;
    if (restart.summaryCanCome) {
        updateSessionMeta(db, sessionId, { compartmentInProgress: true });
        registerActiveCompartmentRun(
            sessionId,
            new Promise<void>((resolve) => {
                finishRun = resolve;
            }),
        );
    }

    const after = newProcess({ db, sessionId, model: passModel });
    const lines: string[] = [];
    const spy = spyOn(logger, "sessionLog").mockImplementation((id: string, ...rest: unknown[]) => {
        if (id === sessionId) lines.push(rest.map(String).join(" "));
    });
    try {
        await after({}, { messages: sessionMessages(sessionId) });
    } finally {
        spy.mockRestore();
        finishRun?.();
    }
    const tagsAfter = getTagsBySession(db, sessionId);
    const scheduler = lines.find((line) => line.startsWith("transform scheduler:")) ?? "";
    return {
        scheduler,
        decision: /decision=(\w+)/.exec(scheduler)?.[1],
        schedulerPercentage: Number(/percentage=([\d.]+)%/.exec(scheduler)?.[1]),
        pendingAfter: getPendingOps(db, sessionId).length,
        oldestToolStatus: tagsAfter.find((tag) => tag.tagNumber === oldestTool.tagNumber)?.status,
        newestToolStatus: tagsAfter.find((tag) => tag.tagNumber === newestTool.tagNumber)?.status,
        droppedTools: tagsAfter.filter((tag) => tag.type === "tool" && tag.status === "dropped")
            .length,
        savedPercentageAfter: getOrCreateSessionMeta(db, sessionId).lastContextPercentage,
        passLog: lines.filter((line) =>
            /first pass|model change since last usage|transform scheduler:|unknown provider usage|heuristics WILL|pending ops|emergency tiered drop|force_materialization/.test(
                line,
            ),
        ),
    };
}

describe("issue 882: the execute decision on the first pass after a restart", () => {
    // The reported session: saved at 63.1% against a 63% threshold. The first
    // pass decides "execute" from that reading. No summary can come (no
    // historian run and none allowed to start), and the queued drop is worth
    // more than 2% of the window, so that execute pass may rebuild and the
    // drop lands on it instead of one pass later.
    it("a saved reading at the threshold decides execute, and the queued drop lands on that pass", async () => {
        const result = await firstPassAfterRestart("reported", { savedPercentage: 63.1 });
        console.log("ISSUE_882_UNIT reported", JSON.stringify(result));
        expect(result.decision).toBe("execute");
        expect(result.schedulerPercentage).toBe(63.1);
        expect(result.passLog.some((line) => /pending ops WILL APPLY/.test(line))).toBe(true);
        expect(result.pendingAfter).toBe(0);
        expect(result.oldestToolStatus).toBe("dropped");
        // The reading served only the decision: the stored copy is still
        // cleared, and the pass was not sized from it.
        expect(result.savedPercentageAfter).toBe(0);
        expect(result.passLog.some((line) => /unknown provider usage/.test(line))).toBe(false);
    });

    // The same decision while a historian run is in progress. An execute pass
    // whose summary can still come holds its drops for that summary's rebuild,
    // so the decision changes nothing on the wire by itself.
    it("an execute decision from the saved reading still holds the drop while a summary can come", async () => {
        const result = await firstPassAfterRestart("summary-can-come", {
            savedPercentage: 63.1,
            summaryCanCome: true,
        });
        console.log("ISSUE_882_UNIT summary-can-come", JSON.stringify(result));
        expect(result.decision).toBe("execute");
        expect(result.passLog.some((line) => /pending ops held/.test(line))).toBe(true);
        expect(result.pendingAfter).toBe(1);
        expect(result.droppedTools).toBe(0);
    });

    // At 90% the saved reading is inside the force band (85% here). It decides
    // "execute", but the force band and the emergency tool drop read the
    // pass's cleared reading, so only the queued drop lands, through the same
    // execute rule as at 63%, and the newest tool output stays protected.
    it("a saved 90% reading decides execute but opens neither the force band nor the emergency drop", async () => {
        const result = await firstPassAfterRestart("force-band", { savedPercentage: 90 });
        console.log("ISSUE_882_UNIT force-band", JSON.stringify(result));
        expect(result.decision).toBe("execute");
        expect(result.schedulerPercentage).toBe(90);
        expect(result.passLog.some((line) => /emergency tiered drop/.test(line))).toBe(false);
        expect(result.passLog.some((line) => /force_materialization/.test(line))).toBe(false);
        expect(result.passLog.some((line) => /unknown provider usage/.test(line))).toBe(false);
        expect(
            result.passLog.some((line) => /pending ops WILL APPLY.*context=0\.0%/.test(line)),
        ).toBe(true);
        expect(result.droppedTools).toBe(1);
        expect(result.oldestToolStatus).toBe("dropped");
        expect(result.newestToolStatus).toBe("active");
    });

    // Controls: these keep the reset exactly as before the change, so they
    // pass with or without it, and guard against a broader rule.
    it("a saved reading below the threshold keeps the cleared reading for the decision", async () => {
        const result = await firstPassAfterRestart("below", { savedPercentage: 62.9 });
        console.log("ISSUE_882_UNIT below", JSON.stringify(result));
        expect(result.passLog.some((line) => /first pass reset — percentage=62\.9%/.test(line))).toBe(
            true,
        );
        expect(result.decision).toBe("defer");
        expect(result.schedulerPercentage).toBe(0);
        expect(result.pendingAfter).toBe(1);
        expect(result.droppedTools).toBe(0);
    });

    it("a saved reading from another model keeps the cleared reading for the decision", async () => {
        const result = await firstPassAfterRestart("other-model", {
            savedPercentage: 63.1,
            passModel: OTHER_MODEL,
        });
        console.log("ISSUE_882_UNIT other-model", JSON.stringify(result));
        expect(result.passLog.some((line) => /model change since last usage/.test(line))).toBe(
            true,
        );
        expect(result.decision).toBe("defer");
        expect(result.schedulerPercentage).toBe(0);
        expect(result.pendingAfter).toBe(1);
        expect(result.droppedTools).toBe(0);
    });

    // A reading taken against another limit is a percentage of a different
    // window, so it does not decide either.
    it("a saved reading taken against another limit keeps the cleared reading for the decision", async () => {
        const result = await firstPassAfterRestart("other-limit", {
            savedPercentage: 63.1,
            savedLimit: 40_000,
        });
        console.log("ISSUE_882_UNIT other-limit", JSON.stringify(result));
        expect(result.decision).toBe("defer");
        expect(result.schedulerPercentage).toBe(0);
        expect(result.pendingAfter).toBe(1);
        expect(result.droppedTools).toBe(0);
    });
});
