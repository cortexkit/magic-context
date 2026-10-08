import { describe, expect, it } from "bun:test";

import {
    DreamerProviderOutputFailureError,
    primaryQuotaFailure,
    providerOutputFailureFromInvalidManifest,
    rememberPrimaryQuota,
    withDreamerModelCooldown,
} from "./provider-output-failure";
import {
    RECORDED_GEMINI_QUOTA_NOTICE,
    recordedGeminiQuotaMessages,
} from "./provider-output-failure.test-support";

function assistantCompletion(args: {
    created: number;
    output: number;
    reasoning: number;
    finish?: string;
    error?: unknown;
}) {
    return {
        info: {
            role: "assistant",
            time: { created: args.created },
            finish: args.finish ?? "stop",
            error: args.error ?? null,
            tokens: { output: args.output, reasoning: args.reasoning },
        },
        parts: [{ type: "text", text: "provider text" }],
    };
}

describe("providerOutputFailureFromInvalidManifest", () => {
    it("isolates quota cooldowns between concurrent maintenance runs", async () => {
        const failure = providerOutputFailureFromInvalidManifest(
            recordedGeminiQuotaMessages(),
            RECORDED_GEMINI_QUOTA_NOTICE,
        )!;
        await Promise.all([
            withDreamerModelCooldown(async () => {
                rememberPrimaryQuota("google/gemini", failure);
                await Promise.resolve();
                expect(primaryQuotaFailure("google/gemini")?.quotaResetAt).toBe(
                    failure.quotaResetAt,
                );
                expect(primaryQuotaFailure("google/other")).toBeNull();
            }),
            withDreamerModelCooldown(async () => {
                await Promise.resolve();
                expect(primaryQuotaFailure("google/gemini")).toBeNull();
            }),
        ]);
        expect(primaryQuotaFailure("google/gemini")).toBeNull();
    });
    it("recognizes the recorded 33-token Gemini account-pool exhaustion notice", () => {
        const failure = providerOutputFailureFromInvalidManifest(
            recordedGeminiQuotaMessages(),
            RECORDED_GEMINI_QUOTA_NOTICE,
            1791425104275,
        );
        expect(failure).toBeInstanceOf(DreamerProviderOutputFailureError);
        expect(failure?.outputTokens).toBe(33);
        expect(failure?.quotaResetAt).toBe(1791430804275);
        expect(failure?.message).toBe(
            "provider quota exhausted until 2026-10-08T03:40:04.275Z (account-pool rate limit)",
        );
    });

    it("does not classify quoted, incomplete, or reasoning-bearing quota notices", () => {
        for (const text of [
            `<verify><skip id="1" reason="${RECORDED_GEMINI_QUOTA_NOTICE}"/></verify>`,
            `The provider said: ${RECORDED_GEMINI_QUOTA_NOTICE}`,
            RECORDED_GEMINI_QUOTA_NOTICE.slice(0, -1),
            RECORDED_GEMINI_QUOTA_NOTICE.replace("1h 35m", "unknown"),
        ]) {
            expect(
                providerOutputFailureFromInvalidManifest(recordedGeminiQuotaMessages(), text),
            ).toBeNull();
        }
        expect(
            providerOutputFailureFromInvalidManifest(
                [assistantCompletion({ created: 1, output: 33, reasoning: 1 })],
                RECORDED_GEMINI_QUOTA_NOTICE,
            ),
        ).toBeNull();
    });

    it("classifies the latest near-zero no-reasoning completion as a transient provider failure", () => {
        const messages = [
            assistantCompletion({ created: 1, output: 8, reasoning: 0 }),
            assistantCompletion({ created: 2, output: 8, reasoning: 0 }),
            assistantCompletion({ created: 3, output: 8, reasoning: 0 }),
        ];

        const failure = providerOutputFailureFromInvalidManifest(
            messages,
            "All Antigravity endpoints failed",
        );

        expect(failure).toBeInstanceOf(DreamerProviderOutputFailureError);
        expect(failure?.transient).toBe(true);
        expect(failure?.outputTokens).toBe(8);
        expect(failure?.reasoningTokens).toBe(0);
        expect(failure?.message).toContain("provider-outage completion");
        expect(failure?.message).not.toContain("manifest missing");
    });

    it("requires the complete outage token shape instead of matching response wording", () => {
        const responseText = "All Antigravity endpoints failed";

        expect(
            providerOutputFailureFromInvalidManifest(
                [assistantCompletion({ created: 1, output: 33, reasoning: 0 })],
                responseText,
            ),
        ).toBeNull();
        expect(
            providerOutputFailureFromInvalidManifest(
                [assistantCompletion({ created: 1, output: 8, reasoning: 1 })],
                responseText,
            ),
        ).toBeNull();
        expect(
            providerOutputFailureFromInvalidManifest(
                [assistantCompletion({ created: 1, output: 8, reasoning: 0, finish: "length" })],
                responseText,
            ),
        ).toBeNull();
        expect(
            providerOutputFailureFromInvalidManifest(
                [
                    assistantCompletion({
                        created: 1,
                        output: 8,
                        reasoning: 0,
                        error: { name: "ProviderError" },
                    }),
                ],
                responseText,
            ),
        ).toBeNull();
    });
});
