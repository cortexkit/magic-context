import { truncate } from "../../lib/api";
import type {
  BrocaSessionSummary,
  DbCacheEvent,
  Harness,
  SessionCacheStats,
} from "../../lib/types";

export type HarnessFilter = "all" | Harness;

export type CacheSessionSelection = { harness: Harness; sessionId: string };

/**
 * Keep the selection inside the visible card list. A Broca card cannot be
 * selected: the dashboard has only Broca's per-run totals for it, with no
 * per-request rows to draw a timeline from.
 */
export function cacheTimelineSelection(
  visible: SessionCacheStats[],
  current: CacheSessionSelection | null,
): CacheSessionSelection | null {
  const selectable = visible.filter((row) => row.harness !== "broca");
  if (
    current &&
    selectable.some(
      (row) => row.harness === current.harness && row.session_id === current.sessionId,
    )
  ) {
    return current;
  }
  const newest = selectable[0];
  return newest ? { harness: newest.harness, sessionId: newest.session_id } : null;
}

export const cacheHarnessOptions: { value: HarnessFilter; label: string }[] = [
  { value: "all", label: "Harness: All" },
  { value: "opencode", label: "OpenCode" },
  { value: "opencode2", label: "OpenCode 2" },
  { value: "pi", label: "Pi" },
  { value: "omp", label: "OMP" },
  { value: "broca", label: "Broca" },
  { value: "claude_code", label: "Claude Code" },
  { value: "codex", label: "Codex" },
];

export function cacheSessionRatio(events: DbCacheEvent[]): number | null {
  let read = 0;
  let total = 0;
  let reported = false;
  for (const event of events) {
    if (!event.cache_reported) continue;
    reported = true;
    read += event.cache_read;
    total += event.cache_read + event.cache_write + event.input_tokens;
  }
  return reported ? (total > 0 ? read / total : 0) : null;
}

/**
 * Stands in for a percentage that cannot be computed. It is one character so
 * a card's big figure keeps the same size whatever the session reported; the
 * reason goes in smaller text beside it.
 */
export const CACHE_FIGURE_PLACEHOLDER = "—";

/** Why a figure is missing when the provider never reported cache reads. */
export const CACHE_NOT_REPORTED = "cache not reported";

/** Why a figure is missing when requests reported cache reads, all of them zero. */
export const CACHE_NO_READS = "no cache reads";

export function cachePercentage(ratio: number | null): string {
  return ratio === null ? CACHE_FIGURE_PLACEHOLDER : `${(ratio * 100).toFixed(1)}%`;
}

export function cacheEventPercentage(event: DbCacheEvent): string {
  if (!event.cache_reported) return CACHE_NOT_REPORTED;
  return event.severity === "unknown" ? "no cache data" : cachePercentage(event.hit_ratio);
}

/** Tooltip explaining what a row's percentage measures. */
export function cacheRatioTitle(event: Pick<DbCacheEvent, "cold_start">): string {
  if (event.cold_start) return "First request of the session: nothing was cached yet";
  return "Cache retention vs the previous step's expected prefix";
}

/**
 * The note to show above the session cards when some listed sessions cannot be
 * updated while a turn runs (the backend explains why on each such row).
 */
export function cacheActivityNote(sessions: SessionCacheStats[]): string | null {
  return sessions.find((row) => row.activity_note)?.activity_note ?? null;
}

export function cacheSessionTitle(row: SessionCacheStats): string {
  return row.title || truncate(row.session_id, 16);
}

export interface CacheCardSummary {
  /** The big figure: a percentage or the placeholder, never words. */
  text: string;
  /** "ratio" colors the text by hit ratio; "neutral" renders it muted. */
  tone: "ratio" | "neutral";
  ratio: number;
  title: string;
  /** Small text shown after the event count, explaining a placeholder. */
  note: string | null;
}

/**
 * The headline of a session card. A red percentage is reserved for sessions
 * that actually read from the cache and could have read more: a session whose
 * requests report no cache reads at all, or whose window holds only its cold
 * opening turn, is shown in a neutral color.
 */
