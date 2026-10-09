import { describe, expect, it, spyOn } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { recordDreamerTickFailure } from "@magic-context/core/features/magic-context/dreamer/tick-failure";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import { insertMemory } from "@magic-context/core/features/magic-context/memory/storage-memory";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage-meta";
import { setSessionWorkMetrics } from "@magic-context/core/features/magic-context/storage-meta-persisted";
import {
	insertTag,
	updateTagTokenCount,
} from "@magic-context/core/features/magic-context/storage-tags";
import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	buildStatusViewFor,
	STATUS_COLUMN_GAP,
	statusColumnsFor,
} from "@magic-context/core/shared/status-view";
import { checkLocalStatusSource } from "@magic-context/core/shared/status-view-check";
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
	formatPiStatusSummary,
	renderPiStatusOverlay,
	type StatusDialogDetail,
	showStatusDialog,
	statusViewSourceFromPiDetail,
	stopStatusDialogRefresh,
} from "./status-dialog";

/**
 * A theme that colours nothing, so assertions read the text the overlay draws
 * rather than the escape sequences around it.
 */
function plainTheme() {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as never;
}

/**
 * A detail whose shared model carries every section, so a layout test can assert
 * on the whole grid instead of on whichever sections a sparse fixture happens to
 * produce. The cache TTL is pinned to a session value so the Configured row is
 * short: the default spelling carries the model key and is long enough that the
 * shared column rule would keep the sections in one column at any width. The
 * caller owns the returned database and must close it.
 */
function fullStatusDetail(sessionId: string) {
	const db = createTestDb();
	insertTag(db, sessionId, "m1", "tool", 4_000, 1);
	const detail = buildPiStatusDetail(
		{ getAllTools: () => [] } as never,
		{
			...fakeContext(sessionId),
			getContextUsage: () => ({
				tokens: 40_000,
				percent: 20,
				contextWindow: 200_000,
			}),
			getSystemPrompt: () => "system prompt",
		} as never,
		{ db, projectIdentity: resolveProjectIdentity(process.cwd()) },
		sessionId,
	);
	return {
		db,
		detail: { ...detail, cacheTtl: "5m", cacheTtlSource: "session" as const },
	};
}

