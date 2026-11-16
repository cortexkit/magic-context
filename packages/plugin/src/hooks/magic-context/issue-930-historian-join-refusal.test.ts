/// <reference types="bun-types" />

/**
 * Issue 930: the turn refusal that names a historian validation error.
 *
 * At 95% a primary session joins its historian for at most 60 seconds
 * (transform-compartment-phase.ts). When the join times out, the pass is
 * refused unless the final request estimate is trusted and under the context
 * limit (historianJoinFailClosedMessage). The refusal's reason text is the
 * session's last recorded historian failure, which belongs to an earlier run,
 * not to the run the pass was waiting for.
 *
 * These tests record that behaviour on a model with no calibration seed, where
 * the estimate used for the decision is an upper envelope (at least twice the
 * local count), and on a route whose tool definitions are not measured yet,
 * where the estimate is not trusted at all. In both the request fits the
 * window by the estimator's own unscaled count. The control shows that the
 * same pass, with the same recorded failure, is sent when the historian run
 * ends inside the join.
 */

import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    closeDatabase,
    incrementHistorianFailure,
    openDatabase,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import {
    __resetToolDefinitionMeasurements,
    recordToolDefinition,
} from "../../features/magic-context/tool-definition-tokens";
import type { PluginContext } from "../../plugin/types";
import * as logger from "../../shared/logger";
import { clearModelsDevCache, refreshModelLimitsFromApi } from "../../shared/models-dev-cache";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { registerActiveCompartmentRun } from "./compartment-runner";
import { resolveDecisionCalibration } from "./decision-calibration";
import { estimateFinalWireInputTokens } from "./final-wire-token-estimate";
import { createTransform } from "./transform";

const PROVIDER = "issue-930-provider";
const MODEL = "issue-930-unseeded";
const CONTEXT_LIMIT = 100_000;
/** The reported error of the run before the one the pass joins. */
const EARLIER_RUN_ERROR =
    "Historian returned invalid compartment output: Compartment range 202-280 does not map to raw session lines 407-432";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;

afterEach(() => {
    closeDatabase();
    clearModelsDevCache();
    __resetToolDefinitionMeasurements();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
});

