import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { computeProtectionWindow } from "@magic-context/core/features/magic-context/protection-window";
import type { TagEntry } from "@magic-context/core/features/magic-context/types";
import {
	decideChannel1,
	evaluateChannel2,
} from "@magic-context/core/hooks/magic-context/ctx-reduce-nudge";
import type { MessageLike } from "@magic-context/core/hooks/magic-context/tag-messages";
import {
	effectiveTailHygiene,
	measureTailHygiene,
	refreshTailHygieneBaseline,
} from "@magic-context/core/hooks/magic-context/tail-hygiene-walk";
import {
	effectivePiTailHygiene,
	measurePiTailHygiene,
	refreshPiTailHygieneBaseline,
} from "./tail-hygiene-walk-pi";

type TextBlock = { type: "text"; unit: string; repeat: number };
type ReasoningBlock = { type: "reasoning"; unit: string; repeat: number };
type ToolCallBlock = {
	type: "tool_call";
	id: string;
	name: string;
	input: unknown;
};
type ToolResultBlock = {
	type: "tool_result";
	id: string;
	name: string;
	unit: string;
	repeat: number;
};
type FileBlock = { type: "file"; mime: string; url: string };
type Block =
	| TextBlock
	| ReasoningBlock
	| ToolCallBlock
	| ToolResultBlock
	| FileBlock;
type FixtureMessage = {
	mid: string;
	ordinal: number;
	role: "user" | "assistant";
	synthetic?: boolean;
	blocks: Block[];
};
type FixtureTag = {
	tag_number: number;
	block_id: string;
	kind: "message" | "tool" | "file";
	token_count: number;
};
type Fixture = {
	id: string;
	/** Retained only to prove the deprecated count does not affect parity. */
	protected_tags: number;
	protected_tokens_effective: number;
	messages: FixtureMessage[];
	tags: FixtureTag[];
	pending_drop_tag_numbers?: number[];
	expected: { u: number; t: number; band: string };
};
type Golden = {
	schema: number;
	provenance: { generator_version: string; input_sha256: string };
	cases: Fixture[];
};

const golden = JSON.parse(
	readFileSync(
		new URL(
			"../../../crates/mc-module/testdata/nudge-hygiene-golden.json",
			import.meta.url,
		),
		"utf8",
	),
) as Golden;

const repeated = (unit: string, repeat: number): string => unit.repeat(repeat);

function toCoreMessages(fixture: Fixture): MessageLike[] {
	return fixture.messages.map((message) => ({
		info: {
			...(message.synthetic ? {} : { id: message.mid }),
			role: message.role,
		},
		parts: message.blocks.map((block) => {
			switch (block.type) {
				case "text":
					return {
						type: "text",
						text: repeated(block.unit, block.repeat),
						synthetic: message.synthetic === true,
					};
				case "reasoning":
					return {
						type: "thinking",
						thinking: repeated(block.unit, block.repeat),
					};
				case "tool_call":
					return {
						type: "tool-invocation",
						callID: block.id,
						tool: block.name,
						args: block.input,
					};
				case "tool_result":
					return {
						type: "tool_result",
						tool_use_id: block.id,
						content: repeated(block.unit, block.repeat),
					};
				case "file":
					return { type: "file", mime: block.mime, url: block.url };
				default:
					throw new Error("unsupported parity fixture block");
			}
		}),
	})) as MessageLike[];
}

function ownerByCall(fixture: Fixture): Map<string, string> {
	const owners = new Map<string, string>();
	for (const message of fixture.messages) {
		for (const block of message.blocks) {
			if (block.type === "tool_call" && !owners.has(block.id)) {
				owners.set(block.id, message.mid);
			}
		}
	}
	return owners;
}

function toTags(fixture: Fixture, pi = false): TagEntry[] {
	const messagesByMid = new Map(
		fixture.messages.map((message) => [message.mid, message]),
	);
	const owners = ownerByCall(fixture);
	return fixture.tags.map((tag) => {
		const [mid, rawIndex] = tag.block_id.split("#");
		const index = Number(rawIndex);
		const message = messagesByMid.get(mid ?? "");
		const block = message?.blocks[index];
		const legacyCallId = !message && tag.kind === "tool" ? tag.block_id : null;
		const callId =
			block?.type === "tool_result" || block?.type === "tool_call"
				? block.id
				: legacyCallId;
		const toolOwnerMessageId = legacyCallId
			? null
			: callId
				? (owners.get(callId) ?? null)
				: null;
		let messageId =
			tag.kind === "tool"
				? (callId ?? tag.block_id)
				: `${mid}:${tag.kind === "file" ? "file" : "p"}${index}`;
		if (
			pi &&
			tag.kind === "file" &&
			block?.type === "file" &&
			!block.mime.startsWith("image/")
		) {
			messageId = `${mid}:p${index}`;
		}
		return {
			tagNumber: tag.tag_number,
			messageId,
			type:
				tag.kind === "tool" ? "tool" : tag.kind === "file" ? "file" : "message",
			status: "active",
			dropMode: "full",
			toolName: tag.kind === "tool" ? "read" : null,
			inputByteSize: 0,
			byteSize: 1,
			reasoningByteSize: 0,
			sessionId: "three-leg-parity",
			cavemanDepth: 0,
			toolOwnerMessageId,
		} satisfies TagEntry;
	});
}

