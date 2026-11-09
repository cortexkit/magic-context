/// <reference types="bun-types" />

/**
 * OpenCode 1 runs the same transform as OpenCode 2 and resolves its window
 * through the same shared geometry. For a model whose declared input limit
 * (302,222) is below its context window (1,000,000), a pass sized from a local
 * count reads it against the window a provider reading does (the input limit,
 * less any configured output reserve), and the 95% fail-closed line sits at 95%
 * of the input limit. Read against the context less the 32,000-token output cap
 * (968,000), both read about a third as full.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import {
    recordOverflowDetected,
    resetEmergencyRecoveryRegistryForTest,
} from "../../features/magic-context/storage-meta-persisted";
import { createTagger } from "../../features/magic-context/tagger";
import type { ContextUsage } from "../../features/magic-context/types";
import * as logger from "../../shared/logger";
import {
    clearModelsDevCache,
    refreshModelLimitsFromApi,
    setOutputReserveConfig,
} from "../../shared/models-dev-cache";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { resolveContextLimit, resolveContextWindowGeometry } from "./event-resolvers";
import { requestPendingMaterialization } from "./pending-materialization";
import { createTransform } from "./transform";

const MODEL = { providerID: "opencode-go", modelID: "deepseek-v4.1-flash" };
const MODEL_KEY = `${MODEL.providerID}/${MODEL.modelID}`;
const INPUT_LIMIT = 302_222;
const RESERVE = 100_000;

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

beforeEach(async () => {
    const dir = createTestTempDirFromPath(join(tmpdir(), "input-limit-window-"));
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
                                [MODEL.modelID]: {
                                    limit: {
                                        context: 1_000_000,
                                        input: INPUT_LIMIT,
                                        output: 65_536,
                                    },
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
    setOutputReserveConfig(undefined);
    resetEmergencyRecoveryRegistryForTest();
    clearModelsDevCache();
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
});

const prose = "Review the records and verify each one carefully before the next deployment step. ";

function sessionMessages(sessionId: string) {
    const messages: Array<{
        info: Record<string, unknown>;
        parts: Array<Record<string, unknown>>;
    }> = [
        {
            info: { id: "u-0", role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: "process the records" }],
        },
    ];
    for (let i = 0; i < 10; i++)
        messages.push({
            info: { id: `a-${i}`, role: "assistant", sessionID: sessionId },
            parts: [
                {
                    type: "tool",
                    callID: `call-${i}`,
                    tool: "bash",
                    state: {
                        status: "completed",
                        input: { command: `cat records/record-${i}.json` },
                        output: prose.repeat(80),
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

function newProcess(args: {
    db: ReturnType<typeof openDatabase>;
    sessionId: string;
    pending: Set<string>;
    liveUsage?: ContextUsage;
    onRefuse?: () => void;
}) {
    return createTransform({
        tagger: createTagger(),
        scheduler: { shouldExecute: mock(() => "defer" as const) },
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
        liveModelBySession: new Map([[args.sessionId, MODEL]]),
        historyRefreshSessions: new Set<string>(),
        pendingMaterializationSessions: args.pending,
        lastHeuristicsTurnId: new Map<string, string>(),
        clearReasoningAge: 50,
        protectedTokens: 0,
        hostRefusalNotice: async () => {},
        hostRefuse: async () => {
            args.onRefuse?.();
        },
    });
}

async function passLogs(sessionId: string, run: () => Promise<unknown>): Promise<string[]> {
    const lines: string[] = [];
    const spy = spyOn(logger, "sessionLog").mockImplementation((id: string, ...rest: unknown[]) => {
        if (id === sessionId) lines.push(rest.map(String).join(" "));
    });
    try {
        await run();
    } finally {
        spy.mockRestore();
    }
    return lines;
}

describe("OpenCode 1: a declared input limit is the window of every pressure reading", () => {
    it("caps the shared hard wall at the input limit", () => {
        const db = openDatabase();
        const ctx = { db, sessionID: "ses-input-limit-geometry" };
        expect(resolveContextLimit(MODEL.providerID, MODEL.modelID, ctx)).toBe(INPUT_LIMIT);
        expect(resolveContextWindowGeometry(MODEL.providerID, MODEL.modelID, ctx)?.usableHard).toBe(
            INPUT_LIMIT,
        );
    });

    it("reads a pass sized from a local count against the window provider readings use, not the hard wall", async () => {
        const sessionId = "ses-input-limit-local-count";
        const db = openDatabase();
        const pending = new Set<string>();
        // A configured output reserve narrows the window provider readings are a
        // share of (the input limit less the reserve) but not the hard wall (the
        // input limit), so a count read against the wrong one reads differently.
        setOutputReserveConfig(RESERVE);
        const ctx = { db, sessionID: sessionId };
        expect(resolveContextLimit(MODEL.providerID, MODEL.modelID, ctx)).toBe(
            INPUT_LIMIT - RESERVE,
        );
        expect(resolveContextWindowGeometry(MODEL.providerID, MODEL.modelID, ctx)?.usableHard).toBe(
            INPUT_LIMIT,
        );
        // A /ctx-flush makes the pass priced; the provider has reported no usage.
        requestPendingMaterialization(pending, sessionId, "user_flush");
        const lines = await passLogs(sessionId, () =>
            newProcess({ db, sessionId, pending })({}, {
                messages: sessionMessages(sessionId),
            } as never),
        );
        const sized =
            /using wire estimate for priced pass inputTokens=(\d+) percentage=([\d.]+)/.exec(
                lines.join("\n"),
            );
        if (!sized) throw new Error(`no local count:\n${lines.join("\n")}`);
        const tokens = Number(sized[1]);
        const percentage = Number(sized[2]);
        expect(Math.abs(percentage - (tokens / (INPUT_LIMIT - RESERVE)) * 100)).toBeLessThan(0.1);
        expect(Math.abs(percentage - (tokens / INPUT_LIMIT) * 100)).toBeGreaterThan(0.5);
    });

    it("refuses a provider overflow at 95% of the input limit", async () => {
        const sessionId = "ses-input-limit-fail-closed";
        const db = openDatabase();
        const inputTokens = Math.round(INPUT_LIMIT * 0.96);
        recordOverflowDetected(db, sessionId, undefined, MODEL_KEY, "provider_overflow");
        let refused = false;
        const lines = await passLogs(sessionId, () =>
            newProcess({
                db,
                sessionId,
                pending: new Set<string>(),
                liveUsage: { percentage: 96, inputTokens },
                onRefuse: () => {
                    refused = true;
                },
            })({}, { messages: sessionMessages(sessionId) } as never),
        );
        expect(refused).toBe(true);
        expect(
            lines.some((line) =>
                /EMERGENCY: fail-closed \(reason=provider-overflow-abort/.test(line),
            ),
        ).toBe(true);
    });
});
