import { afterAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { updateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import { readReplayEnvelope } from "@magic-context/core/features/magic-context/storage-replay-document";
import { createTestTempDir } from "@magic-context/core/shared/test-temp-dir";
import {
	exerciseOmpLoggerFiles,
	pinOmpLoggerFiles,
	reportOmpLogDescriptors,
} from "./__tests__/omp-log-files";
import {
	responsesModel as model,
	signedHistory,
} from "./__tests__/responses-signed-history";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import { piAgentHistory } from "./pi-dispatch-agent-history";
import {
	piPreparedStructure,
	piPreparedStructureMismatch,
} from "./pi-dispatch-structure";
import { drainPiTagSnapshotSession } from "./tag-snapshot-pi";
import { createFakePi, createTestDb, fakeContext } from "./test-utils.test";

// Pi and Oh My Pi read paths at import time. Neither uses a real home or credential here.
const { dir: root, cleanup } = createTestTempDir(
	"mc-pi-test-xdg-",
	"signed-responses",
);
const environment = {
	HOME: join(root, "home"),
	XDG_CONFIG_HOME: join(root, "config"),
	XDG_DATA_HOME: join(root, "data"),
	XDG_CACHE_HOME: join(root, "cache"),
	XDG_STATE_HOME: join(root, "state"),
	PI_CODING_AGENT_DIR: join(root, "agent"),
	MAGIC_CONTEXT_STORAGE_DIR: join(root, "storage"),
};
const previous = Object.fromEntries(
	Object.keys(environment).map((key) => [key, process.env[key]]),
);
const previousApiKey = process.env.OPENAI_API_KEY;
process.env.OPENAI_API_KEY = "mock-key-not-a-credential";
for (const [key, value] of Object.entries(environment)) {
	mkdirSync(value, { recursive: true });
	process.env[key] = value;
}
const harnessKey = Symbol.for("magic-context.pi.harness-detection");
const globals = globalThis as unknown as Record<symbol, unknown>;
const previousHarness = globals[harnessKey];
const aliases = ["omp-pi-ai-18126", "omp-coding-agent-18126"];
await pinOmpLoggerFiles(root, aliases);
const require = createRequire(import.meta.url);
const aiRoot = require.resolve(`${aliases[0]}/package.json`).slice(0, -12);
const piRoot = require
	.resolve("@earendil-works/pi-ai/package.json")
	.slice(0, -12);
const { buildResponsesInput } = await import(
	`${aiRoot}src/providers/openai-shared.ts`
);
const { streamOpenAIResponses } = await import(
	`${aiRoot}src/providers/openai-responses.ts`
);
const { convertResponsesMessages } = await import(
	`${piRoot}dist/api/openai-responses-shared.js`
);
const omp = await import(aliases[1]);
await exerciseOmpLoggerFiles(aliases);
reportOmpLogDescriptors();

afterAll(() => {
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
	else process.env.OPENAI_API_KEY = previousApiKey;
	if (previousHarness === undefined) delete globals[harnessKey];
	else globals[harnessKey] = previousHarness;
	cleanup();
});

function encode(messages: unknown[], host: "omp" | "pi") {
	const context = { messages: piAgentHistory(messages, model.api) };
	return host === "omp"
		? buildResponsesInput({
				model,
				context,
				nativeHistory: { replay: true },
				repairOrphanOutputs: true,
			})
		: convertResponsesMessages(model, context, new Set([model.provider]));
}

test.each([
	"omp",
	"pi",
] as const)("%s: signed historical ordinal renumbering replays without refusal or a stale number", async (host) => {
	globals[harnessKey] = { kind: host, via: "test-override" };
	for (const rawText of ["§42§ Hello", "§2§ Hello", "Hello"]) {
		const sessionId = `signed-${host}-${rawText}`;
		const db = createTestDb();
		const fake = createFakePi();
		const original = signedHistory(rawText);
		if (host === "pi") Reflect.deleteProperty(original, "providerPayload");
		const raw = [
			{ role: "user", content: "Say hello", timestamp: 1 },
			original,
			{ role: "user", content: "Continue", timestamp: 3 },
		];
		let aborted = false;
		const pass = async () => {
			const messages = structuredClone(raw);
			const ctx = {
				...fakeContext(
					sessionId,
					root,
					["entry_0", "entry_1", "entry_2"],
					messages as never,
				),
				model,
				abort: () => {
					aborted = true;
				},
			};
			const handler = fake.handlers.get("context") as any;
			const result = await handler({ messages }, ctx);
			expect(result?.messages).toBeDefined();
			const input = encode(result.messages, host);
			const plan = piPreparedStructure(result.messages, model, host);
			expect(piPreparedStructureMismatch({ input }, plan)).toBeUndefined();
			if (host === "omp")
				await (fake.handlers.get("before_provider_request") as any)(
					{ payload: { input } },
					ctx,
				);
			expect(aborted).toBe(false);
			const assistant = result.messages.find(
				(m: any) => m.role === "assistant",
			);
			expect(assistant.content[0].text).toBe("§2§ Hello");
			expect(assistant.content[0].textSignature).toBe(
				original.content[0].textSignature,
			);
			const wire = input.find((item: any) => item.role === "assistant");
			expect(wire.content[0].text).toBe(host === "omp" ? "Hello" : "§2§ Hello");
			expect(JSON.stringify(input)).not.toContain("§42§");
			if (host === "omp") {
				const expected = structuredClone(original.providerPayload);
				expected.items[0].content[0].text = "Hello";
				expect(assistant.providerPayload).toEqual(expected);
			}
			const bytes = JSON.stringify(input);
			wire.content[0].text += " CHANGED";
			expect(piPreparedStructureMismatch({ input }, plan)).toBeDefined();
			return bytes;
		};
		const register = () =>
			registerPiContextHandler(fake.pi as never, { db, protectedTags: 20 });
		try {
			register();
			const first = await pass();
			const ledger = readReplayEnvelope(db, sessionId);
			updateSessionMeta(db, sessionId, {
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
			});
			expect(await pass()).toBe(first);
			clearContextHandlerSession(sessionId);
			register();
			expect(await pass()).toBe(first);
			expect(readReplayEnvelope(db, sessionId)).toEqual(ledger);
			expect(raw[1]).toEqual(original);
		} finally {
			clearContextHandlerSession(sessionId);
			await drainPiTagSnapshotSession(sessionId);
			db.close();
		}
	}
});

test("real Oh My Pi 18.12.6 dispatches renumbered signed history through a mock Responses provider", async () => {
	globals[harnessKey] = { kind: "omp", via: "test-override" };
	const settings = omp.Settings.isolated({});
	const agentDir = environment.PI_CODING_AGENT_DIR;
	const authStorage = await omp.discoverAuthStorage(agentDir, {
		settings,
		cwd: root,
	});
	const modelRegistry = new omp.ModelRegistry(
		authStorage,
		join(agentDir, "models.yml"),
		{ settings },
	);
	const sessionManager = omp.SessionManager.inMemory(root);
	const original = signedHistory();
	sessionManager.appendMessage({
		role: "user",
		content: "Say hello",
		timestamp: 1,
	});
	sessionManager.appendMessage(original);
	const db = createTestDb();
	const requests: any[] = [];
	const dispatches: any[] = [];
	const refusals: string[] = [];
	const { session } = await omp.createAgentSession({
		cwd: root,
		agentDir,
		model,
		authStorage,
		modelRegistry,
		settings,
		sessionManager,
		extensions: [
			(api: any) => {
				registerPiContextHandler(api, { db, protectedTags: 20 });
				api.on("before_provider_request", (event: any) => {
					dispatches.push(structuredClone(event.payload));
				});
			},
		],
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
		hasUI: false,
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		toolNames: [],
	});
	session.subscribe((event: any) => {
		if (event.type === "extension_error") refusals.push(JSON.stringify(event));
	});
	// Keep the real agent loop, encoder, onPayload dispatch hooks and SSE parser.
	// Replace only HTTP transport; even a misconfigured endpoint cannot reach a network.
	session.agent.streamFn = (target: any, context: any, options: any) =>
		streamOpenAIResponses(target, context, {
			...options,
			apiKey: "mock-key-not-a-credential",
			fetch: async (_url: unknown, init: RequestInit) => {
				requests.push(JSON.parse(String(init.body)));
				const output = [
					{
						type: "message",
						role: "assistant",
						id: "msg_mock",
						status: "completed",
						phase: "final_answer",
						content: [
							{ type: "output_text", text: "Mock answer", annotations: [] },
						],
					},
				];
				const response = {
					id: "resp_mock",
					object: "response",
					status: "completed",
					output,
					usage: { input_tokens: 100, output_tokens: 2, total_tokens: 102 },
				};
				const events = [
					{
						type: "response.created",
						response: { ...response, status: "in_progress", output: [] },
					},
					{
						type: "response.output_item.added",
						output_index: 0,
						item: { ...output[0], status: "in_progress", content: [] },
					},
					{
						type: "response.content_part.added",
						output_index: 0,
						content_index: 0,
						item_id: "msg_mock",
						part: { type: "output_text", text: "", annotations: [] },
					},
					{
						type: "response.output_text.delta",
						output_index: 0,
						content_index: 0,
						item_id: "msg_mock",
						delta: "Mock answer",
					},
					{
						type: "response.output_item.done",
						output_index: 0,
						item: output[0],
					},
					{ type: "response.completed", response },
				];
				return new Response(
					events
						.map(
							(event) =>
								`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
						)
						.join(""),
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		});
	try {
		await session.prompt("Continue");
		expect(refusals).toEqual([]);
		expect(requests).toHaveLength(1);
		expect(dispatches).toHaveLength(1);
		const wire = requests[0].input.find(
			(item: any) => item.role === "assistant",
		);
		expect(wire.content[0].text).toBe("Hello");
		expect(wire.phase).toBe("final_answer");
		expect(JSON.stringify(requests[0])).not.toContain("§42§");
		const saved = sessionManager
			.getEntries()
			.filter((entry: any) => entry.type === "message")
			.map((entry: any) => entry.message);
		expect(
			saved.find(
				(message: any) =>
					message.role === "assistant" &&
					message.content[0]?.text === "Mock answer",
			),
		).toBeDefined();
		expect(original).toEqual(signedHistory());
		await session.prompt("One more turn");
		expect(requests).toHaveLength(2);
		expect(dispatches).toHaveLength(2);
		const replay = requests[1].input.find(
			(item: any) => item.role === "assistant",
		);
		expect(replay).toEqual(wire);
		expect(JSON.stringify(requests[1])).not.toContain("§42§");
		expect(
			sessionManager
				.getEntries()
				.find((entry: any) => entry.message?.timestamp === 2)?.message,
		).toEqual(original);
	} finally {
		await session.dispose();
		clearContextHandlerSession(sessionManager.getSessionId());
		await drainPiTagSnapshotSession(sessionManager.getSessionId());
		db.close();
	}
});
