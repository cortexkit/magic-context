/**
 * Benchmark: P0 storage helper proposal vs current `getTagsBySession`.
 *
 * Measures the actual cost of three different approaches for the per-pass
 * tag queries in `transform.ts`, using the live SQLite database read-only
 * with a real production session as the data source.
 *
 * Three paths:
 *
 *   A) CURRENT — single `SELECT ... FROM tags WHERE session_id = ?` that
 *      loads every tag (status active|dropped|compacted), then JS-side
 *      iterates to find:
 *        - dropped rows whose tag_number is in `targets`
 *        - the maximum dropped tag_number (watermark)
 *        - active rows for cleanup/nudger
 *
 *   B) P0 ONLY — three targeted SQL helpers:
 *        - getTagsByNumbers(targets.keys())  → for applyFlushedStatuses
 *        - getMaxDroppedTagNumber()          → for watermark
 *        - getActiveTagsBySession()          → for cleanup/nudger
 *      Uses only the existing index `(session_id, tag_number)` which
 *      covers `WHERE session_id = ?` but NOT the status predicate.
 *
 *   C) P0 + PARTIAL INDEXES — same queries as B, but with two new
 *      partial indexes on `WHERE status = 'active'` and `WHERE status =
 *      'dropped'` so the active-only and dropped-only queries become
 *      index-only scans.
 *
 * Why a temp DB copy:
 *   - We don't want to mutate the user's live DB by adding indexes for
 *     the benchmark. Copy to /tmp, attach indexes there, dispose at end.
 *   - SQLite page cache is stable across queries within a process, so we
 *     warm the cache once and time many iterations to get reliable mean.
 *
 * Run:
 *   cd packages/plugin && bun run scripts/benchmark-tag-queries.ts
 */

import { Database, type Statement } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type DB = Database;
type Stmt = Statement;

const LIVE_DB_PATH =
    process.env.MAGIC_CONTEXT_DB ??
    join(
        process.env.HOME ?? "",
        ".local",
        "share",
        "cortexkit",
        "magic-context",
        "context.db",
    );

// AFT session — 48,949 tags total, 399 active (0.8%). Worst-case for the
// current scan-everything approach, best-case for partial indexes.
const SESSION_ID = process.env.BENCH_SESSION_ID ?? "ses_331acff95fferWZOYF1pG0cjOn";

// Iterations per phase. With 48k rows the current path is ~70ms so
// 200 iters = ~14s per phase, ~45s total. Tweak if you want tighter
// or looser stats.
const ITERATIONS = 200;
const WARMUP_ITERS = 20;

interface BenchTagEntry {
    id: number;
    session_id: string;
    message_id: string;
    type: string;
    status: string;
    drop_mode: string | null;
    tool_name: string | null;
    input_byte_size: number;
    byte_size: number;
    reasoning_byte_size: number;
    tag_number: number;
    caveman_depth: number;
}

function setupTempDb(): { db: DB; tempDir: string; path: string } {
    if (!existsSync(LIVE_DB_PATH)) {
        throw new Error(`Live DB not found at ${LIVE_DB_PATH}`);
    }

    // Copy to a temp dir so we can experiment with index changes without
    // touching the user's live DB.
    const tempDir = mkdtempSync(join(tmpdir(), "mc-bench-tags-"));
    const tempDbPath = join(tempDir, "context.db");
    copyFileSync(LIVE_DB_PATH, tempDbPath);

    // Also copy WAL/SHM files if present to ensure consistent snapshot.
    for (const suffix of ["-wal", "-shm"]) {
        const sidecar = LIVE_DB_PATH + suffix;
        if (existsSync(sidecar)) {
            copyFileSync(sidecar, tempDbPath + suffix);
        }
    }

    // Need write access for ANALYZE / index creation in path C.
    const db = new Database(tempDbPath, { readwrite: true });
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    return { db, tempDir, path: tempDbPath };
}

function pickRealTargets(
    db: DB,
    sessionId: string,
    n: number,
): Map<number, { tagNumber: number; status: string }> {
    // Targets in production are tag_numbers for tags currently visible in
    // the post-injection message array. The visible window is roughly the
    // tail of the session, so picking the highest N tag_numbers is a fair
    // approximation. Mix in some active and some dropped to mirror real
    // pass behavior (most active are at the tail, most dropped are older
    // but some recent visible tags are also dropped).
    const rows = db
        .prepare(
            `SELECT tag_number, status FROM tags
             WHERE session_id = ?
             ORDER BY tag_number DESC
             LIMIT ?`,
        )
        .all(sessionId, n) as Array<{ tag_number: number; status: string }>;

    const m = new Map<number, { tagNumber: number; status: string }>();
    for (const r of rows) {
        m.set(r.tag_number, { tagNumber: r.tag_number, status: r.status });
    }
    return m;
}

