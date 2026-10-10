import { expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { calibrationForModelKey } from "@magic-context/core/hooks/magic-context/decision-calibration";
import { resetLkgSlotsForTest } from "@magic-context/core/hooks/magic-context/lkg-slot";
import { Database } from "@magic-context/core/shared/sqlite";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import {
	__test,
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import { createPiLkgCoordinator } from "./pi-lkg";
import { readPiLkgFitEnvelope } from "./pi-lkg-fit-envelope";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	type PiMessage,
	textOf,
	userMessage,
} from "./test-utils.test";

type Handler = (
	event: { messages: PiMessage[] },
	ctx: ReturnType<typeof fakeContext>,
) => Promise<{ messages: PiMessage[] }>;

function install(db: ReturnType<typeof createTestDb>): Handler {
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, { db });
	return fake.handlers.get("context") as unknown as Handler;
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

for (const cancellation of ["successor", "signal"] as const) {
	test(`review: ${cancellation} fences an admitted Pi pass before late adoption`, async () => {
		const db = createTestDb();
		const sessionId = `review-late-${cancellation}`;
		const historian = deferred();
		const restorePause = __test.setBeforePipelineForTests(
			() => historian.promise,
		);
		const controller = new AbortController();
		let older: Promise<unknown> | undefined;
		try {
			getOrCreateSessionMeta(db, sessionId);
			updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
			const handler = install(db);
			const raw = [userMessage("abandoned input", 1)];
			const ctx = {
				...fakeContext(sessionId, process.cwd(), ["older"], raw),
				signal: controller.signal,
				getContextUsage: () => ({
					tokens: 96000,
					percent: 96,
					contextWindow: 100000,
				}),
			};
			older = handler({ messages: raw }, ctx).then(
				(value) => ({ value }),
				(error: Error) => ({ error: error.message }),
			);
			await new Promise((done) => setImmediate(done));
			// Pause after admission and before tagging so cancellation or a
			// replacement request can arrive without depending on a historian join.
			expect(db.inTransaction).toBe(false);
			expect(
				db.prepare("SELECT * FROM tags WHERE session_id=?").all(sessionId),
			).toHaveLength(0);
			if (cancellation === "successor") {
				restorePause();
				const newer = [userMessage("replacement input", 2)];
				const result = await handler(
					{ messages: newer },
					fakeContext(sessionId, process.cwd(), ["newer"], newer),
				);
				expect(JSON.stringify(result)).toContain("replacement input");
			} else {
				controller.abort(new Error("host cancelled after admission"));
			}
			historian.resolve();
			const result = await older;
			const oldRows = db
				.prepare(
					"SELECT message_id FROM tags WHERE session_id=? AND message_id LIKE 'older%'",
				)
				.all(sessionId);
			expect({ result, oldRows }).toEqual({
				result: {
					error:
						cancellation === "successor"
							? "Pi context pass superseded before writer admission"
							: "host cancelled after admission",
				},
				oldRows: [],
			});
		} finally {
			historian.resolve();
			await older;
			restorePause();
			clearContextHandlerSession(sessionId);
			resetLkgSlotsForTest();
			db.close();
		}
	});
}

test("review: adoption discovers a racing drop for an already-served historical message", async () => {
	const dir = createTestTempDirFromPath(join(tmpdir(), "pi-640-review-"));
	const path = join(dir, "context.db");
	const db = createTestDb(path);
	const sibling = new Database(path);
	const sessionId = "review-historical-adoption";
	let restore: (() => void) | undefined;
	try {
		const handler = install(db);
		const historical = userMessage("historical text", 1);
		const first = await handler(
			{ messages: [structuredClone(historical)] },
			fakeContext(sessionId, dir, ["historical"], [historical]),
		);
		expect(textOf(first.messages[0])).toContain("§1§ historical text");
		expect(
			__test.getTaggedStableMessageIdsForTests(sessionId).has("historical"),
		).toBe(true);
		const fingerprint = __test
			.buildEntryFingerprintMap([historical], () => "historical")
			.get("historical");
		const prepare = db.prepare.bind(db);
		let inserted = false;
		const spy = spyOn(db, "prepare").mockImplementation((sql) => {
			// The historical message already has a tag, so its fingerprint was
			// omitted from the prepared list. Add its dropped fallback row before
			// the code records the database version used to decide whether to rescan.
			if (
				sql === "SELECT total_changes() AS changes" &&
				!db.inTransaction &&
				!inserted
			) {
				inserted = true;
				sibling
					.prepare(
						"INSERT INTO tags(message_id,type,status,session_id,tag_number,byte_size,entry_fingerprint) VALUES ('pi-msg-racing:p0','message','dropped',?,9,0,?)",
					)
					.run(sessionId, fingerprint);
			}
			return prepare(sql);
		});
		restore = () => spy.mockRestore();
		const raw = [structuredClone(historical), userMessage("new tail", 2)];
		const result = await handler(
			{ messages: raw },
			fakeContext(sessionId, dir, ["historical", "tail"], raw),
		);
		expect(inserted).toBe(true);
		expect(textOf(result.messages[0])).toBe("[dropped §1§]");
		expect(
			db
				.prepare(
					"SELECT message_id FROM tags WHERE session_id=? AND message_id LIKE 'pi-msg-%'",
				)
				.all(sessionId),
		).toHaveLength(0);
	} finally {
		restore?.();
		clearContextHandlerSession(sessionId);
		resetLkgSlotsForTest();
		sibling.close();
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

const piMessagesProvider = await import(
	new URL("./api/pi-messages.js", import.meta.resolve("@earendil-works/pi-ai"))
		.href
);

function replayWithBookkeeping(
	before: PiMessage[],
	after: PiMessage[],
	provider: string,
	api: string,
) {
	resetLkgSlotsForTest();
	const db = createTestDb();
	try {
		const coordinator = createPiLkgCoordinator(db, (capture) => capture());
		const snapshot = (messages: PiMessage[]) =>
			coordinator.beginPass({
				sessionId: "review-wire",
				messages,
				entryIds: messages.map((_, index) => `entry-${index}`),
				modelKey: `${provider}/fixture`,
				providerKey: provider,
			});
		const captured = coordinator.captureAppliedPass({
			snapshot: snapshot(before),
			outputMessages: before,
			outputEntryIds: before.map((_, index) => `entry-${index}`),
			cacheBusting: false,
		});
		expect(captured, api).toBeDefined();
		return coordinator.replay(snapshot(after));
	} finally {
		resetLkgSlotsForTest();
		db.close();
	}
}

for (const field of ["completedAt", "contextSnapshot"]) {
	test(`review: Pi pi-messages wire-visible root ${field} invalidates LKG`, async () => {
		const model = {
			id: "fixture",
			provider: "review-gateway",
			api: "pi-messages",
			baseUrl: "https://example.invalid",
			contextWindow: 1000000,
			maxTokens: 8192,
			input: ["text"],
			reasoning: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const before = [
			userMessage("question"),
			assistantMessage("answer", 2, {
				api: model.api,
				provider: model.provider,
				model: model.id,
			}),
		];
		const after = structuredClone(before);
		Object.assign(after[1] as object, {
			[field]: field === "completedAt" ? 42 : { promptTokens: 1000 },
		});
		const wire = async (messages: PiMessage[]) => {
			let captured: string | undefined;
			const stream = piMessagesProvider.stream(
				model,
				{ messages },
				{
					apiKey: "fixture-not-a-real-key",
					fetch: async (_url: unknown, init: RequestInit) => {
						captured = String(init.body);
						return new Response("fixture response", { status: 400 });
					},
				},
			);
			await stream.result();
			expect(captured).toBeDefined();
			return captured;
		};
		const oldWire = await wire(before);
		const newWire = await wire(after);
		expect(newWire).not.toBe(oldWire);
		expect(newWire).toContain(`"${field}":`);
		const replay = replayWithBookkeeping(
			before,
			after,
			model.provider,
			model.api,
		);
		expect(replay.ok).toBe(false);
		if (!replay.ok) expect(replay.reason).toBe("lkg_content_mismatch");
	});
}

test("review: a racing real-id row must not renumber the already-served fallback message", async () => {
	const dir = createTestTempDirFromPath(join(tmpdir(), "pi-640-number-"));
	const path = join(dir, "context.db");
	const db = createTestDb(path);
	const sibling = new Database(path);
	const sessionId = "review-served-fallback-number";
	let restore: (() => void) | undefined;
	try {
		const handler = install(db);
		const original = userMessage("served fallback", 1);
		const ctx = fakeContext(sessionId, dir);
		ctx.sessionManager.getBranch = () => {
			throw new Error("in-flight entry unavailable");
		};
		const served = await handler(
			{ messages: [structuredClone(original)] },
			ctx,
		);
		expect(textOf(served.messages[0])).toBe("§1§ served fallback");
		const exec = db.exec.bind(db);
		const prepare = db.prepare.bind(db);
		let prepared = false;
		let inserted = false;
		const prepareSpy = spyOn(db, "prepare").mockImplementation((sql) => {
			if (sql === "SELECT total_changes() AS changes" && !db.inTransaction)
				prepared = true;
			return prepare(sql);
		});
		const spy = spyOn(db, "exec").mockImplementation((sql) => {
			if (sql === "BEGIN IMMEDIATE" && prepared && !inserted) {
				inserted = true;
				sibling
					.prepare(
						"INSERT INTO tags(message_id,type,status,session_id,tag_number,byte_size) VALUES ('real:p0','message','active',?,9,0)",
					)
					.run(sessionId);
				sibling
					.prepare(
						"INSERT INTO source_contents(tag_id,session_id,content,created_at,harness) VALUES (9,?,'served fallback',0,'pi')",
					)
					.run(sessionId);
			}
			return exec(sql);
		});
		restore = () => {
			spy.mockRestore();
			prepareSpy.mockRestore();
		};
		const raw = [structuredClone(original)];
		const adopted = await handler(
			{ messages: raw },
			fakeContext(sessionId, dir, ["real"], raw),
		);
		expect(inserted).toBe(true);
		expect(textOf(adopted.messages[0])).toBe(textOf(served.messages[0]));
	} finally {
		restore?.();
		clearContextHandlerSession(sessionId);
		resetLkgSlotsForTest();
		sibling.close();
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("review: an unavailable or broken wire-schema export cannot price callable parameters", () => {
	const tool = {
		name: "read",
		description: "read file",
		parameters: () => {
			throw new Error("a validator must not be invoked as a schema factory");
		},
	};
	const args = [
		{ getSystemPrompt: () => "system" },
		{ getAllTools: () => [tool] },
		"test/model",
		calibrationForModelKey(null),
	] as const;
	for (const resolver of [
		undefined,
		() => undefined,
		() => {
			throw new Error("missing export");
		},
	])
		expect(readPiLkgFitEnvelope(...args, resolver)).toBeUndefined();
	const plainPi = readPiLkgFitEnvelope(
		args[0],
		{ getAllTools: () => [{ ...tool, parameters: { type: "object" } }] },
		args[2],
		args[3],
	);
	// Plain Pi accepts JSON-object parameter schemas directly; it must not
	// require Oh My Pi's optional converter for callable validators.
	expect(plainPi).toBeDefined();
});

const fixtureModel = {
	id: "fixture",
	provider: "anthropic",
	api: "anthropic-messages",
	baseUrl: "https://example.invalid",
	contextWindow: 1000000,
	maxTokens: 8192,
	input: ["text", "image"],
	reasoning: true,
	compat: { officialEndpoint: true },
	identity: { class: "fixture" },
};

const converterMessages = [
	userMessage([
		{ type: "text", text: "question" },
		{ type: "image", data: "YWJj", mimeType: "image/png" },
	]),
	assistantMessage("answer", 2, {
		api: fixtureModel.api,
		provider: fixtureModel.provider,
		model: fixtureModel.id,
		stopReason: "toolUse",
		content: [
			{ type: "thinking", thinking: "reason", thinkingSignature: "signature" },
			{ type: "text", text: "answer" },
			{
				type: "toolCall",
				id: "call1",
				name: "read",
				arguments: { completedAt: 42, contextSnapshot: { nested: "argument" } },
			},
		],
	}),
	{
		role: "toolResult",
		toolCallId: "call1",
		toolName: "read",
		timestamp: 3,
		isError: false,
		content: [
			{ type: "text", text: "result" },
			{ type: "image", data: "ZGVm", mimeType: "image/png" },
		],
	} as PiMessage,
];

const piRoot = import.meta.resolve("@earendil-works/pi-ai");
const piGoogle = await import(new URL("./api/google-shared.js", piRoot).href);
const piCompletions = await import(
	new URL("./api/openai-completions.js", piRoot).href
);
const piResponses = await import(
	new URL("./api/openai-responses-shared.js", piRoot).href
);
const constructors: Array<
	[string, (messages: PiMessage[]) => unknown | Promise<unknown>]
> = [
	[
		"Pi Google",
		(messages) =>
			piGoogle.convertMessages(
				{ ...fixtureModel, api: "google-generative-ai", provider: "google" },
				{ messages },
			),
	],
	[
		"Pi Chat Completions",
		(messages) =>
			piCompletions.convertMessages(
				{ ...fixtureModel, api: "openai-completions", provider: "openai" },
				{ messages },
				{},
			),
	],
	[
		"Pi Responses",
		(messages) =>
			piResponses.convertResponsesMessages(
				{ ...fixtureModel, api: "openai-responses", provider: "openai" },
				{ messages },
				new Set(["openai"]),
			),
	],
];
if (process.env.MC640_HOST) {
	const root = `${process.env.MC640_HOST}/node_modules/@oh-my-pi/pi-ai/src/providers/`;
	const anthropic = await import(`${root}anthropic.ts`);
	const google = await import(`${root}google-shared.ts`);
	const completions = await import(`${root}openai-completions.ts`);
	const responses = await import(`${root}openai-shared.ts`);
	const codex = await import(`${root}openai-codex-responses.ts`);
	constructors.push(
		[
			"OMP Anthropic",
			(messages) =>
				anthropic.convertAnthropicMessages(messages, fixtureModel, false),
		],
		[
			"OMP Google",
			(messages) =>
				google.convertMessages(
					{ ...fixtureModel, api: "google-generative-ai", provider: "google" },
					{ messages },
				),
		],
		[
			"OMP Chat Completions",
			(messages) =>
				completions.convertMessages(
					{ ...fixtureModel, api: "openai-completions", provider: "openai" },
					{ messages },
					{},
				),
		],
		[
			"OMP Responses",
			(messages) =>
				responses.buildResponsesInput({
					model: {
						...fixtureModel,
						api: "openai-responses",
						provider: "openai",
					},
					context: { messages },
					nativeHistory: { replay: true },
				}),
		],
		[
			"OMP Codex",
			(messages) =>
				codex.buildTransformedCodexRequestBody(
					{
						...fixtureModel,
						api: "openai-codex-responses",
						provider: "openai-codex",
					},
					{ messages },
					undefined,
					"fixture-cache-key",
				),
		],
	);
}

for (const [name, convert] of constructors) {
	test(`review control: ${name} omits root bookkeeping but fences nested tool arguments`, async () => {
		const before = structuredClone(converterMessages);
		const oldWire = JSON.stringify(await convert(before));
		const after = structuredClone(before);
		for (const message of after)
			Object.assign(message as object, {
				completedAt: 42,
				contextSnapshot: { promptTokens: 1000 },
			});
		expect(JSON.stringify(await convert(after))).toBe(oldWire);
		expect(
			replayWithBookkeeping(
				before,
				after,
				fixtureModel.provider,
				fixtureModel.api,
			).ok,
		).toBe(true);
		const nested = structuredClone(before);
		const call = (
			nested[1] as {
				content: Array<{ type: string; arguments?: { completedAt: number } }>;
			}
		).content.find((part) => part.type === "toolCall");
		if (!call?.arguments) throw new Error("fixture tool call missing");
		call.arguments.completedAt++;
		expect(JSON.stringify(await convert(nested))).not.toBe(oldWire);
		expect(
			replayWithBookkeeping(
				before,
				nested,
				fixtureModel.provider,
				fixtureModel.api,
			).ok,
		).toBe(false);
		const future = structuredClone(before);
		Object.assign(future[1] as object, { futureProviderField: "new field" });
		expect(
			replayWithBookkeeping(
				before,
				future,
				fixtureModel.provider,
				fixtureModel.api,
			).ok,
		).toBe(false);
	});
}

test("review control: lock-free owner preparation adopts a sibling's later committed tool owner", () => {
	const dir = createTestTempDirFromPath(join(tmpdir(), "pi-640-owner-"));
	const path = join(dir, "context.db");
	const db = createTestDb(path);
	const sibling = new Database(path);
	const tagger = createTagger();
	const exec = db.exec.bind(db);
	let prepared = false;
	const spy = spyOn(db, "exec").mockImplementation((sql) => {
		if (sql === "BEGIN IMMEDIATE") {
			expect(prepared).toBe(true);
			sibling
				.prepare(
					"INSERT INTO tags(message_id,type,status,session_id,tag_number,byte_size,tool_name,tool_owner_message_id) VALUES ('call','tool','dropped','owner-review',7,100,'read','pi-msg-0-2-assistant')",
				)
				.run();
		}
		return exec(sql);
	});
	try {
		__test.adoptPiFallbackTags(db, "owner-review", tagger, new Map(), {
			messages: [
				assistantMessage("", 2, {
					content: [
						{ type: "toolCall", id: "call", name: "read", arguments: {} },
					],
				}),
			],
			resolveStableId: () => {
				expect(db.inTransaction).toBe(false);
				prepared = true;
				return "real-owner";
			},
		});
		expect(
			db
				.prepare("SELECT tool_owner_message_id,tag_number,status FROM tags")
				.get(),
		).toEqual({
			tool_owner_message_id: "real-owner",
			tag_number: 7,
			status: "dropped",
		});
		expect(tagger.getToolTag("owner-review", "call", "real-owner")).toBe(7);
	} finally {
		spy.mockRestore();
		sibling.close();
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("review: an aborted superseded waiter must not abort its replacement", async () => {
	const dir = createTestTempDirFromPath(join(tmpdir(), "pi-640-superseded-"));
	const path = join(dir, "context.db");
	const db = createTestDb(path);
	const locker = new Database(path);
	const sessionId = "review-aborted-superseded";
	const handler = install(db);
	const controller = new AbortController();
	let oldAbortCalls = 0;
	let older: Promise<unknown> | undefined;
	let newer: Promise<unknown> | undefined;
	try {
		locker.exec("BEGIN IMMEDIATE");
		const oldRaw = [userMessage("old turn", 1)];
		older = handler({ messages: oldRaw }, {
			...fakeContext(sessionId, dir, ["old"], oldRaw),
			signal: controller.signal,
			abort: () => {
				oldAbortCalls++;
			},
		} as ReturnType<typeof fakeContext>).then(
			(value) => ({ value }),
			(error: Error) => ({ error: error.message }),
		);
		await new Promise((done) => setImmediate(done));
		const newRaw = [userMessage("replacement", 2)];
		newer = handler(
			{ messages: newRaw },
			fakeContext(sessionId, dir, ["new"], newRaw),
		);
		controller.abort(new Error("old operation cancelled"));
		await older;
		locker.exec("ROLLBACK");
		await newer;
		expect(oldAbortCalls).toBe(0);
	} finally {
		if (locker.inTransaction) locker.exec("ROLLBACK");
		await Promise.allSettled([older, newer]);
		clearContextHandlerSession(sessionId);
		resetLkgSlotsForTest();
		locker.close();
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
