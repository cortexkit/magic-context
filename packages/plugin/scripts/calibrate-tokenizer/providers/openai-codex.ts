/**
 * OpenAI ChatGPT-Plus (Codex/Responses API) backend.
 *
 * For users authenticated via the ChatGPT Plus OAuth flow, OpenCode routes
 * requests through `https://chatgpt.com/backend-api/codex/responses` instead
 * of `api.openai.com`. The endpoint speaks the Responses API shape, not Chat
 * Completions: `{ model, input, max_output_tokens, instructions? }`. System
 * prompt goes through `instructions`, not as a `system`-role message.
 *
 * Detection: when `auth.openai.type === "oauth"`, use this backend; otherwise
 * fall back to the standard openai-compatible backend.
 */

interface ModelTest {
    label: string;
    provider: string;
    modelId: string;
}

interface AuthEntry {
    type: string;
    access?: string;
    accountId?: string;
}

interface MeasureResult {
    systemApi: number | null;
    toolsApi: number | null;
}

const CODEX_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

interface ResponsesUsage {
    input_tokens?: number;
    output_tokens?: number;
}

/** Decode the JWT access token to extract the chatgpt_account_id claim. */
function extractAccountId(accessToken: string): string | undefined {
    try {
        const parts = accessToken.split(".");
        if (parts.length !== 3) return undefined;
        const payload = parts[1];
        if (!payload) return undefined;
        const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
        const decoded = Buffer.from(padded, "base64").toString("utf-8");
        const claims = JSON.parse(decoded) as Record<string, unknown>;
        const auth = claims["https://api.openai.com/auth"] as
            | Record<string, unknown>
            | undefined;
        return auth?.chatgpt_account_id as string | undefined;
    } catch {
        return undefined;
    }
}

async function streamResponses(
    body: Record<string, unknown>,
    accessToken: string,
    accountId: string | undefined,
): Promise<number> {
    const headers: Record<string, string> = {
        accept: "text/event-stream",
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
        "OpenAI-Beta": "responses=experimental",
        originator: "codex_cli_rs",
        "user-agent": "magic-context-calibration/1.0",
    };
    if (accountId) headers["chatgpt-account-id"] = accountId;

    const res = await fetch(CODEX_ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...body, stream: true, store: false }),
    });
    if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        throw new Error(`Codex HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    let usage: ResponsesUsage | null = null;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") continue;
            try {
                const parsed = JSON.parse(payload) as {
                    type?: string;
                    response?: { usage?: ResponsesUsage };
                    usage?: ResponsesUsage;
                };
                const u = parsed.response?.usage ?? parsed.usage;
                if (u && typeof u.input_tokens === "number") {
                    usage = u;
                }
            } catch {
                // Ignore malformed events
            }
        }
    }

    if (!usage || typeof usage.input_tokens !== "number") {
        throw new Error("No usage.input_tokens in Codex response stream");
    }
    return usage.input_tokens;
}

export async function measureOpenAICodex(
    test: ModelTest,
    auth: AuthEntry,
    systemText: string,
    toolsArray: unknown[],
): Promise<MeasureResult> {
    if (auth.type !== "oauth" || !auth.access) {
        throw new Error("OpenAI Codex backend requires OAuth auth");
    }
    const access = auth.access;
    const accountId = auth.accountId;

    const baseInput = [
        {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "x" }],
        },
    ];

    // The Codex backend rejects requests without `instructions`. To isolate the
    // contribution of our real system prompt, we send a tiny placeholder as the
    // baseline `instructions`, then re-send with the placeholder *plus* our
    // real system prompt, and take the difference. This way the constant Codex
    // overhead (mandatory framing) cancels out.
    const PLACEHOLDER = ".";

    // Baseline: minimal user message, placeholder instructions, no tools.
    // Note: Codex backend rejects `max_output_tokens` for some models (e.g.
    // gpt-5.2). We omit it entirely; the request still streams and reports
    // input_tokens before any meaningful output is generated.
    const baselineBody: Record<string, unknown> = {
        model: test.modelId,
        input: baseInput,
        instructions: PLACEHOLDER,
    };
    const baseline = await streamResponses(baselineBody, access, accountId);

    // System: placeholder + our system prompt
    const systemBody: Record<string, unknown> = {
        model: test.modelId,
        input: baseInput,
        instructions: `${PLACEHOLDER}\n${systemText}`,
    };
    const systemTotal = await streamResponses(systemBody, access, accountId);

    // Tools: convert Anthropic tool shape to Responses API tool shape (flat)
    const responsesTools = (toolsArray as Array<Record<string, unknown>>).map((t) => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
        strict: false,
    }));
    const toolsBody: Record<string, unknown> = {
        model: test.modelId,
        input: baseInput,
        instructions: PLACEHOLDER,
        tools: responsesTools,
    };
    const toolsTotal = await streamResponses(toolsBody, access, accountId);

    return {
        systemApi: Math.max(0, systemTotal - baseline),
        toolsApi: Math.max(0, toolsTotal - baseline),
    };
}
