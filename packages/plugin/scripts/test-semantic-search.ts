#!/usr/bin/env bun
/**
 * Test semantic search against the memory DB.
 * Run: bun scripts/test-semantic-search.ts "your query"
 */
import { Database } from "../src/shared/sqlite";
import { ensureEmbeddingModel, embedText } from "../src/features/magic-context/memory/embedding";
import { loadAllEmbeddings } from "../src/features/magic-context/memory/storage-memory-embeddings";
import { cosineSimilarity } from "../src/features/magic-context/memory/embedding";

const DB_PATH = `${process.env.HOME}/.local/share/opencode/storage/plugin/magic-context/context.db`;
const query = process.argv[2] ?? "how does the historian work";

async function main() {
    const db = new Database(DB_PATH);
    db.exec("PRAGMA journal_mode=WAL");

    console.log(`Query: "${query}"\n`);

    // Load model
    await ensureEmbeddingModel();

    // Embed query
    const queryEmbedding = await embedText(query);
    if (!queryEmbedding) {
        console.error("Failed to embed query");
        process.exit(1);
    }

    // Load all embeddings
    // Use current repo's root commit hash as project identity
    const proc = Bun.spawnSync(["git", "rev-list", "--max-parents=0", "HEAD"], { stdout: "pipe" });
    const rootHash = new TextDecoder().decode(proc.stdout).trim().split("\n")[0] ?? "";
    const projectPath = rootHash ? `git:${rootHash}` : "";
    console.log(`Project: ${projectPath}`);

    const allEmbeddings = loadAllEmbeddings(db, projectPath);
    console.log(`Loaded ${allEmbeddings.size} embeddings\n`);

    // Compute similarities
    const scored = Array.from(allEmbeddings.entries()).map(([memoryId, embedding]) => ({
        memoryId,
        similarity: cosineSimilarity(queryEmbedding, embedding),
    }));

    scored.sort((a, b) => b.similarity - a.similarity);

    // Show top 10
    console.log("Top 10 results:");
    for (const result of scored.slice(0, 10)) {
        const memory = db
            .prepare("SELECT content, category FROM memories WHERE id = ?")
            .get(result.memoryId) as { content: string; category: string };
        console.log(`  [${result.similarity.toFixed(4)}] (${memory.category}) ${memory.content.slice(0, 120)}...`);
    }
}

main().catch(console.error);
