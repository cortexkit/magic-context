import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
    __resetToolDefinitionMeasurements,
    getCurrentToolSetHash,
    getMeasuredToolDefinitionTokens,
} from "../../features/magic-context/tool-definition-tokens";
import { estimateTokens } from "../../hooks/magic-context/read-session-formatting";
import {
    __resetHostLimitations,
    activeHostLimitations,
    declareHostLimitation,
} from "../../shared/host-limitations";
import type { StatusDetail } from "../../shared/rpc-types";
import { statusSummaryFromDetail } from "../../shared/status-summary";
import { recordV2ToolDefinitions } from "./context";
import { resolveV2RustModeModuleClient } from "./rust-mode";
import type { SessionContext } from "./types";

function draft(overrides: Partial<SessionContext> = {}): SessionContext {
    return {
        sessionID: "ses-v2-limitations",
        model: { providerID: "openai", id: "gpt-mock" },
        agent: "build",
        messages: [],
        system: [],
        tools: {
            read: { description: "Read a file", input: { type: "object", properties: {} } },
            ctx_note: { description: "Save a note", input: { type: "object", properties: {} } },
        },
        options: {},
        ...overrides,
    };
}

describe("v2 transform-mode resolution", () => {
    beforeEach(() => {
        __resetHostLimitations();
    });
    afterEach(() => {
        __resetHostLimitations();
    });

    it("builds a module client for Rust mode and none for TypeScript mode", () => {
        const directory = "/tmp/magic-context-v2-rust-mode";
        expect(resolveV2RustModeModuleClient({ transform_mode: "ts" }, directory)).toBeUndefined();
        expect(resolveV2RustModeModuleClient({}, directory)).toBeUndefined();
        const client = resolveV2RustModeModuleClient({ transform_mode: "rust" }, directory);
        expect(client).toBeDefined();
        // Every method the RPC status handlers and the transform reach for must be
        // present; a missing one reads as "Rust module status unavailable" at runtime.
        for (const method of [
            "call",
            "stateSyncCapabilities",
            "deleteSession",
            "closeSession",
            "authorityStatus",
            "authorityPrepare",
            "authoritySeed",
            "authorityDrain",
            "mirrorPull",
            "markerStatus",
            "mirrorMemory",
            "memoryIdentityAck",
            "getCompartmentsAfter",
        ]) {
            expect(typeof (client as unknown as Record<string, unknown>)[method]).toBe("function");
        }
    });

    it("declares no limitation for a Rust-mode session", () => {
        const warnings: string[] = [];
        const original = console.warn;
        console.warn = (...args: unknown[]) => {
            warnings.push(args.map(String).join(" "));
        };
        try {
            resolveV2RustModeModuleClient({ transform_mode: "rust" }, "/tmp/magic-context-v2-rust");
            expect(activeHostLimitations()).toEqual([]);
            expect(warnings).toEqual([]);
        } finally {
            console.warn = original;
        }
    });

    it("shows a declared limitation as a status warning", () => {
        declareHostLimitation("hidden_cleanup_unbound");
        const detail = {
            inputTokens: 0,
            contextLimit: 0,
            usagePercentage: 0,
            cacheTtl: "5m",
            compartmentCount: 0,
            memoryCount: 0,
            executeThreshold: 65,
            hostLimitations: activeHostLimitations(),
        } as unknown as StatusDetail;
        expect(statusSummaryFromDetail(detail).warnings).toEqual(["hidden_cleanup_unbound"]);
    });
});

describe("v2 tool-definition measurement", () => {
    beforeEach(() => {
        __resetToolDefinitionMeasurements();
    });
    afterEach(() => {
        __resetToolDefinitionMeasurements();
    });

    it("measures the draft's tool set under the same key the status surfaces read", () => {
        const request = draft();
        recordV2ToolDefinitions(request);
        const expected =
            estimateTokens("Read a file") +
            estimateTokens(JSON.stringify({ type: "object", properties: {} })) +
            estimateTokens("Save a note") +
            estimateTokens(JSON.stringify({ type: "object", properties: {} }));
        expect(getMeasuredToolDefinitionTokens("openai", "gpt-mock", "build")).toBe(expected);
        expect(getCurrentToolSetHash("openai", "gpt-mock", "build")).not.toBe("");
    });

    it("measures the edited descriptions, not the host's originals", () => {
        const request = draft();
        request.tools.ctx_note!.description = "short";
        recordV2ToolDefinitions(request);
        const shortened =
            estimateTokens("Read a file") +
            estimateTokens(JSON.stringify({ type: "object", properties: {} })) +
            estimateTokens("short") +
            estimateTokens(JSON.stringify({ type: "object", properties: {} }));
        expect(getMeasuredToolDefinitionTokens("openai", "gpt-mock", "build")).toBe(shortened);
    });

    it("keys each agent and model separately and re-measuring one pass changes nothing", () => {
        recordV2ToolDefinitions(draft());
        const first = getMeasuredToolDefinitionTokens("openai", "gpt-mock", "build");
        recordV2ToolDefinitions(draft());
        expect(getMeasuredToolDefinitionTokens("openai", "gpt-mock", "build")).toBe(first);
        expect(getMeasuredToolDefinitionTokens("openai", "gpt-mock", "plan")).toBeUndefined();
        recordV2ToolDefinitions(draft({ agent: "plan" }));
        expect(getMeasuredToolDefinitionTokens("openai", "gpt-mock", "plan")).toBe(first);
    });

    it("reports no measurement for a draft the host sent no tools with", () => {
        recordV2ToolDefinitions(draft({ tools: {} }));
        expect(getMeasuredToolDefinitionTokens("openai", "gpt-mock", "build")).toBeUndefined();
        expect(getCurrentToolSetHash("openai", "gpt-mock", "build")).toBe("");
    });
});
