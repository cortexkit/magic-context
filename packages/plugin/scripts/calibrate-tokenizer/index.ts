/**
 * Tokenizer calibration harness.
 *
 * Measures the token-count drift between local ai-tokenizer estimates and
 * actual provider token counts for our real production system prompt and tool
 * definitions. Hits each provider directly using OAuth/API tokens from
 * `~/.local/share/opencode/auth.json`. No OpenCode dependency.
 *
 * For each model:
 *   - Sends a SYSTEM-only request: real production system prompt + minimal user message.
 *   - Sends a TOOLS-only request: real production tools array + minimal user message.
 *   - Captures provider's reported input token count from the actual usage field.
 *   - Counts the same content locally with ai-tokenizer (raw + SDK with model calibration).
 *   - Computes drift ratios.
 *
 * Output: a per-model JSON report with system_ratio and tools_ratio that the
 * sidebar can use as static calibration multipliers.
 *
 * Usage:
 *   bun run packages/plugin/scripts/calibrate-tokenizer/index.ts
 *   bun run packages/plugin/scripts/calibrate-tokenizer/index.ts --only anthropic/claude-opus-4-7
 *   bun run packages/plugin/scripts/calibrate-tokenizer/index.ts --providers anthropic,openai
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Tokenizer, { models as aiTokenizerModels } from "ai-tokenizer";
import { count as sdkCount } from "ai-tokenizer/sdk";
import * as cl100kEncoding from "ai-tokenizer/encoding/cl100k_base";
import * as claudeEncoding from "ai-tokenizer/encoding/claude";
import * as o200kEncoding from "ai-tokenizer/encoding/o200k_base";
import * as p50kEncoding from "ai-tokenizer/encoding/p50k_base";

import { measureAnthropic } from "./providers/anthropic";
import { measureOpenAICodex } from "./providers/openai-codex";
import { measureOpenAICompatible } from "./providers/openai-compatible";

interface AuthFile {
    [provider: string]:
        | { type: "oauth"; access: string; refresh?: string; expires?: number }
        | { type: "api"; key: string };
}

interface ModelTest {
    label: string;
    provider: string;
    modelId: string;
    tokenizerKey: string | null;
}

interface ModelTestSet {
    tests: ModelTest[];
}

interface MeasurementResult {
    label: string;
    provider: string;
    modelId: string;
    tokenizerKey: string | null;
    systemTokens: {
        local_raw: number;
        local_sdk: number | null;
        api: number | null;
        ratio_raw: number | null;
        ratio_sdk: number | null;
    };
    toolsTokens: {
        local_raw: number;
        local_sdk: number | null;
        api: number | null;
        ratio_raw: number | null;
        ratio_sdk: number | null;
    };
    error: string | null;
    durationMs: number;
}

const ENCODINGS = {
    cl100k_base: cl100kEncoding,
    claude: claudeEncoding,
    o200k_base: o200kEncoding,
    p50k_base: p50kEncoding,
};

// biome-ignore lint/suspicious/noExplicitAny: ai-tokenizer types are very strict
const ALL_MODELS = aiTokenizerModels as unknown as Record<string, any>;

/**
 * Extract `chatgpt_account_id` from the JWT access token claims. The Codex
 * backend requires this header for every request; without it ChatGPT routes
 * the call to no account and returns 401.
 */
function extractCodexAccountId(accessToken: string): string | undefined {
    try {
        const parts = accessToken.split(".");
        if (parts.length !== 3) return undefined;
        const payload = parts[1];
        if (!payload) return undefined;
        const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
        const decoded = Buffer.from(padded, "base64").toString("utf-8");
        const claims = JSON.parse(decoded) as Record<string, unknown>;
        const auth = claims["https://api.openai.com/auth"] as
            | Record<string, unknown>
            | undefined;
        return auth?.chatgpt_account_id as string | undefined;
    } catch {
        return undefined;
    }
}

