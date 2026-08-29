#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { encodeOpenCodeMessagesToCk } from "../../../packages/plugin/src/hooks/magic-context/module-wire";
import { findLatestAssistantReasoningMutationExemptMessage } from "../../../packages/plugin/src/hooks/magic-context/strip-content";
import { makeSentinel } from "../../../packages/plugin/src/hooks/magic-context/sentinel";

const here = dirname(fileURLToPath(import.meta.url));
const output = resolve(
	here,
	"../testdata/merged-reasoning-adapter-golden.json",
);

type RawPart = Record<string, unknown>;

function assistant(id: string, parts: RawPart[]): Record<string, unknown> {
	return {
		info: { id, role: "assistant" },
		parts,
	};
}

function rawMessages(
	name: string,
	reasoningPart: RawPart,
): Record<string, unknown>[] {
	return [
		assistant(`${name}-first`, [{ type: "text", text: "first answer" }]),
		assistant(`${name}-target`, [
			reasoningPart,
			{ type: "text", text: "target answer" },
		]),
		assistant(`${name}-newest`, [{ type: "text", text: "newest answer" }]),
	];
}

const fixtures = [
	{
		name: "reasoning",
		reasoningPart: {
			type: "reasoning",
			text: "reasoning trace",
			signature: "sig-reasoning",
		},
		expectStrip: true,
	},
	{
		name: "thinking",
		reasoningPart: {
			type: "thinking",
			thinking: "thinking trace",
			signature: "sig-thinking",
		},
		expectStrip: true,
	},
	{
		name: "redacted_thinking",
		reasoningPart: { type: "redacted_thinking", data: "redacted payload" },
		expectStrip: true,
	},
	{
		name: "reasoning_cache_control",
		reasoningPart: {
			type: "reasoning",
			text: "cached reasoning trace",
			signature: "sig-cache-control",
			cache_control: { type: "ephemeral" },
		},
		expectStrip: false,
	},
];

const liveContinuation = [
	assistant("live-continuation-first", [
		{
			type: "reasoning",
			text: "older thinking",
			metadata: { anthropic: { signature: "sig-older" } },
		},
		{ type: "text", text: "older status" },
	]),
	assistant("live-continuation-target", [
		{ type: "step-start" },
		{
			type: "reasoning",
			text: "signed live thinking",
			metadata: { anthropic: { signature: "sig-live" } },
		},
		{ type: "text", text: "status before tool" },
		{
			type: "tool",
			callID: "call-live",
			tool: "bash",
			state: { status: "completed", input: { command: "true" }, output: "done" },
		},
		{ type: "step-finish" },
	]),
	assistant("live-continuation-request-shell", [{ type: "step-start" }]),
];

const incidentAstroReasoningTool = [
	{
		info: {
			id: "msg_03724c745001WO47gldfQGbrqY",
			sessionID: "ses_08df2045bffeBcWcqw60elghER",
			role: "assistant",
			finish: "tool-calls",
		},
		parts: [
			{ type: "step-start" },
			{
				type: "reasoning",
				text: "[redacted signed live thinking]",
				metadata: { anthropic: { signature: "[redacted signature]" } },
			},
			{
				type: "tool",
				callID: "toolu_01HhvtLQasFDWBB19QP5WvqK",
				tool: "read",
				state: {
					status: "completed",
					input: { filePath: "[redacted]" },
					output: "[redacted tool result]",
				},
			},
			{ type: "step-finish", reason: "tool-calls" },
		],
	},
	assistant("incident-astro-request-shell", [{ type: "step-start" }]),
];

const incidentEngramTextOrderRecurrence = [
	{
		info: {
			id: "msg_0348483e9001xBB7Ya0H5bfkvm",
			sessionID: "ses_0ad83017cffexe0g5N8UG0y3LZ",
			role: "assistant",
			finish: "tool-calls",
		},
		parts: [
			{ type: "step-start" },
			{
				type: "reasoning",
				text: "[redacted signed live thinking]",
				metadata: { anthropic: { signature: "[redacted signature]" } },
			},
			{
				type: "text",
				text: "Three construction sites, plus a third upstream break in the same window.",
			},
			{
				type: "tool",
				callID: "toolu_01AveJRXHJBnmXzSD16U5zmi",
				tool: "bash",
				state: {
					status: "completed",
					input: { command: "[redacted]" },
					output: "[redacted tool result]",
				},
			},
			{ type: "step-finish", reason: "tool-calls" },
		],
	},
];

