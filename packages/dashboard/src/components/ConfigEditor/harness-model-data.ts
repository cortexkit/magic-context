import { ompModelIdToCanonical, piModelIdToCanonical } from "../../lib/model-ids";

export type Harness = "opencode" | "pi" | "omp";

export function modelCatalogForHarness(
  catalogs: Record<Harness, string[]>,
  harness: Harness,
): string[] {
  const canonicalize =
    harness === "pi" ? piModelIdToCanonical : harness === "omp" ? ompModelIdToCanonical : undefined;
  return [...new Set(canonicalize ? catalogs[harness].map(canonicalize) : catalogs[harness])];
}

export type OpenCodeModelEntry = string | { model: string; variant?: string };
export type PiModelEntry = string | { model: string; thinking_level?: string };
export type ModelEntry = OpenCodeModelEntry | PiModelEntry;

const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const OMP_THINKING_LEVELS = [...PI_THINKING_LEVELS, "inherit", "auto"] as const;

export function thinkingLevelsForHarness(harness: Harness): readonly string[] {
  return harness === "omp" ? OMP_THINKING_LEVELS : PI_THINKING_LEVELS;
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function modelId(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const candidate = record(value).model;
  return typeof candidate === "string" ? candidate : undefined;
}

export function modelQualifier(value: unknown, harness: Harness): string | undefined {
  const candidate = record(value)[harness === "opencode" ? "variant" : "thinking_level"];
  return typeof candidate === "string" ? candidate : undefined;
}

export function modelEntryWithModel(
  value: unknown,
  harness: Harness,
  model: string | undefined,
): ModelEntry | undefined {
  if (!model) return undefined;
  const qualifier = modelQualifier(value, harness);
  return qualifier ? modelEntryWithQualifier(model, harness, qualifier) : model;
}

export function modelEntryWithQualifier(
  value: unknown,
  harness: Harness,
  qualifier: string | undefined,
): ModelEntry | undefined {
  const model = modelId(value);
  if (!model) return undefined;
  if (!qualifier) return model;
  return harness === "opencode"
    ? { model, variant: qualifier }
    : { model, thinking_level: qualifier };
}

export function fallbackEntries(value: unknown): ModelEntry[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is ModelEntry => Boolean(modelId(entry)))
    : [];
}
