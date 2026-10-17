import type { DbCacheEvent } from "./types";

const SEVERITY_RANK: Record<DbCacheEvent["severity"], number> = {
  full_bust: 6,
  bust: 5,
  warming: 4,
  warning: 3,
  stable: 2,
  info: 1,
  aggregate: 1,
  unknown: 0,
};

/**
 * Select the event that supplies a turn's summary severity and cause. Equal
 * severities intentionally favor the later event so the displayed cause
 * describes the newest equally-severe step.
 */
export function selectWorstCacheEvent(events: readonly DbCacheEvent[]): DbCacheEvent | undefined {
  let winner: DbCacheEvent | undefined;
  for (const event of events) {
    if (
      !winner ||
      SEVERITY_RANK[event.severity] > SEVERITY_RANK[winner.severity] ||
      (SEVERITY_RANK[event.severity] === SEVERITY_RANK[winner.severity] &&
        event.timestamp >= winner.timestamp)
    ) {
      winner = event;
    }
  }
  return winner;
}

// Map a cache-event severity to a bar/pill color class. Severity is the source
// of truth (computed cross-step in the backend); colors follow it directly.
export function severityColorClass(severity: string): string {
  switch (severity) {
    case "stable":
      return "green";
    case "warning":
      return "amber";
    case "bust":
    case "full_bust":
      return "red";
    case "info":
      return "blue";
    default:
      return "gray"; // unknown / warming / aggregate
  }
}

type CacheLabelFields = Pick<DbCacheEvent, "severity" | "cold_start" | "aggregate" | "finish">;

/**
 * Pill text for one cache row. A session's first row is a cold start: its
 * opening request had nothing cached to read, so it is labelled neutrally
 * instead of as a miss. A run aggregate sums a whole agent loop and carries
 * no health verdict, so it is labelled as a total rather than STABLE/BUST.
 */
export function cacheEventLabel(event: CacheLabelFields): string {
  if (event.aggregate) {
    const base = event.cold_start ? "COLD START · RUN TOTAL" : "RUN TOTAL";
    // A run that ended any way other than normally (error, cancelled, max
    // steps, ...) still billed its requests; name the ending so it is not
    // mistaken for a completed run.
    return event.finish && event.finish !== "completed"
      ? `${base} · ${event.finish.toUpperCase()}`
      : base;
  }
  if (event.cold_start || event.severity === "info") return "COLD START";
  if (event.severity === "full_bust") return "FULL BUST";
  if (event.severity === "unknown") return "NO CACHE DATA";
  return event.severity.toUpperCase();
}

/** Color class for a row's pill and bar: cold starts stay neutral blue. */
export function cacheEventColorClass(event: CacheLabelFields): string {
  if (event.cold_start) return "blue";
  return severityColorClass(event.severity);
}

/**
 * A row label in sentence case for the turn list ("COLD START · RUN TOTAL"
 * reads as "Cold start · run total"), so statuses sit quietly in running text.
 */
