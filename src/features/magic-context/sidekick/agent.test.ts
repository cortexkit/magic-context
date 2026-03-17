/// <reference types="bun-types" />

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { insertMemory } from "../memory/storage-memory";
import { runSidekick } from "./agent";
import type { OpenAIChatCompletionResponse } from "./types";

let db: Database;
let server: ReturnType<typeof Bun.serve> | null = null;

function makeMemoryDatabase(): Database {
    const database = Database.open(":memory:");
    database.run(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      normalized_hash TEXT NOT NULL,
      source_session_id TEXT,
      source_type TEXT DEFAULT 'historian',
      seen_count INTEGER DEFAULT 1,
      retrieval_count INTEGER DEFAULT 0,
      first_seen_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      last_retrieved_at INTEGER,
      status TEXT DEFAULT 'active',
      expires_at INTEGER,
      verification_status TEXT DEFAULT 'unverified',
      verified_at INTEGER,
      superseded_by_memory_id INTEGER,
      merged_from TEXT,
      metadata_json TEXT,
      UNIQUE(project_path, category, normalized_hash)
    );

    CREATE TABLE IF NOT EXISTS memory_embeddings (
      memory_id INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
      embedding BLOB NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      category,
      content='memories',
      content_rowid='id',
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, category) VALUES (new.id, new.content, new.category);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, category) VALUES ('delete', old.id, old.content, old.category);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, category) VALUES ('delete', old.id, old.content, old.category);
      INSERT INTO memories_fts(rowid, content, category) VALUES (new.id, new.content, new.category);
    END;
  `);
    return database;
}

function startMockServer(handler: (request: Request) => Response | Promise<Response>): {
    endpoint: string;
} {
    server = Bun.serve({
        port: 0,
        fetch: handler,
    });

    return { endpoint: `http://127.0.0.1:${server.port}/v1` };
}

function jsonResponse(body: OpenAIChatCompletionResponse): Response {
    return Response.json(body);
}

function insertTestMemory(content: string): void {
    insertMemory(db, {
        projectPath: "/repo/project",
        category: "CONSTRAINTS",
        content,
    });
}

beforeEach(() => {
    db = makeMemoryDatabase();
});

afterEach(() => {
    server?.stop(true);
    server = null;
    db.close(false);
});

describe("runSidekick", () => {
    it("returns context briefing after tool-calling flow", async () => {
        insertTestMemory("Use Bun for all package and test commands");
        let requestCount = 0;
        const { endpoint } = startMockServer(async (request) => {
            const body = (await request.json()) as {
                messages: Array<{ role: string }>;
                tools?: unknown[];
            };
            requestCount += 1;

            if (requestCount === 1) {
                expect(body.tools).toBeArray();
                return jsonResponse({
                    choices: [
                        {
                            finish_reason: "tool_calls",
                            message: {
                                role: "assistant",
                                content: null,
                                tool_calls: [
                                    {
                                        id: "call-1",
                                        type: "function",
                                        function: {
                                            name: "search_memory",
                                            arguments: JSON.stringify({
                                                query: "bun test commands",
                                            }),
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                });
            }

            expect(body.messages.at(-1)?.role).toBe("tool");
            return jsonResponse({
                choices: [
                    {
                        finish_reason: "stop",
                        message: {
                            role: "assistant",
                            content:
                                'The user likely wants to implement sidekick support.\n- Workflow: "Use Bun for all package and test commands"',
                        },
                    },
                ],
            });
        });

        const result = await runSidekick({
            db,
            projectPath: "/repo/project",
            userMessage: "Implement sidekick and keep Bun workflow rules.",
            config: {
                enabled: true,
                endpoint,
                model: "test-model",
                api_key: "",
                max_tool_calls: 3,
                timeout_ms: 5_000,
            },
        });

        expect(result).toContain("Use Bun for all package and test commands");
    });

    it("returns null when endpoint is unreachable", async () => {
        const result = await runSidekick({
            db,
            projectPath: "/repo/project",
            userMessage: "Implement sidekick.",
            config: {
                enabled: true,
                endpoint: "http://127.0.0.1:9/v1",
                model: "test-model",
                api_key: "",
                max_tool_calls: 3,
                timeout_ms: 100,
            },
        });

        expect(result).toBeNull();
    });

    it("returns null on timeout", async () => {
        const { endpoint } = startMockServer(
            () =>
                new Promise<Response>((resolve) =>
                    setTimeout(() => resolve(jsonResponse({ choices: [] })), 200),
                ),
        );

        const result = await runSidekick({
            db,
            projectPath: "/repo/project",
            userMessage: "Implement sidekick.",
            config: {
                enabled: true,
                endpoint,
                model: "test-model",
                api_key: "",
                max_tool_calls: 3,
                timeout_ms: 25,
            },
        });

        expect(result).toBeNull();
    });

    it("returns null when max iterations are exceeded", async () => {
        const { endpoint } = startMockServer(() =>
            jsonResponse({
                choices: [
                    {
                        finish_reason: "tool_calls",
                        message: {
                            role: "assistant",
                            content: null,
                            tool_calls: [
                                {
                                    id: crypto.randomUUID(),
                                    type: "function",
                                    function: {
                                        name: "search_memory",
                                        arguments: JSON.stringify({ query: "loop forever" }),
                                    },
                                },
                            ],
                        },
                    },
                ],
            }),
        );

        const result = await runSidekick({
            db,
            projectPath: "/repo/project",
            userMessage: "Implement sidekick.",
            config: {
                enabled: true,
                endpoint,
                model: "test-model",
                api_key: "",
                max_tool_calls: 1,
                timeout_ms: 5_000,
            },
        });

        expect(result).toBeNull();
    });

    it("returns direct text when no tool calls are requested", async () => {
        const { endpoint } = startMockServer(() =>
            jsonResponse({
                choices: [
                    {
                        finish_reason: "stop",
                        message: {
                            role: "assistant",
                            content: "The user likely wants to implement sidekick support.",
                        },
                    },
                ],
            }),
        );

        const result = await runSidekick({
            db,
            projectPath: "/repo/project",
            userMessage: "Implement sidekick.",
            config: {
                enabled: true,
                endpoint,
                model: "test-model",
                api_key: "",
                max_tool_calls: 3,
                timeout_ms: 5_000,
            },
        });

        expect(result).toBe("The user likely wants to implement sidekick support.");
    });
});
