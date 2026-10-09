/**
 * The content of the `/ctx-status` view: one section/row model that every host
 * renders with its own drawing primitives.
 *
 * OpenCode 1 and OpenCode 2 paint it with the Solid/OpenTUI dialog component,
 * Pi paints it with its own line-based overlay renderer. Neither host decides
 * WHICH rows exist, what they are called, in which order they appear, or what
 * colour they carry — that is decided here, once, so a row cannot appear on one
 * host and be missing on another.
 *
 * Colours are semantic tones ("accent", "warning", …) rather than hex values,
 * because each host resolves them against its own theme. The one exception is
 * the token-breakdown palette: those colours identify a context category across
 * the status view AND the sidebar, so they are fixed hex values shared by both.
 */
import type { DreamerTickFailure } from "../features/magic-context/dreamer/tick-failure";
import { formatCacheTtlDisplay } from "./cache-ttl-display";
import { type ConfigParseFailure, formatConfigParseStatusLine } from "./config-diagnostics";
import { formatThresholdPercent } from "./format-threshold";
import { primaryQuotaDiagnostic } from "./quota-diagnostic";
import type { TailHygieneStatus } from "./rpc-types";
import {
    type StatusCheck,
    type StatusUnavailableReason,
    type StatusVersions,
    statusVersionNotice,
} from "./status-view-check";
import { formatTailHygiene } from "./tail-hygiene-status";
import {
    renderUserFacingFailure,
    type UserFacingFailureKey,
    userFacingFailureCode,
} from "./user-facing-codes";
import {
    formatWindowDerivationLine,
    formatWindowSource,
    type WindowGeometryResult,
} from "./window-geometry";

/** Theme-independent colour role; each host maps these onto its own palette. */
export type StatusTone = "accent" | "text" | "muted" | "warning" | "error";

export interface StatusRow {
    readonly label: string;
    readonly value: string;
    readonly tone: StatusTone;
}

export interface StatusSection {
    readonly title: string;
    /**
     * Characters reserved for the label column of this section. Labels are
     * padded to it and values start after it, so a label can never be squeezed
     * into a mid-word wrap by a long value next to it.
     */
    readonly labelWidth: number;
    readonly rows: readonly StatusRow[];
}

/** One coloured slice of the breakdown bar, sized by its token count. */
export interface StatusBarSegment {
    readonly label: string;
    readonly tokens: number;
    readonly color: string;
}

export interface StatusBreakdownRow {
    readonly label: string;
    readonly value: string;
    readonly color: string;
}

export interface StatusWarning {
    readonly text: string;
    readonly tone: "warning" | "error";
}

export interface StatusHeadlineCell {
    readonly text: string;
    readonly tone: StatusTone;
}

export interface StatusView {
    readonly title: string;
    readonly version: string;
    /** Left cell is pressure against the threshold, right cell is the absolute count. */
    readonly headline: { readonly left: StatusHeadlineCell; readonly right: StatusHeadlineCell };
    readonly windowLine: string | null;
    readonly bar: readonly StatusBarSegment[];
    readonly breakdown: readonly StatusBreakdownRow[];
    readonly hygiene: StatusRow | null;
    readonly sections: readonly StatusSection[];
    readonly warnings: readonly StatusWarning[];
    readonly footer: string;
}

/**
 * The status fields the view reads. Field names follow the OpenCode RPC
 * `StatusDetail`, so that host passes its snapshot straight in; Pi builds the
 * same shape from its own detail (see `statusViewSourceFromPiDetail`).
 */
