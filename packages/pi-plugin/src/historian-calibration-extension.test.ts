import { describe, expect, it } from "bun:test";

import { calibrateHistorianProviderPayload } from "./historian-calibration-extension";

describe("historian provider calibration", () => {
	it("sets the calibration triple on every supported output-budget shape", () => {
		const fixtures = [
			{ input: { max_tokens: 4096 }, key: "max_tokens" },
			{ input: { max_completion_tokens: 4096 }, key: "max_completion_tokens" },
			{ input: { max_output_tokens: 4096 }, key: "max_output_tokens" },
			{ input: { maxTokens: 4096 }, key: "maxTokens" },
		] as const;
		for (const fixture of fixtures) {
			const result = calibrateHistorianProviderPayload(
				fixture.input,
				0.1,
				32_000,
			) as Record<string, unknown>;
			expect(result.temperature).toBe(0.1);
			expect(result[fixture.key]).toBe(32_000);
		}
	});

	it("calibrates nested provider generation shapes without adding invalid top-level fields", () => {
		const result = calibrateHistorianProviderPayload(
			{ generationConfig: { topP: 0.9, maxOutputTokens: 4096 } },
			0.1,
			32_000,
		) as Record<string, unknown>;
		expect(result).toEqual({
			generationConfig: {
				topP: 0.9,
				temperature: 0.1,
				maxOutputTokens: 32_000,
			},
		});
		expect(
			calibrateHistorianProviderPayload(
				{ inferenceConfig: { maxTokens: 4096 } },
				0.1,
				32_000,
			),
		).toEqual({ inferenceConfig: { temperature: 0.1, maxTokens: 32_000 } });
	});
});
