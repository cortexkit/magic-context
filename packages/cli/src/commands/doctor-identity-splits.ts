import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
    IDENTITY_MERGE_COMMAND,
    IDENTITY_MERGE_PREVIEW_HINT,
    identityMergeCommand,
} from "@magic-context/core/features/magic-context/memory/identity-merge-command";
import { directoryFallback } from "@magic-context/core/features/magic-context/memory/project-identity";
import {
    projectDirectoryKey,
    readRememberedGitIdentity,
} from "@magic-context/core/features/magic-context/memory/project-identity-cache";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { resolveOpenCodeDbPath } from "@magic-context/core/shared/opencode-db-path";
import type { Database } from "@magic-context/core/shared/sqlite";
import { openExistingContextDatabase, openExistingDatabase } from "../lib/database-access";

export interface IdentitySplit {
    directory: string;
    identities: Array<{
        identity: string;
        sessions: number;
        memories: number;
        notes: number;
        dreamer: number;
    }>;
}

function tableExists(db: Database, table: string): boolean {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

function hasGitMetadataInAncestors(directory: string): boolean {
    let current = resolve(directory);
    while (true) {
        if (existsSync(join(current, ".git"))) return true;
        const parent = dirname(current);
        if (parent === current) return false;
        current = parent;
    }
}

/**
 * Why a recorded session directory is a leftover rather than a live project, or
 * undefined when it may still be one.
 *
 * A path that no longer exists, or an empty folder with no git metadata in it or above
 * it (what a removed worktree leaves behind), has nothing that resolves to a project:
 * its live resolution is only a freshly computed `dir:` hash that owns no data. Such a
 * path is reported as orphaned, never as an identity split to merge. Filesystem errors
 * other than "missing" (for example permission denied) are not proof of a leftover.
 */
export function orphanedPathReason(directory: string): string | undefined {
    let entries: string[];
    try {
        if (!statSync(directory).isDirectory()) return "path is no longer a directory";
        entries = readdirSync(directory);
    } catch (error) {
        return (error as { code?: unknown }).code === "ENOENT"
            ? "directory no longer exists"
            : undefined;
    }
    if (entries.length > 0 || hasGitMetadataInAncestors(directory)) return undefined;
    return "directory is empty and has no git metadata";
}

/** Probe Git without populating the resolver's durable cache during a preview. */
export function resolveReadOnly(directory: string): string | undefined {
    if (!existsSync(directory)) return undefined;
    try {
        const roots = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], {
            cwd: directory,
            windowsHide: true,
            encoding: "utf8",
            timeout: 5000,
            stdio: ["ignore", "pipe", "pipe"],
        })
            .trim()
            .split(/\s+/)
            .filter((root) => /^[0-9a-f]{40,64}$/.test(root))
            .sort();
        if (roots[0]) return `git:${roots[0]}`;
    } catch {
        /* An unreadable repository is not proof of a directory identity. */
    }
    try {
        const result = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
            cwd: directory,
            windowsHide: true,
            encoding: "utf8",
            timeout: 5000,
            stdio: ["ignore", "pipe", "pipe"],
        });
        if (result.trim() === "true") return undefined;
    } catch (error) {
        if (String((error as { stderr?: unknown }).stderr).includes("not a git repository"))
            return `dir:${createHash("md5").update(projectDirectoryKey(directory)).digest("hex").slice(0, 12)}`;
    }
    return undefined;
}

/** The plugin's persisted git key takes precedence over the result of a live probe. */
export function canonicalIdentity(directory: string, storageDir: string): string | undefined {
    return (
        readRememberedGitIdentity(directory, storageDir) ??
        (orphanedPathReason(directory) ? undefined : resolveReadOnly(directory))
    );
}

