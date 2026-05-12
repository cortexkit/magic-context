import type { EmbeddingConfig } from "../../../config/schema/magic-context";
import { DEFAULT_LOCAL_EMBEDDING_MODEL } from "../../../config/schema/magic-context";
import { log } from "../../../shared/logger";
import type { Database, Statement as PreparedStatement } from "../../../shared/sqlite";
import { cosineSimilarity } from "./cosine-similarity";
import { getEmbeddingProviderIdentity } from "./embedding-identity";
import { LocalEmbeddingProvider } from "./embedding-local";
import { OpenAICompatibleEmbeddingProvider } from "./embedding-openai";
import type { EmbeddingProvider } from "./embedding-provider";
import { saveEmbedding } from "./storage-memory-embeddings";

const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
    provider: "local",
    model: DEFAULT_LOCAL_EMBEDDING_MODEL,
};

let embeddingConfig: EmbeddingConfig = DEFAULT_EMBEDDING_CONFIG;
let provider: EmbeddingProvider | null = null;

interface UnembeddedMemoryRow {
    id: number;
    content: string;
}

const loadUnembeddedMemoriesStatements = new WeakMap<Database, PreparedStatement>();

function isUnembeddedMemoryRow(row: unknown): row is UnembeddedMemoryRow {
    if (row === null || typeof row !== "object") {
        return false;
    }

    const candidate = row as Record<string, unknown>;
    return typeof candidate.id === "number" && typeof candidate.content === "string";
}

function getLoadUnembeddedMemoriesStatement(db: Database): PreparedStatement {
    let stmt = loadUnembeddedMemoriesStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT m.id AS id, m.content AS content FROM memories m LEFT JOIN memory_embeddings me ON m.id = me.memory_id WHERE m.project_path = ? AND m.status = 'active' AND me.memory_id IS NULL LIMIT ?",
        );
        loadUnembeddedMemoriesStatements.set(db, stmt);
    }

    return stmt;
}

function resolveEmbeddingConfig(config?: EmbeddingConfig): EmbeddingConfig {
    if (!config || config.provider === "local") {
        return {
            provider: "local",
            model: config?.model?.trim() || DEFAULT_LOCAL_EMBEDDING_MODEL,
        };
    }

    if (config.provider === "openai-compatible") {
        const apiKey = config.api_key?.trim();
        return {
            provider: "openai-compatible",
            model: config.model.trim(),
            endpoint: config.endpoint.trim(),
            ...(apiKey ? { api_key: apiKey } : {}),
        };
    }

    return { provider: "off" };
}

function resolveProviderIdentity(config: EmbeddingConfig): string {
    return getEmbeddingProviderIdentity(config);
}

function createProvider(config: EmbeddingConfig): EmbeddingProvider | null {
    if (config.provider === "off") {
        return null;
    }

    if (config.provider === "openai-compatible") {
        return new OpenAICompatibleEmbeddingProvider({
            endpoint: config.endpoint,
            model: config.model,
            apiKey: config.api_key,
        });
    }

    return new LocalEmbeddingProvider(config.model);
}

function getOrCreateProvider(): EmbeddingProvider | null {
    if (provider) {
        return provider;
    }

    provider = createProvider(embeddingConfig);
    return provider;
}

export function initializeEmbedding(config: EmbeddingConfig): void {
    const nextConfig = resolveEmbeddingConfig(config);
    const nextProviderIdentity = resolveProviderIdentity(nextConfig);
    const previousProvider = provider;
    const previousProviderIdentity =
        previousProvider?.modelId ?? resolveProviderIdentity(embeddingConfig);

    if (previousProviderIdentity === nextProviderIdentity) {
        embeddingConfig = nextConfig;
        return;
    }

    embeddingConfig = nextConfig;
    provider = null;

    if (previousProvider) {
        void previousProvider.dispose().catch((error) => {
            log("[magic-context] embedding provider dispose failed:", error);
        });
    }
}

export function isEmbeddingEnabled(): boolean {
    return embeddingConfig.provider !== "off";
}

export async function ensureEmbeddingModel(): Promise<boolean> {
    const currentProvider = getOrCreateProvider();
    if (!currentProvider) {
        return false;
    }

    return currentProvider.initialize();
}

export async function embedText(text: string, signal?: AbortSignal): Promise<Float32Array | null> {
    const currentProvider = getOrCreateProvider();
    if (!currentProvider) {
        return null;
    }

    if (!(await currentProvider.initialize())) {
        return null;
    }

    return currentProvider.embed(text, signal);
}

export async function embedBatch(
    texts: string[],
    signal?: AbortSignal,
): Promise<(Float32Array | null)[]> {
    if (texts.length === 0) {
        return [];
    }

    const currentProvider = getOrCreateProvider();
    if (!currentProvider) {
        return Array.from({ length: texts.length }, () => null);
    }

    if (!(await currentProvider.initialize())) {
        return Array.from({ length: texts.length }, () => null);
    }

    return currentProvider.embedBatch(texts, signal);
}

export async function embedUnembeddedMemories(
    db: Database,
    projectPath: string,
    config: EmbeddingConfig,
    batchSize = 10,
): Promise<number> {
    return embedUnembeddedMemoriesForProject(db, projectPath, config, batchSize);
}

/** Wall-clock ceiling per sweep invocation — ensures a hung/slow endpoint can't
 *  hold the sweep running across many 15-min ticks. On ceiling, the sweep
 *  gracefully stops; the next tick picks up the remaining work. */
const SWEEP_MAX_WALL_CLOCK_MS = 10 * 60 * 1000;

