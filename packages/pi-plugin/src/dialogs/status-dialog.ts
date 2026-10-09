import type {
	ExtensionAPI,
	ExtensionCommandContext,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { MagicContextConfig } from "@magic-context/core/config/schema/magic-context";
import { getCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	getFailingDreamTasks,
	getMostRecentTaskRunAt,
	getSkippedDreamTasks,
} from "@magic-context/core/features/magic-context/dreamer/storage-task-schedule";
import { getDreamTaskBacklogs } from "@magic-context/core/features/magic-context/dreamer/task-gates";
import {
	CANONICAL_DREAM_TASKS,
	type DreamTaskFailureState,
} from "@magic-context/core/features/magic-context/dreamer/task-registry";
import {
	type DreamerTickFailure,
	getDreamerTickFailure,
} from "@magic-context/core/features/magic-context/dreamer/tick-failure";
import {
	emptyMemoryImportanceHistogram,
	getActiveMemoryImportanceHistogram,
} from "@magic-context/core/features/magic-context/memory/memory-diagnostics";
import { getEmbeddingCoverageStatus } from "@magic-context/core/features/magic-context/project-embedding-registry";
import {
	getProtectionWindowForSession,
	type ProtectionWindowStatus,
	readEpochFloorSnapshot,
} from "@magic-context/core/features/magic-context/protection-window";
import { parseCacheTtl } from "@magic-context/core/features/magic-context/scheduler";
import { readSessionCacheTtl } from "@magic-context/core/features/magic-context/session-cache-ttl";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { countHistorianRuns } from "@magic-context/core/features/magic-context/storage";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage-meta";
import {
	getCompactionMarkerHealth,
	getOverflowState,
	getSessionWorkMetrics,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { getNotes } from "@magic-context/core/features/magic-context/storage-notes";
import { getTagsBySession } from "@magic-context/core/features/magic-context/storage-tags";
import { getEmbedDrainUiStatus } from "@magic-context/core/hooks/magic-context/embed-session-state";
import { resolveExecuteThresholdDetail } from "@magic-context/core/hooks/magic-context/event-resolvers";
import { countCompartmentsNeedingUpgrade } from "@magic-context/core/hooks/magic-context/legacy-compartments";
import { computeM0BlockTokens } from "@magic-context/core/hooks/magic-context/m0-token-breakdown";
import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import { reasoningBudgetStatusLine } from "@magic-context/core/hooks/magic-context/reasoning-budget-status";
import {
	formatCacheTtlDisplay,
	resolveCacheTtlDisplay,
} from "@magic-context/core/shared/cache-ttl-display";
import type { ConfigParseFailure } from "@magic-context/core/shared/config-diagnostics";
import type {
	MemoryImportanceHistogram,
	TailHygieneStatus,
} from "@magic-context/core/shared/rpc-types";
import type { Statement } from "@magic-context/core/shared/sqlite";
import { isKnownAutocommit } from "@magic-context/core/shared/sqlite-helpers";
import { renderUserStatusSummary } from "@magic-context/core/shared/status-summary";
import {
	buildStatusViewFor,
	distributeBarWidths,
	STATUS_COLUMN_GAP,
	type StatusBarSegment,
	type StatusColumnLayout,
	type StatusRow,
	type StatusSection,
	type StatusTone,
	type StatusViewSource,
	statusColumnsFor,
} from "@magic-context/core/shared/status-view";
import { checkLocalStatusSource } from "@magic-context/core/shared/status-view-check";
import { resolveTailHygieneStatus } from "@magic-context/core/shared/tail-hygiene-status";
import type { UserFacingFailureKey } from "@magic-context/core/shared/user-facing-codes";
import {
	formatWindowSource,
	type WindowGeometryResult,
} from "@magic-context/core/shared/window-geometry";
import packageJson from "../../package.json";
import { resolveSessionId } from "../commands/pi-command-utils";
import { getPiChannel1Baseline } from "../ctx-reduce-nudge-pi";
import { readHostSystemPrompt } from "../host-system-prompt";
import { resolvePiWindowGeometry } from "../pi-context-limit";
import {
	piPressureEvidenceLimit,
	resolvePiStatusPressureSnapshot,
} from "../pi-pressure";
import {
	piProvenFloorModelKey,
	resolvePiProvenInputFloor,
} from "../pi-proven-floor";
import { isPiRecompInFlight } from "../pi-recomp-runner";

/** Countdown/usage cadence while dialog is open. */
const REFRESH_INTERVAL_MS = 1000;
const DETAIL_REFRESH_INTERVAL_MS = 10_000;

// Top/bottom borders, and one border plus one padding column on each side.
const BORDER_ROWS = 2;
const BORDER_COLUMNS = 2;
const PADDING_COLUMNS = 2;

export interface StatusDialogDeps {
	db: ContextDatabase;
	projectIdentity: string;
	protectedTokens?: number;
	floor?: number;
	protectedTags?: number;
	executeThresholdPercentage?:
		| number
		| { default: number; [modelKey: string]: number };
	historyBudgetPercentage?: number;
	injectionBudgetTokens?: number;
	/** User-owned profile selected for the project, after config resolution. */
	activeProfile?: string;
	configGeneration?: number;
	configAdoptedAt?: number;
	configReloadFailure?: { path: string; message: string };
	dreamer?: { runnable?: boolean; scheduleSummary?: string };
	executeThresholdTokens?: {
		default?: number;
		[modelKey: string]: number | undefined;
	};
	cacheTtlConfig?: MagicContextConfig["cache_ttl"];
	cacheTtlConfigured?: boolean;
	configParseFailures?: ConfigParseFailure[];
	hasDeprecatedProtectedTags?: boolean;
	compactionEnabled?: boolean;
}

export interface StatusDialogDetail {
	reasoningBudgetLine?: string;
	sessionId: string;
	activeProfile: string | null;
	configGeneration?: number;
	configAdoptedAt?: number;
	configReloadFailure?: { path: string; message: string };
	usagePercentage: number;
	inputTokens: number;
	systemPromptTokens: number;
	compartmentCount: number;
	lastCompartmentRange: string | null;
	memoryCount: number;
	memoryBlockCount: number;
	memoryImportanceHistogram: MemoryImportanceHistogram;
	sessionNoteCount: number;
	readySmartNoteCount: number;
	pendingOpsCount: number;
	compactionMarker: {
		code: "MC-C11" | null;
		attempts: number;
		lastError: string | null;
		pendingSinceMs: number | null;
	};
	historianRunning: boolean;
	historianRuns: number;
	historianFailureCount: number;
	historianLastFailureAt: number | null;
	historianLastError: string | null;
	cacheTtl: string;
	cacheTtlSource: import("@magic-context/core/shared/cache-ttl-display").CacheTtlDisplaySource;
	cacheTtlModelKey?: string;
	configParseFailures: ConfigParseFailure[];
	lastResponseTime: number;
	cacheRemainingMs: number;
	cacheExpired: boolean;
	lastNudgeTokens: number;
	lastNudgeBand: string;
	lastTransformError: string | null;
	isSubagent: boolean;
	contextLimit: number;
	windowGeometry?: WindowGeometryResult;
	executeThreshold: number;
	/** Which config source produced `executeThreshold` (tokens vs percentage). */
	executeThresholdMode: "percentage" | "tokens";
	/** True when `executeThreshold` was clamped down from a higher configured value (#241). */
	executeThresholdClamped?: boolean;
	/** Raw configured value before clamping, for showing the math in the clamp note. */
	executeThresholdConfigured?: number;
	protectedTokens: ProtectionWindowStatus;
	historyBlockTokens: number;
	compressionBudget: number | null;
	compressionUsage: string | null;
	activeTags: number;
	droppedTags: number;
	totalTags: number;
	activeBytes: number;
	compartmentTokens: number;
	factTokens: number;
	memoryTokens: number;
	docsTokens: number;
	profileTokens: number;
	conversationTokens: number;
	toolCallTokens: number;
	toolDefinitionTokens: number;
	tailHygiene?: TailHygieneStatus;
	newWorkTokens: number;
	totalInputTokens: number;
	/** Compartments still needing a v2 upgrade (legacy or tierless). */
	upgradeNeededCount: number;
	/** A detached /ctx-recomp is running in the background. */
	recompInFlight: boolean;
	hasDeprecatedProtectedTags: boolean;
	compactionEnabled: boolean;
	dreamer: {
		enabled: boolean;
		scheduleSummary: string | null;
		lastRunAt: number | null;
		backlog: ReturnType<typeof getDreamTaskBacklogs>;
		/** Tasks whose last scheduled run failed; empty when all of them are healthy. */
		failures: DreamTaskFailureState[];
		skipped?: string[];
		/**
		 * The stage that stopped the last maintenance pass, or null when the pass
		 * completed. Not a per-task failure: this is the whole pass never reaching
		 * the tasks at all.
		 */
		tickFailure: DreamerTickFailure | null;
	};
	embedding: {
		state: "off" | "running" | "paused" | "stopped" | "ready" | "waiting";
		indexed: number;
		total: number;
	};
}

export async function showStatusDialog(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	deps: StatusDialogDeps,
): Promise<void> {
	const sessionId = resolveSessionId(ctx);
	if (!sessionId) throw new Error("No active Pi session is available.");

	await ctx.ui.custom<undefined>(
		(tui, theme, _keybindings, done) =>
			new StatusDialogComponent({
				pi,
				ctx,
				deps,
				sessionId,
				theme,
				tui,
				done,
			}),
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: 78 },
		},
	);
}

