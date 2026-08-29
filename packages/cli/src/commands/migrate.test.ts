import { afterEach, describe, expect, it } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    renameSync,
    rmSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LATEST_SUPPORTED_VERSION } from "@magic-context/core/features/magic-context/storage-db";
import { Database } from "@magic-context/core/shared/sqlite";
import { convertEntriesToRawMessages } from "@magic-context/pi-core/read-session-pi";
import {
    type MigrationPendingRow,
    migrateOpenCodeSessionToPi,
    migrationKeyFor,
    parseMigrateArgs,
    projectPathToPiDirSlug,
    runMigrateCli,
    sweepPendingMigrations,
} from "./migrate";

const tempDirs: string[] = [];
const databases: Array<{ close(): void }> = [];
const originalPiDir = process.env.PI_CODING_AGENT_DIR;

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
          p1 TEXT,
          p2 TEXT,
          p3 TEXT,
          p4 TEXT,
          importance INTEGER NOT NULL DEFAULT 50,
          episode_type TEXT,
          legacy INTEGER NOT NULL DEFAULT 0,
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
        CREATE TABLE authority_managed (
          project_path TEXT PRIMARY KEY,
          context_store_uuid TEXT NOT NULL,
          marked_at INTEGER NOT NULL
        );
        CREATE TABLE session_projects (
          session_id TEXT NOT NULL,
          harness TEXT NOT NULL,
          project_path TEXT NOT NULL,
          PRIMARY KEY (session_id, harness)
        );
        CREATE TABLE migration_pending (
          migration_key TEXT PRIMARY KEY,
          source_session_id TEXT NOT NULL,
          target_harness TEXT NOT NULL,
          pi_session_id TEXT NOT NULL,
          final_path TEXT NOT NULL,
          stage_path TEXT NOT NULL,
          content_sha256 TEXT NOT NULL,
          phase TEXT NOT NULL CHECK (phase IN ('staged', 'db_committed')),
          created_at INTEGER NOT NULL
        );
    `);
    return ck;
}

type CortexkitTestDb = ReturnType<typeof makeCortexkitDb>;

function readJournalRows(ck: CortexkitTestDb): MigrationPendingRow[] {
    return ck.prepare("SELECT * FROM migration_pending ORDER BY created_at ASC").all() as never;
}

/**
 * Resolve the runtime ordinal of the RawMessage a JSONL entry participates
 * in, THROUGH THE RUNTIME READ PATH (convertEntriesToRawMessages — the same
 * basis readSessionChunk consumes). User/assistant entries map by their own
 * id; toolResult entries fold into the following user turn (or into a
 * synthetic user turn ahead of the next assistant / at the tail), matching
 * the reader's documented SYNTH_USER_ID_PREFIX contract.
 */
function runtimeOrdinalOfEntry(
    entries: Array<Record<string, unknown>>,
    entryId: string,
): number | undefined {
    const raw = convertEntriesToRawMessages(entries);
    const byId = new Map(raw.map((message) => [message.id, message.ordinal]));
    if (byId.has(entryId)) return byId.get(entryId);

    const index = entries.findIndex((entry) => entry.id === entryId);
    const entry = entries[index];
    const message = entry?.message as { role?: string } | undefined;
    if (entry?.type !== "message" || message?.role !== "toolResult") return undefined;

    // First toolResult id of the folded run (the synth-user id suffix).
    let firstRunId = entryId;
    for (let i = index - 1; i >= 0; i--) {
        const prior = entries[i];
        const priorMessage = prior?.message as { role?: string } | undefined;
        if (prior?.type === "message" && priorMessage?.role === "toolResult") {
            firstRunId = prior.id as string;
            continue;
        }
        break;
    }

    for (let i = index + 1; i < entries.length; i++) {
        const next = entries[i];
        const nextMessage = next?.message as { role?: string } | undefined;
        if (next?.type !== "message") continue;
        if (nextMessage?.role === "toolResult") continue;
        if (nextMessage?.role === "user") return byId.get(next.id as string);
        return byId.get(`synth-user-${firstRunId}`);
    }
    return byId.get(`synth-user-${firstRunId}`);
}

afterEach(() => {
    if (originalPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalPiDir;
    for (const db of databases.splice(0)) db.close();
    for (const dir of tempDirs.splice(0)) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            // Ignore EBUSY on Windows
        }
    }
});

describe("migrateOpenCodeSessionToPi", () => {
    it("converts text, reasoning, tools, skips steps, and marks files", () => {
        const db = makeDb();
        const { sessionId, cwd } = insertSyntheticSession(db);
        const root = tempDir();

        const result = migrateOpenCodeSessionToPi({
            db,
            cortexkitDb: null,
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

    it("chunks part lookups below conservative SQLite bind limits", () => {
        const db = makeDb();
        const sessionId = "ses_many_messages";
        db.prepare(
            "INSERT INTO session (id, title, directory, path, time_created) VALUES (?, ?, ?, ?, ?)",
        ).run(sessionId, "Large", "/tmp/large", null, 1);
        const insertMessage = db.prepare(
            "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
        );
        const insertPart = db.prepare(
            "INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)",
        );
        db.transaction(() => {
            for (let index = 0; index < 1001; index++) {
                const messageId = `msg_${index.toString().padStart(4, "0")}`;
                insertMessage.run(messageId, sessionId, index, JSON.stringify({ role: "user" }));
                insertPart.run(
                    `part_${index.toString().padStart(4, "0")}`,
                    messageId,
                    sessionId,
                    index,
                    JSON.stringify({ type: "text", text: `message ${index}` }),
                );
            }
        })();
        const limitedDb = {
            prepare(sql: string) {
                const bindCount = (sql.match(/\?/g) ?? []).length;
                if (bindCount > 999) throw new Error("too many SQL variables");
                return db.prepare(sql);
            },
            exec: (sql: string) => db.exec(sql),
            close: () => db.close(),
        };

        const result = migrateOpenCodeSessionToPi({
            db: limitedDb as never,
            cortexkitDb: null,
            sessionId,
            piSessionsRoot: tempDir(),
            now: new Date("2026-04-30T11:46:47.422Z"),
            dryRun: true,
        });

        expect(result.sourceMessageCount).toBe(1001);
        expect(result.messageCount).toBe(1002);
    });

    it("limits to the most recent N source messages in chronological order", () => {
        const db = makeDb();
        const { sessionId } = insertSyntheticSession(db);
        const result = migrateOpenCodeSessionToPi({
            db,
            cortexkitDb: null,
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
            cortexkitDb: null,
            sessionId,
            piSessionsRoot: root,
            dryRun: true,
            now: new Date("2026-04-30T11:46:47.422Z"),
            fs: {
                writeFileAtomic: (path) => {
                    writes.push(path);
                },
                unlinkSync: () => {
                    throw new Error("unlink should not be called");
                },
            },
        });

        expect(result.dryRun).toBe(true);
        expect(result.byteCount).toBeGreaterThan(0);
        expect(writes).toEqual([]);
    });

    it("stages outside the sessions root, commits shared state, then renames into place", () => {
        const db = makeDb();
        const { sessionId, cwd } = insertSyntheticSession(db);
        const root = tempDir();
        const agentDir = join(root, "isolated", "agent");
        process.env.PI_CODING_AGENT_DIR = agentDir;
        const order: string[] = [];
        const cortexkitDb = makeCortexkitDb();
        const wrappedCortexkitDb = {
            prepare: cortexkitDb.prepare.bind(cortexkitDb),
            close: cortexkitDb.close.bind(cortexkitDb),
            exec: (sql: string) => {
                if (sql === "BEGIN IMMEDIATE") order.push("db-commit");
                return cortexkitDb.exec(sql);
            },
        };

        const result = migrateOpenCodeSessionToPi({
            db,
            cortexkitDb: wrappedCortexkitDb,
            sessionId,
            now: new Date("2026-04-30T11:46:47.422Z"),
            fs: {
                writeFileAtomic: (path, data) => {
                    order.push("stage-write");
                    // The stage file lands OUTSIDE the sessions tree (no harness
                    // scanner suffix rules apply there).
                    expect(path.startsWith(join(agentDir, ".mc-migrations"))).toBe(true);
                    expect(path).not.toContain(join(agentDir, "sessions"));
                    expect(data.endsWith("\n")).toBe(true);
                    mkdirSync(dirname(path), { recursive: true });
                    writeFileSync(path, data, "utf-8");
                },
                unlinkSync: (path) => {
                    order.push("unlink");
                    unlinkSync(path);
                },
                existsSync: (path) => existsSync(path),
                renameSync: (from, to) => {
                    order.push("rename");
                    expect(from.startsWith(join(agentDir, ".mc-migrations"))).toBe(true);
                    expect(to.startsWith(join(agentDir, "sessions"))).toBe(true);
                    expect(to).toContain(projectPathToPiDirSlug(cwd));
                    renameSync(from, to);
                },
                mkdirSync: (path, options) => mkdirSync(path, options),
            },
        });

        expect(result.outputPath.startsWith(join(agentDir, "sessions"))).toBe(true);
        expect(order[0]).toBe("stage-write");
        expect(order[1]).toBe("db-commit");
        expect(order[2]).toBe("rename");
        expect(order).not.toContain("unlink");
        // Success clears the journal row.
        expect(readJournalRows(cortexkitDb)).toEqual([]);
    });

    it("refuses module-managed source sessions before staging output", () => {
        const db = makeDb();
        const { sessionId, cwd } = insertSyntheticSession(db);
        const cortexkitDb = makeCortexkitDb();
        cortexkitDb
            .prepare(
                "INSERT INTO authority_managed (project_path, context_store_uuid, marked_at) VALUES (?, 'store-test', 0)",
            )
            .run("git:managed");
        cortexkitDb
            .prepare(
                "INSERT INTO session_projects (session_id, harness, project_path) VALUES (?, 'opencode', ?)",
            )
            .run(sessionId, "git:managed");
        const writes: string[] = [];

        expect(() =>
            migrateOpenCodeSessionToPi({
                db,
                cortexkitDb,
                sessionId,
                piSessionsRoot: tempDir(),
                fs: {
                    writeFileAtomic: (path) => writes.push(path),
                    unlinkSync: () => {},
                    existsSync: (path) => existsSync(path),
                    renameSync: (from, to) => renameSync(from, to),
                    mkdirSync: (path, options) => mkdirSync(path, options),
                },
            }),
        ).toThrow(
            `context.db may contain only host mirrors, not the Rust engine truth. Drain authority to TypeScript with \`magic-context doctor drain-authority ${cwd}\``,
        );
        expect(writes).toEqual([]);
        expect(readJournalRows(cortexkitDb)).toEqual([]);
    });

    it("skips a missing context DB without creating an empty file", () => {
        const db = makeDb();
        const { sessionId } = insertSyntheticSession(db);
        const root = tempDir();
        const contextDbPath = join(root, "missing", "context.db");

        const result = migrateOpenCodeSessionToPi({
            db,
            cortexkitDbPath: contextDbPath,
            sessionId,
            piSessionsRoot: root,
            now: new Date("2026-04-30T11:46:47.422Z"),
        });

        expect(result.compartmentsCopied).toBe(0);
        expect(existsSync(contextDbPath)).toBe(false);
    });

    it("refuses a newer context DB before writing migration output", () => {
        const db = makeDb();
        const { sessionId } = insertSyntheticSession(db);
        const root = tempDir();
        const contextDbPath = join(root, "context.db");
        const contextDb = new Database(contextDbPath);
        // Derive from the live fence so a routine schema bump cannot stale this fixture.
        contextDb.exec(
            `CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY); INSERT INTO schema_migrations (version) VALUES (${LATEST_SUPPORTED_VERSION + 1})`,
        );
        contextDb.close();
        const writes: string[] = [];

        expect(() =>
            migrateOpenCodeSessionToPi({
                db,
                cortexkitDbPath: contextDbPath,
                sessionId,
                piSessionsRoot: root,
                fs: {
                    writeFileAtomic: (path) => writes.push(path),
                    unlinkSync: () => {},
                    existsSync: (path) => existsSync(path),
                    renameSync: (from, to) => renameSync(from, to),
                    mkdirSync: (path, options) => mkdirSync(path, options),
                },
            }),
        ).toThrow(
            `database schema v${LATEST_SUPPORTED_VERSION + 1} is newer than this CLI supports (max v${LATEST_SUPPORTED_VERSION})`,
        );
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
            "INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, p1, p2, p3, p4, importance, episode_type, legacy, created_at, harness) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'opencode')",
        ).run(
            sessionId,
            0,
            1,
            2,
            "msg_1",
            "msg_2",
            "Comp 0",
            "summary 0",
            "p1 verbose",
            "p2 mid",
            "p3 terse",
            "p4 anchor",
            72,
            "design,bug",
            0,
            5,
        );
        // Compartment 1: end boundary "msg_unknown" doesn't directly map →
        // must remap to nearest at-or-before. Stored as a legacy (v1) row to
        // confirm the legacy flag is preserved verbatim through migration.
        ck.prepare(
            "INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, importance, legacy, created_at, harness) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'opencode')",
        ).run(sessionId, 1, 3, 4, "msg_3", "msg_zzzz_unknown", "Comp 1", "summary 1", 50, 1, 6);

        ck.prepare(
            "INSERT INTO session_facts (session_id, category, content, created_at, updated_at, harness) VALUES (?, ?, ?, ?, ?, 'opencode')",
        ).run(sessionId, "ARCHITECTURE_DECISIONS", "Use SQLite", 7, 8);

        const result = migrateOpenCodeSessionToPi({
            db,
            cortexkitDb: ck,
            sessionId,
            piSessionsRoot: join(tempDir(), "sessions"),
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
                "SELECT session_id, sequence, start_message_id, end_message_id, title, content, p1, p2, p3, p4, importance, episode_type, legacy, harness FROM compartments WHERE session_id = ? AND harness = 'pi' ORDER BY sequence",
            )
            .all(result.piSessionId) as Array<
            Row & {
                p1: string | null;
                p2: string | null;
                p3: string | null;
                p4: string | null;
                importance: number;
                episode_type: string | null;
                legacy: number;
            }
        >;
        expect(piCompartments).toHaveLength(2);
        expect(piCompartments[0].title).toBe("Comp 0");
        expect(piCompartments[1].title).toBe("Comp 1");

        // v2 tier/metadata must survive migration (regression: bespoke INSERT
        // previously dropped p1-p4/importance/episode_type and forced legacy=0).
        expect(piCompartments[0].p1).toBe("p1 verbose");
        expect(piCompartments[0].p2).toBe("p2 mid");
        expect(piCompartments[0].p3).toBe("p3 terse");
        expect(piCompartments[0].p4).toBe("p4 anchor");
        expect(piCompartments[0].importance).toBe(72);
        expect(piCompartments[0].episode_type).toBe("design,bug");
        expect(piCompartments[0].legacy).toBe(0);
        // Legacy v1 row keeps legacy=1 and NULL tiers.
        expect(piCompartments[1].legacy).toBe(1);
        expect(piCompartments[1].p1).toBeNull();

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
            piSessionsRoot: join(tempDir(), "sessions"),
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
            piSessionsRoot: join(tempDir(), "sessions"),
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
                writeFileAtomic: () => {
                    throw new Error("writeFileAtomic should not be called");
                },
                unlinkSync: () => {
                    throw new Error("unlink should not be called");
                },
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

describe("migration journal — crash-safe lifecycle", () => {
    function insertCompartment(ck: CortexkitTestDb, sessionId: string): void {
        ck.prepare(
            "INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, created_at, harness) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'opencode')",
        ).run(sessionId, 0, 1, 1, "msg_1", "msg_1", "Comp 0", "summary 0", 5);
    }

    function countPiCompartments(ck: CortexkitTestDb, piSessionId: string): number {
        return (
            ck
                .prepare(
                    "SELECT COUNT(*) AS n FROM compartments WHERE session_id = ? AND harness = 'pi'",
                )
                .get(piSessionId) as { n: number }
        ).n;
    }

    it("happy path: stage lands outside the sessions root, final in it, journal row cleared", () => {
        const db = makeDb();
        const { sessionId } = insertSyntheticSession(db);
        const ck = makeCortexkitDb();
        insertCompartment(ck, sessionId);
        const root = tempDir();
        const sessionsRoot = join(root, "sessions");

        const result = migrateOpenCodeSessionToPi({
            db,
            cortexkitDb: ck,
            sessionId,
            piSessionsRoot: sessionsRoot,
            now: new Date("2026-04-30T11:46:47.422Z"),
        });

        expect(result.migrationKey).toBe(migrationKeyFor(sessionId, "pi"));
        expect(result.journalResumed).toBe(false);
        expect(result.recovery).toEqual({
            completed: 0,
            rolledForward: 0,
            rolledBack: 0,
            lost: [],
        });
        expect(existsSync(result.outputPath)).toBe(true);
        expect(result.outputPath.startsWith(sessionsRoot)).toBe(true);
        // The staged file was renamed away, not copied.
        expect(existsSync(join(root, ".mc-migrations", `${result.migrationKey}.jsonl`))).toBe(
            false,
        );
        expect(readJournalRows(ck)).toEqual([]);
        expect(countPiCompartments(ck, result.piSessionId)).toBe(1);
    });

    it("a crash while staging leaves a phase=staged row and provably no shared state", () => {
        const db = makeDb();
        const { sessionId } = insertSyntheticSession(db);
        const ck = makeCortexkitDb();
        insertCompartment(ck, sessionId);

        expect(() =>
            migrateOpenCodeSessionToPi({
                db,
                cortexkitDb: ck,
                sessionId,
                piSessionsRoot: join(tempDir(), "sessions"),
                now: new Date("2026-04-30T11:46:47.422Z"),
                fs: {
                    writeFileAtomic: () => {
                        throw new Error("disk full");
                    },
                    unlinkSync: () => {},
                    existsSync: () => false,
                    renameSync: () => {},
                    mkdirSync: () => {},
                },
            }),
        ).toThrow("disk full");

        const rows = readJournalRows(ck);
        expect(rows).toHaveLength(1);
        expect(rows[0].phase).toBe("staged");
        expect(rows[0].pi_session_id.length).toBeGreaterThan(0);
        expect(rows[0].content_sha256.length).toBe(64);
        // Ordering proof: the staged row committed BEFORE any shared state.
        expect(countPiCompartments(ck, rows[0].pi_session_id)).toBe(0);
    });

    it("replay after a post-commit crash reuses the journal identity and upserts shared state", () => {
        const db = makeDb();
        const { sessionId } = insertSyntheticSession(db);
        const ck = makeCortexkitDb();
        insertCompartment(ck, sessionId);
        const sessionsRoot = join(tempDir(), "sessions");

        // Attempt 1 crashes AFTER the shared-state transaction committed but
        // before the stage file reached its final path (rename failure).
        expect(() =>
            migrateOpenCodeSessionToPi({
                db,
                cortexkitDb: ck,
                sessionId,
                piSessionsRoot: sessionsRoot,
                now: new Date("2026-04-30T11:46:47.422Z"),
                fs: {
                    writeFileAtomic: (path, data) => {
                        mkdirSync(dirname(path), { recursive: true });
                        writeFileSync(path, data, "utf-8");
                    },
                    unlinkSync: (path) => unlinkSync(path),
                    existsSync: (path) => existsSync(path),
                    renameSync: () => {
                        throw new Error("rename failed");
                    },
                    mkdirSync: (path, options) => mkdirSync(path, options),
                },
            }),
        ).toThrow("rename failed");

        const crashed = readJournalRows(ck);
        expect(crashed).toHaveLength(1);
        expect(crashed[0].phase).toBe("db_committed");
        const firstPiSessionId = crashed[0].pi_session_id;
        expect(countPiCompartments(ck, firstPiSessionId)).toBe(1);

        // The staged bytes are lost before the retry can roll forward.
        unlinkSync(crashed[0].stage_path);

        // Attempt 2 (real fs): the sweep reports the loss loudly, the journal
        // identity is reused, and the upsert-shaped shared-state commit cannot
        // UNIQUE-collide on the rows attempt 1 committed.
        const result = migrateOpenCodeSessionToPi({
            db,
            cortexkitDb: ck,
            sessionId,
            piSessionsRoot: sessionsRoot,
            now: new Date("2026-04-30T12:00:00.000Z"),
        });

        expect(result.journalResumed).toBe(true);
        expect(result.piSessionId).toBe(firstPiSessionId);
        expect(result.recovery?.lost).toHaveLength(1);
        expect(result.recovery?.lost[0].migration_key).toBe(result.migrationKey);
        expect(result.recovery?.lost[0].content_sha256).toBe(crashed[0].content_sha256);
        // Exactly ONE set of shared rows — replaced, never duplicated.
        expect(countPiCompartments(ck, firstPiSessionId)).toBe(1);
        expect(readJournalRows(ck)).toEqual([]);
        expect(existsSync(result.outputPath)).toBe(true);
        expect(result.outputPath).toBe(crashed[0].final_path);
    });

    it("the next run rolls back a staged-only crash and migrates with a fresh identity", () => {
        const db = makeDb();
        const { sessionId } = insertSyntheticSession(db);
        const ck = makeCortexkitDb();
        insertCompartment(ck, sessionId);
        const sessionsRoot = join(tempDir(), "sessions");

        expect(() =>
            migrateOpenCodeSessionToPi({
                db,
                cortexkitDb: ck,
                sessionId,
                piSessionsRoot: sessionsRoot,
                now: new Date("2026-04-30T11:46:47.422Z"),
                fs: {
                    writeFileAtomic: () => {
                        throw new Error("stage write failed");
                    },
                    unlinkSync: () => {},
                    existsSync: () => false,
                    renameSync: () => {},
                    mkdirSync: () => {},
                },
            }),
        ).toThrow("stage write failed");
        const crashed = readJournalRows(ck);
        expect(crashed).toHaveLength(1);
        expect(crashed[0].phase).toBe("staged");

        const result = migrateOpenCodeSessionToPi({
            db,
            cortexkitDb: ck,
            sessionId,
            piSessionsRoot: sessionsRoot,
            now: new Date("2026-04-30T12:00:00.000Z"),
        });

        expect(result.recovery?.rolledBack).toBe(1);
        expect(result.journalResumed).toBe(false);
        expect(result.piSessionId).not.toBe(crashed[0].pi_session_id);
        expect(readJournalRows(ck)).toEqual([]);
        expect(existsSync(result.outputPath)).toBe(true);
        expect(countPiCompartments(ck, result.piSessionId)).toBe(1);
    });
});

describe("sweepPendingMigrations — phase reconciliation", () => {
    function seedRow(
        ck: CortexkitTestDb,
        dir: string,
        overrides: Partial<MigrationPendingRow> = {},
    ): MigrationPendingRow {
        const row: MigrationPendingRow = {
            migration_key: `key_${Math.random().toString(36).slice(2)}`,
            source_session_id: "ses_src",
            target_harness: "pi",
            pi_session_id: "pi_uuid",
            final_path: join(dir, "sessions", "--tmp--", "final.jsonl"),
            stage_path: join(dir, ".mc-migrations", "stage.jsonl"),
            content_sha256: "abc123",
            phase: "staged",
            created_at: 1,
            ...overrides,
        };
        ck.prepare(
            "INSERT INTO migration_pending (migration_key, source_session_id, target_harness, pi_session_id, final_path, stage_path, content_sha256, phase, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
            row.migration_key,
            row.source_session_id,
            row.target_harness,
            row.pi_session_id,
            row.final_path,
            row.stage_path,
            row.content_sha256,
            row.phase,
            row.created_at,
        );
        return row;
    }

    it("staged + stage file ⇒ rolls back (stage removed, row deleted)", () => {
        const ck = makeCortexkitDb();
        const dir = tempDir();
        const row = seedRow(ck, dir);
        mkdirSync(dirname(row.stage_path), { recursive: true });
        writeFileSync(row.stage_path, "{}\n", "utf-8");

        const report = sweepPendingMigrations(ck);

        expect(report).toEqual({ completed: 0, rolledForward: 0, rolledBack: 1, lost: [] });
        expect(existsSync(row.stage_path)).toBe(false);
        expect(readJournalRows(ck)).toEqual([]);
    });

    it("staged without a stage file ⇒ row deleted anyway", () => {
        const ck = makeCortexkitDb();
        const row = seedRow(ck, tempDir());

        const report = sweepPendingMigrations(ck);

        expect(report.rolledBack).toBe(1);
        expect(readJournalRows(ck)).toEqual([]);
        expect(row.migration_key.length).toBeGreaterThan(0);
    });

    it("db_committed + stage file ⇒ rolls forward (rename completes, row deleted)", () => {
        const ck = makeCortexkitDb();
        const dir = tempDir();
        const row = seedRow(ck, dir, { phase: "db_committed" });
        mkdirSync(dirname(row.stage_path), { recursive: true });
        writeFileSync(row.stage_path, '{"type":"session"}\n', "utf-8");
        // The final path's parent directory never existed (the crash happened
        // before anything created it) — the sweep must still complete the rename.
        expect(existsSync(dirname(row.final_path))).toBe(false);

        const report = sweepPendingMigrations(ck);

        expect(report).toEqual({ completed: 0, rolledForward: 1, rolledBack: 0, lost: [] });
        expect(existsSync(row.final_path)).toBe(true);
        expect(existsSync(row.stage_path)).toBe(false);
        expect(readFileSync(row.final_path, "utf-8")).toBe('{"type":"session"}\n');
        expect(readJournalRows(ck)).toEqual([]);
    });

    it("final file present ⇒ row deleted regardless of phase (finished migration)", () => {
        const ck = makeCortexkitDb();
        const dir = tempDir();
        const row = seedRow(ck, dir, { phase: "db_committed" });
        mkdirSync(dirname(row.final_path), { recursive: true });
        writeFileSync(row.final_path, "{}\n", "utf-8");

        const report = sweepPendingMigrations(ck);

        expect(report.completed).toBe(1);
        expect(report.lost).toEqual([]);
        expect(readJournalRows(ck)).toEqual([]);
    });

    it("db_committed without any file ⇒ reported lost and the row is kept", () => {
        const ck = makeCortexkitDb();
        const row = seedRow(ck, tempDir(), {
            phase: "db_committed",
            content_sha256: "deadbeef",
        });

        const report = sweepPendingMigrations(ck);

        expect(report).toEqual({ completed: 0, rolledForward: 0, rolledBack: 0, lost: [row] });
        // Never silently deleted: the checksum row survives to name the loss.
        expect(readJournalRows(ck)).toEqual([row]);
    });

    it("is a no-op when the journal table does not exist", () => {
        const db = new Database(":memory:");
        databases.push(db);
        const report = sweepPendingMigrations(db);
        expect(report).toEqual({ completed: 0, rolledForward: 0, rolledBack: 0, lost: [] });
    });
});

describe("compartment ordinals — Pi runtime reader basis", () => {
    function insertExpandingSession(db: ReturnType<typeof makeDb>): string {
        // user A (1 entry), assistant B (reasoning + text + tool ⇒ 4 entries),
        // user C (1 entry). B's toolResult folds into C's runtime turn.
        const sessionId = "ses_ord";
        db.prepare(
            "INSERT INTO session (id, title, directory, path, time_created) VALUES (?, ?, ?, ?, ?)",
        ).run(sessionId, "Ord", "/tmp/ord", null, 1);
        const insertMessage = db.prepare(
            "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
        );
        const insertPart = db.prepare(
            "INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)",
        );
        insertMessage.run("msg_A", sessionId, 1000, JSON.stringify({ role: "user" }));
        insertPart.run(
            "prt_A1",
            "msg_A",
            sessionId,
            1000,
            JSON.stringify({ type: "text", text: "question A" }),
        );
        insertMessage.run("msg_B", sessionId, 2000, JSON.stringify({ role: "assistant" }));
        insertPart.run(
            "prt_B1",
            "msg_B",
            sessionId,
            2000,
            JSON.stringify({ type: "reasoning", text: "thinking B" }),
        );
        insertPart.run(
            "prt_B2",
            "msg_B",
            sessionId,
            2001,
            JSON.stringify({ type: "text", text: "answer B" }),
        );
        insertPart.run(
            "prt_B3",
            "msg_B",
            sessionId,
            2002,
            JSON.stringify({
                type: "tool",
                tool: "bash",
                callID: "call_B",
                state: { input: { command: "ls" }, output: "ok" },
            }),
        );
        insertMessage.run("msg_C", sessionId, 3000, JSON.stringify({ role: "user" }));
        insertPart.run(
            "prt_C1",
            "msg_C",
            sessionId,
            3000,
            JSON.stringify({ type: "text", text: "next C" }),
        );
        return sessionId;
    }

    function readPiCompartment(ck: CortexkitTestDb, piSessionId: string, sequence: number) {
        return ck
            .prepare(
                "SELECT start_message, end_message, start_message_id, end_message_id FROM compartments WHERE session_id = ? AND harness = 'pi' AND sequence = ?",
            )
            .get(piSessionId, sequence) as {
            start_message: number;
            end_message: number;
            start_message_id: string;
            end_message_id: string;
        };
    }

    it("one message expanding to several entries spans all of its runtime ordinals", () => {
        const db = makeDb();
        const sessionId = insertExpandingSession(db);
        const ck = makeCortexkitDb();
        ck.prepare(
            "INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, created_at, harness) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'opencode')",
        ).run(sessionId, 0, 2, 2, "msg_B", "msg_B", "Mid", "summary", 5);

        const result = migrateOpenCodeSessionToPi({
            db,
            cortexkitDb: ck,
            sessionId,
            piSessionsRoot: join(tempDir(), "sessions"),
            now: new Date("2026-04-30T11:46:47.422Z"),
        });

        const entries = readJsonl(result.outputPath);
        const row = readPiCompartment(ck, result.piSessionId, 0);

        // B's derived entries, located by content.
        const thinkingEntry = entries.find(
            (entry) =>
                (entry.message as { content?: Array<{ thinking?: string }> })?.content?.[0]
                    ?.thinking === "thinking B",
        );
        const toolResultEntry = entries.find(
            (entry) => (entry.message as { role?: string })?.role === "toolResult",
        );
        expect(thinkingEntry).toBeDefined();
        expect(toolResultEntry).toBeDefined();

        // Boundary ids: FIRST derived entry for the start, LAST for the end.
        expect(row.start_message_id).toBe(thinkingEntry.id);
        expect(row.end_message_id).toBe(toolResultEntry.id);

        // Ordinals resolved THROUGH THE RUNTIME READ PATH.
        expect(row.start_message).toBe(runtimeOrdinalOfEntry(entries, thinkingEntry.id));
        expect(row.end_message).toBe(runtimeOrdinalOfEntry(entries, toolResultEntry.id));
        // The mid-compartment spans the whole expansion: thinking, text,
        // toolCall entries plus the folded toolResult turn ⇒ >= 4 ordinals.
        expect(row.end_message - row.start_message).toBeGreaterThanOrEqual(3);
    });

    it("remaps an expanded start-boundary message to its FIRST Pi entry (no silent shrink)", () => {
        const db = makeDb();
        const sessionId = insertExpandingSession(db);
        const ck = makeCortexkitDb();
        ck.prepare(
            "INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, created_at, harness) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'opencode')",
        ).run(sessionId, 0, 2, 3, "msg_B", "msg_C", "StartExpand", "summary", 5);

        const result = migrateOpenCodeSessionToPi({
            db,
            cortexkitDb: ck,
            sessionId,
            piSessionsRoot: join(tempDir(), "sessions"),
            now: new Date("2026-04-30T11:46:47.422Z"),
        });

        const entries = readJsonl(result.outputPath);
        const row = readPiCompartment(ck, result.piSessionId, 0);
        const thinkingEntry = entries.find(
            (entry) =>
                (entry.message as { content?: Array<{ thinking?: string }> })?.content?.[0]
                    ?.thinking === "thinking B",
        );
        const toolResultEntry = entries.find(
            (entry) => (entry.message as { role?: string })?.role === "toolResult",
        );
        const userCEntry = entries.find(
            (entry) =>
                (entry.message as { content?: Array<{ text?: string }> })?.content?.[0]?.text ===
                "next C",
        );

        // The start boundary is B's FIRST derived entry — the old last-entry
        // remap would have picked the toolResult and shrunk the span.
        expect(row.start_message_id).toBe(thinkingEntry.id);
        expect(row.start_message_id).not.toBe(toolResultEntry.id);
        expect(row.start_message).toBe(runtimeOrdinalOfEntry(entries, thinkingEntry.id));
        // The end boundary keeps last-entry semantics.
        expect(row.end_message_id).toBe(userCEntry.id);
        expect(row.end_message).toBe(runtimeOrdinalOfEntry(entries, userCEntry.id));
    });

    it("compaction-marker insertion does not shift the ordinal basis", () => {
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
            piSessionsRoot: join(tempDir(), "sessions"),
            now: new Date("2026-04-30T11:46:47.422Z"),
        });
        expect(result.compactionMarkerWritten).toBe(true);

        const entries = readJsonl(result.outputPath);
        expect(entries.some((entry) => entry.type === "compaction")).toBe(true);
        // The runtime reader skips structural entries: the RawMessage sequence
        // is identical with or without the marker, so ordinals cannot drift.
        expect(convertEntriesToRawMessages(entries).length).toBe(
            convertEntriesToRawMessages(entries.filter((entry) => entry.type !== "compaction"))
                .length,
        );

        const row = readPiCompartment(ck, result.piSessionId, 0);
        const helloEntry = entries.find(
            (entry) =>
                (entry.message as { content?: Array<{ text?: string }> })?.content?.[0]?.text ===
                "hello",
        );
        const toolResultEntry = entries.find(
            (entry) => (entry.message as { role?: string })?.role === "toolResult",
        );
        expect(row.start_message_id).toBe(helloEntry.id);
        expect(row.end_message_id).toBe(toolResultEntry.id);
        expect(row.start_message).toBe(runtimeOrdinalOfEntry(entries, helloEntry.id));
        expect(row.end_message).toBe(runtimeOrdinalOfEntry(entries, toolResultEntry.id));
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

    it("accepts OMP as a Pi-compatible migration target", () => {
        expect(
            parseMigrateArgs(["--from", "opencode", "--to", "omp", "--session", "ses_x"]),
        ).toEqual({ from: "opencode", to: "omp", session: "ses_x" });
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
