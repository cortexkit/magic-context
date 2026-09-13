import { describe, expect, it } from "bun:test";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import { setSessionWorkMetrics } from "@magic-context/core/features/magic-context/storage-meta-persisted";
import {
	insertTag,
	updateTagTokenCount,
} from "@magic-context/core/features/magic-context/storage-tags";
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
import {
	buildPiStatusDetail,
	formatPiStatusDiagnostics,
	formatPiStatusSummary,
	type StatusDialogDetail,
	showStatusDialog,
} from "./status-dialog";

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

	it("shows live config TTL before the first Pi message_end", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-status-config-ttl";
			const ctx = {
				...fakeContext(sessionId),
				model: {
					provider: "anthropic",
					id: "claude-opus-5",
					contextWindow: 200_000,
					maxTokens: 20_000,
				},
			};
			const detail = buildPiStatusDetail(
				{ getAllTools: () => [] } as never,
				ctx as never,
				{
					db,
					projectIdentity: resolveProjectIdentity(process.cwd()),
					cacheTtlConfig: {
						default: "5m",
						"anthropic/claude-opus-5": "1h",
					},
					cacheTtlConfigured: true,
				},
				sessionId,
			);

			expect(detail.cacheTtl).toBe("1h");
			expect(detail.cacheTtlSource).toBe("config");
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

	it("renders the plain-text Pi summary golden without internal vocabulary", () => {
		const db = createTestDb();
		try {
			const detail = buildPiStatusDetail(
				{ getAllTools: () => [] } as never,
				{
					...fakeContext("ses-status-summary"),
					getContextUsage: () => ({
						tokens: 1_000,
						percent: 1,
						contextWindow: 100_000,
					}),
				} as never,
				{
					db,
					projectIdentity: resolveProjectIdentity(process.cwd()),
				},
				"ses-status-summary",
			);
			const statusFixture = {
				...detail,
				sessionId: "session-secret",
				cacheTtl: "1h",
				cacheTtlSource: "config",
				cacheTtlModelKey: "anthropic/claude-opus-5",
				executeThreshold: 65,
				compactionEnabled: true,
				tailHygiene: {
					u: 14_400,
					t: 48_000,
					severity: 0.3,
					evaluable: true,
					generationInvalidated: false,
					baselineGeneration: 3,
					computedAt: 1_730_000_000_000,
					reclaimableToolOutputCount: 3,
				},
				historianLastError:
					"MODULE facade drain failed in mc-store /tmp/private",
				lastTransformError: "MODULE facade drain failed",
				historianFailureCount: 1,
				// The golden pins every rendered input. Embedding state must not
				// depend on whichever project config an earlier test file resolved
				// for process.cwd(), which is what buildPiStatusDetail reads.
				embedding: { state: "off", indexed: 0, total: 0 },
			} satisfies StatusDialogDetail;
			const summary = formatPiStatusSummary(statusFixture);
			const diagnostics = formatPiStatusDiagnostics(statusFixture);
			expect(summary).toBe(`Magic Context Status
Context: 1.0% of usable context (1,000 / 100,000 tokens)
Cache lifetime: 1h (config for anthropic/claude-opus-5)
Automatic compression: at 65.0% of usable context
History compression: Waiting for enough conversation history
Reclaimable: 3 spent tool outputs (~14k tokens)
Memory: 0 memories · 0 notes
Search indexing: Off
Warning: The last context update did not finish. Send another message to retry. (MC-S02)
Warning: History compression could not finish this turn. It will retry automatically. (MC-H01)`);
			for (const value of [
				"1.0%",
				"65.0%",
				"1h (config for anthropic/claude-opus-5)",
			]) {
				expect(summary).toContain(value);
				expect(diagnostics).toContain(value);
			}
			for (const forbidden of [
				"session-secret",
				"/tmp/",
				"tag counter",
				"protection",
				"formula",
				"MODULE",
				"mc-store",
				"harness",
				"compartment",
				"facade",
				"changefeed",
				"drain",
			]) {
				expect(summary.toLowerCase()).not.toContain(forbidden.toLowerCase());
			}
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

	it("toggles from the summary to diagnostics with D", async () => {
		const db = createTestDb();
		try {
			const rendered: string[][] = [];
			const ctx = {
				...fakeContext("ses-status-toggle"),
				hasUI: true,
				ui: {
					async custom(
						factory: (
							tui: unknown,
							theme: unknown,
							done: () => void,
						) => unknown,
					) {
						const component = factory(
							{ requestRender() {} },
							{
								fg: (_name: string, text: string) => text,
								bold: (text: string) => text,
							},
							() => {},
						) as {
							render(width: number): string[];
							handleInput(data: string): void;
							dispose?(): void;
						};
						rendered.push(component.render(90));
						component.handleInput("d");
						rendered.push(component.render(90));
						component.dispose?.();
					},
				},
				getContextUsage: () => ({
					tokens: 10_000,
					percent: 10,
					contextWindow: 100_000,
				}),
			};
			await showStatusDialog({ getAllTools: () => [] } as never, ctx as never, {
				db,
				projectIdentity: resolveProjectIdentity(process.cwd()),
			});
			const before = rendered[0]?.join("\n") ?? "";
			const after = rendered[1]?.join("\n") ?? "";
			expect(before).toContain("Diagnostics: off");
			expect(before).not.toContain("Protected tokens");
			expect(after).toContain("Diagnostics: on");
			expect(after).toContain("Protected tokens");
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

			await showStatusDialog(
				{ getAllTools: () => [] } as never,
				ctx as never,
				{
					db,
					projectIdentity: resolveProjectIdentity(process.cwd()),
				},
				true,
			);

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

			await showStatusDialog(
				{ getAllTools: () => [] } as never,
				ctx as never,
				{
					db,
					projectIdentity: resolveProjectIdentity(process.cwd()),
				},
				true,
			);

			const text = rendered.flat().join("\n");
			expect(text).toContain("Work tokens 1.2K new · 9.8K total input");
			expect(text).toContain("Window ");
			expect(text).not.toContain("Context:");
		} finally {
			closeQuietly(db);
		}
	});

	it("exposes protectedTokens by value against F2 ({floor: 16000, protectedCount: 3, protectedMass: 44000}) and removes protectedTagCount", () => {
		const db = createTestDb();
		const sessionId = "ses-status-f2";
		try {
			// Single large read fixture: rows 1..9 each 2,000 tokens, row 10 is 40,000 tokens
			for (let i = 1; i <= 9; i++) {
				insertTag(db, sessionId, `m${i}`, "tool", 2_000, i);
				updateTagTokenCount(db, sessionId, i, 2_000);
			}
			insertTag(db, sessionId, "m10", "tool", 40_000, 10);
			updateTagTokenCount(db, sessionId, 10, 40_000);

			const ctx = {
				...fakeContext(sessionId),
				model: {
					provider: "anthropic",
					id: "claude",
					contextWindow: 200_000,
				},
				getContextUsage: () => ({
					tokens: 10_000,
					percent: 5,
					contextWindow: 200_000,
				}),
				getSystemPrompt: () => "system prompt",
			};

			const detail = buildPiStatusDetail(
				{ getAllTools: () => [] } as never,
				ctx as never,
				{
					db,
					projectIdentity: resolveProjectIdentity(process.cwd()),
					floor: 16_000,
				},
				sessionId,
			);

			// Assert by value for single large read fixture
			expect(detail.protectedTokens).toEqual({
				floor: 16_000,
				protectedCount: 3,
				protectedMass: 44_000,
			});
			// No protectedTagCount remains
			expect("protectedTagCount" in detail).toBe(false);
			expect(
				(detail as Record<string, unknown>).protectedTagCount,
			).toBeUndefined();
		} finally {
			closeQuietly(db);
		}
	});

	it("exposes protectedTokens by value against F8 ({floor: 16000, protectedCount: 0, protectedMass: 0}) in empty state with no placeholder, dash or absent field", () => {
		const db = createTestDb();
		const sessionId = "ses-status-f8";
		try {
			// Variant (b): non-tool tags only, 0 tool rows
			for (let i = 1; i <= 6; i++) {
				insertTag(db, sessionId, `m${i}`, "message", 500, i);
			}

			const ctx = {
				...fakeContext(sessionId),
				model: {
					provider: "anthropic",
					id: "claude",
					contextWindow: 200_000,
				},
				getContextUsage: () => ({
					tokens: 10_000,
					percent: 5,
					contextWindow: 200_000,
				}),
				getSystemPrompt: () => "system prompt",
			};

			const detail = buildPiStatusDetail(
				{ getAllTools: () => [] } as never,
				ctx as never,
				{
					db,
					projectIdentity: resolveProjectIdentity(process.cwd()),
					floor: 16_000,
				},
				sessionId,
			);

			// Status is exactly { floor: 16000, protectedCount: 0, protectedMass: 0 }
			expect(detail.protectedTokens).toEqual({
				floor: 16_000,
				protectedCount: 0,
				protectedMass: 0,
			});
			expect(detail.protectedTokens.floor).toBe(16_000);
			expect(detail.protectedTokens.protectedCount).toBe(0);
			expect(detail.protectedTokens.protectedMass).toBe(0);
			// No placeholder, dash, or absent field
			expect(typeof detail.protectedTokens.floor).toBe("number");
			expect(typeof detail.protectedTokens.protectedCount).toBe("number");
			expect(typeof detail.protectedTokens.protectedMass).toBe("number");
			// No protectedTagCount remains
			expect("protectedTagCount" in detail).toBe(false);
		} finally {
			closeQuietly(db);
		}
	});

	it("pins protectedCount as a ROW count where tag-number projection is smaller against F4", () => {
		const db = createTestDb();
		const sessionId = "ses-status-f4";
		try {
			// Exact equality fixture: rows 1..10 each 4k, except row 6 (non-member) raised to 8k
			for (let i = 1; i <= 10; i++) {
				const mass = i === 6 ? 8_000 : 4_000;
				insertTag(db, sessionId, `m${i}`, "tool", mass, i);
				updateTagTokenCount(db, sessionId, i, mass);
			}
			const ctx = {
				...fakeContext(sessionId),
				model: {
					provider: "anthropic",
					id: "claude",
					contextWindow: 200_000,
				},
				getContextUsage: () => ({
					tokens: 10_000,
					percent: 5,
					contextWindow: 200_000,
				}),
				getSystemPrompt: () => "system prompt",
			};

			const detail = buildPiStatusDetail(
				{ getAllTools: () => [] } as never,
				ctx as never,
				{
					db,
					projectIdentity: resolveProjectIdentity(process.cwd()),
					floor: 16_000,
				},
				sessionId,
			);

			// protectedMass STAYS 16,000 because row 6 is older than cutoff 7
			expect(detail.protectedTokens).toEqual({
				floor: 16_000,
				protectedCount: 4,
				protectedMass: 16_000,
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("renders protectedTokens in dialog UI and does not contain 'Protected tags'", async () => {
		const db = createTestDb();
		const sessionId = "ses-status-ui-render";
		try {
			insertTag(db, sessionId, "m1", "tool", 40_000, 1);
			updateTagTokenCount(db, sessionId, 1, 40_000);

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
				model: {
					provider: "anthropic",
					id: "claude",
					contextWindow: 200_000,
				},
				getContextUsage: () => ({
					tokens: 10_000,
					percent: 5,
					contextWindow: 200_000,
				}),
				getSystemPrompt: () => "system prompt",
			};

			await showStatusDialog(
				{ getAllTools: () => [] } as never,
				ctx as never,
				{
					db,
					projectIdentity: resolveProjectIdentity(process.cwd()),
					floor: 16_000,
				},
				true,
			);

			const text = rendered.flat().join("\n");
			expect(text).toContain("Protected tokens");
			expect(text).not.toContain("Protected tags");
		} finally {
			closeQuietly(db);
		}
	});
});