const incident337 = [
	{
		info: {
			id: "msg_034356b50001Cbvu81faDbQTRW",
			sessionID: "ses_0ad83017cffexe0g5N8UG0y3LZ",
			role: "assistant",
			finish: "tool-calls",
		},
		parts: [
			{
				id: "prt_034358925001Rh1YRViacgqaW7",
				type: "step-start",
			},
			{
				id: "prt_034358930001DHhVVQmRKFziFN",
				type: "reasoning",
				text: "All three values match, but hardcoding them is risky...",
				metadata: { anthropic: { signature: "[redacted signature]" } },
			},
			{
				id: "prt_034358991001ZC7E9bfKiYXbTH",
				type: "text",
				text: "All three match the live keystore...",
			},
			{
				id: "prt_034358b2b001x9lN3yC9zUfB0J",
				type: "tool",
				callID: "toolu_019MxMREqQYT875aJy8Q5w6W",
				tool: "read",
				state: {
					status: "completed",
					input: { filePath: "[redacted]" },
					output: "[redacted tool result]",
				},
			},
			{
				id: "prt_034358edc001qEZnQkRNpR0y5C",
				type: "step-finish",
				reason: "tool-calls",
			},
		],
	},
];

const rawCases = [
	...fixtures.map((fixture) => ({
		name: fixture.name,
		target_mid: `${fixture.name}-target`,
        expect_strip: fixture.expectStrip,
        expected_sentinel: makeSentinel(fixture.reasoningPart),
        raw_messages: rawMessages(fixture.name, fixture.reasoningPart),
	})),
	{
		name: "live_tool_continuation_request_shell",
		target_mid: "live-continuation-target",
		expect_strip: false,
		raw_messages: liveContinuation,
	},
	{
		name: "incident_astro_signed_reasoning_tool_without_text",
		target_mid: "msg_03724c745001WO47gldfQGbrqY",
		target_reasoning_index: 1,
		provider_error_path: "messages.151.content.26",
		failing_provider_part_types: ["text", "thinking", "thinking", "tool_use"],
		expect_strip: false,
		source_part_types: ["step-start", "reasoning", "tool", "step-finish"],
		expected_native_part_types: [
			"step-start",
			"reasoning",
			"tool",
			"step-finish",
		],
		raw_messages: incidentAstroReasoningTool,
	},
	{
		name: "incident_engram_text_after_tool_recurrence",
		target_mid: "msg_0348483e9001xBB7Ya0H5bfkvm",
		target_reasoning_index: 1,
		expect_strip: false,
		source_part_types: [
			"step-start",
			"reasoning",
			"text",
			"tool",
			"step-finish",
		],
		expected_native_part_types: ["step-start", "text", "tool", "step-finish"],
		raw_messages: incidentEngramTextOrderRecurrence,
	},
	{
		name: "incident_337_text_before_tool",
		target_mid: "msg_034356b50001Cbvu81faDbQTRW",
		expect_strip: false,
		source_part_order: incident337[0]?.parts.map((part) => part.id),
		source_part_types: [
			"step-start",
			"reasoning",
			"text",
			"tool",
			"step-finish",
		],
		expected_native_part_types: [
			"step-start",
			"text",
			"text",
			"tool",
			"step-finish",
		],
		raw_messages: incident337,
	},
];

const cases = rawCases.map((fixture) => {
	const encoded_input = encodeOpenCodeMessagesToCk(fixture.raw_messages);
	const target = encoded_input.find((message) => message.mid === fixture.target_mid);
	const target_reasoning_index = target?.ck.content.findIndex((block) => {
		const type = (block.kind as { type?: unknown }).type;
		return type === "reasoning" || type === "redacted_reasoning";
	});
	if (target_reasoning_index === undefined || target_reasoning_index < 0) {
		throw new Error(`missing target reasoning for ${fixture.name}`);
	}
	return {
		...fixture,
		reasoning_exempt_mid:
			findLatestAssistantReasoningMutationExemptMessage(fixture.raw_messages)?.info.id ?? null,
		target_reasoning_index,
		encoded_input,
	};
});

writeFileSync(
	output,
	`${JSON.stringify({ generator_version: 6, cases }, null, 2)}\n`,
);
