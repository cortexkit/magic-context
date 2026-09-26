/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import type { ContextUsage, SessionMeta } from "../../features/magic-context/types";
import { resolveExecuteThreshold } from "../../hooks/magic-context/event-resolvers";
import { resolveSchedulerDecision } from "../../hooks/magic-context/transform-context-state";
import { createV2ThresholdDeps } from "./context";

// The OpenCode 2 context hook hands `createV2ThresholdDeps` to the shared transform.
// Each case reads those dependencies exactly as the transform reads them on a pass:
// the scheduler decision, and the threshold the transform derives its pressure bands
// from. The pass sees a 100k-token window holding 30k input tokens (30%), well inside
// the cache TTL, so only a threshold can make it execute.

const SESSION = "ses_v2_threshold";
const CONTEXT_LIMIT = 100_000;
const usage: ContextUsage = { percentage: 30, inputTokens: 30_000 };

function sessionMeta(): SessionMeta {
    return {
        sessionId: SESSION,
        lastResponseTime: Date.now(),
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
        systemPromptTokens: 0,
        clearedReasoningThroughTag: 0,
    };
}

function pass(config: Parameters<typeof createV2ThresholdDeps>[0]) {
    const deps = createV2ThresholdDeps(config);
    return {
        decision: resolveSchedulerDecision(
            deps.scheduler,
            sessionMeta(),
            usage,
            SESSION,
            undefined,
            CONTEXT_LIMIT,
        ),
        transformThresholdPercentage: resolveExecuteThreshold(
            deps.executeThresholdPercentage ?? 65,
            undefined,
            65,
            { tokensConfig: deps.executeThresholdTokens, contextLimit: CONTEXT_LIMIT },
        ),
    };
}

describe("OpenCode 2 execute-threshold wiring", () => {
    it("control: at 30% under an 80% threshold with no token threshold, the pass defers", () => {
        const result = pass({ execute_threshold_percentage: 80 });
        expect(result.decision).toBe("defer");
        expect(result.transformThresholdPercentage).toBe(80);
    });

    it("executes a pass over execute_threshold_tokens.default even below the percentage threshold", () => {
        const result = pass({
            execute_threshold_percentage: 80,
            execute_threshold_tokens: { default: 20_000 },
        });
        expect(result.decision).toBe("execute");
    });

    it("gives the transform the token threshold, so its pressure bands start at 20% and not 80%", () => {
        const result = pass({
            execute_threshold_percentage: 80,
            execute_threshold_tokens: { default: 20_000 },
        });
        expect(result.transformThresholdPercentage).toBe(20);
    });
});
