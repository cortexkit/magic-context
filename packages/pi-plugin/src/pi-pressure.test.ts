import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { computePiPressure, extractAssistantUsage } from "./pi-pressure";

interface SessionUsageFixture {
	assistant_message: {
		provider: string;
		model: string;
		usage: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			totalTokens: number;
		};
	};
	next_assistant_message: {
		usage: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			totalTokens: number;
		};
	};
}

const sessionFixture = JSON.parse(
	readFileSync(
		new URL("./__fixtures__/session-019de471-usage.json", import.meta.url),
		"utf8",
	),
) as SessionUsageFixture;

describe("Pi prompt usage accounting", () => {
	test("normalizes OpenAI input that already includes cached tokens", () => {
		const pressure = computePiPressure(
			{
				input: 255_834,
				output: 151,
				cacheRead: 247_514,
				cacheWrite: 0,
				totalTokens: 255_985,
			},
			204_000,
		);

		expect(pressure?.inputTokens).toBe(255_834);
		expect(pressure?.inputTokens).not.toBe(503_348);
	});

	test("rejects the captured impossible Codex reading as non-request usage", () => {
		const usage = extractAssistantUsage({
			role: "assistant",
			provider: sessionFixture.assistant_message.provider,
			model: sessionFixture.assistant_message.model,
			usage: sessionFixture.assistant_message.usage,
		});

		expect(computePiPressure(usage, 204_000, 272_000)).toBeNull();
	});

	test("accepts the next captured Codex reading and excludes output", () => {
		const usage = sessionFixture.next_assistant_message.usage;
		const pressure = computePiPressure(usage, 204_000, 272_000);

		expect(pressure?.inputTokens).toBe(140_654);
		expect(pressure?.inputTokens).not.toBe(usage.totalTokens);
	});
});
