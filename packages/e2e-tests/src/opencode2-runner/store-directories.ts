import { openTestDb } from "../test-db";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const columns = [
    ["session", "directory"],
    ["project", "worktree"],
    ["project", "directory"],
    ["session_projects", "project_path"],
] as const;

function canonical(path: string): string {
    if (existsSync(path)) return realpathSync(path);
    const parent = dirname(path);
    return parent === path ? path : join(canonical(parent), path.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
}

function inside(path: string, root: string): boolean {
    const rel = relative(root, canonical(resolve(path)));
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Normalize path-bearing rows before a copied database is ever opened by a host. */
export function isolateStoreDirectories(root: string, openCodeDb: string, contextDb: string): string[] {
    const base = realpathSync(root);
    const references = new Set<string>();
    for (const [path, fields] of [[openCodeDb, columns.slice(0, 3)], [contextDb, columns.slice(3)]] as const) {
        if (!existsSync(path)) continue;
        if (!inside(path, base)) throw new Error(`E2E_STORE_OUTSIDE_ROOT: ${path}`);
        const db = openTestDb(path);
        try {
            const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(row => row.name));
            const rewrite = db.transaction(() => {
                for (const [table, column] of fields) {
                    if (!tables.has(table)) continue;
                    const available = new Set((db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name));
                    if (!available.has(column)) continue;
                    const rows = db.query(`SELECT DISTINCT ${column} AS path FROM ${table} WHERE ${column} IS NOT NULL`).all() as { path: string }[];
                    for (const { path: value } of rows) {
                        if (!value || (value.startsWith("git:") || value.startsWith("dir:"))) continue;
                        if (!isAbsolute(value)) throw new Error(`E2E_STORE_DIRECTORY_OUTSIDE_ROOT: ${table}.${column}=${value}`);
                        if (inside(value, base)) continue;
                        // OpenCode uses '/' as a synthetic global project; scanning the whole filesystem is not a repo fence.
                        if (resolve(value) !== "/") references.add(value);
                        const safe = join(base, "replayed-projects", createHash("sha256").update(value).digest("hex"));
                        mkdirSync(safe, { recursive: true });
                        db.query(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(safe, value);
                    }
                    for (const { path: value } of db.query(`SELECT DISTINCT ${column} AS path FROM ${table} WHERE ${column} IS NOT NULL`).all() as { path: string }[]) {
                        if (value && !(value.startsWith("git:") || value.startsWith("dir:")) && (!isAbsolute(value) || !inside(value, base))) {
                            throw new Error(`E2E_STORE_DIRECTORY_OUTSIDE_ROOT: ${table}.${column}=${value}`);
                        }
                    }
                }
            });
            rewrite();
        } finally {
            db.close();
        }
    }
    return [...references];
}