function useTempDataHome(prefix: string): void {
    const dir = createTestTempDirFromPath(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    process.env.XDG_CACHE_HOME = dir;
}

/** A host store holding one raw message, so the compartment phase can read history. */
function createOpenCodeDb(sessionId: string): void {
    const dbPath = join(process.env.XDG_DATA_HOME!, "opencode", "opencode.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    try {
        db.exec(`
      CREATE TABLE IF NOT EXISTS message (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS part (
        id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
      );
    `);
        db.prepare(
            "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        ).run(
            "m-raw-1",
            sessionId,
            1,
            1,
            JSON.stringify({ id: "m-raw-1", role: "user", sessionID: sessionId }),
        );
        db.prepare(
            "INSERT INTO part (message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        ).run("m-raw-1", sessionId, 1, 1, JSON.stringify({ type: "text", text: "recent history" }));
    } finally {
        closeQuietly(db);
    }
}

function userMessage(sessionId: string) {
    return {
        info: { id: "m-user", role: "user", sessionID: sessionId },
        parts: [{ type: "text", text: "continue" }],
    };
}

async function setup(args: {
    prefix: string;
    sessionId: string;
    systemPromptTokens: number;
    measureTools: boolean;
    /** The historian run the pass joins; it ends when this promise settles. */
    run: Promise<void>;
    historianTimeoutMs: number;
}) {
    useTempDataHome(args.prefix);
    createOpenCodeDb(args.sessionId);
    await refreshModelLimitsFromApi({
        config: {
            providers: async () => ({
                data: {
                    providers: [
                        { id: PROVIDER, models: { [MODEL]: { limit: { input: CONTEXT_LIMIT } } } },
                    ],
                },
            }),
        },
    });
    if (args.measureTools) {
        recordToolDefinition(PROVIDER, MODEL, "build", "read", "Read a file", { type: "object" });
    }
    const db = openDatabase();
    updateSessionMeta(db, args.sessionId, { systemPromptTokens: args.systemPromptTokens });
    // The earlier run failed validation; the pass joins the next one.
    incrementHistorianFailure(db, args.sessionId, EARLIER_RUN_ERROR);
    registerActiveCompartmentRun(args.sessionId, args.run);
    const abort = mock(async () => ({ data: true }));
    const transform = createTransform({
        tagger: createTagger(),
        scheduler: { shouldExecute: mock(() => "defer" as const) },
        // The provider's own reading of the last request: 96% of the window,
        // so under the window and inside the 95% emergency band.
        contextUsageMap: new Map([
            [
                args.sessionId,
                { usage: { percentage: 96, inputTokens: 96_000 }, updatedAt: Date.now() },
            ],
        ]),
        db,
        historyRefreshSessions: new Set<string>(),
        pendingMaterializationSessions: new Set<string>(),
        lastHeuristicsTurnId: new Map<string, string>(),
        clearReasoningAge: 50,
        protectedTokens: 0,
        historianTimeoutMs: args.historianTimeoutMs,
        client: {
            session: {
                abort,
                get: mock(async () => ({ data: { directory: "/tmp", title: "Issue 930" } })),
                prompt: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"],
        directory: "/tmp",
        liveModelBySession: new Map([[args.sessionId, { providerID: PROVIDER, modelID: MODEL }]]),
        getModelKey: () => `${PROVIDER}/${MODEL}`,
        getNotificationParams: () => ({ agent: "build", providerId: PROVIDER, modelId: MODEL }),
    });
    return { db, transform, abort };
}

/**
 * Run one pass and return its log lines and the refusal line, if any.
 * `onLine` sees each line as it is logged, so a test can act at a given point
 * of the pass.
 */
async function runPass(
    transform: ReturnType<typeof createTransform>,
    sessionId: string,
    onLine?: (line: string) => void,
): Promise<{ error: unknown; lines: string[]; refusalLog: string | undefined }> {
    const lines: string[] = [];
    const spy = spyOn(logger, "sessionLog").mockImplementation((id: string, ...rest: unknown[]) => {
        if (id !== sessionId) return;
        const line = rest.map(String).join(" ");
        lines.push(line);
        onLine?.(line);
    });
    let error: unknown;
    try {
        await transform({}, { messages: [userMessage(sessionId)] });
    } catch (caught) {
        error = caught;
    } finally {
        spy.mockRestore();
    }
    return {
        error,
        lines,
        refusalLog: lines.find((line) => line.startsWith("transform: historian did not complete")),
    };
}

/** The estimator's own unscaled count of the request this pass would send. */
function unscaledCount(sessionId: string, systemPromptTokens: number): number {
    const estimate = estimateFinalWireInputTokens({
        messages: [userMessage(sessionId)],
        systemPromptTokens,
        providerID: PROVIDER,
        modelID: MODEL,
        agentName: "build",
        sessionId,
    });
    return estimate.rawTokens ?? Number.POSITIVE_INFINITY;
}

describe("issue 930: refusal after a timed-out historian join", () => {
    it("refuses a request under the window on an unseeded model and names the earlier run's validation error", async () => {
        const sessionId = "ses-issue-930-unseeded";
        let finishRun!: () => void;
        const { transform, abort } = await setup({
            prefix: "issue-930-unseeded-",
            sessionId,
            systemPromptTokens: 90_000,
            measureTools: true,
            run: new Promise<void>((resolve) => {
                finishRun = resolve;
            }),
            historianTimeoutMs: 5,
        });
        try {
            expect(resolveDecisionCalibration(PROVIDER, MODEL).seeded).toBe(false);
            expect(unscaledCount(sessionId, 90_000)).toBeLessThan(CONTEXT_LIMIT);

            const { error, lines, refusalLog } = await runPass(transform, sessionId);

            expect(lines).toContain(
                "transform: compartment await timed out after 5ms — proceeding without waiting",
            );
            expect(error).toMatchObject({
                name: "EmergencyFailClosedError",
                message: `historian did not complete within 0.005 s: ${EARLIER_RUN_ERROR}`,
            });
            // The decision compared the fit envelope, not the request's size.
            const finalEstimate = Number(/finalEstimate=(\d+)/.exec(refusalLog ?? "")?.[1]);
            expect(refusalLog).toContain("estimateTrusted=true");
            expect(refusalLog).toContain(`contextLimit=${CONTEXT_LIMIT}`);
            expect(finalEstimate).toBeGreaterThanOrEqual(2 * unscaledCount(sessionId, 90_000));
            expect(abort).not.toHaveBeenCalled();
        } finally {
            finishRun();
        }
    });

    it("refuses a small request whose estimate is untrusted because the route's tool definitions are not measured", async () => {
        const sessionId = "ses-issue-930-untrusted";
        let finishRun!: () => void;
        const { transform } = await setup({
            prefix: "issue-930-untrusted-",
            sessionId,
            systemPromptTokens: 20_000,
            measureTools: false,
            run: new Promise<void>((resolve) => {
                finishRun = resolve;
            }),
            historianTimeoutMs: 5,
        });
        try {
            expect(unscaledCount(sessionId, 20_000)).toBeLessThan(CONTEXT_LIMIT / 4);

            const { error, lines, refusalLog } = await runPass(transform, sessionId);

            expect(lines).toContain(
                "transform: compartment await timed out after 5ms — proceeding without waiting",
            );
            expect(error).toMatchObject({
                name: "EmergencyFailClosedError",
                message: `historian did not complete within 0.005 s: ${EARLIER_RUN_ERROR}`,
            });
            expect(refusalLog).toContain("estimateTrusted=false");
        } finally {
            finishRun();
        }
    });

    it("sends the same pass when the historian run ends inside the join, even though that run also failed", async () => {
        const sessionId = "ses-issue-930-control";
        let finishRun!: () => void;
        const { db, transform, abort } = await setup({
            prefix: "issue-930-control-",
            sessionId,
            systemPromptTokens: 90_000,
            measureTools: true,
            run: new Promise<void>((resolve) => {
                finishRun = resolve;
            }),
            historianTimeoutMs: 5_000,
        });

        // The run ends only once the pass is waiting for it: it fails
        // validation like the earlier run did, and publishes nothing.
        const { error, lines, refusalLog } = await runPass(transform, sessionId, (line) => {
            if (!line.startsWith("transform: blocking at")) return;
            incrementHistorianFailure(db, sessionId, EARLIER_RUN_ERROR);
            finishRun();
        });

        expect(lines).toContain(
            "transform: compartment agent completed, refreshing compartment coverage",
        );
        expect(error).toBeUndefined();
        expect(refusalLog).toBeUndefined();
        expect(abort).not.toHaveBeenCalled();
    });
});
