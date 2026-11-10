import { expect, it } from "bun:test";
import {
	type PiRequestToolsRoute,
	readPiRequestToolsFingerprint,
} from "./pi-request-tools";

const tools = () => [
	{ name: "read", description: "Read", parameters: { type: "object" } },
	{ name: "bash", description: "Run", parameters: { type: "object" } },
];

it("fingerprints only the active tools Pi sends", () => {
	const registered = tools();
	const both = readPiRequestToolsFingerprint(
		{ getAllTools: () => registered, getActiveTools: () => ["read", "bash"] },
		undefined,
		[],
	);
	const readOnly = readPiRequestToolsFingerprint(
		{ getAllTools: () => registered, getActiveTools: () => ["read", "gone"] },
		undefined,
		[],
	);
	expect(both).toBeDefined();
	expect(readOnly).toBeDefined();
	expect(readOnly?.names).not.toBe(both?.names);
	expect(
		readPiRequestToolsFingerprint(
			{ getAllTools: () => registered, getActiveTools: () => ["bash", "read"] },
			undefined,
			[],
		),
	).toEqual(both);
});

it("is undefined when the host does not expose both tool lists", () => {
	expect(
		readPiRequestToolsFingerprint(
			{ getAllTools: () => tools() },
			undefined,
			[],
		),
	).toBeUndefined();
	expect(
		readPiRequestToolsFingerprint(
			{
				getAllTools: () => {
					throw new Error("host failure");
				},
				getActiveTools: () => ["read"],
			},
			undefined,
			[],
		),
	).toBeUndefined();
});

it("converts each schema object once and reuses its digest", () => {
	const registered = tools();
	let conversions = 0;
	const wire = (tool: { parameters: unknown }) => {
		conversions += 1;
		return tool.parameters;
	};
	const pi = {
		getAllTools: () => registered.map((tool) => ({ ...tool })),
		getActiveTools: () => ["read", "bash"],
	};
	const first = readPiRequestToolsFingerprint(pi, wire, []);
	const second = readPiRequestToolsFingerprint(pi, wire, []);
	expect(second).toEqual(first);
	expect(conversions).toBe(2);
	// A replaced schema object is converted again.
	registered[0] = {
		name: "read",
		description: "Read",
		parameters: { type: "object", required: [] } as never,
	};
	const third = readPiRequestToolsFingerprint(pi, wire, []);
	expect(conversions).toBe(3);
	expect(third?.schemas).not.toBe(first?.schemas);
});

const PI_ANTHROPIC: PiRequestToolsRoute & {
	model: NonNullable<PiRequestToolsRoute["model"]>;
} = {
	host: "pi",
	model: {
		provider: "anthropic",
		id: "claude-fable-5-2",
		api: "anthropic-messages",
	},
};

const single = (
	parameters: object,
	route: PiRequestToolsRoute = PI_ANTHROPIC,
) =>
	readPiRequestToolsFingerprint(
		{
			getAllTools: () => [{ name: "read", description: "Read", parameters }],
			getActiveTools: () => ["read"],
		},
		undefined,
		[],
		route,
	);

it("on pi-ai's Anthropic writer, counts only the schema keys the request sends", () => {
	const base = single({
		type: "object",
		properties: { path: { type: "string" } },
	});
	// pi-ai sends { type: "object", properties, required } only, writing a
	// missing `properties` or `required` as empty.
	expect(
		single({
			type: "object",
			properties: { path: { type: "string" } },
			required: [],
			additionalProperties: false,
			$schema: "https://json-schema.org/draft/2020-12/schema",
			title: "read input",
			description: "not sent",
		}),
	).toEqual(base);
	expect(single({ type: "object" })).toEqual(
		single({ properties: {}, required: [] }),
	);
	expect(
		single({
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		})?.schemas,
	).not.toBe(base?.schemas);
	expect(
		single({ type: "object", properties: { path: { type: "number" } } })
			?.schemas,
	).not.toBe(base?.schemas);
});