/** Report observed bindings and data left behind when a first commit changes the directory identity to git; never merge. */
export function findIdentitySplits(
    db: Database,
    host: Database,
    includeSingles = false,
): IdentitySplit[] {
    if (!tableExists(db, "session_projects")) return [];
    const directories = new Map<string, Set<string>>();
    const directorySpellings = new Map<string, Set<string>>();
    // A host store repeats the same directory on many session rows. Resolve
    // each spelling once per inspection, without retaining filesystem state
    // between doctor invocations.
    const canonicalDirectories = new Map<string, string>();
    const canonicalDirectory = (directory: string): string => {
        const cached = canonicalDirectories.get(directory);
        if (cached !== undefined) return cached;
        let canonical = directory;
        try {
            canonical = realpathSync.native(directory);
        } catch {
            /* Historical paths need not still exist. */
        }
        canonicalDirectories.set(directory, canonical);
        return canonical;
    };
    for (const table of ["session", "session_v2"]) {
        if (!tableExists(host, table)) continue;
        const rows = host
            .prepare(`SELECT id, directory FROM ${table} WHERE directory IS NOT NULL`)
            .all() as Array<{ id: string; directory: string }>;
        for (const row of rows) {
            if (!row.directory) continue;
            const canonical = canonicalDirectory(row.directory);
            const key = `${table === "session" ? "opencode" : "opencode2"}\0${row.id}`;
            const roots = directories.get(key) ?? new Set<string>();
            const directoryKey = projectDirectoryKey(canonical);
            roots.add(directoryKey);
            // Directory identities hash the original spelling, not the normalized grouping key.
            const spellings = directorySpellings.get(directoryKey) ?? new Set<string>();
            spellings.add(row.directory);
            spellings.add(canonical);
            directorySpellings.set(directoryKey, spellings);
            directories.set(key, roots);
        }
    }
    const byDirectory = new Map<string, Set<string>>();
    const bindings = db
        .prepare(
            "SELECT session_id, harness, project_path FROM session_projects WHERE harness IN ('opencode', 'opencode2')",
        )
        .all() as Array<{ session_id: string; harness: string; project_path: string }>;
    for (const row of bindings) {
        if (!/^(git|dir):/.test(row.project_path)) continue;
        for (const directory of directories.get(`${row.harness}\0${row.session_id}`) ?? []) {
            const identities = byDirectory.get(directory) ?? new Set<string>();
            identities.add(row.project_path);
            byDirectory.set(directory, identities);
        }
    }
    const countStatements = new Map<string, ReturnType<Database["prepare"]> | null>();
    const counts = new Map<string, number>();
    const count = (table: string, identity: string): number => {
        const key = `${table}\0${identity}`;
        const cached = counts.get(key);
        if (cached !== undefined) return cached;
        if (!countStatements.has(table)) {
            countStatements.set(
                table,
                tableExists(db, table)
                    ? db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_path = ?`)
                    : null,
            );
        }
        const statement = countStatements.get(table);
        const value = statement ? (statement.get(identity) as { n: number }).n : 0;
        counts.set(key, value);
        return value;
    };
    const gitIdentities = new Map<string, string | undefined>();
    // A first commit can strand directory-scoped data before any git-bound session is recorded.
    for (const [directoryKey, spellings] of directorySpellings) {
        for (const directory of spellings) {
            const dirIdentity = directoryFallback(directory);
            const hasData = [
                "memories",
                "notes",
                "dream_queue",
                "dream_runs",
                "task_schedule_state",
                "retrospective_processed_windows",
            ].some((table) => count(table, dirIdentity) > 0);
            if (!hasData) continue;
            const canonical = canonicalDirectory(directory);
            try {
                // Probe git directly: doctor must not write the identity sidecar or migrate a store.
                if (!gitIdentities.has(canonical)) {
                    const roots = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], {
                        cwd: directory,
                        encoding: "utf8",
                        timeout: 5_000,
                        stdio: ["ignore", "pipe", "pipe"],
                        windowsHide: true,
                    })
                        .trim()
                        .split(/\r?\n/)
                        .filter((root) => /^[0-9a-f]{7,64}$/.test(root))
                        .sort();
                    gitIdentities.set(canonical, roots[0]);
                }
                const root = gitIdentities.get(canonical);
                if (!root) continue;
                const identities = byDirectory.get(directoryKey) ?? new Set<string>();
                identities.add(dirIdentity);
                identities.add(`git:${root}`);
                byDirectory.set(directoryKey, identities);
            } catch {
                // Missing paths, unborn repositories, and transient git failures are not split evidence.
                gitIdentities.set(canonical, undefined);
            }
        }
    }
    return [...byDirectory]
        .filter(([, identities]) => includeSingles || identities.size > 1)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([directory, identities]) => ({
            directory,
            identities: [...identities].sort().map((identity) => ({
                identity,
                sessions: count("session_projects", identity),
                memories: count("memories", identity),
                notes: count("notes", identity),
                dreamer: [
                    "dream_queue",
                    "dream_runs",
                    "task_schedule_state",
                    "retrospective_processed_windows",
                ].reduce((n, table) => n + count(table, identity), 0),
            })),
        }));
}

export function formatIdentitySplits(splits: IdentitySplit[]): string[] {
    return splits.flatMap((split) => {
        const orphaned = orphanedPathReason(split.directory);
        return orphaned
            ? [
                  `Orphaned project path: ${split.directory} (${orphaned}; read-only; no merge performed)`,
                  "  Not an identity split: nothing at this path resolves to a project any more.",
                  ...identityLines(split),
              ]
            : [
                  `Project identity split: ${split.directory} (read-only; no merge performed)`,
                  `  Review with ${IDENTITY_MERGE_COMMAND} before choosing which identity to keep.`,
                  ...identityLines(split),
              ];
    });
}

function identityLines(split: IdentitySplit): string[] {
    return split.identities.map(
        (row) =>
            `  ${row.identity}: ${row.sessions} sessions, ${row.memories} memories, ${row.notes} notes, ${row.dreamer} dreamer rows (identity-wide counts)`,
    );
}

function eventDirectory(data: string, sessionId: string): string | undefined {
    try {
        const event = JSON.parse(data) as {
            sessionID?: unknown;
            location?: { directory?: unknown };
        };
        const directory = event?.location?.directory;
        if (
            event?.sessionID === sessionId &&
            typeof directory === "string" &&
            isAbsolute(directory)
        )
            return directory;
    } catch {
        // An unreadable payload does not prove either end of the move.
    }
}

interface SessionMove {
    id: string;
    directory: string;
    initial: string;
    latest: string;
}

/** The v2 event log may be missing, unpopulated, or from a different host schema. */
function readSessionMoves(host: Database | null): SessionMove[] {
    if (!host || !tableExists(host, "session_v2") || !tableExists(host, "event")) return [];
    try {
        return host
            .prepare(`SELECT s.id, s.directory, c.data AS initial, m.data AS latest
            FROM session_v2 AS s
            JOIN event AS c ON c.aggregate_id = s.id AND c.seq = 0 AND c.type = 'session.created.1'
            JOIN event AS m ON m.aggregate_id = s.id AND m.seq = (
                SELECT MAX(seq) FROM event WHERE aggregate_id = s.id AND type GLOB 'session.moved.*'
            ) AND m.type = 'session.moved.1' AND m.seq > c.seq`)
            .all() as SessionMove[];
    } catch {
        return [];
    }
}

function formatStrandedDirectoryMemories(
    db: Database,
    host: Database | null,
    storageDir: string,
    splits: IdentitySplit[],
): string[] {
    if (!tableExists(db, "memories") || !tableExists(db, "session_projects")) return [];
    const seen = new Set(
        splits.flatMap(({ identities }) => identities.map(({ identity }) => identity)),
    );
    const stranded = (
        db
            .prepare(`SELECT m.project_path AS identity, COUNT(*) AS memories,
            MAX(MAX(m.last_seen_at, COALESCE(m.last_retrieved_at, 0))) AS lastUse
        FROM memories AS m WHERE m.project_path GLOB 'dir:*'
          AND NOT EXISTS (SELECT 1 FROM session_projects AS sp WHERE sp.project_path = m.project_path)
        GROUP BY m.project_path ORDER BY m.project_path`)
            .all() as Array<{
            identity: string;
            memories: number;
            lastUse: number;
        }>
    ).filter(({ identity }) => !seen.has(identity));
    if (stranded.length === 0) return [];
    const keys = new Set(stranded.map(({ identity }) => identity));
    const binding = db.prepare(
        "SELECT project_path FROM session_projects WHERE session_id = ? AND harness = 'opencode2'",
    );
    const canonicalKeys = new Map<string, string | undefined>();
    const sourceFolders = new Map<string, string>();
    const destinations = new Map<string, Set<string | undefined>>();
    for (const row of readSessionMoves(host)) {
        const source = eventDirectory(row.initial, row.id);
        if (!source) continue;
        const from = directoryFallback(source);
        if (!keys.has(from)) continue;
        const latest = eventDirectory(row.latest, row.id);
        if (source === row.directory) continue;
        sourceFolders.set(from, source);
        const current = binding.get(row.id) as { project_path: string } | null;
        if (latest === row.directory && current && !canonicalKeys.has(row.directory)) {
            canonicalKeys.set(row.directory, canonicalIdentity(row.directory, storageDir));
        }
        const resolved = canonicalKeys.get(row.directory);
        const target =
            latest === row.directory && current?.project_path === resolved ? resolved : undefined;
        const choices = destinations.get(from) ?? new Set();
        choices.add(target);
        destinations.set(from, choices);
    }
    return stranded.flatMap(({ identity, memories, lastUse }) => {
        const time = new Date(lastUse);
        const when =
            lastUse > 0 && Number.isFinite(time.getTime()) ? time.toISOString() : "unknown";
        const choices = destinations.get(identity);
        const target = choices?.size === 1 ? [...choices][0] : undefined;
        const from = sourceFolders.get(identity) ?? identity;
        return [
            `Memories left under folder key ${identity}: ${memories} ${memories === 1 ? "memory" : "memories"}; last used ${when}. No session is currently recorded for this key.`,
            target
                ? "  Review a merge into the session's current project:"
                : "  The destination can't be determined. If you choose one, replace DESTINATION_IDENTITY in:",
            `  ${identityMergeCommand(from, target)}`,
            `  ${IDENTITY_MERGE_PREVIEW_HINT}`,
        ];
    });
}

export function diagnoseIdentitySplits(): string[] {
    const storageDir = getMagicContextStorageDir();
    const db = openExistingContextDatabase(join(storageDir, "context.db"), {
        readonly: true,
    });
    if (!db) return [];
    let host: Database | null = null;
    try {
        host = openExistingDatabase(resolveOpenCodeDbPath().path, { readonly: true });
        const splits = host ? findIdentitySplits(db, host) : [];
        return [
            ...(host
                ? formatIdentitySplits(splits)
                : ["Identity split check skipped: OpenCode session directories unavailable."]),
            ...formatStrandedDirectoryMemories(db, host, storageDir, splits),
        ];
    } finally {
        host?.close();
        db.close();
    }
}
