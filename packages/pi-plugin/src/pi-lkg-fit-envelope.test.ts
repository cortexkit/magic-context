import { expect, spyOn, test } from "bun:test";
import { calibrationForModelKey } from "@magic-context/core/hooks/magic-context/decision-calibration";
import * as formatting from "@magic-context/core/hooks/magic-context/read-session-formatting";
import { readPiLkgFitEnvelope } from "./pi-lkg-fit-envelope";

test("callable tool schemas use the host wire resolver without invoking validators", () => {
	let validated = 0;
	let resolved = 0;
	const parameters = Object.assign(
		() => {
			validated++;
			throw new Error("not a factory");
		},
		{
			toJsonSchema: () => ({
				type: "object",
				properties: { path: { type: "string" } },
			}),
			assert: () => {},
		},
	);
	const host = {
		getAllTools: () => [{ name: "read", description: "read file", parameters }],
	};
	const system = { getSystemPrompt: () => "system" };
	const freeze = calibrationForModelKey(null);
	const envelope = readPiLkgFitEnvelope(
		system,
		host,
		"test/model",
		freeze,
		(tool) => {
			resolved++;
			expect(tool.parameters).toBe(parameters);
			return parameters.toJsonSchema();
		},
	);
	expect(envelope).toBeDefined();
	expect(resolved).toBe(1);
	expect(validated).toBe(0);
	expect(
		readPiLkgFitEnvelope(system, host, "test/model", freeze),
	).toBeUndefined();
	expect(
		readPiLkgFitEnvelope(system, host, "test/model", freeze, () => {
			throw new Error("unresolvable");
		}),
	).toBeUndefined();
	expect(
		readPiLkgFitEnvelope(system, host, "test/model", freeze, () => undefined),
	).toBeUndefined();
});

import { assertPiRawFallbackFits } from "./pi-raw-fallback";

const key = "anthropic/claude-fable-5-1";
const messages = [{ role: "user", content: "hello" }];
const system = { getSystemPrompt: () => "A complete system prompt." };
const tool = (description: string) => ({
	name: "tool",
	description,
	parameters: { type: "object", properties: {} },
});

test("LKG envelope counts full tool schemas with the matching frozen model policy", () => {
	const frozen = Object.freeze({
		...calibrationForModelKey(key),
		toolsRatio: 3,
		revision: "older-frozen-table",
	});
	const schemaTool = {
		...tool("small"),
		parameters: {
			type: "object",
			properties: {
				value: { type: "string", description: "word ".repeat(1500) },
			},
		},
	};
	const envelope = readPiLkgFitEnvelope(
		system,
		{ getAllTools: () => [schemaTool] },
		key,
		frozen,
	);
	expect(envelope).toBeDefined();
	expect(envelope?.calibration).toBe(frozen);
	// The complete JSON's byte proxy fits, but the frozen tools ratio does not.
	expect(
		Buffer.byteLength(
			JSON.stringify({
				system: system.getSystemPrompt(),
				tools: [schemaTool],
				messages,
			}),
		),
	).toBeLessThan(4000 * 4);
	expect(() =>
		assertPiRawFallbackFits(messages, 4000, () => {}, null, envelope),
	).toThrow();
});

test("LKG envelope reads Oh My Pi's segmented system prompt", () => {
	const envelope = readPiLkgFitEnvelope(
		{ getSystemPrompt: () => ["A complete", "system prompt."] },
		{ getAllTools: () => [tool("small")] },
		key,
		calibrationForModelKey(key),
	);
	expect(envelope).toBeDefined();
});

test("unknown LKG models use the unknown-model fit rule instead of a family or other-model freeze", () => {
	const envelope = readPiLkgFitEnvelope(
		system,
		{ getAllTools: () => [tool("word ".repeat(1800))] },
		"unmeasured/no-ratio",
		{
			...calibrationForModelKey(key),
			systemRatio: 1,
			toolsRatio: 1,
			proseRatio: 1,
		},
	);
	expect(() =>
		assertPiRawFallbackFits(messages, 3000, () => {}, null, envelope),
	).toThrow();
	expect(envelope?.calibration?.seeded).toBe(false);
	const family = readPiLkgFitEnvelope(system, { getAllTools: () => [] }, key, {
		...calibrationForModelKey(key),
		source: "family-fallback",
		seeded: true,
		toolsRatio: 0.1,
	});
	expect(family?.calibration?.seeded).toBe(false);
	expect(envelope?.envelopeBytes).toBeLessThan(3000 * 4);
});

