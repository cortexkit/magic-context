import { describe, expect, it } from "bun:test";

import type { EmbeddingConfig } from "../config/schema/magic-context";
import {
    type EmbeddingLoadResultDetailed,
    isConfigLoadUntrusted,
} from "./embedding-bootstrap-helpers";

type Detailed = EmbeddingLoadResultDetailed<{ embedding: EmbeddingConfig }>;

function makeDetailed(embedding: EmbeddingConfig): Detailed {
    return {
        config: { embedding },
        loadOutcome: "ok",
        sources: { userConfig: "ok", projectConfig: "ok" },
        substitutionFailures: [],
        recoveredTopLevelKeys: [],
    };
}

describe("isConfigLoadUntrusted — literal config tokens", () => {
    it("treats a literal {env:} token in an embedding field as untrusted", () => {
        // A project config can leave {env:}/{file:} tokens literal (no expansion
        // for security). If one lands in an embedding field the registry would
        // hash a bogus identity, clear the untrusted latch, and GC could reap the
        // real model's vectors — so the load must be untrusted regardless of how
        // the (generic, key-path-less) substitution warning was worded.
        const detailed = makeDetailed({
            provider: "openai-compatible",
            model: "qwen/qwen3-embedding-8b",
            endpoint: "{env:EMBED_ENDPOINT}/v1",
        });
        expect(isConfigLoadUntrusted(detailed)).toBe(true);
    });

    it("treats a literal {file:} token in the api_key as untrusted", () => {
        const detailed = makeDetailed({
            provider: "openai-compatible",
            model: "qwen/qwen3-embedding-8b",
            endpoint: "https://openrouter.ai/api/v1",
            api_key: "{file:~/.config/key}",
        });
        expect(isConfigLoadUntrusted(detailed)).toBe(true);
    });

    it("trusts a fully-resolved embedding config", () => {
        const detailed = makeDetailed({
            provider: "openai-compatible",
            model: "qwen/qwen3-embedding-8b",
            endpoint: "https://openrouter.ai/api/v1",
            api_key: "sk-real-resolved-value",
        });
        expect(isConfigLoadUntrusted(detailed)).toBe(false);
    });

    it("trusts a local provider with no tokens", () => {
        const detailed = makeDetailed({ provider: "local", model: "minilm" });
        expect(isConfigLoadUntrusted(detailed)).toBe(false);
    });
});

describe("isConfigLoadUntrusted — recovered fields", () => {
    it.each([
        "embedding.provider",
        "embedding.model",
        "embedding.endpoint",
        "embedding.api_key",
        "embedding.input_type",
        "embedding.query_input_type",
        "embedding.query_instruction",
        "embedding.document_prefix",
        "embedding.truncate",
        "embedding.max_input_tokens",
        "embedding.local_runtime",
        "embedding.local_dtype",
        "embedding.fallback_provider",
        "subc.connection_file",
        "shadow_embedding.enabled",
        "memory.enabled",
        "memory.git_commit_indexing.enabled",
        "allow_home_project",
        "embedding",
        "memory",
        "memory.git_commit_indexing",
        "subc",
        "shadow_embedding",
    ])("distrusts recovery of %s", (path) => {
        const detailed = makeDetailed({ provider: "off" });
        detailed.recoveredTopLevelKeys = [path.split(".")[0]];
        detailed.recoveredFieldPaths = [path];
        expect(isConfigLoadUntrusted(detailed)).toBe(true);
    });

    it.each([
        "memory.injection_budget_tokens",
        "memory.auto_promote",
        "memory.retrieval_count_promotion_threshold",
        "memory.auto_search",
        "memory.auto_search.enabled",
        "memory.auto_search.score_threshold",
        "memory.auto_search.min_prompt_chars",
        "memory.git_commit_indexing.since_days",
        "memory.git_commit_indexing.max_commits",
        "experimental",
    ])("trusts recovery of a non-identity setting: %s", (path) => {
        const detailed = makeDetailed({ provider: "off" });
        detailed.recoveredTopLevelKeys = [path.split(".")[0]];
        detailed.recoveredFieldPaths = [path];
        expect(isConfigLoadUntrusted(detailed)).toBe(false);
    });
});
