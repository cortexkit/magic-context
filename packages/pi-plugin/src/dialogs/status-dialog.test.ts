import { describe, expect, it } from "bun:test";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import { setSessionWorkMetrics } from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	clearPiChannel1State,
	setPiChannel1Baseline,
} from "../ctx-reduce-nudge-pi";
import {
	assistantMessage,
	createTestDb,
	fakeContext,
} from "../test-utils.test";
import { buildPiStatusDetail, showStatusDialog } from "./status-dialog";

describe("Pi status dialog", () => {
	it("displays usage against the output-reserved safe window", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-status-reserved-window";
			const ctx = {
				...fakeContext(sessionId),
				model: {
					provider: "anthropic",
					id: "claude",
					contextWindow: 100_000,
					maxTokens: 20_000,
				},
				getContextUsage: () => ({
					tokens: 50_000,
					percent: 50,
					contextWindow: 100_000,
				}),
				getSystemPrompt: () => "system prompt",
			};

			const detail = buildPiStatusDetail(
				{ getAllTools: () => [] } as never,
				ctx as never,
				{
					db,
					projectIdentity: resolveProjectIdentity(process.cwd()),
				},
				sessionId,
			);
			expect(detail.contextLimit).toBe(80_000);
			expect(detail.usagePercentage).toBe(62.5);
		} finally {
			closeQuietly(db);
		}
	});

	it("includes the active profile in status-dialog data", () => {
		const db = createTestDb();
		try {
			const detail = buildPiStatusDetail(
				{ getAllTools: () => [] } as never,
				fakeContext("ses-status-profile") as never,
				{
					db,
					projectIdentity: resolveProjectIdentity(process.cwd()),
					activeProfile: "work",
				},
				"ses-status-profile",
			);
			expect(detail.activeProfile).toBe("work");
		} finally {
			closeQuietly(db);
		}
	});

	it("matches the persisted scheduler percentage when command context omits maxTokens", async () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-status-persisted-reserve";
			const inputTokens = 105_932;
			const { persistPiPressureFromMessageEnd } = await import("../index");
			await persistPiPressureFromMessageEnd({
				db,
				sessionId,
				message: assistantMessage("done", 1, {
					usage: {
						input: inputTokens,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: inputTokens,
					},
				}),
				piContextWindow: 204_000,
				piModel: {
					provider: "anthropic",
					id: "claude",
					maxTokens: 30_625,
				},
			});

			const schedulerPressure = db
				.prepare<
					[string],
					{ last_context_percentage: number; last_input_tokens: number }
				>(
					"SELECT last_context_percentage, last_input_tokens FROM session_meta WHERE session_id = ?",
				)
				.get(sessionId);
			const schedulerPercentage =
				schedulerPressure?.last_context_percentage ?? 0;
			const detail = buildPiStatusDetail(
				{ getAllTools: () => [] } as never,
				{
					...fakeContext(sessionId),
					model: {
						provider: "anthropic",
						id: "claude",
						contextWindow: 204_000,
					},
					getContextUsage: () => ({
						tokens: inputTokens,
						percent: (inputTokens / 204_000) * 100,
						contextWindow: 204_000,
					}),
					getSystemPrompt: () => "system prompt",
				} as never,
				{
					db,
					projectIdentity: resolveProjectIdentity(process.cwd()),
				},
				sessionId,
			);

			expect(schedulerPercentage).toBeCloseTo(61.1, 1);
			expect(schedulerPressure?.last_input_tokens).toBe(inputTokens);
			expect(detail.inputTokens).toBe(schedulerPressure?.last_input_tokens);
			expect(detail.contextLimit).toBe(173_375);
			expect(detail.usagePercentage).toBe(schedulerPercentage);
		} finally {
			closeQuietly(db);
		}
	});

	it("renders the same persisted hygiene ratio used by nudges", async () => {
		const db = createTestDb();
		const sessionId = "ses-status-hygiene";
		try {
			setPiChannel1Baseline(sessionId, {
				baselineU: 65_100,
				baselineT: 100_000,
				turnDeltaU: 0,
				turnDeltaT: 0,
				usableWindow: 128_000,
				realUserTurnCount: 4,
				baselineGeneration: 4,
				computedAt: 123,
				evaluable: true,
				generationInvalidated: false,
				baselineParts: [],
				contentSignature: "fixture",
				reducedSinceRefresh: false,
				oldestReclaimableToolTags: [],
			});
			const rendered: string[][] = [];
			const ctx = {
				...fakeContext(sessionId),
				ui: {
					async custom(factory: unknown) {
						const makeComponent = factory as (
							tui: { requestRender: () => void },
							theme: {
								fg: (_name: string, text: string) => string;
								bold: (text: string) => string;
							},
							keybindings: unknown,
							done: (value: undefined) => void,
						) => { render: (width: number) => string[]; dispose?: () => void };
						const component = makeComponent(
							{ requestRender: () => undefined },
							{ fg: (_name, text) => text, bold: (text) => text },
							undefined,
							() => undefined,
						);
						rendered.push(component.render(90));
						component.dispose?.();
						return undefined;
					},
				},
				getSystemPrompt: () => "system prompt",
			};

			await showStatusDialog({ getAllTools: () => [] } as never, ctx as never, {
				db,
				projectIdentity: resolveProjectIdentity(process.cwd()),
			});

			const text = rendered.flat().join("\n");
			expect(text).toContain("Hygiene 65.1% · 65,100 / 100,000 tok");
			expect(text).toContain(
				"Conversation includes model Reasoning; hygiene excludes it",
			);
		} finally {
			clearPiChannel1State(sessionId);
			closeQuietly(db);
		}
	});

	it("renders stored work metrics", async () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-status-work";
			setSessionWorkMetrics(db, sessionId, 1200, 9800);
			const rendered: string[][] = [];
			const ctx = {
				...fakeContext(sessionId),
				ui: {
					async custom(factory: unknown) {
						const makeComponent = factory as (
							tui: { requestRender: () => void },
							theme: {
								fg: (_name: string, text: string) => string;
								bold: (text: string) => string;
							},
							keybindings: unknown,
							done: (value: undefined) => void,
						) => { render: (width: number) => string[]; dispose?: () => void };
						const component = makeComponent(
							{ requestRender: () => undefined },
							{ fg: (_name, text) => text, bold: (text) => text },
							undefined,
							() => undefined,
						);
						rendered.push(component.render(78));
						component.dispose?.();
						return undefined;
					},
				},
				getSystemPrompt: () => "system prompt",
			};

			await showStatusDialog({ getAllTools: () => [] } as never, ctx as never, {
				db,
				projectIdentity: resolveProjectIdentity(process.cwd()),
			});

			const text = rendered.flat().join("\n");
			expect(text).toContain("Work tokens 1.2K new · 9.8K total input");
			expect(text).toContain("Window ");
			expect(text).not.toContain("Context:");
		} finally {
			closeQuietly(db);
		}
	});
});
