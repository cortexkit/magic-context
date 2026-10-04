/**
 * The local-embedding worker for the Claude Code build.
 *
 * The core runs local embedding models on a worker thread loaded from
 * `embedding-worker.js` beside the bundle. The Claude Code plugin does not ship
 * the model runtime, so this worker answers every request the way a worker that
 * could not load a model does: no vectors and a non-retryable reason. Memories
 * are still saved and searched lexically; another host with local embeddings
 * embeds them later.
 */
import { parentPort } from "node:worker_threads";
import type { EmbeddingWorkerReply } from "@magic-context/core/features/magic-context/memory/embedding-worker-client";

const failure = {
    class: "local_binding_missing",
    reason: 'local embeddings are not bundled with the Claude Code plugin; set embedding.provider to "openai-compatible" for semantic search under Claude Code',
    retryable: false,
} as const;

parentPort?.on("message", (request: { id: number }) => {
    const reply: EmbeddingWorkerReply = { id: request.id, loaded: false, failure };
    parentPort?.postMessage(reply);
});