export interface StatusViewSource {
    readonly usagePercentage: number;
    readonly inputTokens: number;
    readonly contextLimit: number;
    readonly executeThreshold: number;
    readonly executeThresholdClamped?: boolean;
    readonly windowGeometry?: WindowGeometryResult;
    readonly tailHygiene?: TailHygieneStatus;
    readonly systemPromptTokens: number;
    readonly docsTokens: number;
    readonly compartmentTokens: number;
    readonly compartmentCount: number;
    readonly factTokens: number;
    readonly memoryTokens: number;
    readonly memoryBlockCount: number;
    readonly profileTokens: number;
    readonly conversationTokens: number;
    readonly toolCallTokens: number;
    readonly toolDefinitionTokens: number;
    readonly activeTags: number;
    readonly droppedTags: number;
    readonly totalTags: number;
    readonly activeBytes: number;
    /** False when only a module-side total is authoritative; active/dropped are then unknown. */
    readonly tagCountsAuthoritative?: boolean;
    readonly lastNudgeTokens: number;
    readonly pendingOpsCount: number;
    readonly compactionMarker?: {
        readonly code: "MC-C11" | null;
        readonly attempts: number;
        readonly lastError: string | null;
        readonly pendingSinceMs: number | null;
    };
    readonly protectedTagCount: number;
    readonly isSubagent: boolean;
    readonly cacheTtl: string;
    readonly cacheTtlSource?: import("./cache-ttl-display").CacheTtlDisplaySource;
    readonly cacheTtlModelKey?: string;
    readonly lastResponseTime: number;
    readonly cacheRemainingMs: number;
    readonly cacheExpired: boolean;
    readonly cacheNeverExpires?: boolean;
    readonly historyBlockTokens: number;
    readonly compressionBudget: number | null;
    readonly compressionUsage: string | null;
    readonly lastDreamerRunAt?: number | null;
    /**
     * Dreamer tasks the running host cannot execute, by name. Shown so the
     * unavailable maintenance is visible as a named list rather than as a
     * backlog that silently never falls.
     */
    readonly dreamerUnsupportedTasks?: readonly string[];
    readonly dreamerSkipped?: readonly string[];
    /**
     * Set when the last background maintenance pass stopped before finishing.
     * Shown so "the dreamer has nothing to do" and "the dreamer never got to
     * its work" are not the same blank space in this view.
     */
    readonly dreamerTickFailure?: DreamerTickFailure | null;
    readonly dreamerFailures?: readonly { task: string; error: string }[];
    readonly memoryCount: number;
    readonly sessionNoteCount?: number;
    readonly readySmartNoteCount?: number;
    readonly archivedCompartmentCount?: number;
    readonly configParseFailures?: readonly ConfigParseFailure[];
    readonly configGeneration?: number;
    readonly configAdoptedAt?: number;
    readonly configReloadFailure?: { readonly path: string; readonly message: string };
    /** OpenCode spells this `compaction_enabled`; both spellings are accepted. */
    readonly compaction_enabled?: boolean;
    readonly compactionEnabled?: boolean;
    /** Failure codes to print under the sections, already selected by the host. */
    readonly warnings?: readonly UserFacingFailureKey[];
    /**
     * Set when this server migrated the shared store at startup while other
     * OpenCode servers (these PIDs, from their RPC discovery records) could not
     * be checked; if one was an older build still running, it now reads a
     * store newer than it supports.
     */
    readonly unconfirmedMigrationHolders?: {
        readonly pids: readonly number[];
        readonly fromVersion: number;
        readonly toVersion: number;
    };
    readonly hiddenVariantWarnings?: readonly string[];
}

declare const checkedStatusViewSource: unique symbol;

/**
 * A `StatusViewSource` that has passed `checkStatusViewSource`. The brand exists
 * only in the type system: `buildStatusView` accepts nothing else, so a payload
 * cannot reach the view model without going through the check.
 */
export type CheckedStatusViewSource = StatusViewSource & {
    readonly [checkedStatusViewSource]: true;
};

export interface StatusViewOptions {
    /** Plugin version shown next to the title. */
    readonly version: string;
    /** Clock used for the cache "last response"/"remaining" values. */
    readonly now?: number;
}

/**
 * Category palette, kept identical to the sidebar breakdown
 * (`src/tui/slots/sidebar-content.tsx`) so one colour means one category
 * wherever it is drawn.
 */
export const STATUS_CATEGORY_COLORS = {
    system: "#c084fc",
    docs: "#22d3ee",
    compartments: "#60a5fa",
    facts: "#fbbf24",
    memories: "#34d399",
    profile: "#a3e635",
    conversation: "#f87171",
    toolCalls: "#fb923c",
    toolDefs: "#f472b6",
} as const;