function pickEncoding(tokenizerKey: string | null): unknown {
    if (!tokenizerKey) return claudeEncoding;
    const m = ALL_MODELS[tokenizerKey];
    if (!m) return claudeEncoding;
    const enc = ENCODINGS[m.encoding as keyof typeof ENCODINGS];
    return enc ?? claudeEncoding;
}

function localCounts(
    systemText: string,
    toolsArray: unknown[],
    tokenizerKey: string | null,
): {
    systemRaw: number;
    systemSdk: number | null;
    toolsRaw: number;
    toolsSdk: number | null;
} {
    const enc = pickEncoding(tokenizerKey);
    // biome-ignore lint/suspicious/noExplicitAny: encoding type varies
    const tk = new Tokenizer(enc as any);
    const systemRaw = tk.count(systemText);
    const toolsRaw = tk.count(JSON.stringify(toolsArray));

    let systemSdk: number | null = null;
    let toolsSdk: number | null = null;

    if (tokenizerKey && ALL_MODELS[tokenizerKey]) {
        const m = ALL_MODELS[tokenizerKey];
        try {
            const sysResult = sdkCount({
                // biome-ignore lint/suspicious/noExplicitAny: cross-package type mismatch
                tokenizer: tk as any,
                model: m,
                messages: [
                    { role: "system", content: systemText },
                    { role: "user", content: "x" },
                ],
            });
            systemSdk = sysResult.total;
        } catch {
            systemSdk = null;
        }
        try {
            const tools = (toolsArray as Array<Record<string, unknown>>).map((t) => ({
                type: "function" as const,
                name: t.name as string,
                description: t.description as string,
                inputSchema: t.input_schema as Record<string, unknown>,
            }));
            const toolsResult = sdkCount({
                // biome-ignore lint/suspicious/noExplicitAny: cross-package type mismatch
                tokenizer: tk as any,
                model: m,
                messages: [{ role: "user", content: "x" }],
                tools,
            });
            toolsSdk = toolsResult.total;
        } catch {
            toolsSdk = null;
        }
    }

    return { systemRaw, systemSdk, toolsRaw, toolsSdk };
}

async function measureOne(
    test: ModelTest,
    auth: AuthFile,
    systemText: string,
    toolsArray: unknown[],
): Promise<MeasurementResult> {
    const start = Date.now();
    const local = localCounts(systemText, toolsArray, test.tokenizerKey);
    let systemApi: number | null = null;
    let toolsApi: number | null = null;
    let error: string | null = null;
    try {
        const authEntry = auth[test.provider];
        if (!authEntry) throw new Error(`No auth for provider ${test.provider}`);

        // Route OpenAI OAuth (ChatGPT Plus subscription) through the Codex backend
        // since `api.openai.com` requires a paid API key, while OAuth tokens work via
        // `chatgpt.com/backend-api/codex/responses`. The user's account chatgpt_account_id
        // is encoded inside the JWT access token claims.
        const useCodex =
            test.provider === "openai" &&
            authEntry.type === "oauth" &&
            !!authEntry.access;
        let measurements: { systemApi: number | null; toolsApi: number | null };
        if (test.provider === "anthropic") {
            measurements = await measureAnthropic(test, authEntry, systemText, toolsArray);
        } else if (useCodex) {
            const accountId = extractCodexAccountId(authEntry.access);
            measurements = await measureOpenAICodex(
                test,
                { type: "oauth", access: authEntry.access, accountId },
                systemText,
                toolsArray,
            );
        } else {
            measurements = await measureOpenAICompatible(test, authEntry, systemText, toolsArray);
        }
        systemApi = measurements.systemApi;
        toolsApi = measurements.toolsApi;
    } catch (e) {
        error = e instanceof Error ? e.message : String(e);
    }

    const durationMs = Date.now() - start;
    return {
        label: test.label,
        provider: test.provider,
        modelId: test.modelId,
        tokenizerKey: test.tokenizerKey,
        systemTokens: {
            local_raw: local.systemRaw,
            local_sdk: local.systemSdk,
            api: systemApi,
            ratio_raw: systemApi != null ? +(systemApi / local.systemRaw).toFixed(3) : null,
            ratio_sdk:
                systemApi != null && local.systemSdk
                    ? +(systemApi / local.systemSdk).toFixed(3)
                    : null,
        },
        toolsTokens: {
            local_raw: local.toolsRaw,
            local_sdk: local.toolsSdk,
            api: toolsApi,
            ratio_raw: toolsApi != null ? +(toolsApi / local.toolsRaw).toFixed(3) : null,
            ratio_sdk:
                toolsApi != null && local.toolsSdk ? +(toolsApi / local.toolsSdk).toFixed(3) : null,
        },
        error,
        durationMs,
    };
}

