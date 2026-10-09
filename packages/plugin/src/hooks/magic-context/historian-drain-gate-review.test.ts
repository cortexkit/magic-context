import { afterEach, beforeEach, expect, it, mock, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import {
    getOrCreateSessionMeta,
    getPendingOps,
    getTagsBySession,
    insertTag,
    queuePendingOp,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    DRAIN_WINDOW_MS,
    loadProtectedTailMeta,
    reserveProtectedTailDrainTokens,
} from "../../features/magic-context/storage-meta-persisted";
import { createTagger } from "../../features/magic-context/tagger";
import type { ContextUsage } from "../../features/magic-context/types";
import type { PluginContext } from "../../plugin/types";
import { Database } from "../../shared/sqlite";
import * as compartmentRunner from "./compartment-runner";
import {
    getActiveCompartmentRun,
    registerActiveCompartmentRun,
    startCompartmentAgent,
} from "./compartment-runner";
import { checkCompartmentTrigger } from "./compartment-trigger";
import { deriveProtectedTailTokenTarget, selectPerRunCap } from "./protected-tail-boundary";
import { setRawMessageProvider } from "./read-session-chunk";
import { createTransform } from "./transform";

let db: Database;
const unregister: Array<() => void> = [];
beforeEach(() => {
    db = new Database(":memory:");
    initializeDatabase(db);
});
afterEach(() => {
    for (const remove of unregister.splice(0)) remove();
    db.close();
});

function history(sessionId: string) {
    const raw = Array.from({ length: 17 }, (_, i) => ({
        id: `m${i + 1}`,
        ordinal: i + 1,
        role: i % 2 ? "assistant" : "user",
        parts: [{ type: "text" as const, text: i < 12 ? "history ".repeat(3500) : "protected" }],
    }));
    unregister.push(setRawMessageProvider(sessionId, { readMessages: () => raw }));
    getOrCreateSessionMeta(db, sessionId);
    for (let i = 0; i < 12; i++) insertTag(db, sessionId, `m${i + 1}`, "message", 3500, i + 1);
    return raw;
}

function triggerAndReserve(sessionId: string, percentage: number) {
    const usage = { percentage, inputTokens: percentage * 2000 };
    const fired = checkCompartmentTrigger(
        db,
        sessionId,
        getOrCreateSessionMeta(db, sessionId),
        usage,
        percentage,
        80,
        1000,
        undefined,
        undefined,
        undefined,
        200_000,
    ).shouldFire;
    if (!fired) return { fired, ok: false, bypass: false };
    const target = deriveProtectedTailTokenTarget({
        contextLimit: 200_000,
        executeThresholdPercentage: 80,
        usagePercentage: percentage,
    });
    const result = reserveProtectedTailDrainTokens({
        db,
        sessionId,
        runId: `${sessionId}-${percentage}`,
        trueRawTokens: 100,
        usagePercentage: percentage,
        usable: target.usable,
        perRunCap: selectPerRunCap({
            N: target.N,
            usagePercentage: percentage,
            contextLimit: 200_000,
            executeThresholdPercentage: 80,
        }),
        executeThresholdPercentage: 80,
    });
    return { fired, ok: result.ok, bypass: result.overQuotaBypass };
}

function spend(sessionId: string, latch = 0) {
    db.prepare(
        "UPDATE session_meta SET protected_tail_drain_window_started_at = ?, protected_tail_drain_tokens = 500000, emergency_drain_active = ? WHERE session_id = ?",
    ).run(Date.now(), latch, sessionId);
}

it("review regression: a skipped low-pressure pass must end emergency catch-up before pressure rises below force", () => {
    const sessionId = "review-latch-exit";
    history(sessionId);
    spend(sessionId, Date.now() - 1000);
    // With an 80% execute threshold, usage below 70% ends emergency catch-up.
    // A rise to 78% must not bypass the quota; only reaching 85% rearms catch-up.
    expect(triggerAndReserve(sessionId, 69).ok).toBe(false);
    const rising = triggerAndReserve(sessionId, 78);
    expect(rising.ok).toBe(false);
    expect(loadProtectedTailMeta(db, sessionId).emergencyDrainActive).toBe(0);
});

it("review comparison: emergency 85 and 95 remain admitted with a spent budget on both sides of reset", () => {
    for (const percentage of [85, 95]) {
        const sessionId = `review-emergency-${percentage}`;
        history(sessionId);
        spend(sessionId);
        const before = triggerAndReserve(sessionId, percentage);
        expect(before).toEqual({ fired: true, ok: true, bypass: true });
        db.prepare(
            "UPDATE session_meta SET protected_tail_drain_window_started_at = ? WHERE session_id = ?",
        ).run(Date.now() - DRAIN_WINDOW_MS, sessionId);
        const after = triggerAndReserve(sessionId, percentage);
        expect(after).toEqual({ fired: true, ok: true, bypass: false });
    }
});

it("review comparison: immediate repeated starts register one run and eventually execute it", async () => {
    const sessionId = "review-double-start";
    history(sessionId);
    updateSessionMeta(db, sessionId, { compartmentInProgress: true });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    const run = mock(async (deps: Parameters<typeof compartmentRunner.runCompartmentAgent>[0]) => {
        deps.onHistorianRunStarted?.();
        await held;
        updateSessionMeta(db, sessionId, { compartmentInProgress: false });
    });
    const deps = { db, sessionId, historianChunkTokens: 20_000, directory: "/tmp" };
    startCompartmentAgent(deps, run);
    const active = getActiveCompartmentRun(sessionId);
    try {
        expect(active).toBeDefined();
        startCompartmentAgent(deps, run);
        expect(getActiveCompartmentRun(sessionId)).toBe(active);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(run).toHaveBeenCalledTimes(1);
    } finally {
        release();
        await active?.promise;
    }
    expect(getActiveCompartmentRun(sessionId)).toBeUndefined();
    expect(getOrCreateSessionMeta(db, sessionId).compartmentInProgress).toBe(false);
});

it("review startup: boundary preparation errors clear intent, registry and lease", async () => {
    const sessionId = "review-startup-error";
    history(sessionId);
    updateSessionMeta(db, sessionId, { compartmentInProgress: true });
    const run = mock(async () => {});
    startCompartmentAgent(
        { db, sessionId, historianChunkTokens: 20_000, directory: "/tmp" },
        run,
        () => {
            throw new Error("review boundary read failed");
        },
    );
    await getActiveCompartmentRun(sessionId)?.promise;
    expect(run).not.toHaveBeenCalled();
    expect(getActiveCompartmentRun(sessionId)).toBeUndefined();
    expect(getOrCreateSessionMeta(db, sessionId).compartmentInProgress).toBe(false);
    expect(
        db
            .prepare("SELECT holder_id FROM compartment_state_lease WHERE session_id = ?")
            .get(sessionId),
    ).toBeNull();
});

for (const lane of ["defer", "flush", "fold", "force"] as const) {
    // An explicit flush is a deliberate user action and the exception to the historian hold.
    const name =
        lane === "flush"
            ? "review contract: OpenCode explicit flush drains drops during a registered historian"
            : lane === "defer"
              ? "review contract: OpenCode automatic defer holds drops during a registered historian"
              : `review mutation contract: OpenCode ${lane} pass during a registered historian`;
    it(name, async () => {
        const sessionId = `review-wire-${lane}`;
        getOrCreateSessionMeta(db, sessionId);
        const materialize = new Set<string>();
        const models = new Map([
            [sessionId, { providerID: "anthropic", modelID: "claude-sonnet-4-6" }],
        ]);
        const pressure = new Map<string, { usage: ContextUsage; updatedAt: number }>([
            [sessionId, { usage: { percentage: 20, inputTokens: 40_000 }, updatedAt: Date.now() }],
        ]);
        const transform = createTransform({
            db,
            tagger: createTagger(),
            scheduler: { shouldExecute: () => "defer" },
            contextUsageMap: pressure,
            liveModelBySession: models,
            historyRefreshSessions: new Set(),
            pendingMaterializationSessions: materialize,
            lastHeuristicsTurnId: new Map(),
            protectedTokens: 0,
            directory: "/tmp",
            projectPath: "review-project",
            injectDocs: false,
        });
        const raw = [
            {
                info: { id: "u1", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "old user instruction" }],
            },
            {
                info: { id: "a1", role: "assistant", sessionID: sessionId },
                parts: [{ type: "text", text: "old answer" }],
            },
            {
                info: { id: "u2", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "current instruction" }],
            },
        ];
        const pass = async () => {
            const messages = structuredClone(raw);
            await transform({}, { messages });
            return JSON.stringify(messages);
        };
        const baseline = await pass();
        const old = getTagsBySession(db, sessionId).find((tag) => tag.tagNumber === 1);
        if (!old) throw new Error("Expected the old instruction to have tag 1");
        queuePendingOp(db, sessionId, old.tagNumber, "drop");
        expect(getPendingOps(db, sessionId)).toHaveLength(1);
        let release!: () => void;
        const active = registerActiveCompartmentRun(
            sessionId,
            new Promise<void>((resolve) => {
                release = resolve;
            }),
            "incremental",
        );
        updateSessionMeta(db, sessionId, { compartmentInProgress: true });
        if (lane === "flush") materialize.add(sessionId);
        if (lane === "fold")
            models.set(sessionId, { providerID: "anthropic", modelID: "claude-opus-4-6" });
        if (lane === "force")
            pressure.set(sessionId, {
                usage: { percentage: 85, inputTokens: 170_000 },
                updatedAt: Date.now(),
            });
        try {
            const served = await pass();
            expect(
                db
                    .prepare(
                        "SELECT cached_m0_model_key AS model FROM session_meta WHERE session_id = ?",
                    )
                    .get(sessionId),
            ).toEqual({
                model:
                    lane === "fold" ? "anthropic/claude-opus-4-6" : "anthropic/claude-sonnet-4-6",
            });
            const pending = getPendingOps(db, sessionId).length;
            console.log(
                `REVIEW_WIRE ${JSON.stringify({ lane, active: getActiveCompartmentRun(sessionId) === active, inProgress: getOrCreateSessionMeta(db, sessionId).compartmentInProgress, pending, sameBytes: served === baseline, digest: createHash("sha256").update(served).digest("hex") })}`,
            );
            expect(getActiveCompartmentRun(sessionId)).toBe(active);
            if (lane === "flush" || lane === "fold" || lane === "force") {
                expect(pending).toBe(0);
                expect(served).not.toBe(baseline);
            } else {
                expect(pending).toBe(1);
                expect(served).toBe(baseline);
            }
        } finally {
            release();
            await active.promise;
        }
    });
}

