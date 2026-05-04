import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import { probeEmbeddingEndpoint } from "./embedding-probe";

interface FetchCapture {
    url?: string;
    init?: RequestInit;
}

function mockFetch(
    response: Response | (() => Promise<Response>),
    capture?: FetchCapture,
): typeof fetch {
    return mock(async (input: Request | URL | string, init?: RequestInit) => {
        if (capture) {
            capture.url =
                typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            capture.init = init;
        }
        return typeof response === "function" ? await response() : response;
    }) as unknown as typeof fetch;
}

describe("probeEmbeddingEndpoint", () => {
    const ORIGINAL_ENV = { ...process.env };

    beforeEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    it("returns ok with embedding dimensions on 200 response", async () => {
        const fetch = mockFetch(
            new Response(
                JSON.stringify({ data: [{ embedding: Array.from({ length: 1536 }, () => 0.1) }] }),
                { status: 200, headers: { "content-type": "application/json" } },
            ),
        );

        const result = await probeEmbeddingEndpoint({
            endpoint: "https://api.openai.com/v1",
            model: "text-embedding-3-small",
            apiKey: "sk-test",
            fetch,
        });

        expect(result).toEqual({ kind: "ok", status: 200, dimensions: 1536 });
    });

    it("classifies 200 without data[].embedding as endpoint_unsupported", async () => {
        const fetch = mockFetch(
            new Response(JSON.stringify({ message: "unknown route but 200" }), {
                status: 200,
                headers: { "content-type": "application/json" },
            }),
        );

        const result = await probeEmbeddingEndpoint({
            endpoint: "https://api.example.com/v1",
            model: "any",
            fetch,
        });

        expect(result.kind).toBe("endpoint_unsupported");
        if (result.kind === "endpoint_unsupported") {
            expect(result.status).toBe(200);
            expect(result.preview).toContain("unknown route");
        }
    });

    it("classifies 401 as auth_failed and includes body preview", async () => {
        const fetch = mockFetch(
            new Response(JSON.stringify({ error: "invalid api key" }), {
                status: 401,
                headers: { "content-type": "application/json" },
            }),
        );

        const result = await probeEmbeddingEndpoint({
            endpoint: "https://api.openai.com/v1",
            model: "text-embedding-3-small",
            apiKey: "sk-wrong",
            fetch,
        });

        expect(result.kind).toBe("auth_failed");
        if (result.kind === "auth_failed") {
            expect(result.status).toBe(401);
            expect(result.preview).toContain("invalid api key");
        }
    });

    it("classifies 403 as auth_failed", async () => {
        const fetch = mockFetch(new Response("forbidden", { status: 403 }));

        const result = await probeEmbeddingEndpoint({
            endpoint: "https://api.example.com/v1",
            model: "any",
            fetch,
        });

        expect(result.kind).toBe("auth_failed");
    });

    it("classifies 404 as endpoint_unsupported (route missing)", async () => {
        const fetch = mockFetch(
            new Response(JSON.stringify({ error: "Not Found" }), {
                status: 404,
                headers: { "content-type": "application/json" },
            }),
        );

        const result = await probeEmbeddingEndpoint({
            endpoint: "https://openrouter.ai/api/v1",
            model: "text-embedding-3-small",
            fetch,
        });

        expect(result.kind).toBe("endpoint_unsupported");
        if (result.kind === "endpoint_unsupported") {
            expect(result.status).toBe(404);
            expect(result.preview).toContain("Not Found");
        }
    });

    it("classifies 405 as endpoint_unsupported", async () => {
        const fetch = mockFetch(new Response("method not allowed", { status: 405 }));

        const result = await probeEmbeddingEndpoint({
            endpoint: "https://api.example.com/v1",
            model: "any",
            fetch,
        });

        expect(result.kind).toBe("endpoint_unsupported");
    });

    it("classifies 5xx as http_error", async () => {
        const fetch = mockFetch(new Response("internal error", { status: 503 }));

        const result = await probeEmbeddingEndpoint({
            endpoint: "https://api.example.com/v1",
            model: "any",
            fetch,
        });

        expect(result.kind).toBe("http_error");
        if (result.kind === "http_error") {
            expect(result.status).toBe(503);
            expect(result.preview).toContain("internal error");
        }
    });

    it("classifies thrown fetch error as network_error", async () => {
        const fetch: typeof globalThis.fetch = mock(async () => {
            throw new Error("ECONNREFUSED");
        }) as unknown as typeof fetch;

        const result = await probeEmbeddingEndpoint({
            endpoint: "https://api.example.com/v1",
            model: "any",
            fetch,
        });

        expect(result.kind).toBe("network_error");
        if (result.kind === "network_error") {
            expect(result.message).toBe("ECONNREFUSED");
        }
    });

    it("classifies AbortError as timeout", async () => {
        const fetch: typeof globalThis.fetch = mock(async () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            throw err;
        }) as unknown as typeof fetch;

        const result = await probeEmbeddingEndpoint({
            endpoint: "https://api.example.com/v1",
            model: "any",
            timeoutMs: 2500,
            fetch,
        });

        expect(result.kind).toBe("timeout");
        if (result.kind === "timeout") {
            expect(result.timeoutMs).toBe(2500);
        }
    });

    it("classifies TimeoutError as timeout", async () => {
        const fetch: typeof globalThis.fetch = mock(async () => {
            const err = new Error("timed out");
            err.name = "TimeoutError";
            throw err;
        }) as unknown as typeof fetch;

        const result = await probeEmbeddingEndpoint({
            endpoint: "https://api.example.com/v1",
            model: "any",
            fetch,
        });

        expect(result.kind).toBe("timeout");
    });

    it("rejects endpoint without http(s) scheme before making a request", async () => {
        const fetch: typeof globalThis.fetch = mock(() => {
            throw new Error("should not be called");
        }) as unknown as typeof fetch;

        const result = await probeEmbeddingEndpoint({
            endpoint: "api.openai.com/v1",
            model: "any",
            fetch,
        });

        expect(result.kind).toBe("invalid_scheme");
        if (result.kind === "invalid_scheme") {
            expect(result.endpoint).toBe("api.openai.com/v1");
        }
    });

    it("rejects empty endpoint", async () => {
        const fetch: typeof globalThis.fetch = mock(() => {
            throw new Error("should not be called");
        }) as unknown as typeof fetch;

        const result = await probeEmbeddingEndpoint({
            endpoint: "   ",
            model: "any",
            fetch,
        });

        expect(result.kind).toBe("invalid_scheme");
    });

    it("trims trailing slashes from endpoint", async () => {
        const capture: FetchCapture = {};
        const fetch = mockFetch(
            new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), {
                status: 200,
                headers: { "content-type": "application/json" },
            }),
            capture,
        );

        await probeEmbeddingEndpoint({
            endpoint: "https://api.openai.com/v1///",
            model: "text-embedding-3-small",
            fetch,
        });

        expect(capture.url).toBe("https://api.openai.com/v1/embeddings");
    });

    it("sends apiKey as Bearer authorization header", async () => {
        const capture: FetchCapture = {};
        const fetch = mockFetch(
            new Response(JSON.stringify({ data: [{ embedding: [0.1] }] }), { status: 200 }),
            capture,
        );

        await probeEmbeddingEndpoint({
            endpoint: "https://api.openai.com/v1",
            model: "m",
            apiKey: "sk-real",
            fetch,
        });

        const headers = capture.init?.headers as Record<string, string> | undefined;
        expect(headers?.authorization).toBe("Bearer sk-real");
    });

    it("omits authorization header when no apiKey", async () => {
        const capture: FetchCapture = {};
        const fetch = mockFetch(
            new Response(JSON.stringify({ data: [{ embedding: [0.1] }] }), { status: 200 }),
            capture,
        );

        await probeEmbeddingEndpoint({
            endpoint: "https://api.example.com/v1",
            model: "m",
            fetch,
        });

        const headers = capture.init?.headers as Record<string, string> | undefined;
        expect(headers?.authorization).toBeUndefined();
    });

    it("does not send empty apiKey as a header", async () => {
        const capture: FetchCapture = {};
        const fetch = mockFetch(
            new Response(JSON.stringify({ data: [{ embedding: [0.1] }] }), { status: 200 }),
            capture,
        );

        await probeEmbeddingEndpoint({
            endpoint: "https://api.example.com/v1",
            model: "m",
            apiKey: "   ",
            fetch,
        });

        const headers = capture.init?.headers as Record<string, string> | undefined;
        expect(headers?.authorization).toBeUndefined();
    });

    it("truncates very long error body previews", async () => {
        const longBody = "x".repeat(1000);
        const fetch = mockFetch(new Response(longBody, { status: 500 }));

        const result = await probeEmbeddingEndpoint({
            endpoint: "https://api.example.com/v1",
            model: "m",
            fetch,
        });

        expect(result.kind).toBe("http_error");
        if (result.kind === "http_error") {
            // 240 preview chars + trailing ellipsis.
            expect(result.preview.length).toBeLessThan(300);
            expect(result.preview.endsWith("…")).toBe(true);
        }
    });
});
