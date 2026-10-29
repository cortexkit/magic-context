import { expect, spyOn, test } from "bun:test";
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
	try {
		await handler({ messages: structuredClone(raw) } as never, ctx as never);
		expect(saved()).toBeUndefined();
		const readsAtReturn = schemaReads;
		await new Promise((resolve) => setTimeout(resolve, 10));
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
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(encode).not.toHaveBeenCalled();
		expect(saved()).toBe(first);
		const pass = {
			measuredAt: snapshot.measured_at + 1,
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
	} finally {
		encode.mockRestore();
		clearContextHandlerSession(sessionId);
		db.close();
	}
});
