import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { formatDateTime, getSessionCacheEvents, getSessionCacheStatsFromDb } from "../../lib/api";
import {
  cacheCauseColor,
  cacheCauseLabel,
  cacheCauseTooltip,
  cacheEventColorClass,
  cacheEventLabel,
  cacheReadLabel,
  cacheWriteLabel,
  formatTokensShort,
  latestContextFill,
  selectWorstCacheEvent,
  sentenceCaseLabel,
} from "../../lib/cache-format";
import { livePollDue } from "../../lib/live-poll";
import { sessionLabel } from "../../lib/session-label";
import type { DbCacheEvent, Harness, SessionCacheStats } from "../../lib/types";
import HarnessBadge from "../HarnessBadge";
import CacheTimeline from "../shared/CacheTimeline";
import FilterSelect from "../shared/FilterSelect";
import Icon from "../shared/Icon";
import type { CacheCardSummary, HarnessFilter } from "./cache-diagnostics-model";
import {
  CACHE_FIGURE_PLACEHOLDER,
  cacheActivityNote,
  cacheCardCountLabel,
  cacheCardSummary,
  cacheEventPercentage,
  cacheHarnessOptions,
  cacheRatioTitle,
  cacheSessionHeader,
  cacheSessionVisible,
  isManagedFilterableHarness,
  sessionModelLabel,
  sessionModelSummary,
} from "./cache-diagnostics-model";

