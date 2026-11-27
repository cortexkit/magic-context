import {
	afterEach,
	beforeEach,
	describe,
	expect,
	jest,
	spyOn,
	test,
} from "bun:test";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { insertMemory } from "@magic-context/core/features/magic-context/memory";
import * as embeddingModule from "@magic-context/core/features/magic-context/memory/embedding";
import { OpenAICompatibleEmbeddingProvider } from "@magic-context/core/features/magic-context/memory/embedding-openai";
import type { Database } from "@magic-context/core/shared/sqlite";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { createTestDb, fakeContext } from "../test-utils.test";
import { createCtxSearchTool } from "./ctx-search";

describe("Pi ctx_search with a hanging embedding endpoint", () => {
	let server: Server;
	const sockets = new Set<Socket>();
	let requests: number;
	let provider: OpenAICompatibleEmbeddingProvider;
	let db: Database;
	let embed: ReturnType<
		typeof spyOn<typeof embeddingModule, "embedTextForProject">
	>;
	let invoke: (signal?: AbortSignal) => Promise<string | undefined>;
	let requestArrival: ReturnType<typeof Promise.withResolvers<void>>;

	beforeEach(async () => {
		requests = 0;
		requestArrival = Promise.withResolvers<void>();
		server = createServer((request) => {
			requests++;
			request.resume();
			requestArrival.resolve();
		});
		server.on("connection", (socket) => {
			sockets.add(socket);
			socket.on("close", () => sockets.delete(socket));
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("missing server port");
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
		db = createTestDb();
		insertMemory(db, {
			projectPath: "git:pi-hang",
			category: "ARCHITECTURE",
			content:
				"needle keyword fallback survives an unavailable embedding endpoint",
		});
		const tool = createCtxSearchTool({
			db,
			resolveProjectIdentity: () => "git:pi-hang",
			embeddingEnabled: true,
			memoryEnabled: true,
		});
		invoke = async (signal = new AbortController().signal) => {
			const result = await tool.execute(
				"hang-call",
				{ query: "needle keyword fallback", sources: ["memory"] },
				signal,
				undefined,
				fakeContext("ses-hang") as never,
			);
			const content = result.content[0];
			return content?.type === "text" ? content.text : undefined;
		};
	});

	afterEach(async () => {
		jest.useRealTimers();
		for (const socket of sockets) socket.destroy();
		sockets.clear();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		embed.mockRestore();
		await provider.dispose();
		closeQuietly(db);
	});

	test("returns keyword results in 5s and repeated search deadlines open the circuit", async () => {
		jest.useFakeTimers({ doNotFake: ["setImmediate"] });
		const flushSearch = () =>
			new Promise<void>((resolve) => setImmediate(resolve));
		for (let i = 0; i < 3; i++) {
			requestArrival = Promise.withResolvers<void>();
			let done = false;
			const search = invoke().then((result) => {
				done = true;
				return result;
			});
			// Cancel an actual request, not one stalled in local socket setup.
			await Promise.race([requestArrival.promise, search]);
			expect(requests).toBe(i + 1);
			jest.advanceTimersByTime(4_999);
			await flushSearch();
			expect(done).toBe(false);
			expect(provider._getFailureCount()).toBe(i);
			jest.advanceTimersByTime(1);
			await flushSearch();
			expect(done).toBe(true);
			expect(await search).toContain("needle keyword fallback survives");
			expect(provider.getLastFailureReason()?.reason).toBe(
				"request timed out after 5000ms",
			);
		}
		expect(provider._getCircuitState()).toBe("open");
		let answer: string | undefined;
		const search = invoke().then((result) => {
			answer = result;
		});
		await flushSearch();
		expect(answer).toContain("needle keyword fallback survives");
		await search;
		expect(requests).toBe(3);
	}, 40_000);

	test("tool caller cancellation is propagated without counting an endpoint failure", async () => {
		const controller = new AbortController();
		const pending = invoke(controller.signal);
		await requestArrival.promise;
		controller.abort(new Error("caller cancelled"));
		await pending;
		expect(provider._getFailureCount()).toBe(0);
		expect(provider._getCircuitState()).toBe("closed");
		expect(requests).toBe(1);
	});
});
