import { expect, it } from "bun:test";
import { protectedToolTokenCount } from "@magic-context/core/features/magic-context/reclaim-protection";
import type { TagEntry } from "@magic-context/core/features/magic-context/types";
import { resolveDecisionCalibration } from "@magic-context/core/hooks/magic-context/decision-calibration";
import {
	outgoingContextRefusal,
	PROTECTED_TOOL_RESULTS_OVER_LIMIT,
} from "@magic-context/core/hooks/magic-context/emergency-fail-closed";
import { readPiLkgFitEnvelope } from "./pi-lkg-fit-envelope";
import {
	assertPiRawFallbackFits,
	classifyPiOutgoingFit,
	estimatePiOutgoingInputTokens,
	piFallbackRefusal,
} from "./pi-raw-fallback";
import { tokenizePiMessages } from "./tokenize-pi-messages";

it("fallback busy refusals require SQLite contention even through a wrapped cause", () => {
	for (const lock of [
		{ code: "SQLITE_BUSY" },
		{ code: "SQLITE_LOCKED_SHAREDCACHE" },
		{ errcode: 517 },
	]) {
		const error = piFallbackRefusal(
			"identity",
			new Error("identity unavailable", { cause: lock }),
		);
		expect(error.name).toBe("PiStorageBusyError");
	}
	const persistent = piFallbackRefusal(
		"fallback-metadata-incomplete",
		new Error("corrupt ledger"),
	);
	expect(persistent.name).toBe("PiDegradedPassError");
	expect(persistent.message).toContain("corrupt ledger");
	expect(persistent.message).not.toContain("send your message again");
});

it("known text, thinking and tool fields survive unsupported sibling parts in the lower bound", () => {
	const envelope = {
		modelKey: "mock/mock",
		systemTokens: 10,
		toolDefinitionTokens: 0,
	};
	for (const unsupported of [
		{ type: "image", mimeType: "image/png", data: "opaque" },
		{ type: "extension-metadata", details: "not provider text" },
		null,
	]) {
		for (const known of [
			{ type: "text", text: "word ".repeat(100000) },
			{ type: "thinking", thinking: "word ".repeat(100000) },
			{
				type: "toolCall",
				name: "probe",
				arguments: { text: "word ".repeat(100000) },
			},
		]) {
			const estimate = estimatePiOutgoingInputTokens(
				[{ role: "assistant", content: [unsupported, known] }],
				envelope,
				undefined,
				50000,
			);
			expect(estimate.refusalTokens).toBeGreaterThanOrEqual(125000);
			expect(classifyPiOutgoingFit(estimate, 50000)).toBe("over-window-proof");
		}
		const uncertain = estimatePiOutgoingInputTokens(
			[
				{
					role: "user",
					content: [
						{ type: "text", text: "small" },
						unsupported,
						{ type: "extension", text: "x".repeat(1000000) },
					],
				},
			],
			envelope,
			undefined,
			50000,
		);
		expect(classifyPiOutgoingFit(uncertain, 50000)).toBe(
			"upper-estimate-pressure",
		);
	}
});

it("custom text keeps lower-bound overflow evidence without pricing notice metadata", () => {
	const envelope = {
		modelKey: "unknown/unknown",
		systemTokens: 100,
		toolDefinitionTokens: 0,
	};
	const custom = {
		role: "custom",
		customType: "notice",
		content: "x".repeat(1200000),
		display: false,
	};
	const estimate = estimatePiOutgoingInputTokens(
		[custom],
		envelope,
		undefined,
		272000,
	);
	expect(estimate.refusalTokens).toBe(300000);
	expect(classifyPiOutgoingFit(estimate, 272000)).toBe("over-window-proof");
	expect(
		tokenizePiMessages([{ ...custom, content: "visible notice" }]).conversation,
	).toBeGreaterThan(0);
	const metadata = estimatePiOutgoingInputTokens(
		[{ ...custom, content: "small", details: "x".repeat(1200000) }],
		envelope,
		undefined,
		272000,
	);
	expect(metadata.tokens).toBeLessThan(272000);
	expect(classifyPiOutgoingFit(metadata, 272000)).toBe("fits-or-unknown");
	const unknown = estimatePiOutgoingInputTokens(
		[{ role: "extension-role", content: "x".repeat(1200000) }],
		envelope,
		undefined,
		272000,
	);
	expect(unknown.tokens).toBeGreaterThan(272000);
	expect(classifyPiOutgoingFit(unknown, 272000)).toBe(
		"upper-estimate-pressure",
	);
});

