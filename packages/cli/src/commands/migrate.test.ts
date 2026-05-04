import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "@magic-context/core/shared/sqlite";
import {
    migrateOpenCodeSessionToPi,
    parseMigrateArgs,
    projectPathToPiDirSlug,
    runMigrateCli,
} from "./migrate";

const tempDirs: string[] = [];
const databases: Array<{ close(): void }> = [];

function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "mc-migrate-test-"));
    tempDirs.push(dir);
    return dir;
}

function makeDb() {
    const db = new Database(":memory:");
    databases.push(db);
    db.exec(`
        CREATE TABLE session (
            id text PRIMARY KEY,
            title text NOT NULL,
            directory text NOT NULL,
            path text,
            time_created integer NOT NULL
        );
        CREATE TABLE message (
            id text PRIMARY KEY,
            session_id text NOT NULL,
            time_created integer NOT NULL,
            data text NOT NULL
        );
        CREATE TABLE part (
            id text PRIMARY KEY,
            message_id text NOT NULL,
            session_id text NOT NULL,
            time_created integer NOT NULL,
            data text NOT NULL
        );
    `);
    return db;
}

function insertSyntheticSession(db: ReturnType<typeof makeDb>) {
    const sessionId = "ses_test";
    const cwd = "/tmp/migrate-project";
    db.prepare(
        "INSERT INTO session (id, title, directory, path, time_created) VALUES (?, ?, ?, ?, ?)",
    ).run(sessionId, "Test", cwd, null, 1000);

    const insertMessage = db.prepare(
        "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
    );
    const insertPart = db.prepare(
        "INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)",
    );

    insertMessage.run(
        "msg_1",
        sessionId,
        1000,
        JSON.stringify({
            role: "user",
            model: { providerID: "anthropic", modelID: "claude-opus" },
        }),
    );
    insertPart.run(
        "prt_1",
        "msg_1",
        sessionId,
        1000,
        JSON.stringify({ type: "text", text: "hello" }),
    );
    insertPart.run("prt_2", "msg_1", sessionId, 1001, JSON.stringify({ type: "step-start" }));
    insertPart.run(
        "prt_3",
        "msg_1",
        sessionId,
        1002,
        JSON.stringify({ type: "file", filename: "image.png", url: "data:image/png;base64,abc" }),
    );
    insertPart.run("prt_4", "msg_1", sessionId, 1003, JSON.stringify({ type: "step-finish" }));

    insertMessage.run(
        "msg_2",
        sessionId,
        2000,
        JSON.stringify({ role: "assistant", providerID: "anthropic", modelID: "claude-opus" }),
    );
    insertPart.run(
        "prt_5",
        "msg_2",
        sessionId,
        2000,
        JSON.stringify({
            type: "reasoning",
            text: "thinking text",
            metadata: { anthropic: { signature: "signed-thinking" } },
        }),
    );
    insertPart.run(
        "prt_6",
        "msg_2",
        sessionId,
        2001,
        JSON.stringify({ type: "text", text: "assistant answer" }),
    );
    insertPart.run(
        "prt_7",
        "msg_2",
        sessionId,
        2002,
        JSON.stringify({
            type: "tool",
            tool: "bash",
            callID: "call_1",
            state: { input: { command: "echo hi" }, output: "hi\n" },
        }),
    );

    insertMessage.run("msg_3", sessionId, 3000, JSON.stringify({ role: "user" }));
    insertPart.run(
        "prt_8",
        "msg_3",
        sessionId,
        3000,
        JSON.stringify({ type: "text", text: "next" }),
    );

    return { sessionId, cwd };
}

