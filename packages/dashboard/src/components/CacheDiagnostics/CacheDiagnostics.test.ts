import { describe, expect, test } from "bun:test";
import type { DbCacheEvent, SessionCacheStats } from "../../lib/types";
import {
  cacheActivityNote,
  cacheCardCountLabel,
  cacheCardSummary,
  cacheCardTitle,
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
} from "./CacheDiagnostics";

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
    harness: "broca",
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
    aggregate: false,
    cold_start: false,
    cache_write_reported: true,
    provider: null,
    model: null,
    ...partial,
  };
}

describe("cache reporting", () => {
  test("unreported event is neutral without a percentage", () => {
    expect(cacheEventPercentage(event({ cache_reported: false }))).toBe(
      "No cached tokens reported",
    );
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
    expect(cachePercentage(ratio)).toBe("No cached tokens reported");
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

  test("a run aggregate shows its own cached share and explains it", () => {
    const run = event({
      aggregate: true,
      severity: "aggregate",
      input_tokens: 993,
      cache_read: 114_560,
      hit_ratio: 114_560 / 115_553,
    });
    expect(cacheEventPercentage(run)).toBe("99.1%");
    expect(cacheRatioTitle(run)).toContain("whole run");
  });

  test("a cold first request explains that nothing was cached yet", () => {
    expect(cacheRatioTitle(event({ cold_start: true }))).toContain("First request");
  });
});

describe("session cards", () => {
  const run = (partial: Partial<DbCacheEvent>) =>
    event({ aggregate: true, severity: "aggregate", ...partial });

  test("a run that reports zero cache reads is neutral, not a red 0%", () => {
    // A lone run total with a 614-token prompt that reported zero cache reads.
    const events = [run({ input_tokens: 614, cache_read: 0, cold_start: true })];
    const summary = cacheCardSummary(events);
    expect(summary.tone).toBe("neutral");
    expect(summary.text).toBe("no cache data");
    expect(cacheCardCountLabel(events)).toBe("1 run");
  });

  test("runs that never report reads are neutral", () => {
    const summary = cacheCardSummary([run({ cache_reported: false }), run({ turn_id: "t2" })]);
    expect(summary.tone).toBe("neutral");
    expect(summary.text).toBe("no cache data");
    expect(cacheCardSummary([run({ cache_reported: false })]).text).toBe(
      "No cached tokens reported",
    );
  });

  test("a single cold run with reads is neutral", () => {
    const steps = [
      event({ turn_id: "r1", cold_start: true, input_tokens: 900, severity: "info" }),
      event({ turn_id: "r1", cache_read: 100, input_tokens: 900, severity: "stable" }),
    ];
    const summary = cacheCardSummary(steps);
    expect(summary.tone).toBe("neutral");
    expect(summary.text).toBe("5.3%");
    expect(cacheCardCountLabel(steps)).toBe("2 events");
  });

  test("a later run is colored by its ratio", () => {
    const summary = cacheCardSummary([
      run({ turn_id: "r1", cold_start: true, input_tokens: 100 }),
      run({ turn_id: "r2", cache_read: 900, input_tokens: 100 }),
    ]);
    expect(summary.tone).toBe("ratio");
    expect(summary.ratio).toBeCloseTo(900 / 1100);
  });

  test("long names keep their last meaningful part", () => {
    const named = (title: string) => ({ ...brocaRow, title });
    expect(cacheCardTitle(named("alfonso:consult-00000000-1111-2222-3333-4444a1b2c3"))).toBe(
      "consult-…a1b2c3",
    );
    expect(cacheCardTitle(named("alfonso:oneshot-9f8e7d6c5b4a39281706f5e4d3"))).toBe(
      "oneshot-…f5e4d3",
    );
    expect(cacheCardTitle(named("alfonso:bg_b1b7fea62af10d66"))).toBe("bg_b1b7fea62af10d66");
    expect(cacheCardTitle(named("mc-historian:one"))).toBe("mc-historian:one");
  });
});

describe("timeline header", () => {
  test("a Broca session shows its full name and inner harness", () => {
    const name = "alfonso:consult-00000000-1111-2222-3333-444444444444-synthesis";
    const header = cacheSessionHeader(
      "broca",
      JSON.stringify({ project_root: "/work/app", harness: "runner", session: name }),
      name,
    );
    expect(header.name).toBe(name);
    expect(header.innerHarness).toBe("runner");
    expect(header.tooltip).toContain(name);
    expect(header.tooltip).toContain("/work/app");
  });

  test("other harnesses show the title and keep the id in the tooltip", () => {
    const header = cacheSessionHeader("opencode", "ses_123", "Fix the parser");
    expect(header).toEqual({
      name: "Fix the parser",
      tooltip: "Fix the parser\nses_123",
      innerHarness: null,
    });
    expect(cacheSessionHeader("pi", "abc", undefined).name).toBe("abc");
  });

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
