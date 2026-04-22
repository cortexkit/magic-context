import { log } from "../../../shared/logger";
import type { EmbeddingProvider } from "./embedding-provider";

interface OpenAICompatibleEmbeddingProviderOptions {
    endpoint?: string;
    model?: string;
    apiKey?: string;
}

interface EmbeddingResponseBody {
    data?: Array<{
        embedding?: number[];
    }>;
}

function normalizeEndpoint(endpoint?: string): string {
    return endpoint?.trim().replace(/\/+$/, "") ?? "";
}

/**
 * Circuit breaker constants. Shared across all callers of this provider so a
 * hung/saturated endpoint (e.g., LMStudio overloaded by parallel council
 * subagents) cannot keep dragging every plugin operation through its timeout.
 *
 * State machine (canonical three-state):
 *   - CLOSED:     issue requests; track failures in a rolling window. After
 *                 FAILURE_THRESHOLD failures within FAILURE_WINDOW_MS → OPEN.
 *   - OPEN:       short-circuit every call and return nulls immediately, no
 *                 HTTP. After OPEN_DURATION_MS elapses → HALF_OPEN.
 *   - HALF_OPEN:  let exactly ONE call through as a probe. Any other caller
 *                 during the probe short-circuits (no stampede on recovery).
 *                 Probe success → CLOSED; probe failure → OPEN immediately
 *                 for another OPEN_DURATION_MS.
 *
 * Design notes:
 *   - The half-open probe uses `halfOpenProbeInFlight` to prevent concurrent
 *     callers from all sending real requests the moment the open timer elapses
 *     (stampede). Only the first caller becomes the probe; the rest short-
 *     circuit as if the circuit were still OPEN.
 *   - A single failure on the probe re-opens the circuit. This matches the
 *     canonical pattern: if the probe fails, the endpoint is still sick.
 *   - On success, we fully close and reset failure counters.
 */
const FAILURE_THRESHOLD = 3;
const FAILURE_WINDOW_MS = 60_000;
const OPEN_DURATION_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 30_000;

