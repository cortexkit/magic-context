/**
 * Build-time stand-in for `@huggingface/transformers`.
 *
 * Local embeddings need Transformers.js, an ONNX runtime and a downloaded model;
 * none of that ships in a plugin Claude Code copies without node_modules. The
 * core only imports Transformers.js lazily, when a local model is first loaded,
 * so this module fails that load the way an absent runtime does: the embedding
 * is skipped and search stays lexical. Configure an OpenAI-compatible embedding
 * endpoint to get semantic search under Claude Code.
 */
throw new Error(
    'Local embeddings are not bundled with the Magic Context Claude Code plugin; configure embedding.provider "openai-compatible" for semantic search',
);
