import { createMemo, createSignal, For, Show } from "solid-js";
import { formatDateTime } from "../../lib/api";
import {
  cacheCauseText,
  cacheCauseTooltip,
  cacheDropLine,
  cacheDropText,
  cacheEventColorClass,
  cacheEventLabel,
  cacheWriteLabel,
  ctxBarGeom,
  formatTokensShort,
  normalizeEstimatedContextLimits,
  type TimelineAxis,
  timelineAxis,
} from "../../lib/cache-format";
import type { DbCacheEvent } from "../../lib/types";

interface TimelineSegment {
  /** Context window shared by every event in this run (0 = unknown/unreported). */
  limit: number;
  events: DbCacheEvent[];
  /** The segment's own y-axis (see timelineAxis). */
  axis: TimelineAxis;
}

/**
 * Group consecutive events into segments by context window. A new segment starts
 * whenever `context_limit` changes — which happens on a model switch OR a config
 * change to the same model's window (e.g. an accidental 12k default). Each
 * segment then gets its OWN y-scale so a large-model prompt is never measured
 * against a later small window (issue #173: that mismatch pinned bars to full
 * height and printed >100%-of-window labels).
 */
function segmentByContextLimit(events: DbCacheEvent[]): TimelineSegment[] {
  const segments: TimelineSegment[] = [];
  for (const event of events) {
    const limit = event.context_limit > 0 ? event.context_limit : 0;
    const last = segments[segments.length - 1];
    if (last && last.limit === limit) {
      last.events.push(event);
    } else {
      segments.push({ limit, events: [event], axis: { max: 1, windowInRange: false } });
    }
  }
  for (const segment of segments) segment.axis = timelineAxis(segment.events, segment.limit);
  return segments;
}

function formatLimitLabel(limit: number): string {
  return limit > 0 ? formatTokensShort(limit) : "—";
}

/**
 * The per-step cache timeline. Bars are grouped into one rounded box per context
 * window; within a box each bar's HEIGHT is the prompt size on that box's own
 * token axis. The axis spans the segment's range rather than the whole window
 * (a 219k session in a 1M window would otherwise be a thin strip), and the
 * window is still shown: as a dashed line when it is within the axis, or as an
 * off-scale label at the top of the box when it is far above. The inner segment
 * is the cached (cheap) portion, colored by the step's severity; busts also get
 * a red-tinted bar and a red tick above it so they stand out at any density.
 * A vertical "old → new" divider marks where the window changed. Steps where
 * the prompt shrank get a full-height marker line whose tooltip explains why:
 * Magic Context's reclaim in a session it manages; otherwise it says Magic
 * Context does not manage the session, plus what the request size shows when
 * the source recorded it.
 *
 * Shared by the global Cache Diagnostics page and the per-session viewer; the
 * caller owns scroll-to-list behavior via onBarClick.
 */
