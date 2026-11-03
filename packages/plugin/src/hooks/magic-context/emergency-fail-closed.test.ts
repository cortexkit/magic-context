import { afterEach, expect, it } from "bun:test";
import golden from "../../../test-fixtures/runtime/protected-tool-refusal.json";
import signedTurnGolden from "../../../test-fixtures/runtime/signed-turn-refusal.json";
import { protectedToolTokenCount } from "../../features/magic-context/reclaim-protection";
import {
    __resetToolDefinitionMeasurements,
    recordToolDefinition,
} from "../../features/magic-context/tool-definition-tokens";
import type { TagEntry } from "../../features/magic-context/types";
import { resolveDecisionCalibration } from "./decision-calibration";
import {
    contextRefusalError,
    outgoingContextRefusal,
    PROTECTED_TOOL_RESULTS_OVER_LIMIT,
    PROTECTED_TOOL_RESULTS_OVER_LIMIT_CODE,
    protectedToolRefusal,
    SIGNED_TURN_OVER_LIMIT,
    SIGNED_TURN_OVER_LIMIT_CODE,
    signedTurnContextRefusal,
} from "./emergency-fail-closed";
import { estimateFinalWireInputTokens } from "./final-wire-token-estimate";
import type { MessageLike } from "./tag-messages";
import { evaluateEmergencyFailClosed } from "./transform-postprocess-phase";

afterEach(() => __resetToolDefinitionMeasurements());

it("re-review: OpenCode must not refuse a fitting uncalibrated request on the unknown-model upper envelope", () => {
    const route = {
        providerID: "unmeasured-provider",
        modelID: "unmeasured-model",
        agentName: "build",
    };
    const output = "word ".repeat(8000);
    const calibration = resolveDecisionCalibration(route.providerID, route.modelID);
    expect(calibration.seeded).toBe(false);
    recordToolDefinition(route.providerID, route.modelID, route.agentName, "probe", "A probe", {
        type: "object",
    });
    const messages = [
        {
            info: { id: "probe-result", role: "assistant" },
            parts: [
                {
                    type: "tool",
                    tool: "probe",
                    callID: "probe-call",
                    state: { status: "completed", input: {}, output },
                },
            ],
        },
    ] as unknown as MessageLike[];
    const estimate = estimateFinalWireInputTokens({ messages, systemPromptTokens: 100, ...route });
    expect(estimate.rawTokens!).toBeLessThan(14000);
    expect(estimate.tokens).toBeGreaterThan(16000);
    expect(estimate.trusted).toBe(true);
    expect(estimate.refusalGrade).toBe(false);
    const protectedToolTokens = protectedToolTokenCount(
        [
            {
                tagNumber: 1,
                type: "tool",
                status: "active",
                toolName: "probe",
                tokenCount: estimate.messageTokens.toolCall,
            } as TagEntry,
        ],
        { probe: 1 },
        calibration,
    );
    expect(
        evaluateEmergencyFailClosed({
            usagePercentage: 50,
            emergencyRecoveryArmed: false,
            emergencyRecoveryOrigin: null,
            foldMaterializedThisPass: false,
            finalWireEstimate: estimate,
            contextLimitTokens: 16000,
            protectedToolTokens,
        }).shouldAbort,
    ).toBe(false);
});

