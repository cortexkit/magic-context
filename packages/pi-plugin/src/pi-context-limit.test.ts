import { afterEach, describe, expect, test } from "bun:test";
import { setOutputReserveConfig } from "@magic-context/core/shared/models-dev-cache";
import {
	resolvePiUsableContextLimit,
	resolvePiWindowGeometry,
} from "./pi-context-limit";

describe("resolvePiUsableContextLimit", () => {
	afterEach(() => setOutputReserveConfig(undefined));

	test("honors the reporter's default output_reserve instead of the 25% fallback", () => {
		setOutputReserveConfig({ default: 16_384 });
		expect(
			resolvePiUsableContextLimit({
				rawContextWindow: 272_000,
				model: {
					provider: "openai-codex",
					id: "gpt-5.6-sol",
					contextWindow: 272_000,
					maxTokens: 128_000,
				},
				persistedInputTokens: 139_400,
				persistedPercentage: (139_400 / 204_000) * 100,
			}),
		).toBe(272_000 - 16_384);
	});

	test("reserves Pi model maxTokens on shared-window providers", () => {
		expect(
			resolvePiUsableContextLimit({
				rawContextWindow: 122_880,
				model: {
					provider: "openai",
					id: "reporter-model",
					contextWindow: 122_880,
					maxTokens: 16_384,
				},
			}),
		).toBe(106_496);
	});

	test("keeps Google Antigravity's separate output quota unchanged", () => {
		expect(
			resolvePiUsableContextLimit({
				rawContextWindow: 1_048_576,
				model: {
					provider: "google-antigravity",
					id: "gemini-2.5-pro",
					maxTokens: 65_536,
				},
			}),
		).toBe(1_048_576);
	});

	test("keeps a successful request as a pressure floor when static model metadata is too small", () => {
		expect(
			resolvePiUsableContextLimit({
				model: {
					provider: "custom",
					id: "model",
					contextWindow: 30_000,
				},
				provenInputTokens: 90_000,
			}),
		).toBe(90_000);
	});

	test("bounds successful-request proof by an observed absolute wall", () => {
		const model = {
			provider: "openai-codex",
			id: "gpt-5.6-sol",
			contextWindow: 272_000,
			maxTokens: 128_000,
		};
		expect(
			resolvePiUsableContextLimit({
				rawContextWindow: 272_000,
				model,
				provenInputTokens: 255_834,
			}),
		).toBe(255_834);
		expect(
			resolvePiUsableContextLimit({
				rawContextWindow: 272_000,
				model,
				provenInputTokens: 593_717,
			}),
		).toBe(204_000);
	});

	test("keeps a current detected overflow cap authoritative over older proof", () => {
		expect(
			resolvePiUsableContextLimit({
				rawContextWindow: 200_000,
				detectedContextLimit: 30_000,
				provenInputTokens: 90_000,
				model: { provider: "custom", id: "model" },
			}),
		).toBe(30_000);
	});

	test("applies detected wire truth before output reservation", () => {
		expect(
			resolvePiUsableContextLimit({
				rawContextWindow: 200_000,
				detectedContextLimit: 120_000,
				model: { provider: "anthropic", id: "claude", maxTokens: 20_000 },
			}),
		).toBe(100_000);
	});
});

describe("resolvePiWindowGeometry", () => {
	// Pi's model metadata carries a context window and an output limit, never a
	// separate input limit, so the shared cap of the hard wall at a declared
	// input limit never reaches a Pi session. Its usable window and hard wall
	// (which its pressure and 95% emergency checks read) stay as they were.
	test("keeps the usable window and hard wall of a Pi session unchanged", () => {
		const cases = [
			{
				model: {
					provider: "anthropic",
					id: "claude-sonnet",
					contextWindow: 200_000,
					maxTokens: 64_000,
				},
				usableSoft: 150_000,
				usableHard: 200_000 - 4_096,
			},
			{
				model: {
					provider: "opencode-go",
					id: "deepseek-v4.1-flash",
					contextWindow: 1_000_000,
					maxTokens: 65_536,
				},
				usableSoft: 1_000_000 - 65_536,
				usableHard: 1_000_000 - 4_096,
			},
		];
		for (const { model, usableSoft, usableHard } of cases) {
			const geometry = resolvePiWindowGeometry({
				rawContextWindow: model.contextWindow,
				model,
			});
			expect({
				usableSoft: geometry?.usableSoft,
				usableHard: geometry?.usableHard,
			}).toEqual({ usableSoft, usableHard });
		}
	});
});
