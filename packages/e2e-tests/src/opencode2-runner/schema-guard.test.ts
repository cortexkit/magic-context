import { expect, test } from "bun:test";
import { requireSchemaGuard, schemaGeneration } from "./schema-guard";
import type { PluginActivationClient } from "./plugin-activation";

test("the schema oracle selects exact supported host generations and refuses unknown hosts", () => {
	expect(schemaGeneration("opencode v2.0.22")).toBe("2.0");
	expect(schemaGeneration("opencode v2.0.32")).toBe("2.0");
	expect(schemaGeneration("opencode v2.1.0")).toBe("2.1");
	expect(() => schemaGeneration("opencode v2.2.0")).toThrow(
		"No e2e LLM schema bundle",
	);
});

test("fixture readiness refuses a failed schema guard even when Magic Context is active", async () => {
	const client: PluginActivationClient = {
		event: {
			subscribe: async function* () {
				throw new Error("terminal inventory must not subscribe");
			},
		},
		plugin: {
			list: async () => ({
				data: [
					{ id: "opencode-magic-context", state: { status: "active" } },
					{
						id: "mc-e2e-llm-schema-guard",
						state: { status: "failed", error: "foreign Effect import" },
					},
				],
			}),
		},
	};
	await expect(requireSchemaGuard(client, "/private-fixture")).rejects.toThrow(
		"foreign Effect import",
	);
	client.plugin.list = async () => ({
		data: [{ id: "mc-e2e-llm-schema-guard", state: { status: "active" } }],
	});
	await expect(
		requireSchemaGuard(client, "/private-fixture"),
	).resolves.toBeUndefined();
});

test("an unpinned 2.2 host requires an exact external schema version", () => {
	expect(schemaGeneration("opencode v2.2.2", "2.2.2")).toBe("2.2");
	expect(() => schemaGeneration("opencode v2.2.2", "2.2.1")).toThrow("No e2e LLM schema bundle");
	expect(() => schemaGeneration("opencode v2.3.0", "2.3.0")).toThrow("No e2e LLM schema bundle");
});
