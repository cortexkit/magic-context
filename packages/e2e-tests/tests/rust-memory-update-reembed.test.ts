/// <reference types="bun-types" />

/**
 * Under MODULE authority a `ctx_memory update` is applied in the module and
 * mirrors back to the host as changed content. The mirror retires the row's now
 * stale embedding — and before this scenario existed, nothing put a fresh one
 * back until authority drained to TypeScript, so an edited memory quietly fell
 * out of scored recall for the rest of the session.
 *
 * The counts here follow the sequence a curating agent produces: write ->
 * one embedding row, update -> that row gone, then re-embedded from the new
 * content while the module still holds authority.
 *
 * The embedding provider is a local OpenAI-compatible stub so the lane stays
 * hermetic: no model download, deterministic vectors, and a record of exactly
 * which text was embedded.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { openTestDb } from "../src/test-db";
import { join } from "node:path";

import { RustTestHarness } from "../src/rust-harness";
import { rustPrereqs } from "../src/rust-scenario-support";

const EMBED_MODEL = "hermetic-embed";
const ORIGINAL_CONTENT = "Release gates run before the tag is pushed.";
const UPDATED_CONTENT = "Release gates run before the tag is pushed, and the tag is signed.";

interface EmbeddingStub {
    url: string;
    embedded: string[];
    stop(): void;
}

/** Deterministic OpenAI-compatible /v1/embeddings endpoint on loopback. */
function startEmbeddingStub(): EmbeddingStub {
    const embedded: string[] = [];
    const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(request) {
            if (!new URL(request.url).pathname.endsWith("/embeddings")) {
                return new Response("not found", { status: 404 });
            }
            const body = (await request.json()) as { input?: unknown };
            const inputs = Array.isArray(body.input)
                ? body.input.map((value) => String(value))
                : [String(body.input ?? "")];
            for (const text of inputs) embedded.push(text);
            return Response.json({
                model: EMBED_MODEL,
                data: inputs.map((text) => ({
                    embedding: [text.length / 100, (text.split(" ").length ?? 0) / 100, 0.5],
                })),
            });
        },
    });
    return {
        url: `http://127.0.0.1:${server.port}/v1`,
        embedded,
        stop: () => {
            server.stop(true);
        },
    };
}

describe.skipIf(!rustPrereqs.ok)("rust mode memory update re-embedding", () => {
    let h: RustTestHarness;
    let stub: EmbeddingStub;

    const magicContextConfig = (): Record<string, unknown> => ({
        memory: { enabled: true, injection_budget_tokens: 1_000 },
        embedding: {
            provider: "openai-compatible",
            endpoint: stub.url,
            model: EMBED_MODEL,
        },
    });

    beforeEach(async () => {
        stub = startEmbeddingStub();
        h = await RustTestHarness.create({
            startInTsMode: true,
            startHistorianProducer: false,
            magicContextConfig: magicContextConfig(),
        });
    });

    afterEach(async () => {
        await h?.dispose();
        stub?.stop();
    });

    it(
        "re-embeds an updated memory while the module still holds authority",
        async () => {
            const sessionId = await h.createSession();
            let toolUseCount = 0;
            const invokeMemoryTool = async (
                input: Record<string, unknown>,
                prompt: string,
            ): Promise<void> => {
                let emitted = false;
                h.mock.addMatcher((body) => {
                    if (emitted || !JSON.stringify(body.system ?? "").includes("## Magic Context")) {
                        return null;
                    }
                    const tools = Array.isArray(body.tools) ? body.tools : [];
                    const memoryTool = tools.find(
                        (tool) =>
                            tool !== null &&
                            typeof tool === "object" &&
                            (tool as { name?: unknown }).name === "ctx_memory",
                    ) as { name: string } | undefined;
                    if (!memoryTool) return null;
                    emitted = true;
                    toolUseCount += 1;
                    return {
                        content: [
                            {
                                type: "tool_use",
                                id: `toolu_reembed_${toolUseCount}`,
                                name: memoryTool.name,
                                input,
                            },
                        ],
                        stop_reason: "tool_use",
                        usage: {
                            input_tokens: 100,
                            output_tokens: 10,
                            cache_creation_input_tokens: 100,
                        },
                    };
                });
                await h.sendPrompt(sessionId, prompt);
                expect(emitted).toBe(true);
            };

            await invokeMemoryTool(
                { action: "write", category: "CONSTRAINTS", content: ORIGINAL_CONTENT },
                "record the release gate constraint",
            );

            const contextDbPath = join(h.env.dataDir, "cortexkit", "magic-context", "context.db");
            const readState = (): { memoryId: number; content: string; embeddings: number } => {
                const db = openTestDb(contextDbPath, { readonly: true });
                try {
                    const memory = db
                        .prepare(
                            "SELECT id, content FROM memories WHERE content LIKE 'Release gates run before%' ORDER BY id LIMIT 1",
                        )
                        .get() as { id: number; content: string } | undefined;
                    if (!memory) return { memoryId: 0, content: "", embeddings: 0 };
                    const count = db
                        .prepare(
                            "SELECT COUNT(*) AS count FROM memory_embeddings WHERE memory_id = ?",
                        )
                        .get(memory.id) as { count: number };
                    return {
                        memoryId: memory.id,
                        content: memory.content,
                        embeddings: count.count,
                    };
                } finally {
                    db.close();
                }
            };

            // write → embedded
            const written = await h.waitFor(
                () => {
                    const state = readState();
                    return state.memoryId > 0 && state.embeddings === 1 ? state : false;
                },
                { label: "TS-mode write is embedded" },
            );
            expect(written.content).toBe(ORIGINAL_CONTENT);
            expect(stub.embedded).toContain(ORIGINAL_CONTENT);

            await h.restart({ rust: true, magicContextConfig: magicContextConfig() });
            await h.sendPrompt(sessionId, "activate Rust authority over this project's memories");
            await h.waitForRustPasses(1);
            expect(readState().embeddings).toBe(1);

            stub.embedded.length = 0;
            await invokeMemoryTool(
                { action: "update", ids: [written.memoryId], content: UPDATED_CONTENT },
                "correct the release gate constraint",
            );

            // update → mirrored back with new content AND re-embedded, without
            // draining authority back to TypeScript.
            const healed = await h.waitFor(
                () => {
                    const state = readState();
                    return state.content === UPDATED_CONTENT && state.embeddings === 1
                        ? state
                        : false;
                },
                { label: "updated memory is re-embedded under module authority" },
            );
            expect(healed.memoryId).toBe(written.memoryId);
            expect(stub.embedded).toContain(UPDATED_CONTENT);

            // The vector stored is the one computed from the CURRENT content: the
            // guarded save refuses a vector whose content hash no longer matches.
            const verifyDb = openTestDb(contextDbPath, { readonly: true });
            try {
                const rows = verifyDb
                    .prepare(
                        `SELECT COUNT(*) AS count
                           FROM memories memory
                           JOIN memory_embeddings embedding ON embedding.memory_id = memory.id
                          WHERE memory.id = ? AND memory.content = ?`,
                    )
                    .get(written.memoryId, UPDATED_CONTENT) as { count: number };
                expect(rows.count).toBe(1);
            } finally {
                verifyDb.close();
            }
        },
        300_000,
    );
});