it("Pi fit and fallback byte proxies do not price ciphertext as input text", () => {
	const envelope = {
		modelKey: "anthropic/claude-opus-5-5",
		systemTokens: 100,
		toolDefinitionTokens: 100,
		refusalToolDefinitionTokens: 100,
		toolDefinitionsMeasured: true,
	};
	const plain = [
		{
			role: "assistant",
			content: [{ type: "thinking", thinking: "A short thought" }],
		},
	];
	const signed = [
		{
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "A short thought",
					thinkingSignature: "opaque".repeat(100_000),
				},
			],
		},
	];
	expect(estimatePiOutgoingInputTokens(signed, envelope).refusalTokens).toBe(
		estimatePiOutgoingInputTokens(plain, envelope).refusalTokens,
	);
	const fit = estimatePiOutgoingInputTokens(
		signed,
		envelope,
		undefined,
		16_000,
	);
	expect(fit.refusalTokens ?? fit.tokens).toBeLessThan(16_000);
	expect(fit.tokens).toBeLessThan(16_000);
	expect(() =>
		assertPiRawFallbackFits(signed, 16_000, () => {}, null, envelope),
	).not.toThrow();
	const redacted = [
		{
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "opaque".repeat(100_000),
					redacted: true,
					thinkingSignature: "opaque",
				},
			],
		},
	];
	expect(
		estimatePiOutgoingInputTokens(redacted, envelope, undefined, 16_000)
			.refusalGrade,
	).toBe(false);
	expect(() =>
		assertPiRawFallbackFits(redacted, 16_000, () => {}, null, envelope),
	).not.toThrow();
	const text = [{ role: "user", content: "large text ".repeat(20_000) }];
	expect(
		estimatePiOutgoingInputTokens(text, envelope, undefined, 16_000)
			.refusalGrade,
	).toBe(true);
	const tool = [
		{
			role: "assistant",
			content: [
				{
					type: "toolCall",
					name: "probe",
					arguments: { thinkingSignature: "large text ".repeat(20_000) },
				},
			],
		},
	];
	expect(
		estimatePiOutgoingInputTokens(tool, envelope, undefined, 16_000)
			.refusalGrade,
	).toBe(true);
});

it("Pi healthy refusal settles huge and small byte bounds without BPE", () => {
	const envelope = {
		modelKey: "unknown/unknown",
		systemTokens: 100,
		toolDefinitionTokens: 0,
	};
	const startedAt = performance.now();
	const huge = estimatePiOutgoingInputTokens(
		[{ role: "toolResult", content: "x".repeat(12 * 1024 * 1024) }],
		envelope,
		undefined,
		16000,
	);
	expect(huge.refusalBasis).toBe("byte-bound");
	expect(huge.refusalGrade).toBe(true);
	expect(performance.now() - startedAt).toBeLessThan(1000);
	const small = estimatePiOutgoingInputTokens(
		[{ role: "user", content: "x".repeat(4000) }],
		envelope,
		undefined,
		16000,
	);
	expect(small.refusalBasis).toBe("byte-bound");
	expect(small.refusalGrade).toBe(false);
});

it("re-review: Pi must not refuse a fitting uncalibrated request on the unknown-model upper envelope", () => {
	const messages = [
		{
			role: "toolResult",
			toolName: "probe",
			toolCallId: "probe-call",
			content: [{ type: "text", text: "word ".repeat(8000) }],
		},
	];
	const unknown = resolveDecisionCalibration(
		"unmeasured-provider",
		"unmeasured-model",
	);
	const envelope = {
		modelKey: unknown.modelKey,
		systemTokens: 100,
		toolDefinitionTokens: 20,
		toolDefinitionsMeasured: true,
		refusalToolDefinitionTokens: 20,
	};
	const estimate = estimatePiOutgoingInputTokens(messages, envelope);
	// This altered ratio checks local token pricing only; it does not prove that
	// the route has a measured calibration suitable for refusing the request.
	const local = estimatePiOutgoingInputTokens(messages, {
		...envelope,
		calibration: { ...unknown, seeded: true },
	});
	expect(local.tokens).toBeLessThan(14000);
	expect(estimate.tokens).toBeGreaterThan(16000);
	expect(estimate.trusted).toBe(true);
	expect(estimate.refusalGrade).toBe(false);
	const protectedMass = protectedToolTokenCount(
		[
			{
				tagNumber: 1,
				type: "tool",
				status: "active",
				toolName: "probe",
				tokenCount: local.tokens - 120,
			} as TagEntry,
		],
		{ probe: 1 },
		unknown,
	);
	expect(
		outgoingContextRefusal(estimate, 16000, protectedMass),
	).toBeUndefined();
});

