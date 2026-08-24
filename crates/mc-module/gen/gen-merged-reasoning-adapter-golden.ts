#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { encodeOpenCodeMessagesToCk } from "../../../packages/plugin/src/hooks/magic-context/module-wire";
import { findLatestAssistantReasoningMutationExemptMessage } from "../../../packages/plugin/src/hooks/magic-context/strip-content";

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

const rawCases = [
	...fixtures.map((fixture) => ({
		name: fixture.name,
		target_mid: `${fixture.name}-target`,
		expect_strip: fixture.expectStrip,
		raw_messages: rawMessages(fixture.name, fixture.reasoningPart),
	})),
	{
		name: "live_tool_continuation_request_shell",
		target_mid: "live-continuation-target",
		expect_strip: false,
		raw_messages: liveContinuation,
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
	`${JSON.stringify({ generator_version: 2, cases }, null, 2)}\n`,
);