export default function CacheTimeline(props: {
  events: DbCacheEvent[];
  selectedStepId: string | null;
  onBarClick: (event: DbCacheEvent) => void;
}) {
  // Custom drop-line tooltip. The native `title` attribute has a ~1s OS delay
  // and tiny system styling; instead we render our own immediate tooltip on
  // hover. It must live OUTSIDE the overflow:hidden segment box, so we anchor it
  // in `.ctx-chart` at the hovered line's x (captured relative to the chart) and
  // clamp it horizontally so edge lines don't clip.
  const [hoveredDrop, setHoveredDrop] = createSignal<{ event: DbCacheEvent; xPct: number } | null>(
    null,
  );
  let chartRef: HTMLDivElement | undefined;
  const showDropTip = (event: DbCacheEvent, lineEl: HTMLElement) => {
    if (!chartRef) return;
    const chartRect = chartRef.getBoundingClientRect();
    const lineRect = lineEl.getBoundingClientRect();
    if (chartRect.width <= 0) return;
    const centerX = lineRect.left - chartRect.left + lineRect.width / 2;
    setHoveredDrop({ event, xPct: (centerX / chartRect.width) * 100 });
  };

  // Collapse climbing max-prompt fallbacks to a stable per-session limit before
  // segmenting, so a session with no recorded limit renders as one box instead
  // of fragmenting into one per step.
  const segments = createMemo(() =>
    segmentByContextLimit(normalizeEstimatedContextLimits(props.events)),
  );

  const renderBar = (event: DbCacheEvent, axis: TimelineAxis) => {
    const g = ctxBarGeom(event, axis.max);
    const isUnknown = event.severity === "unknown";
    const isBust = event.severity === "bust" || event.severity === "full_bust";
    const outerClass = isUnknown
      ? "unknown"
      : event.severity === "full_bust"
        ? "bust full_bust"
        : isBust
          ? "bust"
          : "";
    const pctOfWindow = g.limit > 0 ? (g.prompt / g.limit) * 100 : 0;
    const cachedOfPrompt = g.prompt > 0 ? (event.cache_read / g.prompt) * 100 : 0;
    const cachedLine =
      isUnknown || !event.cache_reported
        ? "Cache: not reported by provider"
        : `Cached: ${event.cache_read.toLocaleString()} (${cachedOfPrompt.toFixed(0)}% of prompt)`;
    const dropLine = event.is_drop ? `\n${cacheDropLine(event)}` : "";
    // A cause on a step that is not a drop gets its own line, worded as in the
    // Turns table; a drop already names its cause on the drop line.
    const causeLine = !event.is_drop && event.cause ? `\n${cacheCauseText(event.cause)}` : "";
    const isSelected = () => props.selectedStepId === event.message_id;
    const barProps = {
      role: "button" as const,
      tabindex: 0,
      onClick: () => props.onBarClick(event),
      onKeyDown: (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          props.onBarClick(event);
        }
      },
    };
    const windowLabel = g.limit > 0 ? g.limit.toLocaleString() : "unknown";
    const causeTip = event.cause ? cacheCauseTooltip(event.cause) : undefined;
    const title = `${formatDateTime(event.timestamp)}\n${cacheEventLabel(event)}${g.overflow ? " · OVERFLOW" : ""}\nPrompt: ${g.prompt.toLocaleString()} / ${windowLabel} (${pctOfWindow.toFixed(1)}% of window)\n${cachedLine}\nUncached: ${(event.input_tokens + event.cache_write).toLocaleString()}\nCache writes: ${cacheWriteLabel([event])}${dropLine}${causeLine}${causeTip ? `\n${causeTip}` : ""}\n(click → jump to step in list)`;
    return (
      <div class="ctx-bar-slot">
        <Show when={isBust}>
          <span class="ctx-bust-mark" />
        </Show>
        <Show when={event.is_drop}>
          <button
            type="button"
            class="ctx-drop-line"
            aria-label={`${cacheDropText(event).title} — jump to step`}
            onMouseEnter={(e) => showDropTip(event, e.currentTarget)}
            onMouseLeave={() => setHoveredDrop(null)}
            onClick={(e) => {
              e.stopPropagation();
              props.onBarClick(event);
            }}
          />
        </Show>
        <div
          {...barProps}
          class={`ctx-bar ${outerClass} ${g.overflow ? "overflow" : ""} ${isSelected() ? "selected" : ""}`}
          style={{ height: `${g.outerPct}%` }}
          title={title}
        >
          <Show when={!isUnknown && g.innerPct > 0}>
            <div
              class={`ctx-bar-cached ${cacheEventColorClass(event)}`}
              style={{ height: `${g.innerPct}%` }}
            />
          </Show>
        </div>
      </div>
    );
  };

  return (
    <div class="ctx-chart-wrap">
      <div class="ctx-chart" ref={chartRef}>
        <Show when={hoveredDrop()}>
          {(tip) => (
            <div
              class="ctx-drop-tip"
              style={{
                left: `${Math.min(92, Math.max(8, tip().xPct))}%`,
              }}
            >
              <div class="ctx-drop-tip-title">⬇ {cacheDropText(tip().event).title}</div>
              <div class="ctx-drop-tip-row">{formatDateTime(tip().event.timestamp)}</div>
              <div class="ctx-drop-tip-row">{cacheDropText(tip().event).detail}</div>
              <div class="ctx-drop-tip-hint">click → jump to step</div>
            </div>
          )}
        </Show>
        <div class="ctx-segments">
          <For each={segments()}>
            {(seg, i) => (
              <>
                <Show when={i() > 0}>
                  <div
                    class="ctx-model-divider"
                    title={`Context window changed: ${formatLimitLabel(segments()[i() - 1].limit)} → ${formatLimitLabel(seg.limit)}`}
                  >
                    <span class="ctx-model-divider-label">
                      {formatLimitLabel(segments()[i() - 1].limit)} → {formatLimitLabel(seg.limit)}
                    </span>
                  </div>
                </Show>
                <div class="ctx-segment" style={{ "flex-grow": String(seg.events.length) }}>
                  <div
                    class="ctx-segment-caption"
                    title={
                      seg.limit <= 0
                        ? "Context window not reported for these steps"
                        : seg.axis.windowInRange
                          ? `Context window: ${seg.limit.toLocaleString()} tokens (dashed line)`
                          : `Context window: ${seg.limit.toLocaleString()} tokens, above this chart's scale`
                    }
                  >
                    <Show when={seg.limit > 0} fallback="window not reported">
                      <Show when={seg.axis.windowInRange}>
                        <span class="ctx-window-swatch" />
                      </Show>
                      {formatLimitLabel(seg.limit)} window
                      <Show when={!seg.axis.windowInRange}> ↑</Show>
                    </Show>
                  </div>
                  <div class="ctx-segment-body">
                    <div class="ctx-axis" title="Bar height = prompt size in tokens">
                      <span>{formatTokensShort(seg.axis.max)}</span>
                      <span>{formatTokensShort(seg.axis.max / 2)}</span>
                      <span>0</span>
                    </div>
                    <div class="ctx-segment-box">
                      <div class="ctx-bars">
                        {/* faint gridlines at 25/50/75% of the axis to read the scale against */}
                        <div class="ctx-gridline" style={{ bottom: "25%" }} />
                        <div class="ctx-gridline" style={{ bottom: "50%" }} />
                        <div class="ctx-gridline" style={{ bottom: "75%" }} />
                        <Show when={seg.limit > 0 && seg.axis.windowInRange}>
                          <div class="ctx-window-line" />
                        </Show>
                        <For each={seg.events}>{(event) => renderBar(event, seg.axis)}</For>
                      </div>
                    </div>
                  </div>
                </div>
              </>
            )}
          </For>
        </div>
      </div>
      <div class="ctx-legend">
        <span class="ctx-legend-item">
          <span class="ctx-legend-swatch cached" />
          Cached
        </span>
        <span class="ctx-legend-item">
          <span class="ctx-legend-swatch uncached" />
          Uncached
        </span>
        <span class="ctx-legend-item">
          <span class="ctx-legend-swatch bust" />
          Bust
        </span>
        <span class="ctx-legend-item">
          <span class="ctx-legend-swatch reclaim" />
          Context reduced
        </span>
      </div>
    </div>
  );
}
