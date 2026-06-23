import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildHiddenAgentConfig } from "./hidden-agent-config";

describe("plugin model-limit cache warmup", () => {
    test("warms model limits once at startup and does not schedule periodic refresh", () => {
        const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
        const refreshCalls = source.match(/refreshModelLimitsFromApi\(/g) ?? [];

        expect(refreshCalls).toHaveLength(1); // one startup call, no timer callback
        expect(source).not.toContain("setInterval(");
        expect(source).toContain("Do NOT refresh periodically");
    });
});

describe("buildHiddenAgentConfig", () => {
    test("clamps maxSteps overrides above the hard cap", () => {
        const config = buildHiddenAgentConfig("prompt", ["read"], 40, { maxSteps: 100_000 });

        expect(config.maxSteps).toBe(40);
        expect(config.steps).toBe(40);
    });

    test("honors maxSteps/steps overrides below the hard cap", () => {
        const config = buildHiddenAgentConfig("prompt", ["read"], 40, {
            maxSteps: 12,
            steps: 10,
        });

        expect(config.maxSteps).toBe(12);
        expect(config.steps).toBe(10);
    });
});
