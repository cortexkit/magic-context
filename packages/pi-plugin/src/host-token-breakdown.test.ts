import { expect, spyOn, test } from "bun:test";
import * as decayRender from "@magic-context/core/hooks/magic-context/decay-render";
import {
	HOST_BREAKDOWN_KEY,
	persistHostTokenBreakdown,
} from "@magic-context/core/hooks/magic-context/host-token-breakdown";
import * as tokenCount from "@magic-context/core/hooks/magic-context/token-count-exact";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import {
	hostToolSchemaBytes,
	measureHostToolDefinitions,
} from "./host-token-breakdown";
import {
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

test("Pi served pass measures off path, persists once, shares status cache, and respects the threshold", async () => {
	const db = createTestDb();
	const sessionId = "pi-phone-host-breakdown";
	const fake = createFakePi();
	const tools = [
		{
			name: "read",
			description: "Pi phone breakdown unique schema",
			parameters: { type: "object" },
		},
	];
	let schemaReads = 0;
	const pi = {
		...fake.pi,
		getAllTools: () => {
			schemaReads++;
			return tools;
		},
	};
	registerPiContextHandler(pi as never, {
		db,
		protectedTags: 0,
		historianContextLimit: 1_000_000,
		historianChunkTokens: 32_000,
	});
	const handler = fake.handlers.get("context")!;
	const raw = [userMessage("A user question for Pi phone attribution", 1)];
	const ctx = {
		...fakeContext(sessionId, process.cwd(), ["phone-pi-u"], raw),
		model: {
			provider: "test-provider",
			id: "test-model",
			contextWindow: 128000,
		},
		getContextUsage: () => ({
			tokens: 1000,
			percent: 1,
			contextWindow: 128000,
		}),
	};
	const saved = () =>
		(
			db
				.prepare(
					"SELECT value FROM session_render_cache WHERE session_id=? AND cache_key=?",
				)
				.get(sessionId, HOST_BREAKDOWN_KEY) as { value: string } | undefined
		)?.value;
	const encode = spyOn(tokenCount, "countTokensExactly");
	const extract = spyOn(decayRender, "extractM0Block");
	let cacheReads = 0;
	const prepare = db.prepare.bind(db);
	const readSpy = spyOn(db, "prepare").mockImplementation(((sql: string) => {
		const statement = prepare(sql);
		if (
			!sql.trimStart().startsWith("SELECT") ||
			!sql.includes("FROM session_render_cache")
		)
			return statement;
		return new Proxy(statement, {
			get(target, key) {
				const value = Reflect.get(target, key, target);
				if (typeof value !== "function") return value;
				return (...args: unknown[]) => {
					if (key === "all" || key === "get") cacheReads++;
					return value.apply(target, args);
				};
			},
		});
	}) as never);
	try {
		await handler({ messages: structuredClone(raw) } as never, ctx as never);
		expect(saved()).toBeUndefined();
		const readsAtReturn = schemaReads;
		cacheReads = 0;
		extract.mockClear();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(cacheReads).toBe(1);
		expect(extract).toHaveBeenCalledTimes(5);
		const first = saved()!;
		const snapshot = JSON.parse(first);
		expect(snapshot.parts.history_raw).toBeGreaterThan(0);
		expect(snapshot.parts.tool_definitions).toBeGreaterThan(0);
		expect(schemaReads).toBe(readsAtReturn + 1);
		encode.mockClear();
		expect(measureHostToolDefinitions(hostToolSchemaBytes(tools))).toBe(
			snapshot.parts.tool_definitions,
		);
		expect(encode).not.toHaveBeenCalled();
		await handler({ messages: structuredClone(raw) } as never, ctx as never);
		encode.mockClear();
		cacheReads = 0;
		extract.mockClear();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(encode).not.toHaveBeenCalled();
		expect(cacheReads).toBe(0);
		expect(extract).not.toHaveBeenCalled();
		expect(saved()).toBe(first);
		const pass = {
			measuredAt: snapshot.measured_at + 1,
			prefixChanged: false,
			conversationTokens: snapshot.parts.history_raw,
			toolCallTokens: 0,
			readToolSchemas: () => hostToolSchemaBytes(tools),
		};
		expect(persistHostTokenBreakdown(db, sessionId, pass)).toBe(false);
		expect(
			persistHostTokenBreakdown(db, sessionId, {
				...pass,
				toolCallTokens: 501,
			}),
		).toBe(true);

		const beforeClear = saved();
		clearContextHandlerSession(sessionId, db);
		expect(saved()).toBe(beforeClear);
		cacheReads = 0;
		extract.mockClear();
		expect(
			persistHostTokenBreakdown(db, sessionId, {
				...pass,
				measuredAt: pass.measuredAt + 1,
				toolCallTokens: 501,
			}),
		).toBe(false);
		expect(cacheReads).toBe(1);
		expect(extract).toHaveBeenCalledTimes(5);
	} finally {
		encode.mockRestore();
		extract.mockRestore();
		readSpy.mockRestore();
		clearContextHandlerSession(sessionId, db);
		db.close();
	}
});
