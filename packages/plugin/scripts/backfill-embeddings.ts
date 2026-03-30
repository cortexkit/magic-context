#!/usr/bin/env bun
/**
 * Backfill embeddings for all memories that don't have one yet.
 * Run: bun scripts/backfill-embeddings.ts
 */
import { Database } from "bun:sqlite";
import {
    embedBatch,
    ensureEmbeddingModel,
    getEmbeddingModelId,
    initializeEmbedding,
} from "../src/features/magic-context/memory/embedding";
import { DEFAULT_LOCAL_EMBEDDING_MODEL } from "../src/config/schema/magic-context";
import { saveEmbedding } from "../src/features/magic-context/memory/storage-memory-embeddings";

const DB_PATH = `${process.env.HOME}/.local/share/opencode/storage/plugin/magic-context/context.db`;

async function main() {
    const db = new Database(DB_PATH);
    db.run("PRAGMA journal_mode=WAL");
    initializeEmbedding({ provider: "local", model: DEFAULT_LOCAL_EMBEDDING_MODEL });

    // Find memories without embeddings
    const allMemories = db
        .prepare(
            `SELECT m.id, m.content, m.category, m.project_path
             FROM memories m
             LEFT JOIN memory_embeddings me ON me.memory_id = m.id
             WHERE m.status != 'deleted' AND me.memory_id IS NULL`,
        )
        .all() as Array<{ id: number; content: string; category: string; project_path: string }>;

    console.log(`Found ${allMemories.length} memories without embeddings`);

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
