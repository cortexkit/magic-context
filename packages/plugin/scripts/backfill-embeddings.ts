#!/usr/bin/env bun
/**
 * Backfill embeddings for all memories that don't have one yet.
 *
 * Reads the user's magic-context.jsonc (same as the running plugin) to resolve
 * the active embedding provider, so this works for local MiniLM, OpenAI-
 * compatible (LMStudio/Ollama), or any other configured endpoint.
 *
 * Run: bun scripts/backfill-embeddings.ts [--directory <cwd>] [--project <project_path>]
 *   --directory  Project directory used to resolve config and identity.
 *   --project    Only backfill memories for this project_path (must match --directory identity unless --force-project-path).
 */
import { Database } from "../src/shared/sqlite";
import { loadPluginConfig } from "../src/config";
import {
    embedBatchForProject,
    getProjectEmbeddingSnapshot,
    registerProjectEmbeddingAndMaybeWipe,
} from "../src/features/magic-context/memory/embedding";
import { resolveProjectIdentity } from "../src/features/magic-context/memory/project-identity";
import { saveEmbedding } from "../src/features/magic-context/memory/storage-memory-embeddings";

const DB_PATH = `${process.env.HOME}/.local/share/opencode/storage/plugin/magic-context/context.db`;
function getArg(name: string): string | null {
    const index = process.argv.indexOf(name);
    return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

async function main() {
    const directory = getArg("--directory") ?? process.cwd();
    const projectFilter = getArg("--project");
    const forceProjectPath = process.argv.includes("--force-project-path");
    const projectIdentity = resolveProjectIdentity(directory);

    if (projectFilter && projectFilter !== projectIdentity && !forceProjectPath) {
        console.error(
            `--project ${projectFilter} does not match identity for --directory ${directory}: ${projectIdentity}. ` +
                "Pass --force-project-path to override.",
        );
        process.exit(1);
    }

    const db = new Database(DB_PATH);
    db.exec("PRAGMA journal_mode=WAL");
    const config = loadPluginConfig(directory);
    registerProjectEmbeddingAndMaybeWipe(
        db,
        projectIdentity,
        config.embedding,
        {
            memoryEnabled: config.memory.enabled,
            gitCommitEnabled: config.experimental.git_commit_indexing.enabled,
        },
        directory,
    );

    // Find memories without embeddings (optionally filtered to one project)
    const effectiveProject = projectFilter ?? projectIdentity;
    const query = effectiveProject
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
        effectiveProject ? stmt.all(effectiveProject) : stmt.all()
    ) as Array<{ id: number; content: string; category: string; project_path: string }>;

    console.log(
        `Found ${allMemories.length} memories without embeddings${effectiveProject ? ` in project ${effectiveProject}` : ""}`,
    );

    if (allMemories.length === 0) {
        console.log("Nothing to do.");
        db.close();
        return;
    }

    const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
    if (!snapshot?.enabled) {
        console.error("Embedding is disabled for this project.");
        db.close();
        process.exit(1);
    }

    // Batch embed for efficiency
    const batchSize = 32;
    let embedded = 0;
    let failed = 0;

    for (let i = 0; i < allMemories.length; i += batchSize) {
        const batch = allMemories.slice(i, i + batchSize);
        const texts = batch.map((m) => m.content);

        try {
            const result = await embedBatchForProject(projectIdentity, texts);
            if (!result) {
                failed += batch.length;
                continue;
            }

            for (let j = 0; j < batch.length; j++) {
                const memory = batch[j]!;
                const embedding = result.vectors[j];
                if (embedding) {
                    saveEmbedding(db, memory.id, embedding, result.modelId);
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
