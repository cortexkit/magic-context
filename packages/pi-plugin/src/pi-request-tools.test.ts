import { expect, it } from "bun:test";
import { readPiRequestToolsFingerprint } from "./pi-request-tools";

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