function protectedTagNumbers(fixture: Fixture): Set<number> {
	// The golden stores persisted-row mass and the epoch floor, so every JavaScript
	// leg derives canonical membership exactly as the production callers do.
	return computeProtectionWindow(
		fixture.tags,
		fixture.protected_tokens_effective,
	).tagNumberSet.tagNumbers;
}

function toPiMessages(fixture: Fixture): object[] {
	return fixture.messages.map((message) => {
		const toolResult = message.blocks.find(
			(block): block is ToolResultBlock => block.type === "tool_result",
		);
		return {
			_mid: message.mid,
			role: message.synthetic
				? "custom"
				: toolResult
					? "toolResult"
					: message.role,
			...(toolResult
				? { toolCallId: toolResult.id, toolName: toolResult.name }
				: {}),
			content: message.blocks.map((block) => {
				switch (block.type) {
					case "text":
						return {
							type: "text",
							text: repeated(block.unit, block.repeat),
						};
					case "reasoning":
						return {
							type: "thinking",
							thinking: repeated(block.unit, block.repeat),
						};
					case "tool_call":
						return {
							type: "toolCall",
							id: block.id,
							name: block.name,
							arguments: block.input,
						};
					case "tool_result":
						return {
							type: "text",
							text: repeated(block.unit, block.repeat),
						};
					case "file":
						return block.mime.startsWith("image/")
							? {
									type: "image",
									data: block.url,
									mimeType: block.mime,
								}
							: { type: "text", text: block.url };
					default:
						throw new Error("unsupported parity fixture block");
				}
			}),
		};
	});
}

function band(u: number, t: number): string {
	const baseline = {
		baselineU: u,
		baselineT: t,
		turnDeltaU: 0,
		turnDeltaT: 0,
		evaluable: true,
		generationInvalidated: false,
	};
	if (evaluateChannel2(baseline).shouldTrigger) return "channel2";
	const decision = decideChannel1({
		...baseline,
		lastNudgeUndropped: 0,
		lastNudgeLevel: "",
		hasRecentReduce: false,
	});
	return decision.fire ? decision.level : "quiet";
}

function tolerance(expected: number): number {
	return Math.max(12, Math.ceil(Math.abs(expected) * 0.03));
}

function measureLegs(
	fixture: Fixture,
	protectedNumbers = protectedTagNumbers(fixture),
) {
	const pendingDropTagNumbers = new Set(fixture.pending_drop_tag_numbers ?? []);
	const core = measureTailHygiene({
		messages: toCoreMessages(fixture),
		tags: toTags(fixture),
		protectedTagNumbers: protectedNumbers,
		pendingDropTagNumbers,
	});
	const pi = measurePiTailHygiene({
		messages: toPiMessages(fixture),
		tags: toTags(fixture, true),
		protectedTagNumbers: protectedNumbers,
		pendingDropTagNumbers,
		stableId: (message) =>
			typeof (message as { _mid?: unknown })._mid === "string"
				? (message as { _mid: string })._mid
				: undefined,
	});
	return { core, pi, protectedNumbers };
}

function liveIncidentFixture(): Fixture {
	const fixture = golden.cases.find(
		(entry) => entry.id === "live-incident-mixed-tail",
	);
	if (!fixture) throw new Error("missing live-incident parity fixture");
	return fixture;
}

function assertLeg(
	caseId: string,
	leg: "TypeScript" | "Pi",
	actual: { u: number; t: number },
	expected: Fixture["expected"],
): void {
	expect(
		Math.abs(actual.u - expected.u),
		`${caseId} ${leg} U drift`,
	).toBeLessThanOrEqual(tolerance(expected.u));
	expect(
		Math.abs(actual.t - expected.t),
		`${caseId} ${leg} T drift`,
	).toBeLessThanOrEqual(tolerance(expected.t));
	expect(band(actual.u, actual.t), `${caseId} ${leg} band drift`).toBe(
		expected.band,
	);
	expect(actual.u, `${caseId} ${leg} violated U subset T`).toBeLessThanOrEqual(
		actual.t,
	);
}