/**
 * Columns reserved between the two section columns when the grid is drawn.
 * The dialog draws its two columns at equal width with this gap between them.
 */
export const STATUS_COLUMN_GAP = 4;

/**
 * Columns one section needs so that neither its labels nor its values wrap:
 * the label column, one separating space, and the longest value in the section.
 */
export function statusSectionWidth(section: StatusSection): number {
    const longestValue = section.rows.reduce(
        (longest, row) => Math.max(longest, row.value.length),
        0,
    );
    return section.labelWidth + 1 + longestValue;
}

/** How the sections are laid out at one content width. */
export interface StatusColumnLayout {
    /** True when both columns fit; false means the caller draws one column. */
    readonly twoColumn: boolean;
    /** Columns the widest section in the left column needs. */
    readonly leftWidth: number;
    /** Columns the widest section in the right column needs. */
    readonly rightWidth: number;
}

function widestSectionWidth(sections: readonly StatusSection[]): number {
    return sections.reduce((widest, section) => Math.max(widest, statusSectionWidth(section)), 0);
}

/**
 * Whether the sections fit in two columns at this content width, and how wide
 * each column has to be.
 *
 * A value never wraps, so a section needs `labelWidth + 1 + longest value`
 * columns and the grid is drawn only when both columns' requirements plus the
 * gap fit the content width. When they do not, the caller draws the same
 * sections in one column instead of squeezing values into mid-word wraps.
 *
 * The returned widths are the columns' own requirements, so a caller that sizes
 * its columns from them cannot wrap a value even when the two requirements are
 * very different. Both renderers call this so neither decides the layout on its
 * own.
 */
export function statusColumnsFor(
    sections: readonly StatusSection[],
    contentWidth: number,
): StatusColumnLayout {
    const left = sections.filter((_section, index) => index % 2 === 0);
    const right = sections.filter((_section, index) => index % 2 === 1);
    const leftWidth = widestSectionWidth(left);
    const rightWidth = widestSectionWidth(right);
    const twoColumn =
        left.length > 0 &&
        right.length > 0 &&
        leftWidth + rightWidth + STATUS_COLUMN_GAP <= contentWidth;
    return { twoColumn, leftWidth, rightWidth };
}

/**
 * Integer column widths for the breakdown bar, summing exactly to `totalWidth`.
 *
 * Each segment's proportional share is rounded down and the leftover columns go
 * to the largest fractional remainders, so the widths always add up to the bar
 * width. Rounding every segment independently instead leaves the bar short of
 * its container by up to one column per segment, which paints as blank cells
 * between the coloured runs.
 *
 * Every segment that carries tokens keeps at least one column, so a category
 * whose share rounds below a column stays visible in the bar.
 */
export function distributeBarWidths(tokens: readonly number[], totalWidth: number): number[] {
    const width = Math.max(0, Math.floor(totalWidth));
    if (tokens.length === 0) return [];
    if (width === 0) return tokens.map(() => 0);
    const weights = tokens.map((value) =>
        typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0,
    );
    const total = weights.reduce((sum, value) => sum + value, 0);
    if (total <= 0) {
        // No token counts to weigh by: split the bar as evenly as possible.
        const base = Math.floor(width / tokens.length);
        const remainder = width - base * tokens.length;
        return tokens.map((_value, index) => base + (index < remainder ? 1 : 0));
    }
    const floors: number[] = weights.map((weight) => (weight > 0 ? 1 : 0));
    const assigned = floors.reduce((sum, value) => sum + value, 0);
    if (assigned > width) {
        // Narrower than the number of categories: keep the leftmost ones.
        let remaining = width;
        return floors.map((value) => {
            if (value === 0 || remaining === 0) return 0;
            remaining -= 1;
            return 1;
        });
    }
    const remaining = width - assigned;
    const exact = weights.map((weight) => (weight / total) * remaining);
    const shares = exact.map((value) => Math.floor(value));
    let leftover = remaining - shares.reduce((sum, value) => sum + value, 0);
    const byRemainder = exact
        .map((value, index) => ({
            index,
            fraction: value - Math.floor(value),
            weight: weights[index] ?? 0,
        }))
        .sort((a, b) => b.fraction - a.fraction || b.weight - a.weight || a.index - b.index);
    for (const entry of byRemainder) {
        if (leftover <= 0) break;
        shares[entry.index] = (shares[entry.index] ?? 0) + 1;
        leftover -= 1;
    }
    return floors.map((value, index) => value + (shares[index] ?? 0));
}

