/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { Database, withPrivilegedWriter } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { installAuthorityManagedMarker } from "../context-authority";
import { getMemoryById, insertMemory } from "../memory";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import {
    applyClassifications,
    type ClassifyArgs,
    type ClassifyModuleCallArgs,
    runClassify,
} from "./classify";
import { acquireLease } from "./lease";

function assistantMessages(text: string) {
    return [
        {
            info: { role: "assistant", time: { created: Date.now() } },
            parts: [{ type: "text", text }],
        },
    ];
}

function successfulClassifyClient(onPrompt?: () => void, onSystem?: (system: string) => void) {
    let manifest = "";
    return {
        session: {
            create: async () => ({ data: { id: "classify-child" } }),
            prompt: async (args: {
                body?: { system?: string; parts?: Array<{ text?: string }> };
            }) => {
                const prompt = args.body?.parts?.[0]?.text ?? "";
                onSystem?.(args.body?.system ?? "");
                const ids = [...prompt.matchAll(/^\[(\d+)\]/gm)].map((match) => Number(match[1]));
                manifest = `<classify>${ids.map((id) => `<memory id="${id}" importance="80" scope="project" shareable="true"/>`).join("")}</classify>`;
                onPrompt?.();
                return {};
            },
            messages: async () => ({ data: assistantMessages(manifest) }),
            delete: async () => ({}),
        },
    };
}

function freshDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function classifyArgs(db: Database, projectIdentity: string): ClassifyArgs {
    const holderId = "classify-holder";
    const leaseKey = `classify-${Math.random()}`;
    expect(acquireLease(db, holderId, leaseKey)).toBe(true);
    return {
        db,
        client: {} as never,
        projectIdentity,
        parentSessionId: undefined,
        sessionDirectory: process.cwd(),
        holderId,
        leaseKey,
        deadline: Date.now() + 60_000,
    };
}

describe("runClassify disposition", () => {
    test("localizes the TypeScript classifier system prompt", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:classify-language";
            addMemoriesForDisposition(db, projectIdentity, 10);
            const args = classifyArgs(db, projectIdentity);
            args.language = "tr";
            let system = "";
            args.client = successfulClassifyClient(undefined, (value) => {
                system = value;
            }) as never;

            const result = await runClassify(args);

            expect(result.classified).toBe(10);
            expect(system).toContain(
                "Write human-readable prose you author in: Turkish (Türkçe).",
            );
        } finally {
            closeQuietly(db);
        }
    });

    test("banks a completed chunk and reports the deadline remainder", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:classify-deadline";
            addMemoriesForDisposition(db, projectIdentity, 101);
            const args = classifyArgs(db, projectIdentity);
            args.client = successfulClassifyClient(() => {
                args.deadline = Date.now() - 1;
            }) as never;

            const result = await runClassify(args);

            expect(result.classified).toBe(100);
            expect(result.remaining).toBe(1);
            expect(result.complete).toBe(false);
        } finally {
            closeQuietly(db);
        }
    });

    test("reports complete after fully draining the selected set", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:classify-complete";
            addMemoriesForDisposition(db, projectIdentity, 10);
            const args = classifyArgs(db, projectIdentity);
            args.client = successfulClassifyClient() as never;

            const result = await runClassify(args);
            expect(result.classified).toBe(10);
            expect(result.remaining).toBe(0);
            expect(result.complete).toBe(true);
        } finally {
            closeQuietly(db);
        }
    });

    test("reports a swallowed chunk failure as incomplete", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:classify-failure";
            addMemoriesForDisposition(db, projectIdentity, 10);
            const args = classifyArgs(db, projectIdentity);
            args.client = {
                session: {
                    create: async () => {
                        throw new Error("provider unavailable");
                    },
                },
            } as never;

            const result = await runClassify(args);
            expect(result.complete).toBe(false);
            expect(result.remaining).toBe(10);
        } finally {
            closeQuietly(db);
        }
    });
});

function addMemoriesForDisposition(db: Database, projectIdentity: string, count: number): void {
    for (let index = 0; index < count; index += 1) {
        insertMemory(db, {
            projectPath: projectIdentity,
            category: "ARCHITECTURE",
            content: `Classification fact ${index}.`,
            sourceSessionId: "ses",
        });
    }
}

