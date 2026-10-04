// src/embedding-worker.ts
import { parentPort } from "node:worker_threads";
var failure = {
  class: "local_binding_missing",
  reason: 'local embeddings are not bundled with the Claude Code plugin; set embedding.provider to "openai-compatible" for semantic search under Claude Code',
  retryable: false
};
parentPort?.on("message", (request) => {
  const reply = { id: request.id, loaded: false, failure };
  parentPort?.postMessage(reply);
});