/** Compact token count, e.g. 623K. Shared so every host prints one spelling. */
export function formatStatusTokens(value: number): string {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
    return String(value);
}

function formatStatusBytes(value: number): string {
    if (value >= 1_048_576) return `${(value / 1_048_576).toFixed(1)} MB`;
    if (value >= 1_024) return `${Math.round(value / 1_024)} KB`;
    return `${value} B`;
}

function formatRelativeTime(timestamp: number, now: number): string {
    const elapsed = now - timestamp;
    if (elapsed < 60_000) return "just now";
    if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
    if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
    return `${Math.floor(elapsed / 86_400_000)}d ago`;
}

/** Remaining cache lifetime as one value, never a sentence: `4m 12s`, `38s`. */
function formatRemaining(milliseconds: number): string {
    const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes === 0) return `${seconds}s`;
    if (minutes < 60) return `${minutes}m ${seconds}s`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function pressureTone(usagePercentage: number): StatusTone {
    if (usagePercentage >= 80) return "error";
    if (usagePercentage >= 65) return "warning";
    return "accent";
}

function compactionEnabled(source: StatusViewSource): boolean {
    if (source.compaction_enabled === false) return false;
    if (source.compactionEnabled === false) return false;
    return true;
}

/**
 * Pressure headline when Magic Context compaction is off: the percentage is of
 * the model window, because native compaction — not the Magic Context execute
 * threshold — is what acts on it.
 */
function nativeCompactionLabel(source: StatusViewSource): string {
    if (source.contextLimit <= 0) return "Context: unknown · native compaction";
    const percentage = (source.inputTokens / source.contextLimit) * 100;
    return `Context: ${percentage.toFixed(1)}% · native compaction`;
}

function barSegments(source: StatusViewSource): StatusBarSegment[] {
    const segments: Array<StatusBarSegment & { readonly detail?: string }> = [];
    const push = (label: string, tokens: number, color: string, detail?: string) => {
        if (tokens > 0) segments.push({ label, tokens, color, detail });
    };
    push("System", source.systemPromptTokens, STATUS_CATEGORY_COLORS.system);
    push("Docs", source.docsTokens, STATUS_CATEGORY_COLORS.docs);
    if (compactionEnabled(source)) {
        push(
            `Compartments (${source.compartmentCount})`,
            source.compartmentTokens,
            STATUS_CATEGORY_COLORS.compartments,
        );
    }
    push("Facts", source.factTokens, STATUS_CATEGORY_COLORS.facts);
    push(
        `Memories (${source.memoryBlockCount})`,
        source.memoryTokens,
        STATUS_CATEGORY_COLORS.memories,
    );
    push("User Profile", source.profileTokens, STATUS_CATEGORY_COLORS.profile);
    push("Conversation", source.conversationTokens, STATUS_CATEGORY_COLORS.conversation);
    push("Tool Calls", source.toolCallTokens, STATUS_CATEGORY_COLORS.toolCalls);
    push("Tool Defs", source.toolDefinitionTokens, STATUS_CATEGORY_COLORS.toolDefs);
    return segments;
}

function tagRows(source: StatusViewSource): StatusRow[] {
    // A module-side total is the only authoritative count in Rust mode; the
    // host's active/dropped mirror is not presented as truth there.
    const authoritative = source.tagCountsAuthoritative !== false;
    return [
        {
            label: "Active",
            value: authoritative
                ? `${source.activeTags} (~${formatStatusBytes(source.activeBytes)})`
                : "n/a (module total only)",
            tone: "text",
        },
        {
            label: "Dropped",
            value: authoritative ? String(source.droppedTags) : "n/a (module total only)",
            tone: "text",
        },
        { label: "Total", value: String(source.totalTags), tone: "muted" },
    ];
}

