import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { OpenAICompatibleEmbeddingProvider } from "./embedding-openai";

type FetchLike = typeof fetch;

function makeProvider(): OpenAICompatibleEmbeddingProvider {
    return new OpenAICompatibleEmbeddingProvider({
        endpoint: "http://127.0.0.1:65535",
        model: "test-model",
    });
}

function successResponse(count = 1): Response {
    const body = {
        data: Array.from({ length: count }, () => ({ embedding: [0.1, 0.2, 0.3] })),
    };
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
}

function errorResponse(): Response {
    return new Response("internal", { status: 500 });
}

describe("OpenAICompatibleEmbeddingProvider circuit breaker", () => {
    let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

    beforeEach(() => {
        fetchSpy = spyOn(globalThis, "fetch");
    });

    afterEach(() => {
        fetchSpy.mockRestore();
    });

    test("opens circuit after 3 consecutive failures within window", async () => {
        fetchSpy.mockImplementation((async () => errorResponse()) as FetchLike);

        const provider = makeProvider();
        await provider.embed("one");
        await provider.embed("two");
        expect(provider._getCircuitState()).toBe("closed");
        expect(provider._getFailureCount()).toBe(2);

        await provider.embed("three");
        expect(provider._getCircuitState()).toBe("open");
    });

    test("open circuit short-circuits without issuing fetch", async () => {
        fetchSpy.mockImplementation((async () => errorResponse()) as FetchLike);

        const provider = makeProvider();
        await provider.embed("a");
        await provider.embed("b");
        await provider.embed("c");
        expect(provider._getCircuitState()).toBe("open");

        const beforeCount = fetchSpy.mock.calls.length;
        const result = await provider.embed("d");
        expect(result).toBeNull();
        expect(fetchSpy.mock.calls.length).toBe(beforeCount); // no new fetch
    });

    test("success resets failure counters", async () => {
        let fail = true;
        fetchSpy.mockImplementation((async () =>
            fail ? errorResponse() : successResponse()) as FetchLike);

        const provider = makeProvider();
        await provider.embed("x");
        await provider.embed("y");
        expect(provider._getFailureCount()).toBe(2);

        fail = false;
        const result = await provider.embed("ok");
        expect(result).not.toBeNull();
        expect(provider._getFailureCount()).toBe(0);
        expect(provider._getCircuitState()).toBe("closed");
    });

    test("aborts fetch when it exceeds timeout (AbortError path records failure)", async () => {
        // Simulate a fetch that throws AbortError (our AbortController fired).
        fetchSpy.mockImplementation(async () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            throw err;
        });

        const provider = makeProvider();
        const result = await provider.embed("will time out");
        expect(result).toBeNull();
        expect(provider._getFailureCount()).toBe(1);
    });

    test("failures outside the rolling window don't accumulate toward open", async () => {
        fetchSpy.mockImplementation((async () => errorResponse()) as FetchLike);

        const provider = makeProvider();

        // Trigger a failure, then age the internal failureTimes out of window
        // by resetting the circuit (which also clears the window).
        await provider.embed("one");
        expect(provider._getFailureCount()).toBe(1);
        provider._resetCircuit();

        await provider.embed("two");
        await provider.embed("three");
        expect(provider._getFailureCount()).toBe(2);
        expect(provider._getCircuitState()).toBe("closed");
    });

    test("half-open probe: single failure re-opens circuit (canonical pattern)", async () => {
        fetchSpy.mockImplementation((async () => errorResponse()) as FetchLike);

        const provider = makeProvider();
        // Drive to OPEN.
        await provider.embed("a");
        await provider.embed("b");
        await provider.embed("c");
        expect(provider._getCircuitState()).toBe("open");

        // Simulate open-timer elapsed by mutating circuit state directly
        // via the test hook. We don't want to wait 5 minutes in a test.
        provider._resetCircuit();
        // Manually drive state to "open timer elapsed, next call is a probe"
        // — simplest path: force OPEN with a past timestamp.
        (provider as unknown as { circuitOpenUntil: number }).circuitOpenUntil = Date.now() - 10;

        // First call after timer elapse = half-open probe. Still failing →
        // SINGLE failure re-opens. Not 3 like CLOSED state.
        const beforeProbeFailureCount = provider._getFailureCount();
        await provider.embed("probe");
        expect(provider._getFailureCount()).toBe(beforeProbeFailureCount); // window cleared on re-open
        expect(provider._getCircuitState()).toBe("open");
    });

    test("half-open probe in flight: concurrent callers short-circuit (no stampede)", async () => {
        // Hang forever to keep the probe in flight.
        let hangResolver: ((r: Response) => void) | undefined;
        fetchSpy.mockImplementation(
            (async () =>
                new Promise<Response>((resolve) => {
                    hangResolver = resolve;
                })) as FetchLike,
        );

        const provider = makeProvider();
        // Force OPEN with elapsed timer.
        (provider as unknown as { circuitOpenUntil: number }).circuitOpenUntil = Date.now() - 10;

        // Caller 1 claims the probe slot. Doesn't await yet.
        const probePromise = provider.embed("probe-caller");

        // Give the promise a microtask tick to claim the probe slot.
        await Promise.resolve();

        // Now caller 2 should short-circuit — probe is in flight, only
        // one caller at a time during half-open.
        const beforeConcurrentFetches = fetchSpy.mock.calls.length;
        const concurrentResult = await provider.embed("concurrent-caller");
        expect(concurrentResult).toBeNull();
        // No new fetch was issued by caller 2.
        expect(fetchSpy.mock.calls.length).toBe(beforeConcurrentFetches);

        // Let the probe finish (success → circuit closes).
        hangResolver?.(successResponse());
        await probePromise;
        expect(provider._getCircuitState()).toBe("closed");
    });

    test("outer caller abort doesn't count against the circuit", async () => {
        // Fetch that respects the incoming signal and throws AbortError on abort.
        fetchSpy.mockImplementation((async (_url, init) => {
            const signal = (init as RequestInit | undefined)?.signal;
            if (signal) {
                return new Promise<Response>((_resolve, reject) => {
                    signal.addEventListener("abort", () => {
                        const err = new Error("The operation was aborted");
                        err.name = "AbortError";
                        reject(err);
                    });
                });
            }
            return successResponse();
        }) as FetchLike);

        const provider = makeProvider();
        const outerController = new AbortController();
        const outerSignal = outerController.signal;

        // Schedule an outer abort — caller gave up.
        setTimeout(() => outerController.abort(), 30);

        const result = await provider.embed("hang but outer aborts", outerSignal);
        expect(result).toBeNull();
        // The caller's abort must NOT count as an endpoint failure. Endpoint
        // might be perfectly healthy — caller just gave up.
        expect(provider._getFailureCount()).toBe(0);
    });
});
