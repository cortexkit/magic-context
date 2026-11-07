import { describe, expect, test } from "bun:test";
import { scoreCompatibilityNotice, scoreLabel, scoresPending } from "./compartment-scores";

describe("compartment score visibility", () => {
  test("older stores explain original-score fallback without claiming rescoring is available", () => {
    expect(scoreCompatibilityNotice(undefined)).toBeNull();
    expect(scoreCompatibilityNotice({ compartmentScores: true })).toBeNull();
    expect(scoreCompatibilityNotice({ compartmentScores: false })).toBe(
      "Compartment rescoring needs Magic Context 0.50 or later. Showing original scores.",
    );
  });
  test("original rows retain the single-score display", () => {
    expect(scoreLabel({ importance: 73 })).toBeNull();
    expect(scoresPending({ importance: 73 })).toBe(false);
  });
  test("rescored rows distinguish base, effective and applied with pending adoption", () => {
    const row = { importance: 73, effective_importance: 10, applied_importance: 73 };
    expect(scoreLabel(row)).toBe("base 73 · effective 10 · applied 73");
    expect(scoresPending(row)).toBe(true);
    expect(scoresPending({ ...row, applied_importance: 10 })).toBe(false);
  });
  test("both persisted runtime views are labelled instead of guessing the active writer", () => {
    const row = {
      importance: 73,
      effective_importance: 10,
      applied_importance: 10,
      rust_applied_importance: 73,
    };
    expect(scoreLabel(row)).toBe("base 73 · effective 10 · applied TS 10 / Rust 73");
    expect(scoresPending(row)).toBe(true);
  });
});
