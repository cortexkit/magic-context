/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { createScheduler, parseCacheTtl } from "./scheduler";
import type { ContextUsage, SessionMeta } from "./types";

const BASE_TIME = 1_000_000;

function createSessionMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
    return {
        sessionId: "ses-1",
        lastResponseTime: BASE_TIME,
        cacheTtl: "5m",
        counter: 0,
        lastNudgeTokens: 0,
        lastNudgeBand: null,
        lastTransformError: null,
        isSubagent: false,
        lastContextPercentage: 0,
        lastInputTokens: 0,
        timesExecuteThresholdReached: 0,
        compartmentInProgress: false,
        systemPromptHash: "",
        ...overrides,
    };
}

function createContextUsage(percentage: number): ContextUsage {
    return {
        percentage,
        inputTokens: 1000,
    };
}

describe("createScheduler", () => {
    it("returns execute when cache is expired", () => {
        const scheduler = createScheduler({ executeThresholdPercentage: 65 });
        const sessionMeta = createSessionMeta({ lastResponseTime: BASE_TIME - 400_000 });
        const contextUsage = createContextUsage(50);

        const decision = scheduler.shouldExecute(sessionMeta, contextUsage, BASE_TIME);

        expect(decision).toBe("execute");
    });

    it("returns execute when context usage is at or above the configured threshold", () => {
        const scheduler = createScheduler({ executeThresholdPercentage: 65 });
        const sessionMeta = createSessionMeta({ lastResponseTime: BASE_TIME - 10_000 });
        const contextUsage = createContextUsage(65);

        const decision = scheduler.shouldExecute(sessionMeta, contextUsage, BASE_TIME);

        expect(decision).toBe("execute");
    });

    it("returns defer when cache is warm and context usage is below the configured threshold", () => {
        const scheduler = createScheduler({ executeThresholdPercentage: 65 });
        const sessionMeta = createSessionMeta({ lastResponseTime: BASE_TIME - 10_000 });
        const contextUsage = createContextUsage(50);

        const decision = scheduler.shouldExecute(sessionMeta, contextUsage, BASE_TIME);

        expect(decision).toBe("defer");
    });

    it("uses a custom execute threshold", () => {
        const scheduler = createScheduler({ executeThresholdPercentage: 70 });
        const sessionMeta = createSessionMeta({ lastResponseTime: BASE_TIME - 10_000 });

        expect(scheduler.shouldExecute(sessionMeta, createContextUsage(69), BASE_TIME)).toBe(
            "defer",
        );
        expect(scheduler.shouldExecute(sessionMeta, createContextUsage(70), BASE_TIME)).toBe(
            "execute",
        );
    });

    it("uses a model-specific execute threshold when modelKey is provided", () => {
        const scheduler = createScheduler({
            executeThresholdPercentage: { default: 70, "openai/gpt-4o": 60 },
        });
        const sessionMeta = createSessionMeta({ lastResponseTime: BASE_TIME - 10_000 });

        expect(
            scheduler.shouldExecute(
                sessionMeta,
                createContextUsage(65),
                BASE_TIME,
                undefined,
                "openai/gpt-4o",
            ),
        ).toBe("execute");
    });

    it("falls back to 5m default when cacheTtl is invalid", () => {
        const scheduler = createScheduler({ executeThresholdPercentage: 65 });
        const sessionMeta = createSessionMeta({
            cacheTtl: "bad-format",
            lastResponseTime: BASE_TIME - 400_000,
        });
        const contextUsage = createContextUsage(50);

        const decision = scheduler.shouldExecute(sessionMeta, contextUsage, BASE_TIME);

        expect(decision).toBe("execute");
    });

    it("falls back to 5m default when cacheTtl is invalid and cache would be warm", () => {
        const scheduler = createScheduler({ executeThresholdPercentage: 65 });
        const sessionMeta = createSessionMeta({
            cacheTtl: "not-a-ttl",
            lastResponseTime: BASE_TIME - 10_000,
        });
        const contextUsage = createContextUsage(50);

        const decision = scheduler.shouldExecute(sessionMeta, contextUsage, BASE_TIME);

        expect(decision).toBe("defer");
    });
});

describe("parseCacheTtl", () => {
    it("parses minutes, hours, and seconds", () => {
        const minutes = parseCacheTtl("5m");
        const hours = parseCacheTtl("1h");
        const seconds = parseCacheTtl("30s");

        expect(minutes).toBe(300_000);
        expect(hours).toBe(3_600_000);
        expect(seconds).toBe(30_000);
    });

    it("passes through raw millisecond strings", () => {
        const milliseconds = parseCacheTtl("300000");

        expect(milliseconds).toBe(300_000);
    });

    it("throws on invalid ttl format", () => {
        expect(() => parseCacheTtl("bad-format")).toThrow();
    });
});
