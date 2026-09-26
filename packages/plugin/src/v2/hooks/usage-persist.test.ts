/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    openDatabase,
} from "../../features/magic-context/storage";
import { resolveContextLimit } from "../../hooks/magic-context/event-resolvers";
import type { TransformDeps } from "../../hooks/magic-context/transform";
import { ABSOLUTE_EMERGENCY_PERCENTAGE } from "../../shared/escalation-bands";
import { clearModelsDevCache, refreshModelLimitsFromApi } from "../../shared/models-dev-cache";
import { clearWindowOverlayCacheForTest, setWindowOverlayPath } from "../../shared/window-geometry";
import { persistV2UsageReading } from "./usage-persist";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    closeDatabase();
    clearModelsDevCache();
    setWindowOverlayPath(undefined);
    clearWindowOverlayCacheForTest();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
});

function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

// A model whose window is configured at 272K, both in the catalog and in a
// measured overlay cell (the strongest wall the resolver knows).
async function configure272kWindow(): Promise<void> {
    const overlayPath = join(makeTempDir("v2-usage-overlay-"), "window-overlay.json");
    writeFileSync(
        overlayPath,
        JSON.stringify({
            schema: "fusiform-window-overlay/v1",
            generated_at: "2026-09-11T00:00:00Z",
            minted_provider_ids: [],
            cells: [
                {
                    provider_id: "test-provider",
                    model_id: "test-model",
                    facts: {
                        "window.enforced": {
                            value: { kind: "stated", value: 272_000 },
                            grade: "measured",
                            units: "provider",
                            boundary: "Observed",
                            source_ref: "usage persist fixture",
                            observed_at: "2026-09-11T00:00:00Z",
                        },
                    },
                },
            ],
        }),
    );
    setWindowOverlayPath(overlayPath);
    await refreshModelLimitsFromApi({
        config: {
            providers: async () => ({
                data: {
                    providers: [
                        {
                            id: "test-provider",
                            models: {
                                "test-model": { limit: { context: 272_000, output: 128_000 } },
                            },
                        },
                    ],
                },
            }),
        },
    });
}

describe("persistV2UsageReading", () => {
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
    it("moves last_response_time only for a reading with provider tokens", () => {
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
});
