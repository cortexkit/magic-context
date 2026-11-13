/**
 * Tokenizer calibration harness.
 *
 * Measures local tokenizer drift using provider count endpoints. Generation-only
 * routes require --allow-generation. PROSE uses only free counts and
 * public repository bytes plus synthetic history/memory, never private sessions.
 * Reports baseline-subtracted SYSTEM, TOOLS, PROSE and per-section prose ratios.
 *
 * Usage:
 *   bun run packages/plugin/scripts/calibrate-tokenizer/index.ts
 *   bun run packages/plugin/scripts/calibrate-tokenizer/index.ts --only anthropic/claude-opus-4-7
 *   bun run packages/plugin/scripts/calibrate-tokenizer/index.ts --providers anthropic,openai
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Tokenizer, { models as aiTokenizerModels } from "ai-tokenizer";
import { count as sdkCount } from "ai-tokenizer/sdk";
import * as cl100kEncoding from "ai-tokenizer/encoding/cl100k_base";
import * as claudeEncoding from "ai-tokenizer/encoding/claude";
import * as o200kEncoding from "ai-tokenizer/encoding/o200k_base";
import * as p50kEncoding from "ai-tokenizer/encoding/p50k_base";

import { buildProseProbe } from "./prose";
import { crossCheck } from "./cross-check";
import { measureAnthropic } from "./providers/anthropic";
import { type CountAdapter, CountHttpError } from "./providers/counting";
import { credentialsFromEnv, type Credentials, PROVIDER_VARIABLES } from "./credentials";
import { measureDeepseekOffline, OFFLINE_CAVEAT } from "./providers/deepseek";
import { measureMeta, META_COUNT_CAVEAT } from "./providers/meta";
import { measureGemini } from "./providers/gemini";
import { measureXai } from "./providers/xai";
import { measureZai } from "./providers/zai";
import { measureKimi } from "./providers/kimi";
import { measureOpenAI } from "./providers/openai";
import { measureOpenAICodex } from "./providers/openai-codex";
import { measureOpenAICompatible } from "./providers/openai-compatible";

const FREE_ADAPTERS: Record<string, { measure: CountAdapter; method: string }> = {
    deepseek: { measure: measureDeepseekOffline, method: "offline_hf_tokenizer" },
    meta: { measure: measureMeta, method: "input_tokens" },
    google: { measure: measureGemini, method: "countTokens" },
    xai: { measure: measureXai, method: "tokenize-text" },
    zai: { measure: measureZai, method: "paas/v4/tokenizer" },
    moonshot: { measure: measureKimi, method: "tokenizers/estimate-token-count" },
    openai: { measure: measureOpenAI, method: "responses/input_tokens" },
};

function authProvider(test: ModelTest): string {
    return test.label.startsWith("openai-codex/") ? "openai-codex" : test.provider;
}

function generationSkip(test: ModelTest): string {
    return authProvider(test) === "openai-codex"
        ? "no count endpoint; measuring it sends a real generation request with an uncapped reply read whole, drawing on the ChatGPT sign-in's limit; pass --allow-generation to do that"
        : "no count endpoint; measuring it sends a 1-token request; pass --allow-generation to do that";
}

export interface ModelTest {
    label: string;
    provider: string;
    modelId: string;
    tokenizerKey: string | null;
}

interface ModelTestSet {
    tests: ModelTest[];
}

interface MeasurementResult {
    method: string;
    caveat?: string;
    proseRatio: number | null;
    proseTokens: { local_raw: number; api: number | null };
    proseSections: Record<string, { local_raw: number; api: number; ratio: number }>;
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
                // ai-tokenizer types this against the AI SDK it peers with (5.x);
                // the 6.x installed for tests types tools as a record.
                tools: tools as never,
            });
            toolsSdk = toolsResult.total;
        } catch {
            toolsSdk = null;
        }
    }

    return { systemRaw, systemSdk, toolsRaw, toolsSdk };
}

export async function measureOne(
    test: ModelTest,
    auth: Credentials,
    systemText: string,
    toolsArray: unknown[],
    prose: Record<string, string>,
    allowGeneration = false,
): Promise<MeasurementResult> {
    const start = Date.now();
    const local = localCounts(systemText, toolsArray, test.tokenizerKey);
    let systemApi: number | null = null;
    let toolsApi: number | null = null;
    let error: string | null = null;
    let caveat: string | undefined = test.provider === "meta" ? META_COUNT_CAVEAT : test.provider === "deepseek" ? OFFLINE_CAVEAT : undefined;
    const adapter = FREE_ADAPTERS[authProvider(test)];
    let method = adapter?.method ?? (test.provider === "anthropic" ? "count_tokens" : "usage");
    // biome-ignore lint/suspicious/noExplicitAny: encoding type varies
    const tokenizer = new Tokenizer(pickEncoding(test.tokenizerKey) as any);
    const proseLocal = tokenizer.count(Object.values(prose).join("\n\n"));
    let proseApi: number | null = null;
    const proseSections: MeasurementResult["proseSections"] = {};
    try {
        if (!adapter && test.provider !== "anthropic" && !allowGeneration) {
            throw new Error(generationSkip(test));
        }
        const authEntry = auth[authProvider(test)];
        if (!authEntry) throw new Error(`SKIP: set ${PROVIDER_VARIABLES[authProvider(test)] ?? "a provider credential variable"}`);

        // Route OpenAI OAuth (ChatGPT Plus subscription) through the Codex backend
        // since `api.openai.com` requires a paid API key, while OAuth tokens work via
        // `chatgpt.com/backend-api/codex/responses`. The user's account chatgpt_account_id
        // is encoded inside the JWT access token claims.
        const useCodex =
            test.provider === "openai" &&
            authEntry.type === "oauth" &&
            !!authEntry.access;
        let measurements: { systemApi: number | null; toolsApi: number | null };
        if (adapter || test.provider === "anthropic") {
            if (adapter && authEntry.type !== "api") throw new Error("SKIP: counting requires an API key, not OAuth");
            const measured = adapter && authEntry.type === "api"
                ? await adapter.measure(test.modelId, authEntry.key, systemText, toolsArray, prose)
                : await measureAnthropic(test, authEntry, systemText, toolsArray, prose);
            measurements = measured;
            method = measured.method;
            if ("caveat" in measured && typeof measured.caveat === "string") caveat = measured.caveat;
            proseApi = measured.proseApi;
            for (const [name, api] of Object.entries(measured.sections)) {
                const local_raw = tokenizer.count(prose[name] ?? "");
                proseSections[name] = { local_raw, api, ratio: api / local_raw };
            }
        } else if (useCodex) {
            const accountId = extractCodexAccountId(authEntry.access);
            measurements = await measureOpenAICodex(
                test,
                { type: "oauth", access: authEntry.access, accountId },
                systemText,
                toolsArray,
                allowGeneration,
            );
        } else {
            measurements = await measureOpenAICompatible(test, authEntry, systemText, toolsArray, allowGeneration);
        }
        systemApi = measurements.systemApi;
        toolsApi = measurements.toolsApi;
    } catch (e) {
        if (e instanceof CountHttpError && (e.status === 401 || e.status === 403)) {
            throw new Error(`${authProvider(test)} ${test.modelId} HTTP ${e.status}`);
        }
        error = e instanceof Error ? e.message : String(e);
    }

    const durationMs = Date.now() - start;
    return {
        method,
        ...(caveat ? { caveat } : {}),
        proseRatio: proseApi === null ? null : proseApi / proseLocal,
        proseTokens: { local_raw: proseLocal, api: proseApi },
        proseSections,
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

export function parseArgs(args = process.argv.slice(2)): { only: string | null; providers: string[] | null; allowGeneration: boolean } {
    let allowGeneration = false;
    let only: string | null = null;
    let providers: string[] | null = null;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--allow-generation") {
            allowGeneration = true;
        } else if (arg === "--only") {
            only = args[++i] ?? null;
        } else if (arg === "--providers") {
            const v = args[++i] ?? "";
            providers = v
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
        }
    }
    return { only, providers, allowGeneration };
}

function writeResults(path: string, results: MeasurementResult[]): void {
    const previous = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as MeasurementResult[] : [];
    const measuredLabels = new Set(results.map((row) => row.label));
    writeFileSync(path, JSON.stringify([...previous.filter((row) => !measuredLabels.has(row.label)), ...results], null, 2), "utf8");
}

async function main(): Promise<void> {
    const { only, providers, allowGeneration } = parseArgs();
    const auth = credentialsFromEnv(process.env);
    const here = new URL(".", import.meta.url).pathname;
    const systemText = readFileSync(join(here, "fixture-system.txt"), "utf-8");
    const toolsArray = JSON.parse(
        readFileSync(join(here, "fixture-tools.json"), "utf-8"),
    ) as unknown[];
    const testSet = JSON.parse(
        readFileSync(join(here, "models.json"), "utf-8"),
    ) as ModelTestSet;
    const prose = buildProseProbe();

    let tests = testSet.tests;
    if (only) tests = tests.filter((t) => only.split(",").includes(t.label) || only.split(",").includes(t.modelId));
    if (providers) tests = tests.filter((t) => providers.includes(t.provider));
    const missing = new Set<string>();
    tests = tests.filter((test) => {
        const provider = authProvider(test);
        if (!FREE_ADAPTERS[provider] && provider !== "anthropic" && !allowGeneration) {
            console.log(`${test.label}: ${generationSkip(test)}`);
            return false;
        }
        if (auth[provider]) return true;
        if (!missing.has(provider)) console.log(`${provider}: SKIP: set ${PROVIDER_VARIABLES[provider]}`);
        missing.add(provider);
        return false;
    });

    console.log(
        `Calibration harness: ${tests.length} models, system=${systemText.length} chars, tools=${toolsArray.length} (${JSON.stringify(toolsArray).length} chars)`,
    );
    console.log("");

    const results: MeasurementResult[] = [];
    for (const test of tests) {
        process.stdout.write(`  ${test.label.padEnd(45, " ")} ... `);
        const r = await measureOne(test, auth, systemText, toolsArray, prose, allowGeneration);
        if (r.error) {
            process.stdout.write(`SKIP (${r.durationMs}ms) ${r.error}\n`);
        } else {
            process.stdout.write(
                `system=${r.systemTokens.api ?? "—"} (raw ${r.systemTokens.local_raw}, ratio ${r.systemTokens.ratio_raw ?? "—"}x), tools=${r.toolsTokens.api ?? "—"} (raw ${r.toolsTokens.local_raw}, ratio ${r.toolsTokens.ratio_raw ?? "—"}x), ${r.durationMs}ms\n`,
            );
        }
        results.push(r);
        console.log(`method=${r.method}, proseRatio=${r.proseRatio ?? "skipped"}`, r.proseSections);
        const check = !r.error && r.method !== "usage" ? crossCheck(test.provider, test.modelId, (r.systemTokens.api ?? 0) / r.systemTokens.local_raw, (r.toolsTokens.api ?? 0) / r.toolsTokens.local_raw) : null;
        if (check) {
            console.log(`Cross-check delta: system=${check.systemDelta * 100}%, tools=${check.toolsDelta * 100}%`);
            if (check.failed) {
                writeResults(join(here, "results.json"), results);
                throw new Error("Cross-check exceeds 5%; stopped without changing calibration table");
            }
        }
    }

    const outPath = join(here, "results.json");
    writeResults(outPath, results);
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

if (import.meta.main) main().catch((err) => {
    console.error("Harness failed:", err instanceof Error ? err.message : "unknown error");
    process.exit(1);
});
