import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "@magic-context/core/shared/sqlite";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import { diagnoseSmallWindows, findSmallWindows } from "./doctor-small-window";

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway storage directory with the measurements a host would have saved. */
function storage(): string {
    const dir = createTestTempDirFromPath(join(tmpdir(), "doctor-small-window-"));
    dirs.push(dir);
    const db = new Database(join(dir, "context.db"));
    db.exec(`
        CREATE TABLE tool_definition_measurements (provider_id TEXT, model_id TEXT, agent_name TEXT, tool_id TEXT, token_count INTEGER, recorded_at INTEGER);
        CREATE TABLE session_meta (session_id TEXT PRIMARY KEY, system_prompt_tokens INTEGER, last_observed_model_key TEXT, last_response_time INTEGER);
    `);
    const tool = db.prepare("INSERT INTO tool_definition_measurements VALUES (?, ?, ?, ?, ?, 1)");
    // The route of issue 860: 15,134 tokens of tool definitions in two tools.
    tool.run("litellm", "proxy-model", "build", "bash", 9_000);
    tool.run("litellm", "proxy-model", "build", "read", 6_134);
    // A large model with the same tools: fine.
    tool.run("anthropic", "claude-opus-5", "build", "bash", 9_000);
    tool.run("anthropic", "claude-opus-5", "build", "read", 6_134);
    const meta = db.prepare("INSERT INTO session_meta VALUES (?, ?, ?, ?)");
    meta.run("old", 2_000, "litellm/proxy-model", 1);
    meta.run("new", 6_062, "litellm/proxy-model", 2);
    meta.run("big", 6_062, "anthropic/claude-opus-5", 2);
    db.close();
    writeFileSync(
        join(dir, "model-context-limits-opencode.json"),
        JSON.stringify({
            "litellm/proxy-model": { limit: 60_000, contextLimit: 60_000, outputLimit: 32_000 },
            "anthropic/claude-opus-5": {
                limit: 200_000,
                contextLimit: 200_000,
                outputLimit: 32_000,
            },
        }),
    );
    return dir;
}

describe("doctor: models whose usable window is too small", () => {
    test("reports a configured model whose system prompt and tool definitions take over half of the reduction point", () => {
        expect(diagnoseSmallWindows(storage(), {})).toEqual([
            "Context window too small for litellm/proxy-model (agent build): the system prompt (6,062 tokens) and tool definitions (15,134 tokens) take 72% of the 29,250 tokens at which reduction starts, leaving about 8,054 tokens for the conversation. Raise the model's context setting or remove tools. (Usable window 45,000 tokens, execute threshold 65% from the default.)",
        ]);
    });

    test("uses the threshold the configuration sets for the model, tokens included", () => {
        // A token threshold of 40,000 on a 45,000-token usable window.
        const [line] = diagnoseSmallWindows(storage(), {
            tokens: { "litellm/proxy-model": 40_000 },
        });
        expect(line).toMatch(
            /take 53% of the (39,999|40,000) tokens at which reduction starts.*execute threshold 88\.9% from execute_threshold_tokens\.\)$/,
        );
        // A percentage threshold per model; at 20% reduction starts at 9,000.
        expect(
            diagnoseSmallWindows(storage(), {
                percentage: { default: 65, "litellm/proxy-model": 20 },
            })[0],
        ).toContain("execute threshold 20% from execute_threshold_percentage.");
        // Raised so the fixed part is under half of the reduction point: silent.
        expect(
            findSmallWindows({
                toolSets: [
                    {
                        providerId: "litellm",
                        modelId: "proxy-model",
                        agent: "build",
                        toolDefinitionTokens: 8_000,
                    },
                ],
                systemPromptTokens: new Map([["litellm/proxy-model", 6_062]]),
                limits: new Map([["litellm/proxy-model", { context: 60_000, output: 32_000 }]]),
                thresholds: {},
            }),
        ).toEqual([]);
    });

    test("says nothing for a model it cannot size", () => {
        const toolSets = [
            {
                providerId: "litellm",
                modelId: "proxy-model",
                agent: "build",
                toolDefinitionTokens: 15_134,
            },
        ];
        // No saved limits, or no measured system prompt.
        expect(
            findSmallWindows({
                toolSets,
                systemPromptTokens: new Map([["litellm/proxy-model", 6_062]]),
                limits: new Map(),
            }),
        ).toEqual([]);
        expect(
            findSmallWindows({
                toolSets,
                systemPromptTokens: new Map(),
                limits: new Map([["litellm/proxy-model", { context: 60_000, output: 32_000 }]]),
            }),
        ).toEqual([]);
    });

    test("needs no store at all", () => {
        const dir = createTestTempDirFromPath(join(tmpdir(), "doctor-small-window-empty-"));
        mkdirSync(dir, { recursive: true });
        dirs.push(dir);
        expect(diagnoseSmallWindows(dir, {})).toEqual([]);
    });
});
