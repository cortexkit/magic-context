#!/usr/bin/env bun
/**
 * Embedding-quality baseline capture.
 *
 * Runs a fixed query set against the current project's embedded memories and
 * saves the top-K ranked results per query. The goal is to compare two
 * embedding models (e.g. local MiniLM-L6 vs LMStudio 8B / 2048-dim) by
 * diffing two baseline snapshots.
 *
 * Usage:
 *   bun packages/plugin/scripts/embedding-baseline.ts
 *
 * What it measures (cheap, no gold labels):
 *   - score magnitude & spread
 *   - top-1 memory shift across snapshots (via post-hoc diff)
 *   - top-K ranking (for Kendall tau / eyeballing)
 *   - category distribution in top-K
 *
 * What it does NOT measure: precision / recall — needs human gold labels,
 * which is out of scope for a quick baseline. The diff between two snapshots
 * gives enough signal to judge whether the new model meaningfully reranks.
 *
 * Output: local-ignore/embedding-baseline/<safeModelId>-<iso>.json
 */

import { Database } from "../src/shared/sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { EmbeddingConfigSchema } from "../src/config/schema/magic-context";
import { cosineSimilarity } from "../src/features/magic-context/memory/cosine-similarity";
import {
    embedText,
    ensureEmbeddingModel,
    getEmbeddingModelId,
    initializeEmbedding,
} from "../src/features/magic-context/memory/embedding";
import { resolveProjectIdentity } from "../src/features/magic-context/memory/project-identity";
import { getMemoriesByProject } from "../src/features/magic-context/memory/storage-memory";
import { loadAllEmbeddings } from "../src/features/magic-context/memory/storage-memory-embeddings";

// ─────────────────────────────────────────────────────────────────────────
// Query set — 20 realistic queries grouped by intent
// ─────────────────────────────────────────────────────────────────────────

interface Query {
    id: string;
    group: string;
    text: string;
}

const QUERIES: Query[] = [
    // Direct factual lookups (single concept, should be easy)
    { id: "d1", group: "direct", text: "how does historian triggering work" },
    { id: "d2", group: "direct", text: "what is the default execute threshold" },
    { id: "d3", group: "direct", text: "where is the context database stored" },
    { id: "d4", group: "direct", text: "compression budget formula" },

    // Architectural questions
    { id: "a1", group: "architecture", text: "why don't we use global memories" },
    { id: "a2", group: "architecture", text: "how does nudge cache safety work" },
    { id: "a3", group: "architecture", text: "how are project memories scoped" },
    { id: "a4", group: "architecture", text: "what makes a message cache-stable" },

    // Problem-solving queries (agent debugging)
    { id: "p1", group: "problem", text: "historian not publishing compartments" },
    { id: "p2", group: "problem", text: "why is the cache being invalidated" },
    { id: "p3", group: "problem", text: "nudges not appearing in the transform" },
    { id: "p4", group: "problem", text: "tool drop replay losing history" },

    // Workflow / operational
    { id: "w1", group: "workflow", text: "how to release a new plugin version" },
    { id: "w2", group: "workflow", text: "how to test historian prompts locally" },
    { id: "w3", group: "workflow", text: "what dashboard script to run for release" },

    // Entity / name lookups (short, lexical-friendly)
    { id: "e1", group: "entity", text: "ctx_expand" },
    { id: "e2", group: "entity", text: "drop_tool_structure" },
    { id: "e3", group: "entity", text: "sidekick augmentation" },

    // Semantic paraphrase (worded unlike stored memories — hardest)
    {
        id: "s1",
        group: "paraphrase",
        text: "the long term storage for things the agent learned across sessions",
    },
    {
        id: "s2",
        group: "paraphrase",
        text: "what prevents the assistant from re-summarizing the same content",
    },
];

const TOP_K = 10;
const PREVIEW_CHARS = 120;

// ─────────────────────────────────────────────────────────────────────────
// Plugin embedding config resolution
// ─────────────────────────────────────────────────────────────────────────

interface PluginEmbeddingConfig {
    provider?: "local" | "openai-compatible" | "off";
    model?: string;
    endpoint?: string;
    apiKey?: string;
}

interface CLIArgs {
    configPath: string;
    outDir: string;
    tag?: string;
}

