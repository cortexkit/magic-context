/** Recorded final assistant output from the Antigravity auth adapter on
 * 2026-10-08. It reported account-pool exhaustion as a successful completion. */
export const RECORDED_GEMINI_QUOTA_NOTICE =
    "All 2 account(s) rate-limited for gemini. Quota resets in 1h 35m. Add more accounts with `opencode auth login` or wait and retry.";

export function recordedGeminiQuotaMessages() {
    return [
        {
            info: {
                role: "assistant",
                providerID: "google",
                modelID: "antigravity-gemini-3.8-flash",
                time: { created: 1791425104275 },
                finish: "stop",
                error: null,
                tokens: {
                    total: 33,
                    input: 0,
                    output: 33,
                    reasoning: 0,
                    cache: { write: 0, read: 0 },
                },
            },
            parts: [{ type: "text", text: RECORDED_GEMINI_QUOTA_NOTICE }],
        },
    ];
}
