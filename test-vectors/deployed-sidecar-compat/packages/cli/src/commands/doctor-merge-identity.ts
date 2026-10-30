import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveProjectIdentityStrict } from "@magic-context/core/features/magic-context/memory/project-identity";
import {
    projectDirectoryKey,
    readRememberedGitIdentity,
} from "@magic-context/core/features/magic-context/memory/project-identity-cache";
import {
    auditIdentityMerge,
    countIdentityRows,
    type IdentityMergeReport,
    mergeProjectIdentities,
} from "@magic-context/core/features/magic-context/storage-identity-merge";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { resolveOpenCodeDbPath } from "@magic-context/core/shared/opencode-db-path";
import type { Database } from "@magic-context/core/shared/sqlite";
import { configureContextDatabasePragmas } from "@magic-context/core/shared/sqlite-context-pragmas";
import {
    ensureStorageDirectorySync,
    writeStorageFileAtomicSync,
} from "@magic-context/core/shared/storage-permissions";
import {
    CLI_SCHEMA_FLOOR_VERSION,
    openExistingContextDatabase,
    openExistingDatabase,
} from "../lib/database-access";
import { availableDiskBytes, checkDiskSpace, existingDirectoryAncestor } from "../lib/disk-space";
import {
    findIdentitySplits,
    type IdentitySplit,
    orphanedPathReason,
} from "./doctor-identity-splits";
import { probeHostProcessesUsing } from "./doctor-opencode2-cache";
import {
    copyDatabaseBundle,
    type DatabaseHolderInspection,
    databaseBundleSizeBytes,
    defaultInspectHolders,
} from "./doctor-repair-db";

export interface MergeIdentityCliOptions {
    from?: string;
    to?: string;
    dryRun: boolean;
    yes: boolean;
    force: boolean;
    verbose: boolean;
    dbPath?: string;
    hostPath?: string;
    backupRoot?: string;
}

export function parseMergeIdentityArgs(args: string[]): MergeIdentityCliOptions {
    const values: Record<string, string> = {};
    const switches = new Set(["--apply", "--force", "--dry-run", "--yes", "--verbose"]);
    for (let i = 0; i < args.length; i++) {
        const flag = args[i];
        if (["--from", "--to", "--db", "--host-db", "--backup-root"].includes(flag)) {
            const value = args[++i];
            if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
            if (values[flag]) throw new Error(`Repeated option: ${flag}`);
            values[flag] = value;
        } else if (!switches.has(flag))
            throw new Error(`Unknown doctor merge-identities option: ${flag}`);
    }
    if (Boolean(values["--from"]) !== Boolean(values["--to"]))
        throw new Error("Supply both --from and --to");
    const apply = args.includes("--apply") || args.includes("--yes");
    if (apply && (!values["--from"] || args.includes("--dry-run")))
        throw new Error("--apply requires --from/--to and cannot be combined with --dry-run");
    return {
        from: values["--from"],
        to: values["--to"],
        dbPath: values["--db"],
        hostPath: values["--host-db"],
        backupRoot: values["--backup-root"],
        dryRun: !apply,
        yes: apply,
        force: args.includes("--force"),
        verbose: args.includes("--verbose"),
    };
}

function printReport(report: IdentityMergeReport): void {
    console.log(
        `Identity merge ${report.dryRun ? "preview" : "complete"}: ${report.fromIdentity} → ${report.toIdentity}`,
    );
    for (const table of report.auditedTables) {
        console.log(
            `  ${table.tableName}: ${report.dryRun ? table.sourceRows : table.changedRows} row(s)${table.derived ? " (derived; maintained by triggers)" : ""}`,
        );
    }
    for (const change of report.changes) console.log(`  ${change}`);
    console.log(
        `  identical memories collapsed: ${report.duplicateMemoryIds.join(", ") || "none"}`,
    );
    console.log(
        `  potential content conflicts kept for review (same category): ${report.reviewMemoryIds.join(", ") || "none"}`,
    );
    console.log(
        "  Workspace aliases collapse; source-only membership transfers. Target schedules win; next_due_at is recomputed. Queued reasons deduplicate; run history and processed windows remain.",
    );
    console.log(
        "  Git indexes move; sweep leases reset for rebuilding. Existing memory embeddings remain valid (content unchanged); FTS triggers rekey indexes.",
    );
    if (!report.changedRows) console.log("  No-op: no source rows remain to move.");
    if (report.dryRun)
        console.log("  No writes. Review this preview, then repeat with --apply to confirm.");
}