interface PathResult {
    flushedDroppedCount: number;
    flushedTruncatedCount: number;
    maxDroppedTagNumber: number;
    activeCount: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Path A — current single-query approach (matches getTagsBySession)
// ─────────────────────────────────────────────────────────────────────────

function pathA_current(
    db: DB,
    sessionId: string,
    targets: Map<number, unknown>,
): PathResult {
    const tags = db
        .prepare(
            `SELECT id, session_id, message_id, type, status, drop_mode, tool_name,
                    input_byte_size, byte_size, reasoning_byte_size, tag_number, caveman_depth
             FROM tags WHERE session_id = ?
             ORDER BY tag_number ASC, id ASC`,
        )
        .all(sessionId) as BenchTagEntry[];

    // Mimic applyFlushedStatuses + watermark + active filter loops
    let flushedDroppedCount = 0;
    let flushedTruncatedCount = 0;
    let maxDroppedTagNumber = 0;
    let activeCount = 0;

    for (const t of tags) {
        if (t.status === "dropped") {
            if (t.tag_number > maxDroppedTagNumber) maxDroppedTagNumber = t.tag_number;
            if (targets.has(t.tag_number)) {
                if (t.drop_mode === "truncated") flushedTruncatedCount++;
                else flushedDroppedCount++;
            }
        } else if (t.status === "active") {
            activeCount++;
        }
    }

    return {
        flushedDroppedCount,
        flushedTruncatedCount,
        maxDroppedTagNumber,
        activeCount,
    };
}

// ─────────────────────────────────────────────────────────────────────────
// Path B — three targeted helpers, no new indexes
// ─────────────────────────────────────────────────────────────────────────

interface PreparedB {
    activeStmt: Stmt;
    maxDroppedStmt: Stmt;
    // tagsByNumbers can't be a single prepared statement because the IN
    // list size varies. We build it per call.
}

function preparePathB(db: DB): PreparedB {
    return {
        activeStmt: db.prepare(
            `SELECT tag_number, message_id, type, byte_size, caveman_depth
             FROM tags WHERE session_id = ? AND status = 'active'
             ORDER BY tag_number ASC`,
        ),
        maxDroppedStmt: db.prepare(
            `SELECT MAX(tag_number) AS max_dropped
             FROM tags WHERE session_id = ? AND status = 'dropped'`,
        ),
    };
}

function pathB_targeted(
    db: DB,
    prep: PreparedB,
    sessionId: string,
    targets: Map<number, unknown>,
): PathResult {
    // 1. Active tags for heuristic cleanup, nudger, caveman replay scope.
    const activeTags = prep.activeStmt.all(sessionId) as Array<{
        tag_number: number;
        message_id: string;
        type: string;
        byte_size: number;
        caveman_depth: number;
    }>;
    const activeCount = activeTags.length;

    // 2. Watermark (single-row aggregate).
    const watermarkRow = prep.maxDroppedStmt.get(sessionId) as { max_dropped: number | null };
    const maxDroppedTagNumber = watermarkRow.max_dropped ?? 0;

    // 3. Dropped/truncated rows for current targets only.
    const targetNumbers = [...targets.keys()];
    let flushedDroppedCount = 0;
    let flushedTruncatedCount = 0;
    if (targetNumbers.length > 0) {
        const placeholders = targetNumbers.map(() => "?").join(",");
        const stmt = db.prepare(
            `SELECT tag_number, type, status, drop_mode
             FROM tags
             WHERE session_id = ? AND tag_number IN (${placeholders}) AND status = 'dropped'`,
        );
        const droppedTargets = stmt.all(sessionId, ...targetNumbers) as Array<{
            tag_number: number;
            type: string;
            status: string;
            drop_mode: string | null;
        }>;
        for (const r of droppedTargets) {
            if (r.drop_mode === "truncated") flushedTruncatedCount++;
            else flushedDroppedCount++;
        }
    }

    return {
        flushedDroppedCount,
        flushedTruncatedCount,
        maxDroppedTagNumber,
        activeCount,
    };
}

// ─────────────────────────────────────────────────────────────────────────
// Path C — P0 + partial indexes (active and dropped)
// ─────────────────────────────────────────────────────────────────────────

function addPartialIndexes(db: DB) {
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_tags_active_session_tag_number
        ON tags(session_id, tag_number)
        WHERE status = 'active';

        CREATE INDEX IF NOT EXISTS idx_tags_dropped_session_tag_number
        ON tags(session_id, tag_number)
        WHERE status = 'dropped';
    `);
    // ANALYZE helps the planner pick the partial index when there's a
    // choice between the existing compound index and the new partial one.
    db.exec("ANALYZE tags;");
}

function dropPartialIndexes(db: DB) {
    db.exec(`
        DROP INDEX IF EXISTS idx_tags_active_session_tag_number;
        DROP INDEX IF EXISTS idx_tags_dropped_session_tag_number;
    `);
    db.exec("ANALYZE tags;");
}

// ─────────────────────────────────────────────────────────────────────────
// Timing harness
// ─────────────────────────────────────────────────────────────────────────

function bench(
    label: string,
    iterations: number,
    fn: () => PathResult,
): { label: string; medianMs: number; meanMs: number; p95Ms: number; result: PathResult } {
    // Warmup
    let warmupResult: PathResult | null = null;
    for (let i = 0; i < WARMUP_ITERS; i++) {
        warmupResult = fn();
    }
    if (!warmupResult) throw new Error("warmup produced no result");

    // Measure
    const times: number[] = new Array(iterations);
    let result: PathResult = warmupResult;
    for (let i = 0; i < iterations; i++) {
        const t0 = performance.now();
        result = fn();
        const t1 = performance.now();
        times[i] = t1 - t0;
    }

    times.sort((a, b) => a - b);
    const mean = times.reduce((s, x) => s + x, 0) / times.length;
    const median = times[Math.floor(times.length / 2)] ?? 0;
    const p95 = times[Math.floor(times.length * 0.95)] ?? 0;

    return { label, medianMs: median, meanMs: mean, p95Ms: p95, result };
}

function fmt(ms: number): string {
    return `${ms.toFixed(2)}ms`.padStart(10);
}

function summarize(
    label: string,
    medianMs: number,
    meanMs: number,
    p95Ms: number,
    baseline?: number,
) {
    const speedup = baseline ? `(${(baseline / medianMs).toFixed(1)}× faster)` : "";
    console.log(
        `  ${label.padEnd(40)} median ${fmt(medianMs)} | mean ${fmt(meanMs)} | p95 ${fmt(p95Ms)}  ${speedup}`,
    );
}

function checkEquivalence(a: PathResult, b: PathResult, label: string) {
    if (a.flushedDroppedCount !== b.flushedDroppedCount) {
        console.warn(
            `  ⚠️  ${label}: flushedDroppedCount mismatch ${a.flushedDroppedCount} vs ${b.flushedDroppedCount}`,
        );
    }
    if (a.flushedTruncatedCount !== b.flushedTruncatedCount) {
        console.warn(
            `  ⚠️  ${label}: flushedTruncatedCount mismatch ${a.flushedTruncatedCount} vs ${b.flushedTruncatedCount}`,
        );
    }
    if (a.maxDroppedTagNumber !== b.maxDroppedTagNumber) {
        console.warn(
            `  ⚠️  ${label}: maxDroppedTagNumber mismatch ${a.maxDroppedTagNumber} vs ${b.maxDroppedTagNumber}`,
        );
    }
    if (a.activeCount !== b.activeCount) {
        console.warn(
            `  ⚠️  ${label}: activeCount mismatch ${a.activeCount} vs ${b.activeCount}`,
        );
    }
}

function explainPlan(db: DB, sql: string, ...params: Array<string | number>) {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
        detail: string;
    }>;
    return plan.map((p) => p.detail).join(" | ");
}

// ─────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────

function main() {
    console.log("══════════════════════════════════════════════════════════════════════");
    console.log("Magic Context P0 storage-helper benchmark");
    console.log("══════════════════════════════════════════════════════════════════════");
    console.log(`Source DB: ${LIVE_DB_PATH}`);
    console.log(`Session:   ${SESSION_ID}`);

    const { db, tempDir, path } = setupTempDb();
    console.log(`Temp DB:   ${path}`);

    try {
        const totalRow = db
            .prepare("SELECT COUNT(*) AS c FROM tags WHERE session_id = ?")
            .get(SESSION_ID) as { c: number };
        const activeRow = db
            .prepare("SELECT COUNT(*) AS c FROM tags WHERE session_id = ? AND status = 'active'")
            .get(SESSION_ID) as { c: number };
        const droppedRow = db
            .prepare("SELECT COUNT(*) AS c FROM tags WHERE session_id = ? AND status = 'dropped'")
            .get(SESSION_ID) as { c: number };
        const compactedRow = db
            .prepare(
                "SELECT COUNT(*) AS c FROM tags WHERE session_id = ? AND status = 'compacted'",
            )
            .get(SESSION_ID) as { c: number };

        console.log("");
        console.log(
            `Tag distribution: total=${totalRow.c}  active=${activeRow.c}  dropped=${droppedRow.c}  compacted=${compactedRow.c}`,
        );

        // Pick a realistic target set: 565 most-recent tags (matches the
        // ~565 transform targets the user observed in the live log).
        const targets = pickRealTargets(db, SESSION_ID, 565);
        const droppedInTargets = [...targets.values()].filter((t) => t.status === "dropped").length;
        const activeInTargets = [...targets.values()].filter((t) => t.status === "active").length;
        console.log(
            `Targets:          ${targets.size} (active=${activeInTargets}, dropped=${droppedInTargets})`,
        );
        console.log(`Iterations:       ${ITERATIONS} (after ${WARMUP_ITERS} warmup)`);
        console.log("");

        // ──────────────────────────────────────────────────────────────
        // Path A — current single-query
        // ──────────────────────────────────────────────────────────────
        console.log("Path A — current `getTagsBySession` (loads ALL tags)");
        const resA = bench("path A: SELECT * + JS filter", ITERATIONS, () =>
            pathA_current(db, SESSION_ID, targets),
        );
        summarize(resA.label, resA.medianMs, resA.meanMs, resA.p95Ms);
        console.log(
            `    plan: ${explainPlan(db, "SELECT * FROM tags WHERE session_id = ? ORDER BY tag_number, id", SESSION_ID)}`,
        );
        console.log("");

        // ──────────────────────────────────────────────────────────────
        // Path B — P0 helpers, no new indexes
        // ──────────────────────────────────────────────────────────────
        console.log("Path B — P0 targeted helpers (existing indexes only)");
        const prepB1 = preparePathB(db);
        const resB1 = bench("path B: 3 helpers, no partial idx", ITERATIONS, () =>
            pathB_targeted(db, prepB1, SESSION_ID, targets),
        );
        checkEquivalence(resA.result, resB1.result, "path A vs path B");
        summarize(resB1.label, resB1.medianMs, resB1.meanMs, resB1.p95Ms, resA.medianMs);
        console.log(
            `    active plan:  ${explainPlan(db, "SELECT * FROM tags WHERE session_id = ? AND status = 'active'", SESSION_ID)}`,
        );
        console.log(
            `    dropped plan: ${explainPlan(db, "SELECT MAX(tag_number) FROM tags WHERE session_id = ? AND status = 'dropped'", SESSION_ID)}`,
        );
        console.log("");

        // ──────────────────────────────────────────────────────────────
        // Path C — P0 helpers + partial indexes
        // ──────────────────────────────────────────────────────────────
        console.log("Path C — P0 targeted helpers + partial indexes");
        addPartialIndexes(db);
        const prepB2 = preparePathB(db); // re-prepare so planner sees new indexes
        const resC = bench("path C: 3 helpers + partial idx", ITERATIONS, () =>
            pathB_targeted(db, prepB2, SESSION_ID, targets),
        );
        checkEquivalence(resA.result, resC.result, "path A vs path C");
        summarize(resC.label, resC.medianMs, resC.meanMs, resC.p95Ms, resA.medianMs);
        console.log(
            `    active plan:  ${explainPlan(db, "SELECT * FROM tags WHERE session_id = ? AND status = 'active'", SESSION_ID)}`,
        );
        console.log(
            `    dropped plan: ${explainPlan(db, "SELECT MAX(tag_number) FROM tags WHERE session_id = ? AND status = 'dropped'", SESSION_ID)}`,
        );
        console.log("");

        // ──────────────────────────────────────────────────────────────
        // Summary
        // ──────────────────────────────────────────────────────────────
        console.log("══════════════════════════════════════════════════════════════════════");
        console.log("Summary (median):");
        console.log(`  current:                  ${fmt(resA.medianMs)}`);
        console.log(
            `  P0 helpers only:          ${fmt(resB1.medianMs)}  (${(resA.medianMs / resB1.medianMs).toFixed(1)}× faster)`,
        );
        console.log(
            `  P0 + partial indexes:     ${fmt(resC.medianMs)}  (${(resA.medianMs / resC.medianMs).toFixed(1)}× faster)`,
        );
        console.log("");
        console.log("Per-pass savings on this session if shipped:");
        console.log(`  ~${(resA.medianMs - resC.medianMs).toFixed(1)}ms per transform pass`);
        console.log("══════════════════════════════════════════════════════════════════════");

        dropPartialIndexes(db);
    } finally {
        db.close();
        rmSync(tempDir, { recursive: true, force: true });
    }
}

main();
