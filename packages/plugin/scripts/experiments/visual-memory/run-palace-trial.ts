#!/usr/bin/env bun
/**
 * Frozen-corpus prompt trial for the visual-memory palace author.
 *
 * This is deliberately a development harness. It freezes the active memory
 * pool once, then compares prompt and model cells without live-pool drift.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { getMagicContextStorageDir } from "../../../src/shared/data-path";

import { extractCompleteManifestBody } from "../../../src/features/magic-context/dreamer/manifest-parser.ts";

import {
    authorPalace,
    cueBudgetViolations,
    isExactToken,
    type Category,
    type SourceMemory,
    type SpecEntry,
    validate,
} from "./author-palace.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = join(HERE, "corpus", "palace-corpus.json");
const TRIALS_DIR = join(HERE, "trials");
const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
// Thinking models (deepseek-v4-pro, qwen3.5 on ollama-cloud) spend a large share of
// the budget on reasoning before emitting content; 16k starved the big categories
// into empty-content responses. 32k matches the historian producer's budget.
const MAX_OUTPUT_TOKENS = 32_768;
const ANCHOR_FIDELITY_FLOOR = 85;

const CATEGORY_ORDER = [
    "PROJECT_RULES",
    "ARCHITECTURE",
    "CONSTRAINTS",
    "CONFIG_VALUES",
    "NAMING",
] as const;

const VALIDATOR_FAILURE_CLASSES = [
    "missing polarity mechanism",
    "hub noun repetition",
    "memory ID leakage",
    "broken exact anchors",
    "unbalanced parentheses",
    "cue over budget",
    "coverage",
    "other validator failures",
] as const;

type ValidatorFailureClass = (typeof VALIDATOR_FAILURE_CLASSES)[number];
type CorpusMemory = {
    id: number;
    category: Category;
    content: string;
    importance: number;
};
type PalaceCorpus = {
    schemaVersion: 1;
    projectIdentity: string;
    source: { databasePath: string; activeStatus: "active" };
    memories: CorpusMemory[];
};
type TokenUsage = {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cost?: number;
};
type ChatMessage = { role: "system" | "user"; content: string };
type Completion = { content: string; usage?: TokenUsage };
type CategoryRun = {
    category: Category;
    parse: "ok" | "retry" | "fail";
    entries?: SpecEntry[];
    attempts: number;
    usage: TokenUsage[];
    error?: string;
};
type RenderMetrics = {
    imageTokens: number;
    utilizationPercent: number;
    pages: number;
};
type CellResult = {
    model: string;
    prompt: string;
    directory: string;
    parse: "ok" | "retry" | "fail";
    coverage: { covered: number; total: number };
    validatorFailures: Partial<Record<ValidatorFailureClass, number>>;
    anchorFidelity?: number;
    roomCount?: number;
    imageTokens?: number;
    utilizationPercent?: number;
    pages?: number;
    renderError?: string;
    usage: TokenUsage[];
    cost?: number;
    categoryRuns: CategoryRun[];
};
type Args = {
    models: string[];
    prompts: string[];
    rebuildCorpus: boolean;
    reuseManifests: boolean;
};

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function usage(): never {
    throw new Error(`usage:
  bun ${join("packages/plugin/scripts/experiments/visual-memory", "run-palace-trial.ts")} --model deepseek/deepseek-v4-flash --prompt author-trial-system-prompt.md
  bun ${join("packages/plugin/scripts/experiments/visual-memory", "run-palace-trial.ts")} --models model-a,model-b --prompts prompt-a.md,prompt-b.md
  bun ${join("packages/plugin/scripts/experiments/visual-memory", "run-palace-trial.ts")} --rebuild-corpus`);
}

function splitValues(value: string): string[] {
    return value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}

function parseArgs(argv = process.argv.slice(2)): Args {
    const args: Args = { models: [], prompts: [], rebuildCorpus: false, reuseManifests: false };
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        const value = argv[index + 1];
        switch (argument) {
            case "--model":
            case "--models":
                if (!value) usage();
                args.models.push(...splitValues(value));
                index++;
                break;
            case "--prompt":
            case "--prompts":
                if (!value) usage();
                args.prompts.push(...splitValues(value));
                index++;
                break;
            case "--think":
                if (!value) usage();
                setOllamaThink(value);
                index++;
                break;
            case "--rebuild-corpus":
                args.rebuildCorpus = true;
                break;
            case "--reuse-manifests":
                // Re-render from a previous run's saved raw-<category>.xml manifests
                // without spending model quota on re-authoring. Categories with no
                // saved manifest still author normally.
                args.reuseManifests = true;
                break;
            case "--help":
            case "-h":
                usage();
                break;
            default:
                throw new Error(`unknown argument ${argument}`);
        }
    }
    return args;
}

function projectIdentity(): string {
    const rootCommit = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], {
        cwd: process.cwd(),
        encoding: "utf8",
    })
        .split("\n")[0]
        ?.trim();
    if (!rootCommit) throw new Error("could not resolve the current repository's root commit");
    return `git:${rootCommit}`;
}

function databasePath(): string {
    return (
        process.env.PALACE_CONTEXT_DB ??
        join(getMagicContextStorageDir(), "context.db")
    );
}

function buildCorpus(): PalaceCorpus {
    const dbPath = databasePath();
    if (!existsSync(dbPath)) throw new Error(`context database not found: ${dbPath}`);
    const db = new Database(dbPath, { readonly: true });
    try {
        const rows = db
            .query(
                "SELECT id, category, content, COALESCE(importance, 50) AS importance FROM memories WHERE project_path = ? AND status = 'active' ORDER BY id ASC",
            )
            .all(projectIdentity()) as Array<{
            id: number;
            category: string;
            content: string;
            importance: number;
        }>;
        const memories = rows.map((row) => {
            if (!CATEGORY_ORDER.includes(row.category as Category)) {
                throw new Error(`active memory ${row.id} has unsupported category ${row.category}`);
            }
            if (!Number.isSafeInteger(row.id) || !Number.isFinite(row.importance)) {
                throw new Error(`active memory ${row.id} has invalid id or importance`);
            }
            return {
                id: row.id,
                category: row.category as Category,
                content: row.content,
                importance: row.importance,
            };
        });
        if (memories.length === 0) throw new Error("the active memory pool is empty");
        memories.sort(
            (left, right) =>
                CATEGORY_ORDER.indexOf(left.category) - CATEGORY_ORDER.indexOf(right.category) ||
                left.id - right.id,
        );
        return {
            schemaVersion: 1,
            projectIdentity: projectIdentity(),
            source: {
                databasePath: "MAGIC_CONTEXT_STORAGE_DIR/context.db (or XDG-derived default)",
                activeStatus: "active",
            },
            memories,
        };
    } finally {
        db.close();
    }
}

function writeCorpus(corpus: PalaceCorpus): void {
    mkdirSync(dirname(CORPUS_PATH), { recursive: true });
    writeFileSync(CORPUS_PATH, `${JSON.stringify(corpus, null, 2)}\n`);
}

function readCorpus(): PalaceCorpus {
    if (!existsSync(CORPUS_PATH)) {
        throw new Error(`frozen corpus is missing: run with --rebuild-corpus to create ${CORPUS_PATH}`);
    }
    const corpus = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as Partial<PalaceCorpus>;
    if (corpus.schemaVersion !== 1 || !Array.isArray(corpus.memories) || corpus.memories.length === 0) {
        throw new Error(`invalid frozen corpus: ${CORPUS_PATH}`);
    }
    const seen = new Set<number>();
    for (const memory of corpus.memories) {
        if (
            !memory ||
            !Number.isSafeInteger(memory.id) ||
            !CATEGORY_ORDER.includes(memory.category) ||
            typeof memory.content !== "string" ||
            !Number.isFinite(memory.importance) ||
            seen.has(memory.id)
        ) {
            throw new Error(`invalid frozen corpus memory ${JSON.stringify(memory)}`);
        }
        seen.add(memory.id);
    }
    return corpus as PalaceCorpus;
}

function renderSource(corpus: PalaceCorpus): string {
    return CATEGORY_ORDER.flatMap((category) => {
        const memories = corpus.memories.filter((memory) => memory.category === category);
        if (memories.length === 0) return [];
        return [
            `<${category}>`,
            ...memories.flatMap((memory) => `#${memory.id}: ${memory.content}`.split("\n")),
            `</${category}>`,
            "",
        ];
    }).join("\n");
}

function renderCategoryPrompt(category: Category, memories: CorpusMemory[]): string {
    const source = memories
        .map(
            (memory) =>
                `#${memory.id} [importance=${memory.importance}]\n${memory.content}`,
        )
        .join("\n\n");
    return `# Palace cue authoring task\n\nAuthor the complete ${category} manifest below. Copy every source ID and importance exactly. The source text is the only factual input. Before replying, inventory every listed #ID: each must appear exactly once as an entry or merge, including low-importance facts.\n\n<${category}>\n${source}\n</${category}>`;
}

function decodeXml(value: string, context: string): string {
    if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(value)) {
        throw new Error(`${context} contains an unescaped or unknown XML entity`);
    }
    return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_match, entity: string) => {
        switch (entity) {
            case "amp":
                return "&";
            case "lt":
                return "<";
            case "gt":
                return ">";
            case "quot":
                return '"';
            case "apos":
                return "'";
            default: {
                const codePoint = Number.parseInt(
                    entity.startsWith("#x") ? entity.slice(2) : entity.slice(1),
                    entity.startsWith("#x") ? 16 : 10,
                );
                if (
                    !Number.isSafeInteger(codePoint) ||
                    codePoint <= 0 ||
                    codePoint > 0x10ffff ||
                    (codePoint >= 0xd800 && codePoint <= 0xdfff)
                ) {
                    throw new Error(`${context} contains an invalid XML numeric entity`);
                }
                return String.fromCodePoint(codePoint);
            }
        }
    });
}

function parseAttributes(raw: string, context: string): Map<string, string> {
    const attributes = new Map<string, string>();
    const pattern = /\s+([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/g;
    let cursor = 0;
    for (const match of raw.matchAll(pattern)) {
        const start = match.index ?? 0;
        if (raw.slice(cursor, start).trim()) throw new Error(`${context} has malformed attributes`);
        const name = match[1];
        const value = match[2];
        if (!name || value === undefined || attributes.has(name)) {
            throw new Error(`${context} has malformed or repeated attributes`);
        }
        attributes.set(name, decodeXml(value, `${context} attribute ${name}`));
        cursor = start + match[0].length;
    }
    if (raw.slice(cursor).trim()) throw new Error(`${context} has malformed attributes`);
    return attributes;
}

function requiredAttribute(attributes: Map<string, string>, name: string, context: string): string {
    const value = attributes.get(name);
    if (!value) throw new Error(`${context} missing ${name} attribute`);
    return value;
}

function allowedAttributes(attributes: Map<string, string>, names: readonly string[], context: string): void {
    for (const name of attributes.keys()) {
        if (!names.includes(name)) throw new Error(`${context} has unsupported attribute ${name}`);
    }
}

function parseInteger(value: string, context: string): number {
    if (!/^\d+$/.test(value)) throw new Error(`${context} must be a numeric integer`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw new Error(`${context} must be a safe integer`);
    return parsed;
}

function parseManifest(raw: string, expectedCategory: Category, importanceById: Map<number, number>): SpecEntry[] {
    // Models intermittently wrap the manifest in a Markdown code fence despite
    // the prompt's instruction. The fence carries no authoring signal (the XML
    // inside is complete and valid), so unwrap it rather than burning a retry
    // on a formatting tic.
    let text = raw.trim();
    const fence = text.match(/^```(?:xml)?\s*\n([\s\S]*?)\n?```\s*$/);
    if (fence?.[1]) text = fence[1].trim();
    if (!text.startsWith("<palace")) throw new Error("palace manifest must begin with <palace");
    if (!text.endsWith("</palace>")) {
        try {
            extractCompleteManifestBody(text, "palace");
        } catch (error) {
            throw new Error(errorMessage(error));
        }
        throw new Error("palace manifest must end with </palace>");
    }
    const rootMatch = /^<palace\b([^>]*)>([\s\S]*)<\/palace>$/.exec(text);
    if (!rootMatch) throw new Error("palace manifest must contain one complete <palace> root");
    if (extractCompleteManifestBody(text, "palace") !== rootMatch[2]) {
        throw new Error("palace manifest must contain exactly one root element");
    }
    const root = parseAttributes(rootMatch[1] ?? "", "palace root");
    allowedAttributes(root, ["category"], "palace root");
    if (requiredAttribute(root, "category", "palace root") !== expectedCategory) {
        throw new Error(`palace root category does not match ${expectedCategory}`);
    }

    const specs: SpecEntry[] = [];
    const body = rootMatch[2] ?? "";
    const roomPattern = /<room\b([^>]*)>([\s\S]*?)<\/room>/g;
    let roomCursor = 0;
    for (const roomMatch of body.matchAll(roomPattern)) {
        const roomStart = roomMatch.index ?? 0;
        if (body.slice(roomCursor, roomStart).trim()) {
            throw new Error("palace manifest contains content outside a room");
        }
        const roomAttributes = parseAttributes(roomMatch[1] ?? "", "room");
        allowedAttributes(roomAttributes, ["name"], "room");
        const room = requiredAttribute(roomAttributes, "name", "room");
        const roomBody = roomMatch[2] ?? "";
        const childPattern = /<entry\b([^>]*)>([\s\S]*?)<\/entry>|<merge\b([^>]*)\/>/g;
        let childCursor = 0;
        let childCount = 0;
        for (const child of roomBody.matchAll(childPattern)) {
            const childStart = child.index ?? 0;
            if (roomBody.slice(childCursor, childStart).trim()) {
                throw new Error(`room ${room} contains an unknown XML element or text`);
            }
            if (child[1] !== undefined) {
                const attributes = parseAttributes(child[1], `entry in room ${room}`);
                allowedAttributes(attributes, ["id", "importance"], `entry in room ${room}`);
                const id = parseInteger(requiredAttribute(attributes, "id", `entry in room ${room}`), "entry id");
                const importance = parseInteger(
                    requiredAttribute(attributes, "importance", `entry ${id}`),
                    `entry ${id} importance`,
                );
                const rawCue = child[2] ?? "";
                if (rawCue.includes("<")) throw new Error(`entry ${id} must escape literal <`);
                const cue = decodeXml(rawCue.trim(), `entry ${id} cue`);
                if (!cue) throw new Error(`entry ${id} has an empty cue`);
                specs.push({ id, category: expectedCategory, room, cue, importance });
            } else {
                const attributes = parseAttributes(child[3] ?? "", `merge in room ${room}`);
                allowedAttributes(attributes, ["id", "into", "importance"], `merge in room ${room}`);
                const id = parseInteger(requiredAttribute(attributes, "id", `merge in room ${room}`), "merge id");
                const mergeInto = parseInteger(
                    requiredAttribute(attributes, "into", `merge ${id}`),
                    `merge ${id} target`,
                );
                const reportedImportance = attributes.get("importance");
                specs.push({
                    id,
                    category: expectedCategory,
                    room,
                    mergeInto,
                    importance:
                        reportedImportance === undefined
                            ? (importanceById.get(id) ?? Number.NaN)
                            : parseInteger(reportedImportance, `merge ${id} importance`),
                });
            }
            childCount++;
            childCursor = childStart + child[0].length;
        }
        if (roomBody.slice(childCursor).trim()) throw new Error(`room ${room} contains unknown content`);
        if (childCount === 0) throw new Error(`room ${room} has no entries`);
        roomCursor = roomStart + roomMatch[0].length;
    }
    if (body.slice(roomCursor).trim()) throw new Error("palace manifest contains content outside a room");
    if (specs.length === 0) throw new Error("palace manifest contains no entries");
    return specs;
}

function responseContent(payload: unknown): string | undefined {
    if (typeof payload !== "object" || payload === null) return undefined;
    const choices = (payload as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) return undefined;
    const message = (choices[0] as { message?: { content?: unknown } } | undefined)?.message;
    const content = message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        const parts = content.flatMap((part) => {
            if (typeof part !== "object" || part === null) return [];
            const value = part as { text?: unknown; content?: unknown };
            return typeof value.text === "string"
                ? [value.text]
                : typeof value.content === "string"
                  ? [value.content]
                  : [];
        });
        return parts.length > 0 ? parts.join("") : undefined;
    }
    if (typeof content === "object" && content !== null) {
        const value = content as { text?: unknown; content?: unknown; value?: unknown };
        for (const candidate of [value.text, value.content, value.value]) {
            if (typeof candidate === "string") return candidate;
        }
    }
    return undefined;
}

function responseUsage(payload: unknown): TokenUsage | undefined {
    if (typeof payload !== "object" || payload === null) return undefined;
    const usage = (payload as { usage?: unknown }).usage;
    if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return undefined;
    const value = usage as {
        prompt_tokens?: unknown;
        completion_tokens?: unknown;
        total_tokens?: unknown;
        input_tokens?: unknown;
        output_tokens?: unknown;
        cost?: unknown;
    };
    const prompt = value.prompt_tokens ?? value.input_tokens;
    const completion = value.completion_tokens ?? value.output_tokens;
    if (typeof prompt !== "number" || typeof completion !== "number") return undefined;
    if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return undefined;
    const total = value.total_tokens;
    return {
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: typeof total === "number" && Number.isFinite(total) ? total : prompt + completion,
        ...(typeof value.cost === "number" && Number.isFinite(value.cost) ? { cost: value.cost } : {}),
    };
}

const OLLAMA_CLOUD_PREFIX = "ollama-cloud/";
const OLLAMA_CLOUD_ENDPOINT = "https://ollama.com/v1/chat/completions";

// Lazy, cached per-provider key resolution so an all-ollama run needs no OpenRouter
// key and vice versa. OpenRouter key: ~/.config/openrouter.key. Ollama-cloud key:
// OpenCode's auth.json ("ollama-cloud".key), the same credential OpenCode uses.
const keyCache = new Map<string, string>();
function resolveOpenRouterKey(): string {
    const cached = keyCache.get("openrouter");
    if (cached !== undefined) return cached;
    const key = readFileSync(join(homedir(), ".config", "openrouter.key"), "utf8").trim();
    if (!key) throw new Error("OpenRouter key is empty: ~/.config/openrouter.key");
    keyCache.set("openrouter", key);
    return key;
}
function resolveOllamaCloudKey(): string {
    const cached = keyCache.get("ollama-cloud");
    if (cached !== undefined) return cached;
    // OpenCode's auth.json lives under XDG data (~/.local/share/opencode), with the
    // legacy ~/.config/opencode path as a fallback. Read whichever exists.
    const authCandidates = [
        join(homedir(), ".local", "share", "opencode", "auth.json"),
        join(homedir(), ".config", "opencode", "auth.json"),
    ];
    const authPath = authCandidates.find(existsSync);
    if (!authPath) throw new Error(`opencode auth.json not found (looked in ${authCandidates.join(", ")})`);
    const auth = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, { key?: string }>;
    const key = auth["ollama-cloud"]?.key?.trim();
    if (!key) throw new Error(`ollama-cloud key not found in ${authPath}`);
    keyCache.set("ollama-cloud", key);
    return key;
}

// Ollama's native /api/chat honors think (false | "low" | "medium" | "high"),
// which the OpenAI-compat endpoint does not expose reliably. Bounding thinking
// matters: on the biggest categories unbounded thinking consumed the entire
// output budget before any content, returning empty assistant text. The level
// is a CLI knob (--think) so cells can A/B quality against thinking budget.
const THINK_LEVELS = new Set(["false", "low", "medium", "high"]);
let ollamaThink: false | string = "low";

function setOllamaThink(value: string): void {
    if (!THINK_LEVELS.has(value)) {
        throw new Error(`--think must be one of ${[...THINK_LEVELS].join(", ")}`);
    }
    ollamaThink = value === "false" ? false : value;
}

async function callOllamaNativeChat(model: string, messages: ChatMessage[]): Promise<Completion> {
    const response = await fetch("https://ollama.com/api/chat", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${resolveOllamaCloudKey()}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model,
            messages,
            think: ollamaThink,
            stream: false,
            options: { temperature: 0.1, num_predict: MAX_OUTPUT_TOKENS },
        }),
        signal: AbortSignal.timeout(10 * 60 * 1_000),
    });
    const text = await response.text();
    if (!response.ok) {
        throw new Error(`ollama-cloud ${response.status}: ${text.replace(/\s+/g, " ").slice(0, 500)}`);
    }
    const payload = JSON.parse(text) as {
        message?: { content?: string };
        prompt_eval_count?: number;
        eval_count?: number;
    };
    const content = payload.message?.content?.trim();
    if (!content) throw new Error("ollama-cloud response has no assistant text");
    const promptTokens = payload.prompt_eval_count ?? 0;
    const completionTokens = payload.eval_count ?? 0;
    return {
        content,
        usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
    };
}

async function callChatCompletions(
    endpoint: string,
    apiKey: string,
    label: string,
    model: string,
    messages: ChatMessage[],
    extraBody: Record<string, unknown>,
): Promise<Completion> {
    const response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            model,
            messages,
            temperature: 0.1,
            max_tokens: MAX_OUTPUT_TOKENS,
            ...extraBody,
        }),
        signal: AbortSignal.timeout(10 * 60 * 1_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${label} ${response.status}: ${text.replace(/\s+/g, " ").slice(0, 500)}`);
    let payload: unknown;
    try {
        payload = JSON.parse(text);
    } catch (error) {
        throw new Error(`${label} returned non-JSON: ${errorMessage(error)}`);
    }
    const content = responseContent(payload);
    if (!content) throw new Error(`${label} response has no assistant text`);
    return { content, usage: responseUsage(payload) };
}

// Dispatch by model-id prefix: `ollama-cloud/<name>` -> ollama.com; anything else -> OpenRouter.
async function callModel(model: string, messages: ChatMessage[]): Promise<Completion> {
    if (model.startsWith(OLLAMA_CLOUD_PREFIX)) {
        const bareModel = model.slice(OLLAMA_CLOUD_PREFIX.length);
        return callOllamaNativeChat(bareModel, messages);
    }
    return callChatCompletions(OPENROUTER_ENDPOINT, resolveOpenRouterKey(), "OpenRouter", model, messages, {
        ...(model === "google/gemini-3.5-flash" ? {} : { reasoning: { enabled: false } }),
    });
}

// Extension-stripping is for prompt FILE names only. Model ids must keep their
// dots and suffixes verbatim: stripping extname collapsed glm-5.1 and glm-5.2
// into the same trial directory and truncated kimi-k2.7-code to kimi-k2.
function safeName(value: string, opts?: { stripExtension?: boolean }): string {
    const base = opts?.stripExtension ? value.replace(extname(value), "") : value;
    return base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unnamed";
}

function promptPath(value: string): string {
    const candidates = isAbsolute(value)
        ? [value]
        : [resolve(process.cwd(), value), join(HERE, value)];
    const found = candidates.find(existsSync);
    if (!found) throw new Error(`prompt file not found: ${value}`);
    return found;
}

async function runCategory(args: {
    model: string;
    systemPrompt: string;
    category: Category;
    memories: CorpusMemory[];
    importanceById: Map<number, number>;
    outputDir: string;
}): Promise<CategoryRun> {
    const baseMessages: ChatMessage[] = [
        { role: "system", content: args.systemPrompt },
        { role: "user", content: renderCategoryPrompt(args.category, args.memories) },
    ];
    const usage: TokenUsage[] = [];
    const rawPath = join(args.outputDir, `raw-${args.category.toLowerCase()}.xml`);
    let raw: string;
    try {
        const completion = await callModel(args.model, baseMessages);
        raw = completion.content;
        if (completion.usage) usage.push(completion.usage);
    } catch (error) {
        return { category: args.category, parse: "fail", attempts: 1, usage, error: errorMessage(error) };
    }

    let entries: SpecEntry[] | undefined;
    let parseError: string | undefined;
    try {
        entries = parseManifest(raw, args.category, args.importanceById);
    } catch (error) {
        parseError = errorMessage(error);
    }
    if (entries) {
        const violations = cueBudgetViolations(entries, args.importanceById);
        if (violations.length === 0) {
            writeFileSync(rawPath, raw);
            return { category: args.category, parse: "ok", entries, attempts: 1, usage };
        }
        // Budget violations reject the whole category once with per-id feedback;
        // mechanical enforcement replaced the prose that flash imitated instead
        // of obeying.
        writeFileSync(rawPath.replace(/\.xml$/, ".attempt-1.xml"), raw);
        const list = violations
            .slice(0, 20)
            .map((v) => `id ${v.id}: ${v.length} chars (max ${v.budget})`)
            .join("; ");
        try {
            const completion = await callModel(args.model, [
                ...baseMessages,
                { role: "assistant", content: raw },
                {
                    role: "user",
                    content: `REJECTED: ${violations.length} cue(s) exceed their hard character budget: ${list}. Budgets: importance >= 70 allows 90 chars, everything else 50 chars, counted on the rendered cue. Compress the flagged cues (drop path spines, keep anchors and one relation, use the strongest half) and return the complete corrected XML manifest. Do not change ids, rooms, or importance values.`,
                },
            ]);
            raw = completion.content;
            if (completion.usage) usage.push(completion.usage);
        } catch (error) {
            return { category: args.category, parse: "fail", attempts: 2, usage, error: errorMessage(error) };
        }
        writeFileSync(rawPath, raw);
        try {
            entries = parseManifest(raw, args.category, args.importanceById);
            const still = cueBudgetViolations(entries, args.importanceById);
            if (still.length > 0) {
                console.warn(`[palace] ${args.category}: ${still.length} cue(s) still over budget after retry; keeping with warnings`);
            }
            return { category: args.category, parse: "retry", entries, attempts: 2, usage };
        } catch (error) {
            return { category: args.category, parse: "fail", attempts: 2, usage, error: errorMessage(error) };
        }
    }

    writeFileSync(rawPath.replace(/\.xml$/, ".attempt-1.xml"), raw);
    try {
        const completion = await callModel(args.model, [
            ...baseMessages,
            {
                role: "user",
                content: `The previous response was rejected before validation: ${parseError ?? "invalid XML"}. Return a fresh, complete XML palace manifest only. It must begin with <palace and end with </palace>.`,
            },
        ]);
        raw = completion.content;
        if (completion.usage) usage.push(completion.usage);
    } catch (error) {
        return { category: args.category, parse: "fail", attempts: 2, usage, error: errorMessage(error) };
    }
    writeFileSync(rawPath, raw);
    try {
        entries = parseManifest(raw, args.category, args.importanceById);
        return { category: args.category, parse: "retry", entries, attempts: 2, usage };
    } catch (error) {
        return { category: args.category, parse: "fail", attempts: 2, usage, error: errorMessage(error) };
    }
}

function classifyValidatorError(message: string): ValidatorFailureClass {
    if (/negative rule missing polarity marker|polarity mechanism missing|polarity mechanism must follow marker/i.test(message)) {
        return "missing polarity mechanism";
    }
    if (/hub noun repeated in cue/i.test(message)) return "hub noun repetition";
    if (/memory id leaked into cue/i.test(message)) return "memory ID leakage";
    if (/exact anchor .* missing from rendered cue/i.test(message)) return "broken exact anchors";
    if (/polarity mechanism is unclosed|unbalanced mechanism/i.test(message)) return "unbalanced parentheses";
    if (/cue over budget/i.test(message)) return "cue over budget";
    if (/uncovered source ids|duplicate spec id|absent from source|category mismatch/i.test(message)) return "coverage";
    return "other validator failures";
}

function addValidatorFailure(
    failures: Partial<Record<ValidatorFailureClass, number>>,
    message: string,
): void {
    const kind = classifyValidatorError(message);
    failures[kind] = (failures[kind] ?? 0) + 1;
}

function sourceAnchors(value: string): string[] {
    return [
        ...new Set(
            (value.match(/`[^`]+`|[^\s()`]+/g) ?? [])
                .filter((token) => token.startsWith("`") || isExactToken(token))
                .map((token) => token.replace(/^[,;]+|[,;]+$/g, ""))
                .filter(Boolean),
        ),
    ];
}

function anchorFidelity(corpus: PalaceCorpus, palace: string): number {
    const anchors = corpus.memories.flatMap((memory) => sourceAnchors(memory.content));
    if (anchors.length === 0) return 100;
    const matched = anchors.filter((anchor) => palace.includes(anchor)).length;
    return Number(((matched / anchors.length) * 100).toFixed(1));
}

function parseRenderMetrics(stdout: string): RenderMetrics {
    const result = stdout.match(/^RESULT_JSON=(.+)$/m)?.[1];
    if (!result) throw new Error("build-palace did not emit RESULT_JSON");
    const report = JSON.parse(result) as {
        imageTokens?: unknown;
        pages?: unknown;
        utilization?: { contentToCanvasPercent?: unknown };
    };
    if (
        typeof report.imageTokens !== "number" ||
        typeof report.pages !== "number" ||
        typeof report.utilization?.contentToCanvasPercent !== "number"
    ) {
        throw new Error("build-palace RESULT_JSON has an unexpected shape");
    }
    return {
        imageTokens: report.imageTokens,
        pages: report.pages,
        utilizationPercent: report.utilization.contentToCanvasPercent,
    };
}

function renderPalaceCell(args: {
    corpus: PalaceCorpus;
    specs: SpecEntry[];
    outputDir: string;
}): { metrics?: RenderMetrics; error?: string } {
    const source = renderSource(args.corpus);
    const palacePath = join(args.outputDir, "palace.txt");
    const coveragePath = join(args.outputDir, "coverage.json");
    const sourcePath = join(args.outputDir, "source.txt");
    writeFileSync(sourcePath, source);
    try {
        authorPalace({
            source: args.corpus.memories.map(
                (memory): SourceMemory => ({
                    id: memory.id,
                    category: memory.category,
                    importance: memory.importance,
                }),
            ),
            specs: args.specs,
            sourceLabel: CORPUS_PATH,
            palaceOutput: palacePath,
            coverageOutput: coveragePath,
        });
    } catch (error) {
        return { error: `author-palace: ${errorMessage(error)}` };
    }
    const rendered = Bun.spawnSync({
        cmd: ["bun", join(HERE, "build-palace.ts")],
        cwd: HERE,
        env: {
            ...process.env,
            PALACE_SOURCE_PATH: sourcePath,
            PALACE_INPUT_PATH: palacePath,
            PALACE_COVERAGE_PATH: coveragePath,
            PALACE_OUTPUT_DIR: args.outputDir,
            PALACE_OUTPUT_PREFIX: "palace-page",
            PALACE_SKIP_FONT_COMPARISON: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
    });
    if (rendered.exitCode !== 0) {
        return { error: `build-palace: ${new TextDecoder().decode(rendered.stderr).trim()}` };
    }
    try {
        return { metrics: parseRenderMetrics(new TextDecoder().decode(rendered.stdout)) };
    } catch (error) {
        return { error: `build-palace: ${errorMessage(error)}` };
    }
}

async function runCell(args: {
    corpus: PalaceCorpus;
    model: string;
    promptPath: string;
    reuseManifests: boolean;
}): Promise<CellResult> {
    const prompt = readFileSync(args.promptPath, "utf8");
    // Suffix the think mode so A/B arms (think:false vs think:low) write
    // distinct directories instead of clobbering each other's artifacts.
    const directory = join(
        TRIALS_DIR,
        `${safeName(basename(args.promptPath), { stripExtension: true })}__${safeName(args.model)}__think-${safeName(String(ollamaThink))}`,
    );
    mkdirSync(directory, { recursive: true });
    const importanceById = new Map(args.corpus.memories.map((memory) => [memory.id, memory.importance]));
    const categoryRuns: CategoryRun[] = [];
    for (const category of CATEGORY_ORDER) {
        const memories = args.corpus.memories.filter((memory) => memory.category === category);
        if (memories.length === 0) continue;
        if (args.reuseManifests) {
            const rawPath = join(directory, `raw-${category.toLowerCase()}.xml`);
            if (existsSync(rawPath)) {
                try {
                    const entries = parseManifest(readFileSync(rawPath, "utf8"), category, importanceById);
                    categoryRuns.push({ category, parse: "ok", entries, attempts: 0, usage: [] });
                    continue;
                } catch {
                    // A stale or malformed saved manifest falls through to authoring.
                }
            }
        }
        categoryRuns.push(
            await runCategory({
                model: args.model,
                systemPrompt: prompt,
                category,
                memories,
                importanceById,
                outputDir: directory,
            }),
        );
    }
    const specs = categoryRuns.flatMap((run) => run.entries ?? []);
    const validSourceIds = new Set(args.corpus.memories.map((memory) => memory.id));
    const covered = new Set(specs.map((entry) => entry.id).filter((id) => validSourceIds.has(id))).size;
    const failures: Partial<Record<ValidatorFailureClass, number>> = {};
    let renderError: string | undefined;
    let metrics: RenderMetrics | undefined;
    if (categoryRuns.some((run) => run.parse === "fail")) {
        renderError = "parse failure prevented fail-closed authoring";
    } else {
        try {
            const validationDefects = validate(
                args.corpus.memories.map(
                    (memory): SourceMemory => ({
                        id: memory.id,
                        category: memory.category,
                        importance: memory.importance,
                    }),
                ),
                specs,
            );
            for (const defect of validationDefects) addValidatorFailure(failures, defect);
        } catch (error) {
            const message = errorMessage(error);
            addValidatorFailure(failures, message);
            // Dev-only escape hatch for eyeball passes: render the near-miss manifest
            // anyway while keeping the failure in metrics so the verdict stays honest.
            if (process.env.PALACE_RENDER_DESPITE_VALIDATOR !== "1") {
                renderError = `validator: ${message}`;
            }
        }
        if (!renderError) {
            const rendered = renderPalaceCell({ corpus: args.corpus, specs, outputDir: directory });
            metrics = rendered.metrics;
            renderError = rendered.error;
        }
    }
    const parse = categoryRuns.some((run) => run.parse === "fail")
        ? "fail"
        : categoryRuns.some((run) => run.parse === "retry")
          ? "retry"
          : "ok";
    const usage = categoryRuns.flatMap((run) => run.usage);
    const reportedCosts = usage.map((item) => item.cost).filter((cost): cost is number => cost !== undefined);
    const result: CellResult = {
        model: args.model,
        prompt: basename(args.promptPath),
        directory,
        parse,
        coverage: { covered, total: args.corpus.memories.length },
        validatorFailures: failures,
        ...(metrics ? { anchorFidelity: anchorFidelity(args.corpus, readFileSync(join(directory, "palace.txt"), "utf8")) } : {}),
        ...(metrics
            ? {
                  roomCount: new Set(specs.map((entry) => `${entry.category}\u0000${entry.room}`)).size,
                  imageTokens: metrics.imageTokens,
                  utilizationPercent: metrics.utilizationPercent,
                  pages: metrics.pages,
              }
            : {}),
        ...(renderError ? { renderError } : {}),
        usage,
        ...(reportedCosts.length === usage.length && reportedCosts.length > 0
            ? { cost: reportedCosts.reduce((sum, cost) => sum + cost, 0) }
            : {}),
        categoryRuns,
    };
    writeFileSync(join(directory, "metrics.json"), `${JSON.stringify(result, null, 2)}\n`);
    return result;
}

function formatFailures(failures: Partial<Record<ValidatorFailureClass, number>>): string {
    const entries = Object.entries(failures);
    return entries.length === 0 ? "—" : entries.map(([kind, count]) => `${kind}: ${count}`).join(", ");
}

function cellVerdict(result: CellResult): "VIABLE" | "VIABLE-WITH-CAVEATS" | "NOT-VIABLE" {
    if (
        result.parse === "fail" ||
        Object.keys(result.validatorFailures).some((kind) => kind !== "cue over budget") ||
        result.renderError
    ) {
        return "NOT-VIABLE";
    }
    if ((result.anchorFidelity ?? 0) < ANCHOR_FIDELITY_FLOOR || result.parse === "retry") {
        return "VIABLE-WITH-CAVEATS";
    }
    return "VIABLE";
}

function modelVerdict(results: CellResult[]): "VIABLE" | "VIABLE-WITH-CAVEATS" | "NOT-VIABLE" {
    if (results.some((result) => cellVerdict(result) === "NOT-VIABLE")) return "NOT-VIABLE";
    if (results.some((result) => cellVerdict(result) === "VIABLE-WITH-CAVEATS")) {
        return "VIABLE-WITH-CAVEATS";
    }
    return "VIABLE";
}

function markdownCell(value: string | number | undefined): string {
    return String(value ?? "—").replaceAll("|", "\\|").replace(/\n/g, " ");
}

function formatCost(cost: number | undefined): string {
    return cost === undefined ? "not returned by OpenRouter" : `$${cost.toFixed(6)}`;
}

function writeReport(results: CellResult[]): void {
    mkdirSync(TRIALS_DIR, { recursive: true });
    const grouped = new Map<string, CellResult[]>();
    for (const result of results) grouped.set(result.model, [...(grouped.get(result.model) ?? []), result]);
    const lines = [
        "# Memory Palace v3 Prompt Trials",
        "",
        "This development harness compares a frozen corpus across prompt and model cells.",
        "",
        "## Commands",
        "",
        "```sh",
        "bun packages/plugin/scripts/experiments/visual-memory/run-palace-trial.ts --rebuild-corpus",
        "bun packages/plugin/scripts/experiments/visual-memory/run-palace-trial.ts --model deepseek/deepseek-v4-flash --prompt packages/plugin/scripts/experiments/visual-memory/author-trial-system-prompt.md",
        "bun packages/plugin/scripts/experiments/visual-memory/run-palace-trial.ts --models deepseek/deepseek-v4-flash,deepseek/deepseek-v4-pro --prompts prompt-a.md,prompt-b.md",
        "```",
        "",
        "Raw responses, palace text, coverage, metrics, and PNGs land in each named trial directory. PNGs are intentionally ignored.",
        "",
        "## Matrix",
        "",
        "| Model | Prompt | Parse | Coverage | Validator failures | Anchor fidelity | Rooms | Image tokens | Utilization | OpenRouter cost | Verdict |",
        "| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | --- | --- |",
    ];
    if (results.length === 0) {
        lines.push("| _No runs yet_ | — | — | — | — | — | — | — | — | — | — |");
    }
    for (const result of results) {
        const anchor = result.anchorFidelity === undefined ? "—" : String(result.anchorFidelity) + "%";
        const utilization = result.utilizationPercent === undefined ? "—" : String(result.utilizationPercent) + "%";
        lines.push(
            "| " +
                markdownCell(result.model) +
                " | " +
                markdownCell(result.prompt) +
                " | " +
                result.parse +
                " | " +
                result.coverage.covered +
                "/" +
                result.coverage.total +
                " | " +
                markdownCell(formatFailures(result.validatorFailures)) +
                " | " +
                anchor +
                " | " +
                markdownCell(result.roomCount) +
                " | " +
                markdownCell(result.imageTokens) +
                " | " +
                utilization +
                " | " +
                formatCost(result.cost) +
                " | " +
                cellVerdict(result) +
                " |",
        );
    }
    lines.push(
        "",
        "## Per-model cost estimate",
        "",
        "| Model | Cells | Prompt tokens | Completion tokens | OpenRouter cost | Verdict |",
        "| --- | ---: | ---: | ---: | --- | --- |",
    );
    if (grouped.size === 0) lines.push("| _No runs yet_ | — | — | — | — | — |");
    for (const [model, modelResults] of grouped) {
        const usage = modelResults.flatMap((result) => result.usage);
        const costs = modelResults.map((result) => result.cost);
        const totalCost = costs.every((cost) => cost !== undefined)
            ? costs.reduce((sum, cost) => sum + (cost ?? 0), 0)
            : undefined;
        lines.push(
            "| " +
                markdownCell(model) +
                " | " +
                modelResults.length +
                " | " +
                usage.reduce((sum, item) => sum + item.promptTokens, 0) +
                " | " +
                usage.reduce((sum, item) => sum + item.completionTokens, 0) +
                " | " +
                formatCost(totalCost) +
                " | " +
                modelVerdict(modelResults) +
                " |",
        );
    }
    if (results.length === 1) {
        const result = results[0];
        lines.push(
            "",
            "## Smoke cell",
            "",
            "- **Model/prompt:** " + result.model + " × " + result.prompt,
            "- **Parse and coverage:** " + result.parse + "; " + result.coverage.covered + "/" + result.coverage.total,
            "- **Rendered metrics:** " +
                (result.imageTokens ?? "not rendered") +
                " image tokens; " +
                (result.utilizationPercent === undefined ? "not rendered" : String(result.utilizationPercent) + "% utilization") +
                "; " +
                (result.anchorFidelity === undefined ? "anchor fidelity not available" : String(result.anchorFidelity) + "% anchor fidelity") +
                ".",
            "- **Output:** `" + result.directory.slice(HERE.length + 1) + "`",
            ...(result.renderError ? ["- **Failure:** " + result.renderError] : []),
        );
    }
    lines.push(
        "",
        "## Verdict policy",
        "",
        "A cell is **VIABLE** when parsing, validation, rendering, and the author's selected-memory manifest succeed with at least " +
            ANCHOR_FIDELITY_FLOOR +
            "% anchor fidelity. Uncovered source memories are an intentional selection outcome. A parse-recovered or low-anchor cell is **VIABLE-WITH-CAVEATS**; cue-budget diagnostics are warnings. Any parse, hard-validation, or rendering failure is **NOT-VIABLE**.",
        "",
    );
    writeFileSync(join(TRIALS_DIR, "REPORT.md"), lines.join("\n"));
}

async function main(): Promise<void> {
    const args = parseArgs();
    if (args.rebuildCorpus) {
        const corpus = buildCorpus();
        writeCorpus(corpus);
        console.log(`rebuilt ${CORPUS_PATH} (${corpus.memories.length} active memories)`);
    }
    if (args.models.length === 0 && args.prompts.length === 0) {
        if (!args.rebuildCorpus) usage();
        return;
    }
    if (args.models.length === 0 || args.prompts.length === 0) usage();
    const corpus = readCorpus();
    const results: CellResult[] = [];
    for (const requestedPrompt of args.prompts) {
        const candidatePrompt = promptPath(requestedPrompt);
        for (const model of args.models) {
            console.log(`running ${model} × ${basename(candidatePrompt)}`);
            results.push(
                await runCell({
                    corpus,
                    model,
                    promptPath: candidatePrompt,
                    reuseManifests: args.reuseManifests,
                }),
            );
        }
    }
    writeReport(results);
    for (const result of results) {
        console.log(
            JSON.stringify({
                model: result.model,
                prompt: result.prompt,
                parse: result.parse,
                coverage: `${result.coverage.covered}/${result.coverage.total}`,
                imageTokens: result.imageTokens,
                utilizationPercent: result.utilizationPercent,
                output: result.directory,
            }),
        );
    }
}

void main().catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
});