function parseArgs(): CLIArgs {
    const args = process.argv.slice(2);
    const out: CLIArgs = {
        configPath: join(homedir(), ".config/opencode/magic-context.jsonc"),
        outDir: resolve(process.cwd(), "local-ignore/embedding-baseline"),
    };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--config" && args[i + 1]) {
            out.configPath = resolve(args[++i]);
        } else if (arg === "--out" && args[i + 1]) {
            out.outDir = resolve(args[++i]);
        } else if (arg === "--tag" && args[i + 1]) {
            out.tag = args[++i];
        } else if (arg === "--help" || arg === "-h") {
            console.log(
                "Usage: bun packages/plugin/scripts/embedding-baseline.ts " +
                    "[--config path/to/magic-context.jsonc] [--out dir] [--tag label]",
            );
            process.exit(0);
        }
    }
    return out;
}

async function loadEmbeddingConfig(configPath: string): Promise<PluginEmbeddingConfig> {
    if (!existsSync(configPath)) {
        console.warn(
            `[baseline] magic-context config not found at ${configPath}; using provider defaults (local MiniLM-L6).`,
        );
        return {};
    }
    try {
        // Use the same JSONC parser the plugin itself uses — handles comments
        // AND trailing commas, matching real user config behavior.
        const { parseJsonc } = await import("../src/shared/jsonc-parser");
        const raw = await Bun.file(configPath).text();
        // biome-ignore lint/suspicious/noExplicitAny: one-off script
        const json: any = parseJsonc(raw);
        const embedding = (json?.embedding ?? {}) as PluginEmbeddingConfig;
        return embedding;
    } catch (err) {
        console.warn(
            `[baseline] failed to parse ${configPath}: ${err instanceof Error ? err.message : err}`,
        );
        return {};
    }
}

function stripJsoncComments(text: string): string {
    // Strip // line comments (not inside strings) and /* block comments */.
    // Minimal string-aware scanner, same contract as the plugin's loader.
    let out = "";
    let inString = false;
    let inLineComment = false;
    let inBlockComment = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const next = text[i + 1];
        if (inLineComment) {
            if (ch === "\n") {
                inLineComment = false;
                out += ch;
            }
            continue;
        }
        if (inBlockComment) {
            if (ch === "*" && next === "/") {
                inBlockComment = false;
                i++;
            }
            continue;
        }
        if (inString) {
            out += ch;
            if (ch === "\\" && next !== undefined) {
                out += next;
                i++;
                continue;
            }
            if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
            out += ch;
            continue;
        }
        if (ch === "/" && next === "/") {
            inLineComment = true;
            i++;
            continue;
        }
        if (ch === "/" && next === "*") {
            inBlockComment = true;
            i++;
            continue;
        }
        out += ch;
    }
    return out;
}

async function prepareBaseline(): Promise<Awaited<ReturnType<typeof run>>> {
    return run();
}

interface QueryResult {
    id: string;
    group: string;
    text: string;
    topK: Array<{
        rank: number;
        memoryId: number;
        category: string;
        score: number;
        retrievalCount: number;
        preview: string;
    }>;
}

interface BaselineSnapshot {
    tag: string | null;
    timestamp: string;
    modelId: string;
    embeddingDim: number | null;
    projectIdentity: string;
    stats: {
        memoriesConsidered: number;
        memoriesEmbedded: number;
        queryCount: number;
        topK: number;
        queryEmbedLatencyMs: { min: number; max: number; avg: number };
    };
    queries: QueryResult[];
}

