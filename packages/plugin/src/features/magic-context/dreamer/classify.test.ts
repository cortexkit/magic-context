/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import type { HiddenCompletionExecutor } from "../../../hooks/magic-context/compartment-runner-types";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { getMemoryById, insertMemory } from "../memory";
import { recordItemScores } from "../memory/turn-two-scoring";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { getSubagentInvocations } from "../storage-subagent-invocations";
import { applyClassifications, type ClassifyArgs, runClassify } from "./classify";
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
                manifest = `<classify>${ids.map((id) => `<memory id="${id}" importance="80" scope="project" shareable="true" safety_critical="false"/>`).join("")}</classify>`;
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
        parentSessionId: "ses-parent",
        sessionDirectory: process.cwd(),
        holderId,
        leaseKey,
        deadline: Date.now() + 60_000,
    };
}

describe("runClassify disposition", () => {
    test("classifies through the v2 executor without a v1 client", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:classify-v2";
            addMemoriesForDisposition(db, projectIdentity, 10);
            const args = classifyArgs(db, projectIdentity);
            args.client = undefined;
            let opened = 0;
            let manifest = "";
            args.hiddenCompletionExecutor = {
                capabilities: { tools: false, harness: "opencode2" },
                open: async () => {
                    opened++;
                    return { id: "v2-classify" };
                },
                attempt: async (_handle, request) => {
                    const prompt = request.body?.parts?.[0]?.text ?? "";
                    const ids = [...prompt.matchAll(/^\[(\d+)\]/gm)].map((match) =>
                        Number(match[1]),
                    );
                    manifest = `<classify>${ids.map((id) => `<memory id="${id}" importance="80" scope="project" shareable="true"/>`).join("")}</classify>`;
                },
                collect: async () => ({ text: manifest, reasoning: null, lengthCapped: false }),
                close: async () => {},
            } satisfies HiddenCompletionExecutor;
            const result = await runClassify(args);
            expect(opened).toBe(1);
            expect(result.classified).toBe(10);
        } finally {
            closeQuietly(db);
        }
    });
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
            expect(system).toContain("Write human-readable prose you author in: Turkish (Türkçe).");
        } finally {
            closeQuietly(db);
        }
    });

    test("a failed chunk row records the child's tokens and model", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:classify-failed-row-evidence";
            addMemoriesForDisposition(db, projectIdentity, 10);
            const args = classifyArgs(db, projectIdentity);
            args.parentSessionId = "ses-parent-classify";
            // The model answered in prose instead of the classify manifest.
            args.client = {
                session: {
                    create: async () => ({ data: { id: "classify-child" } }),
                    prompt: async () => ({}),
                    messages: async () => ({
                        data: [
                            {
                                info: {
                                    role: "assistant",
                                    providerID: "google",
                                    modelID: "gemini-classify",
                                    time: { created: 1, completed: 2 },
                                    finish: "stop",
                                    tokens: {
                                        input: 700,
                                        output: 90,
                                        cache: { read: 0, write: 0 },
                                    },
                                },
                                parts: [{ type: "text", text: "These all look important." }],
                            },
                        ],
                    }),
                    delete: async () => ({}),
                },
            } as never;

            await runClassify(args);

            const [row] = getSubagentInvocations(db, "ses-parent-classify", {
                subagent: "dreamer",
            });
            expect(row).toMatchObject({
                task: "classify-memories",
                status: "failed",
                providerId: "google",
                modelId: "gemini-classify",
                inputTokens: 700,
                outputTokens: 90,
            });
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

    test("Stage 2 does not prompt for an unchanged classified pool", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:classify-stage2-gate";
            addMemoriesForDisposition(db, projectIdentity, 10);
            const args = classifyArgs(db, projectIdentity);
            let prompts = 0;
            args.client = successfulClassifyClient(() => prompts++) as never;
            expect((await runClassify(args)).classified).toBe(10);
            const second = await runClassify(args);
            expect(second.stage).toBe(2);
            expect(second.classified).toBe(0);
            expect(second.remaining).toBe(0);
            expect(prompts).toBe(1);
        } finally {
            closeQuietly(db);
        }
    });

    test("assesses safety for open historian items without replacing their importance", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:classify-historian-items";
            addMemoriesForDisposition(db, projectIdentity, 8);
            const pending = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Agent save awaiting its historian score.",
                sourceSessionId: "ses",
            });
            const scored = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Agent save the historian scored.",
                sourceSessionId: "ses",
            });
            const enqueue = db.prepare(
                "INSERT INTO memory_classification_items(project_path,memory_id,saved_revision,source_session_id,tool_call_part_id,save_ordinal,excerpt) VALUES(?,?,1,'ses',?,1,'excerpt')",
            );
            enqueue.run(projectIdentity, pending.id, "part-pending");
            const scoredItem = Number(
                enqueue.run(projectIdentity, scored.id, "part-scored").lastInsertRowid,
            );
            // Record the historian's importance score for the saved memory the way turn two
            // does (recordItemScores), which also stamps the row as classified.
            recordItemScores(
                db,
                [scoredItem],
                [{ item: scoredItem, importance: 30, proposedClass: "durable" }],
            );
            const args = classifyArgs(db, projectIdentity);
            const prompted: number[] = [];
            let manifest = "";
            args.client = undefined;
            args.hiddenCompletionExecutor = {
                capabilities: { tools: false, harness: "opencode2" },
                open: async () => ({ id: "v2-classify" }),
                attempt: async (_handle, request) => {
                    const prompt = request.body?.parts?.[0]?.text ?? "";
                    const ids = [...prompt.matchAll(/^\[(\d+)\]/gm)].map((match) =>
                        Number(match[1]),
                    );
                    prompted.push(...ids);
                    manifest = `<classify>${ids.map((id) => `<memory id="${id}" importance="80" scope="project" shareable="true"/>`).join("")}</classify>`;
                },
                collect: async () => ({ text: manifest, reasoning: null, lengthCapped: false }),
                close: async () => {},
            } satisfies HiddenCompletionExecutor;

            const result = await runClassify(args);

            expect(result.classified).toBe(10);
            expect(prompted).toContain(pending.id);
            expect(prompted).toContain(scored.id);
            expect(getMemoryById(db, pending.id)?.importance).toBe(50);
            expect(getMemoryById(db, scored.id)?.importance).toBe(30);
        } finally {
            closeQuietly(db);
        }
    });

    test("an item the historian ran out of attempts on gives its row back to dreamer classify", async () => {
        const db = freshDb();
        try {
            const projectIdentity = "git:classify-exhausted-item";
            addMemoriesForDisposition(db, projectIdentity, 9);
            const saved = insertMemory(db, {
                projectPath: projectIdentity,
                category: "ARCHITECTURE",
                content: "Agent save the historian never scored.",
                sourceSessionId: "ses",
            });
            const item = Number(
                db
                    .prepare(
                        "INSERT INTO memory_classification_items(project_path,memory_id,saved_revision,source_session_id,tool_call_part_id,save_ordinal,excerpt) VALUES(?,?,1,'ses','part',1,'excerpt')",
                    )
                    .run(projectIdentity, saved.id).lastInsertRowid,
            );
            // Three historian turn-two requests carried this item, and none recorded a
            // score for it: it is out of attempts.
            for (let attempt = 1; attempt <= 3; attempt++)
                db.prepare(
                    "INSERT INTO memory_stage_attempts(stage_key,project_path,publication_id,run_attempt,stage,session_id,carrier,state,request_json,started_at) VALUES(?,?,'pub',?,'turn_two','ses','stub','resolved',?,1)",
                ).run(
                    `stage-${attempt}`,
                    projectIdentity,
                    attempt,
                    JSON.stringify({ items: [item] }),
                );
            const args = classifyArgs(db, projectIdentity);
            args.client = successfulClassifyClient() as never;

            expect((await runClassify(args)).classified).toBe(10);
            expect(getMemoryById(db, saved.id)?.importance).toBe(80);
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
