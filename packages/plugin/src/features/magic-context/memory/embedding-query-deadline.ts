const QUERY_EMBEDDING_TIMEOUT_MS = 5_000;

/** An embedding budget expiry is endpoint slowness, not caller cancellation. */
export class EmbeddingQueryTimeoutError extends Error {
    readonly timeoutMs = QUERY_EMBEDDING_TIMEOUT_MS;

    constructor() {
        super(`query embedding timed out after ${QUERY_EMBEDDING_TIMEOUT_MS}ms`);
        this.name = "EmbeddingQueryTimeoutError";
    }
}

/** Bound explicit search's semantic lane without cancelling its keyword lanes. */
export async function withQueryEmbeddingDeadline<T>(
    embed: (signal: AbortSignal) => Promise<T | null>,
    signal?: AbortSignal,
): Promise<T | null> {
    if (signal?.aborted) return null;
    const deadline = new AbortController();
    const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<null>((resolve) => {
        onAbort = () => resolve(null);
        combined.addEventListener("abort", onAbort, { once: true });
    });
    const timer = setTimeout(
        () => deadline.abort(new EmbeddingQueryTimeoutError()),
        QUERY_EMBEDDING_TIMEOUT_MS,
    );
    try {
        return await Promise.race([embed(combined), aborted]);
    } finally {
        clearTimeout(timer);
        if (onAbort) combined.removeEventListener("abort", onAbort);
    }
}
