import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EMBEDDING_DIMENSIONS_MAX, resolveProbeDimensions } from "./embedding-probe-dimensions";

describe("resolveProbeDimensions", () => {
  it("omits the field only when it is unset", () => {
    expect(resolveProbeDimensions(undefined)).toEqual({ ok: true, dimensions: null });
  });

  it("sends a valid width unchanged", () => {
    for (const width of [1, 768, EMBEDDING_DIMENSIONS_MAX]) {
      expect(resolveProbeDimensions(width)).toEqual({ ok: true, dimensions: width });
    }
  });

  // The runtime treats these as a recovered (untrusted) embedding field and pauses
  // registration, so the probe must fail instead of testing the default width.
  it("rejects every value the runtime schema rejects", () => {
    for (const bad of [0, -1, 1.5, EMBEDDING_DIMENSIONS_MAX + 1, "768", null, true, Number.NaN]) {
      const result = resolveProbeDimensions(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("embedding.dimensions");
    }
  });

  it("uses the same upper bound as the runtime schema", () => {
    const schema = readFileSync(
      resolve(import.meta.dir, "../../../../plugin/src/config/schema/magic-context.ts"),
      "utf-8",
    );
    expect(schema).toMatch(
      new RegExp(
        `dimensions: z\\s*\\.number\\(\\)\\s*\\.int\\(\\)\\s*\\.min\\(1\\)\\s*\\.max\\(${EMBEDDING_DIMENSIONS_MAX}\\)`,
      ),
    );
  });
});
