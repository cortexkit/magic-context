import type { createOpencodeClient } from "@opencode-ai/sdk";

import { log } from "./logger";

type Client = ReturnType<typeof createOpencodeClient>;

type PromptBody = {
    model?: { providerID: string; modelID: string };
    [key: string]: unknown;
};

type PromptArgs = {
    path: { id: string };
    body: PromptBody;
    signal?: AbortSignal;
    [key: string]: unknown;
};

export interface PromptRetryOptions {
    timeoutMs?: number;
    /** External abort signal — cancels the in-flight LLM prompt immediately when aborted */
    signal?: AbortSignal;
}

export interface ModelSuggestionInfo {
    providerID: string;
    modelID: string;
    suggestion: string;
}

function extractMessage(error: unknown): string {
    if (typeof error === "string") return error;
    if (error instanceof Error) return error.message;
    if (typeof error === "object" && error !== null) {
        const obj = error as Record<string, unknown>;
        if (typeof obj.message === "string") return obj.message;
    }

    try {
        return JSON.stringify(error);
    } catch (_error) {
        return String(error);
    }
}

export function parseModelSuggestion(error: unknown): ModelSuggestionInfo | null {
    if (!error) return null;

    if (typeof error === "object" && error !== null) {
        const errObj = error as Record<string, unknown>;

        if (
            errObj.name === "ProviderModelNotFoundError" &&
            typeof errObj.data === "object" &&
            errObj.data !== null
        ) {
            const data = errObj.data as Record<string, unknown>;
            const suggestions = data.suggestions;
            if (Array.isArray(suggestions) && typeof suggestions[0] === "string") {
                return {
                    providerID: String(data.providerID ?? ""),
                    modelID: String(data.modelID ?? ""),
                    suggestion: suggestions[0],
                };
            }
        }

        for (const key of ["data", "error", "cause"] as const) {
            const nested = errObj[key];
            if (nested && typeof nested === "object") {
                const result = parseModelSuggestion(nested);
                if (result) return result;
            }
        }
    }

    const message = extractMessage(error);
    const modelMatch = message.match(/model not found:\s*([^/\s]+)\s*\/\s*([^.,\s]+)/i);
    const suggestionMatch = message.match(/did you mean:\s*([^,?]+)/i);

    if (!modelMatch || !suggestionMatch) {
        return null;
    }

    return {
        providerID: modelMatch[1].trim(),
        modelID: modelMatch[2].trim(),
        suggestion: suggestionMatch[1].trim(),
    };
}

async function promptWithTimeout(
    client: Client,
    args: PromptArgs,
    timeoutMs: number,
    signal?: AbortSignal,
): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    // Link external signal to internal controller so external abort cancels the fetch
    const onExternalAbort = () => controller.abort();
    signal?.addEventListener("abort", onExternalAbort);

    try {
        await client.session.prompt({
            ...args,
            signal: controller.signal,
        } as Parameters<typeof client.session.prompt>[0]);
    } catch (error) {
        if (signal?.aborted) {
            throw new Error("prompt aborted by external signal");
        }
        if (controller.signal.aborted) {
            throw new Error(`prompt timed out after ${timeoutMs}ms`);
        }
        throw error;
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onExternalAbort);
    }
}

export async function promptSyncWithModelSuggestionRetry(
    client: Client,
    args: PromptArgs,
    options: PromptRetryOptions = {},
): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 300_000;

    try {
        await promptWithTimeout(client, args, timeoutMs, options.signal);
    } catch (error) {
        const suggestion = parseModelSuggestion(error);
        if (!suggestion || !args.body.model) {
            throw error;
        }

        log("[model-suggestion-retry] Model not found, retrying with suggestion", {
            original: `${suggestion.providerID}/${suggestion.modelID}`,
            suggested: suggestion.suggestion,
        });

        await promptWithTimeout(
            client,
            {
                ...args,
                body: {
                    ...args.body,
                    model: {
                        providerID: suggestion.providerID,
                        modelID: suggestion.suggestion,
                    },
                },
            },
            timeoutMs,
            options.signal,
        );
    }
}
