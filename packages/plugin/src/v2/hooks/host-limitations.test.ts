import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPluginConfigDetailed } from "../../config";
import {
    resetTransformModeDeprecationWarningForTest,
    TRANSFORM_MODE_DEPRECATION_WARNING,
} from "../../config/transform-mode";
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
import * as logger from "../../shared/logger";
import type { StatusDetail } from "../../shared/rpc-types";
import { statusSummaryFromDetail } from "../../shared/status-summary";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { recordV2ToolDefinitions } from "./context";
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

    it("an OpenCode 2 seat config with transform_mode rust loads as ts", () => {
        const xdg = createTestTempDirFromPath(join(tmpdir(), "mc-v2-seat-config-"));
        const project = createTestTempDirFromPath(join(tmpdir(), "mc-v2-seat-project-"));
        mkdirSync(join(xdg, "cortexkit"), { recursive: true });
        writeFileSync(
            join(xdg, "cortexkit", "magic-context.jsonc"),
            JSON.stringify({
                transform_mode: "rust",
                rust_pipeline: "provider",
                subc: { connection_file: "/tmp/magic-context-v2-seat/subc.json" },
            }),
        );
        const original = process.env.XDG_CONFIG_HOME;
        process.env.XDG_CONFIG_HOME = xdg;
        resetTransformModeDeprecationWarningForTest();
        const log = spyOn(logger, "log").mockImplementation(() => {});
        try {
            // OpenCode 2 loads config in its server setup and again for each
            // directory's context hook; the deprecation still logs once.
            for (let load = 0; load < 3; load += 1) {
                const config = loadPluginConfigDetailed(project, false).config;
                expect(config.transform_mode).toBe("ts");
                expect(config.rust_pipeline).toBe("full_request");
            }
            expect(
                log.mock.calls.filter(
                    (call) => call[0] === `[magic-context] ${TRANSFORM_MODE_DEPRECATION_WARNING}`,
                ),
            ).toHaveLength(1);
        } finally {
            log.mockRestore();
            resetTransformModeDeprecationWarningForTest();
            if (original === undefined) delete process.env.XDG_CONFIG_HOME;
            else process.env.XDG_CONFIG_HOME = original;
            rmSync(xdg, { recursive: true, force: true });
            rmSync(project, { recursive: true, force: true });
        }
    });

    it("shows a declared limitation as a status warning", () => {
        declareHostLimitation("historian_unavailable");
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
        expect(statusSummaryFromDetail(detail).warnings).toEqual(["historian_unavailable"]);
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

    it("measures zero tool-definition tokens for a draft the host sent no tools with", () => {
        // The draft is the exact tool set of the request, so a request with no
        // tools has none to count, and no other set may stand in for it.
        recordV2ToolDefinitions(draft());
        recordV2ToolDefinitions(draft({ tools: {} }));
        expect(getMeasuredToolDefinitionTokens("openai", "gpt-mock", "build")).toBe(0);
        expect(getCurrentToolSetHash("openai", "gpt-mock", "build")).toBe("");
    });
});
