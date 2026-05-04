#!/usr/bin/env bun
/**
 * Backfill embeddings for all memories that don't have one yet.
 *
 * Reads the user's magic-context.jsonc (same as the running plugin) to resolve
 * the active embedding provider, so this works for local MiniLM, OpenAI-
 * compatible (LMStudio/Ollama), or any other configured endpoint.
 *
 * Run: bun scripts/backfill-embeddings.ts [--project <path>]
 *   --project  Only backfill memories for this project_path (default: all).
 */
import { Database } from "../src/shared/sqlite";
import { readFileSync } from "node:fs";
import { parseJsonc } from "../src/shared/jsonc-parser";
import { MagicContextConfigSchema } from "../src/config/schema/magic-context";
import {
    embedBatch,
    ensureEmbeddingModel,
    getEmbeddingModelId,
    initializeEmbedding,
} from "../src/features/magic-context/memory/embedding";
import { saveEmbedding } from "../src/features/magic-context/memory/storage-memory-embeddings";

const DB_PATH = `${process.env.HOME}/.local/share/opencode/storage/plugin/magic-context/context.db`;
const USER_CONFIG_PATH = `${process.env.HOME}/.config/opencode/magic-context.jsonc`;

function loadEmbeddingConfigFromUserFile() {
    try {
        const raw = readFileSync(USER_CONFIG_PATH, "utf8");
        const parsed = parseJsonc(raw);
        const config = MagicContextConfigSchema.parse(parsed);
        if (config.embedding) {
            console.log(
                `Using embedding config from ${USER_CONFIG_PATH}: provider=${config.embedding.provider}`,
            );
            return config.embedding;
        }
    } catch (err) {
        console.warn(`Could not read ${USER_CONFIG_PATH}: ${String(err)}`);
    }
    console.log("Falling back to local MiniLM default.");
    return { provider: "local" as const, model: "Xenova/all-MiniLM-L6-v2" };
}

async function main() {
    const projectFilter = process.argv.includes("--project")
        ? process.argv[process.argv.indexOf("--project") + 1]
        : null;

    const db = new Database(DB_PATH);
    db.exec("PRAGMA journal_mode=WAL");
    const embeddingConfig = loadEmbeddingConfigFromUserFile();
    initializeEmbedding(embeddingConfig);

    // Find memories without embeddings (optionally filtered to one project)
    const query = projectFilter
        ? `SELECT m.id, m.content, m.category, m.project_path
           FROM memories m
           LEFT JOIN memory_embeddings me ON me.memory_id = m.id
           WHERE m.status != 'deleted' AND me.memory_id IS NULL AND m.project_path = ?`
        : `SELECT m.id, m.content, m.category, m.project_path
           FROM memories m
           LEFT JOIN memory_embeddings me ON me.memory_id = m.id
           WHERE m.status != 'deleted' AND me.memory_id IS NULL`;
    const stmt = db.prepare(query);
    const allMemories = (
        projectFilter ? stmt.all(projectFilter) : stmt.all()
    ) as Array<{ id: number; content: string; category: string; project_path: string }>;

    console.log(
        `Found ${allMemories.length} memories without embeddings${projectFilter ? ` in project ${projectFilter}` : ""}`,
    );

    if (allMemories.length === 0) {
        console.log("Nothing to do.");
        db.close();
        return;
    }

    // Initialize embedding model
    console.log("Loading embedding model...");
    const ready = await ensureEmbeddingModel();
    if (!ready) {
        console.error("Failed to load embedding model");
        db.close();
        process.exit(1);
    }
    console.log("Model loaded.");
    const modelId = getEmbeddingModelId();

    // Batch embed for efficiency
    const batchSize = 32;
    let embedded = 0;
    let failed = 0;

    for (let i = 0; i < allMemories.length; i += batchSize) {
        const batch = allMemories.slice(i, i + batchSize);
        const texts = batch.map((m) => m.content);

        try {
            const embeddings = await embedBatch(texts);

            for (let j = 0; j < batch.length; j++) {
                const memory = batch[j]!;
                const embedding = embeddings[j];
                if (embedding) {
                    saveEmbedding(db, memory.id, embedding, modelId);
                    embedded++;
                } else {
                    console.warn(`  Failed to embed memory ${memory.id}: null result`);
                    failed++;
                }
            }
        } catch (error) {
            console.error(`  Batch ${i}-${i + batch.length} failed:`, error);
            failed += batch.length;
        }

        console.log(`  Progress: ${embedded + failed}/${allMemories.length} (${embedded} embedded, ${failed} failed)`);
    }

    // Verify
    const embeddingCount = db
        .prepare("SELECT COUNT(*) as count FROM memory_embeddings")
        .get() as { count: number };

    console.log(`\nDone. ${embedded} embeddings saved, ${failed} failures.`);
    console.log(`Total embeddings in DB: ${embeddingCount.count}`);

    db.close();
}

main().catch(console.error);