it("Pi refuses incomplete fallback even when the byte proxy fits", () => {
	expect(() =>
		assertPiRawFallbackFits(
			[{ role: "user", content: "hello" }],
			20000,
			() => {},
			null,
		),
	).toThrow();
});

it("Pi refusal counts active route definitions rather than the all-tools admission envelope", () => {
	const key = "anthropic/claude-fable-5-1";
	const envelope = readPiLkgFitEnvelope(
		{ getSystemPrompt: () => "Helpful system" },
		{
			getAllTools: () => [
				{
					name: "inactive",
					description: "word ".repeat(20000),
					parameters: {},
				},
			],
			getActiveTools: () => [],
		},
		key,
		resolveDecisionCalibration("anthropic", "claude-fable-5-1"),
	);
	const estimate = estimatePiOutgoingInputTokens(
		[{ role: "user", content: "hello" }],
		envelope,
	);
	expect(estimate.tokens).toBeGreaterThan(16000);
	expect(estimate.refusalGrade).toBe(true);
	expect(estimate.refusalTokens).toBeLessThan(1000);
	expect(outgoingContextRefusal(estimate, 16000)).toBeUndefined();
	const missing = { ...envelope!, toolDefinitionsMeasured: false };
	expect(
		estimatePiOutgoingInputTokens(
			[{ role: "user", content: "word ".repeat(20000) }],
			missing,
		).refusalGrade,
	).toBe(false);
	const family = {
		...envelope!,
		modelKey: "anthropic/claude-fable-5-2",
		calibration: resolveDecisionCalibration("anthropic", "claude-fable-5-2"),
	};
	expect(
		estimatePiOutgoingInputTokens(
			[{ role: "user", content: "word ".repeat(20000) }],
			family,
		).refusalGrade,
	).toBe(false);
});

it("Pi admission may retain an unknown freeze while refusal uses the current measured seed", () => {
	const observed = {
		modelKey: "anthropic/claude-fable-5-1",
		systemTokens: 100,
		toolDefinitionTokens: 0,
		refusalToolDefinitionTokens: 0,
		toolDefinitionsMeasured: true,
		calibration: resolveDecisionCalibration(undefined, undefined),
	};
	const estimate = estimatePiOutgoingInputTokens(
		[
			{
				role: "toolResult",
				content: [{ type: "text", text: "word ".repeat(8000) }],
			},
		],
		observed,
	);
	expect(estimate.tokens).toBeGreaterThan(16000);
	expect(estimate.refusalGrade).toBe(true);
	expect(estimate.refusalTokens).toBeLessThan(16000);
	expect(outgoingContextRefusal(estimate, 16000)).toBeUndefined();
});
it("Pi admits a complete calibrated fallback and refuses the locally fitting over-wall request", () => {
	const messages = [{ role: "user", content: "hello" }];
	const observed = {
		modelKey: "anthropic/claude-fable-5-1",
		systemTokens: 10000,
		toolDefinitionTokens: 0,
	};
	expect(() =>
		assertPiRawFallbackFits(messages, 20000, () => {}, null, observed),
	).not.toThrow();
	expect(() =>
		assertPiRawFallbackFits(messages, 12000, () => {}, null, observed),
	).toThrow();
});
it("Pi refuses a complete protected over-limit final envelope but not untrusted counts", () => {
	const messages = [
		{
			role: "toolResult",
			toolCallId: "large",
			toolName: "probe",
			content: [{ type: "text", text: "word ".repeat(12000) }],
		},
	];
	const observed = {
		modelKey: "anthropic/claude-fable-5-1",
		systemTokens: 100,
		toolDefinitionTokens: 0,
		refusalToolDefinitionTokens: 0,
		toolDefinitionsMeasured: true,
	};
	const estimate = estimatePiOutgoingInputTokens(messages, observed);
	expect(estimate.trusted).toBe(true);
	expect(estimate.refusalGrade).toBe(true);
	const rawTools = tokenizePiMessages(messages).toolCall;
	const protectedMass = protectedToolTokenCount(
		[
			{
				tagNumber: 1,
				type: "tool",
				status: "active",
				toolName: "probe",
				tokenCount: rawTools,
			} as TagEntry,
		],
		{ probe: 1 },
		resolveDecisionCalibration("anthropic", "claude-fable-5-1"),
	);
	expect(rawTools).toBeLessThan(16000);
	expect(protectedMass).toBeGreaterThan(16000);
	expect(outgoingContextRefusal(estimate, 16000, protectedMass)).toBe(
		PROTECTED_TOOL_RESULTS_OVER_LIMIT,
	);
	expect(
		outgoingContextRefusal(
			estimatePiOutgoingInputTokens(messages),
			16000,
			96000,
		),
	).toBeUndefined();
	expect(
		outgoingContextRefusal(
			estimatePiOutgoingInputTokens([{ role: "unknown" }], observed),
			16000,
			96000,
		),
	).toBeUndefined();
});

