import type { Harness } from "../../lib/types";

export type HarnessFilter = "all" | Harness;

export const sessionHarnessOptions: { value: HarnessFilter; label: string }[] = [
  { value: "all", label: "Harness: All" },
  { value: "opencode", label: "OpenCode" },
  { value: "opencode2", label: "OpenCode 2" },
  { value: "pi", label: "Pi" },
  { value: "omp", label: "OMP" },
];

/** The saved harness filter, or "all" when nothing (or an unknown value) is saved. */
export function parseStoredHarnessFilter(stored: string): HarnessFilter {
  return sessionHarnessOptions.find((option) => option.value === stored)?.value ?? "all";
}
