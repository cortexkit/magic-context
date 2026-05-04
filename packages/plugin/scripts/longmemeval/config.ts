import { dirname, join, resolve } from "node:path";
import {
    LONGMEMEVAL_QUESTION_TYPES,
    isLongMemEvalQuestionType,
    type LongMemEvalQuestionType,
    type PricingConfig,
    type RunnerConfig,
    type RunnerPaths,
} from "./types";

function parseIntegerFlag(value: string | undefined, flagName: string): number {
    if (!value) throw new Error(`Missing value for ${flagName}`);
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
        throw new Error(`Invalid value for ${flagName}: ${value}`);
    }
    return parsed;
}

function parseStringList(value: string | undefined): string[] {
    if (!value) return [];
    return value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}

function parseQuestionTypes(value: string | undefined): LongMemEvalQuestionType[] {
    const parsed = parseStringList(value);
    if (parsed.length === 0) {
        return [...LONGMEMEVAL_QUESTION_TYPES];
    }

    const invalid = parsed.filter((entry) => !isLongMemEvalQuestionType(entry));
    if (invalid.length > 0) {
        throw new Error(
            `Invalid --types value(s): ${invalid.join(", ")}. Valid values: ${LONGMEMEVAL_QUESTION_TYPES.join(", ")}`,
        );
    }

    return parsed.filter((entry): entry is LongMemEvalQuestionType => isLongMemEvalQuestionType(entry));
}

function parseBooleanFlag(argv: string[], name: string): boolean {
    return argv.includes(name);
}

function getFlagValue(argv: string[], name: string): string | undefined {
    const index = argv.indexOf(name);
    if (index === -1) return undefined;
    return argv[index + 1];
}

function getRequiredFlag(argv: string[], name: string): string {
    const value = getFlagValue(argv, name);
    if (!value) {
        throw new Error(`Missing required flag ${name}`);
    }
    return value;
}

function buildRunnerPaths(datasetPath: string, outputDirArg?: string): RunnerPaths {
    const datasetBaseName = datasetPath
        .split(/[\\/]/)
        .pop()
        ?.replace(/\.[^.]+$/, "")
        .replace(/[^a-zA-Z0-9_-]+/g, "-")
        .toLowerCase();

    const outputDir = outputDirArg
        ? resolve(outputDirArg)
        : resolve(dirname(datasetPath), `${datasetBaseName ?? "longmemeval"}-run`);

    return {
        outputDir,
        stateFile: join(outputDir, "runner-state.json"),
        resultsFile: join(outputDir, "results.jsonl"),
        summaryFile: join(outputDir, "summary.json"),
        logFile: join(outputDir, "runner.log"),
    };
}

function buildSelectionSignature(config: {
    datasetPath: string;
    start?: number;
    end?: number;
    types: string[];
    questionIds: string[];
}): string {
    return JSON.stringify({
        datasetPath: config.datasetPath,
        start: config.start ?? null,
        end: config.end ?? null,
        types: [...config.types].sort(),
        questionIds: [...config.questionIds].sort(),
    });
}

export function estimateCostFromPricing(tokens: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
}, pricing: PricingConfig): number {
    const inputCost = (tokens.inputTokens / 1_000_000) * pricing.inputPerMillionUsd;
    const outputCost = (tokens.outputTokens / 1_000_000) * pricing.outputPerMillionUsd;
    const reasoningCost =
        pricing.reasoningPerMillionUsd !== undefined
            ? (tokens.reasoningTokens / 1_000_000) * pricing.reasoningPerMillionUsd
            : 0;
    const cacheReadCost =
        pricing.cachedInputPerMillionUsd !== undefined
            ? (tokens.cacheReadTokens / 1_000_000) * pricing.cachedInputPerMillionUsd
            : 0;
    const cacheWriteCost =
        pricing.cacheWritePerMillionUsd !== undefined
            ? (tokens.cacheWriteTokens / 1_000_000) * pricing.cacheWritePerMillionUsd
            : 0;

    return inputCost + outputCost + reasoningCost + cacheReadCost + cacheWriteCost;
}