interface StatusDialogProps {
	pi: ExtensionAPI;
	ctx: ExtensionCommandContext;
	deps: StatusDialogDeps;
	sessionId: string;
	theme: Theme;
	tui: TUI;
	done: (value: undefined) => void;
}

/**
 * Custom Component implementation:
 *  - implements its own handleInput so Escape / Enter / Ctrl+C close cleanly
 *  - draws a Unicode rounded-corner border using theme borderMuted color
 *  - updates countdowns/usage each second; refreshes stored detail on changes
 *  - cleans up timer on close
 */
const openStatusDialogs = new Set<StatusDialogComponent>();

export function stopStatusDialogRefresh(): void {
	for (const dialog of openStatusDialogs) dialog.close();
}

class StatusDialogComponent implements Component {
	private readonly props: StatusDialogProps;
	private detail: StatusDialogDetail;
	private readonly detailRefresh: PiStatusDetailRefresh;
	private refreshTimer: ReturnType<typeof setInterval> | null = null;
	private closed = false;
	private scrollOffset = 0;
	private viewportHeight = 1;
	private maxScrollOffset = 0;

	constructor(props: StatusDialogProps) {
		this.props = props;
		this.detailRefresh = new PiStatusDetailRefresh(
			props.pi,
			props.ctx,
			props.deps,
			props.sessionId,
		);
		this.detail = this.detailRefresh.refresh();
		openStatusDialogs.add(this);
		this.refreshTimer = setInterval(() => {
			if (this.closed) return;
			try {
				this.detail = this.detailRefresh.refresh();
				this.props.tui.requestRender();
			} catch {
				// best effort; keep previous detail
			}
		}, REFRESH_INTERVAL_MS);
	}

	handleInput(data: string): void {
		if (this.closed) return;
		if (
			matchesKey(data, "escape") ||
			matchesKey(data, "ctrl+c") ||
			matchesKey(data, "return")
		) {
			this.close();
			return;
		}
		let offset = this.scrollOffset;
		if (matchesKey(data, "up")) offset -= 1;
		else if (matchesKey(data, "down")) offset += 1;
		else if (matchesKey(data, "pageUp")) offset -= this.viewportHeight;
		else if (matchesKey(data, "pageDown")) offset += this.viewportHeight;
		else if (matchesKey(data, "home")) offset = 0;
		else if (matchesKey(data, "end")) offset = this.maxScrollOffset;
		else return;
		this.scrollOffset = Math.max(0, Math.min(offset, this.maxScrollOffset));
		this.props.tui.requestRender();
	}

	close(): void {
		if (this.closed) return;
		this.dispose();
		this.props.done(undefined);
	}

	invalidate(): void {
		// No render cache; viewport metrics are recomputed in render.
	}