it("calibrated measured protected results still refuse with the protected-results code", () => {
    const route = { providerID: "anthropic", modelID: "claude-fable-5-1", agentName: "build" };
    recordToolDefinition(route.providerID, route.modelID, route.agentName, "probe", "A probe", {});
    const messages = [
        {
            info: { id: "probe-result", role: "assistant" },
            parts: [{ type: "tool", state: { input: {}, output: "word ".repeat(12000) } }],
        },
    ] as unknown as MessageLike[];
    const estimate = estimateFinalWireInputTokens({ messages, systemPromptTokens: 100, ...route });
    const protectedToolTokens = protectedToolTokenCount(
        [
            {
                tagNumber: 1,
                type: "tool",
                status: "active",
                toolName: "probe",
                tokenCount: estimate.messageTokens.toolCall,
            } as TagEntry,
        ],
        { probe: 1 },
        resolveDecisionCalibration(route.providerID, route.modelID),
    );
    expect(estimate.refusalGrade).toBe(true);
    expect(estimate.messageTokens.toolCall).toBeLessThan(16000);
    expect(protectedToolTokens).toBeGreaterThan(16000);
    const refusal = outgoingContextRefusal(estimate, 16000, protectedToolTokens);
    expect(refusal).toBe(golden.message);
    expect(contextRefusalError(refusal!).code).toBe(golden.code);
    // Unprotected pressure must still reach the provider's existing overflow handling.
    expect(outgoingContextRefusal(estimate, 16000, 100)).toBeUndefined();
});

it("protected overflow refusal matches the cross-language public contract", () => {
    expect(PROTECTED_TOOL_RESULTS_OVER_LIMIT_CODE).toBe(golden.code);
    expect(PROTECTED_TOOL_RESULTS_OVER_LIMIT).toBe(golden.message);
    expect(contextRefusalError(golden.message).code).toBe(golden.code);
    expect(protectedToolRefusal({ cause: { code: golden.code } })?.message).toBe(golden.message);
});

it("signed-turn over-window refusal matches the cross-language public contract", () => {
    expect(SIGNED_TURN_OVER_LIMIT_CODE).toBe(signedTurnGolden.code);
    expect(SIGNED_TURN_OVER_LIMIT).toBe(signedTurnGolden.message);
    expect(contextRefusalError(signedTurnGolden.message).code).toBe(signedTurnGolden.code);
    const refusal = protectedToolRefusal({ cause: { code: signedTurnGolden.code } });
    expect(refusal?.message).toBe(signedTurnGolden.message);
    expect(refusal?.code).toBe(signedTurnGolden.code);
});

it("after a signed-thinking reset only refusal-grade evidence of non-fit refuses", () => {
    const over = { tokens: 120_000, trusted: false, refusalGrade: true, refusalTokens: 120_000 };
    expect(signedTurnContextRefusal(over, 100_000)).toBe(SIGNED_TURN_OVER_LIMIT);
    // A fitting request, an estimate that cannot prove non-fit, or an unknown limit is sent.
    expect(signedTurnContextRefusal({ ...over, refusalTokens: 90_000 }, 100_000)).toBeUndefined();
    expect(signedTurnContextRefusal({ ...over, refusalGrade: false }, 100_000)).toBeUndefined();
    expect(signedTurnContextRefusal(over, undefined)).toBeUndefined();
});

it("successful no-op reclaim refuses a trusted over-limit outgoing request before provider rejection", () => {
    const decision = evaluateEmergencyFailClosed({
        usagePercentage: 100,
        emergencyRecoveryArmed: false,
        emergencyRecoveryOrigin: null,
        foldMaterializedThisPass: false,
        finalWireEstimate: {
            tokens: 96000,
            trusted: true,
            refusalGrade: true,
            refusalTokens: 96000,
        },
        contextLimitTokens: 16000,
        protectedToolTokens: 96000,
    });
    expect(decision.shouldAbort).toBe(true);
    expect(decision.refusalMessage).toBe(golden.message);
});

it("partial estimates and fitting reclaimed requests do not cause a new refusal", () => {
    expect(outgoingContextRefusal({ tokens: 96000, trusted: false }, 16000, 96000)).toBeUndefined();
    expect(outgoingContextRefusal({ tokens: 16000, trusted: true }, 16000)).toBeUndefined();
    expect(outgoingContextRefusal({ tokens: 2000, trusted: true }, undefined)).toBeUndefined();
    expect(
        outgoingContextRefusal(
            { tokens: 96000, trusted: true, refusalGrade: true, refusalTokens: 96000 },
            16000,
        ),
    ).toBeUndefined();
});
