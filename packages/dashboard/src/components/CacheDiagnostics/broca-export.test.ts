import { describe, expect, test } from "bun:test";
import type { BrocaSessionSummary, SessionCacheStats } from "../../lib/types";
import { brocaCardSummary, brocaCardTooltip, cacheProjectGroups } from "./cache-diagnostics-model";

const head: BrocaSessionSummary = {
  session: { harness: "synthetic-agent-harness", session: "synthetic-agent-head" },
  first_activity_ms: 1700000003200,
  last_activity_ms: 1700000003200,
  models: ["synthetic-provider/synthetic-model-3"],
  run_count: 1,
  slice_count: 2,
  usage: { input_tokens: 21, cached_input_tokens: 0, cache_write_tokens: 6, output_tokens: 4 },
  warm_usage: {
    input_tokens: 1,
    cached_input_tokens: 20,
    cache_write_tokens: null,
    output_tokens: 0,
  },
  last_end_reason: "completed",
};

const row = (broca: BrocaSessionSummary): SessionCacheStats => ({
  harness: "broca",
  session_id: JSON.stringify(broca.session),
  title: broca.session.session,
  event_count: 0,
  total_cache_read: 0,
  total_cache_write: 0,
  total_input: 0,
  hit_ratio: 0,
  last_timestamp: "",
  last_activity_ms: broca.last_activity_ms ?? Number.MIN_SAFE_INTEGER,
  bust_count: 0,
  managed: true,
  is_subagent: false,
  broca,
});

describe("Broca export cards", () => {
  test("warm cache reads never enter the ordinary cache figure", () => {
    expect(brocaCardSummary(head).text).toBe("—");
    expect(brocaCardSummary(head).ratio).toBe(0);
    expect(brocaCardSummary(head).note).toBeNull();
  });
  test("uses whole-session exported prompt totals and existing percentage format", () => {
    const summary = brocaCardSummary({
      ...head,
      usage: {
        input_tokens: 100,
        cached_input_tokens: 800,
        cache_write_tokens: 100,
        output_tokens: 999,
      },
    });
    expect(summary.text).toBe("80.0%");
    expect(summary.ratio).toBe(0.8);
    expect(summary.tone).toBe("ratio");
  });
  test("unknown counters stay a neutral no-data figure, not zero percent", () => {
    const summary = brocaCardSummary({
      ...head,
      usage: {
        input_tokens: null,
        cached_input_tokens: null,
        cache_write_tokens: null,
        output_tokens: null,
      },
    });
    expect(summary.text).toBe("—");
    expect(summary.tone).toBe("neutral");
    expect(summary.note).toBeNull();
  });
  test("folderless sessions form their own group, not an empty path", () => {
    const groups = cacheProjectGroups([
      row(head),
      row({ ...head, session: { ...head.session, project_root: "" } }),
      row({ ...head, session: { ...head.session, project_root: "/synthetic/project-b" } }),
      row(head),
    ]);
    expect(groups.map((group) => [group.project, group.rows.length])).toEqual([
      [null, 2],
      ["", 1],
      ["/synthetic/project-b", 1],
    ]);
  });
  test("tooltip names the folderless identity and models without inventing an epoch time", () => {
    const text = brocaCardTooltip({ ...head, first_activity_ms: null, last_activity_ms: null });
    expect(text).toContain("No project folder");
    expect(text).toContain("synthetic-agent-harness");
    expect(text).toContain("synthetic-provider/synthetic-model-3");
    expect(text).not.toContain("1970");
    expect(text).not.toContain("first:");
    expect(text).not.toContain("last:");
  });
});