function cacheRows(source: StatusViewSource, now: number): StatusRow[] {
    const configured = formatCacheTtlDisplay({
        value: source.cacheTtl,
        source: source.cacheTtlSource ?? "session",
        modelKey: source.cacheTtlModelKey,
    }).replace(/^Cache TTL: /, "");
    const neverExpires =
        source.cacheNeverExpires === true ||
        source.cacheRemainingMs === Number.POSITIVE_INFINITY ||
        source.cacheRemainingMs < 0;
    const threshold = `${formatThresholdPercent(source.executeThreshold)}%`;
    const rows: StatusRow[] = [
        { label: "Configured", value: configured, tone: "text" },
        {
            label: "Last response",
            value:
                source.lastResponseTime > 0
                    ? formatRelativeTime(source.lastResponseTime, now)
                    : "never",
            tone: "text",
        },
    ];
    // With no expiry there is no countdown to print, so the row is absent
    // rather than carrying a sentence explaining its own absence.
    if (!neverExpires) {
        rows.push({
            label: "Remaining",
            value: source.cacheExpired ? "expired" : formatRemaining(source.cacheRemainingMs),
            tone: source.cacheExpired ? "warning" : "muted",
        });
    }
    rows.push({
        label: "Auto-execute",
        value: source.cacheExpired
            ? "yes (expired)"
            : neverExpires
              ? `at ≥${threshold}`
              : `at TTL or ≥${threshold}`,
        tone: "muted",
    });
    return rows;
}

function historyRows(source: StatusViewSource, now: number): StatusRow[] {
    const rows: StatusRow[] = [
        {
            label: "History block",
            value: `~${formatStatusTokens(source.historyBlockTokens)} tok`,
            tone: "text",
        },
    ];
    if (source.compressionBudget != null) {
        rows.push({
            label: "Budget",
            value: `~${formatStatusTokens(source.compressionBudget)} tok (${source.compressionUsage} used)`,
            tone: "text",
        });
    }
    if (source.lastDreamerRunAt) {
        rows.push({
            label: "Dreamer",
            value: `last ${formatRelativeTime(source.lastDreamerRunAt, now)}`,
            tone: "muted",
        });
    }
    rows.push(...dreamerUnsupportedRows(source));
    rows.push(...dreamerTickFailureRows(source, now));
    return rows;
}

/** Availability rows for unsupported tasks and explicitly disabled/unavailable runs. */
function dreamerUnsupportedRows(source: StatusViewSource): StatusRow[] {
    const unsupported = source.dreamerUnsupportedTasks ?? [];
    const skipped: StatusRow[] = (source.dreamerSkipped ?? []).map((value) => ({
        label: "Dreamer skipped",
        value,
        tone: "muted",
    }));
    if (unsupported.length === 0) return skipped;
    return [
        ...skipped,
        {
            label: "Dreamer unavailable",
            value: `${unsupported.join(", ")} (${userFacingFailureCode("dream_task_needs_tool_loop")})`,
            tone: "warning",
        },
    ];
}

/** One row naming the stage that stopped the last maintenance pass, if one did. */
function dreamerTickFailureRows(source: StatusViewSource, now: number): StatusRow[] {
    const quotas = [
        ...new Set(
            (source.dreamerFailures ?? []).flatMap((failure) => {
                const quota = primaryQuotaDiagnostic(failure.error);
                return quota ? [quota] : [];
            }),
        ),
    ].map((value): StatusRow => ({ label: "Dreamer quota", value, tone: "warning" }));
    const failure = source.dreamerTickFailure;
    if (!failure) return quotas;
    return [
        ...quotas,
        {
            label: "Dreamer blocked",
            value: `${failure.stage} failed ${formatRelativeTime(failure.at, now)} (${userFacingFailureCode(
                "dreamer_tick_blocked",
            )})`,
            tone: "error",
        },
    ];
}

