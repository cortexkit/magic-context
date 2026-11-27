import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import * as logger from "../../../shared/logger";
import { normalizeCompartmentChunkMaxInputTokens } from "../compartment-chunk-embedding";
import {
    _resetOpenAICompatibleEmbeddingStateForTests,
    OpenAICompatibleEmbeddingProvider,
    parseRetryAfterMs,
    rateLimitBackoffMs,
} from "./embedding-openai";

/** One scripted reply: the HTTP status plus optional headers. 200 sends vectors. */
interface ScriptedReply {
    status: number;
    headers?: Record<string, string>;
}

interface FakeEmbeddingServer {
    endpoint: string;
    /** Arrival time (epoch ms) of every request the server received. */
    arrivals: number[];
    stop(): void;
}

/**
 * Local fake `/embeddings` server. `reply(n)` scripts the n-th request
 * (0-based); a 200 answers one vector per input.
 */
function startFakeEmbeddingServer(reply: (index: number) => ScriptedReply): FakeEmbeddingServer {
    const arrivals: number[] = [];
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
            const index = arrivals.length;
            arrivals.push(Date.now());
            const body = (await request.json()) as { input: string[]; model: string };
            const scripted = reply(index);
            if (scripted.status !== 200) {
                return new Response("slow down", {
                    status: scripted.status,
                    headers: scripted.headers,
                });
            }
            return Response.json({
                model: body.model,
                data: body.input.map((_, i) => ({ index: i, embedding: [0.1, 0.2, i] })),
            });
        },
    });
    return {
        endpoint: `http://127.0.0.1:${server.port}/v1`,
        arrivals,
        stop: () => server.stop(true),
    };
}

function providerFor(endpoint: string, maxInputTokens?: number): OpenAICompatibleEmbeddingProvider {
    return new OpenAICompatibleEmbeddingProvider({
        endpoint,
        model: "voyage-4",
        apiKey: "test-key",
        ...(maxInputTokens === undefined ? {} : { maxInputTokens }),
    });
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error("condition not reached in time");
        await Bun.sleep(5);
    }
}

