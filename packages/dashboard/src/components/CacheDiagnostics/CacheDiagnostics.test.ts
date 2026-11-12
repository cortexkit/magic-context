import { describe, expect, test } from "bun:test";
import type { DbCacheEvent, SessionCacheStats } from "../../lib/types";
import {
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
  cacheSessionRatio,
  cacheSessionTitle,
  cacheSessionVisible,
  cacheTimelineSelection,
  sessionModelLabel,
  sessionModelSummary,
} from "./cache-diagnostics-model";

const brocaRow: SessionCacheStats = {
  harness: "broca",
  session_id: '{"project_root":"/tmp/project","harness":"opencode","session":"mc-historian:one"}',
  event_count: 2,
  total_cache_read: 120,
  total_cache_write: 40,
  total_input: 20,
  hit_ratio: 2 / 3,
  last_timestamp: "2026-01-01T00:00:00Z",
  last_activity_ms: 1,
  bust_count: 0,
  managed: true,
  is_subagent: false,
  title: "mc-historian:one",
};

describe("cacheActivityNote", () => {
  test("is null when every session can follow a running turn", () => {
    expect(cacheActivityNote([brocaRow, { ...brocaRow, activity_note: null }])).toBeNull();
  });

  test("surfaces the backend's note when a session cannot", () => {
    const note = "OpenCode 2 sessions refresh only when a new prompt starts";
    expect(
      cacheActivityNote([
        brocaRow,
        { ...brocaRow, harness: "opencode2", session_id: "ses", activity_note: note },
      ]),
    ).toBe(note);
  });
});

function event(partial: Partial<DbCacheEvent>): DbCacheEvent {
  return {
    harness: "opencode",
    message_id: "m",
    session_id: "s",
    timestamp: 1,
    input_tokens: 10,
    cache_read: 0,
    cache_write: 0,
    cache_reported: true,
    total_tokens: 10,
    hit_ratio: 0,
    severity: "full_bust",
    cause: null,
    agent: null,
    turn_id: "t",
    is_turn_start: false,
    context_limit: 0,
    context_limit_estimated: false,
    is_drop: false,
    context_reduced_by_mc: true,
    cold_start: false,
    provider: null,
    model: null,
    ...partial,
  };
}

describe("cache reporting", () => {
  test("unreported event is neutral without a percentage", () => {
    expect(cacheEventPercentage(event({ cache_reported: false }))).toBe(CACHE_NOT_REPORTED);
  });

  test("reported zero retains its existing percentage", () => {
    expect(cacheEventPercentage(event({ cache_reported: true }))).toBe("0.0%");
  });

  test("mixed session scores only reported events", () => {
    const ratio = cacheSessionRatio([
      event({ cache_reported: false, input_tokens: 1000 }),
      event({ cache_read: 80, input_tokens: 20 }),
    ]);
    expect(ratio).toBe(0.8);
    expect(cachePercentage(ratio)).toBe("80.0%");
  });

  test("all-unreported session card has neutral text rather than red zero", () => {
    const ratio = cacheSessionRatio([event({ cache_reported: false })]);
    expect(ratio).toBeNull();
    expect(cachePercentage(ratio)).toBe(CACHE_FIGURE_PLACEHOLDER);
  });
});

describe("Broca cache sessions", () => {
  test("filter includes Broca and managed session rows keep their title", () => {
    expect(cacheHarnessOptions).toContainEqual({ value: "broca", label: "Broca" });
    expect(cacheSessionVisible(brocaRow, "broca", false, true)).toBe(true);
    expect(cacheSessionVisible(brocaRow, "pi", false, true)).toBe(false);
    expect(cacheSessionTitle(brocaRow)).toBe("mc-historian:one");
  });

  test("unmanaged Broca rows require the unmanaged toggle", () => {
    const unmanaged = { ...brocaRow, managed: false };
    expect(cacheSessionVisible(unmanaged, "broca", false, true)).toBe(false);
    expect(cacheSessionVisible(unmanaged, "broca", true, true)).toBe(true);
  });

  test("a cold first request explains that nothing was cached yet", () => {
    expect(cacheRatioTitle(event({ cold_start: true }))).toContain("First request");
  });
});

describe("visible timeline selection", () => {
  const oc: SessionCacheStats = { ...brocaRow, harness: "opencode", session_id: "oc" };
  const pi: SessionCacheStats = { ...brocaRow, harness: "pi", session_id: "pi" };
  const current = { harness: "opencode" as const, sessionId: "oc" };

  test("default selection skips export-only cards, and keeps a visible selection", () => {
    expect(cacheTimelineSelection([brocaRow, oc, pi], null)).toEqual(current);
    expect(cacheTimelineSelection([brocaRow, pi, oc], current)).toBe(current);
  });

  test("filtering to another ordinary host selects its newest visible card", () => {
    const visible = [brocaRow, oc, pi].filter((row) => cacheSessionVisible(row, "pi", false, true));
    expect(cacheTimelineSelection(visible, current)).toEqual({ harness: "pi", sessionId: "pi" });
  });

  test("an export-only or empty list clears the selection", () => {
    expect(cacheTimelineSelection([brocaRow], current)).toBeNull();
    expect(cacheTimelineSelection([], current)).toBeNull();
    expect(
      cacheTimelineSelection([brocaRow, oc], { harness: "broca", sessionId: brocaRow.session_id }),
    ).toEqual(current);
  });

  test("subagent, unmanaged, card-count and refresh removals cannot keep a hidden selection", () => {
    const subagent = { ...oc, is_subagent: true };
    const unmanaged = { ...oc, harness: "claude_code" as const, managed: false };
    const visibleSubagents = [subagent, pi].filter((row) =>
      cacheSessionVisible(row, "all", false, true),
    );
    const visibleManaged = [unmanaged, pi].filter((row) =>
      cacheSessionVisible(row, "all", false, true),
    );
    for (const visible of [visibleSubagents, visibleManaged, [pi, oc].slice(0, 1), [pi]]) {
      expect(cacheTimelineSelection(visible, current)).toEqual({ harness: "pi", sessionId: "pi" });
    }
  });
});