describe("applyClassifications", () => {
    test("complete manifest applies classification fields", () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:test";
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Important project fact.",
                sourceSessionId: "ses",
            });

            const result = applyClassifications(
                classifyArgs(db, projectIdentity),
                [memory],
                `<classify><memory id="${memory.id}" importance="85" scope="project" shareable="true"/></classify>`,
            );

            expect(result.classified).toBe(1);
            const after = getMemoryById(db, memory.id);
            expect(after?.importance).toBe(85);
            expect(after?.scope).toBe("project");
            expect(after?.shareable).toBe(1);
        } finally {
            closeQuietly(db);
        }
    });

    test("truncated manifest rejects before stamping classified_at", () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:test";
            const memory = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Important project fact.",
                sourceSessionId: "ses",
            });
            const before = getMemoryById(db, memory.id);
            const beforeRow = db
                .prepare("SELECT classified_at FROM memories WHERE id = ?")
                .get(memory.id) as { classified_at?: number | null } | undefined;

            expect(() =>
                applyClassifications(
                    classifyArgs(db, projectIdentity),
                    [memory],
                    `<classify><memory id="${memory.id}" importance="85"`,
                ),
            ).toThrow(/closing root/);

            const after = getMemoryById(db, memory.id);
            expect(after?.importance).toBe(before?.importance);
            expect(after?.scope).toBe(before?.scope);
            expect(after?.shareable).toBe(before?.shareable);
            const afterRow = db
                .prepare("SELECT classified_at FROM memories WHERE id = ?")
                .get(memory.id) as { classified_at?: number | null } | undefined;
            expect(afterRow?.classified_at).toBe(beforeRow?.classified_at);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("module-backed classification", () => {
    function addMirrorMapping(
        db: Database,
        projectIdentity: string,
        contextRowId: number,
        moduleRowId: number,
        normalizedHash: string,
    ): void {
        withPrivilegedWriter(db, () => {
            db.prepare(
                "INSERT INTO mirror_identity(domain, module_project, module_row_id, context_row_id) VALUES ('memories', ?, ?, ?)",
            ).run(projectIdentity, moduleRowId, contextRowId);
            db.prepare(
                "INSERT INTO mirror_live_memory_rows(module_project, module_row_id, category, normalized_hash) VALUES (?, ?, 'ARCHITECTURE', ?)",
            ).run(projectIdentity, moduleRowId, normalizedHash);
        });
    }

    function moduleArgs(
        db: Database,
        projectIdentity: string,
        onCall: (call: ClassifyModuleCallArgs) => unknown,
    ): ClassifyArgs {
        const args = classifyArgs(db, projectIdentity);
        args.moduleSessionId = "module-session";
        args.moduleProjectRoot = "/repo";
        args.moduleContextStoreUuid = "store";
        args.moduleAuthorityGeneration = 3;
        args.moduleClient = { call: async (call) => onCall(call) };
        return args;
    }

    function addMemories(db: Database, projectIdentity: string, count: number): number[] {
        return Array.from(
            { length: count },
            (_, index) =>
                insertMemory(db, {
                    projectPath: projectIdentity,
                    category: "ARCHITECTURE",
                    content: `Module-backed memory ${index}`,
                    sourceSessionId: "ses",
                }).id,
        );
    }

    test("sends profile-resolved models with translated module ids and hashes", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:module-classify";
            const contextIds = addMemories(db, projectIdentity, 10);
            addMirrorMapping(db, projectIdentity, contextIds[0], 9001, "module-hash");
            for (const [index, contextId] of contextIds.slice(1).entries()) {
                addMirrorMapping(db, projectIdentity, contextId, 9002 + index, `hash-${index}`);
            }
            installAuthorityManagedMarker(db, projectIdentity, "store");

            const calls: ClassifyModuleCallArgs[] = [];
            const args = moduleArgs(db, projectIdentity, (call) => {
                calls.push(call);
                if (call.method === "dreamer.run_task") {
                    const items = (
                        call.body as {
                            payload: {
                                items: Array<{ memory_id: number; content_hash: string }>;
                            };
                        }
                    ).payload.items;
                    const manifest = items
                        .map(
                            (item) =>
                                `<memory id="${item.memory_id}" importance="80" scope="project" shareable="true"/>`,
                        )
                        .join("\n");
                    return { result: { manifest_text: `<classify>${manifest}</classify>` } };
                }
                const rows = (
                    call.body as {
                        arguments: { rows: Array<{ memory_id: number }> };
                    }
                ).arguments.rows;
                return { result: { accepted: rows.map((row) => row.memory_id), rejected: [] } };
            });
            args.model = "anthropic/profile-dreamer";
            args.fallbackModels = ["openai/profile-fallback"];
            const result = await runClassify(args);

            expect(result).toEqual({
                classified: 10,
                changed: 10,
                chunks: 1,
                stage: 2,
                remaining: 0,
                complete: true,
            });
            const taskCall = calls.find((call) => call.method === "dreamer.run_task");
            const applyCall = calls.find((call) => call.method === "memory.set_classification");
            expect((taskCall?.body as { model_chain: string[] }).model_chain).toEqual([
                "anthropic/profile-dreamer",
                "openai/profile-fallback",
            ]);
            expect(
                (
                    taskCall?.body as {
                        payload: { items: Array<{ memory_id: number; content_hash: string }> };
                    }
                ).payload.items.some(
                    (item) => item.memory_id === 9001 && item.content_hash === "module-hash",
                ),
            ).toBe(true);
            expect(
                (
                    applyCall?.body as {
                        arguments: {
                            rows: Array<{ memory_id: number; content_hash_at_prompt: string }>;
                        };
                    }
                ).arguments.rows.some(
                    (row) => row.memory_id === 9001 && row.content_hash_at_prompt === "module-hash",
                ),
            ).toBe(true);
            expect(
                db.prepare("SELECT classified_at FROM memories WHERE id = ?").get(contextIds[0]),
            ).toEqual({ classified_at: null });
        } finally {
            closeQuietly(db);
        }
    });

    test("excludes active context rows without a mirror mapping", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:module-unmapped";
            const contextIds = addMemories(db, projectIdentity, 11);
            for (const [index, contextId] of contextIds.slice(0, 10).entries()) {
                addMirrorMapping(db, projectIdentity, contextId, 9100 + index, `hash-${index}`);
            }
            installAuthorityManagedMarker(db, projectIdentity, "store");

            let itemIds: number[] = [];
            await runClassify(
                moduleArgs(db, projectIdentity, (call) => {
                    if (call.method === "dreamer.run_task") {
                        itemIds = (
                            call.body as { payload: { items: Array<{ memory_id: number }> } }
                        ).payload.items.map((item) => item.memory_id);
                        const manifest = itemIds
                            .map(
                                (id) =>
                                    `<memory id="${id}" importance="80" scope="project" shareable="true"/>`,
                            )
                            .join("\n");
                        return { result: { manifest_text: `<classify>${manifest}</classify>` } };
                    }
                    return { result: { accepted: itemIds, rejected: [] } };
                }),
            );

            expect(itemIds).toHaveLength(10);
            expect(itemIds).not.toContain(contextIds[10]);
        } finally {
            closeQuietly(db);
        }
    });

    test("surfaces module rejection reason counts", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:module-rejections";
            const contextIds = addMemories(db, projectIdentity, 10);
            for (const [index, contextId] of contextIds.entries()) {
                addMirrorMapping(db, projectIdentity, contextId, 9200 + index, `hash-${index}`);
            }
            installAuthorityManagedMarker(db, projectIdentity, "store");

            await expect(
                runClassify(
                    moduleArgs(db, projectIdentity, (call) => {
                        if (call.method === "dreamer.run_task") {
                            const items = (
                                call.body as { payload: { items: Array<{ memory_id: number }> } }
                            ).payload.items;
                            const manifest = items
                                .map(
                                    (item) =>
                                        `<memory id="${item.memory_id}" importance="80" scope="project" shareable="true"/>`,
                                )
                                .join("\n");
                            return {
                                result: { manifest_text: `<classify>${manifest}</classify>` },
                            };
                        }
                        const rows = (
                            call.body as { arguments: { rows: Array<{ memory_id: number }> } }
                        ).arguments.rows;
                        return {
                            result: {
                                accepted: rows.slice(3).map((row) => row.memory_id),
                                rejected: [
                                    { memory_id: rows[0].memory_id, reason: "not_found" },
                                    { memory_id: rows[1].memory_id, reason: "not_owned" },
                                    { memory_id: rows[2].memory_id, reason: "stale" },
                                ],
                            },
                        };
                    }),
                ),
            ).rejects.toThrow(/not_found=1.*not_owned=1.*stale=1/);
        } finally {
            closeQuietly(db);
        }
    });
});