type CircuitState = "closed" | "open" | "half_open";

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
    readonly modelId: string;

    private readonly endpoint: string;
    private readonly model: string;
    private readonly apiKey: string;
    private initialized = false;

    // Circuit breaker state (per provider instance — resets when config
    // changes because a new provider instance is created).
    private failureTimes: number[] = [];
    private circuitOpenUntil = 0;
    private openLogged = false;
    /** True while a half-open probe is in flight. Only the caller who set this
     *  to true is allowed to make a real HTTP call; everyone else short-
     *  circuits as if the circuit were still OPEN. */
    private halfOpenProbeInFlight = false;

    constructor(options: OpenAICompatibleEmbeddingProviderOptions) {
        this.endpoint = normalizeEndpoint(options.endpoint);
        this.model = options.model?.trim() ?? "";
        this.apiKey = options.apiKey?.trim() ?? "";
        this.modelId = `openai-compat:${this.endpoint}:${this.model}`;
    }

    async initialize(): Promise<boolean> {
        if (this.initialized) return true;
        if (!this.endpoint || !this.model) {
            log(
                "[magic-context] openai-compatible embedding provider is missing endpoint or model",
            );
            this.initialized = false;
            return false;
        }

        this.initialized = true;
        return true;
    }

    async embed(text: string, signal?: AbortSignal): Promise<Float32Array | null> {
        const [embedding] = await this.embedBatch([text], signal);
        return embedding ?? null;
    }

    async embedBatch(texts: string[], signal?: AbortSignal): Promise<(Float32Array | null)[]> {
        if (texts.length === 0) {
            return [];
        }

        if (!(await this.initialize())) {
            return Array.from({ length: texts.length }, () => null);
        }

        // Pre-flight: caller already gave up? Don't bother making a request.
        if (signal?.aborted) {
            return Array.from({ length: texts.length }, () => null);
        }

        // Circuit check — and, if transitioning to half-open, claim the probe slot.
        // Both the claim AND the AbortController setup run inside try/finally so
        // that the half-open probe slot is guaranteed to be released even if any
        // intermediate step throws. Previously the claim was outside the try,
        // which was safe in practice (non-throwable code between claim and try)
        // but structurally fragile — a future refactor could introduce a throw
        // point and permanently wedge the circuit in half-open.
        let isProbe = false;
        let internalController: AbortController | undefined;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        let onOuterAbort: (() => void) | undefined;

        try {
            const claim = this.claimProbeOrShortCircuit();
            if (claim === "short_circuit") {
                return Array.from({ length: texts.length }, () => null);
            }
            isProbe = claim === "probe";
            // Set up an AbortController that fires on EITHER the caller's
            // signal OR our internal fetch timeout. This lets a 3s auto-search
            // timeout cancel the underlying HTTP POST instead of leaving it
            // dangling for the full 30s FETCH_TIMEOUT_MS.
            internalController = new AbortController();
            timeoutHandle = setTimeout(() => internalController?.abort(), FETCH_TIMEOUT_MS);
            onOuterAbort = () => internalController?.abort();
            if (signal) {
                signal.addEventListener("abort", onOuterAbort, { once: true });
            }

            const response = await fetch(`${this.endpoint}/embeddings`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
                },
                body: JSON.stringify({
                    model: this.model,
                    input: texts,
                }),
                signal: internalController.signal,
            });

            if (!response.ok) {
                log(
                    `[magic-context] openai-compatible embedding request failed: ${response.status} ${response.statusText}`,
                );
                this.recordFailure(isProbe);
                return Array.from({ length: texts.length }, () => null);
            }

            const body = (await response.json()) as EmbeddingResponseBody;
            const items = Array.isArray(body.data) ? body.data : [];

            const results = Array.from({ length: texts.length }, (_, index) => {
                const embedding = items[index]?.embedding;
                return Array.isArray(embedding) ? Float32Array.from(embedding) : null;
            });

            // A response with no usable vectors is still a failure — the
            // endpoint is up but not actually embedding.
            if (results.every((r) => r === null)) {
                this.recordFailure(isProbe);
            } else {
                this.recordSuccess();
            }

            return results;
        } catch (error) {
            // AbortError (our fetch timeout or outer caller abort) lands here too.
            const isAbort =
                error instanceof Error &&
                (error.name === "AbortError" || error.message.includes("aborted"));
            if (isAbort) {
                // Distinguish outer-caller abort (not our problem — don't penalize
                // the endpoint) from our internal timeout (endpoint is slow).
                if (signal?.aborted) {
                    // Caller gave up. Don't count this against the endpoint.
                    // Half-open probe slot is released without state change so
                    // the next real call can probe again.
                } else {
                    log(
                        `[magic-context] openai-compatible embedding request timed out after ${FETCH_TIMEOUT_MS}ms`,
                    );
                    this.recordFailure(isProbe);
                }
            } else {
                log("[magic-context] openai-compatible embedding request failed:", error);
                this.recordFailure(isProbe);
            }
            return Array.from({ length: texts.length }, () => null);
        } finally {
            if (timeoutHandle !== undefined) {
                clearTimeout(timeoutHandle);
            }
            if (signal && onOuterAbort) {
                signal.removeEventListener("abort", onOuterAbort);
            }
            if (isProbe) {
                this.halfOpenProbeInFlight = false;
            }
        }
    }

    async dispose(): Promise<void> {
        this.initialized = false;
    }

    isLoaded(): boolean {
        return this.initialized;
    }

    /**
     * Decide what this caller should do:
     *   - "allow":         CLOSED — proceed with a real request, not as a probe
     *   - "probe":         HALF_OPEN — this caller owns the probe slot
     *   - "short_circuit": OPEN or half-open probe already in flight — return nulls
     *
     * Claiming the probe slot (setting `halfOpenProbeInFlight = true`) is done
     * here, synchronously, so concurrent callers see the flag and short-circuit.
     */
    private claimProbeOrShortCircuit(): "allow" | "probe" | "short_circuit" {
        if (this.circuitOpenUntil === 0) {
            // CLOSED — normal operation.
            return "allow";
        }
        if (Date.now() < this.circuitOpenUntil) {
            // OPEN — short-circuit.
            return "short_circuit";
        }
        // Open timer elapsed — transition to HALF_OPEN.
        if (this.halfOpenProbeInFlight) {
            // Someone else is already probing; short-circuit.
            return "short_circuit";
        }
        // Claim the probe slot. Do NOT reset circuitOpenUntil yet — that
        // happens on probe success via recordSuccess(). If the probe fails,
        // recordFailure() will push circuitOpenUntil forward.
        this.halfOpenProbeInFlight = true;
        log("[magic-context] openai-compatible embedding: circuit half-open, probing endpoint");
        return "probe";
    }

    private recordFailure(isProbe: boolean): void {
        if (isProbe) {
            // Canonical half-open: single probe failure re-opens the circuit.
            this.circuitOpenUntil = Date.now() + OPEN_DURATION_MS;
            if (!this.openLogged) {
                log(
                    `[magic-context] openai-compatible embedding: probe failed, re-opening circuit for ${OPEN_DURATION_MS / 60_000}min`,
                );
                this.openLogged = true;
            }
            this.failureTimes = [];
            return;
        }

        const now = Date.now();
        const cutoff = now - FAILURE_WINDOW_MS;
        this.failureTimes = this.failureTimes.filter((t) => t > cutoff);
        this.failureTimes.push(now);

        if (this.failureTimes.length >= FAILURE_THRESHOLD) {
            this.circuitOpenUntil = now + OPEN_DURATION_MS;
            if (!this.openLogged) {
                log(
                    `[magic-context] openai-compatible embedding: opening circuit for ${OPEN_DURATION_MS / 60_000}min after ${this.failureTimes.length} failures in ${FAILURE_WINDOW_MS / 1_000}s`,
                );
                this.openLogged = true;
            }
            // Clear the window; when the circuit half-opens later we start
            // counting fresh.
            this.failureTimes = [];
        }
    }

    private recordSuccess(): void {
        if (this.failureTimes.length > 0 || this.circuitOpenUntil > 0 || this.openLogged) {
            log("[magic-context] openai-compatible embedding: endpoint recovered, circuit closed");
        }
        this.failureTimes = [];
        this.circuitOpenUntil = 0;
        this.openLogged = false;
    }

    // Test-only hooks.
    _getCircuitState(): CircuitState {
        if (this.circuitOpenUntil === 0) return "closed";
        if (Date.now() < this.circuitOpenUntil) {
            return this.halfOpenProbeInFlight ? "half_open" : "open";
        }
        // Timer elapsed but no probe has been issued yet — logically half-open.
        return "half_open";
    }
    _getFailureCount(): number {
        return this.failureTimes.length;
    }
    _resetCircuit(): void {
        this.failureTimes = [];
        this.circuitOpenUntil = 0;
        this.openLogged = false;
        this.halfOpenProbeInFlight = false;
    }
}
