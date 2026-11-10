/**
 * Live verification of an OpenAI-compatible embeddings endpoint.
 *
 * Used by `doctor` (Node) and shared in spirit with the dashboard Rust
 * `test_embedding_endpoint` command — both POST `{model, input}` to
 * `${endpoint}/embeddings` and classify the response. Keeping the two
 * implementations parallel is intentional: doctor runs in the plugin's Node
 * runtime where `fetch` + `AbortSignal.timeout` are available, while the
 * dashboard uses Rust `reqwest` for reasons of its own async stack.
 */

export type EmbeddingProbeOutcome =
    | { kind: "ok"; status: number; dimensions: number | null }
    | { kind: "dimensions_mismatch"; status: number; requested: number; returned: number }
    | { kind: "auth_failed"; status: number; preview: string }
    | { kind: "endpoint_unsupported"; status: number; preview: string }
    | { kind: "http_error"; status: number; preview: string }
    | { kind: "network_error"; message: string }
    | { kind: "timeout"; timeoutMs: number }
    | { kind: "invalid_scheme"; endpoint: string };

export interface EmbeddingProbeOptions {
    /**
     * Base endpoint (e.g. `https://api.openai.com/v1`). `/embeddings` is
     * appended by the probe. Trailing slashes are trimmed so both
     * `https://host/v1` and `https://host/v1/` work.
     */
    endpoint: string;
    model: string;
    apiKey?: string;
    /** Optional `input_type` body field — required by some providers (NVIDIA NIM)
     *  for the probe to succeed. Omitted from the body when unset. */
    inputType?: string;
    /** Optional `truncate` body field (e.g. NVIDIA NIM). Omitted when unset. */
    truncate?: string;
    /** Optional `dimensions` body field (Matryoshka output width). Omitted when
     *  unset. When set, a response of any other width is `dimensions_mismatch`:
     *  the runtime provider rejects such vectors, so the probe must too. */
    dimensions?: number;
    /** Milliseconds before aborting the request. Defaults to 10000. */
    timeoutMs?: number;
    /**
     * Optional fetch override, used only by tests to avoid hitting real
     * network endpoints. Matches the signature of the global `fetch` loosely
     * so callers can drop a mock implementation in without overloads.
     */
    fetch?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_PREVIEW_CHARS = 240;

/**
 * Probe an embeddings endpoint and classify the outcome.
 *
 * - 2xx with at least one `data[].embedding` array → `ok` with dimension count
 * - 2xx whose width differs from a requested `dimensions` → `dimensions_mismatch`
 * - 2xx without `data[].embedding` → `endpoint_unsupported` (e.g. routers
 *   that accept the URL but don't implement the embeddings spec)
 * - 401 / 403 → `auth_failed`
 * - 404 / 405 → `endpoint_unsupported` (route not available at this URL)
 * - Other non-2xx → `http_error` with preview
 * - `AbortError` from timeout → `timeout`
 * - Any other thrown error → `network_error`
 * - Missing or non-http(s) scheme → `invalid_scheme` (no request made)
 */
export async function probeEmbeddingEndpoint(
    options: EmbeddingProbeOptions,
): Promise<EmbeddingProbeOutcome> {
    const endpoint = options.endpoint.trim().replace(/\/+$/, "");
    if (!endpoint) {
        return { kind: "invalid_scheme", endpoint: options.endpoint };
    }
    if (!endpoint.startsWith("https://") && !endpoint.startsWith("http://")) {
        return { kind: "invalid_scheme", endpoint: options.endpoint };
    }

    const fetchImpl = options.fetch ?? fetch;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const url = `${endpoint}/embeddings`;

    const apiKey = options.apiKey?.trim();
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (apiKey) {
        headers.authorization = `Bearer ${apiKey}`;
    }

    // Use a short fixed probe string. Providers bill by tokens, so minimal
    // input keeps the check cheap even on metered accounts.
    const inputType = options.inputType?.trim();
    const truncateMode = options.truncate?.trim();
    const requestedDimensions =
        typeof options.dimensions === "number" &&
        Number.isInteger(options.dimensions) &&
        options.dimensions > 0
            ? options.dimensions
            : undefined;
    const body = JSON.stringify({
        model: options.model,
        input: "magic-context probe",
        ...(inputType ? { input_type: inputType } : {}),
        ...(truncateMode ? { truncate: truncateMode } : {}),
        ...(requestedDimensions ? { dimensions: requestedDimensions } : {}),
    });

    let response: Response;
    try {
        response = await fetchImpl(url, {
            method: "POST",
            headers,
            body,
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") {
            return { kind: "timeout", timeoutMs };
        }
        // DOMException with name "AbortError" — older runtimes raise this
        // instead of TimeoutError for AbortSignal.timeout().
        if (error instanceof Error && error.name === "AbortError") {
            return { kind: "timeout", timeoutMs };
        }
        return {
            kind: "network_error",
            message: error instanceof Error ? error.message : String(error),
        };
    }

    const status = response.status;

    if (response.ok) {
        let parsed: unknown = null;
        try {
            parsed = await response.json();
        } catch {
            // 200 with non-JSON body — endpoint accepted the URL but didn't
            // speak the embeddings protocol. Classify as unsupported so the
            // caller can suggest a different provider.
            return { kind: "endpoint_unsupported", status, preview: "" };
        }

        const dimensions = extractDimensions(parsed);
        if (dimensions === null) {
            return {
                kind: "endpoint_unsupported",
                status,
                preview: await readPreview(parsed),
            };
        }
        if (requestedDimensions !== undefined && dimensions !== requestedDimensions) {
            return {
                kind: "dimensions_mismatch",
                status,
                requested: requestedDimensions,
                returned: dimensions,
            };
        }
        return { kind: "ok", status, dimensions };
    }

    const preview = await previewErrorBody(response);

    if (status === 401 || status === 403) {
        return { kind: "auth_failed", status, preview };
    }
    if (status === 404 || status === 405) {
        return { kind: "endpoint_unsupported", status, preview };
    }
    return { kind: "http_error", status, preview };
}

function extractDimensions(body: unknown): number | null {
    if (!body || typeof body !== "object") return null;
    const data = (body as { data?: unknown }).data;
    if (!Array.isArray(data) || data.length === 0) return null;
    const first = data[0];
    if (!first || typeof first !== "object") return null;
    const embedding = (first as { embedding?: unknown }).embedding;
    if (!Array.isArray(embedding) || embedding.length === 0) return null;
    // Defensive: ensure at least the first entry is a finite number. A valid
    // embedding is a dense float array, so if the first entry is anything
    // else the response shape is wrong.
    const sample = embedding[0];
    if (typeof sample !== "number" || !Number.isFinite(sample)) return null;
    return embedding.length;
}

async function previewErrorBody(response: Response): Promise<string> {
    try {
        const text = await response.text();
        return truncate(text);
    } catch {
        return "";
    }
}

async function readPreview(parsed: unknown): Promise<string> {
    try {
        return truncate(JSON.stringify(parsed));
    } catch {
        return "";
    }
}

function truncate(text: string): string {
    if (text.length <= MAX_PREVIEW_CHARS) return text;
    return `${text.slice(0, MAX_PREVIEW_CHARS)}…`;
}
