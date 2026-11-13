import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluatePairs, readThemeTokens } from "../../scripts/theme-contrast";

const css = readFileSync(resolve(import.meta.dir, "../styles.css"), "utf8");

describe("theme token contrast", () => {
  it("every light-theme text and control pair meets its WCAG AA minimum", () => {
    const failing = evaluatePairs("light", css)
      .filter((row) => !row.pass)
      .map((row) => `${row.label}: ${row.ratio.toFixed(2)} < ${row.min}`);
    expect(failing).toEqual([]);
  });

  it("dark-theme pairs added in PR #912 meet WCAG AA", () => {
    // The dark theme has 52 pre-existing pairs below AA; this test guards only
    // the pairs added in #912 (grid error banner, context menu text), ensuring
    // they meet AA in BOTH themes.
    const pr912Labels = [
      "grid error text (70% error-text over text-primary) on error-bg",
      "context-menu explanation (70% text-secondary over text-primary) on bg-elevated",
      "context-menu explanation (70% text-secondary over text-primary) on bg-elevated-hover",
      "disabled menu row (50% text-muted over text-primary) on bg-elevated",
      "disabled menu row (50% text-muted over text-primary) on bg-elevated-hover",
      "current workspace label (70% accent over text-primary) on bg-elevated",
      "current workspace label (70% accent over text-primary) on bg-elevated-hover",
    ];
    const failing = evaluatePairs("dark", css)
      .filter((row) => pr912Labels.includes(row.label) && !row.pass)
      .map((row) => `${row.label}: ${row.ratio.toFixed(2)} < ${row.min}`);
    expect(failing).toEqual([]);
  });

  it("the light theme overrides every colour token the dark theme defines", () => {
    // A token left out of the light block silently inherits its dark value
    // (dark text on light surfaces, or the reverse).
    const dark = readThemeTokens("dark", css);
    const light = readThemeTokens("light", css);
    const missing = [...dark.keys()].filter((name) => !light.has(name));
    expect(missing).toEqual([]);
  });
});
