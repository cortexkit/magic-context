import { expect, spyOn, test } from "bun:test";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage-meta";
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
import { buildPiStatusDetail } from "./dialogs/status-dialog";
import {
	hostToolSchemaBytes,
	measureHostToolDefinitions,
	readPiTokenAttribution,
} from "./host-token-breakdown";
import {
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

for (const [host, prompt] of [
	["Pi", "Pi system prompt"],
	["OMP", ["OMP system prompt", "Project context"]],
] as const) {
	test(`${host} served pass measures off path, matches status, and respects the threshold`, async () => {
		const db = createTestDb();
		const sessionId = `${host}-phone-host-breakdown`;
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
			getSystemPrompt: () => prompt,
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
		let attributionReads = 0;
		const prepare = db.prepare.bind(db);
		const readSpy = spyOn(db, "prepare").mockImplementation(((sql: string) => {
			if (sql.trimStart().startsWith("SELECT")) attributionReads++;
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
			const output = await handler(
				{ messages: structuredClone(raw) } as never,
				ctx as never,
			);
			const returnedBytes = JSON.stringify(output);
			expect(saved()).toBeUndefined();
			const readsAtReturn = schemaReads;
			cacheReads = 0;
			extract.mockClear();
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(JSON.stringify(output)).toBe(returnedBytes);
			expect(cacheReads).toBe(1);
			const prefixExtractions = extract.mock.calls.length;
			const first = saved()!;
			const snapshot = JSON.parse(first);
			expect(snapshot.version).toBe(2);
			expect(snapshot.parts.history_raw).toBeGreaterThan(0);
			expect(snapshot.parts.tool_definitions).toBeGreaterThan(0);
			expect(schemaReads).toBe(readsAtReturn + 1);
			const detail = buildPiStatusDetail(
				pi as never,
				ctx as never,
				{ db, projectIdentity: "" },
				sessionId,
			);
			expect(snapshot.parts).toEqual({
				system_prompt: detail.systemPromptTokens,
				tool_definitions: detail.toolDefinitionTokens,
				history_summaries: detail.compartmentTokens + detail.factTokens,
				memory: detail.memoryTokens,
				project_docs: detail.docsTokens,
				user_profile: detail.profileTokens,
				history_raw: detail.conversationTokens,
				tool_calls_results: detail.toolCallTokens,
				last_user_message: 0,
			});
			expect(prefixExtractions).toBe(4);
			expect(
				Object.values(snapshot.parts).reduce(
					(sum: number, value) => sum + Number(value),
					0,
				),
			).toBe(detail.inputTokens);
			encode.mockClear();
			expect(measureHostToolDefinitions(hostToolSchemaBytes(tools))).toBe(
				snapshot.parts.tool_definitions,
			);
			expect(encode).not.toHaveBeenCalled();
			await handler({ messages: structuredClone(raw) } as never, ctx as never);
			encode.mockClear();
			cacheReads = 0;
			extract.mockClear();
			attributionReads = 0;
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(attributionReads).toBe(0);
			expect(encode).not.toHaveBeenCalled();
			expect(cacheReads).toBe(0);
			expect(extract).not.toHaveBeenCalled();
			expect(saved()).toBe(first);
			const meta = getOrCreateSessionMeta(db, sessionId);
			const pass = {
				measuredAt: snapshot.measured_at + 1,
				prefixChanged: false,
				projectIdentity: undefined,
				readAttribution: (
					blocks: Parameters<typeof readPiTokenAttribution>[5],
				) =>
					readPiTokenAttribution(
						pi as never,
						ctx as never,
						meta,
						{ sessionId, providerInputLimit: 128000 },
						0,
						blocks,
					),
			};
			const changed = {
				...pass,
				readAttribution: (
					blocks: Parameters<typeof readPiTokenAttribution>[5],
				) =>
					readPiTokenAttribution(
						pi as never,
						ctx as never,
						meta,
						{ sessionId, providerInputLimit: 128000 },
						501,
						blocks,
					),
			};
			expect(persistHostTokenBreakdown(db, sessionId, pass)).toBe(false);
			expect(persistHostTokenBreakdown(db, sessionId, changed)).toBe(true);

			const beforeClear = saved();
			clearContextHandlerSession(sessionId, db);
			expect(saved()).toBe(beforeClear);
			cacheReads = 0;
			extract.mockClear();
			expect(
				persistHostTokenBreakdown(db, sessionId, {
					...changed,
					measuredAt: pass.measuredAt + 1,
				}),
			).toBe(false);
			expect(cacheReads).toBe(1);
			expect(extract).toHaveBeenCalledTimes(4);
		} finally {
			encode.mockRestore();
			extract.mockRestore();
			readSpy.mockRestore();
			clearContextHandlerSession(sessionId, db);
			db.close();
		}
	});
}
