import { isRecord } from "./record-type-guard";

export function hasServerFallbackUsage(content: unknown): boolean {
    return (
        Array.isArray(content) &&
        content.some(
            (part) =>
                isRecord(part) &&
                part.type === "reasoning" &&
                isRecord(part.native) &&
                typeof part.native.signature === "string" &&
                part.native.signature.startsWith("cortexkit-server-fallback-v1:"),
        )
    );
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
