// WCAG contrast report for the dashboard theme tokens in src/styles.css.
// Run: bun scripts/theme-contrast.ts        (prints every pair for both themes)
// src/lib/theme-contrast.test.ts imports CONTRAST_PAIRS and fails when a light
// theme pair drops below its minimum.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type Rgb = [number, number, number];
export type ThemeName = "light" | "dark";

/** A colour expression: a token name, or a token tinted over a surface. */
export type ColorRef = string | { tint: string; percent: number; over: string };

export interface ContrastPair {
  label: string;
  fg: ColorRef;
  bg: ColorRef;
  /** 4.5 for text (WCAG AA body text), 3 for UI boundaries and chart marks. */
  min: number;
}

const SURFACES = ["bg-base", "bg-panel", "bg-card", "bg-hover", "bg-active"];
const TEXT = ["text-primary", "text-secondary", "text-muted", "text-quiet"];
const PILL_COLORS = ["green", "accent", "text-secondary", "purple", "indigo", "amber", "red"];

export const CONTRAST_PAIRS: ContrastPair[] = [
  ...TEXT.flatMap((fg) =>
    SURFACES.map((bg) => ({ label: `${fg} on ${bg}`, fg, bg, min: 4.5 })),
  ),
  { label: "text-primary on bg-input", fg: "text-primary", bg: "bg-input", min: 4.5 },
  { label: "text-muted on bg-input (placeholders)", fg: "text-muted", bg: "bg-input", min: 4.5 },
  ...["bg-base", "bg-panel", "bg-card", "bg-hover", "bg-active"].map((bg) => ({
    label: `accent text on ${bg}`,
    fg: "accent",
    bg,
    min: 4.5,
  })),
  ...["accent", "accent-dim", "red", "red-dim", "success"].map((bg) => ({
    label: `on-accent on ${bg}`,
    fg: "on-accent",
    bg,
    min: 4.5,
  })),
  ...PILL_COLORS.flatMap((color) =>
    ["bg-card", "bg-base", "bg-active"].map((surface) => ({
      label: `${color} pill text on its 15% tint over ${surface}`,
      fg: color,
      bg: { tint: color, percent: 15, over: surface },
      min: 4.5,
    })),
  ),
  ...["green", "amber", "red", "accent"].map((color) => ({
    label: `${color} text on bg-card`,
    fg: color,
    bg: "bg-card",
    min: 4.5,
  })),
  {
    label: "red error text on its 10% tint over bg-card",
    fg: "red",
    bg: { tint: "red", percent: 10, over: "bg-card" },
    min: 4.5,
  },
  { label: "error-text on error-bg", fg: "error-text", bg: "error-bg", min: 4.5 },
  // The project grid error banner and the context-menu explanations are text the
  // reviewer singled out: each must clear AA in BOTH themes, not just light.
  {
    label: "grid error text (70% error-text over text-primary) on error-bg",
    fg: { tint: "error-text", percent: 70, over: "text-primary" },
    bg: "error-bg",
    min: 4.5,
  },
  ...["bg-elevated", "bg-elevated-hover"].map((bg) => ({
    label: `context-menu explanation (70% text-secondary over text-primary) on ${bg}`,
    fg: { tint: "text-secondary", percent: 70, over: "text-primary" },
    bg,
    min: 4.5,
  })),
  ...["bg-elevated", "bg-elevated-hover"].map((bg) => ({
    label: `disabled menu row (50% text-muted over text-primary) on ${bg}`,
    fg: { tint: "text-muted", percent: 50, over: "text-primary" },
    bg,
    min: 4.5,
  })),
  ...["bg-elevated", "bg-elevated-hover"].map((bg) => ({
    label: `current workspace label (70% accent over text-primary) on ${bg}`,
    fg: { tint: "accent", percent: 70, over: "text-primary" },
    bg,
    min: 4.5,
  })),
  { label: "danger on bg-card", fg: "danger", bg: "bg-card", min: 4.5 },
  { label: "danger on bg-input", fg: "danger", bg: "bg-input", min: 4.5 },
  {
    label: "badge-neutral-text on badge-neutral-bg",
    fg: "badge-neutral-text",
    bg: "badge-neutral-bg",
    min: 4.5,
  },
  ...["system", "compartments", "facts", "memories", "conversation"].map((name) => ({
    label: `chart-${name}-text on chart-${name}`,
    fg: `chart-${name}-text`,
    bg: `chart-${name}`,
    min: 4.5,
  })),
  ...["bg-card", "bg-input", "bg-panel", "bg-base"].map((bg) => ({
    label: `border-control (input outline) vs ${bg}`,
    fg: "border-control",
    bg,
    min: 3,
  })),
  { label: "checkbox-border vs bg-card", fg: "checkbox-border", bg: "bg-card", min: 3 },
  ...SURFACES.map((bg) => ({ label: `focus-ring vs ${bg}`, fg: "focus-ring", bg, min: 3 })),
  ...["chart-good", "chart-warn", "chart-bad", "chart-info", "chart-neutral"].map((fg) => ({
    label: `${fg} mark vs bg-card`,
    fg,
    bg: "bg-card",
    min: 3,
  })),
  { label: "switch knob (on-accent) vs switch-on", fg: "on-accent", bg: "switch-on", min: 3 },
  // Pills also sit on the sidebar/status strip (bg-panel) and on hovered list
  // rows (bg-hover), not only on cards.
  ...PILL_COLORS.flatMap((color) =>
    ["bg-panel", "bg-hover"].map((surface) => ({
      label: `${color} pill text on its 15% tint over ${surface}`,
      fg: color,
      bg: { tint: color, percent: 15, over: surface },
      min: 4.5,
    })),
  ),
  // Status words (Live, bust counts, causes) are written straight on the page,
  // panel and hovered rows as well as on cards.
  ...["green", "amber", "red", "accent"].flatMap((color) =>
    ["bg-base", "bg-panel", "bg-hover"].map((bg) => ({
      label: `${color} text on ${bg}`,
      fg: color,
      bg,
      min: 4.5,
    })),
  ),
  // Cache timeline marks are drawn inside a segment box that washes the card
  // with 30% of bg-active; the window line is drawn over the same box.
  ...["chart-good", "chart-warn", "chart-bad", "chart-info", "chart-neutral", "chart-window"].map(
    (fg) => ({
      label: `${fg} mark vs the timeline box (30% bg-active over bg-card)`,
      fg,
      bg: { tint: "bg-active", percent: 30, over: "bg-card" },
      min: 3,
    }),
  ),
  { label: "chart-window line vs bg-card", fg: "chart-window", bg: "bg-card", min: 3 },
  { label: "switch knob (on-accent) vs switch-off", fg: "on-accent", bg: "switch-off", min: 3 },
];