export type {
  CacheCardSummary,
  CacheSessionHeader,
  HarnessFilter,
  SessionModelSummary,
} from "./cache-diagnostics-model";
export {
  CACHE_FIGURE_PLACEHOLDER,
  CACHE_NO_READS,
  CACHE_NOT_REPORTED,
  cacheActivityNote,
  cacheCardCountLabel,
  cacheCardSummary,
  cacheEventPercentage,
  cacheHarnessOptions,
  cachePercentage,
  cacheRatioTitle,
  cacheSessionHeader,
  cacheSessionRatio,
  cacheSessionTitle,
  cacheSessionVisible,
  sessionModelLabel,
  sessionModelSummary,
} from "./cache-diagnostics-model";

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
  // latched so a slow pass can't stack. Backs off while the window is in the
  // background and stops while it is hidden (see lib/live-poll.ts); coming
  // back to the window refreshes at once.
  let reconcileInFlight = false;
  let ticksSinceRefresh = 0;
  const tick = async (force = false) => {
    if (paused() || reconcileInFlight) return;
    ticksSinceRefresh += 1;
    const due =
      force ||
      livePollDue({
        hidden: document.visibilityState === "hidden",
        focused: document.hasFocus(),
        ticksSinceRefresh,
      });
    if (!due) return;
    ticksSinceRefresh = 0;
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
  const refreshOnReturn = () => {
    if (document.visibilityState !== "hidden") void tick(true);
  };
  document.addEventListener("visibilitychange", refreshOnReturn);
  window.addEventListener("focus", refreshOnReturn);
  onCleanup(() => {
    clearInterval(tickInterval);
    document.removeEventListener("visibilitychange", refreshOnReturn);
    window.removeEventListener("focus", refreshOnReturn);
  });

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

  // For the SESSION-aggregate figure only: stat.hit_ratio is an overall
  // read/total efficiency number (not a per-step health classification), so a
  // simple threshold color is appropriate there.
  const hitColor = (ratio: number) =>
    ratio >= 0.9 ? "var(--green)" : ratio >= 0.5 ? "var(--amber)" : "var(--red)";

  // The figure on a card: health-coloured when it judges the cache, plain text
  // when it is a real number without a verdict (a cold first run), and muted
  // only for the placeholder dash.
  const figureColor = (summary: CacheCardSummary) => {
    if (summary.text === CACHE_FIGURE_PLACEHOLDER) return "var(--text-muted)";
    return summary.tone === "neutral" ? "var(--text-primary)" : hitColor(summary.ratio);
  };

  const steps = () =>
    totalTimelineSteps() > timelineEvents().length
      ? `last ${timelineEvents().length} of ${totalTimelineSteps()} steps`
      : `${timelineEvents().length} ${timelineEvents().length === 1 ? "step" : "steps"}`;

  return (
    <>
      <div class="section-header">
        <h1 class="section-title">Cache Diagnostics</h1>
        <div class="section-actions toolbar">
          <div class="toolbar-group">
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
          </div>
          <div class="toolbar-group">
            <button
              type="button"
              class="toggle-chip"
              aria-pressed={showUnmanagedSessions()}
              onClick={() => setShowUnmanagedSessions(!showUnmanagedSessions())}
            >
              <Show when={showUnmanagedSessions()}>
                <Icon name="check" size={13} />
              </Show>
              Show unmanaged
            </button>
            <button
              type="button"
              class="toggle-chip"
              aria-pressed={!hideSubagents()}
              onClick={() => {
                setHideSubagents(!hideSubagents());
                void reconcile();
              }}
            >
              <Show when={!hideSubagents()}>
                <Icon name="check" size={13} />
              </Show>
              Show subagents
            </button>
          </div>
          <div class="toolbar-group">
            <span class={`live-status ${paused() ? "paused" : ""}`} aria-live="polite">
              <span class="live-dot" />
              {paused() ? "Paused" : "Live"}
            </span>
            <button type="button" class="btn toolbar-btn" onClick={() => setPaused(!paused())}>
              <Icon name={paused() ? "play" : "pause"} size={13} />
              {paused() ? "Resume" : "Pause"}
            </button>
          </div>
        </div>
      </div>

      {/* Session cards */}
      <div class="cache-section">
        <Show when={activityNote()}>
          {(note) => <div class="cache-activity-note">{note()}</div>}
        </Show>
        <Show when={filteredStats().length > 0}>
          <div class="section-eyebrow">Recent sessions</div>
          <div ref={measureCardRow} class="cache-card-row" style={{ gap: `${CARD_GAP}px` }}>
            <For each={filteredStats()}>
              {(stat) => {
                const isActive = () => {
                  const selected = selectedSession();
                  return (
                    selected?.sessionId === stat.session_id && selected.harness === stat.harness
                  );
                };
                const label = sessionLabel(stat.harness, stat.session_id, stat.title);
                // Every Broca session is managed, so only the exception is
                // marked: an unmanaged card listed because the toggle is on.
                const unmanaged = isManagedFilterableHarness(stat.harness) && !stat.managed;
                return (
                  <button
                    type="button"
                    class={`cache-card ${isActive() ? "active" : ""}`}
                    aria-pressed={isActive()}
                    onClick={() => {
                      // Select-only: clicking a card focuses that session's
                      // window. Clicking the already-active card is a no-op
                      // (there is no combined/merged view to toggle back to).
                      if (!isActive()) {
                        selectSession({ harness: stat.harness, sessionId: stat.session_id });
                      }
                    }}
                  >
                    {/* Every line of a card is one fixed-height, non-wrapping
                        line, so cards in the row stay one height whatever
                        they show. */}
                    <span class="cache-card-name" title={label.tooltip}>
                      <Show when={label.name} fallback={<span class="id-text">{label.id}</span>}>
                        {label.name}
                      </Show>
                    </span>
                    <span class="cache-card-meta" title={label.tooltip}>
                      <HarnessBadge harness={stat.harness} />
                      <Show when={label.owner}>
                        {(owner) => <span class="quiet-label">{owner()}</span>}
                      </Show>
                      <Show when={label.name && label.id}>
                        <span class="id-text">{label.id}</span>
                      </Show>
                      <Show when={unmanaged}>
                        <span class="quiet-label">unmanaged</span>
                      </Show>
                    </span>
                    <span
                      class="cache-card-figure"
                      title={stat.summary.title}
                      style={{ color: figureColor(stat.summary) }}
                    >
                      {stat.summary.text}
                    </span>
                    <span class="cache-card-foot" title={stat.summary.title}>
                      <span>{stat.countLabel}</span>
                      <Show when={stat.summary.note}>
                        {(note) => <span class="cache-card-note">{note()}</span>}
                      </Show>
                      <Show when={stat.bust_count > 0}>
                        <span class="cache-card-busts">
                          {stat.bust_count} {stat.bust_count === 1 ? "bust" : "busts"}
                        </span>
                      </Show>
                    </span>
                  </button>
                );
              }}
            </For>
          </div>
        </Show>
      </div>

      {/* Chart */}
      <Show when={filteredEvents().length > 0}>
        <div class="cache-section">
          <div class="section-eyebrow">Cache hit timeline</div>
          <div class="chart-container cache-chart">
            <Show when={selectedSession()}>
              {(selected) => {
                const label = () =>
                  sessionLabel(
                    selected().harness,
                    selected().sessionId,
                    sessionNames()[windowKey(selected().harness, selected().sessionId)],
                  );
                const header = () =>
                  cacheSessionHeader(
                    selected().harness,
                    selected().sessionId,
                    sessionNames()[windowKey(selected().harness, selected().sessionId)],
                  );
                const models = () => sessionModelSummary(filteredEvents());
                const fill = () => latestContextFill(filteredEvents());
                return (
                  <div class="cache-chart-head">
                    <div class="cache-chart-title" title={label().tooltip}>
                      <HarnessBadge harness={selected().harness} />
                      <span class="cache-chart-name">
                        <Show
                          when={label().name}
                          fallback={<span class="id-text selectable">{label().id}</span>}
                        >
                          {label().name}
                        </Show>
                      </span>
                      <Show when={label().owner}>
                        {(owner) => <span class="quiet-label">{owner()}</span>}
                      </Show>
                      <Show when={label().name && label().id}>
                        <span class="id-text selectable">{label().id}</span>
                      </Show>
                    </div>
                    <span class="cache-chart-steps">{steps()}</span>
                    <div class="cache-chart-sub">
                      <Show when={header().innerHarness}>
                        {(inner) => <span>via {inner()}</span>}
                      </Show>
                      <Show when={models()}>
                        {(summary) => (
                          <span title={summary().all.join("\n")}>
                            {summary().provider ? `${summary().provider} · ` : ""}
                            {sessionModelLabel(summary())}
                          </span>
                        )}
                      </Show>
                    </div>
                    <Show when={fill()}>
                      {(f) => (
                        <div
                          class="context-fill"
                          title={`Newest step: ${f().prompt.toLocaleString()} of ${f().limit.toLocaleString()} context-window tokens`}
                        >
                          <span class="context-fill-label">Context</span>
                          <span class="context-fill-meter" aria-hidden="true">
                            <span
                              class={`context-fill-value ${f().ratio > 1 ? "over" : ""}`}
                              style={{ width: `${Math.min(100, f().ratio * 100)}%` }}
                            />
                          </span>
                          <span class="num">
                            {formatTokensShort(f().prompt)} of {formatTokensShort(f().limit)}
                          </span>
                          <span class="num context-fill-pct">{Math.round(f().ratio * 100)}%</span>
                        </div>
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
        </div>
      </Show>

      {/* Turn list */}
      <div class="scroll-area">
        <Show when={!loading()} fallback={<div class="empty-state">Loading cache events...</div>}>
          <Show
            when={cacheTurns().length > 0}
            fallback={
              <div class="empty-state">
                <span class="empty-state-icon">
                  <Icon name="gauge" size={28} />
                </span>
                <span>No cache events found</span>
                <span style={{ "font-size": "11px" }}>
                  Cache data is read from OpenCode, Pi, Claude Code, and Codex sessions
                </span>
              </div>
            }
          >
            <div class="section-eyebrow">Turns</div>
            <div class="cache-turns">
              <div class="cache-turn-grid cache-turns-head">
                <span>Time</span>
                <span>Status</span>
                <span class="num">Cache hit</span>
                <span class="num">Prompt</span>
                <span class="num">Cached</span>
                <span class="num">New</span>
                <span>Steps</span>
              </div>
              <For each={[...cacheTurns()].reverse()}>
                {(turn) => {
                  // Parent stats reflect the turn's FINAL step (the prompt that
                  // actually shipped), not an aggregate across steps. Aggregation
                  // double-counts a bust child and produces nonsense like
                  // prompt=823k for a 540k actual turn.
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
                        // A getter keeps the attribute reactive through the spread.
                        get "aria-expanded"() {
                          return isExpanded();
                        },
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
                      class={`cache-turn tone-${cacheEventColorClass(turn.worstEvent)}`}
                    >
                      <div
                        class={`cache-turn-grid cache-turn-main ${isMultiStep ? "expandable" : ""}`}
                        {...interactiveProps}
                      >
                        <span class="num cache-cell-time">{formatDateTime(turn.startTime)}</span>
                        <span class="cache-cell-status">
                          <CacheStatus event={turn.worstEvent} />
                        </span>
                        <Show
                          when={turn.worstSeverity !== "unknown" && !unreportedTurn}
                          fallback={
                            <span class="num cache-cell-muted">
                              {unreportedTurn ? "not reported" : "no data"}
                            </span>
                          }
                        >
                          <span class="num cache-cell-hit" title={cacheRatioTitle(last)}>
                            {(turnRetention * 100).toFixed(1)}%
                          </span>
                        </Show>
                        <span class="num">{totalPrompt.toLocaleString()}</span>
                        <TokenCell text={cacheReadLabel(last)} />
                        <TokenCell text={cacheWriteLabel(turn.events)} />
                        <span class="cache-cell-steps">
                          <Show when={isMultiStep}>
                            <Icon
                              name={isExpanded() ? "chevron-down" : "chevron-right"}
                              size={13}
                            />
                            {turn.events.length} steps
                          </Show>
                        </span>
                      </div>
                      <Show when={worstCause}>
                        {(cause) => (
                          <div
                            class="cache-turn-cause"
                            style={{ color: `var(--${cacheCauseColor(cause())})` }}
                            title={cacheCauseTooltip(cause())}
                          >
                            Cause: {cacheCauseLabel(cause())}
                          </div>
                        )}
                      </Show>
                      <Show when={isExpanded()}>
                        <div class="cache-steps">
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
                                  class={`cache-step-row tone-${cacheEventColorClass(event)} ${selectedStepId() === event.message_id ? "selected" : ""}`}
                                >
                                  <div class="cache-turn-grid">
                                    <span class="num cache-cell-time">
                                      {formatDateTime(event.timestamp)}
                                    </span>
                                    <span class="cache-cell-status">
                                      <CacheStatus event={event} />
                                    </span>
                                    <Show
                                      when={event.severity !== "unknown" && event.cache_reported}
                                      fallback={
                                        <span class="num cache-cell-muted">
                                          {event.cache_reported ? "no data" : "not reported"}
                                        </span>
                                      }
                                    >
                                      <span
                                        class="num cache-cell-hit"
                                        title={cacheRatioTitle(event)}
                                      >
                                        {cacheEventPercentage(event)}
                                      </span>
                                    </Show>
                                    <span class="num">{evTotalPrompt.toLocaleString()}</span>
                                    <TokenCell text={cacheReadLabel(event)} />
                                    <TokenCell text={cacheWriteLabel([event])} />
                                    <span />
                                  </div>
                                  <Show when={event.cause}>
                                    {(cause) => (
                                      <div
                                        class="cache-turn-cause"
                                        style={{ color: `var(--${cacheCauseColor(cause())})` }}
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

/**
 * A turn or step's status, said once. Problems (warnings and busts) are a
 * coloured pill so they stand out down the list; everything else (stable, cold
 * start, run totals) is quiet text.
 */
function CacheStatus(props: { event: DbCacheEvent }) {
  const color = () => cacheEventColorClass(props.event);
  const text = () => sentenceCaseLabel(cacheEventLabel(props.event));
  return (
    <Show
      when={color() === "red" || color() === "amber"}
      fallback={<span class="cache-status-text">{text()}</span>}
    >
      <span class={`pill ${color()}`}>{text()}</span>
    </Show>
  );
}

/** A token count cell; "not reported" (and partial counts' note) reads quieter. */
function TokenCell(props: { text: string }) {
  return <span class={`num ${/\d/.test(props.text) ? "" : "cache-cell-muted"}`}>{props.text}</span>;
}
