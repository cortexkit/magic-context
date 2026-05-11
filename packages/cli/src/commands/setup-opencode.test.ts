import { describe, expect, it } from "bun:test";
import { findDcpPluginIndexes } from "./setup-opencode";

describe("setup-opencode DCP preflight", () => {
    it("is tuple-safe and only matches canonical opencode-dcp entries", () => {
        const plugins: unknown[] = [
            ["@plannotator/opencode@latest", { workflow: "plan-agent" }],
            "@some-fork/opencode-dcp-fork",
            ["@tarquinen/opencode-dcp@latest", { enabled: true }],
            "file:///tmp/opencode-dcp-dev",
        ];

        expect(() => findDcpPluginIndexes(plugins)).not.toThrow();
        expect(findDcpPluginIndexes(plugins)).toEqual([2]);
    });
});
