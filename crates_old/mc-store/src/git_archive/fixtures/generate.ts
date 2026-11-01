// Run with Bun from the repository root. Only git-show extracts of this revision
// supply the oracle; the working tree's TypeScript implementation is never loaded.
import { mock } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const revision = "282d9c08bce490346583a3b8c145c402499f980f";
const evidence = resolve(".cortexkit/internal-docs/git-search-evidence");
const prefix = "packages/plugin/src/features/magic-context/";
const files = [
    "git-commits/indexer.ts", "git-commits/git-log-reader.ts",
    "git-commits/storage-git-commits.ts", "git-commits/search-git-commits.ts",
    "git-commits/storage-git-commit-embeddings.ts", "memory/storage-memory-fts.ts",
    "memory/cosine-similarity.ts", "memory/embedding.ts", "memory/storage-memory.ts", "migrations.ts",
].map((path) => prefix + path).concat(
    "packages/plugin/src/shared/sqlite-helpers.ts", "packages/plugin/src/shared/logger.ts",
);
for (const path of files) {
    const output = execFileSync("git", ["show", `${revision}:${path}`]);
    const destination = join(evidence, path);
    mkdirSync(join(destination, ".."), { recursive: true });
    writeFileSync(destination, output);
}

const unexpected = () => { throw Error("unexpected external service or memory search"); };
// Disable logging and the external embedding service, not retrieval/scoring.
mock.module(join(evidence, "packages/plugin/src/shared/logger.ts"), () => ({ log: () => {} }));
mock.module(join(evidence, prefix, "memory/embedding.ts"), () => ({
    getProjectEmbeddingSnapshot: () => null, contentSha256: unexpected,
    embedItemsForProject: unexpected, enqueueShadowEmbeddingItems: unexpected,
}));
// storage-memory-fts imports these for memory search, never the sanitizer.
mock.module(join(evidence, prefix, "memory/storage-memory.ts"), () => ({
    buildWorkspaceMemorySqlFilter: unexpected, getMemorySelectColumns: unexpected,
    isMemoryRow: unexpected, toMemory: unexpected,
}));

