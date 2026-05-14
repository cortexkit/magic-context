/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { isMidTurnPi } from "./read-session-pi";

describe("isMidTurnPi", () => {
	it("is mid-turn when the latest assistant stopReason is toolUse", () => {
		expect(
			isMidTurnPi(
				{
					messages: [{ role: "assistant", stopReason: "toolUse", content: [] }],
				},
				"session-1",
			),
		).toBe(true);
	});

	it("is mid-turn when the latest assistant has an unpaired toolCall", () => {
		expect(
			isMidTurnPi(
				{
					messages: [
						{
							role: "assistant",
							content: [{ type: "toolCall", id: "call-1", name: "bash" }],
						},
					],
				},
				"session-1",
			),
		).toBe(true);
	});

	it("is not mid-turn when toolCall content is paired or absent", () => {
		expect(
			isMidTurnPi(
				{
					messages: [
						{
							role: "assistant",
							content: [{ type: "toolCall", id: "call-1", name: "bash" }],
						},
						{ role: "toolResult", toolCallId: "call-1", content: [] },
					],
				},
				"session-1",
			),
		).toBe(false);

		expect(
			isMidTurnPi(
				{
					messages: [
						{ role: "assistant", content: [{ type: "text", text: "done" }] },
					],
				},
				"session-1",
			),
		).toBe(false);
	});
});