/** Probe Git without populating the resolver's durable cache during a preview. */
function resolveReadOnly(directory: string): string | undefined {
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

/**
 * The identity a directory belongs to. The identity the plugin persisted for the path
 * (its `project-identities` sidecar) wins over a live probe: a live probe of a folder
 * that lost its git metadata yields a fresh `dir:` hash, while the plugin keeps using
 * the persisted `git:` identity there. A leftover path has no live resolution at all.
 */
function canonicalIdentity(directory: string, storageDir: string): string | undefined {
    return (
        readRememberedGitIdentity(directory, storageDir) ??
        (orphanedPathReason(directory) ? undefined : resolveReadOnly(directory))
    );
}

interface PersistedIdentityAllowance {
    directory: string;
    reason: string;
    liveIdentity?: string;
}

function directoryDoesNotExist(directory: string): boolean {
    try {
        statSync(directory);
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
    return false;
}

/**
 * Refuse a merge that would move data the wrong way. Runs for the preview and again on
 * the writable handle immediately before `--apply` writes, and `--force` does not
 * bypass it.
 */
function assertMergePairSafe(
    db: Database,
    observed: IdentitySplit[],
    storageDir: string,
    from: string,
    to: string,
): PersistedIdentityAllowance[] {
    const allowances: PersistedIdentityAllowance[] = [];
    // Every checkout and worktree of a repository shares its git: identity, so folding
    // it into one directory's identity would take the whole repository's pool with it.
    if (from.startsWith("git:") && !to.startsWith("git:"))
        throw new Error(
            `Refusing merge: ${from} is a repository-wide identity shared by every checkout and worktree of its repository. It can only be a merge target, never merged into the directory identity ${to}.`,
        );
    const sourceRows = countIdentityRows(db, from);
    if (sourceRows > 0 && countIdentityRows(db, to) === 0)
        throw new Error(
            `Refusing merge: target ${to} owns no rows while ${from} owns ${sourceRows}. Nothing uses ${to}, so moving data into it would strand that data.`,
        );
    for (const row of observed) {
        const involved = row.identities.filter(
            (item) => item.identity === from || item.identity === to,
        );
        if (!involved.length) continue;
        const persisted = readRememberedGitIdentity(row.directory, storageDir);
        if (!persisted) continue;
        if (persisted === from) {
            let live: string | undefined;
            const orphaned = directoryDoesNotExist(row.directory);
            if (!orphaned) {
                try {
                    live = resolveProjectIdentityStrict(row.directory, undefined, { cache: false });
                } catch {
                    // A failed probe is not evidence that a persisted identity is stale.
                }
            }
            if (orphaned || live === to) {
                allowances.push({
                    directory: row.directory,
                    reason: orphaned ? "orphaned" : `live root now resolves to ${to}`,
                    liveIdentity: live,
                });
                continue;
            }
            throw new Error(
                `Refusing merge: ${from} is the identity the plugin persisted for ${row.directory}; merging away from it would contradict the plugin's own resolution of that path.`,
            );
        }
        if (persisted !== to)
            throw new Error(
                `Refusing merge: the plugin persisted ${persisted} for ${row.directory}, where ${involved.map((item) => item.identity).join(" and ")} was observed. That persisted identity is canonical for the path; merge into ${persisted} instead of ${to}.`,
            );
    }
    return allowances;
}

function assertMergeDirectoriesSafe(
    db: Database,
    from: string,
    to: string,
    sourceDirs: string[],
    targetDirs: string[],
    allowances: PersistedIdentityAllowance[],
): string[] {
    const alreadyMerged =
        auditIdentityMerge(db, from, to).changedRows === 0 &&
        db
            .prepare(
                "SELECT 1 FROM v22_identity_rekey_map WHERE old_project_path = ? AND new_project_path = ?",
            )
            .get(from, to);
    const allowedDirs = new Set(allowances.map((item) => item.directory));
    const missingSourceDirs = sourceDirs.filter(
        (directory) => !targetDirs.includes(directory) && directoryDoesNotExist(directory),
    );
    for (const directory of missingSourceDirs) allowedDirs.add(directory);
    // A changed root can leave old sessions in one checkout and new sessions in others.
    // A missing source folder has no live identity that could contradict the merge.
    const sourceDirsAllowed =
        allowedDirs.size > 0 &&
        sourceDirs.every(
            (directory) => targetDirs.includes(directory) || allowedDirs.has(directory),
        );
    if (
        !alreadyMerged &&
        from.startsWith("git:") &&
        to.startsWith("git:") &&
        (!sourceDirs.length ||
            !targetDirs.length ||
            (!sourceDirsAllowed &&
                (sourceDirs.some((dir) => !targetDirs.includes(dir)) ||
                    targetDirs.some((dir) => !sourceDirs.includes(dir)))))
    )
        throw new Error(
            `Refusing different directories for ${from} (${sourceDirs.join(", ") || "unknown"}) and ${to} (${targetDirs.join(", ") || "unknown"})`,
        );
    return missingSourceDirs;
}

function printSidecarPreview(
    allowances: PersistedIdentityAllowance[],
    missingSourceDirs: string[],
    to: string,
    verbose: boolean,
): void {
    const missing = new Set(missingSourceDirs);
    const orphanPins = allowances.filter((item) => missing.has(item.directory));
    if (missingSourceDirs.length) {
        console.log(
            `  ${missingSourceDirs.length} source-only folders no longer exist: allowed${orphanPins.length ? ` (${orphanPins.length} orphaned sidecar(s) will be rewritten to ${to})` : ""}.${verbose ? "" : " Use --verbose for the full list."}`,
        );
        if (verbose)
            for (const directory of missingSourceDirs)
                if (!orphanPins.some((item) => item.directory === directory))
                    console.log(`    ${directory} (orphaned; no persisted sidecar)`);
    }
    for (const item of allowances)
        if (verbose || !missing.has(item.directory))
            console.log(
                `  Sidecar for ${item.directory}: overwrite with ${to} (${item.reason}; sidecar will be rewritten).`,
            );
}

/** Print one observed directory's suggestion, applying the same rules as an explicit merge. */
function printSuggestion(db: Database, split: IdentitySplit, storageDir: string): void {
    const rows = new Map(
        split.identities.map((row) => [row.identity, countIdentityRows(db, row.identity)]),
    );
    const orphaned = orphanedPathReason(split.directory);
    const persisted = readRememberedGitIdentity(split.directory, storageDir);
    if (orphaned) {
        console.log(`Orphaned project path: ${split.directory} (${orphaned})`);
        console.log("  Not an identity split; no merge proposed.");
        if (persisted) console.log(`  Identity the plugin persisted for this path: ${persisted}`);
        for (const [identity, count] of rows) console.log(`  ${identity}: ${count} row(s)`);
        return;
    }
    console.log(`Project identity split: ${split.directory}`);
    const live = resolveReadOnly(split.directory);
    if (persisted && live && persisted !== live)
        console.log(
            `  Live resolution ${live} disagrees with the identity the plugin persisted for this path, ${persisted}; the persisted identity is canonical.`,
        );
    const target =
        persisted ??
        live ??
        split.identities
            .map((row) => row.identity)
            .filter((id) => id.startsWith("git:"))
            .sort()[0];
    if (!target) {
        console.log("  Unresolved target; no merge proposed.");
        return;
    }
    const sources = split.identities
        .map((row) => row.identity)
        .filter((identity) => identity !== target);
    for (const identity of sources.filter((id) => id.startsWith("git:")))
        console.log(
            `  ${identity}: repository-wide identity shared by every checkout of its repository (${rows.get(identity) ?? 0} row(s)); never proposed as a source for one directory.`,
        );
    const targetRows = rows.get(target) ?? countIdentityRows(db, target);
    if (targetRows === 0 && sources.some((identity) => (rows.get(identity) ?? 0) > 0)) {
        console.log(
            `  Target ${target} owns no rows; no merge proposed into it. Open a session in this directory so it records data under its identity, then rerun.`,
        );
        return;
    }
    for (const identity of sources.filter((id) => !id.startsWith("git:")))
        console.log(`  ${identity} → ${target}`);
}

export function observations(
    db: Database,
    hostPath: string | null,
    storageDir: string,
): IdentitySplit[] {
    const host = hostPath ? openExistingDatabase(hostPath, { readonly: true }) : null;
    let rows: IdentitySplit[] = [];
    try {
        rows = host ? findIdentitySplits(db, host, true) : [];
    } finally {
        host?.close();
    }
    const add = (directory: string, identity: string) => {
        if (!/^(git|dir):/.test(identity)) return;
        directory = projectDirectoryKey(directory);
        let row = rows.find((item) => item.directory === directory);
        if (!row) {
            row = { directory, identities: [] };
            rows.push(row);
        }
        if (!row.identities.some((item) => item.identity === identity))
            row.identities.push({ identity, sessions: 0, memories: 0, notes: 0, dreamer: 0 });
    };
    const sidecars = join(storageDir, "project-identities");
    if (existsSync(sidecars))
        for (const file of readdirSync(sidecars)) {
            if (!file.endsWith(".json")) continue;
            try {
                const record = JSON.parse(readFileSync(join(sidecars, file), "utf8"));
                if (typeof record.directory === "string" && typeof record.identity === "string")
                    add(record.directory, record.identity);
            } catch {
                /* Corrupt sidecars cannot establish an identity's directory. */
            }
        }
    for (const row of db
        .prepare("SELECT project_path, display_path FROM workspace_members")
        .all() as Array<{ project_path: string; display_path: string }>)
        add(row.display_path, row.project_path);
    return rows;
}

export interface MergeIdentityDeps {
    inspectHolders: (storageDir: string) => DatabaseHolderInspection;
    probe: typeof probeHostProcessesUsing;
    freeBytes: (path: string) => number;
}

export function runMergeIdentityCli(args: string[], deps: Partial<MergeIdentityDeps> = {}): number {
    const options = parseMergeIdentityArgs(args);
    const dbPath = options.dbPath ?? join(getMagicContextStorageDir(), "context.db");
    const storageDir = dirname(dbPath);
    const hostPath =
        options.hostPath ??
        (options.dbPath ? join(storageDir, "host.db") : resolveOpenCodeDbPath().path);
    let db = openExistingContextDatabase(dbPath, {
        readonly: true,
        minimumSupportedVersion: CLI_SCHEMA_FLOOR_VERSION,
    });
    if (!db) throw new Error(`Context database does not exist: ${dbPath}`);
    let directories: string[] = [];
    let observed: IdentitySplit[] = [];
    try {
        observed = observations(db, hostPath, storageDir);
        if (!options.from || !options.to) {
            for (const split of observed.filter((row) => row.identities.length > 1))
                printSuggestion(db, split, storageDir);
            if (!observed.some((row) => row.identities.length > 1))
                console.log("No detected identity splits.");
            return 0;
        }
        if (options.from === options.to)
            throw new Error(`Source and target identities must differ: ${options.from}`);
        const allowances = assertMergePairSafe(db, observed, storageDir, options.from, options.to);
        for (const identity of [options.from, options.to]) {
            const known =
                auditIdentityMerge(db, identity, options.to).changedRows > 0 ||
                db
                    .prepare(
                        "SELECT 1 FROM v22_identity_rekey_map WHERE old_project_path = ? OR new_project_path = ?",
                    )
                    .get(identity, identity);
            if (!known) throw new Error(`Unknown identity: ${identity}`);
        }
        const sourceDirs = observed
            .filter((row) => row.identities.some((item) => item.identity === options.from))
            .map((row) => row.directory);
        const targetDirs = observed
            .filter((row) => row.identities.some((item) => item.identity === options.to))
            .map((row) => row.directory);
        directories = [...new Set([...sourceDirs, ...targetDirs])];
        const missingSourceDirs = assertMergeDirectoriesSafe(
            db,
            options.from,
            options.to,
            sourceDirs,
            targetDirs,
            allowances,
        );
        if (
            !options.force &&
            !directories.some(
                (directory) =>
                    canonicalIdentity(directory, storageDir) === options.to ||
                    allowances.some(
                        (item) => item.directory === directory && item.liveIdentity === options.to,
                    ),
            )
        )
            throw new Error(
                `Target ${options.to} does not resolve for any observed directory on this machine; use --force only after reviewing the identity.`,
            );
        const preview = mergeProjectIdentities(db, options.from, options.to, { dryRun: true });
        printSidecarPreview(allowances, missingSourceDirs, options.to, options.verbose);
        printReport(preview);
        if (options.dryRun) return 0;
    } finally {
        db.close();
    }
    const { from, to } = options;
    if (!from || !to) return 0;
    console.log(
        "Checking database holders (bounded process inspection; no changes applied yet)...",
    );
    const holders = (deps.inspectHolders ?? defaultInspectHolders)(storageDir);
    const probe = (deps.probe ?? probeHostProcessesUsing)({
        files: [dbPath, `${dbPath}-wal`, `${dbPath}-shm`],
        directories: [],
    });
    if (!holders.safe || probe.status !== "free")
        throw new Error(
            `Refusing merge: close OpenCode, Pi, OpenCode 2 and ck-mc. ${holders.blockers.join(", ")} ${holders.uncertainty ?? ""} ${probe.status === "in_use" ? `context.db holders: ${probe.pids.join(", ")}` : probe.status === "unknown" ? probe.reason : ""}`,
        );
    const backupRoot = resolve(options.backupRoot ?? storageDir);
    const backupVolume = existingDirectoryAncestor(backupRoot);
    const sidecarRoot = join(storageDir, "project-identities");
    const sidecarEntries = existsSync(sidecarRoot)
        ? readdirSync(sidecarRoot).filter((entry) => entry.endsWith(".json"))
        : [];
    const sidecarBytes = sidecarEntries.reduce(
        (size, entry) => size + statSync(join(sidecarRoot, entry)).size,
        0,
    );
    const diskSpace = checkDiskSpace(
        backupVolume,
        databaseBundleSizeBytes(dbPath) + sidecarBytes,
        deps.freeBytes ?? availableDiskBytes,
    );
    if (!diskSpace.sufficient)
        throw new Error(
            `merge_identity_disk_space: refusing identity merge: backup needs ${diskSpace.requiredBytes} bytes; have ${diskSpace.availableBytes} bytes on ${backupVolume}. Use --backup-root <dir> to choose a volume with enough free space.`,
        );
    ensureStorageDirectorySync(backupRoot, true);
    const backup = mkdtempSync(join(backupRoot, "identity-merge-backup-"));
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    console.log(`Backup directory: ${backup}`);
    console.log(
        `Restore with hosts closed: rm -f ${quote(`${dbPath}-wal`)} ${quote(`${dbPath}-shm`)}; cp ${quote(join(backup, "context.db"))} ${quote(dbPath)}; if test -f ${quote(join(backup, "context.db-wal"))}; then cp ${quote(join(backup, "context.db-wal"))} ${quote(`${dbPath}-wal`)}; fi`,
    );
    const sidecarBackup = join(backup, "project-identities");
    ensureStorageDirectorySync(sidecarBackup, true);
    let backupBytes = 0;
    for (const entry of sidecarEntries) {
        const content = readFileSync(join(sidecarRoot, entry));
        writeStorageFileAtomicSync(join(sidecarBackup, entry), content, true);
        backupBytes += content.byteLength;
    }
    console.log(
        `Restore identity sidecars too: rm -rf ${quote(sidecarRoot)}; cp -R ${quote(sidecarBackup)} ${quote(sidecarRoot)}`,
    );
    const copiedDatabaseFiles = copyDatabaseBundle(dbPath, join(backup, "context.db"), true);
    backupBytes += copiedDatabaseFiles.reduce((size, path) => size + statSync(path).size, 0);
    // The read-only open already checked the schema version. Use the raw writable opener
    // because the context opener may create store metadata before the merge transaction.
    db = openExistingDatabase(dbPath, { readonly: false });
    if (!db) throw new Error(`Context database disappeared: ${dbPath}`);
    try {
        // Rows may have moved since the read-only preview; check the pair again on the
        // handle that is about to write.
        configureContextDatabasePragmas(db);
        observed = observations(db, hostPath, storageDir);
        const allowances = assertMergePairSafe(db, observed, storageDir, from, to);
        const sourceDirs = observed
            .filter((row) => row.identities.some((item) => item.identity === from))
            .map((row) => row.directory);
        const targetDirs = observed
            .filter((row) => row.identities.some((item) => item.identity === to))
            .map((row) => row.directory);
        assertMergeDirectoriesSafe(db, from, to, sourceDirs, targetDirs, allowances);
        directories = [...new Set([...sourceDirs, ...targetDirs])];
        printReport(mergeProjectIdentities(db, from, to));
    } finally {
        db.close();
    }
    if (to.startsWith("git:"))
        for (const directory of directories) {
            const root = join(storageDir, "project-identities");
            ensureStorageDirectorySync(root);
            const path = join(
                root,
                `${createHash("sha256").update(projectDirectoryKey(directory)).digest("hex")}.json`,
            );
            writeStorageFileAtomicSync(
                path,
                JSON.stringify({ directory: projectDirectoryKey(directory), identity: options.to }),
            );
        }
    console.log(`Backup: ${backup} (${backupBytes} bytes)`);
    console.log("This backup can be deleted once the merge has been confirmed.");
    return 0;
}
