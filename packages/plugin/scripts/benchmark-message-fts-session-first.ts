/** SQL-lane benchmark: only read-only handles, SQLite backups, and private hashes. */
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
    MESSAGE_FTS_SESSION_FILTER_SQL,
    withMessageFtsSessionFilter,
} from "../src/features/magic-context/message-fts-session-filter";
import { Database, type Statement } from "../src/shared/sqlite";

const args = process.argv.slice(2);
function option(name: string, fallback = ""): string {
    const index = args.indexOf(`--${name}`);
    return index < 0 ? fallback : (args[index + 1] ?? fallback);
}

const match = `content : ("What's" "the" "current" "status" "?")`;
type Lane = "auto" | "diagnostic";
type Arm = "global" | "session";
interface Sample {
    ms: number;
    hash: string;
    rows: number;
    suppressed: number;
    filtered: boolean;
}

// These are the pre-filter production SELECTs, including the diagnostic UNION's
// existing tie ordering. Both arms retain the same global bm25 corpus.
function querySql(lane: Lane, filtered: boolean): string {
    const filter = filtered ? MESSAGE_FTS_SESSION_FILTER_SQL : "";
    if (lane === "auto") {
        return `SELECT message_ordinal AS messageOrdinal, message_id AS messageId, role, content
            FROM message_history_fts WHERE ${filter}session_id = ? AND message_history_fts MATCH ?
            ORDER BY bm25(message_history_fts), CAST(message_ordinal AS INTEGER) ASC LIMIT ?`;
    }
    return `WITH matches AS MATERIALIZED (
        SELECT message_ordinal AS messageOrdinal, message_id AS messageId, role, content,
            CAST(message_ordinal AS INTEGER) AS ordinalValue, bm25(message_history_fts) AS ftsRank
        FROM message_history_fts WHERE ${filter}session_id = ? AND message_history_fts MATCH ?
    ), eligible AS (
        SELECT * FROM matches WHERE ordinalValue <= ? ORDER BY ftsRank, ordinalValue ASC LIMIT ?
    ), summary AS (
        SELECT COUNT(*) AS suppressedCount FROM matches WHERE ordinalValue > ?
    )
    SELECT eligible.messageOrdinal, eligible.messageId, eligible.role, eligible.content,
        eligible.ftsRank, summary.suppressedCount, 0 AS summaryOnly
    FROM eligible CROSS JOIN summary
    UNION ALL
    SELECT NULL, NULL, NULL, NULL, NULL, summary.suppressedCount, 1 FROM summary
    WHERE NOT EXISTS (SELECT 1 FROM eligible)
    ORDER BY summaryOnly ASC, ftsRank ASC, messageOrdinal ASC`;
}

function worker(): void {
    const db = new Database(`file:${option("copy")}?immutable=1`, { readonly: true });
    const lane = option("lane") as Lane;
    const arm = option("arm") as Arm;
    const cutoff = Number(option("cutoff"));
    const session = option("session");
    const count = Number(option("count", "1"));
    const prepared = new Map<boolean, Statement>();
    const read = (filtered: boolean) => {
        let statement = prepared.get(filtered);
        if (!statement) {
            statement = db.prepare(querySql(lane, filtered));
            prepared.set(filtered, statement);
        }
        return lane === "auto"
            ? statement.all(...(filtered ? [session, session] : [session]), match, 30)
            : statement.all(...(filtered ? [session, session] : [session]), match, cutoff, 90, cutoff);
    };
    const run = (): Sample => {
        let filtered = false;
        const start = performance.now();
        const rows = arm === "global" ? read(false) : withMessageFtsSessionFilter(db, session, (value) => {
            filtered = value;
            return read(value);
        });
        const ms = performance.now() - start;
        return {
            ms, filtered,
            hash: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
            rows: rows.filter((row) => (row as { summaryOnly?: number }).summaryOnly !== 1).length,
            suppressed: (rows[0] as { suppressedCount?: number } | undefined)?.suppressedCount ?? 0,
        };
    };
    try {
        if (option("warmup") === "yes") run();
        console.log(JSON.stringify(Array.from({ length: count }, run)));
    } finally {
        db.close();
    }
}

function subprocess(command: string, argv: string[]): string {
    // A multi-gigabyte backup can queue behind other disk users. Its time is not
    // part of the SQL measurement; allow it more time than a query worker.
    const result = spawnSync(command, argv, { encoding: "utf8", timeout: command === "sqlite3" ? 600000 : 120000 });
    if (result.error || result.status !== 0) {
        throw new Error(`${command} failed: ${result.error ?? result.stderr}`);
    }
    return result.stdout;
}

function stats(values: number[]): { median: number; p90: number; samples: number } {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return {
        median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
        p90: sorted[Math.ceil(sorted.length * 0.9) - 1], samples: sorted.length,
    };
}

