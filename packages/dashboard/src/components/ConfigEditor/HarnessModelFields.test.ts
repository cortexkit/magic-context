import { describe, expect, it } from "bun:test";
import {
  fallbackEntries,
  modelCatalogForHarness,
  modelEntryWithModel,
  modelEntryWithQualifier,
  modelId,
  modelQualifier,
  thinkingLevelsForHarness,
} from "./harness-model-data";

describe("harness model entries", () => {
  it("selects each harness catalog from one generation pair without cross-leakage", () => {
    const catalogs = {
      opencode: ["openai/opencode-only", "anthropic/shared"],
      pi: ["github-copilot/pi-only", "anthropic/shared"],
      omp: ["opencode-zen/omp-only", "anthropic/shared"],
    };

    expect(modelCatalogForHarness(catalogs, "opencode")).toEqual([
      "openai/opencode-only",
      "anthropic/shared",
    ]);
    expect(modelCatalogForHarness(catalogs, "pi")).toEqual([
      "github-copilot/pi-only",
      "anthropic/shared",
    ]);
    expect(modelCatalogForHarness(catalogs, "omp")).toEqual([
      "opencode/omp-only",
      "anthropic/shared",
    ]);
  });

  it("keeps free-text provider/model values usable", () => {
    expect(modelEntryWithModel(undefined, "opencode", "private/model")).toBe("private/model");
    expect(modelEntryWithModel(undefined, "pi", "local/model")).toBe("local/model");
    expect(modelEntryWithModel(undefined, "omp", "private/omp-model")).toBe("private/omp-model");
  });

  it("writes only the selected harness qualifier", () => {
    const openCodeEntry = modelEntryWithQualifier("openai/gpt-5", "opencode", "high");
    const piEntry = modelEntryWithQualifier("openai/gpt-5", "pi", "high");
    const ompEntry = modelEntryWithQualifier("opencode/gpt-5", "omp", "auto");

    expect(openCodeEntry).toEqual({ model: "openai/gpt-5", variant: "high" });
    expect(piEntry).toEqual({ model: "openai/gpt-5", thinking_level: "high" });
    expect(ompEntry).toEqual({ model: "opencode/gpt-5", thinking_level: "auto" });
    expect(modelQualifier(openCodeEntry, "pi")).toBeUndefined();
    expect(modelQualifier(piEntry, "opencode")).toBeUndefined();
    expect(modelQualifier(ompEntry, "omp")).toBe("auto");
  });

  it("offers OMP's thinking-level superset without widening Pi", () => {
    expect(thinkingLevelsForHarness("omp")).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "inherit",
      "auto",
    ]);
    expect(thinkingLevelsForHarness("pi")).not.toContain("auto");
  });

  it("keeps fallback entries separate and ignores malformed values", () => {
    const entries = fallbackEntries([
      "anthropic/claude-sonnet",
      { model: "openai/gpt-5", variant: "fast" },
      { model: 42 },
      null,
    ]);

    expect(entries).toEqual([
      "anthropic/claude-sonnet",
      { model: "openai/gpt-5", variant: "fast" },
    ]);
    expect(modelId(entries[1])).toBe("openai/gpt-5");
  });
});
