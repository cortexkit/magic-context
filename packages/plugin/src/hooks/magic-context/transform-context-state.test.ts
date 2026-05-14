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
import { loadContextUsage } from "./transform-context-state";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    closeDatabase();
    process.env.XDG_DATA_HOME = originalXdgDataHome;

    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
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