const STYLES_PATH = resolve(import.meta.dir, "../src/styles.css");

function blockBody(css: string, selector: string): string {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`Theme block not found: ${selector}`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

/** Token name (without --) → raw declared value, for one theme. */
export function readThemeTokens(theme: ThemeName, css = readFileSync(STYLES_PATH, "utf8")) {
  const selector = theme === "light" ? ':root[data-theme="light"] {' : ':root,\n:root[data-theme="dark"] {';
  const tokens = new Map<string, string>();
  const body = blockBody(css, selector).replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
    tokens.set(match[1], match[2].trim());
  }
  return tokens;
}

function parseHex(value: string): Rgb | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value)?.[1];
  if (!hex) return null;
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as Rgb;
}

export function resolveToken(tokens: Map<string, string>, name: string, depth = 0): Rgb {
  const raw = tokens.get(name);
  if (raw === undefined) throw new Error(`Unknown token --${name}`);
  if (raw === "#fff" || raw === "white") return [255, 255, 255];
  const rgb = parseHex(raw);
  if (rgb) return rgb;
  const ref = /^var\(--([a-z0-9-]+)\)$/.exec(raw)?.[1];
  if (ref && depth < 8) return resolveToken(tokens, ref, depth + 1);
  throw new Error(`--${name} is not a plain colour: ${raw}`);
}

function resolveRef(tokens: Map<string, string>, ref: ColorRef): Rgb {
  if (typeof ref === "string") return resolveToken(tokens, ref);
  const tint = resolveToken(tokens, ref.tint);
  const over = resolveToken(tokens, ref.over);
  const p = ref.percent / 100;
  return tint.map((v, i) => Math.round(v * p + over[i] * (1 - p))) as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function evaluatePairs(theme: ThemeName, css?: string) {
  const tokens = readThemeTokens(theme, css);
  return CONTRAST_PAIRS.map((pair) => {
    const ratio = contrastRatio(resolveRef(tokens, pair.fg), resolveRef(tokens, pair.bg));
    return { ...pair, ratio, pass: ratio >= pair.min };
  });
}

if (import.meta.main) {
  for (const theme of ["light", "dark"] as const) {
    const rows = evaluatePairs(theme);
    const failing = rows.filter((row) => !row.pass).length;
    console.log(`\n${theme.toUpperCase()} theme: ${rows.length} pairs, ${failing} below minimum`);
    for (const row of rows) {
      console.log(
        `${row.pass ? "ok  " : "FAIL"} ${row.ratio.toFixed(2).padStart(5)} (min ${row.min})  ${row.label}`,
      );
    }
  }
}
