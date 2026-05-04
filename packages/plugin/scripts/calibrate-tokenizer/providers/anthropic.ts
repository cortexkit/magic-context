/**
 * Anthropic backend: hits the official `/v1/messages/count_tokens` endpoint
 * which returns deterministic input_tokens for a given request body without
 * actually running inference. Free, fast, exact.
 *
 * Uses the OAuth access token from auth.json with the same beta headers
 * OpenCode/Claude Code use, so OAuth-only models work.
 */

interface ModelTest {
    label: string;
    provider: string;
    modelId: string;
}

interface AuthEntry {
    type: string;
    access?: string;
    key?: string;
}

interface MeasureResult {
    systemApi: number | null;
    toolsApi: number | null;
}

const ANTHROPIC_BETA = "oauth-2025-04-20";
const COUNT_URL = "https://api.anthropic.com/v1/messages/count_tokens";

async function callCountTokens(
    body: Record<string, unknown>,
    accessToken: string,
): Promise<number> {
    const res = await fetch(COUNT_URL, {
        method: "POST",
        headers: {
            authorization: `Bearer ${accessToken}`,
            "anthropic-version": "2023-06-01",
            "anthropic-beta": ANTHROPIC_BETA,
            "content-type": "application/json",
            "user-agent": "magic-context-calibration/1.0",
        },
        body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
        throw new Error(`count_tokens HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = JSON.parse(text) as { input_tokens?: number; type?: string };
    if (json.type === "error" || typeof json.input_tokens !== "number") {
        throw new Error(`count_tokens error: ${text.slice(0, 200)}`);
    }
    return json.input_tokens;
}

export async function measureAnthropic(
    test: ModelTest,
    auth: AuthEntry,
    systemText: string,
    toolsArray: unknown[],
): Promise<MeasureResult> {
    if (auth.type !== "oauth" || !auth.access) {
        throw new Error("Anthropic auth must be OAuth with access token");
    }
    const access = auth.access;

    // System-only request: keep system prompt as one big text block (single block
    // so per-block overhead doesn't dominate; matches what the plugin renders).
    const systemBody = {
        model: test.modelId,
        system: systemText,
        messages: [{ role: "user", content: "x" }],
    };
    const systemApi = await callCountTokens(systemBody, access);

    // Tools-only request
    const toolsBody = {
        model: test.modelId,
        tools: toolsArray,
        messages: [{ role: "user", content: "x" }],
    };
    const toolsApi = await callCountTokens(toolsBody, access);

    // Subtract baseline (~9 tokens for the {role:user,content:"x"} envelope plus
    // the floor) so the returned numbers reflect just the system / tools content.
    const baselineBody = {
        model: test.modelId,
        messages: [{ role: "user", content: "x" }],
    };
    const baseline = await callCountTokens(baselineBody, access);
    return {
        systemApi: Math.max(0, systemApi - baseline),
        toolsApi: Math.max(0, toolsApi - baseline),
    };
}
