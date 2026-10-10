import { expect, test } from "bun:test";
import { resetLkgSlotsForTest } from "@magic-context/core/hooks/magic-context/lkg-slot";
import { createPiLkgCoordinator } from "./pi-lkg";
import { createTestDb } from "./test-utils.test";

const piConverter = await import(
	new URL(
		"./api/google-shared.js",
		import.meta.resolve("@earendil-works/pi-ai"),
	).href
);
const piRoot = import.meta.resolve("@earendil-works/pi-ai");
const piCompletions = await import(
	new URL("./api/openai-completions.js", piRoot).href
);
const piResponses = await import(
	new URL("./api/openai-responses-shared.js", piRoot).href
);
const ompConverter = process.env.MC640_HOST
	? await import(
			`${process.env.MC640_HOST}/node_modules/@oh-my-pi/pi-ai/src/providers/anthropic.ts`
		)
	: undefined;

const model = {
	id: "fixture",
	provider: "anthropic",
	api: "anthropic-messages",
	input: ["text", "image"],
	reasoning: true,
	contextWindow: 1000000,
	maxTokens: 8192,
	compat: { officialEndpoint: true },
	identity: { class: "fixture" },
};
const messages = [
	{
		role: "user",
		content: [
			{ type: "text", text: "question" },
			{ type: "image", data: "YWJj", mimeType: "image/png" },
		],
		timestamp: 1,
	},
	{
		role: "assistant",
		content: [
			{ type: "text", text: "answer" },
			{ type: "thinking", thinking: "reason", thinkingSignature: "signature" },
			{
				type: "toolCall",
				id: "call1",
				name: "read",
				arguments: {
					path: "fixture",
					completedAt: 42,
					contextSnapshot: "argument",
				},
			},
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "fixture",
		stopReason: "toolUse",
		timestamp: 2,
	},
	{
		role: "toolResult",
		toolCallId: "call1",
		toolName: "read",
		content: [
			{ type: "text", text: "result" },
			{ type: "image", data: "ZGVm", mimeType: "image/png" },
		],
		isError: false,
		timestamp: 3,
	},
];

function leafPaths(value: unknown, path: string[] = []): string[][] {
	if (!value || typeof value !== "object") return [path];
	return Object.entries(value).flatMap(([key, child]) =>
		leafPaths(child, [...path, key]),
	);
}

function replay(
	input: unknown[],
	route?: { apiKey?: string | null; transport?: string | null },
) {
	resetLkgSlotsForTest();
	const db = createTestDb();
	try {
		const coordinator = createPiLkgCoordinator(db, (capture) => capture());
		const begin = (messages: unknown[]) =>
			coordinator.beginPass({
				sessionId: "wire",
				messages,
				entryIds: ["u", "a", "t"],
				modelKey: "anthropic/fixture",
				providerKey: "anthropic",
				...route,
			});
		coordinator.captureAppliedPass({
			snapshot: begin(messages),
			outputMessages: messages,
			outputEntryIds: ["u", "a", "t"],
			cacheBusting: false,
		});
		return coordinator.replay(begin(input));
	} finally {
		db.close();
		resetLkgSlotsForTest();
	}
}

test("Pi LKG ignores only root completedAt and contextSnapshot bookkeeping", () => {
	for (const field of ["completedAt", "contextSnapshot"]) {
		const changed = structuredClone(messages);
		Object.assign(changed[1] as object, {
			[field]:
				field === "completedAt"
					? 100
					: { promptTokens: 1000, compactionEpoch: 0 },
		});
		expect(replay(changed).ok).toBe(true);
		if (ompConverter)
			expect(
				JSON.stringify(
					ompConverter.convertAnthropicMessages(changed, model, false),
				),
			).toBe(
				JSON.stringify(
					ompConverter.convertAnthropicMessages(messages, model, false),
				),
			);
		expect(
			JSON.stringify(
				piConverter.convertMessages(
					{ ...model, api: "google-generative-ai", provider: "google" },
					{ messages: changed },
				),
			),
		).toBe(
			JSON.stringify(
				piConverter.convertMessages(
					{ ...model, api: "google-generative-ai", provider: "google" },
					{ messages },
				),
			),
		);
	}
});

test("only proved direct APIs omit root bookkeeping; unknown routes keep the full fence", () => {
	const changed = structuredClone(messages);
	Object.assign(changed[1] as object, {
		completedAt: 42,
		contextSnapshot: { promptTokens: 1000 },
	});
	const constructors = [
		[
			"google-generative-ai",
			(input: unknown[]) =>
				piConverter.convertMessages(
					{ ...model, api: "google-generative-ai", provider: "google" },
					{ messages: input },
				),
		],
		[
			"openai-completions",
			(input: unknown[]) =>
				piCompletions.convertMessages(
					{ ...model, api: "openai-completions", provider: "openai" },
					{ messages: input },
					{},
				),
		],
		[
			"openai-responses",
			(input: unknown[]) =>
				piResponses.convertResponsesMessages(
					{ ...model, api: "openai-responses", provider: "openai" },
					{ messages: input },
					new Set(["openai"]),
				),
		],
	] as const;
	for (const [apiKey, convert] of constructors) {
		expect(JSON.stringify(convert(changed))).toBe(
			JSON.stringify(convert(messages)),
		);
		expect(replay(changed, { apiKey }).ok).toBe(true);
	}
	for (const route of [
		{ apiKey: "unknown-api" },
		{ apiKey: null },
		{ apiKey: "anthropic-messages", transport: "future-transport" },
	])
		expect(replay(changed, route).ok).toBe(false);
});

if (process.env.MC640_HOST) {
	test("proved OMP Anthropic and Codex APIs omit root bookkeeping", async () => {
		const { buildTransformedCodexRequestBody } = await import(
			`${process.env.MC640_HOST}/node_modules/@oh-my-pi/pi-ai/src/providers/openai-codex-responses.ts`
		);
		const changed = structuredClone(messages);
		Object.assign(changed[1] as object, {
			completedAt: 42,
			contextSnapshot: { promptTokens: 1000 },
		});
		expect(
			JSON.stringify(
				ompConverter.convertAnthropicMessages(changed, model, false),
			),
		).toBe(
			JSON.stringify(
				ompConverter.convertAnthropicMessages(messages, model, false),
			),
		);
		expect(replay(changed, { apiKey: "anthropic-messages" }).ok).toBe(true);
		const codex = {
			...model,
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://example.invalid",
		};
		expect(
			JSON.stringify(
				await buildTransformedCodexRequestBody(
					codex,
					{ messages: changed },
					undefined,
					"fixture",
				),
			),
		).toBe(
			JSON.stringify(
				await buildTransformedCodexRequestBody(
					codex,
					{ messages },
					undefined,
					"fixture",
				),
			),
		);
		expect(replay(changed, { apiKey: "openai-codex-responses" }).ok).toBe(true);
	});
	test("OMP pi-native whole-context serializer keeps root bookkeeping in the LKG fence", async () => {
		const { streamPiNative } = await import(
			`${process.env.MC640_HOST}/node_modules/@oh-my-pi/pi-ai/src/providers/pi-native-client.ts`
		);
		const nativeModel = {
			...model,
			baseUrl: "https://example.invalid",
			transport: "pi-native",
		};
		const wire = async (input: unknown[]) => {
			let body: string | undefined;
			const stream = streamPiNative(
				nativeModel,
				{ messages: input },
				{
					apiKey: "fixture-not-a-real-key",
					fetch: async (_url: unknown, init: RequestInit) => {
						body = String(init.body);
						return new Response("fixture response", { status: 400 });
					},
				},
			);
			await stream.result().catch((error: { status?: number }) => {
				expect(error.status).toBe(400);
			});
			expect(body).toBeDefined();
			return body;
		};
		const original = await wire(messages);
		for (const field of ["completedAt", "contextSnapshot"]) {
			const changed = structuredClone(messages);
			Object.assign(changed[1] as object, {
				[field]: field === "completedAt" ? 42 : { promptTokens: 1000 },
			});
			expect(await wire(changed)).not.toBe(original);
			const result = replay(changed, {
				apiKey: "anthropic-messages",
				transport: "pi-native",
			});
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason).toBe("lkg_content_mismatch");
		}
	});
}

