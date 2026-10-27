/// <reference types="bun-types" />

/**
 * The first transform pass after a restart, on a database whose tool-definition
 * rows hold every tool the route was ever offered.
 *
 * Versions before this change never removed a stored tool-definition row, so a
 * route that was once offered 108 tools kept 108 rows although its sessions are
 * offered 34. The numbers are the GitHub issue 797 report's: on a 200k Claude
 * window, a request the provider measured at about 76% of the usable window
 * counted at about 98% with the 74 tools it no longer carries. Within the cache
 * window the provider's saved reading wins, unless the local count is at or past
 * 95% and above it. The phantom tools pushed the count past that line, so the
 * count replaced a correct reading and put the pass in the emergency band. The
 * count must describe the tools of the request: about 76%, below the 95% line,
 * so the saved reading stands, no emergency drop runs and the protected newest
 * tool output stays.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    closeDatabase,
    getTagsBySession,
    openDatabase,
    queuePendingOp,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import {
    __resetToolDefinitionMeasurements,
    recordToolDefinition,
} from "../../features/magic-context/tool-definition-tokens";
import type { ContextUsage } from "../../features/magic-context/types";
import * as logger from "../../shared/logger";
import { clearModelsDevCache, refreshModelLimitsFromApi } from "../../shared/models-dev-cache";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { resolveContextLimit, resolveContextWindowGeometry } from "./event-resolvers";
import { estimateFinalWireInputTokens } from "./final-wire-token-estimate";
import { requestPendingMaterialization } from "./pending-materialization";
import { estimateTokens } from "./read-session-formatting";
import { createTransform } from "./transform";

const MODEL = { providerID: "anthropic", modelID: "claude-opus-5" };
const LIVE_TOOLS = 34;
const PHANTOM_TOOLS = 74;
/** Local tokens per stored row of a tool the route is no longer offered. */
const PHANTOM_TOKENS = 374;

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

beforeEach(async () => {
    __resetToolDefinitionMeasurements();
    await refreshModelLimitsFromApi({
        config: {
            providers: async () => ({
                data: {
                    providers: [
                        {
                            id: MODEL.providerID,
                            models: {
                                [MODEL.modelID]: { limit: { context: 200_000, output: 32_000 } },
                            },
                        },
                    ],
                },
            }),
        },
    });
});

afterEach(() => {
    __resetToolDefinitionMeasurements();
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

function sessionMessages(sessionId: string) {
    const messages: Array<{
        info: Record<string, unknown>;
        parts: Array<Record<string, unknown>>;
    }> = [
        {
            info: { id: "u-0", role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: "run the listings" }],
        },
    ];
    for (let i = 0; i < 20; i++)
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
                        output: prose(33_900, i),
                    },
                },
            ],
        });
    messages.push({
        info: { id: "u-1", role: "user", sessionID: sessionId },
        parts: [{ type: "text", text: "continue" }],
    });
    return messages;
}

const liveTool = (i: number) => ({
    id: `tool_${i}`,
    description: prose(2_900, i),
    parameters: { type: "object", properties: { path: { type: "string" } } },
});

function newProcess(
    db: ReturnType<typeof openDatabase>,
    sessionId: string,
    pending: Set<string>,
    liveUsage?: ContextUsage,
) {
    return createTransform({
        tagger: createTagger(),
        scheduler: { shouldExecute: mock(() => "defer" as const) },
        contextUsageMap: new Map(
            liveUsage
                ? [[sessionId, { usage: liveUsage, updatedAt: Date.now(), hasUsageTokens: true }]]
                : [],
        ),
        db,
        liveModelBySession: new Map([[sessionId, MODEL]]),
        historyRefreshSessions: new Set<string>(),
        pendingMaterializationSessions: pending,
        lastHeuristicsTurnId: new Map<string, string>(),
        clearReasoningAge: 50,
        protectedTokens: 0,
    });
}

