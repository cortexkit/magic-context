import { describe, expect, it } from "bun:test";
import type { ContextUsage, PendingOp, SchedulerDecision, SessionMeta, TagEntry } from "./types";

describe("magic-context types", () => {
    it("TagEntry has the expected shape", () => {
        const entry: TagEntry = {
            tagNumber: 1,
            messageId: "msg-abc",
            type: "message",
            status: "active",
            byteSize: 512,
            sessionId: "ses-xyz",
        };

        expect(entry.tagNumber).toBe(1);
        expect(entry.type).toBe("message");
        expect(entry.status).toBe("active");
    });

    it("TagEntry keeps dropped and compacted statuses", () => {
        const dropped: TagEntry["status"] = "dropped";
        const compacted: TagEntry["status"] = "compacted";

        expect(dropped).toBe("dropped");
        expect(compacted).toBe("compacted");
    });

    it("PendingOp is drop-only", () => {
        const op: PendingOp = {
            id: 1,
            sessionId: "ses-xyz",
            tagId: 42,
            operation: "drop",
            queuedAt: Date.now(),
        };

        expect(op.operation).toBe("drop");
    });

    it("SessionMeta has the expected shape", () => {
        const meta: SessionMeta = {
            sessionId: "ses-xyz",
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
        };

        expect(meta.counter).toBe(0);
        expect(meta.isSubagent).toBe(false);
    });

    it("SchedulerDecision accepts execute and defer", () => {
        const execute: SchedulerDecision = "execute";
        const defer: SchedulerDecision = "defer";

        expect(execute).toBe("execute");
        expect(defer).toBe("defer");
    });

    it("ContextUsage has the expected shape", () => {
        const usage: ContextUsage = {
            percentage: 45.5,
            inputTokens: 10_000,
        };

        expect(usage.percentage).toBe(45.5);
        expect(usage.inputTokens).toBe(10_000);
    });
});
