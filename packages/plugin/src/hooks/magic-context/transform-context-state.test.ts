/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    closeDatabase,
    openDatabase,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import type { ContextUsage } from "../../features/magic-context/types";
import { computeHardCacheExpired } from "./transform";
import { loadContextUsage } from "./transform-context-state";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    closeDatabase();
    process.env.XDG_DATA_HOME = originalXdgDataHome;

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
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

function createUsageMap() {
    return new Map<string, { usage: ContextUsage; updatedAt: number; lastResponseTime?: number }>();
}

describe("loadContextUsage", () => {
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
