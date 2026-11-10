/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
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
    firstPassExecuteReading,
    loadContextUsage,
    recordUsageRefusal,
    resolveUnknownUsageFromWireEstimate,
    savedProviderReadingForPass,
    shouldResetRefusedUsage,
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
                windowTokens: 1_048_576,
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
                windowTokens: 1_048_576,
            }),
        ).toEqual({ percentage: (1_091_002 / 1_048_576) * 100, inputTokens: 1_091_002 });
    });

    it("does not replace a provider usage sample or estimate an unpriced pass", () => {
        expect(
            resolveUnknownUsageFromWireEstimate({
                usage: { percentage: 50, inputTokens: 500_000 },
                pricedPass: true,
                wireEstimateTokens: 1_087_566,
                windowTokens: 1_048_576,
            }),
        ).toEqual({ percentage: 50, inputTokens: 500_000 });
        expect(
            resolveUnknownUsageFromWireEstimate({
                usage: { percentage: 0, inputTokens: 0 },
                pricedPass: false,
                wireEstimateTokens: 1_087_566,
                windowTokens: 1_048_576,
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
    };

    it("returns the saved reading for the same model and limit, however old the last response is", () => {
        expect(savedProviderReadingForPass(qualifying)).toEqual({
            percentage: 59.9,
            inputTokens: 55_000,
        });
        // A provider cache that expired three hours ago does not make the
        // reading stale: it still describes the last request this model was
        // sent, so a pass that rebuilds after a restart prices from it.
        expect(
            savedProviderReadingForPass({
                ...qualifying,
                lastResponseTime: Date.now() - 3 * 60 * 60 * 1000,
            }),
        ).toEqual({ percentage: 59.9, inputTokens: 55_000 });
    });

    it("refuses a reading for another model, another or unknown limit, or no served response", () => {
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

describe("firstPassExecuteReading", () => {
    const persisted = {
        usage: { percentage: 70.2, inputTokens: 64_450 },
        updatedAt: 1_000,
        lastObservedModelKey: "mock/model-a",
        lastUsageContextLimit: 91_808,
    };
    // A saved reading at or above the 65% threshold, for this model and limit,
    // on a pass whose own (cleared) reading is below it.
    const qualifying = {
        persisted,
        currentModelKey: "mock/model-a",
        contextLimit: 91_808,
        lastResponseTime: 1_000,
        executeThresholdPercentage: 65,
        passPercentage: 0,
    };

    it("returns a saved reading at or above the threshold for the same model and limit", () => {
        expect(firstPassExecuteReading(qualifying)).toEqual({
            percentage: 70.2,
            inputTokens: 64_450,
        });
        expect(
            firstPassExecuteReading({
                ...qualifying,
                persisted: { ...persisted, usage: { percentage: 65, inputTokens: 59_675 } },
            }),
        ).toEqual({ percentage: 65, inputTokens: 59_675 });
    });

    it("refuses a reading with no recorded provider reply", () => {
        expect(firstPassExecuteReading({ ...qualifying, lastResponseTime: 0 })).toBeNull();
    });

    it("refuses a reading whose saved model key is null", () => {
        expect(
            firstPassExecuteReading({
                ...qualifying,
                persisted: { ...persisted, lastObservedModelKey: null },
            }),
        ).toBeNull();
    });

    it("refuses a reading when the pass's context limit is unknown", () => {
        expect(firstPassExecuteReading({ ...qualifying, contextLimit: undefined })).toBeNull();
        // A zero limit never matches either, even against a zero saved limit.
        expect(
            firstPassExecuteReading({
                ...qualifying,
                contextLimit: 0,
                persisted: { ...persisted, lastUsageContextLimit: 0 },
            }),
        ).toBeNull();
    });

    it("refuses a reading with no input tokens", () => {
        expect(
            firstPassExecuteReading({
                ...qualifying,
                persisted: { ...persisted, usage: { percentage: 70.2, inputTokens: 0 } },
            }),
        ).toBeNull();
    });

    it("refuses a reading below the threshold, or when the pass already reaches it", () => {
        expect(
            firstPassExecuteReading({
                ...qualifying,
                persisted: { ...persisted, usage: { percentage: 64.9, inputTokens: 59_583 } },
            }),
        ).toBeNull();
        expect(firstPassExecuteReading({ ...qualifying, passPercentage: 65 })).toBeNull();
        expect(firstPassExecuteReading({ ...qualifying, persisted: null })).toBeNull();
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

it("keeps ordinary provider readings trusted after publications and folds", () => {
    useTempDataHome("usage-healthy-");
    const db = openDatabase()!;
    const id = "usage-healthy";
    const now = Date.now();
    const meta = {
        ...getOrCreateSessionMeta(db, id),
        lastResponseTime: now - 3000,
        cachedM0MaterializedAt: now - 2000,
    };
    expect(shouldResetRefusedUsage(db, id, meta)).toBe(false);
    appendCompartments(db, id, [
        {
            sequence: 0,
            startMessage: 1,
            endMessage: 2,
            startMessageId: "m1",
            endMessageId: "m2",
            title: "Published",
            content: "History published after the provider reading.",
        },
    ]);
    expect(shouldResetRefusedUsage(db, id, { ...meta, cachedM0MaterializedAt: null })).toBe(false);
    // A later refusal cannot retroactively turn that earlier publication into recovery.
    recordUsageRefusal(db, id);
    expect(shouldResetRefusedUsage(db, id, { ...meta, cachedM0MaterializedAt: null })).toBe(false);
});

it("requires reading then refusal then landed history, and retires the latch on a new reading", () => {
    useTempDataHome("usage-refused-");
    const db = openDatabase()!;
    const id = "usage-refused";
    const now = Date.now();
    const meta = {
        ...getOrCreateSessionMeta(db, id),
        lastResponseTime: now - 5000,
        cachedM0MaterializedAt: now - 4500,
    };
    recordUsageRefusal(db, id, now - 4000);
    expect(shouldResetRefusedUsage(db, id, meta)).toBe(false);
    expect(shouldResetRefusedUsage(db, id, { ...meta, cachedM0MaterializedAt: now + 60_000 })).toBe(
        false,
    );
    const recovered = { ...meta, cachedM0MaterializedAt: now - 3000 };
    expect(shouldResetRefusedUsage(db, id, recovered)).toBe(true);
    expect(shouldResetRefusedUsage(db, "other-session", recovered)).toBe(false);
    // A retry must not move the refusal boundary past a recovery fold.
    recordUsageRefusal(db, id, now - 2000);
    expect(shouldResetRefusedUsage(db, id, recovered)).toBe(true);
    const newReading = { ...recovered, lastResponseTime: now - 1000 };
    expect(shouldResetRefusedUsage(db, id, newReading)).toBe(false);
    expect(shouldResetRefusedUsage(db, id, { ...newReading, cachedM0MaterializedAt: now })).toBe(
        false,
    );
});

it("uses the live provider timestamp rather than an independently moving idle clock", () => {
    useTempDataHome("usage-live-refused-");
    const db = openDatabase()!;
    const id = "usage-live-refused";
    const now = Date.now();
    const meta = {
        ...getOrCreateSessionMeta(db, id),
        lastResponseTime: now - 5000,
        cachedM0MaterializedAt: now - 3000,
    };
    const live = {
        usage: { percentage: 97, inputTokens: 97_000 },
        updatedAt: now - 2000,
        hasUsageTokens: true,
    };
    recordUsageRefusal(db, id, now - 4000);
    expect(shouldResetRefusedUsage(db, id, meta, live)).toBe(false);
    recordUsageRefusal(db, id, now - 1000);
    expect(
        shouldResetRefusedUsage(
            db,
            id,
            { ...meta, lastResponseTime: now, cachedM0MaterializedAt: now - 500 },
            live,
        ),
    ).toBe(true);
});