	render(width: number): string[] {
		const frameWidth = BORDER_COLUMNS + PADDING_COLUMNS;
		const innerWidth = Math.max(1, width - frameWidth);
		const inner = renderPiStatusOverlay(
			this.detail,
			this.props.theme,
			innerWidth,
		);
		// Reserve the borders, title and close hint; only the body scrolls.
		// The host clips overflowing overlays rather than scrolling them.
		const rows = Math.max(0, this.props.tui.terminal.rows);
		const header = inner.slice(0, 1);
		const footer = inner.slice(-1);
		const body = inner.slice(header.length, inner.length - footer.length);
		const fixedRows = BORDER_ROWS + header.length + footer.length;
		this.viewportHeight = Math.max(1, rows - fixedRows);
		this.maxScrollOffset = Math.max(0, body.length - this.viewportHeight);
		this.scrollOffset = Math.min(this.scrollOffset, this.maxScrollOffset);
		if (rows <= fixedRows || width < frameWidth) {
			const compact = rows <= footer.length ? footer : [...header, ...footer];
			return compact
				.slice(0, rows)
				.map((line) => truncateToWidth(line, width, "…"));
		}
		if (this.maxScrollOffset === 0) {
			return drawBorder(inner, width, this.props.theme);
		}
		const end = this.scrollOffset + this.viewportHeight;
		const range = `${this.scrollOffset + 1}-${end}/${body.length}`;
		const closeHint = footer[0] ?? "";
		const scrollHint =
			["↑↓/PgUp/PgDn/Home/End scroll", "↑↓"]
				.map(
					(controls) =>
						closeHint +
						this.props.theme.fg("muted", ` · ${controls} · ${range}`),
				)
				.find((line) => visibleWidth(line) <= innerWidth) ?? closeHint;
		return drawBorder(
			[...header, ...body.slice(this.scrollOffset, end), scrollHint],
			width,
			this.props.theme,
		);
	}

	dispose(): void {
		this.closed = true;
		openStatusDialogs.delete(this);
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
	}
}

/** Failure codes every Pi status surface prints as a warning. */
function piStatusWarnings(s: StatusDialogDetail): UserFacingFailureKey[] {
	const warnings: UserFacingFailureKey[] = [];
	if (s.lastTransformError) warnings.push("transform_update_failed");
	if (s.historianFailureCount > 0) warnings.push("historian_unavailable");
	if (s.dreamer.failures.length > 0) warnings.push("dreamer_task_failing");
	if (s.dreamer.tickFailure) warnings.push("dreamer_tick_blocked");
	if (s.configParseFailures.length > 0 || s.hasDeprecatedProtectedTags) {
		warnings.push("configuration_warning");
	}
	if (s.embedding.state === "stopped") warnings.push("embedding_unavailable");
	if (s.compactionMarker.code) warnings.push("compaction_marker_missing");
	return warnings;
}

/** Chat-text status for a Pi host without an interactive UI to draw a dialog on. */
export function formatPiStatusSummary(s: StatusDialogDetail): string {
	const summary = `${renderUserStatusSummary(
		{
			inputTokens: s.inputTokens,
			usableContextTokens: s.contextLimit,
			usagePercentage: s.usagePercentage,
			cacheLifetime: formatCacheTtlDisplay({
				value: s.cacheTtl,
				source: s.cacheTtlSource,
				modelKey: s.cacheTtlModelKey,
			}).replace(/^Cache TTL:\s*/, ""),
			automaticCompressionThreshold: s.compactionEnabled
				? s.executeThreshold
				: null,
			compression: {
				state: s.historianRunning
					? "compressing"
					: s.compartmentCount > 0
						? "ready"
						: "waiting",
				historyBlockCount: s.compartmentCount,
			},
			reclaimable: {
				toolOutputCount: s.tailHygiene?.reclaimableToolOutputCount ?? 0,
				tokens: s.tailHygiene?.u ?? 0,
			},
			memoryCount: s.memoryCount,
			noteCount: s.sessionNoteCount + s.readySmartNoteCount,
			embedding: s.embedding,
			warnings: piStatusWarnings(s),
			dreamerSkipped: s.dreamer.skipped,
		},
		"plain",
	)}\nWindow source: ${formatWindowSource(s.windowGeometry)}; denominator: ${Math.round(s.contextLimit)} tokens${s.reasoningBudgetLine ? `\n${s.reasoningBudgetLine}` : ""}`;
	return s.configGeneration === undefined
		? summary
		: `${summary}\nConfig generation: ${s.configGeneration} (adopted ${s.configAdoptedAt ? new Date(s.configAdoptedAt).toLocaleString() : "unknown"})${s.configReloadFailure ? `\nConfig reload failed ${s.configReloadFailure.path}: ${s.configReloadFailure.message}` : ""}`;
}

/**
 * Pi's detail in the shape the shared status model reads. Every field the view
 * needs already carries the OpenCode spelling except these five, which Pi keeps
 * under its own names.
 */
export function statusViewSourceFromPiDetail(
	s: StatusDialogDetail,
): StatusViewSource {
	return {
		...s,
		protectedTagCount: s.protectedTokens.protectedCount,
		compactionEnabled: s.compactionEnabled,
		// Pi carries "no expiry" as an infinite remaining time rather than a flag.
		cacheNeverExpires: s.cacheRemainingMs === Number.POSITIVE_INFINITY,
		lastDreamerRunAt: s.dreamer.lastRunAt,
		dreamerSkipped: s.dreamer.skipped,
		dreamerTickFailure: s.dreamer.tickFailure,
		warnings: piStatusWarnings(s),
	};
}

/** Pi's theme colour for each shared tone. */
const PI_TONE_COLORS: Record<StatusTone, ThemeColor> = {
	accent: "accent",
	text: "text",
	muted: "muted",
	warning: "warning",
	error: "error",
};

/**
 * One label/value row: the label is padded to its section's fixed column so it
 * can never be squeezed into a mid-word wrap, and the value is flush right.
 */
function renderStatusRow(
	row: StatusRow,
	labelWidth: number,
	width: number,
	theme: Theme,
): string {
	const label = row.label.padEnd(labelWidth);
	const value = row.value.padStart(Math.max(1, width - label.length));
	return `${theme.fg("muted", label)}${theme.fg(PI_TONE_COLORS[row.tone], value)}`;
}

/** Two already-coloured cells pushed to opposite edges of one row. */
function renderSplitRow(left: string, right: string, width: number): string {
	const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
	return `${left}${" ".repeat(gap)}${right}`;
}

