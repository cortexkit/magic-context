import { describe, expect, it } from "bun:test";
import {
  cacheCauseColor,
  cacheCauseLabel,
  cacheCauseText,
  cacheCauseTooltip,
  cacheDropLine,
  cacheDropText,
  cacheEventColorClass,
  cacheEventLabel,
  cacheReadLabel,
  cacheWriteLabel,
  ctxBarGeom,
  latestContextFill,
  niceTokenCeil,
  normalizeEstimatedContextLimits,
  PROVIDER_CACHE_MISS_CAUSE,
  selectWorstCacheEvent,
  sentenceCaseLabel,
  timelineAxis,
} from "./cache-format";
import type { DbCacheEvent } from "./types";

function ev(partial: Partial<DbCacheEvent>): DbCacheEvent {
  return {
    harness: "opencode",
    message_id: "m",
    session_id: "s",
    timestamp: 0,
    input_tokens: 0,
    cache_read: 0,
    cache_write: 0,
    cache_reported: true,
    total_tokens: 0,
    hit_ratio: 0,
    severity: "stable",
    cause: null,
    agent: null,
    turn_id: "t",
    is_turn_start: false,
    context_limit: 0,
    context_limit_estimated: false,
    is_drop: false,
    context_reduced_by_mc: true,
    drop_request_size: null,
    aggregate: false,
    cold_start: false,
    cache_write_reported: true,
    ...partial,
  };
}

describe("cacheCauseLabel", () => {
  it("renders a fail-open warning only for recorded transform failures", () => {
    expect(cacheCauseLabel("mc_transform_failed_open")).toBe("Magic Context transform failed open");
    expect(cacheCauseColor("mc_transform_failed_open")).toBe("red");
    expect(cacheCauseLabel("mc_transform_missing")).toBe("No attribution recorded");
    expect(cacheCauseColor("mc_transform_missing")).toBe("amber");
  });

  it("sets provider-side losses apart from Magic Context causes", () => {
    const idle = "Cache expired after 11 min idle";
    expect(cacheCauseLabel(idle)).toBe(idle);
    expect(cacheCauseColor(idle)).toBe("text-secondary");
    expect(cacheCauseTooltip(idle)).toContain("longer than the cache lifetime");
    expect(cacheCauseLabel(PROVIDER_CACHE_MISS_CAUSE)).toBe(
      "Provider cache miss (no change recorded by Magic Context)",
    );
    expect(cacheCauseColor(PROVIDER_CACHE_MISS_CAUSE)).toBe("text-secondary");
    expect(cacheCauseTooltip(PROVIDER_CACHE_MISS_CAUSE)).toContain("did not shrink");
    // The Turns table and the timeline tooltip share one cause line.
    expect(cacheCauseText(PROVIDER_CACHE_MISS_CAUSE)).toBe(
      "Cause: Provider cache miss (no change recorded by Magic Context)",
    );
    expect(cacheCauseText("mc_transform_failed_open")).toBe(
      "Cause: Magic Context transform failed open",
    );
    // Magic Context's own causes keep their tone and carry no provider tooltip.
    for (const cause of [
      "System prompt change",
      "Compaction pressure",
      "Unattributed cache bust",
    ]) {
      expect(cacheCauseColor(cause)).toBe("amber");
      expect(cacheCauseTooltip(cause)).toBeUndefined();
    }
  });
});

describe("selectWorstCacheEvent", () => {
  it("keeps the cause from the step that determined the worst severity", () => {
    const winner = selectWorstCacheEvent([
      ev({ message_id: "m1", timestamp: 100, severity: "stable", cause: "No change" }),
      ev({
        message_id: "m2",
        timestamp: 200,
        severity: "full_bust",
        cause: "Compaction pressure",
      }),
      ev({
        message_id: "m3",
        timestamp: 300,
        severity: "stable",
        cause: "No change",
      }),
    ]);

    expect(winner?.severity).toBe("full_bust");
    expect(winner?.cause).toBe("Compaction pressure");
  });

  it("chooses the newest event when severities tie", () => {
    const winner = selectWorstCacheEvent([
      ev({ message_id: "m1", timestamp: 100, severity: "bust", cause: "First cause" }),
      ev({ message_id: "m2", timestamp: 200, severity: "bust", cause: "Newest cause" }),
    ]);

    expect(winner?.message_id).toBe("m2");
    expect(winner?.cause).toBe("Newest cause");
  });
});

