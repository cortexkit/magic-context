import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  formatDateTime,
  getSessionCacheEvents,
  getSessionCacheStatsFromDb,
  truncate,
} from "../../lib/api";
import {
  cacheCauseColor,
  cacheCauseLabel,
  cacheCauseTooltip,
  cacheEventColorClass,
  cacheEventLabel,
  cacheReadLabel,
  cacheWriteLabel,
  selectWorstCacheEvent,
} from "../../lib/cache-format";
import type { DbCacheEvent, Harness, SessionCacheStats } from "../../lib/types";
import HarnessBadge from "../HarnessBadge";
import CacheTimeline from "../shared/CacheTimeline";
import FilterSelect from "../shared/FilterSelect";

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

export function cachePercentage(ratio: number | null): string {
  return ratio === null ? "No cached tokens reported" : `${(ratio * 100).toFixed(1)}%`;
}

export function cacheEventPercentage(event: DbCacheEvent): string {
  if (!event.cache_reported) return "No cached tokens reported";
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

// Longest session name a card shows as-is. Longer names are shortened to
// their last meaningful part so cards stay one line; the tooltip keeps the
// full name.
const CARD_TITLE_MAX = 20;

/**
 * Short card label for a session. Names like `alfonso:consult-<uuid>` share a
 * long prefix and differ only at the end, so the label drops everything up to
 * the last `:` and, if the rest is still long, keeps its first word plus its
 * last 6 characters: `consult-…a1b2c3`.
 */
export function cacheCardTitle(row: SessionCacheStats): string {
  const full = cacheSessionTitle(row);
  if (full.length <= CARD_TITLE_MAX) return full;
  const tail = full.slice(full.lastIndexOf(":") + 1);
  if (tail.length <= CARD_TITLE_MAX) return tail;
  const head = /^[^-_]+/.exec(tail)?.[0] ?? "";
  if (head.length > 0 && head.length <= 12) return `${head}-…${tail.slice(-6)}`;
  return `${tail.slice(0, 8)}…${tail.slice(-6)}`;
}

export interface CacheCardSummary {
  text: string;
  /** "ratio" colors the text by hit ratio; "neutral" renders it muted. */
  tone: "ratio" | "neutral";
  ratio: number;
  title: string;
}

/**
 * The headline of a session card. A red percentage is reserved for sessions
 * that actually read from the cache and could have read more: a session whose
 * requests report no cache reads at all, or whose window holds only its cold
 * opening turn, is shown in a neutral color.
 */
export function cacheCardSummary(events: DbCacheEvent[]): CacheCardSummary {
  const ratio = cacheSessionRatio(events);
  if (ratio === null) {
    return {
      text: cachePercentage(null),
      tone: "neutral",
      ratio: 0,
      title: "No request in this window reported cached tokens",
    };
  }
  if (!events.some((event) => event.cache_reported && event.cache_read > 0)) {
    return {
      text: "no cache data",
      tone: "neutral",
      ratio,
      title: "No request in this window read anything from the cache",
    };
  }
  const turns = new Set(events.map((event) => event.turn_id));
  if (turns.size === 1 && events.some((event) => event.cold_start)) {
    return {
      text: cachePercentage(ratio),
      tone: "neutral",
      ratio,
      title: "Only the session's cold first run is loaded: nothing was cached before it",
    };
  }
  return {
    text: cachePercentage(ratio),
    tone: "ratio",
    ratio,
    title: "Cache reads over total prompt tokens in this window",
  };
}

/** "1 run" / "3 runs" when every row is a Broca run total, else events. */
export function cacheCardCountLabel(events: DbCacheEvent[]): string {
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
type CacheSessionStats = SessionCacheStats;
type SelectedSession = { harness: Harness; sessionId: string };

// Per-session event WINDOW: the most-recent ≤N events for one session, kept in
// memory and grown incrementally. Cards derive their stats (ratio / busts /
// count) from this session's OWN window — never a shared global pool — so the
// numbers are per-session-correct and don't shift with other sessions' activity.
interface SessionWindow {
  harness: Harness;
  sessionId: string;
  events: DbCacheEvent[]; // chronological, trimmed to the window size
  lastSeen: number; // max event timestamp held (0 = empty); incremental anchor
  lastActivityMs: number; // session.last_activity_ms at last fetch (change gate)
}

// Module-level state — survives component unmount/remount so a return to the
// page rehydrates instantly. Keyed by `${harness}:${sessionId}`.
const cachedWindows = new Map<string, SessionWindow>();
let cachedSessions: CacheSessionStats[] = []; // titles + subagent flags + recency
let cachedSelectedSession: SelectedSession | null = null;
// How many recent sessions to surface as cards. 10 (not 5) fills wide screens.
const RECENT_SESSIONS_LIMIT = 10;
const CACHE_STATS_FETCH_LIMIT = 50;
const SHOW_UNMANAGED_STORAGE_KEY = "mc_cache_show_unmanaged";

const windowKey = (harness: Harness, sessionId: string) => `${harness}:${sessionId}`;

function loadShowUnmanagedPreference(): boolean {
  try {
    return localStorage.getItem(SHOW_UNMANAGED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function isManagedFilterableHarness(harness: Harness): boolean {
  return harness === "claude_code" || harness === "codex" || harness === "broca";
}

export default function CacheDiagnostics() {
  // The session windows live in a module-level Map (mutated in place during
  // incremental polls); `windowsVersion` is bumped on every change so the
  // derived memos (cards + chart) re-run. This avoids re-allocating the whole
  // window array each tick just to trip reactivity.
  const [windowsVersion, setWindowsVersion] = createSignal(0);
  const bumpWindows = () => setWindowsVersion((v) => v + 1);
  const [sessionNames, setSessionNames] = createSignal<Record<string, string>>({});
  const [activityNote, setActivityNote] = createSignal<string | null>(
    cacheActivityNote(cachedSessions),
  );
  const [loading, setLoading] = createSignal(cachedWindows.size === 0);
  const [paused, setPaused] = createSignal(false);
  const [selectedSession, setSelectedSession] = createSignal<SelectedSession | null>(
    cachedSelectedSession,
  );
  const [harnessFilter, setHarnessFilter] = createSignal<HarnessFilter>("all");
  const [hideSubagents, setHideSubagents] = createSignal(true);
  const [showUnmanagedSessions, setShowUnmanagedSessionsSignal] = createSignal(
    loadShowUnmanagedPreference(),
  );
  const [expandedTurns, setExpandedTurns] = createSignal<Set<string>>(new Set());
  // Window size = how many recent events to keep per session (the picker). Drives
  // both the per-session card stats and the selected session's chart/list.
  const [timelineLimit, setTimelineLimit] = createSignal(200);
  // The step message_id selected by clicking a timeline bar — used to outline
  // the bar and briefly highlight the matching list row after scrolling to it.
  const [selectedStepId, setSelectedStepId] = createSignal<string | null>(null);

  // The Recent Sessions strip is a single non-wrapping row of equal-width cards.
  // How many cards fit is measured from the row's width against a min card width,
  // capped at the number of windows we keep — so the strip never wraps and never
  // shows a card narrower than CARD_MIN_WIDTH.
  const CARD_MIN_WIDTH = 180;
  const CARD_GAP = 8;
  const [cardRowWidth, setCardRowWidth] = createSignal(0);
  const visibleCardCount = createMemo(() => {
    const w = cardRowWidth();
    if (w <= 0) return RECENT_SESSIONS_LIMIT; // pre-measure: assume all fit
    const fit = Math.floor((w + CARD_GAP) / (CARD_MIN_WIDTH + CARD_GAP));
    return Math.max(1, Math.min(RECENT_SESSIONS_LIMIT, fit));
  });
  const measureCardRow = (el: HTMLDivElement) => {
    setCardRowWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? el.clientWidth;
      setCardRowWidth(width);
    });
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  };

  // Click a timeline bar → expand its turn (if multi-step) and scroll the
  // matching list row into view. Expansion mutates the DOM, so scroll on the
  // next frame once the step row has rendered.
  const focusStepInList = (event: DbCacheEvent) => {
    setSelectedStepId(event.message_id);
    setExpandedTurns((prev) => {
      const next = new Set(prev);
      next.add(event.turn_id);
      return next;
    });
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const stepEl = document.getElementById(`cache-step-${event.message_id}`);
        const target = stepEl ?? document.getElementById(`cache-turn-${event.turn_id}`);
        target?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    });
  };

  interface CacheTurn {
    turnId: string;
    sessionId: string;
    harness: Harness;
    startTime: number;
    endTime: number;
    events: DbCacheEvent[];
    totalCacheWrite: number;
    firstCacheRead: number;
    lastCacheRead: number;
    worstSeverity: DbCacheEvent["severity"];
    worstEvent: DbCacheEvent;
    totalInputTokens: number;
    agent: string | null;
  }

  // The per-session window size (the picker). Each session keeps its most-recent
  // ≤N events; cards aggregate over that window and the chart shows the selected
  // session's window.
  const windowSize = () => timelineLimit();
  const loadSessionRows = () => {
    const harness = harnessFilter();
    return getSessionCacheStatsFromDb(
      CACHE_STATS_FETCH_LIMIT,
      showUnmanagedSessions(),
      hideSubagents(),
      harness === "all" ? undefined : harness,
    );
  };

  const applySessionMeta = (sessions: CacheSessionStats[]) => {
    cachedSessions = sessions;
    const names: Record<string, string> = {};
    for (const s of sessions) {
      const key = windowKey(s.harness, s.session_id);
      if (s.title) names[key] = s.title;
    }
    setSessionNames(names);
    setActivityNote(cacheActivityNote(sessions));
  };

  // The recent sessions we keep windows for: top-N by activity, non-subagent
  // (unless the user toggled them on), plus the selected session even if it has
  // aged out of the top-N so its chart stays live.
  const recentSessionRows = (sessions: CacheSessionStats[]): CacheSessionStats[] => {
    const managedFiltered = showUnmanagedSessions()
      ? sessions
      : sessions.filter((s) => !isManagedFilterableHarness(s.harness) || s.managed);
    const want = hideSubagents() ? managedFiltered.filter((s) => !s.is_subagent) : managedFiltered;
    const top = want.slice(0, RECENT_SESSIONS_LIMIT);
    const sel = cachedSelectedSession;
    if (sel && !top.some((s) => s.harness === sel.harness && s.session_id === sel.sessionId)) {
      const selRow = sessions.find(
        (s) => s.harness === sel.harness && s.session_id === sel.sessionId,
      );
      if (selRow) top.push(selRow);
    }
    return top;
  };

  // Full window load for one session: the most-recent N events, replacing any
  // prior window. Used on initial load, for a newly-surfaced session, and after
  // a window-size change.
  const loadFullWindow = async (row: CacheSessionStats) => {
    const events = await getSessionCacheEvents(row.harness, row.session_id, windowSize());
    const key = windowKey(row.harness, row.session_id);
    cachedWindows.set(key, {
      harness: row.harness,
      sessionId: row.session_id,
      events,
      lastSeen: events.length > 0 ? events[events.length - 1].timestamp : 0,
      lastActivityMs: row.last_activity_ms,
    });
  };

  // Incremental update for an already-windowed session: fetch only events at/
  // after the window's anchor (>= lastSeen, a 1-event overlap so the first new
  // event's cross-step severity is computed correctly), dedupe the overlap by
  // message_id, append, and trim to the last N. No-op when nothing is new.
  const updateWindowIncremental = async (win: SessionWindow, row: CacheSessionStats) => {
    const fresh = await getSessionCacheEvents(
      win.harness,
      win.sessionId,
      undefined,
      win.lastSeen || null,
    );
    const have = new Set(win.events.map((e) => e.message_id));
    const added = fresh.filter((e) => !have.has(e.message_id));
    win.lastActivityMs = row.last_activity_ms;
    if (added.length === 0) return false;
    const n = windowSize();
    const merged = [...win.events, ...added];
    win.events = merged.length > n ? merged.slice(-n) : merged;
    win.lastSeen = win.events[win.events.length - 1].timestamp;
    return true;
  };

  // One reconciliation pass: re-list sessions, ensure a window exists for each
  // recent session (full load if new, incremental if its activity advanced,
  // skip if unchanged), and evict windows that fell out of the recent set.
  const reconcile = async () => {
    const sessions = await loadSessionRows();
    applySessionMeta(sessions);
    const recent = recentSessionRows(sessions);
    const recentKeys = new Set(recent.map((s) => windowKey(s.harness, s.session_id)));

    const selected = selectedSession();
    if (
      selected &&
      !sessions.some((s) => s.harness === selected.harness && s.session_id === selected.sessionId)
    ) {
      const top = recent.find((s) => !s.is_subagent) ?? recent[0];
      selectSession(top ? { harness: top.harness, sessionId: top.session_id } : null);
    }

    let changed = false;
    for (const row of recent) {
      const key = windowKey(row.harness, row.session_id);
      const win = cachedWindows.get(key);
      if (!win) {
        await loadFullWindow(row);
        changed = true;
      } else if (row.last_activity_ms > win.lastActivityMs) {
        if (await updateWindowIncremental(win, row)) changed = true;
      }
    }
    // Evict windows no longer in the recent set (keep memory bounded).
    for (const key of [...cachedWindows.keys()]) {
      if (!recentKeys.has(key)) cachedWindows.delete(key);
    }
    if (changed) bumpWindows();
  };

  // Reload every window fresh at the current size — used after a window-size
  // change (no backward-fill: just re-fetch the larger/smaller window).
  const reloadAllWindows = async () => {
    const rows = recentSessionRows(cachedSessions);
    await Promise.all(rows.map((row) => loadFullWindow(row)));
    bumpWindows();
  };

  const resolveTitle = (harness: Harness, sessionId: string) =>
    sessionNames()[`${harness}:${sessionId}`] || truncate(sessionId, 16);

  onMount(async () => {
    // Remount fast path: rehydrate from the module-level windows synchronously.
    if (cachedWindows.size > 0) {
      applySessionMeta(cachedSessions);
      setSelectedSession(cachedSelectedSession);
      bumpWindows();
      setLoading(false);
      return;
    }
    // Cold start: list sessions, load each recent session's full window, and
    // default the selection to the most-recent non-subagent session.
    try {
      const sessions = await loadSessionRows();
      applySessionMeta(sessions);
      const recent = recentSessionRows(sessions);
      if (!cachedSelectedSession) {
        const top = recent.find((s) => !s.is_subagent) ?? recent[0];
        if (top) {
          const key: SelectedSession = { harness: top.harness, sessionId: top.session_id };
          setSelectedSession(key);
          cachedSelectedSession = key;
        }
      }
      await Promise.all(recent.map((row) => loadFullWindow(row)));
      bumpWindows();
    } catch {
      // Transient; the poll retries.
    } finally {
      setLoading(false);
    }
  });

  // Single 1s reconciliation loop: cheap cache-stats re-list + incremental
  // per-session fetches (only for sessions whose activity advanced). In-flight
  // latched so a slow pass can't stack.
  let reconcileInFlight = false;
  const tick = async () => {
    if (paused() || reconcileInFlight) return;
    reconcileInFlight = true;
    try {
      await reconcile();
    } catch {
      // Transient (DB lock / IPC); next tick retries.
    } finally {
      reconcileInFlight = false;
    }
  };
  const tickInterval = setInterval(() => void tick(), 1000);
  onCleanup(() => clearInterval(tickInterval));

  // Selection helper. Ensures the newly-selected session has a window (loads it
  // immediately if not already held) so its chart appears without a poll lag.
  const selectSession = (next: SelectedSession | null) => {
    setSelectedSession(next);
    cachedSelectedSession = next;
    if (next && !cachedWindows.has(windowKey(next.harness, next.sessionId))) {
      const row = cachedSessions.find(
        (s) => s.harness === next.harness && s.session_id === next.sessionId,
      );
      if (row) void loadFullWindow(row).then(bumpWindows);
    }
  };

  const setShowUnmanagedSessions = (value: boolean) => {
    setShowUnmanagedSessionsSignal(value);
    try {
      value
        ? localStorage.setItem(SHOW_UNMANAGED_STORAGE_KEY, "true")
        : localStorage.removeItem(SHOW_UNMANAGED_STORAGE_KEY);
    } catch {}
    cachedWindows.clear();
    cachedSessions = [];
    cachedSelectedSession = null;
    setSelectedSession(null);
    setLoading(true);
    void reconcile().finally(() => setLoading(false));
  };

  // Cards: per-session stats aggregated over each session's OWN window (never a
  // shared global pool), ordered by the cache stats recency. Reading
  // windowsVersion() makes this re-run when any window changes.
  type CacheCardRow = CacheSessionStats & { summary: CacheCardSummary; countLabel: string };
  const filteredStats = (): CacheCardRow[] => {
    windowsVersion();
    const harness = harnessFilter();
    const rows: CacheCardRow[] = [];
    for (const s of cachedSessions) {
      if (!cacheSessionVisible(s, harness, showUnmanagedSessions(), hideSubagents())) continue;
      const win = cachedWindows.get(windowKey(s.harness, s.session_id));
      if (!win) continue;
      let read = 0;
      let write = 0;
      let input = 0;
      let busts = 0;
      let lastTs = 0;
      for (const e of win.events) {
        read += e.cache_read;
        write += e.cache_write;
        input += e.input_tokens;
        if (e.severity === "bust" || e.severity === "full_bust") busts++;
        if (e.timestamp > lastTs) lastTs = e.timestamp;
      }
      const summary = cacheCardSummary(win.events);
      rows.push({
        harness: s.harness,
        session_id: s.session_id,
        event_count: win.events.length,
        total_cache_read: read,
        total_cache_write: write,
        total_input: input,
        hit_ratio: summary.ratio,
        summary,
        countLabel: cacheCardCountLabel(win.events),
        last_timestamp: new Date(lastTs).toISOString(),
        last_activity_ms: lastTs,
        bust_count: busts,
        managed: s.managed,
        is_subagent: s.is_subagent,
        title: s.title,
      });
    }
    // Render only as many cards as fit one non-wrapping row at CARD_MIN_WIDTH.
    return rows.slice(0, visibleCardCount());
  };

  // Chart/list events: the selected session's window. There is no combined /
  // merged "all sessions" view: a session is always selected (cards select,
  // never deselect), so an empty result only occurs in the brief pre-selection
  // window on cold start. Reading windowsVersion() ties the downstream memos to
  // window mutations.
  const filteredEvents = () => {
    windowsVersion();
    const selected = selectedSession();
    if (!selected) return [];
    const win = cachedWindows.get(windowKey(selected.harness, selected.sessionId));
    return win ? win.events : [];
  };

  // Per-step events for the Cache Hit Timeline bars, oldest→newest so the
  // chart reads left-to-right chronologically. One bar per API round-trip
  // (step) so mid-turn busts are individually visible instead of being
  // absorbed into a turn's final-step hit ratio. Capped to the most-recent
  // `timelineLimit` steps (the chart's right edge is "now"), so a long session
  // shows a readable window instead of 1000+ hairline bars.
  const sortedTimelineEvents = createMemo(() =>
    [...filteredEvents()].sort((a, b) => a.timestamp - b.timestamp),
  );
  const totalTimelineSteps = createMemo(() => sortedTimelineEvents().length);
  const timelineEvents = createMemo(() => {
    const all = sortedTimelineEvents();
    const limit = timelineLimit();
    return all.length > limit ? all.slice(-limit) : all;
  });

  const cacheTurns = createMemo(() => {
    const turns: CacheTurn[] = [];
    const map = new Map<string, CacheTurn>();
    for (const event of filteredEvents()) {
      let turn = map.get(event.turn_id);
      if (!turn) {
        turn = {
          turnId: event.turn_id,
          sessionId: event.session_id,
          harness: event.harness,
          startTime: event.timestamp,
          endTime: event.timestamp,
          events: [],
          totalCacheWrite: 0,
          firstCacheRead: event.cache_read,
          lastCacheRead: event.cache_read,
          worstSeverity: event.severity,
          worstEvent: event,
          totalInputTokens: 0,
          agent: event.agent,
        };
        map.set(event.turn_id, turn);
        turns.push(turn);
      }
      turn.events.push(event);
      turn.endTime = Math.max(turn.endTime, event.timestamp);
      turn.totalCacheWrite += event.cache_write;
      turn.lastCacheRead = event.cache_read;
      turn.totalInputTokens += event.input_tokens;
    }
    for (const turn of turns) {
      const worstEvent = selectWorstCacheEvent(turn.events);
      if (worstEvent) {
        turn.worstSeverity = worstEvent.severity;
        turn.worstEvent = worstEvent;
      }
    }
    // Sort by start time descending (newest first) so the list is chronological
    // when reversed below, matching the original event order.
    return turns.sort((a, b) => a.startTime - b.startTime);
  });

  const toggleTurn = (turnId: string) => {
    setExpandedTurns((prev) => {
      const next = new Set(prev);
      if (next.has(turnId)) {
        next.delete(turnId);
      } else {
        next.add(turnId);
      }
      return next;
    });
  };

  const severityIcon = (event: Pick<DbCacheEvent, "severity" | "cold_start">) => {
    if (event.cold_start) return "🔵";
    switch (event.severity) {
      case "stable":
        return "🟢";
      case "info":
        return "🔵";
      case "warning":
        return "🟡";
      case "warming":
        return "⚪";
      case "bust":
        return "🔴";
      case "full_bust":
        return "⚫";
      case "unknown":
      case "aggregate":
        return "⚪";
      default:
        return "⚪";
    }
  };

  // Map a severity string to a bar/pill color class. Severity is the source of
  // truth — list pills + bar-fills use the shared cacheEventColorClass.

  // Bar-fill WIDTH for the turn/step list rows scales with retention (hit_ratio
  // now carries the cross-step retention), clamped to [0,1].
  const barFraction = (event: {
    severity: string;
    hit_ratio: number;
    cold_start: boolean;
  }): number => {
    if (event.severity === "unknown" || event.severity === "info" || event.cold_start) return 1;
    return Math.min(1, Math.max(0, event.hit_ratio));
  };

  // For the SESSION-aggregate strip only: stat.hit_ratio is an overall
  // read/total efficiency number (not a per-step health classification), so a
  // simple threshold color is appropriate there.
  const hitColor = (ratio: number) =>
    ratio >= 0.9 ? "var(--green)" : ratio >= 0.5 ? "var(--amber)" : "var(--red)";

  return (
    <>
      <div class="section-header">
        <h1 class="section-title">Cache Diagnostics</h1>
        <div class="section-actions" style={{ "align-items": "center" }}>
          <FilterSelect
            value={String(timelineLimit())}
            onChange={(value) => {
              setTimelineLimit(Number(value));
              // Window size is the per-session event bound — reload every window
              // fresh at the new size (no backward-fill).
              void reloadAllWindows();
            }}
            placeholder="Recent"
            options={[
              { value: "200", label: "Recent: 200" },
              { value: "400", label: "Recent: 400" },
              { value: "600", label: "Recent: 600" },
              { value: "800", label: "Recent: 800" },
              { value: "1000", label: "Recent: 1000" },
            ]}
          />
          <FilterSelect
            value={harnessFilter()}
            onChange={(value) => {
              const harness = value as HarnessFilter;
              setHarnessFilter(harness);
              // Keep a session selected (no combined view): if the current
              // selection no longer matches the harness filter, re-select the
              // top card of the filtered set.
              const sel = selectedSession();
              if (sel && harness !== "all" && sel.harness !== harness) {
                const top = filteredStats()[0];
                selectSession(top ? { harness: top.harness, sessionId: top.session_id } : null);
              }
              void reconcile();
            }}
            placeholder="Harness"
            options={cacheHarnessOptions}
          />
          {/* padding matches .fsel-trigger (6px 10px) so the buttons and the two
              pickers render at identical heights in this toolbar. */}
          <button
            type="button"
            class={`btn ${showUnmanagedSessions() ? "primary" : ""}`}
            style={{ padding: "6px 10px" }}
            onClick={() => setShowUnmanagedSessions(!showUnmanagedSessions())}
          >
            {showUnmanagedSessions() ? "Hide unmanaged" : "Show unmanaged"}
          </button>
          <button
            type="button"
            class={`btn ${!hideSubagents() ? "primary" : ""}`}
            style={{ padding: "6px 10px" }}
            onClick={() => {
              setHideSubagents(!hideSubagents());
              void reconcile();
            }}
          >
            {hideSubagents() ? "Show subagents" : "Hide subagents"}
          </button>
          <button
            type="button"
            class={`btn ${paused() ? "primary" : ""}`}
            style={{ padding: "6px 10px" }}
            onClick={() => setPaused(!paused())}
          >
            {paused() ? "▶ Resume" : "⏸ Pause"}
          </button>
          <Show when={!paused()}>
            <span
              style={{
                color: "var(--green)",
                "font-size": "12px",
                display: "inline-flex",
                "align-items": "center",
                "margin-left": "4px",
              }}
            >
              ● Live
            </span>
          </Show>
        </div>
      </div>

      {/* Session cards */}
      <div style={{ padding: "0 20px 12px" }}>
        <Show when={activityNote()}>
          {(note) => (
            <div style={{ "font-size": "11px", color: "var(--amber)", "margin-bottom": "8px" }}>
              {note()}
            </div>
          )}
        </Show>
        <Show when={filteredStats().length > 0}>
          <div
            style={{ "font-size": "11px", color: "var(--text-secondary)", "margin-bottom": "8px" }}
          >
            Recent Sessions
          </div>
          <div
            ref={measureCardRow}
            style={{ display: "flex", gap: `${CARD_GAP}px`, "flex-wrap": "nowrap" }}
          >
            <For each={filteredStats()}>
              {(stat) => {
                const isActive = () => {
                  const selected = selectedSession();
                  return (
                    selected?.sessionId === stat.session_id && selected.harness === stat.harness
                  );
                };
                return (
                  <button
                    type="button"
                    class="card"
                    style={{
                      cursor: "pointer",
                      // Equal width: every card flexes from a 0 basis so they
                      // share the row evenly; min-width gates how many fit (the
                      // count is computed from the row width, so they never wrap).
                      flex: "1 1 0",
                      "min-width": "0",
                      "border-color": isActive() ? "var(--accent)" : undefined,
                      "text-align": "left",
                    }}
                    onClick={() => {
                      // Select-only: clicking a card focuses that session's
                      // window. Clicking the already-active card is a no-op
                      // (there is no combined/merged view to toggle back to).
                      if (!isActive()) {
                        selectSession({ harness: stat.harness, sessionId: stat.session_id });
                      }
                    }}
                  >
                    <div
                      title={cacheSessionTitle(stat)}
                      style={{
                        "font-size": "11px",
                        color: "var(--text-muted)",
                        "margin-bottom": "4px",
                        overflow: "hidden",
                        "text-overflow": "ellipsis",
                        "white-space": "nowrap",
                      }}
                    >
                      <span style={{ display: "inline-flex", "align-items": "center", gap: "6px" }}>
                        <HarnessBadge harness={stat.harness} />
                        <Show when={isManagedFilterableHarness(stat.harness) && stat.managed}>
                          <span
                            class="pill blue"
                            style={{ "font-size": "9px", "line-height": "1.3" }}
                          >
                            Managed
                          </span>
                        </Show>
                        <span>{cacheCardTitle(stat)}</span>
                      </span>
                    </div>
                    <div
                      title={stat.summary.title}
                      style={{
                        "font-size": "20px",
                        "font-weight": "700",
                        color:
                          stat.summary.tone === "neutral"
                            ? "var(--text-muted)"
                            : hitColor(stat.summary.ratio),
                        "font-family": "var(--mono-font)",
                      }}
                    >
                      {stat.summary.text}
                    </div>
                    <div class="card-meta" style={{ "margin-top": "4px" }}>
                      <span>{stat.countLabel}</span>
                      <Show when={stat.bust_count > 0}>
                        <span style={{ color: "var(--red)" }}>{stat.bust_count} busts</span>
                      </Show>
                    </div>
                  </button>
                );
              }}
            </For>
          </div>
        </Show>
      </div>

      {/* Chart */}
      <div style={{ padding: "0 20px 12px" }}>
        <Show when={filteredEvents().length > 0}>
          <div class="chart-container">
            <div
              style={{
                "font-size": "11px",
                color: "var(--text-secondary)",
                "margin-bottom": "8px",
                display: "flex",
                "justify-content": "space-between",
              }}
            >
              <span style={{ display: "inline-flex", "align-items": "center", gap: "6px" }}>
                <Show when={selectedSession()}>
                  {(selected) => <HarnessBadge harness={selected().harness} />}
                </Show>
                Cache Hit Timeline
              </span>
              <span>
                {totalTimelineSteps() > timelineEvents().length
                  ? `last ${timelineEvents().length} of ${totalTimelineSteps()} steps`
                  : `${timelineEvents().length} steps`}
              </span>
            </div>
            {/* The session line sits on its own row under the title rather than
                beside it: long names (Broca's especially) then wrap across the
                chart's full width instead of squeezing the step count. */}
            <Show when={selectedSession()}>
              {(selected) => {
                const header = () =>
                  cacheSessionHeader(
                    selected().harness,
                    selected().sessionId,
                    sessionNames()[windowKey(selected().harness, selected().sessionId)],
                  );
                const models = () => sessionModelSummary(filteredEvents());
                return (
                  <div
                    style={{
                      display: "flex",
                      "flex-wrap": "wrap",
                      "align-items": "baseline",
                      gap: "4px 12px",
                      "font-size": "12px",
                      "margin-bottom": "8px",
                    }}
                  >
                    <span
                      class="mono"
                      title={header().tooltip}
                      style={{
                        color: "var(--text-primary)",
                        "font-weight": "600",
                        "overflow-wrap": "anywhere",
                        "min-width": "0",
                      }}
                    >
                      {header().name}
                    </span>
                    <Show when={header().innerHarness}>
                      {(inner) => (
                        <span style={{ color: "var(--text-secondary)" }}>via {inner()}</span>
                      )}
                    </Show>
                    <Show when={models()}>
                      {(summary) => (
                        <span
                          class="mono"
                          style={{ color: "var(--text-secondary)" }}
                          title={summary().all.join("\n")}
                        >
                          {summary().provider ? `${summary().provider} · ` : ""}
                          {sessionModelLabel(summary())}
                        </span>
                      )}
                    </Show>
                  </div>
                );
              }}
            </Show>
            <CacheTimeline
              events={timelineEvents()}
              selectedStepId={selectedStepId()}
              onBarClick={focusStepInList}
            />
          </div>
        </Show>
      </div>

      {/* Event log */}
      <div class="scroll-area">
        <Show when={!loading()} fallback={<div class="empty-state">Loading cache events...</div>}>
          <Show
            when={cacheTurns().length > 0}
            fallback={
              <div class="empty-state">
                <span class="empty-state-icon">📊</span>
                <span>No cache events found</span>
                <span style={{ "font-size": "11px" }}>
                  Cache data is read from OpenCode, Pi, Claude Code, and Codex sessions
                </span>
              </div>
            }
          >
            <div class="list-gap">
              <For each={[...cacheTurns()].reverse()}>
                {(turn) => {
                  // Parent stats reflect the turn's FINAL step (the prompt that
                  // actually shipped), not an aggregate across steps. Aggregation
                  // double-counts a bust child and produces nonsense like
                  // prompt=823k for a 540k actual turn (see fix in chart-bar above).
                  const last = turn.events[turn.events.length - 1];
                  const worstCause = turn.worstEvent.cause;
                  const isExpanded = () => expandedTurns().has(turn.turnId);
                  const totalPrompt = last.cache_read + last.cache_write + last.input_tokens;
                  // Retention of the turn's final (shipped) step — hit_ratio now
                  // carries the cross-step retention computed in the backend.
                  const turnRetention = last.hit_ratio;
                  const unreportedTurn = !last.cache_reported;
                  const isMultiStep = turn.events.length > 1;
                  // Only multi-step turns are expandable. Interactive rows get a real
                  // button role + keyboard activation; single-step rows are purely
                  // presentational with no handlers at all.
                  const interactiveProps = isMultiStep
                    ? {
                        role: "button" as const,
                        tabindex: 0,
                        onClick: () => toggleTurn(turn.turnId),
                        onKeyDown: (e: KeyboardEvent) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            toggleTurn(turn.turnId);
                          }
                        },
                      }
                    : {};
                  return (
                    <div
                      id={`cache-turn-${turn.turnId}`}
                      class="card cache-turn-row"
                      {...interactiveProps}
                      style={{ cursor: isMultiStep ? "pointer" : "default" }}
                    >
                      <div
                        style={{
                          display: "flex",
                          "align-items": "center",
                          gap: "8px",
                          "margin-bottom": "4px",
                          "min-width": "0",
                        }}
                      >
                        <span style={{ "flex-shrink": "0" }}>{severityIcon(turn.worstEvent)}</span>
                        <span style={{ "flex-shrink": "0", display: "inline-flex" }}>
                          <HarnessBadge harness={turn.harness} />
                        </span>
                        <span
                          class="mono"
                          style={{
                            "font-size": "11px",
                            color: "var(--text-secondary)",
                            "flex-shrink": "0",
                          }}
                        >
                          {formatDateTime(turn.startTime)}
                        </span>
                        <span
                          class={`pill ${cacheEventColorClass(turn.worstEvent)}`}
                          style={{ "flex-shrink": "0" }}
                        >
                          {cacheEventLabel(turn.worstEvent)}
                        </span>
                        <Show when={isMultiStep}>
                          <span class="pill gray" style={{ "flex-shrink": "0" }}>
                            {isExpanded() ? "▾" : "▸"} {turn.events.length} steps
                          </span>
                        </Show>
                        <span
                          class="mono"
                          style={{
                            "font-size": "10px",
                            color: "var(--text-muted)",
                            "min-width": "0",
                            overflow: "hidden",
                            "text-overflow": "ellipsis",
                            "white-space": "nowrap",
                            flex: "1 1 auto",
                          }}
                          title={resolveTitle(turn.harness, turn.sessionId)}
                        >
                          {resolveTitle(turn.harness, turn.sessionId)}
                        </span>
                      </div>
                      <div class="card-meta" style={{ gap: "12px" }}>
                        <Show
                          when={turn.worstSeverity !== "unknown" && !unreportedTurn}
                          fallback={
                            <span class="mono" style={{ color: "var(--text-muted)" }}>
                              {unreportedTurn ? "No cached tokens reported" : "no cache data"}
                            </span>
                          }
                        >
                          <span
                            class="mono"
                            style={{
                              color: `var(--${cacheEventColorClass(turn.worstEvent)})`,
                              "font-weight": "600",
                            }}
                            title={cacheRatioTitle(last)}
                          >
                            {(turnRetention * 100).toFixed(1)}%
                          </span>
                        </Show>
                        <span class="mono">prompt={totalPrompt.toLocaleString()}</span>
                        <span class="mono">cached={cacheReadLabel(last)}</span>
                        <span class="mono">new={cacheWriteLabel(turn.events)}</span>
                        <div class="cache-bar">
                          <div
                            class={`cache-bar-fill ${cacheEventColorClass(turn.worstEvent)}`}
                            style={{
                              width: `${barFraction({ severity: turn.worstSeverity, hit_ratio: turnRetention, cold_start: turn.worstEvent.cold_start }) * 100}%`,
                            }}
                          />
                        </div>
                      </div>
                      <Show when={worstCause}>
                        {(cause) => (
                          <div
                            style={{
                              "margin-top": "6px",
                              "font-size": "11px",
                              color: `var(--${cacheCauseColor(cause())})`,
                            }}
                            title={cacheCauseTooltip(cause())}
                          >
                            Cause: {cacheCauseLabel(cause())}
                          </div>
                        )}
                      </Show>
                      <Show when={isExpanded()}>
                        <div class="cache-turn-expanded">
                          {/* Newest-step first inside the drill-down so the user
                              reads top-to-bottom matching the outer recent-turn
                              ordering (which is also newest-first). */}
                          <For each={[...turn.events].reverse()}>
                            {(event) => {
                              const evTotalPrompt =
                                event.cache_read + event.cache_write + event.input_tokens;
                              return (
                                <div
                                  id={`cache-step-${event.message_id}`}
                                  class={`cache-step-row ${selectedStepId() === event.message_id ? "selected" : ""}`}
                                >
                                  <div class="cache-step-header">
                                    <span style={{ "flex-shrink": "0" }}>
                                      {severityIcon(event)}
                                    </span>
                                    <span
                                      class="mono"
                                      style={{
                                        "font-size": "11px",
                                        color: "var(--text-secondary)",
                                        "flex-shrink": "0",
                                      }}
                                    >
                                      {formatDateTime(event.timestamp)}
                                    </span>
                                    <span
                                      class={`pill ${cacheEventColorClass(event)}`}
                                      style={{ "flex-shrink": "0" }}
                                    >
                                      {cacheEventLabel(event)}
                                    </span>
                                  </div>
                                  <div class="cache-step-meta">
                                    <Show
                                      when={event.severity !== "unknown" && event.cache_reported}
                                      fallback={
                                        <span class="mono" style={{ color: "var(--text-muted)" }}>
                                          {cacheEventPercentage(event)}
                                        </span>
                                      }
                                    >
                                      <span
                                        class="mono"
                                        style={{
                                          color: `var(--${cacheEventColorClass(event)})`,
                                          "font-weight": "600",
                                        }}
                                        title={cacheRatioTitle(event)}
                                      >
                                        {cacheEventPercentage(event)}
                                      </span>
                                    </Show>
                                    <span class="mono">
                                      prompt={evTotalPrompt.toLocaleString()}
                                    </span>
                                    <span class="mono">cached={cacheReadLabel(event)}</span>
                                    <span class="mono">new={cacheWriteLabel([event])}</span>
                                    <div class="cache-bar">
                                      <div
                                        class={`cache-bar-fill ${cacheEventColorClass(event)}`}
                                        style={{ width: `${barFraction(event) * 100}%` }}
                                      />
                                    </div>
                                  </div>
                                  <Show when={event.cause}>
                                    {(cause) => (
                                      <div
                                        style={{
                                          "margin-top": "4px",
                                          "font-size": "11px",
                                          color: `var(--${cacheCauseColor(cause())})`,
                                        }}
                                        title={cacheCauseTooltip(cause())}
                                      >
                                        Cause: {cacheCauseLabel(cause())}
                                      </div>
                                    )}
                                  </Show>
                                </div>
                              );
                            }}
                          </For>
                        </div>
                      </Show>
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>
        </Show>
      </div>
    </>
  );
}