const flushEmbeddings = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("OpenAICompatibleEmbeddingProvider HTTP 429 back-pressure", () => {
    let server: FakeEmbeddingServer | undefined;

    beforeEach(() => {
        _resetOpenAICompatibleEmbeddingStateForTests();
    });
    afterEach(() => {
        jest.useRealTimers();
        server?.stop();
        server = undefined;
        _resetOpenAICompatibleEmbeddingStateForTests();
    });

    test("background batch waits out Retry-After, sends nothing during the cooldown, then succeeds", async () => {
        server = startFakeEmbeddingServer((index) =>
            index === 0 ? { status: 429, headers: { "Retry-After": "2" } } : { status: 200 },
        );
        const provider = providerFor(server.endpoint, 8_000);

        const first = provider.embedBatch(["alpha", "beta"]);
        await waitFor(() => provider._getRateLimitedUntil() > 0);
        // A second background batch issued during the cooldown must also wait.
        const second = provider.embedBatch(["gamma"], undefined, "passage");

        const [firstVectors, secondVectors] = await Promise.all([first, second]);

        expect(firstVectors.every((vector) => vector !== null)).toBe(true);
        expect(secondVectors.every((vector) => vector !== null)).toBe(true);
        const [rateLimitedAt, ...afterCooldown] = server.arrivals;
        expect(afterCooldown).toHaveLength(2);
        // Zero requests inside the 2 s window that Retry-After asked for.
        for (const arrival of afterCooldown) {
            expect(arrival - (rateLimitedAt as number)).toBeGreaterThanOrEqual(1_990);
        }
        expect(provider._getCircuitState()).toBe("closed");
        expect(provider._getFailureCount()).toBe(0);
        expect(provider.getLastFailureReason()).toBeNull();
    });

    test("429s never count toward the circuit breaker", async () => {
        server = startFakeEmbeddingServer(() => ({
            status: 429,
            headers: { "Retry-After": "30" },
        }));
        const provider = providerFor(server.endpoint, 8_000);

        // Each round simulates a fresh cooldown expiry, so every query reaches
        // the endpoint and is rate limited again: five 429s in well under 60 s.
        for (let round = 0; round < 5; round++) {
            _resetOpenAICompatibleEmbeddingStateForTests();
            expect(await provider.embed(`query ${round}`, undefined, "query")).toBeNull();
        }

        expect(server.arrivals).toHaveLength(5);
        expect(provider._getFailureCount()).toBe(0);
        expect(provider._getCircuitState()).toBe("closed");
        expect(provider.getLastFailureReason()).toBeNull();
    });

    test("background batches keep deferring repeated 429s instead of failing or hot-retrying", async () => {
        const limitedResponses = 4;
        server = startFakeEmbeddingServer((index) =>
            index < limitedResponses
                ? { status: 429, headers: { "Retry-After": "1" } }
                : { status: 200 },
        );
        const provider = providerFor(server.endpoint, 8_000);
        jest.useFakeTimers({ doNotFake: ["setImmediate"] });
        const started = Date.now();
        let cooldown = Promise.withResolvers<void>();
        const logged = spyOn(logger, "log").mockImplementation((message) => {
            if (message.includes("rate limited (HTTP 429)")) cooldown.resolve();
        });
        const batch = provider.embedBatch(["stored passage"]);
        try {
            for (let index = 0; index < limitedResponses; index++) {
                // The endpoint replied and the client recorded the cooldown.
                expect(
                    await Promise.race([
                        cooldown.promise.then(() => true),
                        batch.then(() => false),
                    ]),
                ).toBe(true);
                cooldown = Promise.withResolvers<void>();
                await flushEmbeddings();
                expect(provider._getRateLimitedUntil()).toBe(started + (index + 1) * 1_000);
                jest.advanceTimersByTime(999);
                await flushEmbeddings();
                expect(server.arrivals).toHaveLength(index + 1);
                jest.advanceTimersByTime(1);
            }
        } finally {
            logged.mockRestore();
        }
        const vectors = await batch;
        expect(vectors[0]).not.toBeNull();
        expect(server.arrivals).toEqual([
            started,
            started + 1_000,
            started + 2_000,
            started + 3_000,
            started + 4_000,
        ]);
        expect(provider._getCircuitState()).toBe("closed");
        expect(provider._getFailureCount()).toBe(0);
        expect(provider.getLastFailureReason()).toBeNull();
    });

    test("a query during a cooldown returns no vector at once and is not counted", async () => {
        server = startFakeEmbeddingServer((index) =>
            index === 0 ? { status: 429, headers: { "Retry-After": "30" } } : { status: 200 },
        );
        const provider = providerFor(server.endpoint, 8_000);
        jest.useFakeTimers({ doNotFake: ["setImmediate"] });

        // The query that hits the 429 itself does not wait for the cooldown.
        const firstStarted = Date.now();
        expect(await provider.embed("first query", undefined, "query")).toBeNull();
        expect(Date.now()).toBe(firstStarted);
        expect(provider._getRateLimitedUntil()).toBe(firstStarted + 30_000);
        expect(server.arrivals).toHaveLength(1);

        const failuresBefore = provider._getFailureCount();
        let query: Float32Array | null | undefined;
        const during = provider.embed("during cooldown", undefined, "query").then((vector) => {
            query = vector;
        });
        await flushEmbeddings();
        expect(query).toBeNull();
        await during;
        expect(server.arrivals).toHaveLength(1);
        expect(provider._getFailureCount()).toBe(failuresBefore);
        expect(provider._getCircuitState()).toBe("closed");

        // The cooldown a query noticed holds back background work, including
        // another provider instance (another project) on the same endpoint and key.
        const sibling = providerFor(server.endpoint, 8_000);
        const controller = new AbortController();
        let result: (Float32Array | null)[] | undefined;
        const background = sibling
            .embedBatch(["stored text"], controller.signal)
            .then((vectors) => {
                result = vectors;
            });
        await flushEmbeddings();
        jest.advanceTimersByTime(50);
        await flushEmbeddings();
        expect(result).toBeUndefined();
        expect(server.arrivals).toHaveLength(1);
        controller.abort();
        await flushEmbeddings();
        expect(result).toEqual([null]);
        expect(Date.now()).toBe(firstStarted + 50);
        await background;
        expect(server.arrivals).toHaveLength(1);
    });

    test("background passage batches yield after eight 429 responses without tripping the breaker", async () => {
        server = startFakeEmbeddingServer((index) =>
            index < 8 ? { status: 429, headers: { "Retry-After": "0.001" } } : { status: 200 },
        );
        const provider = providerFor(server.endpoint, 8_000);
        expect(await provider.embedBatch(["stored passage"])).toEqual([null]);
        expect(server.arrivals).toHaveLength(8);
        expect(provider._getCircuitState()).toBe("closed");
        expect(provider._getFailureCount()).toBe(0);
        expect(await provider.embedBatch(["stored passage"])).not.toEqual([null]);
    });

    test("429 without Retry-After starts a 1 s jittered backoff", async () => {
        server = startFakeEmbeddingServer(() => ({ status: 429 }));
        const provider = providerFor(server.endpoint, 8_000);

        const before = Date.now();
        expect(await provider.embed("query", undefined, "query")).toBeNull();
        const after = Date.now();
        const until = provider._getRateLimitedUntil();
        expect(until - after).toBeGreaterThanOrEqual(1_000 - (after - before));
        expect(until - before).toBeLessThanOrEqual(1_250 + (after - before));
    });

    test("one log line per cooldown, not per rate-limited call", async () => {
        server = startFakeEmbeddingServer(() => ({
            status: 429,
            headers: { "Retry-After": "1" },
        }));
        const provider = providerFor(server.endpoint, 8_000);
        const logSpy = spyOn(logger, "log").mockImplementation(() => {});
        try {
            // All three are sent before any 429 comes back, so all three are
            // rate limited; only the first starts the cooldown.
            await Promise.all([
                provider.embed("a", undefined, "query"),
                provider.embed("b", undefined, "query"),
                provider.embed("c", undefined, "query"),
            ]);
            await provider.embed("d", undefined, "query");
            const rateLimitLines = logSpy.mock.calls.filter((call) =>
                String(call[0]).includes("rate limited (HTTP 429)"),
            );
            expect(server.arrivals).toHaveLength(3);
            expect(rateLimitLines).toHaveLength(1);
        } finally {
            logSpy.mockRestore();
        }
    });

    test("three HTTP 500s still open the circuit breaker", async () => {
        server = startFakeEmbeddingServer(() => ({ status: 500 }));
        const provider = providerFor(server.endpoint, 8_000);

        await provider.embed("one");
        await provider.embed("two");
        expect(provider._getCircuitState()).toBe("closed");
        await provider.embed("three");

        expect(provider._getCircuitState()).toBe("open");
        expect(server.arrivals).toHaveLength(3);
        expect(provider._getRateLimitedUntil()).toBe(0);
    });
});