export function sentenceCaseLabel(label: string): string {
  const lower = label.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * The `cached=` value for one row. A missing cache-read count means the
 * provider did not report reads, which is not the same as reading nothing.
 */
export function cacheReadLabel(event: Pick<DbCacheEvent, "cache_read" | "cache_reported">): string {
  return event.cache_reported ? event.cache_read.toLocaleString() : "not reported";
}

/**
 * The `new=` value for a set of rows (one step, or every step of a turn).
 * Several providers never report cache writes, and Broca then omits the
 * field; a missing count must read as "not reported", not as zero writes.
 */
export function cacheWriteLabel(
  events: readonly Pick<DbCacheEvent, "cache_write" | "cache_write_reported">[],
): string {
  const reported = events.filter((event) => event.cache_write_reported);
  if (reported.length === 0) return "not reported";
  const total = reported.reduce((sum, event) => sum + event.cache_write, 0).toLocaleString();
  return reported.length < events.length ? `${total} (partial)` : total;
}

const CACHE_CAUSE_LABELS: Record<string, string> = {
  mc_transform_failed_open: "Magic Context transform failed open",
  // Older dashboard backends may still emit this retired inference. It is not
  // evidence of a failed transform, so keep the legacy value non-alarming.
  mc_transform_missing: "No attribution recorded",
};

/**
 * Causes the backend names for a cache loss on the provider's side, on a
 * request whose prompt Magic Context recorded no change to. The idle label
 * carries the idle time ("Cache expired after 11 min idle"), so it is matched
 * by its prefix.
 */
export const PROVIDER_CACHE_MISS_CAUSE =
  "Provider cache miss (no change recorded by Magic Context)";
export const IDLE_EXPIRY_CAUSE_PREFIX = "Cache expired after ";

function isProviderSideCause(cause: string): boolean {
  return cause === PROVIDER_CACHE_MISS_CAUSE || cause.startsWith(IDLE_EXPIRY_CAUSE_PREFIX);
}

export function cacheCauseLabel(cause: string): string {
  return CACHE_CAUSE_LABELS[cause] ?? cause;
}

/** The cause line, worded the same in the Turns table and the timeline tooltip. */
export function cacheCauseText(cause: string): string {
  return `Cause: ${cacheCauseLabel(cause)}`;
}

export const UNMANAGED_DROP_TITLE = "Prompt tokens dropped";
export const UNMANAGED_DROP_DETAIL = "Magic Context does not manage this session.";
export const DROP_REQUEST_NOT_SMALLER =
  "The request did not get smaller; the provider counted fewer tokens.";
export const DROP_REQUEST_SMALLER = "The request got smaller.";

type DropFields = Pick<DbCacheEvent, "cause" | "context_reduced_by_mc" | "drop_request_size">;

/**
 * The explanation for a drop in a session Magic Context does not manage. It
 * says what the request size shows only when the source recorded the size of
 * both requests, and otherwise claims no cause.
 */
function unmanagedDropDetail(event: DropFields): string {
  if (event.drop_request_size === "not_smaller") {
    return `${UNMANAGED_DROP_DETAIL} ${DROP_REQUEST_NOT_SMALLER}`;
  }
  if (event.drop_request_size === "smaller") {
    return `${UNMANAGED_DROP_DETAIL} ${DROP_REQUEST_SMALLER}`;
  }
  return UNMANAGED_DROP_DETAIL;
}

/**
 * Title and explanation for a step whose prompt shrank (`is_drop`). Only a
 * session whose context Magic Context manages is credited with the reclaim;
 * in any other session the drop is reported without a Magic Context cause.
 */
export function cacheDropText(event: DropFields): { title: string; detail: string } {
  if (!event.context_reduced_by_mc) {
    return { title: UNMANAGED_DROP_TITLE, detail: unmanagedDropDetail(event) };
  }
  return {
    title: "Magic Context reclaimed context",
    detail: event.cause ? cacheCauseText(event.cause) : "Cause not recorded",
  };
}

/** The drop line in a timeline bar's tooltip, worded like the drop marker. */
export function cacheDropLine(event: DropFields): string {
  if (!event.context_reduced_by_mc) {
    return `⬇ ${UNMANAGED_DROP_TITLE} — ${unmanagedDropDetail(event)}`;
  }
  return `⬇ MC reclaimed context${event.cause ? ` — ${cacheCauseLabel(event.cause)}` : ""}`;
}

/**
 * CSS color variable name for a cause line. A provider-side loss is set in the
 * secondary text color so it reads as context, not as something Magic Context did.
 */
export function cacheCauseColor(cause: string): string {
  if (cause === "mc_transform_failed_open") return "red";
  return isProviderSideCause(cause) ? "text-secondary" : "amber";
}

export function cacheCauseTooltip(cause: string): string | undefined {
  if (cause === "mc_transform_failed_open") {
    return "Magic Context recorded a transform error and returned the original messages for this pass.";
  }
  if (cause === PROVIDER_CACHE_MISS_CAUSE) {
    return "The previous request read the cache moments earlier, within its lifetime. This request's prompt did not shrink and Magic Context recorded no change to it, yet the provider did not reuse its cache.";
  }
  if (cause.startsWith(IDLE_EXPIRY_CAUSE_PREFIX)) {
    return "The time since the previous request is longer than the cache lifetime, so the provider dropped the cache. Magic Context recorded no change to this request's prompt.";
  }
  return undefined;
}

// Collapse ESTIMATED (max-prompt fallback) context limits to a single stable
// value per session, so the timeline doesn't fragment into one box per step.
//
// Why: when the plugin never recorded a real limit for a session (e.g. an
// untracked subagent worktree), the backend falls back to the session's
// max-prompt — but that's computed over whatever event batch reached it, so on
// the live incremental (since-based) fetch it CLIMBS as the session grows (85k →
// 86k → … → 95k). segmentByContextLimit then starts a new segment on every step.
//
// Fix: per session, take the MAX estimated limit across the rendered window and
// stamp it on every estimated event of that session. The window's largest prompt
// becomes the stable scale; bars read as a consistent fill instead of all ~100%.
// Recorded limits (context_limit_estimated=false) are left untouched, so a
// genuine mid-session model switch still segments correctly.
//
// Returns a new array (does not mutate the inputs); only estimated events are
// rewritten, and only their `context_limit`.
export function normalizeEstimatedContextLimits(events: DbCacheEvent[]): DbCacheEvent[] {
  const maxEstimatedBySession = new Map<string, number>();
  for (const e of events) {
    if (!e.context_limit_estimated) continue;
    const key = `${e.harness}:${e.session_id}`;
    const prev = maxEstimatedBySession.get(key) ?? 0;
    if (e.context_limit > prev) maxEstimatedBySession.set(key, e.context_limit);
  }
  if (maxEstimatedBySession.size === 0) return events;
  return events.map((e) => {
    if (!e.context_limit_estimated) return e;
    const stable = maxEstimatedBySession.get(`${e.harness}:${e.session_id}`) ?? e.context_limit;
    return stable === e.context_limit ? e : { ...e, context_limit: stable };
  });
}

// Context-scaled timeline-bar geometry:
//   outer height = prompt / axis top        (the axis defaults to the context window)
//   inner segment = cache_read / prompt       (the cached, cheap portion)
//   overflow      = prompt exceeded the window (pinned at 100%)
export function ctxBarGeom(event: DbCacheEvent, axisMax?: number) {
  const prompt = event.cache_read + event.cache_write + event.input_tokens;
  const limit = event.context_limit > 0 ? event.context_limit : prompt;
  const scale = axisMax && axisMax > 0 ? axisMax : limit;
  const outer = scale > 0 ? prompt / scale : 0;
  const inner = prompt > 0 ? event.cache_read / prompt : 0;
  return {
    prompt,
    limit,
    overflow: limit > 0 && prompt > limit,
    outerPct: Math.min(100, Math.max(2, outer * 100)),
    innerPct: Math.min(100, Math.max(0, inner * 100)),
  };
}

/** Rounds a token count up to a readable axis top (1, 1.5, 2, 2.5, 3, 4, 5, 6, 8 × 10ⁿ). */
export function niceTokenCeil(n: number): number {
  if (n <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(n));
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (step * magnitude >= n) return step * magnitude;
  }
  return 10 * magnitude;
}

