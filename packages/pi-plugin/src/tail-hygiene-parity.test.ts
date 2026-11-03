import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { computeProtectionWindow } from "@magic-context/core/features/magic-context/protection-window";
import type { TagEntry } from "@magic-context/core/features/magic-context/types";
import {
	decideChannel1,
	evaluateChannel2,
} from "@magic-context/core/hooks/magic-context/ctx-reduce-nudge";
import type { MessageLike } from "@magic-context/core/hooks/magic-context/tag-messages";
import { measureTailHygiene } from "@magic-context/core/hooks/magic-context/tail-hygiene-walk";
import { measurePiTailHygiene } from "./tail-hygiene-walk-pi";

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
			"../../plugin/test-fixtures/runtime/nudge-hygiene-golden.json",
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
			const protectedNumbers = protectedTagNumbers(fixture);
			const pendingDropTagNumbers = new Set(
				fixture.pending_drop_tag_numbers ?? [],
			);
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
			assertLeg(fixture.id, "TypeScript", core, fixture.expected);
			assertLeg(fixture.id, "Pi", pi, fixture.expected);
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

	it("keeps the 0.651 flagship fixture in the urgent band", () => {
		const flagship = golden.cases.find(
			(fixture) => fixture.id === "live-incident-mixed-tail",
		);
		if (!flagship) throw new Error("missing flagship parity fixture");
		expect(flagship.expected.u / flagship.expected.t).toBeCloseTo(0.651, 3);
		expect(flagship.expected.band).toBe("urgent");
	});
});
