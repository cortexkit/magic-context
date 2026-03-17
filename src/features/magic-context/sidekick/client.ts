import { log } from "../../../shared/logger";
import type { OpenAIChatCompletionResponse, OpenAIChatMessage, OpenAIChatTool } from "./types";

function normalizeEndpoint(endpoint: string): string {
    const trimmed = endpoint.trim().replace(/\/+$/, "");
    return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}

export async function chatCompletions(args: {
    endpoint: string;
    apiKey: string;
    model: string;
    messages: OpenAIChatMessage[];
    timeoutMs: number;
    tools?: OpenAIChatTool[];
    temperature?: number;
}): Promise<OpenAIChatCompletionResponse> {
    const signal = AbortSignal.timeout(args.timeoutMs);
    const url = normalizeEndpoint(args.endpoint);
    const headers: Record<string, string> = {
        "content-type": "application/json",
    };

    if (args.apiKey.trim().length > 0) {
        headers.authorization = `Bearer ${args.apiKey}`;
    }

    const body: Record<string, unknown> = {
        model: args.model,
        messages: args.messages,
    };

    if (args.tools && args.tools.length > 0) {
        body.tools = args.tools;
    }

    if (args.temperature !== undefined) {
        body.temperature = args.temperature;
    }

    let response: Response;

    try {
        response = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal,
        });
    } catch (error) {
        log(`[magic-context] sidekick chat request failed: ${getErrorMessage(error)}`);
        throw error;
    }

    if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        const errorMessage = `HTTP ${response.status}${errorText.length > 0 ? `: ${errorText}` : ""}`;
        log(`[magic-context] sidekick chat request failed: ${errorMessage}`);
        throw new Error(errorMessage);
    }

    const parsed = (await response.json()) as OpenAIChatCompletionResponse;
    if (!Array.isArray(parsed.choices)) {
        throw new Error("Invalid sidekick response: missing choices array");
    }

    return parsed;
}