/**
 * Sections when Magic Context compaction is off: its tags, thresholds and
 * history budgets describe machinery that is not running, so the view shows
 * only what still holds — the knowledge the plugin keeps injecting.
 */
function knowledgeSections(source: StatusViewSource, now: number): StatusSection[] {
    const rows: StatusRow[] = [
        { label: "Memories", value: String(source.memoryCount), tone: "accent" },
        { label: "Notes", value: String(source.sessionNoteCount ?? 0), tone: "muted" },
    ];
    if ((source.archivedCompartmentCount ?? 0) > 0) {
        rows.push({
            label: "Archived compartments",
            value: String(source.archivedCompartmentCount),
            tone: "muted",
        });
    }
    if ((source.readySmartNoteCount ?? 0) > 0) {
        rows.push({
            label: "Smart Notes",
            value: `${source.readySmartNoteCount} ready`,
            tone: "accent",
        });
    }
    if (source.lastDreamerRunAt) {
        rows.push({
            label: "Dreamer",
            value: `last ${formatRelativeTime(source.lastDreamerRunAt, now)}`,
            tone: "muted",
        });
    }
    rows.push(...dreamerUnsupportedRows(source));
    rows.push(...dreamerTickFailureRows(source, now));
    return [{ title: "Knowledge", labelWidth: 23, rows }];
}

/**
 * Section order is also the reading order: hosts with room draw them in two
 * columns (even indices left, odd indices right, which is how they have always
 * been arranged), and a narrow host draws the same list in one column.
 */
function statusSections(source: StatusViewSource, now: number): StatusSection[] {
    const configSection: StatusSection[] =
        source.configGeneration === undefined
            ? []
            : [
                  {
                      title: "Config",
                      labelWidth: 12,
                      rows: [
                          {
                              label: "Generation",
                              value: `${source.configGeneration} · adopted ${source.configAdoptedAt ? new Date(source.configAdoptedAt).toLocaleString() : "unknown"}`,
                              tone: "muted",
                          },
                      ],
                  },
              ];
    if (!compactionEnabled(source)) return [...knowledgeSections(source, now), ...configSection];
    return [
        { title: "Tags", labelWidth: 8, rows: tagRows(source) },
        {
            title: "Reductions",
            labelWidth: 19,
            rows: [
                {
                    label: "Execute threshold",
                    value: `${formatThresholdPercent(source.executeThreshold)}%${
                        source.executeThresholdClamped ? "*" : ""
                    }`,
                    tone: "text",
                },
                {
                    label: "Last reduce anchor",
                    value: `${formatStatusTokens(source.lastNudgeTokens)} tok`,
                    tone: "text",
                },
            ],
        },
        {
            title: "Pending Queue",
            labelWidth: 8,
            rows: [
                {
                    label: "Drops",
                    value: String(source.pendingOpsCount),
                    tone: source.pendingOpsCount > 0 ? "warning" : "muted",
                },
                {
                    label: "Marker",
                    value: source.compactionMarker?.code
                        ? `${source.compactionMarker.code} · ${source.compactionMarker.attempts} attempts · ${source.compactionMarker.lastError ?? "unknown error"}`
                        : "healthy",
                    tone: source.compactionMarker?.code ? "warning" : "muted",
                },
            ],
        },
        {
            title: "Context Details",
            labelWidth: 15,
            rows: [
                {
                    label: "Protected tags",
                    value: String(source.protectedTagCount),
                    tone: "muted",
                },
                { label: "Subagent", value: source.isSubagent ? "yes" : "no", tone: "muted" },
                {
                    label: "Denominator",
                    value: `${Math.round(source.contextLimit)} tokens`,
                    tone: "muted",
                },
                {
                    label: "Window source",
                    value: formatWindowSource(source.windowGeometry),
                    tone: "muted",
                },
            ],
        },
        { title: "Cache TTL", labelWidth: 14, rows: cacheRows(source, now) },
        { title: "History Compression", labelWidth: 14, rows: historyRows(source, now) },
        ...configSection,
        {
            title: "Memory",
            labelWidth: 9,
            rows: [
                { label: "Active", value: String(source.memoryCount), tone: "accent" },
                { label: "Injected", value: String(source.memoryBlockCount), tone: "muted" },
            ],
        },
    ];
}