/** Pads one already-coloured cell to a fixed column width, ANSI-aware. */
function padCell(text: string, width: number): string {
	const pad = Math.max(0, width - visibleWidth(text));
	return `${text}${" ".repeat(pad)}`;
}

/**
 * Draws the sections as a two-column grid: sections pair up left/right in model
 * order, each pair sharing one title line and then one line per row, with the
 * taller column deciding how many lines the pair takes. A trailing odd section
 * sits alone in the left column. The shared model decides whether two columns
 * fit and how wide each has to be, so a value is never squeezed into a wrap and
 * this overlay and the OpenCode dialog lay the sections out the same way.
 */
function renderSectionGrid(
	sections: readonly StatusSection[],
	layout: StatusColumnLayout,
	theme: Theme,
): string[] {
	const gap = " ".repeat(STATUS_COLUMN_GAP);
	const lines: string[] = [];
	for (let i = 0; i < sections.length; i += 2) {
		const left = sections[i];
		if (!left) break;
		const right = sections[i + 1];
		lines.push("");
		const leftTitle = theme.fg("text", theme.bold(left.title));
		lines.push(
			right
				? `${padCell(leftTitle, layout.leftWidth)}${gap}${theme.fg("text", theme.bold(right.title))}`
				: leftTitle,
		);
		const rowCount = Math.max(left.rows.length, right?.rows.length ?? 0);
		for (let r = 0; r < rowCount; r++) {
			const leftRow = left.rows[r];
			const leftCell = leftRow
				? padCell(
						renderStatusRow(leftRow, left.labelWidth, layout.leftWidth, theme),
						layout.leftWidth,
					)
				: " ".repeat(layout.leftWidth);
			const rightRow = right?.rows[r];
			if (!right || !rightRow) {
				lines.push(leftCell);
				continue;
			}
			lines.push(
				`${leftCell}${gap}${renderStatusRow(rightRow, right.labelWidth, layout.rightWidth, theme)}`,
			);
		}
	}
	return lines;
}

/** The overlay's content lines, before the border is drawn around them. */
export function renderPiStatusOverlay(
	s: StatusDialogDetail,
	theme: Theme,
	innerWidth: number,
): string[] {
	// Which rows exist, their labels, order and colours come from the shared
	// model, so this overlay and the OpenCode dialog cannot drift apart. Only
	// the drawing is Pi's own. The snapshot passes the same check the OpenCode
	// dialog applies to its RPC reply; one the model cannot draw becomes the
	// "status unavailable" view naming the missing fields instead of an
	// exception thrown out of Pi's render loop.
	const status = checkLocalStatusSource(statusViewSourceFromPiDetail(s));
	const view = buildStatusViewFor(status, {
		version: packageJson.version,
	});
	const lines: string[] = [];

	lines.push(
		renderSplitRow(
			theme.fg("accent", theme.bold(view.title)),
			theme.fg("muted", view.version),
			innerWidth,
		),
	);
	lines.push("");
	lines.push(
		renderSplitRow(
			theme.fg(
				PI_TONE_COLORS[view.headline.left.tone],
				theme.bold(view.headline.left.text),
			),
			theme.fg(
				PI_TONE_COLORS[view.headline.right.tone],
				view.headline.right.text,
			),
			innerWidth,
		),
	);
	if (view.windowLine) lines.push(theme.fg("muted", view.windowLine));
	if (s.reasoningBudgetLine)
		lines.push(theme.fg("muted", s.reasoningBudgetLine));

	const bar = renderBar(view.bar, innerWidth);
	if (bar) lines.push(bar);
	for (const row of view.breakdown) {
		lines.push(
			renderSplitRow(
				colorHex(row.color, row.label),
				theme.fg("muted", row.value),
				innerWidth,
			),
		);
	}
	if (view.hygiene) {
		lines.push(renderStatusRow(view.hygiene, 9, innerWidth, theme));
	}

	// Pi has no sidebar, so show the total number of recorded historian runs
	// here beside the recomp state.
	if (status.state === "ready") {
		lines.push(
			renderStatusRow(
				{
					label: "Historian runs",
					value: s.historianRuns.toLocaleString(),
					tone: "muted",
				},
				9,
				innerWidth,
				theme,
			),
		);
	}

	const upgrade: StatusRow | null =
		status.state !== "ready"
			? null
			: s.recompInFlight
				? { label: "Recomp", value: "running…", tone: "warning" }
				: s.upgradeNeededCount > 0
					? {
							label: "Recomp",
							value: `${s.upgradeNeededCount} compartment${
								s.upgradeNeededCount === 1 ? "" : "s"
							} in the old layout · run /ctx-recomp`,
							tone: "warning",
						}
					: null;
	if (upgrade) lines.push(renderStatusRow(upgrade, 9, innerWidth, theme));

	// The shared model decides whether the sections fit in two columns at this
	// width, and how wide each column has to be; below that the same sections
	// are drawn in one column, in the same order, instead of being squeezed
	// into mid-word wraps.
	const layout = statusColumnsFor(view.sections, innerWidth);
	if (layout.twoColumn) {
		lines.push(...renderSectionGrid(view.sections, layout, theme));
	} else {
		for (const section of view.sections) {
			lines.push("");
			lines.push(theme.fg("text", theme.bold(section.title)));
			for (const row of section.rows) {
				lines.push(renderStatusRow(row, section.labelWidth, innerWidth, theme));
			}
		}
	}

	if (view.warnings.length > 0) {
		lines.push("");
		for (const warning of view.warnings) {
			lines.push(theme.fg(warning.tone, warning.text));
		}
	}

	lines.push("");
	lines.push(theme.fg("muted", view.footer));
	return lines;
}

/**
 * Wrap inner lines with a Unicode rounded-corner border. The border uses the
 * theme's borderMuted color so the overlay reads as a distinct surface.
 */
function drawBorder(inner: string[], width: number, theme: Theme): string[] {
	const innerWidth = Math.max(0, width - BORDER_COLUMNS - PADDING_COLUMNS);
	const border = (s: string) => theme.fg("borderMuted", s);

	const top = border(`╭${"─".repeat(innerWidth + PADDING_COLUMNS)}╮`);
	const bottom = border(`╰${"─".repeat(innerWidth + PADDING_COLUMNS)}╯`);
	const side = border("│");

	const out: string[] = [];
	out.push(top);
	for (const raw of inner) {
		const line = truncateToWidth(raw, innerWidth, "…");
		const visible = visibleWidth(line);
		const pad = " ".repeat(Math.max(0, innerWidth - visible));
		out.push(`${side} ${line}${pad} ${side}`);
	}
	out.push(bottom);
	return out;
}

