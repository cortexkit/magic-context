import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SessionContext } from "../../plugin/src/v2/hooks/types";

function evidenceRoot(): string {
	const root = process.env.REVIEW_OUTPUT;
	if (!root)
		throw new Error("REVIEW_OUTPUT is required for the opt-in fixture");
	return root;
}

const source = resolve(
	process.env.REVIEW_SOURCE ?? resolve(import.meta.dir, "../../.."),
);
const load = (path: string) => import(join(source, "packages", path));
const digest = (value: string) =>
	new Bun.CryptoHasher("sha256").update(value).digest("hex");
const median = (values: number[]) =>
	[...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

// Opt-in evidence fixture: run each source revision in its own process and compare
// the three output files independently. Timings include handler publication, but
// exclude fixture setup, input cloning, and the deferred drain between samples.

test.skipIf(process.env.REVIEW_OUTPUT === undefined)(
	"independent Pi defer bytes and per-pass cost",
	async () => {
		expect(import.meta.resolve("@magic-context/core/shared/sqlite")).toContain(
			join(source, "packages/plugin/src/shared/sqlite.ts"),
		);
		const {
			createFakePi,
			createTestDb,
			fakeContext,
			userMessage,
			assistantMessage,
			assistantToolCall,
			toolResultMessage,
		} = await load("pi-plugin/src/test-utils.test.ts");
		const { registerPiContextHandler, clearContextHandlerSession } = await load(
			"pi-plugin/src/context-handler.ts",
		);
		const { resetLkgSlotsForTest } = await load(
			"plugin/src/hooks/magic-context/lkg-slot.ts",
		);
		const db = createTestDb();
		const fake = createFakePi();
		registerPiContextHandler(fake.pi, {
			db,
			historian: undefined,
			heuristics: { keepReasoningTokens: 1000 },
			injection: {
				memoryEnabled: false,
				injectDocs: false,
				temporalAwareness: false,
			},
		});
		const raw = Array.from({ length: 600 }, (_, i) =>
			i % 2
				? assistantMessage(`answer ${i}: fixed fixture text`, i + 1)
				: userMessage(`question ${i}: fixed fixture text`, i + 1),
		);
		raw.push(assistantToolCall("call", "read", { path: "fixture.ts" }, 601));
		raw.push(toolResultMessage("call", "export const budget = 21000;", 602));
		raw.push(assistantMessage("The budget includes preparation.", 603));
		raw.push(userMessage("Please inspect writer admission", 604));
		const ctx = fakeContext(
			"review-pi",
			process.env.REVIEW_CWD ?? process.cwd(),
			raw.map((_, i) => `e${i}`),
			raw,
		);
		const times: number[] = [];
		const wires: string[] = [];
		try {
			for (let i = 0; i < 32; i++) {
				const messages = structuredClone(raw);
				const start = performance.now();
				const result = await fake.handlers.get("context")({ messages }, ctx);
				times.push(performance.now() - start);
				const wire = JSON.stringify(result.messages);
				if (i >= 2) wires.push(wire);
				await new Promise((resolve) => setImmediate(resolve));
			}
			expect(wires.every((wire) => wire === wires[0])).toBe(true);
			expect(wires[0]).toContain("§1§");
			writeFileSync(join(evidenceRoot(), "pi.json"), wires[0]);
			console.log(
				"REVIEW_PI",
				JSON.stringify({
					source,

					samples: 30,
					bytes: Buffer.byteLength(wires[0]),
					sha256: digest(wires[0]),
					coldMs: times[0],
					warmMedianMs: median(times.slice(2)),
					warmMinMs: Math.min(...times.slice(2)),
					warmMaxMs: Math.max(...times.slice(2)),
					wireSha256: digest(wires[0]),
				}),
			);
		} finally {
			clearContextHandlerSession("review-pi");
			resetLkgSlotsForTest();
			db.close();
		}
	},
);

test.skipIf(process.env.REVIEW_OUTPUT === undefined)(
	"independent OpenCode1 defer bytes and per-pass cost",
	async () => {
		const { openDatabase, closeDatabase } = await load(
			"plugin/src/features/magic-context/storage-db.ts",
		);
		const { createTransform } = await load(
			"plugin/src/hooks/magic-context/transform.ts",
		);
		const { createMessagesTransformHandler } = await load(
			"plugin/src/plugin/messages-transform.ts",
		);
		const { createTagger } = await load(
			"plugin/src/features/magic-context/tagger.ts",
		);
		const {
			resetCtxReduceRegisteredGloballyForTest,
			setCtxReduceRegisteredGlobally,
		} = await load("plugin/src/hooks/magic-context/ctx-reduce-availability.ts");
		const { resetLkgSlotsForTest } = await load(
			"plugin/src/hooks/magic-context/lkg-slot.ts",
		);
		const db = openDatabase();
		if (!db) throw new Error("isolated database unavailable");
		const sessionId = "review-oc1";
		setCtxReduceRegisteredGlobally(true);
		const transform = createTransform({
			db,
			tagger: createTagger(),
			scheduler: { shouldExecute: () => "defer" },
			contextUsageMap: new Map(),
			historyRefreshSessions: new Set(),
			pendingMaterializationSessions: new Set(),
			lastHeuristicsTurnId: new Map(),
			historianRunnable: false,
			protectedTokens: 0,
			clearReasoningAge: 1000,
			directory: process.env.REVIEW_CWD,
			memoryConfig: { enabled: false },
			injectDocs: false,
			liveModelBySession: new Map([
				[sessionId, { providerID: "openai", modelID: "gpt-4.1" }],
			]),
		});
		const handler = createMessagesTransformHandler({
			magicContext: { "experimental.chat.messages.transform": transform },
		});
		const raw = [
			{
				info: {
					id: "u1",
					role: "user",
					sessionID: sessionId,
					model: { providerID: "openai", modelID: "gpt-4.1" },
					tools: { ctx_reduce: true, read: true },
				},
				parts: [{ type: "text", text: "Please inspect writer admission" }],
			},
		];
		const times: number[] = [];
		const wires: string[] = [];
		try {
			for (let i = 0; i < 32; i++) {
				const output = { messages: structuredClone(raw) };
				const start = performance.now();
				await handler({}, output);
				times.push(performance.now() - start);
				if (i >= 2) wires.push(JSON.stringify(output.messages));
				await new Promise((resolve) => setImmediate(resolve));
			}
			expect(wires.every((wire) => wire === wires[0])).toBe(true);
			expect(wires[0]).toContain("§1§ Please inspect writer admission");
			expect(
				JSON.parse(wires[0])
					.slice(0, 2)
					.map(
						(message: { info: { syntheticHead?: boolean } }) =>
							message.info.syntheticHead,
					),
			).toEqual([true, true]);
			writeFileSync(join(evidenceRoot(), "oc1.json"), wires[0]);
			console.log(
				"REVIEW_OC1",
				JSON.stringify({
					source,

					samples: 30,
					bytes: Buffer.byteLength(wires[0]),
					sha256: digest(wires[0]),
					coldMs: times[0],
					warmMedianMs: median(times.slice(2)),
					warmMinMs: Math.min(...times.slice(2)),
					warmMaxMs: Math.max(...times.slice(2)),
					wireSha256: digest(wires[0]),
				}),
			);
		} finally {
			transform.disposeRust();
			resetLkgSlotsForTest();
			resetCtxReduceRegisteredGloballyForTest();
			closeDatabase();
		}
	},
);

test.skipIf(process.env.REVIEW_OUTPUT === undefined)(
	"independent OpenCode2 defer bytes and per-pass cost",
	async () => {
		const { spyOn } = await import("bun:test");
		const configLoader = await load("plugin/src/config/index.ts");
		const { MagicContextConfigSchema } = await load(
			"plugin/src/config/schema/magic-context.ts",
		);
		const { openDatabase, closeDatabase } = await load(
			"plugin/src/features/magic-context/storage-db.ts",
		);
		const { registerContext } = await load("plugin/src/v2/hooks/context.ts");
		const storageGate = await load("plugin/src/v2/hooks/storage-gate.ts");
		const { Database } = await load("plugin/src/shared/sqlite.ts");
		const dir = join(evidenceRoot(), "v2-store");
		mkdirSync(join(dir, "opencode"), { recursive: true });
		const oldDb = process.env.OPENCODE_DB;
		process.env.OPENCODE_DB = join(dir, "opencode", "opencode.db");
		const store = new Database(process.env.OPENCODE_DB);
		store.exec(
			"CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT); CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT NOT NULL);",
		);
		store.close();
		const db = openDatabase(join(dir, "context.db"));
		if (!db) throw new Error("disposable context.db unavailable");
		const config = MagicContextConfigSchema.parse({
			historian: { disable: true },
			dreamer: { disable: true },
			memory: { enabled: false },
		});
		const configSpy = spyOn(
			configLoader,
			"loadPluginConfigDetailed",
		).mockReturnValue({ config });
		const bootSpy = spyOn(
			storageGate,
			"probeV2StorageAtBoot",
		).mockResolvedValue(db);
		let hook: ((draft: SessionContext) => Promise<void>) | undefined;
		let duties: { dispose(): Promise<void> } | undefined;
		const host = {
			location: { directory: process.env.REVIEW_CWD },
			agent: { transform: async () => {}, reload: async () => {} },
			model: { list: () => [] },
			storage: { get: async () => undefined, set: async () => {} },
			event: { subscribe: async function* () {} },
			tool: { hook: async () => {} },
			session: {
				remove: async () => {},
				compact: async () => {},
				interrupt: async () => {
					throw new Error("unexpected refusal");
				},
				hook: async (
					name: string,
					fn: (draft: SessionContext) => Promise<void>,
				) => {
					if (name === "context") hook = fn;
				},
				get: async () => ({ location: { directory: process.env.REVIEW_CWD } }),
			},
		};
		const raw: SessionContext = {
			sessionID: "review-oc2",
			model: {
				providerID: "openai",
				id: "gpt-4.1",
				limit: { context: 1000000 },
			},
			agent: "build",
			system: [],
			options: {},
			tools: {
				ctx_reduce: { description: "reduce", input: { type: "object" } },
				read: { description: "read file", input: { type: "object" } },
			},
			messages: [
				{
					id: "u1",
					role: "user",
					content: [{ type: "text", text: "Please inspect writer admission" }],
				},
			],
		};
		const times: number[] = [];
		const wires: string[] = [];
		try {
			duties = await registerContext(host);
			if (!hook) throw new Error("no context hook");
			for (let i = 0; i < 32; i++) {
				const draft = structuredClone(raw);
				const start = performance.now();
				await hook(draft);
				times.push(performance.now() - start);
				if (i >= 2) wires.push(JSON.stringify(draft));
				await new Promise((resolve) => setImmediate(resolve));
			}
			expect(wires.every((wire) => wire === wires[0])).toBe(true);
			expect(wires[0]).toContain("§1§ Please inspect writer admission");
			writeFileSync(join(evidenceRoot(), "oc2.json"), wires[0]);
			console.log(
				"REVIEW_OC2",
				JSON.stringify({
					source,

					samples: 30,
					bytes: Buffer.byteLength(wires[0]),
					sha256: digest(wires[0]),
					coldMs: times[0],
					warmMedianMs: median(times.slice(2)),
					warmMinMs: Math.min(...times.slice(2)),
					warmMaxMs: Math.max(...times.slice(2)),
				}),
			);
		} finally {
			await duties?.dispose();
			bootSpy.mockRestore();
			configSpy.mockRestore();
			closeDatabase();
			if (oldDb === undefined) delete process.env.OPENCODE_DB;
			else process.env.OPENCODE_DB = oldDb;
		}
	},
);