async function run() {
    const args = parseArgs();

    // 1. Load embedding config from user's magic-context.jsonc so we match
    //    whatever provider is currently active for the plugin.
    //    Run the raw input through the same Zod schema the plugin uses so we
    //    get the canonical discriminated-union shape initializeEmbedding expects.
    const rawConfig = await loadEmbeddingConfig(args.configPath);
    const parsed = EmbeddingConfigSchema.safeParse(rawConfig);
    if (!parsed.success) {
        console.error(
            `[baseline] embedding config failed validation: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        );
        process.exit(1);
    }
    const embeddingConfig = parsed.data;
    console.log("[baseline] embedding config:", embeddingConfig);
    initializeEmbedding(embeddingConfig);

    const modelReady = await ensureEmbeddingModel();
    if (!modelReady) {
        console.error("[baseline] embedding provider failed to initialize. Aborting.");
        process.exit(1);
    }

    const modelId = getEmbeddingModelId();
    console.log(`[baseline] model_id: ${modelId}`);

    // 2. Open the plugin's live context DB (read-only) and load memories + embeddings
    //    for the current project.
    const dbPath = join(homedir(), ".local/share/opencode/storage/plugin/magic-context/context.db");
    if (!existsSync(dbPath)) {
        console.error(`[baseline] plugin DB not found at ${dbPath}`);
        process.exit(1);
    }
    const db = new Database(dbPath, { readonly: true });

    const projectIdentity = resolveProjectIdentity(process.cwd());
    console.log(`[baseline] project_identity: ${projectIdentity}`);

    const memories = getMemoriesByProject(db, projectIdentity, ["active", "permanent"]);
    const embeddings = loadAllEmbeddings(db, projectIdentity);
    console.log(
        `[baseline] memories_considered=${memories.length} embeddings_loaded=${embeddings.size}`,
    );

    if (embeddings.size === 0) {
        console.error(
            "[baseline] no embeddings in DB for current project. Did the background embed sweep run yet?",
        );
        process.exit(1);
    }

    const memoriesById = new Map(memories.map((m) => [m.id, m]));

    // 3. Embed queries and score.
    const queryLatencies: number[] = [];
    let embeddingDim: number | null = null;
    const results: QueryResult[] = [];

    for (const query of QUERIES) {
        const start = performance.now();
        const vector = await embedText(query.text);
        const latencyMs = performance.now() - start;
        queryLatencies.push(latencyMs);

        if (!vector) {
            console.warn(`[baseline] embedText returned null for query "${query.id}"; skipping`);
            continue;
        }
        if (embeddingDim === null) embeddingDim = vector.length;

        // Score only active memories — matches ctx_search's real semantic ranking path,
        // which iterates over the active-memory list rather than every stored embedding.
        const scored: Array<{ memoryId: number; score: number }> = [];
        for (const memory of memories) {
            const memVec = embeddings.get(memory.id);
            if (!memVec) continue;
            // Cross-model dim check: if dimensions differ the snapshot is bogus.
            if (memVec.length !== vector.length) {
                console.error(
                    `[baseline] dimension mismatch: query dim=${vector.length} memory dim=${memVec.length} ` +
                        `(memoryId=${memory.id}). The DB still holds old model vectors; let proactive embed complete first.`,
                );
                process.exit(1);
            }
            const score = cosineSimilarity(vector, memVec);
            scored.push({ memoryId: memory.id, score });
        }

        scored.sort((a, b) => b.score - a.score);
        const topK = scored.slice(0, TOP_K).map((row, idx) => {
            const memory = memoriesById.get(row.memoryId);
            return {
                rank: idx + 1,
                memoryId: row.memoryId,
                category: memory?.category ?? "(missing)",
                score: Number(row.score.toFixed(4)),
                retrievalCount: memory?.retrievalCount ?? 0,
                preview: memory?.content.slice(0, PREVIEW_CHARS) ?? "(memory row missing)",
            };
        });

        results.push({ id: query.id, group: query.group, text: query.text, topK });
        console.log(
            `[baseline] ${query.id} (${query.group}): top1=${topK[0]?.score ?? "-"} ` +
                `top10=${topK[TOP_K - 1]?.score ?? "-"} latency=${latencyMs.toFixed(1)}ms`,
        );
    }

    const snapshot: BaselineSnapshot = {
        tag: args.tag ?? null,
        timestamp: new Date().toISOString(),
        modelId,
        embeddingDim,
        projectIdentity,
        stats: {
            memoriesConsidered: memories.length,
            memoriesEmbedded: embeddings.size,
            queryCount: results.length,
            topK: TOP_K,
            queryEmbedLatencyMs: {
                min: Number(Math.min(...queryLatencies).toFixed(1)),
                max: Number(Math.max(...queryLatencies).toFixed(1)),
                avg: Number(
                    (queryLatencies.reduce((a, b) => a + b, 0) / queryLatencies.length).toFixed(1),
                ),
            },
        },
        queries: results,
    };

    db.close();

    // 4. Write snapshot.
    if (!existsSync(args.outDir)) mkdirSync(args.outDir, { recursive: true });
    const safeModelId = modelId.replace(/[^a-zA-Z0-9._-]/g, "_");
    const iso = snapshot.timestamp.replace(/[:]/g, "-").replace(/\..+$/, "");
    const filename = `${safeModelId}-${iso}${args.tag ? `-${args.tag}` : ""}.json`;
    const outPath = join(args.outDir, filename);
    writeFileSync(outPath, `${JSON.stringify(snapshot, null, 2)}\n`);

    console.log("");
    console.log(`[baseline] wrote ${outPath}`);
    console.log(`[baseline] queries=${results.length} avg latency=${snapshot.stats.queryEmbedLatencyMs.avg}ms`);
    console.log("");
    console.log("After switching embedding config + restart, run this script again. Then diff the two files.");

    return snapshot;
}

await prepareBaseline();