export function deriveDefaultProtectedTokensFloor(usableSoft?: number): number {
	const soft =
		typeof usableSoft === "number" &&
		Number.isFinite(usableSoft) &&
		usableSoft > 0
			? usableSoft
			: 200_000;
	const low = Math.min(16_000, Math.round(0.08 * soft));
	const val = Math.round(0.05 * soft);
	return Math.max(low, Math.min(64_000, val));
}

interface StatusHostBytes {
	modelKey: string | undefined;
	modelBytes: string;
	system: string | undefined;
	tools: string[];
}

function readStatusHostBytes(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): StatusHostBytes {
	// Match the previous structural estimate: name, description and the exact
	// JSON serialization of each schema (not just tool names or object identity).
	return {
		modelKey: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
		modelBytes: safeStringify(ctx.model),
		system: safeRead(() => readHostSystemPrompt(ctx), undefined),
		tools: safeRead(
			() =>
				(pi.getAllTools?.() ?? []).map(
					(tool) =>
						`${tool.name ?? ""}\n${tool.description ?? ""}\n${safeStringify(tool.parameters)}`,
				),
			[],
		),
	};
}

/** One bounded entry, keyed by model and exact prompt/schema bytes, not object identity. */
export class PiStatusTokenCache {
	private systemKey: string | undefined;
	private systemTokens = 0;
	private toolsKey: string | undefined;
	private toolTokens = 0;

	constructor(private readonly estimate = estimateTokens) {}

	estimates(host: StatusHostBytes, fallbackSystemTokens: number) {
		if (host.system !== undefined) {
			const key = JSON.stringify([host.modelKey, host.system]);
			if (this.systemKey !== key) {
				this.systemTokens = this.estimate(host.system);
				this.systemKey = key;
			}
		}
		const key = JSON.stringify([host.modelKey, host.tools]);
		if (this.toolsKey !== key) {
			this.toolTokens = host.tools.reduce(
				(sum, bytes) => sum + this.estimate(bytes),
				0,
			);
			this.toolsKey = key;
		}
		return {
			systemPromptTokens:
				host.system === undefined ? fallbackSystemTokens : this.systemTokens,
			toolDefinitionTokens: this.toolTokens,
		};
	}
}

interface StatusBuildState {
	tokens: PiStatusTokenCache;
	live?: {
		persistedInputTokens: number;
		persistedPercentage: number;
		detectedContextLimit: number | undefined;
		// Captured with the full rebuild so the cheap per-second refresh uses
		// the same proven floor and provider limit as the full build.
		provenInputTokens: number | undefined;
		providerInputLimit: number | undefined;
	};
}

/** The same refresh controller is used by the dialog and fixture measurements. */
export class PiStatusDetailRefresh {
	private detail: StatusDialogDetail | undefined;
	private readonly state: StatusBuildState;
	private lastBuildAt = 0;
	private detailKey = "";
	private storeRevision: string | undefined;
	private revisionDb: ContextDatabase | undefined;
	private revisionStatement: Statement | undefined;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly ctx: ExtensionCommandContext,
		private readonly deps: StatusDialogDeps,
		private readonly initialSessionId: string,
		tokens = new PiStatusTokenCache(),
	) {
		this.state = { tokens };
	}

	private readStoreRevision(): string | undefined {
		// A rollback does not advance SQLite's change clocks. Never reuse a
		// snapshot read inside a transaction (or when its state is unknown).
		if (!isKnownAutocommit(this.deps.db)) return undefined;
		try {
			if (this.revisionDb !== this.deps.db) {
				this.revisionStatement = this.deps.db.prepare(
					"SELECT total_changes() AS changes, data_version AS version FROM pragma_data_version",
				);
				this.revisionDb = this.deps.db;
			}
			const row = this.revisionStatement?.get() as
				| { changes: number; version: number }
				| undefined;
			return row ? `${row.changes}/${row.version}` : undefined;
		} catch {
			return undefined;
		}
	}

	refresh(now = Date.now()): StatusDialogDetail {
		const sessionId = resolveSessionId(this.ctx) ?? this.initialSessionId;
		const host = readStatusHostBytes(this.pi, this.ctx);
		const usage = this.ctx.getContextUsage?.();
		const { db: _db, ...config } = this.deps;
		const key = JSON.stringify([sessionId, host, usage?.contextWindow, config]);
		const databaseChanged = this.revisionDb !== this.deps.db;
		const revision = this.readStoreRevision();
		if (
			!this.detail ||
			key !== this.detailKey ||
			revision === undefined ||
			revision !== this.storeRevision ||
			databaseChanged ||
			now - this.lastBuildAt >= DETAIL_REFRESH_INTERVAL_MS
		) {
			this.detail = buildStatusDetail(
				this.pi,
				this.ctx,
				this.deps,
				sessionId,
				this.state,
				host,
			);
			this.detailKey = key;
			this.lastBuildAt = now;
			// Building a fresh session may insert metadata. Record the clock
			// after that work so our own INSERT does not cause a second rebuild.
			this.storeRevision = this.readStoreRevision();
		}
		this.detail = refreshLiveStatus(
			this.detail,
			this.state,
			this.ctx,
			usage,
			now,
		);
		return this.detail;
	}
}

function conversationTokensFor(
	detail: Pick<
		StatusDialogDetail,
		| "inputTokens"
		| "systemPromptTokens"
		| "compartmentTokens"
		| "factTokens"
		| "memoryTokens"
		| "docsTokens"
		| "profileTokens"
		| "toolCallTokens"
		| "toolDefinitionTokens"
	>,
): number {
	return Math.max(
		0,
		detail.inputTokens -
			detail.systemPromptTokens -
			detail.compartmentTokens -
			detail.factTokens -
			detail.memoryTokens -
			detail.docsTokens -
			detail.profileTokens -
			detail.toolCallTokens -
			detail.toolDefinitionTokens,
	);
}

