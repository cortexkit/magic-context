export const PER_MODEL_KEYS = [
  "cache_ttl",
  "execute_threshold_percentage",
  "execute_threshold_tokens",
  "output_reserve",
  "keep_reasoning_tokens",
] as const;
export type PerModelKey = (typeof PER_MODEL_KEYS)[number];
export type PerModelValues = Partial<Record<PerModelKey, unknown>>;

export function modelValues(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : value === undefined
      ? {}
      : { default: value };
}

export function overrideModels(values: PerModelValues): string[] {
  return [
    ...new Set(PER_MODEL_KEYS.flatMap((key) => Object.keys(modelValues(values[key])))),
  ].filter((model) => model !== "default");
}

/** Preserve the scalar/map shape where possible; token thresholds are always maps. */
export function editModelCell(
  value: unknown,
  key: PerModelKey,
  model: string,
  input: string,
): unknown {
  const next = modelValues(value);
  if (input.trim() === "") delete next[model];
  else next[model] = key === "cache_ttl" ? input : Number(input);
  const names = Object.keys(next);
  if (names.length === 0) return undefined;
  if (key !== "execute_threshold_tokens" && names.length === 1 && names[0] === "default") {
    return next.default;
  }
  // The scalar-or-map schemas require a default when exceptions are present.
  // Output reserve has a derived fallback, not a schema number; don't invent one.
  if (
    key !== "execute_threshold_tokens" &&
    next.default === undefined &&
    configDefault(key) !== undefined
  ) {
    next.default = configDefault(key);
  }
  return next;
}

export function removeModelRow(values: PerModelValues, model: string): PerModelValues {
  return Object.fromEntries(
    PER_MODEL_KEYS.map((key) => [key, editModelCell(values[key], key, model, "")]),
  );
}

/** Empty rows are editor drafts, not fabricated overrides in the saved config. */
export function addModelRow(rows: string[], model: string): string[] {
  return model && model !== "default" && !rows.includes(model) ? [...rows, model] : rows;
}

import { configDefault } from "./config-schema";
