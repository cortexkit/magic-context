import { AsyncLocalStorage } from "node:async_hooks";
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
        readonly quotaResetAt?: number,
    ) {
        const preview = responseText.trim().replace(/\s+/g, " ").slice(0, 160);
        super(
            quotaResetAt !== undefined
                ? `provider quota exhausted until ${new Date(quotaResetAt).toISOString()} (account-pool rate limit)`
                : `dreamer provider-outage completion (output_tokens=${outputTokens}, reasoning_tokens=${reasoningTokens}): ${JSON.stringify(preview)}`,
        );
        this.name = "DreamerProviderOutputFailureError";
    }
}

// Concurrent maintenance runs must not share provider health, and a new run
// must re-probe its configured primary. Nested verify batches inherit the scope.
const primaryQuotas = new AsyncLocalStorage<Map<string, DreamerProviderOutputFailureError>>();

export function withDreamerModelCooldown<T>(run: () => T): T {
    return primaryQuotas.getStore() ? run() : primaryQuotas.run(new Map(), run);
}

export function rememberPrimaryQuota(
    model: string,
    error: unknown,
): DreamerProviderOutputFailureError | null {
    const quotas = primaryQuotas.getStore();
    if (
        !quotas ||
        model === "primary" ||
        !(error instanceof DreamerProviderOutputFailureError) ||
        error.quotaResetAt === undefined ||
        error.quotaResetAt <= Date.now()
    )
        return null;
    const cached = new DreamerProviderOutputFailureError(
        error.fingerprint,
        error.outputTokens,
        error.reasoningTokens,
        "",
        error.quotaResetAt,
    );
    cached.message = error.message;
    quotas.set(model, cached);
    return error;
}

export function primaryQuotaFailure(model: string): DreamerProviderOutputFailureError | null {
    const quotas = primaryQuotas.getStore();
    const error = quotas?.get(model);
    if (!error) return null;
    if (error.quotaResetAt === undefined || error.quotaResetAt <= Date.now()) {
        quotas?.delete(model);
        return null;
    }
    const failure = new DreamerProviderOutputFailureError(
        error.fingerprint,
        error.outputTokens,
        error.reasoningTokens,
        "",
        error.quotaResetAt,
    );
    failure.message = error.message;
    return failure;
}

/** The auth adapter emits this entire notice as assistant text, not a host error.
 * Match the envelope, never a quoted notice inside a real manifest or narration. */
function quotaResetAt(responseText: string, now: number): number | undefined {
    const notice =
        /^All [1-9]\d* account\(s\) rate-limited for [\w.-]+\. Quota resets in ((?:\d+[hms] ?)+)\. Add more accounts with `opencode auth login` or wait and retry\.$/.exec(
            responseText.trim(),
        );
    if (!notice) return undefined;
    const units: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1_000 };
    const duration = [...notice[1].matchAll(/(\d+)([hms])/g)].reduce(
        (sum, match) => sum + Number(match[1]) * units[match[2]],
        0,
    );
    const resetAt = now + duration;
    return duration > 0 && Number.isSafeInteger(resetAt) && resetAt < 8.64e15 ? resetAt : undefined;
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
    now = Date.now(),
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
    const resetAt = quotaResetAt(responseText, now);
    if (resetAt === undefined && completion.outputTokens > MAX_NEAR_ZERO_OUTPUT_TOKENS) return null;
    const fingerprint = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
    return new DreamerProviderOutputFailureError(
        fingerprint,
        completion.outputTokens,
        completion.reasoningTokens,
        responseText,
        resetAt,
    );
}