describe("nudge hygiene three-leg differential corpus", () => {
	it("keeps TypeScript and Pi aligned with the Rust-consumed golden", () => {
		expect(golden.schema).toBe(2);
		expect(golden.provenance.generator_version).toBe("nudge-hygiene-ts-v3");
		expect(golden.cases.length).toBeGreaterThanOrEqual(12);

		for (const fixture of golden.cases) {
			const { core, pi, protectedNumbers } = measureLegs(fixture);
			assertLeg(fixture.id, "TypeScript", core, fixture.expected);
			assertLeg(fixture.id, "Pi", pi, fixture.expected);
			expect(
				Math.abs(core.u - pi.u),
				`${fixture.id} TypeScript/Pi U drift`,
			).toBeLessThanOrEqual(tolerance(core.u));
			expect(
				band(core.u, core.t),
				`${fixture.id} TypeScript/Pi band drift`,
			).toBe(band(pi.u, pi.t));
			if (fixture.id === "queued-tool-arc-full-mass") {
				expect(core.u).toBe(fixture.expected.u);
				expect(pi.u).toBe(fixture.expected.u);
			}
			if (fixture.id === "protected-recency-reserve") {
				expect(protectedNumbers).toContain(2);
			}
			if (fixture.id === "protected-token-window-spans-more-than-one-tag") {
				expect(protectedNumbers).toEqual(new Set([1, 2, 3, 4]));
			}
			if (fixture.id === "empty-protected-token-window") {
				expect(fixture.protected_tags).toBe(99);
				expect(protectedNumbers).toEqual(new Set());
			}
		}
	});

	it("keeps the live incident quiet when only prose and protected tools remain", () => {
		const fixture = liveIncidentFixture();
		expect(fixture.expected).toEqual({ u: 0, t: 464_203, band: "quiet" });
		const { core, pi } = measureLegs(fixture);
		for (const { u, t } of [core, pi]) {
			expect(u).toBe(0);
			expect(t).toBe(464_203);
			expect(band(u, t)).toBe("quiet");
		}
	});

	it("still reaches urgent when the live-incident tail carries unprotected tool backlog", () => {
		const fixture = liveIncidentFixture();
		// Every earlier above-quiet case reached that band through prose. Add tool
		// output outside the protection window to exercise real reclaimable mass.
		const withBacklog: Fixture = {
			...fixture,
			messages: [
				...fixture.messages,
				{
					mid: "extra-owner",
					ordinal: 4,
					role: "assistant",
					blocks: [{ type: "tool_call", id: "extra", name: "read", input: {} }],
				},
				{
					mid: "extra-result",
					ordinal: 5,
					role: "user",
					blocks: [
						{
							type: "tool_result",
							id: "extra",
							name: "read",
							unit: "output ",
							repeat: 400_000,
						},
					],
				},
			],
			tags: [
				...fixture.tags,
				{
					tag_number: 2,
					block_id: "extra-result#0",
					kind: "tool",
					token_count: 400_001,
				},
			],
		};
		const { core, pi } = measureLegs(withBacklog, new Set());
		for (const { u, t } of [core, pi]) {
			expect(band(u, t)).toBe("urgent");
		}
	});
});