function warningBlock(source: StatusViewSource): StatusWarning[] {
    const holders = source.unconfirmedMigrationHolders;
    return [
        ...(holders && holders.pids.length > 0
            ? [
                  {
                      text: `Magic Context upgraded its database from v${holders.fromVersion} to v${holders.toVersion} while OpenCode PID ${holders.pids.join(", ")} could not be checked. If an older OpenCode is still open, quit all OpenCode processes and start again.`,
                      tone: "error" as const,
                  },
              ]
            : []),
        ...(source.hiddenVariantWarnings ?? []).map((text) => ({ text, tone: "warning" as const })),
        ...(source.configReloadFailure
            ? [
                  {
                      text: `Config reload failed ${source.configReloadFailure.path}: ${source.configReloadFailure.message}`,
                      tone: "error" as const,
                  },
              ]
            : []),
        ...(source.configParseFailures ?? []).map((failure) => ({
            text: formatConfigParseStatusLine(failure),
            tone: "error" as const,
        })),
        ...(source.warnings ?? []).map((code) => ({
            text:
                code === "compaction_marker_missing" && source.compactionMarker?.code
                    ? `${renderUserFacingFailure(code)} ${source.compactionMarker.attempts} attempts; last error: ${source.compactionMarker.lastError ?? "unknown"}.`
                    : renderUserFacingFailure(code),
            tone: "warning" as const,
        })),
    ];
}

/** Builds the full status view from one checked snapshot. */
export function buildStatusView(
    source: CheckedStatusViewSource,
    options: StatusViewOptions,
): StatusView {
    const now = options.now ?? Date.now();
    const off = !compactionEnabled(source);
    const tone = off ? "accent" : pressureTone(source.usagePercentage);
    const segments = barSegments(source);
    const total = source.inputTokens || 1;
    return {
        title: "⚡ Magic Context Status",
        version: `v${options.version}`,
        headline: {
            left: {
                text: off
                    ? nativeCompactionLabel(source)
                    : `${source.usagePercentage.toFixed(1)}% / ${formatThresholdPercent(
                          source.executeThreshold,
                      )}%${source.executeThresholdClamped ? "*" : ""}`,
                tone,
            },
            right: {
                text: `${formatStatusTokens(source.inputTokens)} / ${
                    source.contextLimit > 0 ? formatStatusTokens(source.contextLimit) : "?"
                } tokens`,
                tone,
            },
        },
        windowLine: source.windowGeometry
            ? formatWindowDerivationLine(source.inputTokens, source.windowGeometry)
            : null,
        bar: segments,
        breakdown: segments.map((segment) => ({
            label: segment.label,
            value: `${formatStatusTokens(segment.tokens)} (${((segment.tokens / total) * 100).toFixed(1)}%)`,
            color: segment.color,
        })),
        hygiene: source.tailHygiene
            ? {
                  label: "Hygiene",
                  value: formatTailHygiene(source.tailHygiene),
                  tone: source.tailHygiene.evaluable ? "accent" : "warning",
              }
            : null,
        sections: statusSections(source, now),
        warnings: warningBlock(source),
        footer: "Esc to close",
    };
}

/** Short name for the reason, shown on the headline and in the reason row. */
function unavailableLabel(reason: StatusUnavailableReason): string {
    if (reason.kind === "rpc_error") return "server did not answer";
    if (reason.kind === "not_tracked") {
        return reason.cause === "home_directory" ? "home directory" : "memory paused";
    }
    if (reason.kind === "malformed") return "incomplete status data";
    return "view error";
}

