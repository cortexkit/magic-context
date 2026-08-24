import type { EmbeddingFailure } from "../../features/magic-context/memory/embedding-failure";

export function formatEmbedFailureSummary(
    embedded: number,
    remaining: number,
    failure?: EmbeddingFailure,
): string {
    const compartment = `compartment${embedded === 1 ? "" : "s"}`;
    if (!failure) {
        return `Embedded ${embedded} ${compartment}; ${remaining} could not be embedded (the provider returned no result). Run /ctx-embed start again to retry them.`;
    }

    const retry = " Run /ctx-embed start again to retry them.";
    switch (failure.class) {
        case "substitution_rejected":
            return `Embedded ${embedded} ${compartment}; ${remaining} rejected: ${failure.reason}. Fix: set embedding.model to the served spelling.`;
        case "http_error": {
            const fix =
                failure.reason.startsWith("HTTP 401") || failure.reason.startsWith("HTTP 403")
                    ? " Fix: check embedding.api_key."
                    : failure.reason.startsWith("HTTP 402")
                      ? " Fix: check provider quota or billing."
                      : failure.reason.startsWith("HTTP 404")
                        ? " Fix: check embedding.endpoint and embedding.model."
                        : failure.retryable
                          ? retry
                          : " Fix: check embedding.endpoint, embedding.model, and credentials.";
            return `Embedded ${embedded} ${compartment}; ${remaining} failed: ${failure.reason}.${fix}`;
        }
        case "invalid_envelope":
            return `Embedded ${embedded} ${compartment}; ${remaining} failed: ${failure.reason}. Fix: configure an OpenAI-compatible embedding endpoint that returns data[].embedding.`;
        case "empty_result":
        case "transport_error":
            return `Embedded ${embedded} ${compartment}; ${remaining} failed: ${failure.reason}.${failure.retryable ? retry : ""}`;
    }
}
