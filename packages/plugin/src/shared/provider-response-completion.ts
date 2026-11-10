import { isRecord } from "./record-type-guard";

const SERVER_FALLBACK_USAGE_SIGNATURE_PREFIX = "cortexkit-server-fallback-usage-v1:";
const SERVER_FALLBACK_SIGNATURE_PREFIX = "cortexkit-server-fallback-v1:";

export function hasServerFallbackUsage(content: unknown): boolean {
    return readServerFallbackUsage(content) !== undefined;
}

type ServerFallbackUsage =
    | { kind: "usage"; inputTokens: number }
    | { kind: "boundary"; invalidUsage: boolean };

function parseServerFallbackInputTokens(json: string): number | undefined {
    try {
        const payload: unknown = JSON.parse(json);
        if (!isRecord(payload) || !Array.isArray(payload.iterations)) return undefined;
        let last: unknown;
        for (const entry of payload.iterations) {
            if (isRecord(entry) && entry.type === "fallback_message") last = entry;
        }
        if (!isRecord(last)) return undefined;
        const counts = [
            last.input_tokens,
            last.cache_read_input_tokens ?? 0,
            last.cache_creation_input_tokens ?? 0,
        ];
        if (
            !counts.every(
                (count) => typeof count === "number" && Number.isFinite(count) && count >= 0,
            )
        )
            return undefined;
        const inputTokens = counts.reduce<number>((sum, count) => sum + Number(count), 0);
        return Number.isFinite(inputTokens) ? inputTokens : undefined;
    } catch {
        // Invalid usage must not replace the previous pressure measurement.
        return undefined;
    }
}

export function readServerFallbackUsage(content: unknown): ServerFallbackUsage | undefined {
    if (!Array.isArray(content)) return undefined;
    let boundary = false;
    let invalidUsage = false;
    for (const part of content) {
        if (!isRecord(part) || part.type !== "reasoning") continue;
        for (const location of [part.native, part.state]) {
            if (!isRecord(location) || typeof location.signature !== "string") continue;
            const signature = location.signature;
            if (signature.startsWith(SERVER_FALLBACK_USAGE_SIGNATURE_PREFIX)) {
                const inputTokens = parseServerFallbackInputTokens(
                    signature.slice(SERVER_FALLBACK_USAGE_SIGNATURE_PREFIX.length),
                );
                if (inputTokens !== undefined) return { kind: "usage", inputTokens };
                invalidUsage = true;
            } else if (signature.startsWith(SERVER_FALLBACK_SIGNATURE_PREFIX)) {
                boundary = true;
            }
        }
    }
    return boundary || invalidUsage ? { kind: "boundary", invalidUsage } : undefined;
}

/** Failure markers take precedence over a completion timestamp or token usage. */
export function providerResponseFailed(input: { finish?: unknown; error?: unknown }): boolean {
    if (input.error !== undefined && input.error !== null && input.error !== "") return true;
    const finish = typeof input.finish === "string" ? input.finish.trim().toLowerCase() : "";
    return ["error", "failed", "abort", "aborted", "interrupted", "cancelled", "canceled"].includes(
        finish,
    );
}

/** A terminal, non-failed assistant response can refresh a cache without usage. */
export function isSuccessfulProviderCompletion(input: {
    completedAt?: unknown;
    finish?: unknown;
    error?: unknown;
}): boolean {
    if (providerResponseFailed(input)) return false;
    return (
        (typeof input.completedAt === "number" &&
            Number.isFinite(input.completedAt) &&
            input.completedAt > 0) ||
        (typeof input.finish === "string" && input.finish.trim().length > 0)
    );
}
