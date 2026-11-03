// Run from the repository root with Bun; all input comes from an in-memory database.
import { writeFileSync } from "node:fs";
import {
    buildCanonicalChunkTextFromFts,
    buildCompartmentSummaryFallbackText,
    chunkCanonicalText,
} from "../../../../packages/plugin/src/features/magic-context/compartment-chunk-embedding";
import { Database } from "../../../../packages/plugin/src/shared/sqlite";
import { initializeDatabase } from "../../../../packages/plugin/src/features/magic-context/storage-db";
import { runMigrations } from "../../../../packages/plugin/src/features/magic-context/migrations";

const db = new Database(":memory:");
initializeDatabase(db);
runMigrations(db);
const rows = [
    { ordinal: 1, role: "user", content: "  Search\n history\tby meaning.\uFEFF " },
    { ordinal: 2, role: "user", content: "Keep adjacent user lines grouped. 中文 café 😀" },
    { ordinal: 3, role: "assistant", content: "Embed raw chunks, not the paraphrase. " + "The SQLite store keeps durable history. ".repeat(12) },
    { ordinal: 4, role: "assistant", content: "\n\t " },
    { ordinal: 5, role: "tool", content: "Not conversation." },
    { ordinal: 6, role: "assistant", content: "Return matching ordinal ranges." },
    { ordinal: 7, role: "user", content: "And preserve the provider identity." },
];
for (const row of rows) {
    const result = db.prepare("INSERT INTO message_history_fts(session_id, message_ordinal, message_id, role, content) VALUES ('session', ?, ?, ?, ?)")
        .run(row.ordinal, `m${row.ordinal}`, row.role, row.content);
    db.prepare("INSERT INTO message_fts_rowid_map(session_id, message_ordinal, fts_rowid) VALUES ('session', ?, ?)").run(row.ordinal, result.lastInsertRowid);
}
db.prepare("INSERT INTO compartments(id, session_id, sequence, start_message, end_message, title, p1, content, created_at) VALUES (1, 'session', 1, 8, 10, ?, ?, ?, 1)").run("  Empty raw span  ", "  Useful fallback.\nSecond line. ", "Ignored legacy content.");
const canonical = buildCanonicalChunkTextFromFts(db, "session", 1, 7);
if (canonical === null) throw new Error("fixture span must be mapped");
const fallback = buildCompartmentSummaryFallbackText(db, 1);
const cases = [
    ...[512, 80, 24, 8].map((max) => ({ text: canonical, start: 1, end: 7, max })),
    { text: fallback, start: 8, end: 10, max: 512 },
    { text: "[1] A: " + "a1!".repeat(50), start: 1, end: 1, max: 16 },
    { text: "[1] U: " + "中文😀".repeat(10), start: 1, end: 1, max: 8 },
];
writeFileSync(new URL("chunk-embedding.json", import.meta.url), JSON.stringify({
    rows, canonical, fallback,
    cases: cases.map((c) => ({ ...c, windows: chunkCanonicalText(c.text, c.start, c.end, c.max).map((w) => ({
        ...w,
        // Tiny windows can bisect an emoji's UTF-16 pair. Compare the UTF-8
        // bytes the plugin hashes and sends, replacing lone surrogates.
        text: Buffer.from(w.text, "utf8").toString("utf8"),
    })) })),
}, null, 2) + "\n");
db.close();
console.log(`Generated ${cases.length} plugin chunk parity cases.`);
