// Reroot only filesystem pointers in a finished store COPY. Message bodies,
// identities and counts stay intact; native project/config discovery then
// cannot wander into the original recorded directories.
// timeout 180 bun .../isolate-dashboard-paths.ts <throwaway-root>
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("throwaway root required");
const marker = join(root, "paths-isolated");
if (existsSync(marker)) throw new Error("snapshot paths already isolated");
const path = join(root, "data/opencode/opencode.db");
if ((statSync(path).mode & 0o222) !== 0) throw new Error("snapshot is not finished/read-only");
chmodSync(path, 0o644);
const db = new Database(path);
const directories = new Map<string, string>();
const reroot = (original: string) => {
    let directory = directories.get(original);
    if (directory) return directory;
    directory = join(root, "recorded-directories", createHash("sha256").update(original).digest("hex").slice(0, 12), basename(original) || "root");
    mkdirSync(directory, { recursive: true });
    // Recorded background worktrees should not outrank main checkout labels.
    if (!basename(original).startsWith("bg_")) mkdirSync(join(directory, ".git"), { recursive: true });
    directories.set(original, directory);
    return directory;
};
try {
    const credentials = db.query("SELECT name FROM sqlite_master WHERE name IN ('credential','account','account_state','control_account')").all();
    if (credentials.length) throw new Error("snapshot credentials have not been scrubbed");
    db.exec("BEGIN");
    for (const [table, column] of [["session", "directory"], ["session_v2", "directory"], ["project", "worktree"]]) {
        if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
        const rows = db.query<{ value: string }, []>(`SELECT DISTINCT ${column} value FROM ${table} WHERE ${column} IS NOT NULL AND ${column} != ''`).all();
        const update = db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${column}=?`);
        for (const row of rows) update.run(reroot(row.value), row.value);
    }
    db.exec("COMMIT");
    writeFileSync(marker, String(directories.size));
    console.log(`Bun ${Bun.version}; rerooted ${directories.size} recorded directory pointers in snapshot only`);
} finally {
    db.close(); chmodSync(path, 0o444);
}