function parseArgs(): { only: string | null; providers: string[] | null } {
    const args = process.argv.slice(2);
    let only: string | null = null;
    let providers: string[] | null = null;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--only") {
            only = args[++i] ?? null;
        } else if (arg === "--providers") {
            const v = args[++i] ?? "";
            providers = v
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
        }
    }
    return { only, providers };
}

async function main(): Promise<void> {
    const { only, providers } = parseArgs();
    const here = new URL(".", import.meta.url).pathname;
    const systemText = readFileSync(join(here, "fixture-system.txt"), "utf-8");
    const toolsArray = JSON.parse(
        readFileSync(join(here, "fixture-tools.json"), "utf-8"),
    ) as unknown[];
    const testSet = JSON.parse(
        readFileSync(join(here, "models.json"), "utf-8"),
    ) as ModelTestSet;
    const auth = JSON.parse(
        readFileSync(join(homedir(), ".local/share/opencode/auth.json"), "utf-8"),
    ) as AuthFile;

    let tests = testSet.tests;
    if (only) tests = tests.filter((t) => t.label === only || t.modelId === only);
    if (providers) tests = tests.filter((t) => providers.includes(t.provider));

    console.log(
        `Calibration harness: ${tests.length} models, system=${systemText.length} chars, tools=${toolsArray.length} (${JSON.stringify(toolsArray).length} chars)`,
    );
    console.log("");

    const results: MeasurementResult[] = [];
    for (const test of tests) {
        process.stdout.write(`  ${test.label.padEnd(45, " ")} ... `);
        const r = await measureOne(test, auth, systemText, toolsArray);
        if (r.error) {
            process.stdout.write(`ERROR (${r.durationMs}ms) ${r.error.slice(0, 80)}\n`);
        } else {
            process.stdout.write(
                `system=${r.systemTokens.api ?? "—"} (raw ${r.systemTokens.local_raw}, ratio ${r.systemTokens.ratio_raw ?? "—"}x), tools=${r.toolsTokens.api ?? "—"} (raw ${r.toolsTokens.local_raw}, ratio ${r.toolsTokens.ratio_raw ?? "—"}x), ${r.durationMs}ms\n`,
            );
        }
        results.push(r);
    }

    const outPath = join(here, "results.json");
    writeFileSync(outPath, JSON.stringify(results, null, 2), "utf-8");
    console.log(`\nWrote ${outPath}`);

    // Summary
    console.log("\n=== Summary ===");
    console.log(
        "model".padEnd(45, " "),
        "sys.raw->api",
        " | ",
        "sys.sdk->api",
        " | ",
        "tools.raw->api",
        " | ",
        "tools.sdk->api",
    );
    for (const r of results) {
        if (r.error) {
            console.log(r.label.padEnd(45, " "), "ERROR:", r.error.slice(0, 60));
            continue;
        }
        console.log(
            r.label.padEnd(45, " "),
            (r.systemTokens.ratio_raw ?? "—").toString().padStart(11, " "),
            " | ",
            (r.systemTokens.ratio_sdk ?? "—").toString().padStart(11, " "),
            " | ",
            (r.toolsTokens.ratio_raw ?? "—").toString().padStart(13, " "),
            " | ",
            (r.toolsTokens.ratio_sdk ?? "—").toString().padStart(13, " "),
        );
    }
}

main().catch((err) => {
    console.error("Harness failed:", err);
    process.exit(1);
});
