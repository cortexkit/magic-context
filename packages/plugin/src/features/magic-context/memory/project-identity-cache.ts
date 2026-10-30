import { createHash } from "node:crypto";
import { promises as fs, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { getMagicContextStorageDir } from "../../../shared/data-path";
import { log } from "../../../shared/logger";
import { projectDirectoryKey } from "../../../shared/project-directory-key";
import { writeStorageFileAtomicSync } from "../../../shared/storage-permissions";
import { readCachedGitCheckoutMetadata } from "./git-common-dir";
import { projectPinWriter } from "./project-pin-writer";

// Lives in shared/ so the TUI (which ships without features/) can use the same
// normalization; re-exported here for the existing importers.
export { projectDirectoryKey };

export interface ProjectIdentityRecord {
    directory: string;
    identity: string;
    gitCommonDir?: string;
}

const ignoredImplicitRecords = new Set<string>();
const conflictingCommonDirs = new Set<string>();
const recordCache = new Map<
    string,
    { signature: string; record: ProjectIdentityRecord | undefined }
>();
const borrowedCache = new Map<
    string,
    {
        commonDir: string;
        preferCheckoutRoot: boolean;
        signature: string;
        writer: ReturnType<typeof projectPinWriter>;
        generation: number;
        identity: string | undefined;
        source: string | undefined;
        sourceSignature: string;
    }
>();
const cleanedWorktrees = new Set<string>();

function fileSignature(file: string): string {
    try {
        const stat = statSync(file, { bigint: true });
        return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch {
        return "missing";
    }
}

export function isPinnedProjectIdentity(identity: unknown): identity is string {
    return (
        typeof identity === "string" &&
        /^pj-[A-Za-z0-9_-]+$/.test(identity) &&
        !identity.startsWith("pj-implicit1-")
    );
}

function readIdentityRecord(file: string): ProjectIdentityRecord | undefined {
    try {
        const record = JSON.parse(readFileSync(file, "utf8"));
        if (typeof record?.directory !== "string" || typeof record.identity !== "string")
            return undefined;
        if (record.identity.startsWith("pj-implicit1-")) {
            const key = `${file}\0${record.identity}`;
            if (!ignoredImplicitRecords.has(key)) {
                ignoredImplicitRecords.add(key);
                log(`[magic-context] ignoring implicit project identity sidecar: ${file}`);
            }
            return undefined;
        }
        if (
            !/^git:[0-9a-f]{7,64}$/.test(record.identity) &&
            !isPinnedProjectIdentity(record.identity)
        )
            return undefined;
        return {
            directory: record.directory,
            identity: record.identity,
            ...(typeof record.gitCommonDir === "string"
                ? { gitCommonDir: record.gitCommonDir }
                : {}),
        };
    } catch {
        // Missing or damaged sidecars never prevent a session from starting.
        return undefined;
    }
}

function cachePath(directory: string, storageDir = getMagicContextStorageDir()): string {
    const hash = createHash("sha256").update(projectDirectoryKey(directory)).digest("hex");
    return path.join(storageDir, "project-identities", `${hash}.json`);
}

/** A small atomic sidecar avoids opening or migrating the store during plugin boot. */
export function rememberGitIdentity(directory: string, identity: string): void {
    if (!/^git:[0-9a-f]{7,64}$/.test(identity)) return;
    try {
        if (isPinnedProjectIdentity(readRememberedProjectIdentity(directory)?.identity)) return;
        const destination = cachePath(directory);
        writeStorageFileAtomicSync(
            destination,
            JSON.stringify({ directory: projectDirectoryKey(directory), identity }),
        );
    } catch {
        // Read-only storage must not turn a successful git probe into a failure.
    }
}

/** Called after rememberResolvedProjectIdentity checks folder access and checkout ownership; publishes before disk I/O. */
export function rememberPinnedProjectIdentity(
    directory: string,
    identity: string,
    gitCommonDir?: string,
): void {
    if (!isPinnedProjectIdentity(identity)) return;
    try {
        if (isPinnedProjectIdentity(readRememberedProjectIdentity(directory)?.identity)) return;
        projectPinWriter().publish(cachePath(directory), {
            directory: projectDirectoryKey(directory),
            identity,
            gitCommonDir,
        });
    } catch {
        // A read-only sidecar store must not prevent use of the live identity for this session.
    }
}

/** Read only the record for this exact directory key, never an ancestor's pin. */
export function readRememberedProjectIdentity(
    directory: string,
    storageDir?: string,
): ProjectIdentityRecord | undefined {
    const destination = cachePath(directory, storageDir);
    const published = projectPinWriter().lookup(destination);
    if (published)
        return published.directory === projectDirectoryKey(directory) ? published : undefined;
    const signature = fileSignature(destination);
    const cached = recordCache.get(destination);
    let record: ProjectIdentityRecord | undefined;
    if (cached?.signature === signature) record = cached.record;
    else {
        record = readIdentityRecord(destination);
        recordCache.set(destination, { signature, record });
    }
    return record?.directory === projectDirectoryKey(directory) ? { ...record } : undefined;
}

/** `storageDir` lets offline tools read the sidecars that sit next to a chosen `context.db`. */
export function readRememberedGitIdentity(
    directory: string,
    storageDir?: string,
): string | undefined {
    const record = readRememberedProjectIdentity(directory, storageDir);
    return record?.identity.startsWith("git:") ? record.identity : undefined;
}

/** Borrow a unique pin for a checkout without writing a pin for the queried folder. */
export function findPinnedIdentityByGitCommonDir(
    gitCommonDir: string,
    storageDir = getMagicContextStorageDir(),
    preferCheckoutRoot = false,
): string | undefined {
    return findPinnedRecordByGitCommonDir(gitCommonDir, storageDir, preferCheckoutRoot)?.identity;
}

function findPinnedRecordByGitCommonDir(
    gitCommonDir: string,
    storageDir: string,
    preferCheckoutRoot: boolean,
): ProjectIdentityRecord | undefined {
    const sidecarDir = path.join(storageDir, "project-identities");
    let files: string[];
    try {
        files = readdirSync(sidecarDir);
    } catch {
        files = [];
    }
    const records = new Map(
        projectPinWriter()
            .records(sidecarDir)
            .map((record) => [record.directory, record]),
    );
    const identities = new Map<string, ProjectIdentityRecord>();
    for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const record = readIdentityRecord(path.join(sidecarDir, file));
        if (record && !records.has(record.directory)) records.set(record.directory, record);
    }
    for (const record of records.values()) {
        if (preferCheckoutRoot && isPinnedProjectIdentity(record.identity)) {
            const checkout = readCachedGitCheckoutMetadata(record.directory);
            // Older root pins predate gitCommonDir. Verify their topology on disk,
            // rather than mistaking an independently registered subfolder for the root.
            if (
                checkout?.gitCommonDir === gitCommonDir &&
                !checkout.linkedWorktree &&
                projectDirectoryKey(checkout.checkoutRoot) === record.directory
            )
                return record;
        }
        if (record.gitCommonDir === gitCommonDir && isPinnedProjectIdentity(record.identity))
            identities.set(record.identity, record);
    }
    if (identities.size === 1) return identities.values().next().value;
    if (identities.size > 1) {
        const key = `${sidecarDir}\0${gitCommonDir}`;
        if (!conflictingCommonDirs.has(key)) {
            conflictingCommonDirs.add(key);
            log(`[magic-context] conflicting project pins for git common dir: ${gitCommonDir}`);
        }
    }
    return undefined;
}

/** Atomic renames or a newly published in-memory pin invalidate a borrow before disk persistence. */
export function readBorrowedProjectIdentity(
    directory: string,
    gitCommonDir: string,
    preferCheckoutRoot: boolean,
): string | undefined {
    const storageDir = getMagicContextStorageDir();
    const key = cachePath(directory, storageDir);
    const writer = projectPinWriter();
    const signature = fileSignature(path.join(storageDir, "project-identities"));
    const cached = borrowedCache.get(key);
    if (
        cached &&
        cached.commonDir === gitCommonDir &&
        cached.preferCheckoutRoot === preferCheckoutRoot &&
        cached.writer === writer &&
        cached.generation === writer.generation &&
        cached.signature === signature &&
        (!cached.source || cached.sourceSignature === fileSignature(cached.source))
    )
        return cached.identity;
    const record = findPinnedRecordByGitCommonDir(gitCommonDir, storageDir, preferCheckoutRoot);
    const source = record ? cachePath(record.directory, storageDir) : undefined;
    borrowedCache.set(key, {
        commonDir: gitCommonDir,
        preferCheckoutRoot,
        signature,
        writer,
        generation: writer.generation,
        identity: record?.identity,
        source,
        sourceSignature: source ? fileSignature(source) : "missing",
    });
    return record?.identity;
}

export function __resetProjectIdentitySidecarCachesForTests(): void {
    recordCache.clear();
    borrowedCache.clear();
    cleanedWorktrees.clear();
}

/** Worktrees inherit the checkout's pj- identity without saving it; retire only the git: bytes read here. */
export function removeStaleWorktreeIdentity(directory: string): void {
    const destination = cachePath(directory);
    if (cleanedWorktrees.has(destination)) return;
    // A failed cleanup must not turn into a file read on every context pass.
    cleanedWorktrees.add(destination);
    try {
        const bytes = readFileSync(destination, "utf8");
        const record = JSON.parse(bytes);
        if (
            record.directory === projectDirectoryKey(directory) &&
            /^git:[0-9a-f]{7,64}$/.test(record.identity)
        )
            projectPinWriter().removeIfUnchanged(destination, record, bytes);
    } catch {
        // Missing or unreadable sidecars need no cleanup.
    }
}

/** Maintenance only: an inaccessible directory may still exist; prune only confirmed ENOENT records. */
export async function pruneMissingProjectIdentities(
    storageDir = getMagicContextStorageDir(),
): Promise<number> {
    const directory = path.join(storageDir, "project-identities");
    let removed = 0;
    let entries: string[];
    try {
        entries = await fs.readdir(directory);
    } catch {
        return 0;
    }
    for (const entry of entries) {
        if (!/^[0-9a-f]{64}\.json$/.test(entry)) continue;
        const file = path.join(directory, entry);
        try {
            const record = JSON.parse(await fs.readFile(file, "utf8"));
            if (
                typeof record.directory !== "string" ||
                !path.isAbsolute(record.directory) ||
                cachePath(record.directory, storageDir) !== file ||
                !/^git:[0-9a-f]{7,64}$/.test(record.identity)
            )
                continue;
            try {
                await fs.stat(record.directory);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
                await fs.unlink(file);
                removed++;
            }
        } catch {
            // Damaged records and storage failures are not proof a project is gone.
        }
    }
    return removed;
}
