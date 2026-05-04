/**
 * OpenAI-compatible backend: covers any provider that exposes the standard
 * /v1/chat/completions endpoint and returns `usage.prompt_tokens` (or the
 * Responses API equivalent `usage.input_tokens`).
 *
 * Strategy: send a minimal inference request with `max_tokens=1` (or the
 * smallest the provider allows), let the provider tokenize the prompt, read
 * the actual prompt_tokens from the response. Cost is tiny (one output token).
 *
 * Per-provider URL/auth header variations handled inline. We do NOT route
 * through OpenCode — direct fetch only.
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

interface ProviderEndpoint {
    url: string;
    headers: Record<string, string>;
    /** Some providers use legacy max_tokens, some use max_completion_tokens. */
    maxTokensField: "max_tokens" | "max_completion_tokens";
    /** Some providers reject `tools` when sending only assistant turns. */
    supportsTools: boolean;
}

function endpointFor(provider: string, auth: AuthEntry): ProviderEndpoint {
    const token = auth.access ?? auth.key;
    if (!token) throw new Error(`No token for provider ${provider}`);
    const headers: Record<string, string> = {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "user-agent": "magic-context-calibration/1.0",
    };
    switch (provider) {
        case "openai":
            return {
                url: "https://api.openai.com/v1/chat/completions",
                headers,
                maxTokensField: "max_completion_tokens",
                supportsTools: true,
            };
        case "github-copilot":
            return {
                url: "https://api.githubcopilot.com/chat/completions",
                headers: {
                    ...headers,
                    "copilot-integration-id": "vscode-chat",
                    "editor-version": "vscode/1.95.0",
                },
                maxTokensField: "max_tokens",
                supportsTools: true,
            };
        case "xai":
            return {
                url: "https://api.x.ai/v1/chat/completions",
                headers,
                maxTokensField: "max_tokens",
                supportsTools: true,
            };
        case "cerebras":
            return {
                url: "https://api.cerebras.ai/v1/chat/completions",
                headers,
                maxTokensField: "max_completion_tokens",
                supportsTools: true,
            };
        case "openrouter":
            return {
                url: "https://openrouter.ai/api/v1/chat/completions",
                headers: { ...headers, "http-referer": "https://github.com/cortexkit/magic-context" },
                maxTokensField: "max_tokens",
                supportsTools: true,
            };
        case "fireworks-ai":
            return {
                url: "https://api.fireworks.ai/inference/v1/chat/completions",
                headers,
                maxTokensField: "max_tokens",
                supportsTools: true,
            };
        case "opencode-go":
            return {
                url: "https://opencode.ai/zen/go/v1/chat/completions",
                headers,
                maxTokensField: "max_tokens",
                supportsTools: true,
            };
        case "inception":
            return {
                url: "https://api.inceptionlabs.ai/v1/chat/completions",
                headers,
                maxTokensField: "max_tokens",
                supportsTools: true,
            };
        default:
            throw new Error(`Unknown provider: ${provider}`);
    }
}

async function chatCompletion(
    endpoint: ProviderEndpoint,
    body: Record<string, unknown>,
): Promise<number> {
    const res = await fetch(endpoint.url, {
        method: "POST",
        headers: endpoint.headers,
        body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = JSON.parse(text) as {
        usage?: {
            prompt_tokens?: number;
            input_tokens?: number;
        };
        error?: { message?: string };
    };
    if (json.error) {
        throw new Error(`API error: ${json.error.message ?? JSON.stringify(json.error)}`);
    }
    const tokens = json.usage?.prompt_tokens ?? json.usage?.input_tokens;
    if (typeof tokens !== "number") {
        throw new Error(`No token count in response: ${text.slice(0, 200)}`);
    }
    return tokens;
}

/** Convert Anthropic tool shape to OpenAI tool shape. */
function toOpenAITools(anthropicTools: unknown[]): unknown[] {
    return (anthropicTools as Array<Record<string, unknown>>).map((t) => ({
        type: "function",
        function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema,
        },
    }));
}

export async function measureOpenAICompatible(
    test: ModelTest,
    auth: AuthEntry,
    systemText: string,
    toolsArray: unknown[],
): Promise<MeasureResult> {
    const endpoint = endpointFor(test.provider, auth);

    const baselineBody: Record<string, unknown> = {
        model: test.modelId,
        messages: [{ role: "user", content: "x" }],
        [endpoint.maxTokensField]: 1,
        stream: false,
    };
    const baseline = await chatCompletion(endpoint, baselineBody);

    const systemBody: Record<string, unknown> = {
        model: test.modelId,
        messages: [
            { role: "system", content: systemText },
            { role: "user", content: "x" },
        ],
        [endpoint.maxTokensField]: 1,
        stream: false,
    };
    const systemTotal = await chatCompletion(endpoint, systemBody);

    let toolsTotal = 0;
    if (endpoint.supportsTools && toolsArray.length > 0) {
        const toolsBody: Record<string, unknown> = {
            model: test.modelId,
            messages: [{ role: "user", content: "x" }],
            tools: toOpenAITools(toolsArray),
            [endpoint.maxTokensField]: 1,
            stream: false,
        };
        toolsTotal = await chatCompletion(endpoint, toolsBody);
    } else {
        toolsTotal = baseline; // no tools support → tools contribution is 0
    }

    return {
        systemApi: Math.max(0, systemTotal - baseline),
        toolsApi: Math.max(0, toolsTotal - baseline),
    };
}
