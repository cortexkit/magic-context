import piLevels from "../../generated/pi-thinking-levels.json";
import { canonicalModelIdToPi } from "../../lib/model-ids";
import type { Harness } from "./harness-model-data";

const PI_LEVELS: Record<string, string[]> = Object.fromEntries(
  Object.entries(piLevels).flatMap(([levels, models]) =>
    models.map((model) => [model, levels.split(",")]),
  ),
);
const COMMON_VARIANTS = ["minimal", "low", "medium", "high", "xhigh", "max"];
const COMMON_THINKING = ["off", ...COMMON_VARIANTS];

export function qualifierOptions(
  harness: Harness,
  model: string | undefined,
  variants?: Record<string, string[]>,
): { values: string[]; known: boolean } {
  const exact = model
    ? harness === "opencode"
      ? variants?.[model]
      : harness === "pi"
        ? (PI_LEVELS[canonicalModelIdToPi(model)] ?? PI_LEVELS[model])
        : undefined
    : undefined;
  // Pi and OpenCode have different contracts. Never apply Pi's thinking map to OpenCode or OMP.
  return {
    values:
      exact ??
      (harness === "opencode"
        ? COMMON_VARIANTS
        : harness === "omp"
          ? [...COMMON_THINKING, "inherit", "auto"]
          : COMMON_THINKING),
    known: exact !== undefined,
  };
}
