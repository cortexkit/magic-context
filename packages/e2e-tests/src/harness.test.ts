import { describe, expect, it } from "bun:test";
import { TestHarness } from "./harness";

function harnessReturning(data: unknown): TestHarness {
  return Object.assign(Object.create(TestHarness.prototype), {
    clientInstance: { session: { prompt: async () => ({ data }) } },
    opencodeInstance: { stdout: () => "", stderr: () => "" },
    spawnOptions: {},
    expectMagicContext: false,
  });
}

describe("OpenCode prompt completion", () => {
  it("rejects an embedded assistant API error despite a successful SDK envelope", async () => {
    const h = harnessReturning({
      info: {
        role: "assistant",
        error: {
          name: "APIError",
          data: { message: "Not Found: Not found", statusCode: 404 },
        },
      },
      parts: [],
    });
    await expect(h.sendPrompt("session", "hello", { timeoutMs: 100 })).rejects.toThrow("404");
  });

  it("returns a successful assistant response unchanged", async () => {
    const data = { info: { role: "assistant", finish: "stop" }, parts: [] };
    await expect(harnessReturning(data).sendPrompt("session", "hello", { timeoutMs: 100 })).resolves.toEqual({ data });
  });
});
