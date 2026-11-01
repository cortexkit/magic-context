import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RawMessage } from "../../../../packages/plugin/src/hooks/magic-context/read-session-raw";

type InputMessage = RawMessage & { completedAt: number | null };
type Step = { mode: "page" | "live" | "revert"; revision: string; messages: InputMessage[]; revertFrom?: number };
type Fixture = { session: string; steps: Step[]; normalizations: InputMessage[] };

const base = join(tmpdir(), "magic-context", "archive-index-2b");
mkdirSync(base, { recursive: true });
const sandbox = mkdtempSync(join(base, "typescript-"));
// Migration and logger dependencies must not write to the operator's home.
process.env.HOME = sandbox;
process.env.XDG_DATA_HOME = sandbox;
process.env.XDG_CONFIG_HOME = sandbox;
process.env.XDG_CACHE_HOME = sandbox;
process.env.MAGIC_CONTEXT_LOG_PATH = join(sandbox, "magic-context.log");
process.env.NODE_ENV = "test";

try {
    const root = fileURLToPath(new URL("../../../..", import.meta.url));
    const { Database } = await import(join(root, "packages/plugin/src/shared/sqlite.ts"));
    const { initializeDatabase } = await import(join(root, "packages/plugin/src/features/magic-context/storage-db.ts"));
    const { runMigrations } = await import(join(root, "packages/plugin/src/features/magic-context/migrations.ts"));
    const index = await import(join(root, "packages/plugin/src/features/magic-context/message-index.ts"));
    const db = new Database(join(sandbox, "context.db"));
    initializeDatabase(db);
    runMigrations(db);
    const fixture: Fixture = JSON.parse(readFileSync(new URL("./sequences.json", import.meta.url), "utf8"));
    const canonical = new Map<string, InputMessage>();
    const snapshot = (session: string) => ({
        fts: db.prepare(`SELECT CAST(fts.message_ordinal AS INTEGER) AS ordinal,fts.message_id AS id,
            fts.role,fts.content,map.message_time_ms AS time FROM message_history_fts AS fts
            JOIN message_fts_rowid_map AS map ON map.fts_rowid=fts.rowid
            WHERE fts.session_id=? ORDER BY ordinal`).all(session),
        source: db.prepare(`SELECT message_id AS id,message_ordinal AS ordinal,source_version AS version,
            normalized_content_hash AS hash,role FROM message_history_source WHERE session_id=? ORDER BY ordinal`).all(session),
        watermark: index.getLastIndexedOrdinal(db, session),
        dirty: index.getDirtyIndexFloor(db, session),
    });
    const snapshots: unknown[] = [];
    const queryCases = [
        { query: "run", cutoff: 2, start: null, end: null, limit: 10 },
        { query: "cafe", cutoff: 2, start: null, end: null, limit: 10 },
        { query: "archive_index", cutoff: 2, start: null, end: null, limit: 10 },
        { query: "user", cutoff: 2, start: null, end: null, limit: 10 },
        { query: "run", cutoff: 0, start: null, end: null, limit: 10 },
        { query: "run", cutoff: 2, start: 150, end: 250, limit: 1 },
    ];
    let queries: unknown[] = [];
    for (const step of fixture.steps) {
        if (step.mode === "revert") {
            const deleted = [...canonical.values()].filter(m => m.ordinal >= step.revertFrom!);
            for (const m of deleted) canonical.delete(m.id);
            index.deleteIndexedMessage(db, fixture.session, deleted[0].id);
            // Removal clears the TypeScript session index because ordinals can
            // shift. Rebuild the surviving prefix before comparing logical rows.
            const surviving = [...canonical.values()].sort((a, b) => a.ordinal - b.ordinal);
            index.indexMessagesAfterOrdinal(db, fixture.session, surviving, 0, surviving.length);
        } else {
            for (const m of step.messages) canonical.set(m.id, m);
            if (step.mode === "live") {
                for (const m of step.messages) index.indexSingleMessage(db, fixture.session, m);
            } else {
                const watermark = index.getLastIndexedOrdinal(db, fixture.session);
                const through = Math.max(watermark, ...step.messages.map(m => m.ordinal));
                index.indexMessagesAfterOrdinal(db, fixture.session, step.messages, watermark, through);
            }
        }
        snapshots.push({ ...snapshot(fixture.session), ordinals: [...canonical.values()]
            .sort((a, b) => a.ordinal - b.ordinal).map(m => [m.id, m.ordinal]) });
        if (snapshots.length === 1) {
            queries = queryCases.map(c => ({ ...c, ordinals: db.prepare(`
                SELECT CAST(fts.message_ordinal AS INTEGER) AS ordinal FROM message_history_fts AS fts
                JOIN message_fts_rowid_map AS map ON map.fts_rowid=fts.rowid
                WHERE fts.session_id=?1 AND message_history_fts MATCH ?2
                AND CAST(fts.message_ordinal AS INTEGER)<=?3
                AND (?4 IS NULL OR map.message_time_ms>=?4) AND (?5 IS NULL OR map.message_time_ms<=?5)
                ORDER BY bm25(message_history_fts),CAST(fts.message_ordinal AS INTEGER) ASC LIMIT ?6`)
                .all(fixture.session, `content : (${c.query})`, c.cutoff, c.start, c.end, c.limit)
                .map((row: { ordinal: number }) => row.ordinal) }));
        }
    }
    const normalizations = fixture.normalizations.map(m => index.getIndexableContent(m.role, m.parts));
    const oversized: InputMessage = { id: "oversized", ordinal: 1, role: "user",
        parts: [{ type: "text", text: "é".repeat(32769) }], createdAt: 123, completedAt: null };
    index.indexSingleMessage(db, "oversized", oversized);
    const oversizedSnapshot = snapshot("oversized");
    const skip = JSON.parse(db.prepare("SELECT value FROM schema_migrations_meta WHERE key=?")
        .get(index.messageIndexSkipKey("oversized", "oversized")).value);
    const versions = [0, 1.0, 1e21, 1e-7, 1000.25].map((version, i) => {
        const m: InputMessage = { id: `version${i}`, ordinal: i + 1, role: "user",
            parts: [{ type: "text", text: "version source" }], createdAt: null, completedAt: null, version };
        return { message: m, expected: index.toMessageIndexSource(m).sourceVersion };
    });
    const backfillMessages: InputMessage[] = Array.from({ length: 7 }, (_, i) => ({
        id: `id${i + 1}`, ordinal: i + 1, role: "user", parts: [{ type: "text", text: "resume needle" }],
        createdAt: (i + 1) * 100, completedAt: null, version: 1,
    }));
    const bounded: unknown[] = [];
    for (let start = 0; start < backfillMessages.length; start += 2) {
        index.indexMessagesAfterOrdinal(db, "resume", backfillMessages.slice(start, start + 2), start, 7);
        bounded.push(snapshot("resume"));
    }
    const holeMessages: InputMessage[] = [
        { id: "first", ordinal: 1, role: "user", parts: [{ type: "text", text: "first" }], createdAt: 100, completedAt: null, version: 1 },
        { id: "second", ordinal: 2, role: "user", parts: [{ type: "text", text: "second" }], createdAt: 200, completedAt: null, version: 1 },
        { id: "third", ordinal: 3, role: "user", parts: [{ type: "text", text: "future" }], createdAt: 300, completedAt: null, version: 1 },
    ];
    index.indexSingleMessage(db, "hole", holeMessages[2]);
    const holes = [snapshot("hole")];
    index.indexMessagesAfterOrdinal(db, "hole", [holeMessages[0]], 0, 3);
    holes.push(snapshot("hole"));
    index.indexMessagesAfterOrdinal(db, "hole", holeMessages.slice(1), 1, 3);
    holes.push(snapshot("hole"));
    const config = db.prepare("SELECT k,v FROM message_history_fts_config ORDER BY k").all();
    writeFileSync(resolve(process.argv[2]), JSON.stringify({ snapshots, normalizations, versions, bounded, holes, oversized: oversizedSnapshot, skip, queries, config }, null, 2));
    db.close();
    console.log(`TypeScript archive index: ${snapshots.length} sequence snapshots, ${normalizations.length} normalization cases, 1 oversized source, ${queries.length} FTS queries, ${bounded.length} bounded pages, ${holes.length} hole snapshots`);
} finally {
    rmSync(sandbox, { recursive: true, force: true });
}