// Issue 938: base64 image payloads were priced as input text, so any
// image-heavy request read as over the window.
function imageToolTurns(count: number, imageBytes: number): unknown[] {
	const messages: unknown[] = [{ role: "user", content: "make images" }];
	for (let i = 0; i < count; i++) {
		messages.push(
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: `img-${i}`,
						name: "generate_image",
						arguments: { prompt: `image ${i}` },
					},
				],
			},
			{
				role: "toolResult",
				toolCallId: `img-${i}`,
				toolName: "generate_image",
				content: [
					{ type: "text", text: `generated image ${i}` },
					{
						type: "image",
						mimeType: "image/png",
						data: "A".repeat(imageBytes),
					},
				],
			},
		);
	}
	return messages;
}

it("prices each image at its token cost, so an image-heavy request under the window fits", () => {
	const envelope = {
		modelKey: "mock/mock",
		systemTokens: 100,
		toolDefinitionTokens: 0,
	};
	// 30 images of 200 KB base64 each: about 6 MB of payload, 36k image tokens.
	const messages = imageToolTurns(30, 200_000);
	for (const limit of [272_000, undefined]) {
		const estimate = estimatePiOutgoingInputTokens(
			messages,
			envelope,
			undefined,
			limit,
		);
		expect(estimate.trusted).toBe(true);
		expect(estimate.tokens).toBeLessThan(272_000);
		expect(classifyPiOutgoingFit(estimate, 272_000)).toBe("fits-or-unknown");
	}
});

it("an image count past the window reads as pressure, never as proof", () => {
	const envelope = {
		modelKey: "mock/mock",
		systemTokens: 100,
		toolDefinitionTokens: 0,
	};
	// 300 tiny images: little payload, but 300 images at 1,200 tokens each.
	const messages = imageToolTurns(300, 64);
	for (const limit of [272_000, undefined]) {
		const estimate = estimatePiOutgoingInputTokens(
			messages,
			envelope,
			undefined,
			limit,
		);
		expect(estimate.tokens).toBeGreaterThan(272_000);
		// A fixed per-image price is no proven minimum.
		expect(estimate.refusalGrade).toBe(false);
		expect(classifyPiOutgoingFit(estimate, 272_000)).toBe(
			"upper-estimate-pressure",
		);
	}
});

it("the replay fit check prices images like the outgoing estimate, on both sides of the limit", () => {
	const envelope = {
		modelKey: "mock/mock",
		systemTokens: 100,
		toolDefinitionTokens: 0,
	};
	// About 6 MB of base64 in 30 images: 36k image tokens, well inside 272k.
	const heavy = imageToolTurns(30, 200_000);
	const lines: string[] = [];
	expect(() =>
		assertPiRawFallbackFits(
			heavy,
			272_000,
			(line) => lines.push(line),
			null,
			envelope,
		),
	).not.toThrow();
	expect(
		classifyPiOutgoingFit(
			estimatePiOutgoingInputTokens(heavy, envelope, undefined, 272_000),
			272_000,
		),
	).toBe("fits-or-unknown");
	// 300 tiny images: 360k image tokens, over the limit by count alone.
	const many = imageToolTurns(300, 64);
	lines.length = 0;
	expect(() =>
		assertPiRawFallbackFits(
			many,
			272_000,
			(line) => lines.push(line),
			null,
			envelope,
		),
	).toThrow();
	expect(lines.join("\n")).toContain("raw_fallback_over_context_limit");
});

it("a replay refused for a part it cannot price says so, not that it is over the limit", () => {
	const lines: string[] = [];
	let refusal: unknown;
	try {
		assertPiRawFallbackFits(
			[
				{
					role: "user",
					content: [
						{ type: "text", text: "small" },
						{ type: "extension-metadata", details: "not provider text" },
					],
				},
			],
			983_040,
			(line) => lines.push(line),
			null,
			{ modelKey: "mock/mock", systemTokens: 100, toolDefinitionTokens: 0 },
		);
	} catch (error) {
		refusal = error;
	}
	expect(String((refusal as Error | undefined)?.message)).toContain(
		"fallback-messages-incomplete",
	);
	expect(lines.join("\n")).toContain(
		"raw_fallback_refused completeness=partial messages=unpriceable",
	);
	expect(lines.join("\n")).not.toContain("raw_fallback_over_context_limit");
});
