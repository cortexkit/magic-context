export type EmbeddingFailureClass =
    | "substitution_rejected"
    | "http_error"
    | "transport_error"
    | "invalid_envelope"
    | "empty_result";

/** A classified remote-provider failure that can be surfaced to a caller safely. */
export interface EmbeddingFailure {
    class: EmbeddingFailureClass;
    /** Stable, user-facing diagnostic with only redacted response evidence. */
    reason: string;
    /** Whether the same configuration may plausibly succeed on another attempt. */
    retryable: boolean;
}

export function dominantEmbeddingFailure(
    failures: readonly EmbeddingFailure[],
): EmbeddingFailure | undefined {
    const counts = new Map<string, { failure: EmbeddingFailure; count: number }>();
    for (const failure of failures) {
        const key = `${failure.class}\u0000${failure.reason}`;
        const current = counts.get(key);
        if (current) current.count += 1;
        else counts.set(key, { failure, count: 1 });
    }

    let dominant: { failure: EmbeddingFailure; count: number } | undefined;
    for (const candidate of counts.values()) {
        if (!dominant || candidate.count > dominant.count) dominant = candidate;
    }
    return dominant?.failure;
}