function refreshLiveStatus(
	detail: StatusDialogDetail,
	state: StatusBuildState,
	ctx: ExtensionCommandContext,
	usage: ReturnType<ExtensionCommandContext["getContextUsage"]>,
	now: number,
): StatusDialogDetail {
	const live = state.live;
	if (!live) return detail;
	const windowGeometry = resolvePiWindowGeometry({
		rawContextWindow: usage?.contextWindow ?? ctx.model?.contextWindow,
		rawContextWindowSource: "catalog",
		model: ctx.model,
		detectedContextLimit: live.detectedContextLimit,
		provenInputTokens: live.provenInputTokens,
		persistedInputTokens: live.persistedInputTokens,
		persistedPercentage: live.persistedPercentage,
	});
	const pressure = resolvePiStatusPressureSnapshot({
		providerInputLimit: live.providerInputLimit,
		sessionId: detail.sessionId,
		persistedPercentage: live.persistedPercentage,
		persistedInputTokens: live.persistedInputTokens,
		liveInputTokens: usage?.tokens,
		usableContextLimit: windowGeometry?.usableSoft,
	});
	const cacheRemainingMs = cacheRemaining(
		detail.cacheTtl,
		detail.lastResponseTime,
		now,
	);
	const embeddingRunState = getEmbedDrainUiStatus(
		detail.sessionId,
		undefined,
	).status;
	const current = {
		...detail,
		inputTokens: pressure.inputTokens,
		usagePercentage: pressure.percentage,
		contextLimit: pressure.contextLimit ?? 0,
		windowGeometry,
		cacheRemainingMs,
		cacheExpired: detail.lastResponseTime > 0 && cacheRemainingMs === 0,
		recompInFlight: isPiRecompInFlight(detail.sessionId),
		tailHygiene: resolveTailHygieneStatus(
			getPiChannel1Baseline(detail.sessionId),
		),
		embedding: {
			...detail.embedding,
			state:
				detail.embedding.state === "off"
					? ("off" as const)
					: embeddingRunState !== "idle"
						? embeddingRunState
						: detail.embedding.total > 0 &&
								detail.embedding.indexed >= detail.embedding.total
							? ("ready" as const)
							: ("waiting" as const),
		},
	};
	return { ...current, conversationTokens: conversationTokensFor(current) };
}

function cacheRemaining(
	cacheTtl: string,
	lastResponseTime: number,
	now: number,
): number {
	let ttlMs: number;
	try {
		ttlMs = parseCacheTtl(cacheTtl);
	} catch {
		ttlMs = 5 * 60 * 1000;
	}
	if (ttlMs === Number.POSITIVE_INFINITY) return ttlMs;
	return lastResponseTime > 0
		? Math.max(0, ttlMs - (now - lastResponseTime))
		: ttlMs;
}

export function buildPiStatusDetail(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	deps: StatusDialogDeps,
	sessionId: string,
): StatusDialogDetail {
	return buildStatusDetail(pi, ctx, deps, sessionId, {
		tokens: new PiStatusTokenCache(),
	});
}