it("review comparison: OpenCode firing and immediately following defer pass keep one pending run and identical served bytes", async () => {
    const sessionId = "review-opencode-firing";
    const source = history(sessionId);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    const run = mock(async (deps: Parameters<typeof compartmentRunner.runCompartmentAgent>[0]) => {
        deps.onHistorianRunStarted?.();
        await held;
        updateSessionMeta(db, sessionId, { compartmentInProgress: false });
    });
    const original = compartmentRunner.startCompartmentAgent;
    const start = spyOn(compartmentRunner, "startCompartmentAgent").mockImplementation(
        (deps, _runAgent, prepareBoundary) => {
            original(deps, run, prepareBoundary);
        },
    );
    try {
        const transform = createTransform({
            db,
            tagger: createTagger(),
            scheduler: { shouldExecute: () => "defer" },
            contextUsageMap: new Map([
                [
                    sessionId,
                    { usage: { percentage: 25, inputTokens: 50_000 }, updatedAt: Date.now() },
                ],
            ]),
            historyRefreshSessions: new Set(),
            pendingMaterializationSessions: new Set(),
            lastHeuristicsTurnId: new Map(),
            protectedTokens: 0,
            client: {
                session: { get: mock(async () => ({ data: { directory: "/tmp" } })) },
            } as unknown as PluginContext["client"],
            directory: "/tmp",
        });
        const pass = async () => {
            const messages = source.map((message) => ({
                info: { id: message.id, role: message.role, sessionID: sessionId },
                parts: structuredClone(message.parts),
            }));
            await transform({}, { messages });
            return JSON.stringify(messages);
        };
        const first = await pass();
        const active = getActiveCompartmentRun(sessionId);
        expect(active).toBeDefined();
        expect(getOrCreateSessionMeta(db, sessionId).compartmentInProgress).toBe(true);
        const second = await pass();
        expect(getActiveCompartmentRun(sessionId)).toBe(active);
        expect(getOrCreateSessionMeta(db, sessionId).compartmentInProgress).toBe(true);
        expect(second).toBe(first);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(run).toHaveBeenCalledTimes(1);
        console.log(
            `REVIEW_OPENCODE_FIRING ${JSON.stringify({ starts: run.mock.calls.length, sameBytes: first === second, inProgress: true, digest: createHash("sha256").update(first).digest("hex") })}`,
        );
    } finally {
        release();
        await getActiveCompartmentRun(sessionId)?.promise;
        start.mockRestore();
    }
});