export function parseRunnerConfig(argv: string[], projectDirectory: string): RunnerConfig {
    const datasetPath = resolve(getRequiredFlag(argv, "--dataset"));
    const start = getFlagValue(argv, "--start");
    const end = getFlagValue(argv, "--end");
    const outputDir = getFlagValue(argv, "--output-dir");
    const openCodeBaseUrl =
        getFlagValue(argv, "--opencode-url") ?? process.env.OPENCODE_BASE_URL ?? "http://127.0.0.1:21354";
    const turnDelayMs = parseBooleanFlag(argv, "--fast")
        ? 50
        : Number.parseInt(getFlagValue(argv, "--turn-delay-ms") ?? "2000", 10);
    const sessionDelayMs = parseBooleanFlag(argv, "--fast")
        ? 250
        : Number.parseInt(getFlagValue(argv, "--session-delay-ms") ?? "10000", 10);
    const finalQuestionDelayMs = parseBooleanFlag(argv, "--fast")
        ? 50
        : Number.parseInt(getFlagValue(argv, "--final-delay-ms") ?? "1000", 10);
    const parallelism = Number.parseInt(getFlagValue(argv, "--parallel") ?? "1", 10);
    const cleanupSessions = parseBooleanFlag(argv, "--cleanup");
    const resume = parseBooleanFlag(argv, "--resume");
    const fastMode = parseBooleanFlag(argv, "--fast");
    const types = parseQuestionTypes(getFlagValue(argv, "--types"));
    const questionIds = parseStringList(getFlagValue(argv, "--question-ids"));
    const paths = buildRunnerPaths(datasetPath, outputDir);
    const selectionSignature = buildSelectionSignature({
        datasetPath,
        start: start ? parseIntegerFlag(start, "--start") : undefined,
        end: end ? parseIntegerFlag(end, "--end") : undefined,
        types,
        questionIds,
    });

    return {
        datasetPath,
        projectDirectory,
        openCodeBaseUrl,
        openCodeRequestTimeoutMs: Number.parseInt(
            getFlagValue(argv, "--request-timeout-ms") ?? "300000",
            10,
        ),
        turnDelayMs,
        sessionDelayMs,
        finalQuestionDelayMs,
        parallelism,
        cleanupSessions,
        fastMode,
        resume,
        maxRequestAttempts: Number.parseInt(getFlagValue(argv, "--max-attempts") ?? "5", 10),
        retryBaseDelayMs: Number.parseInt(getFlagValue(argv, "--retry-base-delay-ms") ?? "2000", 10),
        openCodePricing: {
            inputPerMillionUsd: Number.parseFloat(
                getFlagValue(argv, "--opencode-input-usd-per-million") ?? "0",
            ),
            outputPerMillionUsd: Number.parseFloat(
                getFlagValue(argv, "--opencode-output-usd-per-million") ?? "0",
            ),
            reasoningPerMillionUsd: Number.parseFloat(
                getFlagValue(argv, "--opencode-reasoning-usd-per-million") ?? "0",
            ),
            cachedInputPerMillionUsd: Number.parseFloat(
                getFlagValue(argv, "--opencode-cached-input-usd-per-million") ?? "0",
            ),
            cacheWritePerMillionUsd: Number.parseFloat(
                getFlagValue(argv, "--opencode-cache-write-usd-per-million") ?? "0",
            ),
        },
        questionPromptTemplate:
            "Based on our previous conversations, please answer this question. Do not search files or use tools — answer purely from what you remember about our past interactions.\n\nQuestion: {question}",
        selection: {
            start: start ? parseIntegerFlag(start, "--start") : undefined,
            end: end ? parseIntegerFlag(end, "--end") : undefined,
            types,
            questionIds,
        },
        judge: {
            model: getFlagValue(argv, "--judge-model") ?? "gpt-4o-2024-08-06",
            apiKeyEnvVar: getFlagValue(argv, "--judge-api-key-env") ?? "OPENAI_API_KEY",
            apiBaseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
            timeoutMs: Number.parseInt(getFlagValue(argv, "--judge-timeout-ms") ?? "120000", 10),
            maxTokens: Number.parseInt(getFlagValue(argv, "--judge-max-tokens") ?? "10", 10),
            temperature: Number.parseFloat(getFlagValue(argv, "--judge-temperature") ?? "0"),
            pricing: {
                inputPerMillionUsd: Number.parseFloat(
                    getFlagValue(argv, "--judge-input-usd-per-million") ?? "2.5",
                ),
                outputPerMillionUsd: Number.parseFloat(
                    getFlagValue(argv, "--judge-output-usd-per-million") ?? "10",
                ),
            },
        },
        paths,
        selectionSignature,
    };
}

export function printUsage(): string {
    return [
        "Usage: bun run scripts/longmemeval/runner.ts --dataset <path> [options]",
        "",
        "Options:",
        "  --dataset <path>              Required dataset JSON path",
        "  --start <index>               Inclusive start index",
        "  --end <index>                 Exclusive end index",
        "  --types <a,b>                 Filter by question types",
        "  --question-ids <a,b>          Filter by explicit question IDs",
        "  --resume                      Resume from saved runner-state.json",
        "  --fast                        Use minimal delays",
        "  --parallel <n>                Number of questions to process in parallel",
        "  --cleanup                     Delete OpenCode sessions after judging",
        "  --output-dir <path>           Override output directory",
        "  --opencode-url <url>          OpenCode API base URL",
        "  --turn-delay-ms <ms>          Delay between replayed user turns",
        "  --session-delay-ms <ms>       Delay between haystack sessions",
        "  --final-delay-ms <ms>         Delay before asking final benchmark question",
        "  --max-attempts <n>            Retry attempts for network/API failures",
        "  --retry-base-delay-ms <ms>    Base delay for exponential backoff",
        "  --opencode-*-usd-per-million  Optional estimated pricing inputs for OpenCode usage",
        "  --judge-model <model>         Judge model name (default gpt-4o-2024-08-06)",
    ].join("\n");
}