export function cacheCardSummary(events: DbCacheEvent[]): CacheCardSummary {
  if (events.length === 0) {
    return {
      text: CACHE_FIGURE_PLACEHOLDER,
      tone: "neutral",
      ratio: 0,
      title: "No model request of this session has been recorded yet",
      note: null,
    };
  }
  const ratio = cacheSessionRatio(events);
  if (ratio === null) {
    return {
      text: cachePercentage(null),
      tone: "neutral",
      ratio: 0,
      title: "No request in this window reported cached tokens",
      note: CACHE_NOT_REPORTED,
    };
  }
  if (!events.some((event) => event.cache_reported && event.cache_read > 0)) {
    return {
      text: CACHE_FIGURE_PLACEHOLDER,
      tone: "neutral",
      ratio,
      title: "No request in this window read anything from the cache",
      note: CACHE_NO_READS,
    };
  }
  const turns = new Set(events.map((event) => event.turn_id));
  if (turns.size === 1 && events.some((event) => event.cold_start)) {
    return {
      text: cachePercentage(ratio),
      tone: "neutral",
      ratio,
      title: "Only the session's cold first run is loaded: nothing was cached before it",
      note: null,
    };
  }
  return {
    text: cachePercentage(ratio),
    tone: "ratio",
    ratio,
    title: "Cache reads over total prompt tokens in this window",
    note: null,
  };
}

/** Whole-session cache-read summary from runs, not cache-refresh attempts or a timeline window. */
export function brocaCardSummary(summary: BrocaSessionSummary): CacheCardSummary {
  const usage = summary.usage;
  const read = usage.cached_input_tokens;
  if (read === null) return { ...cacheCardSummary([]), title: "No run reported cached tokens" };
  const total = (usage.input_tokens ?? 0) + read + (usage.cache_write_tokens ?? 0);
  const ratio = total > 0 ? read / total : 0;
  return {
    text: read > 0 ? cachePercentage(ratio) : CACHE_FIGURE_PLACEHOLDER,
    tone: read > 0 ? "ratio" : "neutral",
    ratio,
    title: "Cache reads over total prompt tokens across finished runs",
    note: null,
  };
}

export function brocaCardTooltip(summary: BrocaSessionSummary): string {
  const lines = [
    summary.session.session,
    `harness: ${summary.session.harness}`,
    `project: ${summary.session.project_root ?? "No project folder"}`,
    ...summary.models,
  ];
  if (summary.first_activity_ms !== null)
    lines.push(`first: ${new Date(summary.first_activity_ms).toLocaleString()}`);
  if (summary.last_activity_ms !== null)
    lines.push(`last: ${new Date(summary.last_activity_ms).toLocaleString()}`);
  return lines.join("\n");
}

/** Count recorded requests; an empty window has no data. */
export function cacheCardCountLabel(events: DbCacheEvent[]): string {
  if (events.length === 0) return "no data";
  return `${events.length} event${events.length === 1 ? "" : "s"}`;
}

export interface SessionModelSummary {
  /** Model of the newest event that recorded one. */
  model: string;
  provider: string | null;
  /** How many other models the loaded events used. */
  others: number;
  /** Every provider/model seen, most recently used first. */
  all: string[];
}

function providerModelLabel(event: Pick<DbCacheEvent, "provider" | "model">): string {
  return event.provider ? `${event.provider}/${event.model}` : (event.model ?? "");
}

export function sessionModelSummary(events: DbCacheEvent[]): SessionModelSummary | null {
  const lastUsed = new Map<string, number>();
  let latest: DbCacheEvent | null = null;
  for (const event of events) {
    if (!event.model) continue;
    const label = providerModelLabel(event);
    lastUsed.set(label, Math.max(lastUsed.get(label) ?? event.timestamp, event.timestamp));
    if (!latest || event.timestamp >= latest.timestamp) latest = event;
  }
  if (!latest?.model) return null;
  const all = [...lastUsed.entries()].sort((a, b) => b[1] - a[1]).map(([label]) => label);
  return { model: latest.model, provider: latest.provider, others: all.length - 1, all };
}

/** `claude-opus-5-5`, or `claude-opus-5-5 (+1)` when the session mixed models. */
export function sessionModelLabel(summary: SessionModelSummary): string {
  return summary.others > 0 ? `${summary.model} (+${summary.others})` : summary.model;
}

export function cacheSessionVisible(
  row: SessionCacheStats,
  harness: HarnessFilter,
  showUnmanaged: boolean,
  hideSubagents: boolean,
): boolean {
  return (
    (harness === "all" || row.harness === harness) &&
    (!isManagedFilterableHarness(row.harness) || showUnmanaged || row.managed) &&
    (!hideSubagents || !row.is_subagent)
  );
}

export function isManagedFilterableHarness(harness: Harness): boolean {
  return harness === "claude_code" || harness === "codex" || harness === "broca";
}