describe("normalizeEstimatedContextLimits", () => {
  it("collapses a climbing max-prompt fallback to the per-session max (no fragmentation)", () => {
    // The exact failure shape: an untracked session whose estimated limit climbs
    // every step on the incremental fetch path.
    const events = [85_000, 86_000, 89_000, 95_000].map((limit, i) =>
      ev({
        message_id: `m${i}`,
        session_id: "sub",
        timestamp: i,
        context_limit: limit,
        context_limit_estimated: true,
      }),
    );

    const out = normalizeEstimatedContextLimits(events);

    // Every event now carries the SAME stable limit (the window's max), so
    // segmentByContextLimit produces a single segment instead of one per step.
    expect(out.map((e) => e.context_limit)).toEqual([95_000, 95_000, 95_000, 95_000]);
    expect(new Set(out.map((e) => e.context_limit)).size).toBe(1);
  });

  it("leaves recorded limits untouched so real model switches still segment", () => {
    // estimated=false → a genuine mid-session model switch (256k → 1M) must
    // survive as two distinct limits.
    const events = [
      ev({ message_id: "a", context_limit: 256_000, context_limit_estimated: false }),
      ev({ message_id: "b", context_limit: 256_000, context_limit_estimated: false }),
      ev({ message_id: "c", context_limit: 1_000_000, context_limit_estimated: false }),
    ];

    const out = normalizeEstimatedContextLimits(events);

    expect(out.map((e) => e.context_limit)).toEqual([256_000, 256_000, 1_000_000]);
    // No estimated events → identity return (same array reference).
    expect(out).toBe(events);
  });

  it("collapses each session to its OWN max (per session_id, not cross-session)", () => {
    const events = [
      ev({
        message_id: "a",
        session_id: "x",
        context_limit: 50_000,
        context_limit_estimated: true,
      }),
      ev({
        message_id: "b",
        session_id: "x",
        context_limit: 70_000,
        context_limit_estimated: true,
      }),
      ev({
        message_id: "c",
        session_id: "y",
        context_limit: 20_000,
        context_limit_estimated: true,
      }),
      ev({
        message_id: "d",
        session_id: "y",
        context_limit: 30_000,
        context_limit_estimated: true,
      }),
    ];

    const out = normalizeEstimatedContextLimits(events);

    expect(out.map((e) => e.context_limit)).toEqual([70_000, 70_000, 30_000, 30_000]);
  });

  it("does not cross-collapse same session_id across different harnesses", () => {
    const events = [
      ev({
        message_id: "a",
        harness: "opencode",
        session_id: "dup",
        context_limit: 40_000,
        context_limit_estimated: true,
      }),
      ev({
        message_id: "b",
        harness: "pi",
        session_id: "dup",
        context_limit: 90_000,
        context_limit_estimated: true,
      }),
    ];

    const out = normalizeEstimatedContextLimits(events);

    // Keyed by harness:session_id, so the two never alias each other.
    expect(out[0].context_limit).toBe(40_000);
    expect(out[1].context_limit).toBe(90_000);
  });
});

describe("cache row labels", () => {
  it("labels a session's first request as a neutral cold start, never a red miss", () => {
    const first = ev({ severity: "full_bust", cold_start: true });
    expect(cacheEventLabel(first)).toBe("COLD START");
    expect(cacheEventColorClass(first)).toBe("blue");
    expect(cacheEventLabel(ev({ severity: "info" }))).toBe("COLD START");
  });

  it("labels a run aggregate as a total with no health verdict", () => {
    const run = ev({ severity: "aggregate", aggregate: true });
    expect(cacheEventLabel(run)).toBe("RUN TOTAL");
    expect(cacheEventColorClass(run)).toBe("gray");
    expect(cacheEventLabel({ ...run, cold_start: true })).toBe("COLD START · RUN TOTAL");
    expect(cacheEventLabel({ ...run, finish: "completed" })).toBe("RUN TOTAL");
    expect(cacheEventLabel({ ...run, finish: "error" })).toBe("RUN TOTAL · ERROR");
  });

  it("keeps real busts red", () => {
    expect(cacheEventLabel(ev({ severity: "full_bust" }))).toBe("FULL BUST");
    expect(cacheEventColorClass(ev({ severity: "bust" }))).toBe("red");
  });

  it("aggregate rows do not outrank real verdicts when picking a turn's worst event", () => {
    const bust = ev({ severity: "bust", timestamp: 1 });
    const run = ev({ severity: "aggregate", aggregate: true, timestamp: 2 });
    expect(selectWorstCacheEvent([bust, run])).toBe(bust);
  });
});

describe("cacheWriteLabel", () => {
  it("says not reported when the source omitted cache writes", () => {
    expect(cacheWriteLabel([ev({ cache_write: 0, cache_write_reported: false })])).toBe(
      "not reported",
    );
  });

  it("sums reported writes and flags a partly reported set", () => {
    expect(cacheWriteLabel([ev({ cache_write: 1_200 }), ev({ cache_write: 800 })])).toBe(
      (2_000).toLocaleString(),
    );
    expect(
      cacheWriteLabel([
        ev({ cache_write: 5 }),
        ev({ cache_write: 0, cache_write_reported: false }),
      ]),
    ).toBe("5 (partial)");
  });
});