test("Pi LKG rejects every real-converter-visible leaf mutation including nested bookkeeping names", () => {
	const converters = [
		(input: unknown[]) =>
			piConverter.convertMessages(
				{ ...model, api: "google-generative-ai", provider: "google" },
				{ messages: input },
			),
	];
	if (ompConverter)
		converters.push((input) =>
			ompConverter.convertAnthropicMessages(input, model, false),
		);
	let checked = 0;
	for (const path of leafPaths(messages)) {
		const changed = structuredClone(messages) as unknown as Record<
			string,
			unknown
		>;
		let parent = changed;
		for (const key of path.slice(0, -1))
			parent = parent[key] as Record<string, unknown>;
		const key = path.at(-1);
		if (!key) throw new Error("Missing leaf key");
		const old = parent[key];
		parent[key] =
			typeof old === "boolean"
				? !old
				: typeof old === "number"
					? old + 1
					: `${old}x`;
		if (
			!converters.some(
				(convert) =>
					JSON.stringify(convert(changed as unknown as unknown[])) !==
					JSON.stringify(convert(messages)),
			)
		)
			continue;
		const result = replay(changed as unknown as unknown[]);
		expect(result.ok, path.join(".")).toBe(false);
		if (!result.ok) expect(result.reason).toBe("lkg_content_mismatch");
		checked++;
	}
	expect(checked).toBeGreaterThan(15);
});
