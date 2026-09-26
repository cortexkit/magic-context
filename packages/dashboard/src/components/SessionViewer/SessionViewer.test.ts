import { describe, expect, test } from "bun:test";
import { parseStoredHarnessFilter, sessionHarnessOptions } from "./SessionViewer";

describe("Sessions harness filter", () => {
  test("offers OpenCode 2 beside OpenCode", () => {
    expect(sessionHarnessOptions).toContainEqual({ value: "opencode2", label: "OpenCode 2" });
  });

  test("restores a saved OpenCode 2 filter", () => {
    expect(parseStoredHarnessFilter("opencode2")).toBe("opencode2");
    expect(parseStoredHarnessFilter("opencode")).toBe("opencode");
  });

  test("falls back to all for an unknown or empty saved value", () => {
    expect(parseStoredHarnessFilter("")).toBe("all");
    expect(parseStoredHarnessFilter("future-harness")).toBe("all");
  });
});