describe("cacheReadLabel", () => {
  it("shows reads when reported and 'not reported' when the key was absent", () => {
    expect(cacheReadLabel(ev({ cache_read: 90 }))).toBe((90).toLocaleString());
    expect(cacheReadLabel(ev({ cache_read: 0 }))).toBe("0");
    expect(cacheReadLabel(ev({ cache_read: 0, cache_reported: false }))).toBe("not reported");
  });
});

describe("cache timeline axis", () => {
  it("rounds axis tops up to readable token counts", () => {
    expect(niceTokenCeil(252_202)).toBe(300_000);
    expect(niceTokenCeil(140_000)).toBe(150_000);
    expect(niceTokenCeil(1_000)).toBe(1_000);
    expect(niceTokenCeil(0)).toBe(1);
  });

  it("scales a small prompt in a large window to the session's own range", () => {
    // A 219k prompt in a 1.05M window: scaled to the window it filled only a
    // fifth of the chart; on its own range it fills most of it.
    const step = ev({ cache_read: 219_008, input_tokens: 298, context_limit: 1_050_000 });
    const axis = timelineAxis([step], 1_050_000);
    expect(axis).toEqual({ max: 300_000, windowInRange: false });
    expect(ctxBarGeom(step, axis.max).outerPct).toBeCloseTo(73.1, 1);
    expect(ctxBarGeom(step).outerPct).toBeCloseTo(20.9, 1);
  });

  it("uses the whole window once prompts come close to it", () => {
    const step = ev({ cache_read: 180_000, input_tokens: 20_000, context_limit: 272_000 });
    expect(timelineAxis([step], 272_000)).toEqual({ max: 272_000, windowInRange: true });
  });

  it("still flags a prompt that overflowed its window", () => {
    const step = ev({ cache_read: 300_000, context_limit: 272_000 });
    const axis = timelineAxis([step], 272_000);
    const geom = ctxBarGeom(step, axis.max);
    expect(geom.overflow).toBe(true);
    expect(geom.outerPct).toBe(100);
  });
});

describe("latestContextFill", () => {
  it("reports the newest step's share of its recorded window", () => {
    const fill = latestContextFill([
      ev({ timestamp: 1, cache_read: 100_000, context_limit: 1_000_000 }),
      ev({ timestamp: 2, cache_read: 210_000, input_tokens: 9_306, context_limit: 1_050_000 }),
    ]);
    expect(fill).toEqual({ prompt: 219_306, limit: 1_050_000, ratio: 219_306 / 1_050_000 });
  });

  it("says nothing when the window was only estimated", () => {
    expect(
      latestContextFill([
        ev({ cache_read: 5_000, context_limit: 5_000, context_limit_estimated: true }),
      ]),
    ).toBeNull();
  });
});

describe("sentenceCaseLabel", () => {
  it("turns upper-case row labels into sentence case", () => {
    expect(sentenceCaseLabel("COLD START · RUN TOTAL")).toBe("Cold start · run total");
    expect(sentenceCaseLabel("FULL BUST")).toBe("Full bust");
  });
});

describe("drop marker wording", () => {
  const drop = (partial: Partial<DbCacheEvent>) => ev({ is_drop: true, ...partial });

  it("credits Magic Context with a drop only in a session it manages", () => {
    const managed = drop({ context_reduced_by_mc: true, cause: "mc_transform_failed_open" });
    expect(cacheDropText(managed)).toEqual({
      title: "Magic Context reclaimed context",
      detail: "Cause: Magic Context transform failed open",
    });
    expect(cacheDropLine(managed)).toBe(
      "⬇ MC reclaimed context — Magic Context transform failed open",
    );
    const noCause = drop({ context_reduced_by_mc: true });
    expect(cacheDropText(noCause).detail).toBe("Cause not recorded");
    expect(cacheDropLine(noCause)).toBe("⬇ MC reclaimed context");
  });

  it("labels a drop in an unmanaged session without a Magic Context cause", () => {
    // A cause on the event is ignored: it cannot be Magic Context's here.
    const unmanaged = drop({ context_reduced_by_mc: false, cause: "mc_transform_failed_open" });
    expect(cacheDropText(unmanaged)).toEqual({
      title: "Prompt tokens dropped",
      detail: "Magic Context does not manage this session.",
    });
    expect(cacheDropLine(unmanaged)).toBe(
      "⬇ Prompt tokens dropped — Magic Context does not manage this session.",
    );
  });

  it("says what the request size shows when both sizes were recorded", () => {
    const grew = drop({ context_reduced_by_mc: false, drop_request_size: "not_smaller" });
    expect(cacheDropText(grew).detail).toBe(
      "Magic Context does not manage this session. The request did not get smaller; the provider counted fewer tokens.",
    );
    expect(cacheDropLine(grew)).toBe(
      "⬇ Prompt tokens dropped — Magic Context does not manage this session. The request did not get smaller; the provider counted fewer tokens.",
    );
    const shrank = drop({ context_reduced_by_mc: false, drop_request_size: "smaller" });
    expect(cacheDropText(shrank).detail).toBe(
      "Magic Context does not manage this session. The request got smaller.",
    );
  });
});
