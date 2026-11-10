/// <reference types="bun-types" />

/**
 * Issue 889 on OpenCode 1. After a switch from a large-window model to a much
 * smaller one, or after a provider overflow, recovery summarizes history and
 * folds it into the request head. One summary can leave the request several
 * times over the new window. A recovery pass keeps the historian running on
 * the next chunk within its turn, and a request still over 95% of the window
 * is refused, never sent.
 *
 * The historian's model call is stubbed: each run publishes one user turn and
 * its reply as a compartment, the way the real runner publishes (the published
 * callback; the recovery latch stays armed until a recovery pass's request
 * fits).
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    appendCompartments,
    getCompartments,
} from "../../features/magic-context/compartment-storage";
import {
    closeDatabase,
    openDatabase,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import {
    getOverflowState,
    recordOverflowDetected,
    resetEmergencyRecoveryRegistryForTest,
} from "../../features/magic-context/storage-meta-persisted";
import { createTagger } from "../../features/magic-context/tagger";
import type { PluginContext } from "../../plugin/types";
import * as logger from "../../shared/logger";
import { clearModelsDevCache, refreshModelLimitsFromApi } from "../../shared/models-dev-cache";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import * as incremental from "./compartment-runner-incremental";
import { resolveContextWindowGeometry } from "./event-resolvers";
import { estimateFinalWireInputTokens } from "./final-wire-token-estimate";
import { createTransform } from "./transform";

const LARGE = { providerID: "openai", modelID: "large-window" };
const SMALL = { providerID: "openai", modelID: "small-window" };
const LARGE_KEY = `${LARGE.providerID}/${LARGE.modelID}`;
const SMALL_KEY = `${SMALL.providerID}/${SMALL.modelID}`;
const TURNS = 8;
const prose = "Review the records and verify each one carefully before the next deployment step. ";
/** A recovery refusal asks the person to send again; recovery continues on the next turn. */
const RECOVERY_NOTICE =
    "Magic Context is still summarizing older history so this conversation fits the model's context window. Send your message again to continue.";

let dir: string;
const originalXdgDataHome = process.env.XDG_DATA_HOME;

beforeEach(async () => {
    dir = createTestTempDirFromPath(join(tmpdir(), "issue-889-recovery-"));
    process.env.XDG_DATA_HOME = dir;
    await refreshModelLimitsFromApi({
        config: {
            providers: async () => ({
                data: {
                    providers: [
                        {
                            id: "openai",
                            models: {
                                [LARGE.modelID]: { limit: { context: 1_000_000, output: 32_000 } },
                                [SMALL.modelID]: { limit: { context: 24_000, output: 2_000 } },
                            },
                        },
                    ],
                },
            }),
        },
    });
});

afterEach(() => {
    resetEmergencyRecoveryRegistryForTest();
    clearModelsDevCache();
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    rmSync(dir, { recursive: true, force: true });
});

/** Raw ids in session order: eight large user turns with short replies, then a short prompt. */
function rawIds(): string[] {
    const ids: string[] = [];
    for (let turn = 0; turn < TURNS; turn++) ids.push(`u${turn}`, `a${turn}`);
    ids.push("u-next");
    return ids;
}

function textOf(id: string): string {
    if (id === "u-next") return "Continue with the next step.";
    if (id.startsWith("u")) return `Turn ${id.slice(1)}: ${prose.repeat(250)}`;
    return `Reply ${id.slice(1)}: done.`;
}

