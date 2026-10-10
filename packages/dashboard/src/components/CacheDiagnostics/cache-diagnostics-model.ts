import { truncate } from "../../lib/api";
import type { DbCacheEvent, Harness, SessionCacheStats } from "../../lib/types";

export type HarnessFilter = "all" | Harness;

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
export function cacheRatioTitle(event: Pick<DbCacheEvent, "aggregate" | "cold_start">): string {
  if (event.aggregate) {
    return "Cached share of the whole run: cache reads over every request's prompt, summed. Not compared with other runs.";
  }
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

/**
 * "1 run" / "3 runs" when every row is a Broca run total, else events, and
 * "no data" for a session with nothing recorded yet (a Broca run that has
 * just started) rather than "0 events".
 */
export function cacheCardCountLabel(events: DbCacheEvent[]): string {
  if (events.length === 0) return "no data";
  const noun = events.length > 0 && events.every((event) => event.aggregate) ? "run" : "event";
  return `${events.length} ${noun}${events.length === 1 ? "" : "s"}`;
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

export interface CacheSessionHeader {
  /** The full session name, never truncated. */
  name: string;
  tooltip: string;
  /** For Broca, the harness Broca ran the session for (from its identity). */
  innerHarness: string | null;
}

/**
 * Names the selected session above its timeline. A Broca session id is its
 * JSON identity `{project_root, harness, session}`; the header shows the
 * session name and inner harness and keeps the project root in the tooltip.
 */
export function cacheSessionHeader(
  harness: Harness,
  sessionId: string,
  title: string | undefined,
): CacheSessionHeader {
  if (harness === "broca") {
    try {
      const identity = JSON.parse(sessionId) as {
        project_root?: unknown;
        harness?: unknown;
        session?: unknown;
      };
      const name = typeof identity.session === "string" ? identity.session : title || sessionId;
      const innerHarness = typeof identity.harness === "string" ? identity.harness : null;
      const lines = [name];
      if (innerHarness) lines.push(`harness: ${innerHarness}`);
      if (typeof identity.project_root === "string")
        lines.push(`project: ${identity.project_root}`);
      return { name, tooltip: lines.join("\n"), innerHarness };
    } catch {
      // Not a JSON identity: fall through to the plain name.
    }
  }
  const name = title || sessionId;
  return {
    name,
    tooltip: name === sessionId ? name : `${name}\n${sessionId}`,
    innerHarness: null,
  };
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