describe("prose stays in T but not in U on both TypeScript walks (#954)", () => {
	const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
	const proseFixture = (extra: FixtureMessage[] = []): Fixture => {
		const messages: FixtureMessage[] = [
			{
				mid: "u1",
				ordinal: 1,
				role: "user",
				blocks: [{ type: "text", unit: "read the schema ", repeat: 40 }],
			},
			{
				mid: "a1",
				ordinal: 2,
				role: "assistant",
				blocks: [
					{ type: "text", unit: "reading it now ", repeat: 20 },
					{
						type: "tool_call",
						id: "call-schema",
						name: "read",
						input: { path: "schema.sql" },
					},
				],
			},
			{
				mid: "r1",
				ordinal: 3,
				role: "user",
				blocks: [
					{
						type: "tool_result",
						id: "call-schema",
						name: "read",
						unit: "create table ",
						repeat: 120,
					},
				],
			},
			{
				mid: "u2",
				ordinal: 4,
				role: "user",
				blocks: [{ type: "file", mime: "image/png", url: image }],
			},
			{
				mid: "a2",
				ordinal: 5,
				role: "assistant",
				blocks: [{ type: "text", unit: "the schema has tables ", repeat: 40 }],
			},
			...extra,
		];
		const tags: FixtureTag[] = [
			{ tag_number: 1, block_id: "u1#0", kind: "message", token_count: 1 },
			{ tag_number: 2, block_id: "a1#0", kind: "message", token_count: 1 },
			{ tag_number: 3, block_id: "r1#0", kind: "tool", token_count: 1 },
			{ tag_number: 4, block_id: "u2#0", kind: "file", token_count: 1 },
			{ tag_number: 5, block_id: "a2#0", kind: "message", token_count: 1 },
			...extra.map((message, index) => ({
				tag_number: 6 + index,
				block_id: `${message.mid}#0`,
				kind: "message" as const,
				token_count: 1,
			})),
		];
		return {
			id: "prose-outside-u",
			protected_tags: 0,
			protected_tokens_effective: 0,
			messages,
			tags,
			expected: { u: 0, t: 0, band: "quiet" },
		};
	};
	const stableId = (message: unknown) =>
		typeof (message as { _mid?: unknown })._mid === "string"
			? (message as { _mid: string })._mid
			: undefined;
	const nonProseTokens = (
		parts: ReturnType<typeof measureTailHygiene>["parts"],
	): number =>
		parts
			.filter((part) => part.kind !== "text" && part.kind !== "excluded")
			.reduce((sum, part) => sum + part.tokens, 0);

	it("gives the same prose-free U and the same T on the OpenCode and Pi walks", () => {
		const fixture = proseFixture();
		const core = measureTailHygiene({
			messages: toCoreMessages(fixture),
			tags: toTags(fixture),
			protectedTagNumbers: new Set(),
		});
		const pi = measurePiTailHygiene({
			messages: toPiMessages(fixture),
			tags: toTags(fixture, true),
			protectedTagNumbers: new Set(),
			stableId,
		});

		for (const [leg, measured] of [
			["TypeScript", core],
			["Pi", pi],
		] as const) {
			const prose = measured.parts.filter((part) => part.kind === "text");
			expect(prose.length, `${leg} prose parts`).toBe(3);
			expect(
				prose.every((part) => part.tokens > 0 && part.uTokens === 0),
				`${leg} prose U`,
			).toBe(true);
			expect(measured.u, `${leg} U`).toBe(nonProseTokens(measured.parts));
			expect(measured.u, `${leg} U positive`).toBeGreaterThan(0);
			expect(measured.t, `${leg} T`).toBeGreaterThan(measured.u);
		}
		expect(pi.t - pi.u).toBe(core.t - core.u);
		expect(Math.abs(pi.u - core.u)).toBeLessThanOrEqual(tolerance(core.u));
	});

	it("keeps a defer pass after appended prose equal to a full walk on both legs", () => {
		const before = proseFixture();
		const after = proseFixture([
			{
				mid: "u3",
				ordinal: 6,
				role: "user",
				blocks: [{ type: "text", unit: "now add an index ", repeat: 30 }],
			},
			{
				mid: "a3",
				ordinal: 7,
				role: "assistant",
				blocks: [{ type: "text", unit: "index added ", repeat: 30 }],
			},
		]);
		const coreFirst = refreshTailHygieneBaseline({
			messages: toCoreMessages(before),
			tags: toTags(before),
			protectedTagNumbers: new Set(),
			cacheBusting: true,
		});
		const coreDeferred = refreshTailHygieneBaseline({
			messages: toCoreMessages(after),
			tags: toTags(after),
			protectedTagNumbers: new Set(),
			cacheBusting: false,
			previous: coreFirst,
		});
		const coreFull = refreshTailHygieneBaseline({
			messages: toCoreMessages(after),
			tags: toTags(after),
			protectedTagNumbers: new Set(),
			cacheBusting: true,
		});
		const piFirst = refreshPiTailHygieneBaseline({
			messages: toPiMessages(before),
			tags: toTags(before, true),
			protectedTagNumbers: new Set(),
			stableId,
			cacheBusting: true,
		});
		const piDeferred = refreshPiTailHygieneBaseline({
			messages: toPiMessages(after),
			tags: toTags(after, true),
			protectedTagNumbers: new Set(),
			stableId,
			cacheBusting: false,
			previous: piFirst,
		});
		const piFull = refreshPiTailHygieneBaseline({
			messages: toPiMessages(after),
			tags: toTags(after, true),
			protectedTagNumbers: new Set(),
			stableId,
			cacheBusting: true,
		});

		expect(coreDeferred.lastPrefixMismatch).toBeUndefined();
		expect(piDeferred.lastPrefixMismatch).toBeUndefined();
		expect(effectiveTailHygiene(coreDeferred)).toEqual(
			effectiveTailHygiene(coreFull),
		);
		expect(effectivePiTailHygiene(piDeferred)).toEqual(
			effectivePiTailHygiene(piFull),
		);
		expect(effectiveTailHygiene(coreDeferred).u).toBe(
			effectiveTailHygiene(coreFirst).u,
		);
		expect(effectivePiTailHygiene(piDeferred).u).toBe(
			effectivePiTailHygiene(piFirst).u,
		);
		expect(effectivePiTailHygiene(piDeferred).u).toBe(
			effectiveTailHygiene(coreDeferred).u,
		);
	});
});