function readJsonl(path: string) {
    return readFileSync(path, "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
}

function makeCortexkitDb() {
    const ck = new Database(":memory:");
    databases.push(ck);
    ck.exec(`
        CREATE TABLE compartments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          start_message INTEGER NOT NULL,
          end_message INTEGER NOT NULL,
          start_message_id TEXT DEFAULT '',
          end_message_id TEXT DEFAULT '',
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          harness TEXT NOT NULL DEFAULT 'opencode',
          UNIQUE(session_id, sequence)
        );
        CREATE TABLE session_facts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          category TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          harness TEXT NOT NULL DEFAULT 'opencode'
        );
    `);
    return ck;
}

afterEach(() => {
    for (const db of databases.splice(0)) db.close();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("migrateOpenCodeSessionToPi", () => {
    it("converts text, reasoning, tools, skips steps, and marks files", () => {
        const db = makeDb();
        const { sessionId, cwd } = insertSyntheticSession(db);
        const root = tempDir();

        const result = migrateOpenCodeSessionToPi({
            db,
            sessionId,
            piSessionsRoot: root,
            now: new Date("2026-04-30T11:46:47.422Z"),
        });

        expect(projectPathToPiDirSlug("/Users/ufukaltinok/Work/OSS/opencode-magic-context")).toBe(
            "--Users-ufukaltinok-Work-OSS-opencode-magic-context--",
        );
        expect(result.outputPath).toContain(projectPathToPiDirSlug(cwd));
        expect(result.sourceMessageCount).toBe(3);
        const entries = readJsonl(result.outputPath);
        expect(entries[0]).toMatchObject({ type: "session", version: 3, cwd });
        expect(entries[1]).toMatchObject({
            type: "model_change",
            provider: "anthropic",
            modelId: "claude-opus",
        });
        expect(entries[2].message.content[0].text).toContain(
            "migrated from OpenCode session ses_test",
        );

        const messages = entries.slice(2).map((entry) => entry.message);
        expect(messages.map((message) => message.role)).toEqual([
            "user",
            "user",
            "user",
            "assistant",
            "assistant",
            "assistant",
            "toolResult",
            "user",
        ]);
        expect(
            messages.map((message) => message.content?.[0]?.text ?? message.content?.[0]?.thinking),
        ).toContain("<file omitted: image.png>");
        const thinking = messages.find((message) => message.content?.[0]?.type === "thinking");
        expect(thinking.content[0].thinking).toBe("thinking text");
        expect(thinking.content[0].thinkingSignature).toBeNull();
        expect(JSON.stringify(entries)).not.toContain("signed-thinking");

        const toolCall = messages.find((message) => message.content?.[0]?.type === "toolCall");
        expect(toolCall.content[0]).toEqual({
            type: "toolCall",
            id: "call_1",
            name: "bash",
            arguments: { command: "echo hi" },
        });
        const toolResult = messages.find((message) => message.role === "toolResult");
        expect(toolResult.toolCallId).toBe("call_1");
        expect(toolResult.content[0].text).toBe("hi\n");
        expect(JSON.stringify(entries)).not.toContain("step-start");
        expect(JSON.stringify(entries)).not.toContain("step-finish");
    });

    it("limits to the most recent N source messages in chronological order", () => {
        const db = makeDb();
        const { sessionId } = insertSyntheticSession(db);
        const result = migrateOpenCodeSessionToPi({
            db,
            sessionId,
            piSessionsRoot: tempDir(),
            maxMessages: 2,
            now: new Date("2026-04-30T11:46:47.422Z"),
        });

        const entries = readJsonl(result.outputPath);
        const texts = entries
            .slice(2)
            .flatMap((entry) => entry.message.content ?? [])
            .map((content) => content.text ?? content.thinking)
            .filter(Boolean);
        expect(texts).not.toContain("hello");
        expect(texts).toContain("assistant answer");
        expect(texts.at(-1)).toBe("next");
    });

    it("dry-run reports bytes but writes nothing", () => {
        const db = makeDb();
        const { sessionId } = insertSyntheticSession(db);
        const root = tempDir();
        const writes: string[] = [];
        const result = migrateOpenCodeSessionToPi({
            db,
            sessionId,
            piSessionsRoot: root,
            dryRun: true,
            now: new Date("2026-04-30T11:46:47.422Z"),
            fs: {
                existsSync: () => false,
                mkdirSync: () => {
                    throw new Error("mkdir should not be called");
                },
                writeFileSync: (path) => {
                    writes.push(path);
                },
            },
        });

        expect(result.dryRun).toBe(true);
        expect(result.byteCount).toBeGreaterThan(0);
        expect(writes).toEqual([]);
    });
});

describe("migrateOpenCodeSessionToPi — token & magic-context bridging", () => {
    it("carries real assistant usage tokens through to the migrated assistant entries", () => {
        const db = makeDb();
        const sessionId = "ses_tok";
        db.prepare(
            "INSERT INTO session (id, title, directory, path, time_created) VALUES (?, ?, ?, ?, ?)",
        ).run(sessionId, "T", "/tmp/p", null, 1000);
        const insertMessage = db.prepare(
            "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
        );
        const insertPart = db.prepare(
            "INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)",
        );
        insertMessage.run(
            "msg_a",
            sessionId,
            1000,
            JSON.stringify({
                role: "assistant",
                providerID: "openai",
                modelID: "gpt-5.5",
                tokens: {
                    input: 23573,
                    output: 171,
                    reasoning: 100,
                    total: 25380,
                    cache: { read: 1536, write: 0 },
                },
            }),
        );
        insertPart.run(
            "prt_a",
            "msg_a",
            sessionId,
            1000,
            JSON.stringify({ type: "text", text: "answer" }),
        );

        const result = migrateOpenCodeSessionToPi({
            db,
            cortexkitDb: null,
            sessionId,
            piSessionsRoot: tempDir(),
            now: new Date("2026-04-30T11:46:47.422Z"),
        });

        const entries = readJsonl(result.outputPath);
        const assistantEntry = entries.find((e) => e.message?.role === "assistant");
        expect(assistantEntry?.message?.usage).toEqual({
            input: 23573,
            output: 171,
            cacheRead: 1536,
            cacheWrite: 0,
            totalTokens: 25380,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        });
        // Migration boundary marker is a user message — no `usage` field
        // per Pi convention (only assistant messages carry usage). The
        // synthetic-stub usage we computed for it is used internally by
        // makeMessageEntry but discarded for non-assistant roles.
        expect(entries[2].message.role).toBe("user");
        expect(entries[2].message.usage).toBeUndefined();
    });

    it("copies compartments and facts under harness='pi' with remapped Pi entry IDs", () => {
        const db = makeDb();
        const { sessionId } = insertSyntheticSession(db);

        // Set up a minimal cortexkit DB with the schema the migrator
        // expects. We only care about compartments + session_facts here.
        const ck = makeCortexkitDb();
        // Two compartments under the source session.
        // Compartment 0: covers msg_1 → msg_2 (exact boundary match).
        ck.prepare(
            "INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, created_at, harness) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'opencode')",
        ).run(sessionId, 0, 1, 2, "msg_1", "msg_2", "Comp 0", "summary 0", 5);
        // Compartment 1: end boundary "msg_unknown" doesn't directly map →
        // must remap to nearest at-or-before.
        ck.prepare(
            "INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, created_at, harness) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'opencode')",
        ).run(sessionId, 1, 3, 4, "msg_3", "msg_zzzz_unknown", "Comp 1", "summary 1", 6);

        ck.prepare(
            "INSERT INTO session_facts (session_id, category, content, created_at, updated_at, harness) VALUES (?, ?, ?, ?, ?, 'opencode')",
        ).run(sessionId, "ARCHITECTURE_DECISIONS", "Use SQLite", 7, 8);

        const result = migrateOpenCodeSessionToPi({
            db,
            cortexkitDb: ck,
            sessionId,
            piSessionsRoot: tempDir(),
            now: new Date("2026-04-30T11:46:47.422Z"),
        });

        expect(result.compartmentsCopied).toBe(2);
        expect(result.factsCopied).toBe(1);
        expect(result.boundariesApproximated).toBe(1); // msg_zzzz_unknown remapped to nearest

        // Read back the copied rows under the new Pi session id with
        // harness='pi'. Boundary IDs must match Pi entry IDs that
        // exist in the JSONL output.
        type Row = {
            session_id: string;
            sequence: number;
            start_message_id: string;
            end_message_id: string;
            title: string;
            content: string;
            harness: string;
        };
        const piCompartments = ck
            .prepare(
                "SELECT session_id, sequence, start_message_id, end_message_id, title, content, harness FROM compartments WHERE session_id = ? AND harness = 'pi' ORDER BY sequence",
            )
            .all(result.piSessionId) as Row[];
        expect(piCompartments).toHaveLength(2);
        expect(piCompartments[0].title).toBe("Comp 0");
        expect(piCompartments[1].title).toBe("Comp 1");

        // Verify boundary IDs reference real Pi entries in the JSONL.
        const entries = readJsonl(result.outputPath);
        const entryIds = new Set(
            entries.filter((e) => e.type === "message" && e.id).map((e) => e.id as string),
        );
        expect(entryIds.has(piCompartments[0].start_message_id)).toBe(true);
        expect(entryIds.has(piCompartments[0].end_message_id)).toBe(true);
        expect(entryIds.has(piCompartments[1].start_message_id)).toBe(true);
        expect(entryIds.has(piCompartments[1].end_message_id)).toBe(true);

        // Facts copied with harness='pi'.
        type FactRow = {
            category: string;
            content: string;
            harness: string;
        };
        const piFacts = ck
            .prepare(
                "SELECT category, content, harness FROM session_facts WHERE session_id = ? AND harness = 'pi'",
            )
            .all(result.piSessionId) as FactRow[];
        expect(piFacts).toEqual([
            {
                category: "ARCHITECTURE_DECISIONS",
                content: "Use SQLite",
                harness: "pi",
            },
        ]);

        // Source rows remain untouched under harness='opencode'.
        const sourceCount = (
            ck
                .prepare(
                    "SELECT COUNT(*) as n FROM compartments WHERE session_id = ? AND harness = 'opencode'",
                )
                .get(sessionId) as { n: number }
        ).n;
        expect(sourceCount).toBe(2);
    });

    it("writes a Pi compaction marker at the last compartment boundary", () => {
        const db = makeDb();
        const { sessionId } = insertSyntheticSession(db);
        const ck = makeCortexkitDb();
        ck.prepare(
            "INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, created_at, harness) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'opencode')",
        ).run(sessionId, 0, 1, 1, "msg_1", "msg_1", "Comp 0", "summary 0", 5);
        ck.prepare(
            "INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, created_at, harness) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'opencode')",
        ).run(sessionId, 1, 2, 2, "msg_2", "msg_2", "Comp 1", "summary 1", 6);

        const result = migrateOpenCodeSessionToPi({
            db,
            cortexkitDb: ck,
            sessionId,
            piSessionsRoot: tempDir(),
            now: new Date("2026-04-30T11:46:47.422Z"),
        });

        expect(result.compactionMarkerWritten).toBe(true);
        const entries = readJsonl(result.outputPath);
        const compactions = entries.filter((entry) => entry.type === "compaction");
        expect(compactions).toHaveLength(1);
        const compaction = compactions[0];
        const compactionIndex = entries.indexOf(compaction);
        const parentIndex = entries.findIndex((entry) => entry.id === compaction.parentId);
        const firstKeptIndex = entries.findIndex(
            (entry) => entry.id === compaction.firstKeptEntryId,
        );

        expect(parentIndex).toBeGreaterThanOrEqual(0);
        expect(parentIndex).toBeLessThan(compactionIndex);
        expect(firstKeptIndex).toBeGreaterThan(compactionIndex);
        expect(compaction.fromHook).toBe(true);
        expect(compaction.tokensBefore).toBeGreaterThan(0);
        expect(entries[compactionIndex + 1].parentId).toBe(compaction.id);

        const seen = new Set<string>();
        for (const [index, entry] of entries.entries()) {
            if (entry.id) {
                if (index > 0 && entry.parentId !== null && entry.parentId !== undefined) {
                    expect(seen.has(entry.parentId)).toBe(true);
                }
                seen.add(entry.id);
            }
        }
    });

    it("skips compaction marker when no compartments are copied", () => {
        const db = makeDb();
        const { sessionId } = insertSyntheticSession(db);
        const result = migrateOpenCodeSessionToPi({
            db,
            cortexkitDb: makeCortexkitDb(),
            sessionId,
            piSessionsRoot: tempDir(),
            now: new Date("2026-04-30T11:46:47.422Z"),
        });

        expect(result.compartmentsCopied).toBe(0);
        expect(result.compactionMarkerWritten).toBe(false);
        expect(readJsonl(result.outputPath).filter((entry) => entry.type === "compaction")).toEqual(
            [],
        );
    });

    it("skips magic-context copy entirely when cortexkitDb is null", () => {
        const db = makeDb();
        const { sessionId } = insertSyntheticSession(db);
        const result = migrateOpenCodeSessionToPi({
            db,
            cortexkitDb: null,
            sessionId,
            piSessionsRoot: tempDir(),
            now: new Date("2026-04-30T11:46:47.422Z"),
        });
        expect(result.compartmentsCopied).toBe(0);
        expect(result.factsCopied).toBe(0);
    });

    it("dry run reports compartment/fact counts without inserting", () => {
        const db = makeDb();
        const { sessionId } = insertSyntheticSession(db);
        const ck = makeCortexkitDb();
        ck.prepare(
            "INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, created_at, harness) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'opencode')",
        ).run(sessionId, 0, 1, 2, "msg_1", "msg_2", "Comp 0", "summary 0", 5);

        const result = migrateOpenCodeSessionToPi({
            db,
            cortexkitDb: ck,
            sessionId,
            piSessionsRoot: tempDir(),
            dryRun: true,
            now: new Date("2026-04-30T11:46:47.422Z"),
            fs: {
                existsSync: () => false,
                mkdirSync: () => {
                    throw new Error("mkdir should not be called");
                },
                writeFileSync: () => {},
            },
        });
        expect(result.dryRun).toBe(true);
        expect(result.compartmentsCopied).toBe(1);

        // No Pi rows actually inserted on dry run.
        const piCount = (
            ck.prepare("SELECT COUNT(*) as n FROM compartments WHERE harness = 'pi'").get() as {
                n: number;
            }
        ).n;
        expect(piCount).toBe(0);
    });
});

describe("migrate CLI parsing", () => {
    it("parses required flags", () => {
        expect(
            parseMigrateArgs([
                "--from",
                "opencode",
                "--to",
                "pi",
                "--session",
                "ses_x",
                "--max-messages",
                "5",
                "--dry-run",
            ]),
        ).toEqual({ from: "opencode", to: "pi", session: "ses_x", maxMessages: 5, dryRun: true });
    });

    it("rejects unsupported migration directions clearly", async () => {
        const originalError = console.error;
        const errors: string[] = [];
        console.error = (message?: unknown) => {
            errors.push(String(message));
        };
        try {
            const code = await runMigrateCli([
                "--from",
                "pi",
                "--to",
                "opencode",
                "--session",
                "ses_x",
            ]);
            expect(code).toBe(1);
            expect(errors.join("\n")).toContain("pi → opencode is not yet supported");
        } finally {
            console.error = originalError;
        }
    });
});