describe("Retry-After parsing and backoff bounds", () => {
    test("reads delta-seconds and HTTP dates, capped at 60 s", () => {
        const now = Date.parse("2026-01-01T00:00:00Z");
        expect(parseRetryAfterMs("2", now)).toBe(2_000);
        expect(parseRetryAfterMs(" 7 ", now)).toBe(7_000);
        expect(parseRetryAfterMs("120", now)).toBe(60_000);
        expect(parseRetryAfterMs("Thu, 01 Jan 2026 00:00:05 GMT", now)).toBe(5_000);
        expect(parseRetryAfterMs("Thu, 01 Jan 2026 01:00:00 GMT", now)).toBe(60_000);
    });

    test("absent, unparseable, zero or past values fall back to backoff", () => {
        const now = Date.parse("2026-01-01T00:00:00Z");
        expect(parseRetryAfterMs(null, now)).toBeNull();
        expect(parseRetryAfterMs("", now)).toBeNull();
        expect(parseRetryAfterMs("soon", now)).toBeNull();
        expect(parseRetryAfterMs("-3", now)).toBeNull();
        expect(parseRetryAfterMs("0", now)).toBeNull();
        expect(parseRetryAfterMs("Wed, 31 Dec 2025 23:59:00 GMT", now)).toBeNull();
    });

    test("backoff doubles from 1 s, jitters by at most 25%, and never exceeds 30 s", () => {
        for (let consecutive = 0; consecutive <= 40; consecutive++) {
            const nominal = Math.min(30_000, 1_000 * 2 ** Math.min(consecutive, 30));
            const low = rateLimitBackoffMs(consecutive, () => 0);
            const high = rateLimitBackoffMs(consecutive, () => 1);
            expect(low).toBe(nominal);
            expect(high).toBe(Math.min(30_000, Math.round(nominal * 1.25)));
            expect(high).toBeLessThanOrEqual(30_000);
            for (let sample = 0; sample < 20; sample++) {
                const delay = rateLimitBackoffMs(consecutive);
                expect(delay).toBeGreaterThanOrEqual(low);
                expect(delay).toBeLessThanOrEqual(high);
            }
        }
        expect(rateLimitBackoffMs(0, () => 0)).toBe(1_000);
        expect(rateLimitBackoffMs(1, () => 0)).toBe(2_000);
        expect(rateLimitBackoffMs(5, () => 0)).toBe(30_000);
    });
});

