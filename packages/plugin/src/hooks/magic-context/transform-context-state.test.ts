/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    openDatabase,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import type { ContextUsage } from "../../features/magic-context/types";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { computeHardCacheExpired } from "./transform";
import {
    contextUsagePassSnapshot,
    loadContextUsage,
    resolveUnknownUsageFromWireEstimate,
    savedProviderReadingForPass,
    usagePredatesHistoryChange,
} from "./transform-context-state";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;

    for (const dir of tempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* Ignore EBUSY on Windows */
        }
    }
    tempDirs.length = 0;
});

function useTempDataHome(prefix: string): void {
    const dir = createTestTempDirFromPath(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

function createUsageMap() {
    return new Map<string, { usage: ContextUsage; updatedAt: number; lastResponseTime?: number }>();
}

describe("resolveUnknownUsageFromWireEstimate", () => {
    it("uses an untrusted wire estimate for a priced overflow-recovery pass", () => {
        expect(
            resolveUnknownUsageFromWireEstimate({
                usage: { percentage: 95, inputTokens: 0 },
                pricedPass: true,
                wireEstimateTokens: 1_087_566,
                usableHardLimit: 1_048_576,
            }),
        ).toEqual({ percentage: (1_087_566 / 1_048_576) * 100, inputTokens: 1_087_566 });
    });

    it("prefers provider-proven overflow mass when the local wire estimate is untrusted", () => {
        expect(
            resolveUnknownUsageFromWireEstimate({
                usage: { percentage: 95, inputTokens: 0 },
                pricedPass: true,
                wireEstimateTokens: 285_478,
                wireEstimateTrusted: false,
                providerProvenInputTokens: 1_091_002,
                providerProvenLimitTokens: 1_048_576,
                usableHardLimit: 1_048_576,
            }),
        ).toEqual({ percentage: (1_091_002 / 1_048_576) * 100, inputTokens: 1_091_002 });
    });

    it("does not replace a provider usage sample or estimate an unpriced pass", () => {
        expect(
            resolveUnknownUsageFromWireEstimate({
                usage: { percentage: 50, inputTokens: 500_000 },
                pricedPass: true,
                wireEstimateTokens: 1_087_566,
                usableHardLimit: 1_048_576,
            }),
        ).toEqual({ percentage: 50, inputTokens: 500_000 });
        expect(
            resolveUnknownUsageFromWireEstimate({
                usage: { percentage: 0, inputTokens: 0 },
                pricedPass: false,
                wireEstimateTokens: 1_087_566,
                usableHardLimit: 1_048_576,
            }),
        ).toEqual({ percentage: 0, inputTokens: 0 });
    });
});

describe("savedProviderReadingForPass", () => {
    const persisted = {
        usage: { percentage: 59.9, inputTokens: 55_000 },
        updatedAt: 1_000,
        lastObservedModelKey: "mock/model-a",
        lastUsageContextLimit: 91_808,
    };
    const qualifying = {
        persisted,
        currentModelKey: "mock/model-a",
        contextLimit: 91_808,
        lastResponseTime: 1_000,
        cacheExpired: false,
    };

    it("returns the saved reading for the same model and limit inside the cache window", () => {
        expect(savedProviderReadingForPass(qualifying)).toEqual({
            percentage: 59.9,
            inputTokens: 55_000,
        });
    });

    it("refuses a reading for another model, another or unknown limit, or an expired cache", () => {
        expect(
            savedProviderReadingForPass({ ...qualifying, currentModelKey: "mock/model-b" }),
        ).toBeNull();
        expect(
            savedProviderReadingForPass({ ...qualifying, currentModelKey: undefined }),
        ).toBeNull();
        expect(
            savedProviderReadingForPass({
                ...qualifying,
                persisted: { ...persisted, lastObservedModelKey: null },
            }),
        ).toBeNull();
        expect(savedProviderReadingForPass({ ...qualifying, contextLimit: 200_000 })).toBeNull();
        expect(savedProviderReadingForPass({ ...qualifying, contextLimit: undefined })).toBeNull();
        expect(
            savedProviderReadingForPass({
                ...qualifying,
                persisted: { ...persisted, lastUsageContextLimit: 0 },
            }),
        ).toBeNull();
        expect(savedProviderReadingForPass({ ...qualifying, cacheExpired: true })).toBeNull();
        expect(savedProviderReadingForPass({ ...qualifying, lastResponseTime: 0 })).toBeNull();
    });

    it("refuses an empty reading", () => {
        expect(savedProviderReadingForPass({ ...qualifying, persisted: null })).toBeNull();
        expect(
            savedProviderReadingForPass({
                ...qualifying,
                persisted: { ...persisted, usage: { percentage: 59.9, inputTokens: 0 } },
            }),
        ).toBeNull();
    });
});

describe("loadContextUsage", () => {
    it("trusts the event-updated live map and reloads when that signal changes", () => {
        useTempDataHome("context-usage-live-signal-");
        const db = openDatabase();
        let prepared = 0;
        const spiedDb = new Proxy(db, {
            get(target, prop, receiver) {
                if (prop !== "prepare") return Reflect.get(target, prop, receiver);
                return (sql: string) => {
                    prepared += 1;
                    return target.prepare.call(target, sql);
                };
            },
        }) as typeof db;
        const contextUsageMap = new Map([
            [
                "ses-live",
                {
                    usage: { percentage: 10, inputTokens: 10_000 },
                    updatedAt: 1_000,
                    lastResponseTime: 1_000,
                    hasUsageTokens: true,
                },
            ],
        ]);

        expect(loadContextUsage(contextUsageMap, spiedDb, "ses-live")).toEqual({
            percentage: 10,
            inputTokens: 10_000,
        });
        contextUsageMap.set("ses-live", {
            usage: { percentage: 20, inputTokens: 20_000 },
            updatedAt: 2_000,
            lastResponseTime: 2_000,
            hasUsageTokens: true,
        });
        expect(loadContextUsage(contextUsageMap, spiedDb, "ses-live")).toEqual({
            percentage: 20,
            inputTokens: 20_000,
        });
        expect(prepared).toBe(0);
    });

    it("uses a pass-owned session metadata snapshot without a scalar re-read", () => {
        useTempDataHome("context-usage-pass-snapshot-");
        const db = openDatabase();
        updateSessionMeta(db, "ses-pass-snapshot", {
            lastResponseTime: 3_000,
            lastContextPercentage: 30,
            lastInputTokens: 30_000,
        });
        const sessionMeta = getOrCreateSessionMeta(db, "ses-pass-snapshot");
        let prepared = 0;
        const spiedDb = new Proxy(db, {
            get(target, prop, receiver) {
                if (prop !== "prepare") return Reflect.get(target, prop, receiver);
                return (sql: string) => {
                    prepared += 1;
                    return target.prepare.call(target, sql);
                };
            },
        }) as typeof db;

        expect(
            loadContextUsage(
                createUsageMap(),
                spiedDb,
                "ses-pass-snapshot",
                contextUsagePassSnapshot(sessionMeta),
            ),
        ).toEqual({ percentage: 30, inputTokens: 30_000 });
        expect(prepared).toBe(0);
    });

    it("loads persisted usage into an empty cache", () => {
        useTempDataHome("context-usage-load-");
        const db = openDatabase();
        updateSessionMeta(db, "ses-load", {
            lastResponseTime: 1_000,
            lastContextPercentage: 42.5,
            lastInputTokens: 85_000,
        });

        const contextUsageMap = createUsageMap();
        const usage = loadContextUsage(contextUsageMap, db, "ses-load");

        expect(usage).toEqual({ percentage: 42.5, inputTokens: 85_000 });
        expect(contextUsageMap.get("ses-load")?.lastResponseTime).toBe(1_000);
    });

    it("refreshes cached usage when persisted last_response_time advances", () => {
        useTempDataHome("context-usage-refresh-");
        const db = openDatabase();
        updateSessionMeta(db, "ses-refresh", {
            lastResponseTime: 1_000,
            lastContextPercentage: 12.4,
            lastInputTokens: 12_400,
        });
        const contextUsageMap = createUsageMap();

        expect(loadContextUsage(contextUsageMap, db, "ses-refresh")).toEqual({
            percentage: 12.4,
            inputTokens: 12_400,
        });

        updateSessionMeta(db, "ses-refresh", {
            lastResponseTime: 2_000,
            lastContextPercentage: 126.7,
            lastInputTokens: 126_700,
        });

        expect(loadContextUsage(contextUsageMap, db, "ses-refresh")).toEqual({
            percentage: 126.7,
            inputTokens: 126_700,
        });
        expect(contextUsageMap.get("ses-refresh")?.lastResponseTime).toBe(2_000);
    });

    it("uses the cache when persisted last_response_time is unchanged", () => {
        useTempDataHome("context-usage-cache-hit-");
        const db = openDatabase();
        updateSessionMeta(db, "ses-cache", {
            lastResponseTime: 1_000,
            lastContextPercentage: 50,
            lastInputTokens: 50_000,
        });
        let fullUsageReads = 0;
        const spiedDb = new Proxy(db, {
            get(target, prop, receiver) {
                if (prop !== "prepare") return Reflect.get(target, prop, receiver);
                return (sql: string) => {
                    if (sql.includes("last_context_percentage")) fullUsageReads += 1;
                    return target.prepare.call(target, sql);
                };
            },
        }) as typeof db;
        const contextUsageMap = createUsageMap();

        expect(loadContextUsage(contextUsageMap, spiedDb, "ses-cache")).toEqual({
            percentage: 50,
            inputTokens: 50_000,
        });
        updateSessionMeta(db, "ses-cache", {
            lastContextPercentage: 99,
            lastInputTokens: 99_000,
        });

        expect(loadContextUsage(contextUsageMap, spiedDb, "ses-cache")).toEqual({
            percentage: 50,
            inputTokens: 50_000,
        });
        expect(fullUsageReads).toBe(1);
    });

    it("returns the default usage when no persisted row exists", () => {
        useTempDataHome("context-usage-default-");
        const db = openDatabase();
        const contextUsageMap = createUsageMap();

        expect(loadContextUsage(contextUsageMap, db, "ses-missing")).toEqual({
            percentage: 0,
            inputTokens: 0,
        });
        expect(contextUsageMap.has("ses-missing")).toBe(false);
    });
});

describe("computeHardCacheExpired", () => {
    it("returns false for 'never' even with a 10-day-old lastResponseTime", () => {
        const now = Date.now();
        const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;
        expect(computeHardCacheExpired("never", tenDaysAgo, now)).toBe(false);
        expect(computeHardCacheExpired("NEVER", tenDaysAgo, now)).toBe(false);
    });

    it("returns true when idle exceeds the TTL", () => {
        const now = Date.now();
        const tenMinutesAgo = now - 10 * 60 * 1000;
        expect(computeHardCacheExpired("5m", tenMinutesAgo, now)).toBe(true);
    });

    it("returns false when idle is within the TTL", () => {
        const now = Date.now();
        const oneMinuteAgo = now - 60 * 1000;
        expect(computeHardCacheExpired("5m", oneMinuteAgo, now)).toBe(false);
    });

    it("returns false when lastResponseTime is 0 (never responded)", () => {
        expect(computeHardCacheExpired("5m", 0, Date.now())).toBe(false);
    });

    it("falls back to 5m on invalid TTL", () => {
        const now = Date.now();
        const sixMinutesAgo = now - 6 * 60 * 1000;
        expect(computeHardCacheExpired("garbage", sixMinutesAgo, now)).toBe(true);
    });

    it("invokes onInvalid callback for invalid TTL but not for valid ones", () => {
        const now = Date.now();
        const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;
        const invalidErrors: unknown[] = [];

        // Invalid TTL: callback fires + 5m fallback applied
        const result = computeHardCacheExpired("bad-format", tenDaysAgo, now, (error) => {
            invalidErrors.push(error);
        });
        expect(invalidErrors.length).toBe(1);
        expect(invalidErrors[0]).toBeInstanceOf(Error);
        expect(result).toBe(true); // 5m fallback, 10-day-old → expired

        // Valid TTLs: callback NOT invoked
        const validErrors: unknown[] = [];
        computeHardCacheExpired("never", tenDaysAgo, now, (error) => {
            validErrors.push(error);
        });
        expect(validErrors.length).toBe(0);

        computeHardCacheExpired("5m", tenDaysAgo, now, (error) => {
            validErrors.push(error);
        });
        expect(validErrors.length).toBe(0);
    });

    it("omitting onInvalid is harmless (5m fallback still applies)", () => {
        const now = Date.now();
        const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;
        // No callback — should not throw, should still fall back to 5m
        expect(computeHardCacheExpired("bad-format", tenDaysAgo, now)).toBe(true);
        // "never" with no callback still works
        expect(computeHardCacheExpired("never", tenDaysAgo, now)).toBe(false);
    });
});

describe("computeHardCacheExpired finite boundary parity", () => {
    it("defers at exactly elapsed == ttl, matching the Rust scheduler's strict predicate", () => {
        const now = Date.now();
        const ttl = 5 * 60 * 1000;
        expect(computeHardCacheExpired("5m", now - ttl, now)).toBe(false);
        expect(computeHardCacheExpired("5m", now - ttl - 1, now)).toBe(true);
    });
});

it("invalidates pre-fold usage but retains a new provider reading and its older live timestamp", () => {
    useTempDataHome("usage-fold-");
    const db = openDatabase()!;
    const id = "usage-fold";
    const meta = {
        ...getOrCreateSessionMeta(db, id),
        lastResponseTime: 1000,
        cachedM0MaterializedAt: 2000,
    };
    expect(usagePredatesHistoryChange(db, id, meta)).toBe(true);
    expect(usagePredatesHistoryChange(db, id, { ...meta, lastResponseTime: 3000 })).toBe(false);
    // An error or usage-less completion can move the idle clock without replacing usage.
    expect(
        usagePredatesHistoryChange(
            db,
            id,
            { ...meta, lastResponseTime: 3000 },
            {
                usage: { percentage: 97, inputTokens: 97_000 },
                updatedAt: 1000,
                hasUsageTokens: true,
            },
        ),
    ).toBe(true);
    // A stored response can be ingested after the fold; its completion still predates it.
    expect(
        usagePredatesHistoryChange(db, id, meta, {
            usage: { percentage: 97, inputTokens: 97_000 },
            updatedAt: 3000,
            hasUsageTokens: true,
        }),
    ).toBe(true);
    expect(usagePredatesHistoryChange(db, id, { ...meta, lastResponseTime: 0 })).toBe(false);
});
