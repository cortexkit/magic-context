/// <reference types="bun-types" />

/**
 * Rust mode reads workspace-shared memories directly from context.db. The same
 * ID is readable from a neighbouring project when workspace policy allows it,
 * but that does not grant permission to mutate the neighbour's row.
 *
 * This real-stack scenario checks shared reads, scoped write refusal, and
 * per-ID results for a mixed batch.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { openTestDb } from "../src/test-db";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { RustTestHarness } from "../src/rust-harness";
import { rustPrereqs } from "../src/rust-scenario-support";

const FOREIGN_PROJECT = "git:0000000000000000000000000000000000000478";
const FOREIGN_SHARED_CONTENT =
    "Shared constraint from a neighbouring project: never hand-edit generated wire fixtures.";

function normalizedHash(content: string): string {
    return createHash("sha256").update(content.trim().toLowerCase()).digest("hex");
}

describe.skipIf(!rustPrereqs.ok)("rust mode workspace-shared memory addressing", () => {
    let h: RustTestHarness;

    beforeEach(async () => {
        h = await RustTestHarness.create({
            startInTsMode: true,
            startHistorianProducer: false,
            magicContextConfig: {
                memory: { enabled: true, injection_budget_tokens: 1_000 },
                embedding: { provider: "off" },
            },
        });
    });

    afterEach(async () => {
        await h?.dispose();
    });

    it(
        "reads a foreign shared id, refuses to mutate it permanently, and reports a mixed batch per id",
        async () => {
            const sessionId = await h.createSession();

            // A TypeScript write initializes the project's identity and its shared memory row.
            let bootstrapWrite = false;
            h.mock.addMatcher((body) => {
                if (
                    bootstrapWrite ||
                    !JSON.stringify(body.system ?? "").includes("## Magic Context")
                ) {
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
                bootstrapWrite = true;
                return {
                    content: [
                        {
                            type: "tool_use",
                            id: "toolu_shared_memory_bootstrap",
                            name: memoryTool.name,
                            input: {
                                action: "write",
                                category: "CONSTRAINTS",
                                content: "Own project constraint that the module mirrors.",
                            },
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
            await h.sendPrompt(sessionId, "initialize the TypeScript memory store");
            expect(bootstrapWrite).toBe(true);

            const contextDbPath = join(h.env.dataDir, "cortexkit", "magic-context", "context.db");
            const seedDb = openTestDb(contextDbPath);
            let projectIdentity = "";
            let ownMemoryId = 0;
            let foreignMemoryId = 0;
            try {
                const ownRow = seedDb
                    .prepare("SELECT id, project_path FROM memories ORDER BY id LIMIT 1")
                    .get() as { id: number; project_path: string } | undefined;
                expect(ownRow).toBeTruthy();
                projectIdentity = ownRow?.project_path ?? "";
                ownMemoryId = ownRow?.id ?? 0;

                // Share the CONSTRAINTS category between these projects and add a
                // neighbouring project's memory. Both runtimes use the same context.db IDs.
                seedDb.transaction(() => {
                    seedDb
                        .prepare(
                            "INSERT INTO workspaces (id, name, created_at, updated_at, share_categories) VALUES (1, 'hermetic-ws', 1, 1, ?)",
                        )
                        .run(JSON.stringify(["CONSTRAINTS"]));
                    const member = seedDb.prepare(
                        "INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at) VALUES (1, ?, ?, ?, 1)",
                    );
                    member.run(projectIdentity, "Own", projectIdentity);
                    member.run(FOREIGN_PROJECT, "Neighbour", FOREIGN_PROJECT);
                    seedDb
                        .prepare(
                            `INSERT INTO memories(
                                project_path, category, content, normalized_hash, importance, scope,
                                shareable, source_session_id, source_type, seen_count, retrieval_count,
                                first_seen_at, created_at, updated_at, last_seen_at, status,
                                verification_status
                            ) VALUES (?, 'CONSTRAINTS', ?, ?, 60, 'project', 1, ?, 'agent', 1, 0,
                                ?, ?, ?, ?, 'active', 'unverified')`,
                        )
                        .run(
                            FOREIGN_PROJECT,
                            FOREIGN_SHARED_CONTENT,
                            normalizedHash(FOREIGN_SHARED_CONTENT),
                            sessionId,
                            1_800_000_000_000,
                            1_800_000_000_000,
                            1_800_000_000_000,
                            1_800_000_000_000,
                        );
                })();
                foreignMemoryId = (
                    seedDb
                        .prepare("SELECT id FROM memories WHERE project_path = ?")
                        .get(FOREIGN_PROJECT) as { id: number }
                ).id;
            } finally {
                seedDb.close();
            }
            expect(projectIdentity).toBeTruthy();
            expect(foreignMemoryId).toBeGreaterThan(0);

            await h.restart({ rust: true });
            await h.sendPrompt(sessionId, "activate Rust mode over the seeded shared memories");
            await h.waitForRustPasses(1);

            expect(h.contextDb().prepare("SELECT project_path FROM memories WHERE id=?").get(foreignMemoryId))
                .toEqual({ project_path: FOREIGN_PROJECT });

            let toolUseCount = 0;
            const invokeMemoryTool = async (
                input: Record<string, unknown>,
                prompt: string,
            ): Promise<string> => {
                h.mock.reset();
                h.mock.setDefault({
                    text: "ok",
                    usage: {
                        input_tokens: 100,
                        output_tokens: 20,
                        cache_creation_input_tokens: 100,
                    },
                });
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
                                id: `toolu_shared_memory_${toolUseCount}`,
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
                // Only the messages this call added; an earlier tool result must
                // never satisfy a later assertion.
                const before = (await h.listMessages(sessionId)).length;
                await h.sendPrompt(sessionId, prompt);
                expect(emitted).toBe(true);
                return JSON.stringify((await h.listMessages(sessionId)).slice(before));
            };

            const read = await invokeMemoryTool(
                { action: "get", ids: [foreignMemoryId] },
                "read the shared memory through ctx_memory",
            );
            expect(read).toContain("never hand-edit generated wire fixtures");
            expect(read).not.toContain("has no module mapping yet");

            const mutation = await invokeMemoryTool(
                {
                    action: "update",
                    ids: [foreignMemoryId],
                    content: "this project must not rewrite a neighbour's memory",
                },
                "try to curate the shared memory through ctx_memory",
            );
            expect(mutation).toContain(`Memory with ID ${foreignMemoryId} was not found`);
            expect(mutation).not.toContain("Updated memory");

            const mixed = await invokeMemoryTool(
                { action: "get", ids: [ownMemoryId, foreignMemoryId, 987_654] },
                "read a mixed batch of memory ids through ctx_memory",
            );
            expect(mixed).toContain("Own project constraint that the module mirrors.");
            expect(mixed).toContain("never hand-edit generated wire fixtures");
            expect(mixed).toContain("id 987654: not found or not visible from this project");

            // The neighbour's row is untouched by the refused mutation.
            const verifyDb = openTestDb(contextDbPath, { readonly: true });
            try {
                const row = verifyDb
                    .prepare("SELECT content FROM memories WHERE id = ?")
                    .get(foreignMemoryId) as { content: string };
                expect(row.content).toBe(FOREIGN_SHARED_CONTENT);
            } finally {
                verifyDb.close();
            }
            expect(toolUseCount).toBe(3);
        },
        300_000,
    );
});
