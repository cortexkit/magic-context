import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("plugin model-limit cache warmup", () => {
    test("warms model limits once at startup and does not schedule periodic refresh", () => {
        const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
        const refreshCalls = source.match(/refreshModelLimitsFromApi\(/g) ?? [];

        expect(refreshCalls).toHaveLength(1); // one startup call, no timer callback
        expect(source).not.toContain("setInterval(");
        expect(source).toContain("Do NOT refresh periodically");
    });
});
