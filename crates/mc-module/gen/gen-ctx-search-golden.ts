// Capture current TypeScript tool-result bytes without opening a store or a provider.
import { formatSearchResults, type UnifiedSearchResult } from "../../../packages/plugin/src/features/magic-context/search";
import { getEmbeddingProviderIdentity } from "../../../packages/plugin/src/features/magic-context/memory/embedding-identity";
import { createHash } from "node:crypto";
import { getSynapseLaneIdentity } from "../../../packages/plugin/src/features/magic-context/memory/embedding-synapse";

const query = "needle";
const cases: Record<string, UnifiedSearchResult[]> = {
    memory: [{ source: "memory", memoryId: 1, category: "CONSTRAINTS", content: "needle memory", score: 0.8, matchType: "fts" }],
    message: [{ source: "message", messageOrdinal: 4, messageId: "raw-4", role: "user", content: "needle archived text", score: 1 }],
    primer: [{ source: "primer", primerId: 1, question: "needle question", content: "Q: needle question A: A supported answer", support: 3, lastObservedAt: 1, score: 1, matchType: "fts" }],
    git: [{ source: "git_commit", sha: "a".repeat(40), shortSha: "aaaaaaa", author: null, committedAtMs: Date.UTC(2099, 0, 1), content: "needle commit", score: 0.8, matchType: "fts" }],
    note: [{ source: "note", noteId: 1, status: "active", createdAt: Date.UTC(2099, 0, 1), anchorOrdinal: 4, sourceSessionId: "ses", content: "needle note", score: 0.8 / 7 }],
    compartment: [{ source: "compartment", compartmentId: 1, sessionId: "ses", startOrdinal: 1, endOrdinal: 5, title: "C1", content: "C1", score: 0.8, matchType: "semantic" }],
};
const modelId = getEmbeddingProviderIdentity({provider:"openai-compatible",model:"fixture",endpoint:"https://embedding.invalid/v1"});
const chunk = {chunkerVersion:2,maxInputTokens:512,providerIdentity:modelId,truncate:""};
const chunkId = `${modelId}:chunk:${createHash("sha256").update(JSON.stringify(chunk)).digest("hex").slice(0,16)}`;
await Bun.write(new URL("../testdata/ctx-search-tool-golden.json", import.meta.url), `${JSON.stringify({outputs:Object.fromEntries(Object.entries(cases).map(([name, hits]) => [name, formatSearchResults(query, hits, "ses") ])),embedding:{modelId,chunkId,synapseId:getSynapseLaneIdentity("gte-modernbert-base-f16","b".repeat(64))}}, null, 2)}\n`);
