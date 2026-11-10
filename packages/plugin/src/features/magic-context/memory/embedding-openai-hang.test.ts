import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { OpenAICompatibleEmbeddingProvider } from "./embedding-openai";
import { withQueryEmbeddingDeadline } from "./embedding-query-deadline";

describe("embedding endpoint that accepts but never responds", () => {
    let server: Server;
    const sockets = new Set<Socket>();
    let requests: number;
    let provider: OpenAICompatibleEmbeddingProvider;
    let responseStatus: number | undefined;

    beforeEach(async () => {
        requests = 0;
        responseStatus = undefined;
        server = createServer((request, response) => {
            requests++;
            request.resume();
            if (responseStatus !== undefined) {
                response.writeHead(responseStatus);
                response.flushHeaders();
            }
        });
        server.on("connection", (socket) => {
            sockets.add(socket);
            socket.on("close", () => sockets.delete(socket));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("missing server port");
        provider = new OpenAICompatibleEmbeddingProvider({
            endpoint: `http://127.0.0.1:${address.port}/v1`,
            model: "test-model",
            maxInputTokens: 8192,
        });
    });

    afterEach(async () => {
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await provider.dispose();
    });

    test("three serial 30s hangs open the circuit and the fourth sends no request", async () => {
        for (let i = 0; i < 3; i++) {
            expect(await provider.embed(`query ${i}`, undefined, "query")).toBeNull();
            expect(requests).toBe(i + 1);
            expect(provider.getLastFailureReason()?.reason).toBe("request timed out after 30000ms");
        }
        expect(provider._getCircuitState()).toBe("open");
        const started = performance.now();
        expect(await provider.embed("fourth", undefined, "query")).toBeNull();
        expect(performance.now() - started).toBeLessThan(500);
        expect(requests).toBe(3);
    }, 100_000);

    test("refused connections still open the circuit", async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        for (let i = 0; i < 3; i++) expect(await provider.embed("query")).toBeNull();
        expect(provider._getCircuitState()).toBe("open");
        expect(requests).toBe(0);
    });

    test.each([
        200, 502, 429,
    ])("query deadline during a stalled HTTP %s body is counted at most once", async (status) => {
        responseStatus = status;
        let embedding: Promise<Float32Array | null> | undefined;
        expect(
            await withQueryEmbeddingDeadline((signal) => {
                embedding = provider.embed("query", signal, "query");
                return embedding;
            }),
        ).toBeNull();
        await embedding;
        expect(provider._getFailureCount()).toBe(status === 429 ? 0 : 1);
        expect(provider._getCircuitState()).toBe("closed");
        expect(requests).toBe(1);
    }, 10_000);
});