function main(): void {
    const source = resolve(option("source"));
    const directory = resolve(option("directory"));
    const allowed = `${resolve(join(tmpdir(), "magic-context"))}/`;
    if (!option("source") || !option("directory") || !directory.startsWith(allowed) || !source.startsWith(allowed)) {
        throw new Error("Provide --source <read-only seed> --directory <$TMPDIR/magic-context/task>");
    }
    mkdirSync(directory, { recursive: true });
    const db = new Database(`file:${source}?immutable=1`, { readonly: true });
    const selected = db.prepare(`SELECT map.session_id AS session, COUNT(*) AS rows
        FROM message_fts_rowid_map AS map JOIN session_meta AS meta ON meta.session_id = map.session_id
        WHERE meta.harness = 'pi' GROUP BY map.session_id ORDER BY rows DESC LIMIT 1`).get() as { session: string; rows: number };
    const cutoffRow = db.prepare(`SELECT MAX(end_message) AS cutoff FROM compartments
        WHERE session_id = ? AND rebase_status != 'unresolved'`).get(selected.session) as { cutoff: number | null };
    const inventory = db.prepare(`SELECT (SELECT COUNT(*) FROM message_history_fts_docsize) AS ftsRows,
        (SELECT COUNT(*) FROM message_fts_rowid_map) AS mapRows`).get();
    const sqliteBackend = db.prepare("SELECT sqlite_version() AS version").get();
    db.close();
    if (cutoffRow.cutoff === null) throw new Error("Selected Pi session has no persisted cutoff");
    const repeats = Number(option("repeats", "10"));
    if (!Number.isSafeInteger(repeats) || repeats < 2) throw new Error("repeats must be at least two");
    const samples: Record<string, Sample[]> = {};
    const recordProgress = (key: string, values: Sample[]) => {
        (samples[key] ??= []).push(...values);
        writeFileSync(join(directory, "fts-benchmark-progress.json"), JSON.stringify({
            inventory, sessionRows: selected.rows, cutoff: cutoffRow.cutoff, match, samples,
        }, null, 2));
        console.log(`[message-fts] ${key}: ${samples[key].length} samples`);
    };
    const runChild = (copy: string, lane: Lane, arm: Arm, warm: boolean) => JSON.parse(subprocess(process.execPath, [
        process.argv[1], "--worker", "yes", "--copy", copy, "--lane", lane, "--arm", arm,
        "--session", selected.session, "--cutoff", String(cutoffRow.cutoff),
        "--count", String(warm ? repeats : 1), "--warmup", warm ? "yes" : "no",
    ])) as Sample[];
    for (const lane of ["auto", "diagnostic"] as const) {
        for (let repeat = 0; option("warm-only") !== "yes" && repeat < repeats; repeat++) {
            const arms: Arm[] = repeat % 2 ? ["session", "global"] : ["global", "session"];
            for (const arm of arms) {
                const copy = join(directory, `fts-${lane}-${arm}-${repeat}.db`);
                try {
                    // Backup is outside the timed lane. Every cold sample gets a
                    // new file AND process/SQLite cache; the OS cache is not purged.
                    subprocess("sqlite3", ["-readonly", `file:${source}?immutable=1`, `.backup ${copy}`]);
                    recordProgress(`cold:${lane}:${arm}`, runChild(copy, lane, arm, false));
                } finally {
                    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${copy}${suffix}`, { force: true });
                }
            }
        }
        for (const arm of ["global", "session"] as const) {
            recordProgress(`warm:${lane}:${arm}`, runChild(source, lane, arm, true));
        }
    }
    for (const lane of ["auto", "diagnostic"] as const) {
        const rows = Object.entries(samples).filter(([key]) => key.includes(`:${lane}:`)).flatMap(([, values]) => values);
        if (new Set(rows.map((row) => row.hash)).size !== 1) throw new Error(`${lane}: result bytes differ`);
        if (Object.entries(samples).some(([key, values]) => key.endsWith(":session") && values.some((row) => !row.filtered))) {
            throw new Error("Selected session did not reach the sidecar filter");
        }
    }
    const report = {
        runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.version}`,
        sqliteBackend, sqliteBackup: subprocess("sqlite3", ["--version"]).trim(),
        inventory, sessionRows: selected.rows, cutoff: cutoffRow.cutoff, match,
        equality: "All samples have identical row bytes within each lane",
        statistics: Object.fromEntries(Object.entries(samples).map(([key, values]) => [key, stats(values.map((row) => row.ms))])),
        samples,
    };
    const output = join(directory, "fts-benchmark.json");
    writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, samples: undefined, output }, null, 2));
}

if (option("worker") === "yes") worker();
else main();
