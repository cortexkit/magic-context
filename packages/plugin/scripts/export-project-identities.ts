#!/usr/bin/env bun
/**
 * Export the project-identity inventory as a ck-projects seed_import corpus.
 *
 * One JSONL line per identity:
 *   {"identity": "git:<sha>"|"dir:<md5-12>", "roots": [...], "sources": {"session_bindings": n, "memory_rows": n}}
 *
 * The dump is deliberately UNCLEANED: dir:-transient aliases (git-cooldown
 * fallbacks for roots that also carry a git: identity) and dead worktree roots
 * stay in, because the registry's seed importer wants real topology to exercise
 * its identity_split / alias_occupied merge arms and the seeds-only
 * skip-with-provenance path for missing roots. "sources" is report provenance
 * only; it never enters the registry's hash contract.
 *
 * Usage: bun packages/plugin/scripts/export-project-identities.ts [out.jsonl]
 * Reads the live context.db (identities) and opencode.db (session directories)
 * read-only; writes to stdout when no path is given.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getMagicContextStorageDir } from "../src/shared/data-path";

const canonicalHome = realpathSync.native(homedir());
const homeIdentity = `dir:${createHash("md5").update(canonicalHome, "utf8").digest("hex").slice(0, 12)}`;

function isCanonicalHomeRoot(root: string): boolean {
    try {
        return realpathSync.native(resolve(root)) === canonicalHome;
    } catch {
        return false;
    }
}

const dbPath = process.env.MAGIC_CONTEXT_DB ?? join(getMagicContextStorageDir(), "context.db");
// Plain path + options object, not a file: URI — bun:sqlite on Linux rejects
// file: URIs (the CLI database-access fix established this pattern).
const db = new Database(dbPath, { readonly: true });
const openCodePath =
    process.env.OPENCODE_DB ?? join(homedir(), ".local", "share", "opencode", "opencode.db");
const opencodeDb = new Database(openCodePath, { readonly: true });

interface Row {
    identity: string;
    root: string | null;
    source: "session_bindings" | "memory_rows";
}

const rows: Row[] = [];

// session_projects binds session -> identity; the session's working directory
// (the observed root) lives in the harness store. Join across the two DBs
// in-process: identity map from context.db, directories from opencode.db.
const directoryBySession = new Map<string, string>();
for (const r of opencodeDb
    .prepare("SELECT id, directory FROM session WHERE directory IS NOT NULL")
    .all() as Array<{ id: string; directory: string }>) {
    directoryBySession.set(r.id, r.directory);
}
for (const r of db
    .prepare("SELECT session_id, project_path AS identity FROM session_projects")
    .all() as Array<{ session_id: string; identity: string }>) {
    const root = directoryBySession.get(r.session_id) ?? null;
    // A home identity is valid for an explicitly opted-in session, but must
    // never seed the fleet registry: its root would otherwise contain every
    // unrelated directory below $HOME.
    if (r.identity === homeIdentity || (root !== null && isCanonicalHomeRoot(root))) continue;
    rows.push({
        identity: r.identity,
        root,
        source: "session_bindings",
    });
}

// Memory rows carry the identity only; they contribute source counts (and can
// surface identities that never got a session binding, e.g. imported pools).
for (const r of db
    .prepare(
        "SELECT DISTINCT project_path AS identity FROM memories WHERE project_path LIKE 'git:%' OR project_path LIKE 'dir:%'",
    )
    .all() as Array<{ identity: string }>) {
    // Memory-only rows have no harness root to inspect, so recognize the same
    // canonical-home dir: identity directly.
    if (r.identity === homeIdentity) continue;
    rows.push({ identity: r.identity, root: null, source: "memory_rows" });
}

const byIdentity = new Map<string, { roots: Set<string>; session_bindings: number; memory_rows: number }>();
for (const row of rows) {
    let entry = byIdentity.get(row.identity);
    if (!entry) {
        entry = { roots: new Set(), session_bindings: 0, memory_rows: 0 };
        byIdentity.set(row.identity, entry);
    }
    if (row.root) entry.roots.add(row.root);
    entry[row.source] += 1;
}

const memoryCounts = new Map<string, number>();
for (const r of db
    .prepare(
        "SELECT project_path AS identity, COUNT(*) AS n FROM memories WHERE project_path LIKE 'git:%' OR project_path LIKE 'dir:%' GROUP BY project_path",
    )
    .all() as Array<{ identity: string; n: number }>) {
    memoryCounts.set(r.identity, r.n);
}

const lines: string[] = [];
for (const [identity, entry] of [...byIdentity.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(
        JSON.stringify({
            identity,
            roots: [...entry.roots].sort(),
            sources: {
                session_bindings: entry.session_bindings,
                memory_rows: memoryCounts.get(identity) ?? 0,
            },
        }),
    );
}

const out = lines.join("\n") + "\n";
const target = process.argv[2];
if (target) {
    await Bun.write(target, out);
    console.error(`wrote ${lines.length} identities to ${target}`);
} else {
    process.stdout.write(out);
}