/** Full-width sentences explaining the reason and what to do about it. */
function unavailableExplanation(
    reason: StatusUnavailableReason,
    versionNotice: string | null,
): string[] {
    const persists = "If this persists after a restart, report it with magic-context.log attached.";
    if (reason.kind === "rpc_error") {
        return [
            `The Magic Context server did not return status: ${reason.message}`,
            renderUserFacingFailure("status_unavailable", "plain"),
        ];
    }
    if (reason.kind === "not_tracked" && reason.cause === "home_directory") {
        return [
            "This is your home directory, so Magic Context keeps no project history or memory here.",
            "Set allow_home_project in magic-context.jsonc to opt in.",
        ];
    }
    if (reason.kind === "not_tracked") {
        return [
            "Magic Context could not work out a project identity for this directory, so its memory features are paused.",
            'magic-context.log names the cause (search for "memory features paused"), for example a git command that failed.',
        ];
    }
    if (reason.kind === "malformed") {
        return [
            `The status reply is missing, or has unexpected values for: ${reason.fields.join(", ")}.`,
            versionNotice ? "The version difference above is the likely cause." : persists,
        ];
    }
    return [`The status view could not be drawn: ${reason.message}`, persists];
}

/**
 * The view drawn instead of the status when there is no usable snapshot. It has
 * the same shape as a full view (headline, sections, warnings, footer), so a
 * host draws it with the same code and cannot crash on a missing part.
 */
export function buildUnavailableStatusView(
    reason: StatusUnavailableReason,
    versions: StatusVersions | null,
    options: StatusViewOptions,
): StatusView {
    const label = unavailableLabel(reason);
    const versionNotice = statusVersionNotice(versions);
    const rows: StatusRow[] = [{ label: "Reason", value: label, tone: "warning" }];
    if (versions) {
        rows.push(
            { label: "Server", value: versions.server ?? "not reported", tone: "muted" },
            { label: "UI", value: versions.ui, tone: "muted" },
        );
    }
    return {
        title: "⚡ Magic Context Status",
        version: `v${options.version}`,
        headline: {
            left: { text: "Status unavailable", tone: "error" },
            right: { text: label, tone: "muted" },
        },
        windowLine: null,
        bar: [],
        breakdown: [],
        hygiene: null,
        sections: [{ title: "Status unavailable", labelWidth: 8, rows }],
        warnings: [
            ...(versionNotice ? [{ text: versionNotice, tone: "error" as const }] : []),
            ...unavailableExplanation(reason, versionNotice).map((text) => ({
                text,
                tone: "warning" as const,
            })),
        ],
        footer: "Esc to close",
    };
}

/**
 * The view for one checked status result: the full status, or the
 * "status unavailable" view naming why there is none. A version difference
 * between the server and this UI is named in both. This never throws, so a
 * host can call it inside a render without guarding it.
 */
export function buildStatusViewFor(
    check: StatusCheck<unknown>,
    options: StatusViewOptions,
): StatusView {
    if (check.state === "unavailable") {
        return buildUnavailableStatusView(check.reason, check.versions, options);
    }
    try {
        const view = buildStatusView(check.source, options);
        const versionNotice = statusVersionNotice(check.versions);
        const notices: StatusWarning[] = [
            ...(versionNotice ? [{ text: versionNotice, tone: "warning" as const }] : []),
            ...(check.ignoredFields.length > 0
                ? [
                      {
                          text: `Ignored status fields with an unexpected shape: ${check.ignoredFields.join(", ")}`,
                          tone: "warning" as const,
                      },
                  ]
                : []),
        ];
        return notices.length > 0 ? { ...view, warnings: [...notices, ...view.warnings] } : view;
    } catch (error) {
        return buildUnavailableStatusView(
            {
                kind: "view_error",
                message: error instanceof Error ? error.message : String(error),
            },
            check.versions,
            options,
        );
    }
}

/** Pads one row to its section's label column; values print flush right. */
export function formatStatusRowText(row: StatusRow, labelWidth: number, width: number): string {
    const label = row.label.padEnd(labelWidth);
    const room = Math.max(1, width - label.length);
    return `${label}${row.value.padStart(room)}`.trimEnd();
}