describe("issue 797: first pass after a restart with stored tool rows of every tool ever seen", () => {
    it("sizes a session the provider measured at about 76% at about 76%, with no force band or emergency drop", async () => {
        const dir = createTestTempDirFromPath(join(tmpdir(), "issue-797-restart-"));
        tempDirs.push(dir);
        process.env.XDG_DATA_HOME = dir;
        const sessionId = "ses-issue-797-restart";
        let db = openDatabase();
        const usableHard = resolveContextWindowGeometry(MODEL.providerID, MODEL.modelID, {
            db,
            sessionID: sessionId,
        })?.usableHard;
        const liveLimit = resolveContextLimit(MODEL.providerID, MODEL.modelID, {
            db,
            sessionID: sessionId,
        });
        expect(usableHard).toBeGreaterThan(190_000);

        // The request as the provider measured it: its own 34 tools only.
        const tools = Array.from({ length: LIVE_TOOLS }, (_, i) => liveTool(i));
        const liveToolTokens = tools.reduce(
            (sum, tool) =>
                sum +
                estimateTokens(tool.description) +
                estimateTokens(JSON.stringify(tool.parameters)),
            0,
        );
        const count = (toolDefinitionTokens: number) =>
            ((estimateFinalWireInputTokens({
                messages: sessionMessages(sessionId) as never,
                systemPromptTokens: 0,
                toolDefinitionTokens,
                ...MODEL,
                agentName: undefined,
            }).pressureTokens ?? 0) /
                usableHard!) *
            100;
        const providerPercentage = count(liveToolTokens);
        const withPhantoms = count(liveToolTokens + PHANTOM_TOOLS * PHANTOM_TOKENS);
        console.log(
            "ISSUE_797_SHAPE",
            JSON.stringify({ usableHard, liveToolTokens, providerPercentage, withPhantoms }),
        );
        // The report's shape: about 76% for real, past the 95% line with the
        // tools the route is no longer offered.
        expect(providerPercentage).toBeGreaterThan(72);
        expect(providerPercentage).toBeLessThan(80);
        expect(withPhantoms).toBeGreaterThanOrEqual(95);

        const pending = new Set<string>();
        const liveUsage = {
            percentage: providerPercentage,
            inputTokens: Math.round(((usableHard ?? 0) * providerPercentage) / 100),
        };
        await newProcess(
            db,
            sessionId,
            pending,
            liveUsage,
        )({}, { messages: sessionMessages(sessionId) } as never);
        // What the event handler persists after the provider measured the last reply.
        updateSessionMeta(db, sessionId, {
            lastContextPercentage: liveUsage.percentage,
            lastInputTokens: liveUsage.inputTokens,
            lastUsageContextLimit: liveLimit,
            lastObservedModelKey: `${MODEL.providerID}/${MODEL.modelID}`,
            lastResponseTime: Date.now() - 60_000,
            cacheTtl: "1h",
        });
        const newestTool = getTagsBySession(db, sessionId)
            .filter((tag) => tag.type === "tool")
            .sort((a, b) => b.tagNumber - a.tagNumber)[0]!;
        queuePendingOp(db, sessionId, newestTool.tagNumber, "drop");

        // The stored rows an earlier version left: the 34 tools of this request
        // plus 74 the route was offered once and never again.
        const insert = db.prepare(
            `INSERT OR REPLACE INTO tool_definition_measurements
             (provider_id, model_id, agent_name, tool_id, token_count, recorded_at)
             VALUES (?, ?, 'default', ?, ?, ?)`,
        );
        for (const tool of tools)
            insert.run(
                MODEL.providerID,
                MODEL.modelID,
                tool.id,
                estimateTokens(tool.description) + estimateTokens(JSON.stringify(tool.parameters)),
                Date.now(),
            );
        for (let i = 0; i < PHANTOM_TOOLS; i++)
            insert.run(MODEL.providerID, MODEL.modelID, `retired_${i}`, PHANTOM_TOKENS, 1);

        // Restart: a new process reloads the stored rows, then OpenCode 1 fires
        // tool.definition for this request's tools before its messages transform.
        __resetToolDefinitionMeasurements();
        closeDatabase();
        db = openDatabase();
        for (const tool of tools)
            recordToolDefinition(
                MODEL.providerID,
                MODEL.modelID,
                undefined,
                tool.id,
                tool.description,
                tool.parameters,
                sessionId,
            );
        requestPendingMaterialization(pending, sessionId, "user_flush");
        const lines: string[] = [];
        const spy = spyOn(logger, "sessionLog").mockImplementation(
            (id: string, ...rest: unknown[]) => {
                if (id === sessionId) lines.push(rest.map(String).join(" "));
            },
        );
        try {
            await newProcess(
                db,
                sessionId,
                pending,
            )({}, { messages: sessionMessages(sessionId) } as never);
        } finally {
            spy.mockRestore();
        }
        const usageLine = lines.find((line) => line.includes("unknown provider usage;"));
        const reading = Number(/ percentage=([\d.]+)/.exec(usageLine ?? "")?.[1]);
        const counted = Number(/countPercentage=([\d.]+)/.exec(usageLine ?? "")?.[1]);
        console.log(
            "ISSUE_797_RESTART",
            JSON.stringify({
                liveToolTokens,
                providerPercentage: providerPercentage.toFixed(1),
                withPhantoms: withPhantoms.toFixed(1),
                usageLine,
            }),
        );
        expect(usageLine).toContain("using saved provider reading");
        expect(reading).toBeCloseTo(providerPercentage, 0);
        // The count itself describes this request: close to the provider's
        // reading, not in the force band.
        expect(Math.abs(counted - providerPercentage)).toBeLessThan(3);
        expect(lines.some((line) => /emergency tiered drop: /.test(line))).toBe(false);
        // The queued drop targets the newest output, inside the protected tail;
        // only a reading at 95% or more lifts that protection.
        expect(
            getTagsBySession(db, sessionId).find((tag) => tag.tagNumber === newestTool.tagNumber)
                ?.status,
        ).toBe("active");
        expect(
            getTagsBySession(db, sessionId).filter(
                (tag) => tag.type === "tool" && tag.status === "dropped",
            ),
        ).toHaveLength(0);
    });
});