describe("openai-compatible max_input_tokens default", () => {
    beforeEach(() => {
        _resetOpenAICompatibleEmbeddingStateForTests();
    });
    afterEach(() => {
        _resetOpenAICompatibleEmbeddingStateForTests();
    });

    test("keeps the 512 default that stored chunk identities were hashed with", () => {
        // Chunk model ids hash normalizeCompartmentChunkMaxInputTokens(config value);
        // a changed default would silently re-embed every user who never set it.
        expect(normalizeCompartmentChunkMaxInputTokens(undefined)).toBe(512);
        const logSpy = spyOn(logger, "log").mockImplementation(() => {});
        try {
            expect(providerFor("http://127.0.0.1:65535/v1").maxInputTokens).toBe(512);
            expect(providerFor("http://127.0.0.1:65535/v1", 32_000).maxInputTokens).toBe(32_000);
        } finally {
            logSpy.mockRestore();
        }
    });

    test("warns once per endpoint and model when max_input_tokens is unset", () => {
        const logSpy = spyOn(logger, "log").mockImplementation(() => {});
        try {
            providerFor("http://127.0.0.1:65535/v1");
            providerFor("http://127.0.0.1:65535/v1");
            providerFor("http://127.0.0.1:65535/v1", 32_000);
            const warnings = logSpy.mock.calls
                .map((call) => String(call[0]))
                .filter((line) => line.includes("embedding.max_input_tokens is not set"));
            expect(warnings).toHaveLength(1);
            expect(warnings[0]).toContain('"voyage-4"');
            expect(warnings[0]).not.toContain("test-key");

            logSpy.mockClear();
            providerFor("http://127.0.0.1:65534/v1", 32_000);
            expect(
                logSpy.mock.calls.some((call) =>
                    String(call[0]).includes("embedding.max_input_tokens is not set"),
                ),
            ).toBe(false);
        } finally {
            logSpy.mockRestore();
        }
    });
});
