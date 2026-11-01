/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScheduler } from "../../features/magic-context/scheduler";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    openDatabase,
    recordOverflowDetected,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { resolveContextLimit } from "../../hooks/magic-context/event-resolvers";
import type { TransformDeps } from "../../hooks/magic-context/transform";
import {
    recordUsageRefusal,
    shouldResetRefusedUsage,
} from "../../hooks/magic-context/transform-context-state";
import { ABSOLUTE_EMERGENCY_PERCENTAGE } from "../../shared/escalation-bands";
import { clearModelsDevCache, refreshModelLimitsFromApi } from "../../shared/models-dev-cache";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { clearWindowGeometryLogForTest } from "../../shared/window-geometry";
import { persistV2UsageReading } from "./usage-persist";
import { resolveUsageReading } from "./usage-reading";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    closeDatabase();
    clearModelsDevCache();
    clearWindowGeometryLogForTest();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
});

function makeTempDir(prefix: string): string {
    const dir = createTestTempDirFromPath(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

// Catalog metadata provides the configured window for this test model.
async function configure272kWindow(): Promise<void> {
    await refreshModelLimitsFromApi({
        config: {
            providers: async () => ({
                data: {
                    providers: [
                        {
                            id: "test-provider",
                            models: {
                                "test-model": { limit: { context: 272_000, output: 32_000 } },
                            },
                        },
                    ],
                },
            }),
        },
    });
}

describe("persistV2UsageReading", () => {
    it("dates provider usage by completion when the store is read after a fold", () => {
        process.env.XDG_DATA_HOME = makeTempDir("v2-usage-age-");
        const db = openDatabase();
        const sessionID = "v2-usage-age";
        const contextUsageMap: TransformDeps["contextUsageMap"] = new Map();
        getOrCreateSessionMeta(db, sessionID);
        updateSessionMeta(db, sessionID, { cachedM0MaterializedAt: 2000 });
        const persist = (inputTokens: number, completed: number) =>
            persistV2UsageReading({
                db,
                sessionID,
                contextUsageMap,
                draftModel: { providerID: "test-provider", id: "test-model" },
                reading: {
                    inputTokens,
                    completed,
                    finish: "stop",
                    limit: 100_000,
                    admissionLimit: 100_000,
                    modelKey: "test-provider/test-model",
                },
            });
        const stale = () =>
            shouldResetRefusedUsage(
                db,
                sessionID,
                getOrCreateSessionMeta(db, sessionID),
                contextUsageMap.get(sessionID),
            );
        persist(97_000, 1000);
        expect(contextUsageMap.get(sessionID)?.updatedAt).toBe(1000);
        expect(stale()).toBe(false);
        recordUsageRefusal(db, sessionID, 1500);
        expect(stale()).toBe(true);
        persist(40_000, 3000);
        expect(contextUsageMap.get(sessionID)?.updatedAt).toBe(3000);
        expect(stale()).toBe(false);
        // A later completion without usage refreshes the idle clock, not the measurement.
        recordUsageRefusal(db, sessionID, 3200);
        updateSessionMeta(db, sessionID, { cachedM0MaterializedAt: 3500 });
        persist(0, 4000);
        expect(getOrCreateSessionMeta(db, sessionID).lastResponseTime).toBe(4000);
        expect(contextUsageMap.get(sessionID)?.updatedAt).toBe(3000);
        expect(stale()).toBe(true);
        persist(97_000, 5000);
        expect(stale()).toBe(false);
    });

    it("treats provider usage above the configured window as real pressure on every reading", async () => {
        process.env.XDG_DATA_HOME = makeTempDir("v2-usage-persist-");
        await configure272kWindow();
        const db = openDatabase();
        const sessionID = "ses-v2-above-window";
        const contextUsageMap: TransformDeps["contextUsageMap"] = new Map();
        const draftModel = { providerID: "test-provider", id: "test-model" };
        const persist = (inputTokens: number) =>
            persistV2UsageReading({
                db,
                sessionID,
                draftModel,
                reading: {
                    inputTokens,
                    limit: 240_000,
                    admissionLimit: 240_000,
                    modelKey: "test-provider/test-model",
                },
                contextUsageMap,
            });

        persist(147_839);
        expect(getOrCreateSessionMeta(db, sessionID).lastInputTokens).toBe(147_839);

        // The provider accepted a 300K request on a model configured at 272K:
        // that is the real prompt size, so it becomes the pressure reading.
        persist(300_000);
        let meta = getOrCreateSessionMeta(db, sessionID);
        expect(meta.lastInputTokens).toBe(300_000);
        expect(meta.lastContextPercentage).toBeGreaterThanOrEqual(ABSOLUTE_EMERGENCY_PERCENTAGE);
        expect(contextUsageMap.get(sessionID)?.usage.inputTokens).toBe(300_000);

        // Staying above the configured window keeps counting on every reading.
        persist(310_000);
        meta = getOrCreateSessionMeta(db, sessionID);
        expect(meta.lastInputTokens).toBe(310_000);
        expect(meta.lastContextPercentage).toBeGreaterThanOrEqual(ABSOLUTE_EMERGENCY_PERCENTAGE);
        expect(contextUsageMap.get(sessionID)?.usage.percentage).toBeGreaterThanOrEqual(
            ABSOLUTE_EMERGENCY_PERCENTAGE,
        );
    });

    // The numbers reported on issue 493: a 1,000,000-token model whose reply
    // reserve is capped at a quarter of the window (a 750,000-token usable window),
    // and a provider-accepted request of 962,842 tokens. That request fits the
    // model's own window, so it says nothing about the window being wrong; it is
    // pressure against the usable part and must not raise the usable limit.
    it("counts a reading past the usable window as pressure without widening that window", async () => {
        process.env.XDG_DATA_HOME = makeTempDir("v2-usage-persist-");
        await refreshModelLimitsFromApi({
            config: {
                providers: async () => ({
                    data: {
                        providers: [
                            {
                                id: "deepseek",
                                models: {
                                    "deepseek-flash": {
                                        limit: { context: 1_000_000, output: 384_000 },
                                    },
                                },
                            },
                        ],
                    },
                }),
            },
        });
        const db = openDatabase();
        const sessionID = "ses-v2-over-usable";
        const contextUsageMap: TransformDeps["contextUsageMap"] = new Map();
        const limit = resolveContextLimit("deepseek", "deepseek-flash", { db, sessionID });
        expect(limit).toBe(750_000);
        expect(
            resolveContextLimit("deepseek", "deepseek-flash", {
                db,
                sessionID,
                reservation: "none",
            }),
        ).toBe(1_000_000);

        for (let reading = 0; reading < 2; reading++) {
            persistV2UsageReading({
                db,
                sessionID,
                draftModel: { providerID: "deepseek", id: "deepseek-flash" },
                reading: {
                    inputTokens: 962_842,
                    limit,
                    admissionLimit: limit,
                    modelKey: "deepseek/deepseek-flash",
                },
                contextUsageMap,
            });
            // Every repeat of the reading reaches the transform as emergency-band
            // pressure, which is what runs the reclaim on the next pass.
            const percentage = contextUsageMap.get(sessionID)?.usage.percentage ?? 0;
            expect(percentage).toBeCloseTo(128.38, 1);
            expect(getOrCreateSessionMeta(db, sessionID).lastInputTokens).toBe(962_842);
        }
        expect(resolveContextLimit("deepseek", "deepseek-flash", { db, sessionID })).toBe(750_000);
    });

    // Issue 545. last_response_time is the idle clock the cache TTL is measured
    // from. A reply the provider refused (a spent quota) can be stored with zero
    // tokens and a completion time; it refreshed no cache, so it must not move
    // the clock, or the first pass after a long idle would defer queued drops.
    it("does not move last_response_time for an errored zero-token reading", () => {
        process.env.XDG_DATA_HOME = makeTempDir("v2-usage-persist-");
        const db = openDatabase();
        const sessionID = "ses-v2-idle-clock";
        const contextUsageMap: TransformDeps["contextUsageMap"] = new Map();
        const persist = (inputTokens: number, completed: number) =>
            persistV2UsageReading({
                db,
                sessionID,
                draftModel: { providerID: "test-provider", id: "test-model" },
                reading: {
                    inputTokens,
                    limit: 200_000,
                    admissionLimit: 200_000,
                    modelKey: "test-provider/test-model",
                    completed,
                    ...(inputTokens === 0 ? { finish: "error", error: { name: "APIError" } } : {}),
                },
                contextUsageMap,
            });

        persist(40_000, 1_000);
        expect(getOrCreateSessionMeta(db, sessionID).lastResponseTime).toBe(1_000);
        persist(0, 2_000);
        expect(getOrCreateSessionMeta(db, sessionID).lastResponseTime).toBe(1_000);
        persist(41_000, 3_000);
        expect(getOrCreateSessionMeta(db, sessionID).lastResponseTime).toBe(3_000);
    });

    it("expires once after switching to a completed provider with no usage, preserving measured pressure", () => {
        process.env.XDG_DATA_HOME = makeTempDir("v2-usage-less-completion-");
        const db = openDatabase();
        const sessionID = "ses-v2-no-usage-switch";
        const contextUsageMap: TransformDeps["contextUsageMap"] = new Map();
        const now = Date.now();
        const draftModel = { providerID: "test", id: "usage-less" };
        persistV2UsageReading({
            db,
            sessionID,
            draftModel,
            contextUsageMap,
            reading: {
                inputTokens: 1_000,
                limit: 100_000,
                admissionLimit: 100_000,
                modelKey: "test/old-model",
                completed: now - 2 * 3_600_000,
            },
        });
        updateSessionMeta(db, sessionID, { cacheTtl: "1h" });
        const scheduler = createScheduler({ executeThresholdPercentage: 90 });
        const usage = { inputTokens: 1_000, percentage: 1 };
        expect(scheduler.shouldExecute(getOrCreateSessionMeta(db, sessionID), usage, now)).toBe(
            "execute",
        );
        for (const error of [{ name: "MessageAbortedError" }, { name: "APIError" }]) {
            const reading = resolveUsageReading({
                draftModel,
                tokens: { input: 0 },
                completed: now,
                finish: "stop",
                error,
                limitFor: () => 100_000,
            })!;
            persistV2UsageReading({ db, sessionID, draftModel, contextUsageMap, reading });
        }
        expect(scheduler.shouldExecute(getOrCreateSessionMeta(db, sessionID), usage, now)).toBe(
            "execute",
        );
        const reading = resolveUsageReading({
            draftModel,
            completed: now,
            finish: "stop",
            limitFor: () => 0,
        });
        if (reading) persistV2UsageReading({ db, sessionID, draftModel, contextUsageMap, reading });
        expect(getOrCreateSessionMeta(db, sessionID).lastResponseTime).toBe(now);
        expect(getOrCreateSessionMeta(db, sessionID).lastInputTokens).toBe(1_000);
        expect(
            scheduler.shouldExecute(getOrCreateSessionMeta(db, sessionID), usage, now + 1_000),
        ).toBe("defer");
        persistV2UsageReading({
            db,
            sessionID,
            draftModel,
            contextUsageMap,
            reading: { ...reading!, completed: now + 2_000 },
        });
        expect(
            scheduler.shouldExecute(getOrCreateSessionMeta(db, sessionID), usage, now + 3_000),
        ).toBe("defer");
    });

    it("retains rejection-derived usage reading on a subsequent context pass with no new reply", () => {
        process.env.XDG_DATA_HOME = makeTempDir("v2-usage-persist-rejection-");
        const db = openDatabase();
        const sessionID = "ses_f026cf502ffegwOeLMe8Oaw5l3";
        const contextUsageMap: TransformDeps["contextUsageMap"] = new Map();
        const draftModel = { providerID: "google", id: "probe-model" };
        // Rejection pressure is distinct from the cache clock: only a served
        // response advances the clock, and the old reply must remain stale.
        const firstReplyCompleted = Date.now() - 60_000;

        // 1. Initial accepted assistant reading (seq 158 with 129,777 input tokens)
        persistV2UsageReading({
            db,
            sessionID,
            draftModel,
            reading: {
                inputTokens: 129_777,
                limit: 100_000,
                admissionLimit: 100_000,
                modelKey: "google/probe-model",
                completed: firstReplyCompleted,
            },
            contextUsageMap,
        });

        expect(getOrCreateSessionMeta(db, sessionID).lastInputTokens).toBe(129_777);
        expect(getOrCreateSessionMeta(db, sessionID).lastResponseTime).toBe(firstReplyCompleted);
        expect(contextUsageMap.get(sessionID)?.usage.inputTokens).toBe(129_777);

        // 2. Provider rejection records pressure without refreshing the cache clock.
        recordOverflowDetected(
            db,
            sessionID,
            100_000,
            "google/probe-model",
            "provider_overflow",
            "prompt_only",
            123_456,
        );
        contextUsageMap.set(sessionID, {
            usage: { inputTokens: 123_456, percentage: (123_456 / 100_000) * 100 },
            hasUsageTokens: true,
            updatedAt: Date.now(),
        });

        expect(getOrCreateSessionMeta(db, sessionID).lastInputTokens).toBe(123_456);
        expect(getOrCreateSessionMeta(db, sessionID).lastResponseTime).toBe(firstReplyCompleted);
        expect(contextUsageMap.get(sessionID)?.usage.inputTokens).toBe(123_456);

        // 3. Next context pass runs before any new reply exists; the newest accepted reply is still seq 158
        persistV2UsageReading({
            db,
            sessionID,
            draftModel,
            reading: {
                inputTokens: 129_777,
                limit: 100_000,
                admissionLimit: 100_000,
                modelKey: "google/probe-model",
                completed: firstReplyCompleted,
            },
            contextUsageMap,
        });

        // The rejection-derived reading must NOT be overwritten by the older reply
        expect(getOrCreateSessionMeta(db, sessionID).lastInputTokens).toBe(123_456);
        expect(contextUsageMap.get(sessionID)?.usage.inputTokens).toBe(123_456);

        // 4. A genuinely new accepted reply arrives (seq 169 with 10,458 input tokens)
        const newReplyCompleted = Date.now() + 60_000;
        persistV2UsageReading({
            db,
            sessionID,
            draftModel,
            reading: {
                inputTokens: 10_458,
                limit: 100_000,
                admissionLimit: 100_000,
                modelKey: "google/probe-model",
                completed: newReplyCompleted,
            },
            contextUsageMap,
        });

        // The new reply must update the reading
        expect(getOrCreateSessionMeta(db, sessionID).lastInputTokens).toBe(10_458);
        expect(getOrCreateSessionMeta(db, sessionID).lastResponseTime).toBe(newReplyCompleted);
        expect(contextUsageMap.get(sessionID)?.usage.inputTokens).toBe(10_458);

        // 5. Subsequent accepted reply (10,502 input tokens)
        persistV2UsageReading({
            db,
            sessionID,
            draftModel,
            reading: {
                inputTokens: 10_502,
                limit: 100_000,
                admissionLimit: 100_000,
                modelKey: "google/probe-model",
                completed: newReplyCompleted + 1_000,
            },
            contextUsageMap,
        });

        expect(getOrCreateSessionMeta(db, sessionID).lastInputTokens).toBe(10_502);
        expect(getOrCreateSessionMeta(db, sessionID).lastResponseTime).toBe(
            newReplyCompleted + 1_000,
        );
        expect(contextUsageMap.get(sessionID)?.usage.inputTokens).toBe(10_502);
    });
});