test("the replay byte proxy includes the system and tools envelope independently of calibration", () => {
	// Small synthetic ratios isolate the independent byte guard: token pricing
	// alone must not admit the much larger serialized host envelope.
	const frozen = Object.freeze({
		...calibrationForModelKey(key),
		systemRatio: 0.0001,
		toolsRatio: 0.0001,
		proseRatio: 0.0001,
	});
	for (const [prompt, description] of [
		[" ".repeat(20000), "small"],
		["system", " ".repeat(20000)],
	]) {
		const envelope = readPiLkgFitEnvelope(
			{ getSystemPrompt: () => prompt },
			{ getAllTools: () => [tool(description)] },
			key,
			frozen,
		);
		expect(envelope).toBeDefined();
		expect(envelope?.envelopeBytes).toBeGreaterThan(3000 * 4);
		expect(() =>
			assertPiRawFallbackFits(messages, 3000, () => {}, null, envelope),
		).toThrow();
	}
});

test("missing, throwing or incomplete host metadata never produces an admissible replay envelope", () => {
	const frozen = calibrationForModelKey(key);
	for (const [ctx, pi] of [
		[{}, { getAllTools: () => [] }],
		[system, {}],
		[
			{
				getSystemPrompt: () => {
					throw new Error("missing prompt");
				},
			},
			{ getAllTools: () => [] },
		],
		[
			system,
			{
				getAllTools: () => {
					throw new Error("missing tools");
				},
			},
		],
		[
			system,
			{ getAllTools: () => [{ name: "partial", description: "no schema" }] },
		],
		[system, { getAllTools: () => [tool("valid"), { name: "partial" }] }],
		[
			system,
			{
				getAllTools: () => [
					{ ...tool("invalid schema"), parameters: { minimum: Number.NaN } },
				],
			},
		],
	] as const) {
		const envelope = readPiLkgFitEnvelope(ctx, pi, key, frozen);
		expect(envelope).toBeUndefined();
		expect(() =>
			assertPiRawFallbackFits(messages, 20000, () => {}, null, envelope),
		).toThrow();
	}
});

test("unavailable tokenizer refuses a replay instead of pricing a partial envelope heuristically", () => {
	const unavailable = spyOn(formatting, "hasTokenizerForFit").mockReturnValue(
		false,
	);
	try {
		const envelope = readPiLkgFitEnvelope(
			system,
			{ getAllTools: () => [] },
			key,
			calibrationForModelKey(key),
		);
		expect(envelope).toBeUndefined();
		expect(() =>
			assertPiRawFallbackFits(messages, 20000, () => {}, null, {
				modelKey: key,
				systemTokens: 100,
				toolDefinitionTokens: 0,
			}),
		).toThrow();
	} finally {
		unavailable.mockRestore();
	}
});

test("LKG token and byte guards price one coherent schema snapshot", () => {
	let reads = 0;
	const schemaTool = {
		...tool("small"),
		parameters: {
			type: "object",
			properties: {
				value: {
					type: "string",
					get description() {
						reads++;
						return reads === 1 ? "word ".repeat(1500) : "small";
					},
				},
			},
		},
	};
	const frozen = Object.freeze({
		...calibrationForModelKey(key),
		toolsRatio: 3,
	});
	const envelope = readPiLkgFitEnvelope(
		system,
		{ getAllTools: () => [schemaTool] },
		key,
		frozen,
	);
	expect(reads).toBe(1);
	expect(envelope).toBeDefined();
	expect(() =>
		assertPiRawFallbackFits(messages, 4000, () => {}, null, envelope),
	).toThrow();
});

test("measured envelope fingerprints include the active tool subset and reject unknown active schemas", () => {
	const definitions = [
		{ ...tool("first"), name: "first" },
		{ ...tool("second"), name: "second" },
	];
	const snapshot = (active: string[]) =>
		readPiLkgFitEnvelope(
			system,
			{ getAllTools: () => definitions, getActiveTools: () => active },
			key,
			calibrationForModelKey(key),
		);
	const first = snapshot(["first"]);
	const second = snapshot(["second"]);
	expect(first?.envelopeSignature).toBeDefined();
	expect(first?.envelopeSignature).not.toBe(second?.envelopeSignature);
	expect(first?.envelopeBytes).toBe(second?.envelopeBytes);
	expect(snapshot(["not-in-registry"])).toBeUndefined();
	expect(snapshot(["first", "first"])).toBeUndefined();
	const unavailable = readPiLkgFitEnvelope(
		system,
		{
			getAllTools: () => definitions,
			getActiveTools: () => {
				throw new Error("active set unavailable");
			},
		},
		key,
		calibrationForModelKey(key),
	);
	expect(unavailable?.toolDefinitionTokens).toBeGreaterThan(0);
	expect(unavailable?.envelopeSignature).toBeUndefined();
});