function buildStatusDetail(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	deps: StatusDialogDeps,
	sessionId: string,
	state: StatusBuildState,
	host = readStatusHostBytes(pi, ctx),
): StatusDialogDetail {
	const usage = ctx.getContextUsage?.();

	const meta = getOrCreateSessionMeta(deps.db, sessionId);
	let detectedContextLimit: number | undefined;
	try {
		const detected = getOverflowState(deps.db, sessionId).detectedContextLimit;
		if (detected > 0) detectedContextLimit = detected;
	} catch {
		// Status remains available when overflow metadata cannot be read.
	}
	const providerInputLimit = piPressureEvidenceLimit(
		resolvePiWindowGeometry({
			rawContextWindow: usage?.contextWindow ?? ctx.model?.contextWindow,
			rawContextWindowSource: "catalog",
			model: ctx.model,
			detectedContextLimit,
		}),
	);
	const provenInputTokens = resolvePiProvenInputFloor({
		db: deps.db,
		sessionId,
		modelKey: piProvenFloorModelKey(ctx.model),
		readBranch: () => ctx.sessionManager.getBranch(),
		providerInputLimit,
	});
	state.live = {
		persistedInputTokens: meta.lastInputTokens,
		persistedPercentage: meta.lastContextPercentage,
		detectedContextLimit,
		provenInputTokens: provenInputTokens || undefined,
		providerInputLimit,
	};
	const windowGeometry = resolvePiWindowGeometry({
		rawContextWindow: usage?.contextWindow ?? ctx.model?.contextWindow,
		rawContextWindowSource: "catalog",
		model: ctx.model,
		detectedContextLimit,
		provenInputTokens: provenInputTokens || undefined,
		persistedInputTokens: meta.lastInputTokens,
		persistedPercentage: meta.lastContextPercentage,
	});
	const pressure = resolvePiStatusPressureSnapshot({
		providerInputLimit,
		sessionId,
		persistedPercentage: meta.lastContextPercentage,
		persistedInputTokens: meta.lastInputTokens,
		liveInputTokens: usage?.tokens,
		usableContextLimit: windowGeometry?.usableSoft,
	});
	const inputTokens = pressure.inputTokens;
	const contextLimit = pressure.contextLimit ?? 0;
	const usagePercentage = pressure.percentage;

	const compartments = getCompartments(deps.db, sessionId);
	const metaRow = readSessionMetaRow(deps.db, sessionId);
	const memoryBlockCount = Number(metaRow?.memory_block_count ?? 0);

	// v2 m[0] per-block attribution via the SHARED core helper so the Pi dialog
	// renders byte-identical categories to OpenCode's sidebar (Docs / User
	// Profile / Memories / Compartments measured from the real cached_m0 slice,
	// with Compartments also counting those still served in cached_m1;
	// Facts retired → 0). Falls back to Σp1 / on-demand v2 memory render cold.
	const decodeCachedBytes = (
		bytes: Buffer | Uint8Array | string | null | undefined,
	): string =>
		bytes instanceof Uint8Array
			? Buffer.from(bytes).toString("utf8")
			: typeof bytes === "string"
				? bytes
				: "";
	const m0Blocks = computeM0BlockTokens(deps.db, sessionId, {
		m0Text: decodeCachedBytes(metaRow?.cached_m0_bytes),
		m1Text: decodeCachedBytes(metaRow?.cached_m1_bytes),
		projectIdentity: deps.projectIdentity,
		injectionBudgetTokens: deps.injectionBudgetTokens,
		memoryBlockCount,
	});
	const compartmentTokens = m0Blocks.compartmentTokens;
	const factTokens = m0Blocks.factTokens;
	const memoryTokens = m0Blocks.memoryTokens;
	const docsTokens = m0Blocks.docsTokens;
	const profileTokens = m0Blocks.profileTokens;

	// On Pi we don't persist system_prompt_tokens (no
	// experimental.chat.system.transform hook). Compute it on demand from
	// ctx.getSystemPrompt() when available; fall back to the stored value
	// so the dialog still has a sensible number outside command context.
	const { systemPromptTokens, toolDefinitionTokens } = state.tokens.estimates(
		host,
		meta.systemPromptTokens,
	);

	const tags = getTagsBySession(deps.db, sessionId);
	const activeTags = tags.filter((tag) => tag.status === "active");
	const droppedTags = tags.filter((tag) => tag.status === "dropped");
	const activeBytes = activeTags.reduce((sum, tag) => sum + tag.byteSize, 0);
	const pendingOps = readPendingOpsCount(deps.db, sessionId);

	// Tool call + conversation tokens: read from session_meta where the
	// pipeline persists post-tag/post-injection/post-strip totals each
	// pass (see context-handler.ts:1858-1872 → tokenize-pi-messages.ts).
	//
	// IMPORTANT: do NOT walk `ctx.sessionManager.getBranch()` here.
	// `getBranch()` returns the full leaf-to-root path INCLUDING
	// pre-compaction-marker entries that were never tagged because they
	// predate the marker. Tokenizing all of them and trying to subtract
	// "dropped tool tags" cannot work — there are no tags for the
	// pre-compaction tool calls at all, so the result over-counts by
	// the entire pre-marker tool history (we observed Tool Calls = 1.1M
	// on a 162K context — ~650% impossible). The pipeline-side walk
	// uses the post-compaction `event.messages` view, which is the
	// authoritative source for what the LLM receives.
	const toolCallTokens = meta.toolCallTokens;

	const conversationTokens = conversationTokensFor({
		inputTokens,
		systemPromptTokens,
		compartmentTokens,
		factTokens,
		memoryTokens,
		docsTokens,
		profileTokens,
		toolCallTokens,
		toolDefinitionTokens,
	});
	const workMetrics = getSessionWorkMetrics(deps.db, sessionId);
	const tailHygiene = resolveTailHygieneStatus(
		getPiChannel1Baseline(sessionId),
	);

	const modelKey = ctx.model
		? `${ctx.model.provider}/${ctx.model.id}`
		: undefined;
	const threshold = resolveExecuteThresholdDetail(
		deps.executeThresholdPercentage ?? 65,
		modelKey,
		65,
		{
			tokensConfig: deps.executeThresholdTokens,
			contextLimit: contextLimit || undefined,
			sessionId,
		},
	);
	const cacheTtlDisplay = resolveCacheTtlDisplay({
		frozen: readSessionCacheTtl(deps.db, sessionId),
		configured: deps.cacheTtlConfig ?? "5m",
		configuredExplicitly: deps.cacheTtlConfigured === true,
		modelKey,
		sessionValue: meta.cacheTtl,
		sessionModelKey: meta.lastObservedModelKey,
	});
	const cacheTtl = cacheTtlDisplay.value;
	const cacheRemainingMs = cacheRemaining(
		cacheTtl,
		meta.lastResponseTime,
		Date.now(),
	);
	const cacheExpired = meta.lastResponseTime > 0 && cacheRemainingMs === 0;
	const historyBlockTokens = compartmentTokens + factTokens;
	const embeddingCoverage = safeRead(
		() => getEmbeddingCoverageStatus(deps.db, deps.projectIdentity, sessionId),
		{
			enabled: false,
			model: "off",
			provider: "off",
			session: { embedded: 0, total: 0 },
			memories: { embedded: 0, total: 0 },
			commits: { embedded: 0, total: 0, gitEnabled: false },
			shadowBackfillStalls: [],
		},
	);
	const embeddingRunState = getEmbedDrainUiStatus(sessionId, undefined).status;
	const embeddingState = !embeddingCoverage.enabled
		? "off"
		: embeddingRunState !== "idle"
			? embeddingRunState
			: embeddingCoverage.session.total > 0 &&
					embeddingCoverage.session.embedded >= embeddingCoverage.session.total
				? "ready"
				: "waiting";
	const historyBudgetPercentage = deps.historyBudgetPercentage ?? 0.15;
	const memoryImportanceHistogram = safeRead(
		() => getActiveMemoryImportanceHistogram(deps.db, deps.projectIdentity),
		emptyMemoryImportanceHistogram(),
	);
	const compressionBudget =
		contextLimit > 0
			? Math.floor(
					contextLimit *
						(Math.min(threshold.percentage, 80) / 100) *
						historyBudgetPercentage,
				)
			: null;

	return {
		sessionId,
		reasoningBudgetLine: reasoningBudgetStatusLine(sessionId),
		activeProfile: deps.activeProfile ?? null,
		configGeneration: deps.configGeneration,
		configAdoptedAt: deps.configAdoptedAt,
		configReloadFailure: deps.configReloadFailure,
		usagePercentage,
		inputTokens,
		systemPromptTokens,
		compartmentCount: compartments.length,
		lastCompartmentRange: (() => {
			const last = compartments.at(-1);
			return last ? `${last.startMessage}-${last.endMessage}` : null;
		})(),
		memoryCount: memoryImportanceHistogram.total,
		memoryBlockCount,
		memoryImportanceHistogram,
		sessionNoteCount: safeRead(
			() =>
				getNotes(deps.db, {
					sessionId,
					type: "session",
					status: "active",
				}).length,
			0,
		),
		readySmartNoteCount: safeRead(
			() =>
				getNotes(deps.db, {
					projectPath: deps.projectIdentity,
					type: "smart",
					status: "ready",
				}).length,
			0,
		),
		pendingOpsCount: pendingOps,
		compactionMarker: getCompactionMarkerHealth(deps.db, sessionId),
		historianRunning: meta.compartmentInProgress,
		historianRuns: countHistorianRuns(deps.db, sessionId),
		historianFailureCount: Number(metaRow?.historian_failure_count ?? 0),
		historianLastFailureAt:
			typeof metaRow?.historian_last_failure_at === "number"
				? metaRow.historian_last_failure_at
				: null,
		historianLastError: metaRow?.historian_last_error ?? null,
		cacheTtl,
		cacheTtlSource: cacheTtlDisplay.source,
		cacheTtlModelKey: cacheTtlDisplay.modelKey,
		configParseFailures: deps.configParseFailures ?? [],
		lastResponseTime: meta.lastResponseTime,
		cacheRemainingMs,
		cacheExpired,
		lastNudgeTokens: meta.lastNudgeTokens,
		lastNudgeBand: meta.lastNudgeBand ?? "",
		lastTransformError: meta.lastTransformError,
		isSubagent: meta.isSubagent,
		contextLimit,
		windowGeometry,
		executeThreshold: threshold.percentage,
		executeThresholdMode: threshold.mode,
		executeThresholdClamped: threshold.clamped,
		executeThresholdConfigured: threshold.configuredValue,
		protectedTokens: getProtectionWindowForSession(
			deps.db,
			sessionId,
			typeof deps.floor === "number" && Number.isFinite(deps.floor)
				? deps.floor
				: (readEpochFloorSnapshot(deps.db, sessionId) ??
						(typeof deps.protectedTokens === "number" &&
						Number.isFinite(deps.protectedTokens)
							? deps.protectedTokens
							: deriveDefaultProtectedTokensFloor(windowGeometry?.usableSoft))),
		).status,
		historyBlockTokens,
		compressionBudget,
		compressionUsage:
			compressionBudget && compressionBudget > 0
				? `${((historyBlockTokens / compressionBudget) * 100).toFixed(0)}%`
				: null,
		activeTags: activeTags.length,
		droppedTags: droppedTags.length,
		totalTags: tags.length,
		activeBytes,
		compartmentTokens,
		factTokens,
		memoryTokens,
		docsTokens,
		profileTokens,
		conversationTokens,
		toolCallTokens,
		toolDefinitionTokens,
		...(tailHygiene === undefined ? {} : { tailHygiene }),
		newWorkTokens: workMetrics.newWorkTokens,
		totalInputTokens: workMetrics.totalInputTokens,
		upgradeNeededCount: safeRead(
			() => countCompartmentsNeedingUpgrade(deps.db, sessionId),
			0,
		),
		recompInFlight: isPiRecompInFlight(sessionId),
		hasDeprecatedProtectedTags: deps.hasDeprecatedProtectedTags ?? false,
		compactionEnabled: deps.compactionEnabled ?? true,
		dreamer: {
			enabled: deps.dreamer?.runnable === true,
			scheduleSummary: deps.dreamer?.scheduleSummary ?? null,
			lastRunAt: safeRead(
				() => getMostRecentTaskRunAt(deps.db, deps.projectIdentity),
				null,
			),
			backlog: safeRead(
				() =>
					getDreamTaskBacklogs(
						deps.db,
						deps.projectIdentity,
						CANONICAL_DREAM_TASKS,
					),
				{},
			),
			failures: safeRead(
				() => getFailingDreamTasks(deps.db, deps.projectIdentity),
				[],
			),
			skipped: safeRead(
				() => getSkippedDreamTasks(deps.db, deps.projectIdentity),
				[],
			),
			// Recorded by the process-wide maintenance timer, so it is read from
			// the shared store rather than from this project's schedule rows.
			tickFailure: safeRead(() => getDreamerTickFailure(deps.db), null),
		},
		embedding: {
			state: embeddingState,
			indexed: embeddingCoverage.session.embedded,
			total: embeddingCoverage.session.total,
		},
	};
}

