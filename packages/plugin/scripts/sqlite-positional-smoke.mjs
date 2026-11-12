// Build with: bun packages/plugin/scripts/sqlite-positional-smoke.mjs <output.mjs>
// Then run the output with the Node binary being checked. It runs against an in-memory database
// it creates itself: it starts no OpenCode or Pi and opens no database file on disk.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import ts from "typescript";

const pluginRoot = resolve(import.meta.dirname, "..");
const searchPath = resolve(pluginRoot, "src/features/magic-context/search.ts");
const output = process.argv[2];
if (!process.versions.bun || !output)
    throw new Error("Build with bun and an output.mjs path, then run that file with Node");

function source(path) {
    return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
}

// The diagnostic and benchmark scripts named below open copies of a real OpenCode or
// Magic Context database when they run. This reads only the SQL text out of their source,
// so none of them runs; the smoke database supplies the tables and bound values.
function auxiliaryQueries() {
    const queries = [];
    for (const [path, bindings] of [
        ["scripts/perf-audit/isolate-dashboard-paths.ts", [["rewrite_fixture"], ["next", "old"]]],
        [
            "scripts/perf-audit/dashboard-sql.ts",
            [["session-a"], ["session-a"], ["session-a"], ["active"]],
        ],
        [
            "scripts/perf-audit/cli-probes.ts",
            [
                ["probe", "/fixture"],
                ["probe", "project"],
            ],
        ],
        [
            "../cli/src/commands/doctor-identity-splits.test.ts",
            [
                ["doctor", "/fixture"],
                ["doctor", "project"],
            ],
        ],
        [
            "src/features/magic-context/message-fts-session-filter.test.ts",
            [
                ["session-a", "session-a", "alpha"],
                ["session-a", "session-a", "alpha"],
            ],
        ],
    ]) {
        const file = source(resolve(pluginRoot, path));
        let index = 0;
        function visit(node) {
            if (
                ts.isCallExpression(node) &&
                ts.isPropertyAccessExpression(node.expression) &&
                ["prepare", "query"].includes(node.expression.name.text)
            ) {
                const sql = node.arguments[0];
                if (
                    sql &&
                    (ts.isStringLiteralLike(sql) || ts.isTemplateExpression(sql)) &&
                    /\?/.test(sql.getText(file)) &&
                    (!path.endsWith("message-fts-session-filter.test.ts") ||
                        /^`EXPLAIN/.test(sql.getText(file))) &&
                    (!path.endsWith("doctor-identity-splits.test.ts") ||
                        /^"INSERT INTO session(?:_projects)? VALUES \(\?/.test(sql.getText(file)))
                ) {
                    if (!bindings[index]) throw new Error(`Unexpected bound query in ${path}`);
                    queries.push(
                        `{ name: ${JSON.stringify(`${path}:${index}`)}, sql: ${sql.getText(file)}, bindings: ${JSON.stringify(bindings[index++])} }`,
                    );
                }
            }
            ts.forEachChild(node, visit);
        }
        visit(file);
        if (index !== bindings.length) throw new Error(`Missing bound query in ${path}`);
    }
    return `[${queries.join(",\n")}]`;
}

// Export private query runners only in the smoke bundle, not in the shipped API.
// Their real constructors, caches and binding lists are bundled without rewriting SQL.
async function buildSmoke() {
    const entry = resolve(dirname(output), "sqlite-positional-smoke-entry.ts");
    mkdirSync(dirname(entry), { recursive: true });
    const benchmark = source(resolve(pluginRoot, "scripts/benchmark-message-fts-session-first.ts"));
    const querySql = benchmark.statements.find(
        (node) => ts.isFunctionDeclaration(node) && node.name?.text === "querySql",
    );
    if (!querySql) throw new Error("Missing benchmark querySql function");
    writeFileSync(
        entry,
        runtime
            .replace(
                "/* auxiliary SQL */",
                `const auxiliary = ${auxiliaryQueries()};\n${querySql.getText(benchmark)}`,
            )
            .replaceAll('"./src/', `"${pluginRoot}/src/`),
    );
    const result = await Bun.build({
        entrypoints: [entry],
        target: "node",
        format: "esm",
        minify: false,
        outdir: dirname(resolve(output)),
        naming: basename(output),
        plugins: [
            {
                name: "sqlite-positional-smoke",
                setup(build) {
                    build.onLoad(
                        { filter: /[/\\]features[/\\]magic-context[/\\]search\.ts$/ },
                        ({ path }) => ({
                            loader: "ts",
                            contents: `${readFileSync(path, "utf8")}\nexport { runMessageFtsQuery, runMessageFtsQueryWithDiagnostics, runMessageFtsQueriesBatch, countSessionFtsMatchesBatch };`,
                        }),
                    );
                },
            },
        ],
    });
    if (!result.success) throw new AggregateError(result.logs, "Smoke bundle failed");
    console.log(`Built ${output} from ${searchPath}`);
}

// A tiny schema keeps the proof independent of migrations, host APIs and live data.
// Two sessions and distinct probe counts catch swapped or reused session bindings.
const runtime = `
import assert from "node:assert/strict";
import { Database } from "./src/shared/sqlite";
import { runMessageFtsQuery, runMessageFtsQueryWithDiagnostics, runMessageFtsQueriesBatch, countSessionFtsMatchesBatch } from "./src/features/magic-context/search";
import { renderSearchArchive } from "./src/tools/ctx-expand/search-archive";
import { getUncoveredCompartmentEndsThrough } from "./src/features/magic-context/compartment-storage";
import { MESSAGE_FTS_SESSION_FILTER_SQL } from "./src/features/magic-context/message-fts-session-filter";

const table = "rewrite_fixture", column = "value";
/* auxiliary SQL */

assert.equal(process.versions.bun, undefined, "Run the built bundle with Node, not Bun");
const db = new Database(":memory:");
let passed = 0;
let failed = 0;
function check(name, run) {
    try { run(); passed++; console.log("PASS " + name); }
    catch (error) { failed++; console.error("FAIL " + name + ": " + error.message); }
}
try {
    db.exec(\`CREATE VIRTUAL TABLE message_history_fts USING fts5(session_id UNINDEXED, message_ordinal UNINDEXED, message_id UNINDEXED, role UNINDEXED, content);
        CREATE TABLE message_fts_rowid_map(session_id TEXT, message_ordinal INTEGER, message_id TEXT, fts_rowid INTEGER, message_time_ms INTEGER);
        CREATE TABLE compartments(session_id TEXT, sequence INTEGER, start_message INTEGER, start_message_id TEXT, start_block_index INTEGER, end_message INTEGER, end_message_id TEXT, end_block_index INTEGER);\`);
    for (const [rowid, session, ordinal, content, time] of [
        [1, "session-a", 1, "alpha beta", 100],
        [2, "session-a", 2, "alpha", 200],
        [3, "session-b", 1, "alpha beta", 100],
    ]) {
        db.prepare("INSERT INTO message_history_fts(rowid, session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, ?, 'user', ?)").run(rowid, session, ordinal, session + ordinal, content);
        db.prepare("INSERT INTO message_fts_rowid_map VALUES (?, ?, ?, ?, ?)").run(session, ordinal, session + ordinal, rowid, time);
    }
    for (const session of ["session-a", "session-b"]) {
        db.prepare("INSERT INTO compartments VALUES (?, 0, 1, 'start', 0, 2, 'end', 1)").run(session);
    }
    for (const sessionFirst of [false, true]) {
        for (const cutoff of [null, 1]) {
            for (const dateRange of [null, { from: 50, to: 150 }]) {
                const shape = JSON.stringify({ sessionFirst, cutoff, dateRange });
                const expected = cutoff !== null || dateRange !== null ? ["session-a1"] : ["session-a1", "session-a2"];
                const ids = rows => rows.map(row => row.messageId).sort();
                check("single " + shape, () => assert.deepEqual(ids(runMessageFtsQuery(db, "session-a", '"alpha"', 10, cutoff, dateRange, sessionFirst)), expected));
                check("batch " + shape, () => {
                    const rows = runMessageFtsQueriesBatch(db, "session-a", ['"alpha"', '"beta"'], 10, cutoff, dateRange, sessionFirst);
                    assert.deepEqual(rows.map(ids), [expected, ["session-a1"]]);
                });
                check("counts " + shape, () => assert.deepEqual(countSessionFtsMatchesBatch(db, "session-a", ['"alpha"', '"beta"'], cutoff, dateRange, sessionFirst), [expected.length, 1]));
            }
        }
        for (const dateRange of [null, { from: 50, to: 150 }]) {
            check("diagnostic " + JSON.stringify({ sessionFirst, dateRange }), () => {
                const result = runMessageFtsQueryWithDiagnostics({ db, sessionId: "session-a", ftsQuery: '"alpha"', fetchLimit: 10, cutoff: 1, dateRange, sessionFirst });
                assert.deepEqual(result.rows.map(row => row.messageId), ["session-a1"]);
                assert.equal(result.suppressedCount, dateRange === null ? 1 : 0);
            });
        }
    }
    check("compartment bounds", () => {
        assert.deepEqual(getUncoveredCompartmentEndsThrough(db, "session-a", 2, 0), [{ endMessageId: "end", endMessage: 2, successorStartMessageId: null, successorStartMessage: null }]);
        assert.deepEqual(getUncoveredCompartmentEndsThrough(db, "session-a", 1, 0), []);
        assert.deepEqual(getUncoveredCompartmentEndsThrough(db, "session-a", 2, 2), []);
    });
    db.exec(\`CREATE TABLE rewrite_fixture(value TEXT);
        INSERT INTO rewrite_fixture VALUES ('old');
        CREATE TABLE session(id TEXT, directory TEXT);
        CREATE TABLE session_projects(session_id TEXT, harness TEXT, project_id TEXT);
        CREATE TABLE message(id TEXT, time_created INTEGER, data TEXT, session_id TEXT);
        CREATE TABLE memories(status TEXT);\`);
    for (const { name, sql, bindings } of auxiliary) {
        check("auxiliary " + name, () => { db.prepare(sql).all(...bindings); });
    }
    for (const filtered of [false, true]) {
        for (const lane of ["auto", "diagnostic"]) {
            check("benchmark " + JSON.stringify({ filtered, lane }), () => {
                const bindings = filtered ? ["session-a", "session-a"] : ["session-a"];
                bindings.push('"alpha"', ...(lane === "auto" ? [10] : [1, 10, 1]));
                const rows = db.prepare(querySql(lane, filtered)).all(...bindings);
                assert.equal(rows.length, lane === "auto" ? 2 : 1);
            });
        }
    }
    check("archive mapped", () => {
        const text = renderSearchArchive(db, "session-a", 1, 1, 1000, true);
        assert.ok(text?.includes("[1] U: alpha beta"));
        assert.ok(!text.includes("[2]"));
    });
    db.prepare("DELETE FROM message_fts_rowid_map WHERE session_id = ?").run("session-a");
    check("archive legacy", () => {
        const text = renderSearchArchive(db, "session-a", 2, 2, 1000, true);
        assert.ok(text?.includes("[2] U: alpha"));
        assert.ok(!text.includes("[1]"));
    });
} finally { db.close(); }
console.log(process.version + ": " + passed + " passed, " + failed + " failed");
if (failed) process.exitCode = 1;
`;

await buildSmoke();