it("review comparison: empty-tail stale intent eventually clears without a lost startup", async () => {
    const sessionId = "review-empty-intent";
    getOrCreateSessionMeta(db, sessionId);
    unregister.push(setRawMessageProvider(sessionId, { readMessages: () => [] }));
    updateSessionMeta(db, sessionId, { compartmentInProgress: true });
    const { runCompartmentPhase } = await import("./transform-compartment-phase");
    const phase = () =>
        runCompartmentPhase({
            db,
            sessionId,
            resolvedSessionId: sessionId,
            canRunCompartments: true,
            fullFeatureMode: true,
            sessionMeta: getOrCreateSessionMeta(db, sessionId),
            contextUsage: { percentage: 25 },
            boundaryContextLimit: 200_000,
            boundaryExecuteThresholdPercentage: 65,
            boundaryUsage: { percentage: 25, inputTokens: 50_000 },
            boundaryUsageSource: "live",
            historianChunkTokens: 20_000,
            compartmentDirectory: "/tmp",
            messages: [],
            pendingCompartmentInjection: null,
            deferredHistoryRefreshSessions: new Set(),
            client: {} as PluginContext["client"],
        });
    const first = await phase();
    const next = await phase();
    const active = getActiveCompartmentRun(sessionId);
    console.log(
        `REVIEW_EMPTY_INTENT ${JSON.stringify({ first: first.compartmentInProgress, next: next.compartmentInProgress, active: active !== undefined })}`,
    );
    await active?.promise;
    expect(getActiveCompartmentRun(sessionId)).toBeUndefined();
    expect(getOrCreateSessionMeta(db, sessionId).compartmentInProgress).toBe(false);
});