/** If N consecutive batches return zero embedded memories, stop — that signals
 *  the endpoint is failing silently or there's nothing left to do. Without
 *  this guard, a broken provider would loop until the wall-clock deadline. */
const SWEEP_MAX_CONSECUTIVE_EMPTY = 3;

/** Singleton guard: prevents a second dream-timer tick from spawning a
 *  parallel sweep while the previous one is still draining. */
let sweepInProgress = false;

/**
 * Sweep ALL projects for unembedded memories, draining each fully before
 * moving to the next. Projects are ordered by most-recent memory activity
 * (MAX(updated_at)), so the project you're actively working in gets
 * embedded first after a provider switch.
 *
 * Within one invocation:
 *   - Each project is drained in batches of `batchSize` until `embedUnembeddedMemoriesForProject`
 *     returns 0 (nothing left, or a batch failure).
 *   - Wall-clock deadline + consecutive-empty fail-safe prevent runaway
 *     or infinite looping when the provider is unhealthy.
 *
 * Between invocations:
 *   - The module-level `sweepInProgress` flag guards against parallel runs
 *     from the same process. If a sweep is still running when the next
 *     15-min tick fires, that tick is a no-op.
 *
 * Used by the dream timer for proactive embedding coverage. After a
 * provider change wipes embeddings, this path drains the full backlog on
 * a single tick (bounded by wall clock) instead of trickling 10/15min.
 */
export async function embedAllUnembeddedMemories(
    db: Database,
    config: EmbeddingConfig,
    batchSize = 10,
): Promise<number> {
    if (sweepInProgress) {
        log("[magic-context] embedding sweep already in progress, skipping this tick");
        return 0;
    }
    sweepInProgress = true;
    const startedAt = Date.now();
    const deadline = startedAt + SWEEP_MAX_WALL_CLOCK_MS;

    try {
        const resolvedConfig = resolveEmbeddingConfig(config);
        if (resolvedConfig.provider === "off") return 0;

        // Order projects by most-recent memory activity so the live project
        // drains first. `updated_at` reflects both new writes and existing
        // memory updates, which is what we want: any fresh churn = recent.
        const projects = db
            .prepare(
                `SELECT m.project_path, MAX(m.updated_at) AS latest
                 FROM memories m
                 WHERE m.status IN ('active', 'permanent')
                 AND m.id NOT IN (SELECT memory_id FROM memory_embeddings)
                 GROUP BY m.project_path
                 ORDER BY latest DESC
                 LIMIT 20`,
            )
            .all() as Array<{ project_path: string; latest: number }>;

        let total = 0;
        let consecutiveEmpty = 0;

        outer: for (const project of projects) {
            while (Date.now() < deadline) {
                const count = await embedUnembeddedMemoriesForProject(
                    db,
                    project.project_path,
                    config,
                    batchSize,
                );
                if (count === 0) {
                    // Either drained or the batch silently failed. Either
                    // way, this project can't make progress right now.
                    consecutiveEmpty += 1;
                    if (consecutiveEmpty >= SWEEP_MAX_CONSECUTIVE_EMPTY) {
                        log(
                            `[magic-context] embedding sweep: ${SWEEP_MAX_CONSECUTIVE_EMPTY} consecutive empty batches, stopping (total=${total})`,
                        );
                        break outer;
                    }
                    break; // move to next project
                }
                consecutiveEmpty = 0;
                total += count;

                // Partial batch = fewer rows than batchSize = project drained.
                if (count < batchSize) break;
            }

            if (Date.now() >= deadline) {
                log(
                    `[magic-context] embedding sweep: wall-clock deadline reached after ${((Date.now() - startedAt) / 1000).toFixed(1)}s (total=${total})`,
                );
                break;
            }
        }

        return total;
    } finally {
        sweepInProgress = false;
    }
}

/** Test-only: reset the in-progress guard. */
export function _resetEmbeddingSweepGuard(): void {
    sweepInProgress = false;
}

async function embedUnembeddedMemoriesForProject(
    db: Database,
    projectPath: string,
    config: EmbeddingConfig,
    batchSize = 10,
): Promise<number> {
    const normalizedBatchSize = Math.max(1, Math.floor(batchSize));
    const resolvedConfig = resolveEmbeddingConfig(config);

    if (resolvedConfig.provider === "off") {
        return 0;
    }

    initializeEmbedding(resolvedConfig);

    const memories = getLoadUnembeddedMemoriesStatement(db)
        .all(projectPath, normalizedBatchSize)
        .filter(isUnembeddedMemoryRow);
    if (memories.length === 0) {
        return 0;
    }

    try {
        const embeddings = await embedBatch(memories.map((memory) => memory.content));
        const modelId = getEmbeddingModelId();
        if (modelId === "off") {
            return 0;
        }

        let embeddedCount = 0;
        db.transaction(() => {
            for (const [index, memory] of memories.entries()) {
                const embedding = embeddings[index];
                if (!embedding) {
                    continue;
                }

                saveEmbedding(db, memory.id, embedding, modelId);
                embeddedCount += 1;
            }
        })();

        return embeddedCount;
    } catch (error) {
        log("[magic-context] failed to proactively embed missing memories:", error);
        return 0;
    }
}

export function getEmbeddingModelId(): string {
    return getOrCreateProvider()?.modelId ?? "off";
}

export { cosineSimilarity };

export async function disposeEmbeddingModel(): Promise<void> {
    const currentProvider = provider;
    provider = null;

    if (!currentProvider) {
        return;
    }

    await currentProvider.dispose();
}
