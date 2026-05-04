import { afterEach, describe, expect, test } from "bun:test";
import {
    __resetToolDefinitionMeasurements,
    getMeasuredToolDefinitionTokens,
    getToolDefinitionSnapshot,
    recordToolDefinition,
} from "./tool-definition-tokens";

describe("tool-definition-tokens", () => {
    afterEach(() => {
        __resetToolDefinitionMeasurements();
    });

    test("returns undefined before any measurement", () => {
        expect(
            getMeasuredToolDefinitionTokens("anthropic", "claude-sonnet-4.7", "sisyphus"),
        ).toBeUndefined();
    });

    test("records and retrieves tokens for a provider/model/agent key", () => {
        recordToolDefinition(
            "anthropic",
            "claude-sonnet-4.7",
            "sisyphus",
            "bash",
            "Run a shell command",
            { type: "object", properties: { command: { type: "string" } } },
        );
        const total = getMeasuredToolDefinitionTokens("anthropic", "claude-sonnet-4.7", "sisyphus");
        expect(total).toBeGreaterThan(0);
        // Description + serialized params should both contribute.
        expect(total).toBeGreaterThan(5);
    });

    test("sums multiple tools under same key", () => {
        recordToolDefinition("p", "m", "a", "bash", "Run a shell command", {
            type: "object",
        });
        recordToolDefinition("p", "m", "a", "edit", "Edit a file", {
            type: "object",
        });
        const total = getMeasuredToolDefinitionTokens("p", "m", "a") ?? 0;
        expect(total).toBeGreaterThan(0);

        // Removing one tool via a snapshot helper doesn't exist — idempotent
        // re-record should replace, not add.
        recordToolDefinition("p", "m", "a", "bash", "Run a shell command", {
            type: "object",
        });
        const after = getMeasuredToolDefinitionTokens("p", "m", "a") ?? 0;
        expect(after).toBe(total);
    });

    test("isolates measurements by agent within same model", () => {
        recordToolDefinition("p", "m", "sisyphus", "bash", "x".repeat(100), {});
        recordToolDefinition("p", "m", "historian", "summarize", "y".repeat(50), {});
        const a = getMeasuredToolDefinitionTokens("p", "m", "sisyphus") ?? 0;
        const b = getMeasuredToolDefinitionTokens("p", "m", "historian") ?? 0;
        expect(a).toBeGreaterThan(0);
        expect(b).toBeGreaterThan(0);
        expect(a).not.toBe(b);
    });

    test("isolates measurements by model within same agent", () => {
        recordToolDefinition("p", "model-a", "sisyphus", "bash", "x".repeat(100), {});
        recordToolDefinition("p", "model-b", "sisyphus", "bash", "x".repeat(50), {});
        const a = getMeasuredToolDefinitionTokens("p", "model-a", "sisyphus") ?? 0;
        const b = getMeasuredToolDefinitionTokens("p", "model-b", "sisyphus") ?? 0;
        expect(a).toBeGreaterThan(b);
    });

    test("treats missing agent as 'default' scope", () => {
        recordToolDefinition("p", "m", undefined, "bash", "x".repeat(40), {});
        const explicit = getMeasuredToolDefinitionTokens("p", "m", "default");
        const implicit = getMeasuredToolDefinitionTokens("p", "m", undefined);
        expect(explicit).toBe(implicit);
        expect(implicit).toBeGreaterThan(0);
    });

    test("same toolID on later flight overwrites its slot, not accumulates", () => {
        recordToolDefinition("p", "m", "a", "bash", "v1 description", { v: 1 });
        const first = getMeasuredToolDefinitionTokens("p", "m", "a") ?? 0;
        recordToolDefinition("p", "m", "a", "bash", "v2 description", { v: 2 });
        const second = getMeasuredToolDefinitionTokens("p", "m", "a") ?? 0;
        // Second flight replaces first — totals should reflect v2 only, not v1+v2.
        expect(second).toBeGreaterThan(0);
        expect(second).not.toBe(first * 2);
    });

    test("ignores invalid inputs", () => {
        recordToolDefinition("", "m", "a", "bash", "desc", {});
        recordToolDefinition("p", "", "a", "bash", "desc", {});
        recordToolDefinition("p", "m", "a", "", "desc", {});
        expect(getMeasuredToolDefinitionTokens("", "m", "a")).toBeUndefined();
        expect(getMeasuredToolDefinitionTokens("p", "", "a")).toBeUndefined();
        expect(getMeasuredToolDefinitionTokens("p", "m", "a")).toBeUndefined();
    });

    test("handles unserializable parameters without throwing", () => {
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        // Should not throw even when JSON.stringify would fail.
        recordToolDefinition("p", "m", "a", "bad-tool", "desc", circular);
        const total = getMeasuredToolDefinitionTokens("p", "m", "a") ?? 0;
        // Description still contributes even if params can't be serialized.
        expect(total).toBeGreaterThan(0);
    });

    test("snapshot helper lists all measurements", () => {
        recordToolDefinition("anthropic", "sonnet", "sisyphus", "bash", "a", {});
        recordToolDefinition("openai", "gpt-5", "historian", "sum", "b", {});
        const snapshot = getToolDefinitionSnapshot();
        expect(snapshot.length).toBe(2);
        expect(snapshot.every((s) => s.totalTokens > 0)).toBe(true);
        expect(snapshot.every((s) => s.toolCount === 1)).toBe(true);
    });
});