it("review comparison: budget admission changes only spent-budget no-ops across reset and failure backoff", () => {
    const now = Date.now();
    const cases = [
        { usage: 25, start: now, latch: 0, failure: 0, ok: false },
        { usage: 78, start: now, latch: 0, failure: 0, ok: false },
        { usage: 78, start: now - DRAIN_WINDOW_MS + 5000, latch: 0, failure: 0, ok: false },
        { usage: 78, start: now - DRAIN_WINDOW_MS, latch: 0, failure: 0, ok: true },
        { usage: 78, start: now + 60_000, latch: 0, failure: 0, ok: true },
        { usage: 78, start: now, latch: now - 1000, failure: 0, ok: true },
        { usage: 85, start: now, latch: 0, failure: now - 1, ok: false },
        { usage: 95, start: now, latch: 0, failure: now - 1, ok: false },
        { usage: 95, start: now, latch: 0, failure: now - 60_000, ok: true },
        { usage: 95, start: now, latch: 0, failure: now + 60_000, ok: true },
    ];
    for (const [i, c] of cases.entries()) {
        const sessionId = `review-admission-${i}`;
        history(sessionId);
        db.prepare(
            "UPDATE session_meta SET protected_tail_drain_window_started_at = ?, protected_tail_drain_tokens = 500000, emergency_drain_active = ?, historian_drain_failure_at = ? WHERE session_id = ?",
        ).run(c.start, c.latch, c.failure, sessionId);
        const result = triggerAndReserve(sessionId, c.usage);
        expect(result.ok).toBe(c.ok);
        console.log(
            `REVIEW_ADMISSION ${JSON.stringify({ usage: c.usage, reset: now - c.start >= DRAIN_WINDOW_MS, latch: c.latch > 0, recentFailure: c.failure > 0 && c.failure <= now && now - c.failure < 60_000, ...result })}`,
        );
    }
});