const { indexCommitsForProject } = await import(join(evidence, prefix, "git-commits/indexer.ts"));
const { searchGitCommitsSync } = await import(join(evidence, prefix, "git-commits/search-git-commits.ts"));
const { sanitizeFtsQuery } = await import(join(evidence, prefix, "memory/storage-memory-fts.ts"));
const temp = mkdtempSync(join(tmpdir(), "mc-git-search-"));
const repo = join(temp, "repo");
mkdirSync(repo);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
Object.assign(env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C", LANG: "C" });
const now = 1_800_000_000_123;
const day = 86_400_000;
let clock = now;
Date.now = () => clock;
function git(args: string[], at = now): string {
    const stamp = `@${Math.floor(at / 1000)} +0000`;
    return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
        cwd: repo, env: { ...env, GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp },
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }).trim();
}
let sequence = 0;
function commit(message: string, at: number): string {
    const file = `change-${sequence++}.txt`;
    writeFileSync(join(repo, file), message);
    git(["add", "--", file]);
    writeFileSync(join(temp, "message"), message);
    git(["commit", "--allow-empty", "-q", "--cleanup=verbatim", "-F", join(temp, "message")], at);
    return git(["rev-parse", "HEAD"]);
}
const db = new Database(join(temp, "oracle.sqlite"));
db.exec("PRAGMA foreign_keys = ON");
// Execute the pinned migration's git schema, not a copy of the Rust schema.
const migrations = readFileSync(join(evidence, prefix, "migrations.ts"), "utf8");
const schema = migrations.slice(migrations.indexOf("CREATE TABLE IF NOT EXISTS git_commits ("));
db.exec(schema.slice(0, schema.indexOf("`")));
const rows = () => db.prepare("SELECT * FROM git_commits ORDER BY sha").all();
const steps: unknown[] = [];
async function sweep(project: string, cap: number) {
    const head = git(["rev-parse", "HEAD"]);
    const result = await indexCommitsForProject(db, project, repo, { sinceDays: 100, maxCommits: cap, skipEmbed: true });
    steps.push({ project, head, nowMs: clock, maxCommits: cap, sinceDays: 100, rows: rows(), result });
}
try {
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.name", "Search Fixture"]);
    git(["config", "user.email", "search@example.invalid"]);
    git(["config", "core.hooksPath", "/dev/null"]);
    commit("base historical migration", now - 20 * day);
    git(["checkout", "-q", "-b", "feature"]);
    commit("running repair on older feature branch", now - 10 * day);
    git(["checkout", "-q", "main"]);
    commit("main repair tip", now - 8 * day);
    git(["branch", "fixture-before-merge"]);
    await sweep("git:search-fixture", 100);
    git(["merge", "--no-ff", "-q", "-m", "merge-only-marker", "feature"], now - 7 * day);
    await sweep("git:search-fixture", 100);
    commit("original rewritten repair", now - 6 * day);
    git(["branch", "fixture-before-rewrite"]);
    await sweep("git:search-fixture", 100);
    git(["commit", "--amend", "--allow-empty", "-q", "-m", "amended repair implementation"], now - 7 * day);
    await sweep("git:search-fixture", 100);

    const messages = [
        "repair repair repair", "a very verbose repair with many unrelated words padding out its relevance",
        'fix src/git-archive/search.rs path and sanitizeFtsQuery() identifier',
        'quoted "repair" OR NOT NEAR operators stay literal',
        "literal 100% completion x_y and back\\slash C:\\temp\\file", "punctuation ::: !!! ??? ---",
        "Running café CAFÉ naïve unicode 日本語 修正", "exact substring ab+cd and a:b-c identifiers",
        "hash deadbeef 0123456789abcdef reference", "token foo_bar fooBar HTTPServer 123",
        "repair same timestamp first", "repair same timestamp second",
        `long message repair\n\n${"🦀 café running body\n".repeat(3000)}tailneedle`,
    ];
    for (let i = 0; i < 38; i++) commit(`cap eviction obsolete ${i}`, now - 5 * day + i * 1000);
    for (const [i, message] of messages.entries()) commit(message, now - day + Math.min(i, 10) * 1000);
    for (let i = 0; i < 34; i++) commit(`repair filler ${i}`, now + i * 1000);
    await sweep("git:search-fixture", 60);
    git(["branch", "fixture-final"]);
    git(["checkout", "-q", "--orphan", "other-project"]);
    commit("repair repair repair foreign-only-marker ::: 100%", now + day);
    git(["branch", "fixture-other"]);
    await sweep("dir:foreign-project", 100);
    git(["checkout", "-q", "main"]);

    const embeddings = (rows() as any[]).filter((row) => row.project_path === "git:search-fixture").slice(0, 12)
        .map((row, i) => ({ sha: row.sha, vector: i === 0 ? [0, 0, 0] : i === 1 ? [-1, 0, 0]
            : i === 2 ? [1, 0] : i === 3 ? [1, 0, 0] : [0.8, (i % 3) / 3, 0.25], model: i === 4 ? "other-model" : "fixture-model" }));
    const foreign = (rows() as any[]).find((row) => row.project_path === "dir:foreign-project");
    embeddings.push({ sha: foreign.sha, vector: [1, 0, 0], model: "fixture-model" });
    for (const entry of embeddings) db.prepare("INSERT INTO git_commit_embeddings VALUES (?, ?, ?, ?)")
        .run(entry.sha, new Uint8Array(new Float32Array(entry.vector).buffer), entry.model, now);

    const cases: any[] = [];
    function query(name: string, query: string, options: any = {}, project = "git:search-fixture") {
        const f32 = options.queryEmbedding ? new Float32Array(options.queryEmbedding) : undefined;
        let fts: unknown[] = [], vector: unknown[] = [];
        const opts = { limit: 10, ...options, queryEmbedding: f32,
            captureLanes: (a: unknown[], b: unknown[]) => { fts = a; vector = b; } };
        const hits = searchGitCommitsSync(db, project, query, opts);
        cases.push({ name, query, project, options: { limit: 10, ...options }, expected: { hits, fts, vector } });
    }
    for (const q of ["repair", "running", "café", "日本語", "sanitizeFtsQuery", "src/git-archive/search.rs",
        "foo_bar", "fooBar", "HTTPServer", "123", "deadbeef", "0123456789abcdef", "repair repair", '"repair"',
        "repair OR NOT", "NEAR(repair)", "a:b-c", "ab+cd", "100%", "x_y", "back\\slash", "C:\\temp\\file",
        "::: !!!", "???", "---", "no-such-token", "merge-only-marker", "tailneedle", "🦀", "\0repair", "\ufeffrepair\u00a0filler",
        "repair\u0085filler", "repair\u2028filler", " ", "\0", "repair\" OR 1:*"]) query(`lexical:${JSON.stringify(q)}`, q);
    query("bound-project", "foreign-only-marker");
    query("other-project", "foreign-only-marker", {}, "dir:foreign-project");
    query("missing-project", "repair", {}, "git:missing");
    query("full-object-name-not-indexed", git(["rev-parse", "HEAD"]));
    query("short-object-name-not-indexed", git(["rev-parse", "--short=7", "HEAD"]));
    const boundary = Math.floor(now / 1000) * 1000;
    query("date-inclusive-point", "repair", { from: boundary, to: boundary });
    query("date-from", "repair", { from: now + 20_000 });
    query("date-to", "repair", { to: now - day + 5000 });
    query("date-inverted", "repair", { from: now + day, to: now - day });
    query("date-zero", "repair", { from: 0, to: 0 });
    query("fallback-date", "::: !!!", { from: now - day, to: now - day + 5000 });
    for (const limit of [0, 1, 2, 11, 25, 50, 100]) query(`limit-${limit}`, "repair", { limit });
    for (const q of ["repair", "no-such-token", "tailneedle", "::: !!!"]) query(`hybrid:${q}`, q,
        { queryEmbedding: [1, 0, 0], queryModelId: "fixture-model" });
    query("hybrid-date", "repair", { queryEmbedding: [1, 0, 0], queryModelId: "fixture-model", from: now, to: now + 10_000 });
    query("hybrid-weights", "repair", { queryEmbedding: [1, 0, 0], queryModelId: "fixture-model", semanticWeight: 0.2, ftsWeight: 0.8, singleSourcePenalty: 0.5 });
    query("model-off", "repair", { queryEmbedding: [1, 0, 0], queryModelId: "off" });
    query("model-unknown", "repair", { queryEmbedding: [1, 0, 0], queryModelId: "missing-model" });
    query("model-other", "repair", { queryEmbedding: [1, 0, 0], queryModelId: "other-model" });
    query("model-absent", "repair", { queryEmbedding: [1, 0, 0] });
    query("zero-vector", "repair", { queryEmbedding: [0, 0, 0], queryModelId: "fixture-model" });
    query("dimension-mismatch", "repair", { queryEmbedding: [1], queryModelId: "fixture-model" });
    const sanitizers = ["", "  ", "\0", 'a"b OR c:d-*', "repair\0filler", "\ufeffrepair\u00a0filler", "a\u0085b", "a\u2028b"]
        .map((input) => ({ input, expected: sanitizeFtsQuery(input) }));
    const output = resolve("crates/mc-store/src/git_archive/fixtures");
    git(["bundle", "create", join(output, "history.bundle"), "--all"]);
    writeFileSync(join(output, "search.json.gz"), gzipSync(JSON.stringify({ revision, steps, embeddings, cases, sanitizers }), { level: 9 }));
    console.log(`Bun ${Bun.version}: generated ${cases.length} queries, ${steps.length} ingestion sweeps, ${sanitizers.length} sanitizer cases from ${revision}`);
} finally { db.close(); rmSync(temp, { recursive: true, force: true }); }
