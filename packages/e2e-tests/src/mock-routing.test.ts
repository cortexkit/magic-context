import { openTestDb } from "./test-db";
import { describe, expect, it } from "bun:test";
import { assertHistorianMockRouting, assertMockEndpoint, assertMockProviders, pinMockAgents } from "./mock-routing";

describe("mock child-agent routing", () => {
  it("pins omitted and blank models without enabling the dreamer", () => {
    expect(pinMockAgents({ historian: { model: "", disable: true } }, "mock/main")).toEqual({
      historian: { opencode: { model: "mock/main" }, disable: true },
      dreamer: { opencode: { model: "mock/main" }, disable: true },
    });
  });

  it("writes the OpenCode 2 host's model under the block the model resolver reads", () => {
    // `opencode2` is a host, not a model harness: both OpenCode generations
    // resolve agent models from `opencode`. Writing an `opencode2` block left
    // the historian with no model at all on the v2 lane.
    expect(pinMockAgents({ historian: {} }, "mock/main", "opencode2")).toMatchObject({
      historian: { opencode: { model: "mock/main" } },
    });
    expect(
      Object.keys(
        (pinMockAgents({ historian: {} }, "mock/main", "opencode2").historian ?? {}) as Record<
          string,
          unknown
        >,
      ),
    ).not.toContain("opencode2");
  });

  it("rejects off-mock primary, harness-specific and fallback child models", () => {
    for (const historian of [
      { model: "anthropic/real" },
      { opencode: { model: "anthropic/real" } },
      { fallback_models: ["anthropic/real"] },
    ]) {
      expect(() => pinMockAgents({ historian }, "mock/main")).toThrow("must use mock model");
    }
  });

  it("pins an agent to its own named mock model and rejects any other", () => {
    expect(
      pinMockAgents({ historian: {} }, "mock/main", "opencode", { historian: "mock/historian" }),
    ).toEqual({
      historian: { opencode: { model: "mock/historian" } },
      dreamer: { opencode: { model: "mock/main" }, disable: true },
    });
    expect(
      pinMockAgents({ historian: { opencode: { model: "mock/historian" } } }, "mock/main", "opencode", {
        historian: "mock/historian",
      }),
    ).toMatchObject({ historian: { opencode: { model: "mock/historian" } } });
    // Naming a separate historian model does not open the historian to the host
    // model or to anything else.
    for (const historian of [{ model: "mock/main" }, { opencode: { model: "anthropic/real" } }]) {
      expect(() =>
        pinMockAgents({ historian }, "mock/main", "opencode", { historian: "mock/historian" }),
      ).toThrow("must use mock model mock/historian");
    }
  });

  it("rejects a real provider endpoint even when a mock model name is used", () => {
    expect(() =>
      assertMockEndpoint("https://api.anthropic.com/v1", "http://127.0.0.1:1234"),
    ).toThrow("Off-mock provider endpoint");
    expect(() =>
      assertMockEndpoint("https://api.anthropic.com/v1", "https://api.anthropic.com/v1"),
    ).toThrow("expected loopback");
    assertMockEndpoint("http://127.0.0.1:1234", "http://127.0.0.1:1234");
  });

  it("rejects an external historian attempt even after successful mock fallback", () => {
    const db = openTestDb(":memory:");
    try {
      db.exec(
        "CREATE TABLE subagent_invocations (harness TEXT, subagent TEXT, provider_id TEXT, model_id TEXT)",
      );
      db.exec(
        "INSERT INTO subagent_invocations VALUES ('opencode', 'historian', 'anthropic', 'claude-fable-5-1'), ('opencode', 'historian', 'mock-anthropic', 'mock-sonnet')",
      );
      expect(() =>
        assertHistorianMockRouting(db, "opencode", "mock-anthropic/mock-sonnet"),
      ).toThrow("Off-mock historian request");
      db.exec("DELETE FROM subagent_invocations WHERE provider_id = 'anthropic'");
      assertHistorianMockRouting(db, "opencode", "mock-anthropic/mock-sonnet");
    } finally {
      db.close();
    }
  });
});

it("rejects extra effective providers even when the configured mock is correct", () => {
  const expected = "http://127.0.0.1:1234";
  const mock = { options: { baseURL: expected } };
  assertMockProviders({ providers: [mock] }, expected);
  expect(() => assertMockProviders({ providers: [mock, { options: {} }] }, expected)).toThrow("Off-mock");
  expect(() => assertMockProviders({ providers: [mock, { options: { baseURL: "http://127.0.0.1:53864" } }] }, expected)).toThrow("Off-mock");
  expect(() => assertMockProviders({ providers: [] }, expected)).toThrow("Missing effective");
});