function safeStringify(value: unknown): string {
	try {
		if (value === undefined || value === null) return "";
		return typeof value === "string" ? value : JSON.stringify(value);
	} catch {
		return "";
	}
}

/**
 * Draws the breakdown bar with block characters, one coloured run per segment,
 * filling the row. Pi's renderer emits truecolor escapes (see `colorHex`), so
 * the bar carries the same category colours as the legend below it.
 *
 * The segment widths come from the shared `distributeBarWidths`, so the runs
 * always add up to the bar width and no blank cell can appear between them.
 */
function renderBar(
	segments: readonly StatusBarSegment[],
	innerWidth: number,
): string {
	// Fill the full inner content row. Clamp to a sensible minimum so
	// extremely narrow terminals still render a visible bar instead of
	// collapsing all segments to width 1.
	const barWidth = Math.max(20, innerWidth);
	if (segments.length === 0) return "";
	const widths = distributeBarWidths(
		segments.map((seg) => seg.tokens),
		barWidth,
	);
	return segments
		.map((seg, i) => colorHex(seg.color, "\u2588".repeat(widths[i] ?? 0)))
		.join("");
}

function readSessionMetaRow(db: ContextDatabase, sessionId: string) {
	return db
		.prepare<
			[string],
			{
				memory_block_cache: string | null;
				memory_block_count: number | null;
				cached_m0_bytes: Buffer | Uint8Array | string | null;
				cached_m1_bytes: Buffer | Uint8Array | string | null;
				historian_failure_count: number | null;
				historian_last_failure_at: number | null;
				historian_last_error: string | null;
			}
		>(
			"SELECT memory_block_cache, memory_block_count, cached_m0_bytes, cached_m1_bytes, historian_failure_count, historian_last_failure_at, historian_last_error FROM session_meta WHERE session_id = ?",
		)
		.get(sessionId);
}

function readPendingOpsCount(db: ContextDatabase, sessionId: string): number {
	try {
		const row = db
			.prepare<[string], { count: number }>(
				"SELECT COUNT(*) as count FROM pending_ops WHERE session_id = ?",
			)
			.get(sessionId);
		return row?.count ?? 0;
	} catch {
		return 0;
	}
}

function safeRead<T>(fn: () => T, fallback: T): T {
	try {
		return fn();
	} catch {
		return fallback;
	}
}

function colorHex(hex: string, text: string): string {
	const clean = hex.replace("#", "");
	const r = Number.parseInt(clean.slice(0, 2), 16);
	const g = Number.parseInt(clean.slice(2, 4), 16);
	const b = Number.parseInt(clean.slice(4, 6), 16);
	return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}