it("counts the whole schema on routes that send it whole", () => {
	const extra = { type: "object", additionalProperties: false };
	const routes: PiRequestToolsRoute[] = [
		// Bedrock sends the registered schema as it is.
		{
			host: "pi",
			model: { ...PI_ANTHROPIC.model, api: "bedrock-converse-stream" },
		},
		// A model that accepts strict tools gets the whole schema for tools that
		// ask for constrained sampling, which the registry does not show.
		{
			host: "pi",
			model: { ...PI_ANTHROPIC.model, compat: { supportsStrictTools: true } },
		},
		// Oh My Pi has its own writer.
		{ host: "omp", model: PI_ANTHROPIC.model },
	];
	for (const route of routes)
		expect(single(extra, route)?.schemas).not.toBe(
			single({ type: "object" }, route)?.schemas,
		);
});

it("over OAuth, counts tools under the Claude Code names pi-ai sends", () => {
	const fingerprint = (
		registered: Array<{ name: string; description: string }>,
		oauth: boolean,
	) =>
		readPiRequestToolsFingerprint(
			{
				getAllTools: () =>
					registered.map((tool) => ({
						...tool,
						parameters: { type: "object" },
					})),
				getActiveTools: () => registered.map((tool) => tool.name),
			},
			undefined,
			[],
			{ ...PI_ANTHROPIC, oauth },
		);
	const sentAsRead = fingerprint(
		[{ name: "Read", description: "Second" }],
		false,
	);
	// "read" goes out as "Read"; of two tools with the same Claude Code name
	// pi-ai sends the last one.
	expect(fingerprint([{ name: "read", description: "Second" }], true)).toEqual(
		sentAsRead,
	);
	expect(
		fingerprint(
			[
				{ name: "read", description: "First" },
				{ name: "Read", description: "Second" },
			],
			true,
		),
	).toEqual(sentAsRead);
	// Without OAuth both are sent under their own names.
	expect(
		fingerprint(
			[
				{ name: "read", description: "First" },
				{ name: "Read", description: "Second" },
			],
			false,
		)?.names,
	).not.toBe(sentAsRead?.names);
});

it("marks a tool a tool result activated before any call as deferred, as pi-ai sends it", () => {
	const registered = [
		...tools(),
		{
			name: "mcp_search",
			description: "Search",
			parameters: { type: "object" },
		},
	];
	const pi = {
		getAllTools: () => registered,
		getActiveTools: () => ["read", "bash", "mcp_search"],
	};
	const activation = [
		{
			role: "assistant",
			content: [
				{ type: "toolCall", id: "c1", name: "load_tools", arguments: {} },
			],
		},
		{
			role: "toolResult",
			toolCallId: "c1",
			content: [{ type: "text", text: "loaded" }],
			addedToolNames: ["mcp_search"],
		},
	];
	const immediate = readPiRequestToolsFingerprint(
		pi,
		undefined,
		[],
		PI_ANTHROPIC,
	);
	const deferred = readPiRequestToolsFingerprint(
		pi,
		undefined,
		activation,
		PI_ANTHROPIC,
	);
	// pi-ai references the deferred tool (tool_reference) in the same request,
	// so it counts; it differs from the immediate tool by its defer_loading flag.
	expect(deferred?.names).toBe(immediate?.names);
	expect(deferred?.descriptions).toBe(immediate?.descriptions);
	expect(deferred?.schemas).not.toBe(immediate?.schemas);
	// A tool already called before the result that activates it is immediate.
	expect(
		readPiRequestToolsFingerprint(
			pi,
			undefined,
			[
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "c0", name: "mcp_search", arguments: {} },
					],
				},
				...activation,
			],
			PI_ANTHROPIC,
		),
	).toEqual(immediate);
	// Models without tool references (Haiku here) get every tool immediate.
	const haiku = {
		...PI_ANTHROPIC,
		model: { ...PI_ANTHROPIC.model, id: "claude-haiku-5-5" },
	};
	expect(
		readPiRequestToolsFingerprint(pi, undefined, activation, haiku),
	).toEqual(readPiRequestToolsFingerprint(pi, undefined, [], haiku));
	// With every tool deferred, pi-ai sends them all as immediate tools.
	const onlyDeferred = {
		getAllTools: () => registered,
		getActiveTools: () => ["mcp_search"],
	};
	expect(
		readPiRequestToolsFingerprint(
			onlyDeferred,
			undefined,
			activation,
			PI_ANTHROPIC,
		),
	).toEqual(
		readPiRequestToolsFingerprint(onlyDeferred, undefined, [], PI_ANTHROPIC),
	);
});
