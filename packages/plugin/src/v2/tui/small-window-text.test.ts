import { describe, expect, test } from "bun:test";
import type { SidebarSnapshot } from "../../shared/rpc-types";
import { sidebarText, statusText } from "./index";

describe("small-window warning in the OpenCode 2 text fallbacks", () => {
    test("the OpenCode 2 text sidebar and status fallback show it while it holds", () => {
        const snapshot = {
            sessionId: "s",
            usagePercentage: 20,
            inputTokens: 9_000,
            contextLimit: 45_000,
            executeThreshold: 65,
            systemPromptTokens: 6_062,
            toolDefinitionTokens: 15_134,
            compartmentCount: 0,
            memoryCount: 0,
            memoryBlockCount: 0,
            pendingOpsCount: 0,
            historianRunning: false,
            lastTransformError: null,
        } as unknown as SidebarSnapshot;
        const line =
            "Warning: Context window too small: the system prompt (6,062 tokens) and tool definitions (15,134 tokens) take 72% of the 29,250 tokens at which reduction starts, leaving about 8,054 tokens for the conversation. Raise the model's context setting or remove tools.";
        expect(sidebarText(snapshot).split("\n")).toContain(line);
        expect(statusText(snapshot as never).split("\n")).toContain(line);
        expect(sidebarText({ ...snapshot, contextLimit: 90_000 })).not.toContain(
            "Context window too small",
        );
    });
});
