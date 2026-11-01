import { readFileSync } from "node:fs";
import { Database } from "../../../../packages/plugin/src/shared/sqlite";
import { initializeDatabase } from "../../../../packages/plugin/src/features/magic-context/storage-db";
import { runMigrations } from "../../../../packages/plugin/src/features/magic-context/migrations";
import { indexCommitsForProject } from "../../../../packages/plugin/src/features/magic-context/git-commits/indexer";
import {
    parseGitLogOutput,
    readGitCommitsResult,
    type GitCommit,
    type ReadGitCommitsOptions,
} from "../../../../packages/plugin/src/features/magic-context/git-commits/git-log-reader";
import {
    enforceProjectCap,
    upsertCommits,
} from "../../../../packages/plugin/src/features/magic-context/git-commits/storage-git-commits";

// The Rust fixtures provide disposable repository and SQLite database paths.
// This driver runs the shipped TypeScript producer rather than duplicating its
// traversal or storage rules.
interface Request {
    operation: "index" | "upsert" | "cap" | "read" | "parse";
    database: string;
    directory: string;
    project: string;
    nowMs: number;
    maxCommits: number;
    sinceDays: number;
    commits?: GitCommit[];
    options?: ReadGitCommitsOptions;
    raw?: string;
    sql?: string;
}

const request = JSON.parse(readFileSync(0, "utf8")) as Request;
Date.now = () => request.nowMs;
const db = new Database(request.database);
initializeDatabase(db);
runMigrations(db);
if (request.sql) db.exec(request.sql);
let result: unknown;
try {
    switch (request.operation) {
        case "index":
            result = await indexCommitsForProject(db, request.project, request.directory, {
                sinceDays: request.sinceDays,
                maxCommits: request.maxCommits,
                skipEmbed: true,
            });
            break;
        case "upsert":
            result = upsertCommits(db, request.project, request.commits ?? []);
            break;
        case "cap":
            result = enforceProjectCap(db, request.project, request.maxCommits);
            break;
        case "read":
            result = await readGitCommitsResult(request.directory, request.options);
            break;
        case "parse":
            result = parseGitLogOutput(request.raw ?? "");
            break;
    }
} catch {
    result = { failed: true };
}

db.exec("CREATE VIRTUAL TABLE temp.git_archive_vocab USING fts5vocab(main, git_commits_fts, 'row')");
const snapshot = {
    rows: db.prepare("SELECT * FROM git_commits ORDER BY sha").all(),
    fts: db.prepare("SELECT sha, project_path, message FROM git_commits_fts ORDER BY sha").all(),
    terms: db.prepare("SELECT term, doc, cnt FROM temp.git_archive_vocab ORDER BY term").all(),
};
console.log(`MC_GIT_ORACLE=${JSON.stringify({ result, ...snapshot })}`);
db.close();