describe("Pi status dialog", () => {
	it("shutdown closes the dialog and clears its refresh interval", async () => {
		const db = createTestDb();
		try {
			let finished = false;
			let component: { dispose(): void } | undefined;
			const ctx = {
				...fakeContext("ses-status-shutdown"),
				ui: {
					custom: async (
						factory: (...args: never[]) => { dispose(): void },
					) => {
						component = factory({ requestRender() {} }, {}, {}, () => {
							finished = true;
						});
					},
				},
			};
			await showStatusDialog({ getAllTools: () => [] } as never, ctx as never, {
				db,
				projectIdentity: resolveProjectIdentity(process.cwd()),
			});
			const cleared = spyOn(globalThis, "clearInterval");
			try {
				stopStatusDialogRefresh();
				expect(finished).toBe(true);
				expect(cleared).toHaveBeenCalledTimes(1);
			} finally {
				cleared.mockRestore();
				component?.dispose();
			}
		} finally {
			closeQuietly(db);
		}
	});
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

	it("counts compartments served in m[1] in the Compartments bucket", () => {
		// Compartments published after the last m[0] fold ride in m[1]'s
		// <new-compartments> block; m[0]'s <session-history> may still be empty.
		const db = createTestDb();
		try {
			const sessionId = "ses-status-m1-compartments";
			const m0History = "<session-history>\n</session-history>";
			const newCompartments =
				"<new-compartments>\n## 11-14 · Continued runtime inspection\nRead production, gear and ABI record code before implementing the plan.\n</new-compartments>";
			getOrCreateSessionMeta(db, sessionId);
			db.prepare(
				"UPDATE session_meta SET cached_m0_bytes = ?, cached_m1_bytes = ? WHERE session_id = ?",
			).run(
				Buffer.from(m0History, "utf8"),
				Buffer.from(
					`<session-history-since>\n${newCompartments}\n</session-history-since>`,
					"utf8",
				),
				sessionId,
			);
			const detail = buildPiStatusDetail(
				{ getAllTools: () => [] } as never,
				fakeContext(sessionId) as never,
				{ db, projectIdentity: resolveProjectIdentity(process.cwd()) },
				sessionId,
			);
			expect(detail.compartmentTokens).toBe(
				estimateTokens(m0History) + estimateTokens(newCompartments),
			);
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

	it("renders the exact active-memory importance distribution and unclassified denominator", () => {
		const db = createTestDb();
		try {
			const projectIdentity = resolveProjectIdentity(process.cwd());
			const rows = [5, 25, 50, 65, 100].map((importance, index) =>
				insertMemory(db, {
					projectPath: projectIdentity,
					category: "CONSTRAINTS",
					content: `status-memory-${index}`,
					importance,
				}),
			);
			const classifiedRows = [rows[0], rows[1], rows[3], rows[4]];
			if (classifiedRows.some((row) => row === undefined)) {
				throw new Error("histogram fixture rows missing");
			}
			db.prepare(
				"UPDATE memories SET classified_at = 123 WHERE id IN (?, ?, ?, ?)",
			).run(...classifiedRows.map((row) => row.id));
			const detail = buildPiStatusDetail(
				{ getAllTools: () => [] } as never,
				fakeContext("ses-status-histogram") as never,
				{ db, projectIdentity },
				"ses-status-histogram",
			);

			expect(detail.memoryImportanceHistogram).toEqual({
				total: 5,
				unclassified: 1,
				bands: {
					"0-19": 1,
					"20-39": 1,
					"40-59": 1,
					"60-79": 1,
					"80-100": 1,
				},
			});
			expect(detail.historianRuns).toBe(0);
			const overlay = renderPiStatusOverlay(detail, plainTheme(), 74).join(
				"\n",
			);
			expect(overlay).toContain("Historian runs");
			expect(overlay).toMatch(/Historian runs\s+0/);
			expect(overlay).not.toContain("Importance");
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
			expect(summary).toBe(`Magic Context Status
Context: 1.0% of usable context (1,000 / 100,000 tokens)
Cache lifetime: 1h (your config)
Automatic compression: at 65.0% of usable context
History compression: Waiting for enough conversation history
Reclaimable: 3 spent tool outputs (~14k tokens)
Memory: 0 memories · 0 notes
Search indexing: Off
Warning: The last context update did not finish. Send another message to retry. (MC-S02)
Warning: History compression could not finish this turn. It will retry automatically. (MC-H01)
Window source: catalog; denominator: 100000 tokens`);
			for (const value of ["1.0%", "65.0%", "1h (your config)"]) {
				expect(summary).toContain(value);
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

	// Replaces "toggles from the summary to diagnostics with D": /ctx-status no
	// longer has a summary/diagnostics split, so there is no second view for D to
	// reach and the one view is what every keystroke other than close leaves alone.
	it("draws one view, with no diagnostics toggle for D to flip", async () => {
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
							{ terminal: { rows: 100 }, requestRender() {} },
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
			expect(before).toBe(after);
			expect(before).not.toContain("Diagnostics");
			// The full view is drawn immediately, with no second mode behind a key.
			expect(before).toContain("Context Details");
			expect(before).toContain("Cache TTL");
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
							tui: { terminal: { rows: number }; requestRender: () => void },
							theme: {
								fg: (_name: string, text: string) => string;
								bold: (text: string) => string;
							},
							keybindings: unknown,
							done: (value: undefined) => void,
						) => { render: (width: number) => string[]; dispose?: () => void };
						const component = makeComponent(
							{ terminal: { rows: 100 }, requestRender: () => undefined },
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
			expect(text).toContain("Hygiene");
			expect(text).toContain("65.1% · 65,100 / 100,000 tok");
			// The footnote explaining that Conversation counts reasoning while
			// hygiene does not is no longer drawn anywhere.
			expect(text).not.toContain("hygiene excludes it");
		} finally {
			clearPiChannel1State(sessionId);
			closeQuietly(db);
		}
	});

	// Was "renders stored work metrics": the Pi-only Work tokens line is gone,
	// because the single view draws the same rows on every host and OpenCode
	// never had it. The metrics themselves are still collected and stored.
	it("keeps stored work metrics in the detail and off the one view", async () => {
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
							tui: { terminal: { rows: number }; requestRender: () => void },
							theme: {
								fg: (_name: string, text: string) => string;
								bold: (text: string) => string;
							},
							keybindings: unknown,
							done: (value: undefined) => void,
						) => { render: (width: number) => string[]; dispose?: () => void };
						const component = makeComponent(
							{ terminal: { rows: 100 }, requestRender: () => undefined },
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

			const detail = buildPiStatusDetail(
				{ getAllTools: () => [] } as never,
				ctx as never,
				{ db, projectIdentity: resolveProjectIdentity(process.cwd()) },
				sessionId,
			);
			expect({
				newWorkTokens: detail.newWorkTokens,
				totalInputTokens: detail.totalInputTokens,
			}).toEqual({ newWorkTokens: 1200, totalInputTokens: 9800 });

			const text = rendered.flat().join("\n");
			expect(text).not.toContain("Work tokens");
			// The window derivation is now drawn as the shared line every host
			// prints verbatim, instead of Pi's own "Window …" rewrite of it. The
			// line no longer carries a `Context:` prefix: it pushed the line past
			// the narrowest dialog's content width, where it wrapped.
			expect(text).toContain("usable · window");
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

	// Was "renders protectedTokens in dialog UI and does not contain 'Protected
	// tags'". Pi's own protected-tokens line was replaced by the Context Details
	// section every host now draws, whose rows are Protected tags and Subagent.
	// The protection-window value object is unchanged and the row draws its
	// protectedCount, but the protected mass and floor are no longer rendered.
	it("renders the shared Context Details rows instead of a Pi-only protected-tokens line", async () => {
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
							tui: { terminal: { rows: number }; requestRender: () => void },
							theme: {
								fg: (_name: string, text: string) => string;
								bold: (text: string) => string;
							},
							keybindings: unknown,
							done: (value: undefined) => void,
						) => { render: (width: number) => string[]; dispose?: () => void };
						const component = makeComponent(
							{ terminal: { rows: 100 }, requestRender: () => undefined },
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

			await showStatusDialog({ getAllTools: () => [] } as never, ctx as never, {
				db,
				projectIdentity: resolveProjectIdentity(process.cwd()),
				floor: 16_000,
			});

			const text = rendered.flat().join("\n");
			expect(text).toContain("Protected tags");
			expect(text).not.toContain("Protected tokens");
		} finally {
			closeQuietly(db);
		}
	});

	/**
	 * The tokenizer calibration leaves the hygiene masses fractional; Pi prints
	 * the same whole token counts as the OpenCode dialog and the sidebar.
	 */
	it("prints the hygiene masses as whole token counts", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-status-hygiene-rounding";
			insertTag(db, sessionId, "m1", "tool", 4_000, 1);
			const detail = buildPiStatusDetail(
				{ getAllTools: () => [] } as never,
				{
					...fakeContext(sessionId),
					getContextUsage: () => ({
						tokens: 40_000,
						percent: 20,
						contextWindow: 200_000,
					}),
					getSystemPrompt: () => "system prompt",
				} as never,
				{ db, projectIdentity: resolveProjectIdentity(process.cwd()) },
				sessionId,
			);
			const text = renderPiStatusOverlay(
				{
					...detail,
					tailHygiene: {
						u: 63_063.522,
						t: 288_527.546,
						severity: 0.2186,
						evaluable: true,
						reclaimableToolOutputCount: 3,
					},
				},
				plainTheme(),
				74,
			).join("\n");
			expect(text).toContain("21.9% · 63,064 / 288,528 tok");
			expect(text).not.toContain("63,063.522");
		} finally {
			closeQuietly(db);
		}
	});

	/**
	 * The bar is drawn from the shared width distribution, so its runs add up to
	 * the row width. Rounding each segment's share on its own left blank cells
	 * between the coloured runs.
	 */
	it("fills the bar row exactly, with no blank cell between the runs", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-status-bar-width";
			insertTag(db, sessionId, "m1", "tool", 4_000, 1);
			const detail = buildPiStatusDetail(
				{ getAllTools: () => [] } as never,
				{
					...fakeContext(sessionId),
					getContextUsage: () => ({
						tokens: 40_000,
						percent: 20,
						contextWindow: 200_000,
					}),
					getSystemPrompt: () => "system prompt",
				} as never,
				{ db, projectIdentity: resolveProjectIdentity(process.cwd()) },
				sessionId,
			);
			const innerWidth = 74;
			const lines = renderPiStatusOverlay(detail, plainTheme(), innerWidth);
			const barLine = lines.find((line) => line.includes("\u2588"));
			expect(barLine).toBeDefined();
			// Every cell of the bar row is a block: a blank cell between two runs
			// would show up as a shorter visible width than the row it fills.
			expect(visibleWidth(barLine ?? "")).toBe(innerWidth);
			expect(
				(barLine ?? "").includes(" \u2588") ||
					(barLine ?? "").includes("\u2588 "),
			).toBe(false);
		} finally {
			closeQuietly(db);
		}
	});

	it("draws the shared sections, in order, with the shared labels", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-status-shared-sections";
			insertTag(db, sessionId, "m1", "tool", 4_000, 1);
			const detail = buildPiStatusDetail(
				{ getAllTools: () => [] } as never,
				{
					...fakeContext(sessionId),
					getContextUsage: () => ({
						tokens: 40_000,
						percent: 20,
						contextWindow: 200_000,
					}),
					getSystemPrompt: () => "system prompt",
				} as never,
				{ db, projectIdentity: resolveProjectIdentity(process.cwd()) },
				sessionId,
			);
			const view = buildStatusViewFor(
				checkLocalStatusSource(statusViewSourceFromPiDetail(detail)),
				{
					version: "0.0.0",
				},
			);
			const lines = renderPiStatusOverlay(detail, plainTheme(), 74);

			// Section titles appear in the model's order, and every row label the
			// model carries is drawn — so a row cannot exist on OpenCode and be
			// missing here.
			const titles = view.sections.map((section) => section.title);
			expect(titles).toEqual([
				"Tags",
				"Reductions",
				"Pending Queue",
				"Context Details",
				"Cache TTL",
				"History Compression",
				"Memory",
			]);
			const positions = titles.map((title) => lines.indexOf(title));
			expect(positions).toEqual([...positions].sort((a, b) => a - b));
			expect(titles.every((title) => lines.includes(title))).toBe(true);
			for (const section of view.sections) {
				for (const row of section.rows) {
					expect(lines.some((line) => line.startsWith(row.label))).toBe(true);
				}
			}

			const text = lines.join("\n");
			expect(text).toContain("⚡ Magic Context Status");
			expect(text).toContain("Esc to close");
			// Rows and modes that the one status view no longer carries.
			for (const gone of [
				"Diagnostics",
				"Logger",
				"Importance",
				"Memory importance",
				"unclassified of",
				"hygiene excludes it",
				"Work tokens",
				"Protected tokens",
				"Press D",
			]) {
				expect(text).not.toContain(gone);
			}
		} finally {
			closeQuietly(db);
		}
	});

	it("pairs sections into two columns when the overlay is wide enough", () => {
		const { db, detail } = fullStatusDetail("ses-status-two-column");
		try {
			const innerWidth = 96;
			const lines = renderPiStatusOverlay(detail, plainTheme(), innerWidth);
			const view = buildStatusViewFor(
				checkLocalStatusSource(statusViewSourceFromPiDetail(detail)),
				{
					version: "0.0.0",
				},
			);
			// The shared model decides the layout and sizes each column from its own
			// widest section, so a value never wraps inside its column.
			const layout = statusColumnsFor(view.sections, innerWidth);
			expect(layout.twoColumn).toBe(true);
			const gap = STATUS_COLUMN_GAP;

			expect(view.sections.length).toBe(7);
			for (let i = 0; i < view.sections.length; i += 2) {
				const left = view.sections[i];
				if (!left) throw new Error("left section missing");
				const right = view.sections[i + 1];
				// The pair shares one title line: the left title at the start, the
				// right title exactly after the left column and the gap.
				const titleIndex = lines.findIndex((line) =>
					right
						? line.startsWith(left.title) && line.includes(right.title)
						: line.trimEnd() === left.title,
				);
				expect(titleIndex).toBeGreaterThanOrEqual(0);
				const titleLine = lines[titleIndex] ?? "";
				expect(titleLine.startsWith(left.title)).toBe(true);
				if (right) {
					expect(titleLine.slice(layout.leftWidth + gap)).toBe(right.title);
				}

				const rowCount = Math.max(left.rows.length, right?.rows.length ?? 0);
				for (let r = 0; r < rowCount; r++) {
					const line = lines[titleIndex + 1 + r] ?? "";
					const leftRow = left.rows[r];
					if (leftRow) {
						expect(line.startsWith(leftRow.label)).toBe(true);
						// The value is right-aligned within the left column: it ends at
						// the column's right edge.
						expect(
							line.slice(
								layout.leftWidth - leftRow.value.length,
								layout.leftWidth,
							),
						).toBe(leftRow.value);
					}
					const rightRow = right?.rows[r];
					if (rightRow && right) {
						const rightStart = layout.leftWidth + gap;
						const rightEnd = rightStart + layout.rightWidth;
						expect(line.slice(rightEnd - rightRow.value.length, rightEnd)).toBe(
							rightRow.value,
						);
					}
				}
			}
		} finally {
			closeQuietly(db);
		}
	});

	it("keeps the one-column shape below the two-column minimum", () => {
		const { db, detail } = fullStatusDetail("ses-status-one-column");
		try {
			const innerWidth = 60;
			const lines = renderPiStatusOverlay(detail, plainTheme(), innerWidth);
			const view = buildStatusViewFor(
				checkLocalStatusSource(statusViewSourceFromPiDetail(detail)),
				{
					version: "0.0.0",
				},
			);

			// Walk the sections in model order: each title is alone on its own
			// line, followed by its rows, each padded to the full inner width.
			let cursor = 0;
			for (const section of view.sections) {
				const titleIndex = lines.indexOf(section.title, cursor);
				expect(titleIndex).toBeGreaterThanOrEqual(cursor);
				cursor = titleIndex + 1;
				for (const row of section.rows) {
					const line = lines[cursor] ?? "";
					expect(line.startsWith(row.label)).toBe(true);
					expect(visibleWidth(line)).toBe(innerWidth);
					cursor += 1;
				}
			}
		} finally {
			closeQuietly(db);
		}
	});
});

/**
 * On Pi and OMP the background maintenance pass used to die at its first stage
 * on every tick, and nothing in this overlay said so — an old Dreamer timestamp
 * reads exactly like a quiet project (issue 496).
 */
describe("Pi status overlay: blocked background maintenance", () => {
	function detailFor(db: ReturnType<typeof createTestDb>, sessionId: string) {
		insertTag(db, sessionId, "m1", "tool", 4_000, 1);
		return buildPiStatusDetail(
			{ getAllTools: () => [] } as never,
			{
				...fakeContext(sessionId),
				getContextUsage: () => ({
					tokens: 40_000,
					percent: 20,
					contextWindow: 200_000,
				}),
				getSystemPrompt: () => "system prompt",
			} as never,
			{ db, projectIdentity: resolveProjectIdentity(process.cwd()) },
			sessionId,
		);
	}

	it("draws the stage that stopped the last pass, with its code", () => {
		const db = createTestDb();
		try {
			recordDreamerTickFailure(db, {
				at: Date.now() - 3 * 3_600_000,
				stage: "message-history maintenance",
				message: "OpenCode orphan sweep cannot read a omp host store",
			});
			const detail = detailFor(db, "ses-status-dreamer-blocked");

			expect(detail.dreamer.tickFailure?.stage).toBe(
				"message-history maintenance",
			);
			const text = renderPiStatusOverlay(detail, plainTheme(), 74).join("\n");
			expect(text).toContain("Dreamer blocked");
			expect(text).toContain("MC-D09");
			// The chat-text surface carries the same code for a Pi host with no
			// interactive overlay to draw on.
			expect(formatPiStatusSummary(detail)).toContain("MC-D09");
		} finally {
			closeQuietly(db);
		}
	});

	it("says nothing about a blocked dreamer after a pass that completed", () => {
		const db = createTestDb();
		try {
			const detail = detailFor(db, "ses-status-dreamer-healthy");

			expect(detail.dreamer.tickFailure).toBeNull();
			const text = renderPiStatusOverlay(detail, plainTheme(), 74).join("\n");
			expect(text).not.toContain("Dreamer blocked");
			expect(text).not.toContain("MC-D09");
			expect(formatPiStatusSummary(detail)).not.toContain("MC-D09");
		} finally {
			closeQuietly(db);
		}
	});
});

it("Pi status includes config generation and last reload warning", () => {
	const db = createTestDb();
	try {
		const detail = buildPiStatusDetail(
			{ getAllTools: () => [] } as never,
			fakeContext("ses-status-live-config") as never,
			{
				db,
				projectIdentity: resolveProjectIdentity(process.cwd()),
				configGeneration: 6,
				configAdoptedAt: 1730000000000,
				configReloadFailure: {
					path: "/tmp/magic-context.jsonc",
					message: "malformed",
				},
			},
			"ses-status-live-config",
		);
		expect(formatPiStatusSummary(detail)).toContain(
			"Config generation: 6 (adopted ",
		);
		expect(formatPiStatusSummary(detail)).toContain(
			"Config reload failed /tmp/magic-context.jsonc: malformed",
		);
		expect(
			buildStatusViewFor(
				checkLocalStatusSource(statusViewSourceFromPiDetail(detail)),
				{
					version: "test",
				},
			).sections.some((section) => section.title === "Config"),
		).toBe(true);
	} finally {
		closeQuietly(db);
	}
});

it("a Pi snapshot the status model cannot draw renders the unavailable view instead of throwing", () => {
	const db = createTestDb();
	try {
		const detail = buildPiStatusDetail(
			{ getAllTools: () => [] } as never,
			fakeContext("ses-status-malformed") as never,
			{ db, projectIdentity: resolveProjectIdentity(process.cwd()) },
			"ses-status-malformed",
		);
		// The shared model formats usagePercentage with toFixed; a snapshot
		// without it used to throw out of the overlay's render.
		const broken = { ...detail, usagePercentage: undefined } as never;
		const text = renderPiStatusOverlay(broken, plainTheme(), 74).join("\n");
		expect(text).toContain("Status unavailable");
		expect(text).toContain("incomplete status data");
		expect(text).toContain("usagePercentage");
	} finally {
		closeQuietly(db);
	}
});