// Once a segment's largest prompt plus headroom reaches this share of its
// window, the axis shows the whole window instead of the session's own range.
const WINDOW_SNAP = 0.75;

export interface TimelineAxis {
  /** Token count at the top of the chart. */
  max: number;
  /** True when the context window itself is the axis top (drawn as a line). */
  windowInRange: boolean;
}

/**
 * The y-axis for one context-window segment of the cache timeline. Bars are
 * scaled to the segment's own largest prompt (rounded up, with headroom) so the
 * cache pattern fills the chart even when a 219k prompt sits in a 1M window;
 * how full the window is stays visible from the axis labels, the off-scale
 * window label and the header's fill meter. When the prompts come close to the
 * window, the axis is the window and the window line sits at its top.
 */
export function timelineAxis(events: readonly DbCacheEvent[], limit: number): TimelineAxis {
  let largest = 0;
  for (const event of events) {
    largest = Math.max(largest, event.cache_read + event.cache_write + event.input_tokens);
  }
  const ranged = niceTokenCeil(largest * 1.15);
  if (limit > 0 && ranged >= limit * WINDOW_SNAP) return { max: limit, windowInRange: true };
  return { max: ranged, windowInRange: false };
}

export interface ContextFill {
  prompt: number;
  limit: number;
  ratio: number;
}

/**
 * How full the context window was at the newest step that recorded its real
 * window. Estimated windows (the session's largest prompt standing in for an
 * unrecorded limit) say nothing about fill, so they are skipped.
 */
export function latestContextFill(events: readonly DbCacheEvent[]): ContextFill | null {
  let latest: DbCacheEvent | null = null;
  for (const event of events) {
    if (event.context_limit <= 0 || event.context_limit_estimated) continue;
    if (!latest || event.timestamp >= latest.timestamp) latest = event;
  }
  if (!latest) return null;
  const prompt = latest.cache_read + latest.cache_write + latest.input_tokens;
  return { prompt, limit: latest.context_limit, ratio: prompt / latest.context_limit };
}

// Compact token label for axis ticks: 1_000_000 → "1M", 272_000 → "272k".
export function formatTokensShort(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 10 || Number.isInteger(m) ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${n}`;
}