describe("session cards", () => {
  test("a request that reports zero cache reads is neutral, not a red 0%", () => {
    // A lone request with a 614-token prompt that reported zero cache reads.
    const events = [event({ input_tokens: 614, cache_read: 0, cold_start: true })];
    const summary = cacheCardSummary(events);
    expect(summary.tone).toBe("neutral");
    expect(summary.text).toBe(CACHE_FIGURE_PLACEHOLDER);
    expect(summary.note).toBe(CACHE_NO_READS);
    expect(cacheCardCountLabel(events)).toBe("1 event");
  });

  test("requests that never report reads are neutral", () => {
    const summary = cacheCardSummary([event({ cache_reported: false }), event({ turn_id: "t2" })]);
    expect(summary.tone).toBe("neutral");
    expect(summary.text).toBe(CACHE_FIGURE_PLACEHOLDER);
    expect(summary.note).toBe(CACHE_NO_READS);
  });

  test("the card figure is only ever a percentage or the placeholder", () => {
    const figure = /^(\d+\.\d%|—)$/;
    const cases = [
      [],
      [event({ cache_reported: false })],
      [event({ cache_read: 0 })],
      [event({ turn_id: "r1", cold_start: true }), event({ turn_id: "r2", cache_read: 900 })],
      [event({ turn_id: "r1", cold_start: true, cache_read: 100, severity: "info" })],
    ];
    for (const events of cases) expect(cacheCardSummary(events).text).toMatch(figure);
  });

  test("an unreported session keeps a one-character figure and explains it in small text", () => {
    const summary = cacheCardSummary([event({ cache_reported: false })]);
    expect(summary.text).toBe(CACHE_FIGURE_PLACEHOLDER);
    expect(summary.tone).toBe("neutral");
    expect(summary.note).toBe(CACHE_NOT_REPORTED);
    // Reported sessions have no note: their figure speaks for itself.
    expect(cacheCardSummary([event({ cache_read: 900, input_tokens: 100 })]).note).toBeNull();
  });

  test("a session with no recorded requests is a neutral no-data card, not 0 events", () => {
    const summary = cacheCardSummary([]);
    expect(summary.text).toBe(CACHE_FIGURE_PLACEHOLDER);
    expect(summary.tone).toBe("neutral");
    expect(cacheCardCountLabel([])).toBe("no data");
  });

  test("a single cold turn with reads is neutral", () => {
    const steps = [
      event({ turn_id: "r1", cold_start: true, input_tokens: 900, severity: "info" }),
      event({ turn_id: "r1", cache_read: 100, input_tokens: 900, severity: "stable" }),
    ];
    const summary = cacheCardSummary(steps);
    expect(summary.tone).toBe("neutral");
    expect(summary.text).toBe("5.3%");
    expect(cacheCardCountLabel(steps)).toBe("2 events");
  });

  test("a later turn is colored by its ratio", () => {
    const summary = cacheCardSummary([
      event({ turn_id: "r1", cold_start: true, input_tokens: 100 }),
      event({ turn_id: "r2", cache_read: 900, input_tokens: 100 }),
    ]);
    expect(summary.tone).toBe("ratio");
    expect(summary.ratio).toBeCloseTo(900 / 1100);
  });
});

describe("timeline header", () => {
  test("a session on one model shows it plainly", () => {
    const summary = sessionModelSummary([
      event({ timestamp: 1, provider: "anthropic", model: "claude-opus-5" }),
      event({ timestamp: 2, provider: "anthropic", model: "claude-opus-5" }),
    ]);
    expect(summary).not.toBeNull();
    if (!summary) return;
    expect(sessionModelLabel(summary)).toBe("claude-opus-5");
    expect(summary.provider).toBe("anthropic");
  });

  test("a mixed session shows the latest model and lists all", () => {
    const summary = sessionModelSummary([
      event({ timestamp: 1, provider: "anthropic", model: "claude-sonnet-5" }),
      event({ timestamp: 3, provider: "anthropic", model: "claude-opus-5-5" }),
      event({ timestamp: 2, provider: null, model: null }),
    ]);
    expect(summary).not.toBeNull();
    if (!summary) return;
    expect(sessionModelLabel(summary)).toBe("claude-opus-5-5 (+1)");
    expect(summary.all).toEqual(["anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5"]);
  });

  test("no recorded model yields no model label", () => {
    expect(sessionModelSummary([event({})])).toBeNull();
  });
});
