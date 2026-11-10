import { createHash } from "node:crypto";

import { isRecord } from "../../../shared/record-type-guard";

const MAX_NEAR_ZERO_OUTPUT_TOKENS = 32;

interface AssistantCompletionShape {
    createdAt: number;
    finish: string | null;
    error: unknown;
    outputTokens: number | null;
    reasoningTokens: number | null;
}

/** A provider transport failure that arrived as an ordinary assistant completion. */
export class DreamerProviderOutputFailureError extends Error {
    readonly transient = true;

    constructor(
        readonly fingerprint: string,
        readonly outputTokens: number,
        readonly reasoningTokens: number,
        responseText: string,
    ) {
        const preview = responseText.trim().replace(/\s+/g, " ").slice(0, 160);
        super(
            `dreamer provider-outage completion (output_tokens=${outputTokens}, reasoning_tokens=${reasoningTokens}): ${JSON.stringify(preview)}`,
        );
        this.name = "DreamerProviderOutputFailureError";
    }
}

/** The auth adapter emits this entire notice as assistant text, not a host error.
 * Recognize the failed completion, but never infer a reset deadline from prose. */
export function isAccountPoolQuotaNotice(responseText: string): boolean {
    return /^All [1-9]\d* account\(s\) rate-limited for [\w.-]+\. Quota resets in (?:\d+[hms] ?)+\. Add more accounts with `opencode auth login` or wait and retry\.$/.test(
        responseText.trim(),
    );
}

function finiteTokenCount(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function completionShape(value: unknown): AssistantCompletionShape | null {
    if (!isRecord(value)) return null;
    const info = isRecord(value.info) ? value.info : value;
    if (info.role !== "assistant") return null;

    const time = isRecord(info.time) ? info.time : null;
    const tokens = isRecord(info.tokens) ? info.tokens : null;
    return {
        createdAt: typeof time?.created === "number" ? time.created : 0,
        finish:
            typeof info.finish === "string"
                ? info.finish
                : typeof info.finish_reason === "string"
                  ? info.finish_reason
                  : typeof info.finishReason === "string"
                    ? info.finishReason
                    : null,
        error: info.error,
        outputTokens: finiteTokenCount(tokens?.output),
        reasoningTokens: finiteTokenCount(tokens?.reasoning),
    };
}

function latestAssistantCompletion(messages: unknown): AssistantCompletionShape | null {
    if (!Array.isArray(messages)) return null;
    let latest: AssistantCompletionShape | null = null;
    for (const message of messages) {
        const completion = completionShape(message);
        if (completion && (!latest || completion.createdAt >= latest.createdAt))
            latest = completion;
    }
    return latest;
}

/**
 * OpenCode can serialize a provider outage as a successful `finish=stop` assistant
 * message. Only classify that shape after manifest validation has already failed:
 * a real manifest remains authoritative regardless of its token counts.
 */
export function providerOutputFailureFromInvalidManifest(
    messages: unknown,
    responseText: string,
): DreamerProviderOutputFailureError | null {
    const completion = latestAssistantCompletion(messages);
    if (completion?.finish?.toLowerCase() !== "stop") return null;
    if (
        completion.error != null ||
        completion.outputTokens === null ||
        completion.reasoningTokens !== 0
    ) {
        return null;
    }

    const normalized = responseText.trim().replace(/\s+/g, " ").toLowerCase();
    if (!normalized) return null;
    if (
        !isAccountPoolQuotaNotice(responseText) &&
        completion.outputTokens > MAX_NEAR_ZERO_OUTPUT_TOKENS
    )
        return null;
    const fingerprint = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
    return new DreamerProviderOutputFailureError(
        fingerprint,
        completion.outputTokens,
        completion.reasoningTokens,
        responseText,
    );
}