/** The host's own store, which the historian boundary reads. */
function writeOpenCodeDb(sessionId: string): void {
    const dbPath = join(dir, "opencode", "opencode.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    const raw = new Database(dbPath);
    try {
        raw.exec(`
            CREATE TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS part (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
        `);
        rawIds().forEach((id, index) => {
            const role = id.startsWith("u") ? "user" : "assistant";
            raw.prepare(
                "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
            ).run(
                id,
                sessionId,
                index + 1,
                index + 1,
                JSON.stringify({ id, role, sessionID: sessionId }),
            );
            raw.prepare(
                "INSERT INTO part (message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
            ).run(
                id,
                sessionId,
                index + 1,
                index + 1,
                JSON.stringify({ type: "text", text: textOf(id) }),
            );
        });
    } finally {
        closeQuietly(raw);
    }
}

/** The array the host hands the transform, with the newest prompt on `model`. */
function hostMessages(sessionId: string, model: typeof LARGE) {
    return rawIds().map((id) => {
        const user = id.startsWith("u");
        return {
            info: user
                ? {
                      id,
                      role: "user",
                      sessionID: sessionId,
                      ...(id === "u-next" ? { model } : {}),
                  }
                : { id, role: "assistant", sessionID: sessionId, ...LARGE },
            parts: [{ type: "text", text: textOf(id) }],
        };
    });
}

/**
 * Each historian run publishes the next user turn and its reply, up to
 * `publishing` runs; later runs publish nothing (no progress).
 */
function stubHistorian(db: ReturnType<typeof openDatabase>, publishing: number) {
    const ids = rawIds();
    let runs = 0;
    const spy = spyOn(incremental, "runCompartmentAgent").mockImplementation(async (deps) => {
        runs += 1;
        updateSessionMeta(db, deps.sessionId, { compartmentInProgress: false });
        const snapshot = deps.boundarySnapshot;
        if (runs > publishing || !snapshot) return;
        const start = snapshot.offset;
        const end = start + 1;
        if (end >= snapshot.eligibleEndOrdinal) return;
        appendCompartments(db, deps.sessionId, [
            {
                sequence: getCompartments(db, deps.sessionId).length,
                startMessage: start,
                endMessage: end,
                startMessageId: ids[start - 1]!,
                endMessageId: ids[end - 1]!,
                title: `Turn ${start}`,
                content: "Reviewed the earlier records.",
            },
        ]);
        deps.onCompartmentStatePublished?.(deps.sessionId);
    });
    return { spy, runs: () => runs };
}

function newTransform(args: {
    db: ReturnType<typeof openDatabase>;
    live: Map<string, typeof LARGE>;
    onRefuse: () => void;
    notices?: string[];
    hostAddedTokens?: number;
}) {
    return createTransform({
        tagger: createTagger(),
        scheduler: { shouldExecute: mock(() => "defer" as const) },
        contextUsageMap: new Map(),
        db: args.db,
        liveModelBySession: args.live,
        getModelKey: (id: string) => {
            const model = args.live.get(id);
            return model ? `${model.providerID}/${model.modelID}` : undefined;
        },
        historyRefreshSessions: new Set<string>(),
        pendingMaterializationSessions: new Set<string>(),
        lastHeuristicsTurnId: new Map<string, string>(),
        clearReasoningAge: 50,
        protectedTokens: 0,
        storeGeneration: "v1",
        directory: dir,
        client: {
            session: { abort: mock(async () => ({ data: true })), prompt: mock(async () => ({})) },
        } as unknown as PluginContext["client"],
        hostRefusalNotice: async (_client, _sessionId, message) => {
            args.notices?.push(message);
        },
        // An OpenCode 2 host reports the checkpoint text it adds after the
        // transform; the totals are kept small so they raise no pressure.
        hostInputEstimate:
            args.hostAddedTokens === undefined
                ? undefined
                : () => ({ tokens: 1, pressureTokens: 1, hostAddedTokens: args.hostAddedTokens }),
        hostRefuse: async () => {
            args.onRefuse();
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

/** A session last measured on the large model at well over the small model's window. */
async function switchedSession(
    sessionId: string,
    publishing: number,
    options: { hostAddedTokens?: number } = {},
) {
    writeOpenCodeDb(sessionId);
    const db = openDatabase();
    const live = new Map([[sessionId, LARGE]]);
    let refused = 0;
    const notices: string[] = [];
    const transform = newTransform({
        db,
        live,
        onRefuse: () => refused++,
        notices,
        hostAddedTokens: options.hostAddedTokens,
    });
    // An earlier turn on the large model, measured by the provider.
    await transform({}, { messages: hostMessages(sessionId, LARGE) } as never);
    updateSessionMeta(db, sessionId, {
        lastContextPercentage: 3.5,
        lastInputTokens: 35_000,
        lastObservedModelKey: LARGE_KEY,
        lastUsageContextLimit: 968_000,
    });
    const historian = stubHistorian(db, publishing);
    // The person switches to the small model and sends the next prompt.
    live.set(sessionId, SMALL);
    const output = { messages: hostMessages(sessionId, SMALL) };
    try {
        const lines = await passLogs(sessionId, () => transform({}, output as never));
        return {
            db,
            lines,
            output,
            refused: () => refused,
            notices,
            historianRuns: historian.runs(),
        };
    } finally {
        historian.spy.mockRestore();
    }
}

const recoveryLine = (db: ReturnType<typeof openDatabase>, sessionId: string) =>
    Math.floor(
        (resolveContextWindowGeometry(SMALL.providerID, SMALL.modelID, {
            db,
            sessionID: sessionId,
        })!.usableHard *
            95) /
            100,
    );

describe("OpenCode 1: recovery never sends a request over the window (issue 889)", () => {
    it("summarizes chunk after chunk within the switching turn and sends a request that fits", async () => {
        const sessionId = "ses-889-oc1-chain";
        const pass = await switchedSession(sessionId, TURNS);
        const log = pass.lines.join("\n");
        expect(log).toContain("arming overflow recovery proactively for the shrinking switch");
        expect(log).toMatch(
            /recovery chain done: the request is about \d+ tokens, under the 95% line/,
        );
        // More than one historian run in the one turn, and nothing refused.
        expect(pass.historianRuns).toBeGreaterThan(1);
        expect(pass.refused()).toBe(0);
        expect(pass.notices).toEqual([]);
        expect(log).not.toContain("EMERGENCY: fail-closed");
        // The request fits, so this pass ends recovery.
        expect(log).toMatch(/recovery request admitted: about \d+ tokens/);
        expect(getOverflowState(pass.db, sessionId).needsEmergencyRecovery).toBe(false);
        const served = estimateFinalWireInputTokens({
            messages: pass.output.messages as never,
            systemPromptTokens: 0,
            providerID: SMALL.providerID,
            modelID: SMALL.modelID,
            sessionId,
        });
        expect(served.pressureTokens).toBeLessThanOrEqual(recoveryLine(pass.db, sessionId));
    });

    it("counts the text an OpenCode 2 host adds after the transform", async () => {
        const sessionId = "ses-889-oc1-host-text";
        // The host's checkpoint text alone is larger than the small window, so
        // no amount of summarizing makes the request fit.
        const pass = await switchedSession(sessionId, TURNS, { hostAddedTokens: 30_000 });
        const log = pass.lines.join("\n");
        expect(log).toContain("arming overflow recovery proactively for the shrinking switch");
        // The chain counts it too, so it keeps summarizing past the point where
        // the request alone would fit.
        expect(log).not.toContain("recovery chain done");
        expect(pass.refused()).toBe(1);
        const counted = Number(
            log.match(/recovery request still over the window: about (\d+) tokens/)?.[1],
        );
        expect(counted).toBeGreaterThanOrEqual(30_000);
        expect(getOverflowState(pass.db, sessionId).needsEmergencyRecovery).toBe(true);
    });

    it("refuses a model-shrink pass whose partial fold still leaves the request over the window", async () => {
        const sessionId = "ses-889-oc1-shrink-refuse";
        // One run publishes, the next makes no progress.
        const pass = await switchedSession(sessionId, 1);
        const log = pass.lines.join("\n");
        expect(log).toContain("arming overflow recovery proactively for the shrinking switch");
        expect(log).toContain("recovery chain stops: the last historian run published nothing");
        expect(getCompartments(pass.db, sessionId)).toHaveLength(1);
        expect(pass.refused()).toBe(1);
        expect(log).toMatch(
            /EMERGENCY: fail-closed \(reason=recovery-request-over-limit, recoveryOrigin=proactive_model_shrink/,
        );
        expect(pass.notices).toEqual([RECOVERY_NOTICE]);
        // The publication leaves the latch armed, and so does the refusal, so
        // the next turn continues recovery.
        const overflow = getOverflowState(pass.db, sessionId);
        expect(overflow.needsEmergencyRecovery).toBe(true);
        expect(overflow.emergencyRecoveryOrigin).toBe("proactive_model_shrink");
        expect(overflow.detectedContextLimit).toBe(0);
    });

    it("refuses a provider-overflow pass whose partial history refresh still leaves the request over the window", async () => {
        const sessionId = "ses-889-oc1-overflow-refuse";
        writeOpenCodeDb(sessionId);
        const db = openDatabase();
        // The first turn was already summarized and rendered into the head.
        appendCompartments(db, sessionId, [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 2,
                startMessageId: "u0",
                endMessageId: "a0",
                title: "Turn 1",
                content: "Reviewed the earlier records.",
            },
        ]);
        const live = new Map([[sessionId, SMALL]]);
        let refused = 0;
        const notices: string[] = [];
        const transform = newTransform({ db, live, onRefuse: () => refused++, notices });
        await transform({}, { messages: hostMessages(sessionId, SMALL) } as never);
        expect(refused).toBe(0);
        // The provider rejected the next request as too long.
        recordOverflowDetected(db, sessionId, undefined, SMALL_KEY, "provider_overflow");
        const historian = stubHistorian(db, 1);
        let lines: string[];
        try {
            lines = await passLogs(sessionId, () =>
                transform({}, { messages: hostMessages(sessionId, SMALL) } as never),
            );
        } finally {
            historian.spy.mockRestore();
        }
        const log = lines.join("\n");
        expect(getCompartments(db, sessionId)).toHaveLength(2);
        expect(refused).toBe(1);
        // Not the no-fold refusal: the pass refreshed its history, and the
        // request it would send is still over the window.
        expect(log).toMatch(
            /EMERGENCY: fail-closed \(reason=recovery-request-over-limit, recoveryOrigin=provider_overflow/,
        );
        expect(notices).toEqual([RECOVERY_NOTICE]);
        const overflow = getOverflowState(db, sessionId);
        expect(overflow.needsEmergencyRecovery).toBe(true);
        expect(overflow.emergencyRecoveryOrigin).toBe("provider_overflow");
    });
});
