import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { insertMemory } from "../../features/magic-context/memory";
import * as embeddingModule from "../../features/magic-context/memory/embedding";
import { OpenAICompatibleEmbeddingProvider } from "../../features/magic-context/memory/embedding-openai";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createCtxSearchTools } from "./tools";

describe("OpenCode ctx_search with a hanging embedding endpoint", () => {
    let server: Server;
    const sockets = new Set<Socket>();
    let requests: number;
    let provider: OpenAICompatibleEmbeddingProvider;
    let db: Database;
    let embed: ReturnType<typeof spyOn<typeof embeddingModule, "embedTextForProject">>;
    let invoke: (signal?: AbortSignal) => Promise<string>;
    let requestSeen: Promise<void>;

    beforeEach(async () => {
        requests = 0;
        let onRequest: () => void;
        requestSeen = new Promise<void>((resolve) => {
            onRequest = resolve;
        });
        server = createServer((request) => {
            requests++;
            request.resume();
            onRequest();
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
        embed = spyOn(embeddingModule, "embedTextForProject").mockImplementation(
            async (_project, text, signal, purpose) => {
                const vector = await provider.embed(text, signal, purpose);
                return vector
                    ? {
                          vector,
                          modelId: provider.modelId,
                          chunkModelId: provider.modelId,
                          generation: 1,
                      }
                    : null;
            },
        );
        db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);
        insertMemory(db, {
            projectPath: "git:opencode-hang",
            category: "ARCHITECTURE",
            content: "needle keyword fallback survives an unavailable embedding endpoint",
        });
        const tool = createCtxSearchTools({
            db,
            resolveProjectPath: () => "git:opencode-hang",
            embeddingEnabled: true,
            memoryEnabled: true,
            readMessages: () => [],
        }).ctx_search;
        invoke = (signal = new AbortController().signal) =>
            tool.execute({ query: "needle keyword fallback", sources: ["memory"] }, {
                sessionID: "ses-hang",
                abort: signal,
            } as never);
    });

    afterEach(async () => {
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        embed.mockRestore();
        await provider.dispose();
        closeQuietly(db);
    });

    test("returns keyword results in 5s and repeated search deadlines open the circuit", async () => {
        for (let i = 0; i < 3; i++) {
            const started = performance.now();
            expect(await invoke()).toContain("needle keyword fallback survives");
            const elapsed = performance.now() - started;
            expect(elapsed).toBeGreaterThanOrEqual(4_500);
            expect(elapsed).toBeLessThan(6_500);
            expect(requests).toBe(i + 1);
            expect(provider.getLastFailureReason()?.reason).toBe("request timed out after 5000ms");
        }
        expect(provider._getCircuitState()).toBe("open");
        const started = performance.now();
        expect(await invoke()).toContain("needle keyword fallback survives");
        expect(performance.now() - started).toBeLessThan(500);
        expect(requests).toBe(3);
    }, 40_000);

    test("tool caller cancellation is propagated without counting an endpoint failure", async () => {
        const controller = new AbortController();
        const pending = invoke(controller.signal);
        await requestSeen;
        controller.abort(new Error("caller cancelled"));
        await pending;
        expect(provider._getFailureCount()).toBe(0);
        expect(provider._getCircuitState()).toBe("closed");
        expect(requests).toBe(1);
    });
});
