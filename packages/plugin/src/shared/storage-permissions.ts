/**
 * Process-wide storage permission policy resolved from trusted user config.
 *
 * Storage is shared by OpenCode and Pi, so all writers consult one setting before
 * applying POSIX modes. The default preserves the historical owner-only policy.
 */
import { randomBytes } from "node:crypto";
import type { Stats, WriteStream } from "node:fs";
import {
    chmodSync,
    closeSync,
    constants,
    createWriteStream,
    fstatSync,
    fsyncSync,
    lstatSync,
    mkdirSync,
    openSync,
    readdirSync,
    readlinkSync,
    readSync,
    realpathSync,
    renameSync,
    rmdirSync,
    rmSync,
    symlinkSync,
    writeFileSync,
    writeSync,
} from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { open as openAsync, writeFile as writeFileAsync } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isPidAlive } from "./rpc-utils";

let enforcePrivateStoragePermissions = true;
const STORAGE_PERMISSIONS_POLICY_VERSION = 1;
const STORAGE_PERMISSIONS_MARKER = `.storage-permissions-v${STORAGE_PERMISSIONS_POLICY_VERSION}`;
const STORAGE_PERMISSIONS_MARKER_BYTES = Buffer.from(`${STORAGE_PERMISSIONS_POLICY_VERSION}\n`);
const STORAGE_PERMISSIONS_MARKER_MAX_AGE_MS = 24 * 60 * 60_000;
const LEGACY_FENCE_TEMP_MIN_AGE_MS = 10 * 60_000;

/** Top-level names that Magic Context creates in its data folder. */
export const MAGIC_CONTEXT_STORAGE_ENTRIES: readonly (string | RegExp)[] = [
    "context.db",
    "context.db-wal",
    "context.db-shm",
    "context.db-journal",
    "store.db", // The 0.49 Magic Context module's companion database.
    "store.db-wal",
    "store.db-shm",
    "store.db-journal",
    STORAGE_PERMISSIONS_MARKER,
    "models",
    "logs",
    "backups",
    "config-backups",
    "lkg-recovery-fences",
    "rpc",
    "project-identities",
    "heap-snapshots",
    "host-profiler",
    "pi-served-array-digests",
    "pi-served-array-bodies",
    "pi-served-tag-numbers",
    "window-reports.jsonl",
    "window-reports.jsonl.1",
    // Atomic storage writes add .<pid>.<12 hex digits>.tmp to these root files.
    /^(?:last_announced_version|last-update-check\.json|pending-plugin-update\.json|model-context-limits-(?:opencode|opencode2)\.json)(?:\.[1-9]\d*\.[a-f0-9]{12}\.tmp)?$/,
    /^identity-merge-backup-[A-Za-z0-9]{6}$/,
    // Session migration snapshot and database-repair copies/staging bundles.
    /^context\.db\.bak-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/,
    /^context\.db\.corrupt-(?:backup|original)-\d{8}T\d{9}Z(?:-[1-9]\d{0,3})?(?:-wal|-shm)?$/,
    /^context\.db\.recovering-\d{8}T\d{9}Z-[1-9]\d*(?:-[1-9]\d{0,3})?(?:\.(?:count-source|recover-source|(?:fresh\.)?db)(?:-wal|-shm)?|\.sql)$/,
];

/**
 * Storage roots and their configured aliases. Marker invalidation must stop
 * at the storage boundary whether a writer uses the physical path or the alias.
 */
const storagePermissionRoots = new Set<string>();

function invalidateStoragePermissionMarkers(directory: string): void {
    // Stop at the storage root: an ancestor of the root has no applicable marker.
    // A directory that is not in a known root continues to the file system
    // root, because a marker that stays can keep the approval of a loose tree.
    for (let current = resolve(directory); ; current = dirname(current)) {
        const marker = join(current, STORAGE_PERMISSIONS_MARKER);
        try {
            rmSync(marker, { force: true });
        } catch (error) {
            const stat = lstatSync(marker, { throwIfNoEntry: false });
            // Only a regular file can be a certificate.
            // A read-only mount can reject an unlink even if the marker is absent.
            if (stat?.isFile() || (!stat && (error as NodeJS.ErrnoException).code !== "EROFS")) {
                throw error;
            }
        }
        if (storagePermissionRoots.has(current) || dirname(current) === current) return;
    }
}

export function setStoragePrivatePermissionEnforcement(enforce: boolean): void {
    enforcePrivateStoragePermissions = enforce;
    if (enforce || process.platform === "win32") return;
    // A host can keep its database open across a reload, so the next open does not
    // run the startup walk. Files written while enforcement is off can be loose.
    for (const root of storagePermissionRoots) {
        try {
            rmSync(join(root, STORAGE_PERMISSIONS_MARKER), { force: true });
        } catch {
            // Do not stop the configuration change. The startup walk reports this failure.
        }
    }
}

export function shouldEnforcePrivateStoragePermissions(): boolean {
    return enforcePrivateStoragePermissions;
}

/** Test-only reset for suites that exercise both permission policies in one process. */
export function __resetStoragePrivatePermissionEnforcementForTests(): void {
    enforcePrivateStoragePermissions = true;
}

/** Create storage directories with owner-only permissions at their creation. */
export function ensureStorageDirectorySync(
    directory: string,
    forcePrivate = false,
    recursive = true,
): void {
    const privateMode = forcePrivate || shouldEnforcePrivateStoragePermissions();
    mkdirSync(directory, {
        recursive,
        ...(privateMode ? { mode: 0o700 } : {}),
    });
}

/** Replay-authorizing files require a private real directory, even after a permissive restore. */
export function ensurePrivateStorageDirectorySync(directory: string): void {
    ensureStorageDirectorySync(directory, true);
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Private storage directory is not a real directory");
    if (process.platform !== "win32") {
        if ((stat.mode & 0o777) !== 0o700) invalidateStoragePermissionMarkers(directory);
        chmodSync(directory, 0o700);
    }
}

/** Create or replace a storage file using a private mode from the first byte. */
export function writeStorageFileSync(
    filePath: string,
    content: string | Uint8Array,
    options: { encoding?: BufferEncoding; flag?: string; forcePrivate?: boolean } = {},
): void {
    const { forcePrivate = false, ...writeOptions } = options;
    const privateMode = forcePrivate || shouldEnforcePrivateStoragePermissions();
    writeFileSync(filePath, content, {
        ...writeOptions,
        ...(privateMode ? { mode: 0o600 } : {}),
    });
}

/** Write a private sibling then atomically publish it without a permissive temp window. */
export function writeStorageFileAtomicSync(
    filePath: string,
    content: string | Uint8Array,
    forcePrivate = false,
): void {
    ensureStorageDirectorySync(dirname(filePath), forcePrivate);
    const tempPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
        writeStorageFileSync(tempPath, content, { flag: "wx", forcePrivate });
        renameSync(tempPath, filePath);
    } catch (error) {
        rmSync(tempPath, { force: true });
        throw error;
    }
}

/** Flush the namespace containing a safety-critical sidecar (POSIX only). */
export function syncStorageDirectorySync(directory: string): void {
    const fd = openSync(directory, "r");
    try {
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
}

/** Publish a safety record only after both its bytes and directory entry are durable.
 * Hold the mutex through this call to use a constant tempPath.
 */
export function writeStorageFileDurableAtomicSync(
    filePath: string,
    content: string,
    afterTempSync?: () => void,
    tempPath = `${filePath}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
): void {
    const directory = dirname(filePath);
    ensurePrivateStorageDirectorySync(directory);
    let fd: number | undefined;
    try {
        fd = openStorageFileSync(tempPath, "wx", true);
        writeFileSync(fd, content, "utf8");
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        afterTempSync?.();
        renameSync(tempPath, filePath);
        syncStorageDirectorySync(directory);
        syncStorageDirectorySync(dirname(directory));
    } finally {
        if (fd !== undefined) closeSync(fd);
        rmSync(tempPath, { force: true });
    }
}

export function copyStorageFileSync(
    sourcePath: string,
    destinationPath: string,
    forcePrivate = false,
): void {
    ensureStorageDirectorySync(dirname(destinationPath), forcePrivate);
    const privateMode = forcePrivate || shouldEnforcePrivateStoragePermissions();
    const sourceFd = openSync(sourcePath, "r");
    let destinationFd: number | undefined;
    try {
        destinationFd = openSync(destinationPath, "wx", privateMode ? 0o600 : 0o666);
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        for (;;) {
            const bytesRead = readSync(sourceFd, buffer, 0, buffer.length, null);
            if (bytesRead === 0) break;
            let offset = 0;
            while (offset < bytesRead) {
                offset += writeSync(destinationFd, buffer, offset, bytesRead - offset);
            }
        }
    } catch (error) {
        if (destinationFd !== undefined) rmSync(destinationPath, { force: true });
        throw error;
    } finally {
        closeSync(sourceFd);
        if (destinationFd !== undefined) closeSync(destinationFd);
    }
}

export function copyStorageTreeSync(
    sourcePath: string,
    destinationPath: string,
    forcePrivate = false,
): void {
    const stat = lstatSync(sourcePath);
    if (stat.isSymbolicLink()) {
        ensureStorageDirectorySync(dirname(destinationPath), forcePrivate);
        symlinkSync(readlinkSync(sourcePath), destinationPath);
        return;
    }
    if (!stat.isDirectory()) {
        copyStorageFileSync(sourcePath, destinationPath, forcePrivate);
        return;
    }
    ensureStorageDirectorySync(destinationPath, forcePrivate);
    for (const entry of readdirSync(sourcePath)) {
        copyStorageTreeSync(join(sourcePath, entry), join(destinationPath, entry), forcePrivate);
    }
}

export function openStorageFileSync(filePath: string, flags: string, forcePrivate = false): number {
    ensureStorageDirectorySync(dirname(filePath), forcePrivate);
    const privateMode = forcePrivate || shouldEnforcePrivateStoragePermissions();
    return openSync(filePath, flags, privateMode ? 0o600 : 0o666);
}

export async function writeStorageFileAsync(
    filePath: string,
    content: string | Uint8Array,
    forcePrivate = false,
): Promise<void> {
    const privateMode = forcePrivate || shouldEnforcePrivateStoragePermissions();
    ensureStorageDirectorySync(dirname(filePath), privateMode);
    await writeFileAsync(filePath, content, privateMode ? { mode: 0o600 } : undefined);
}

export async function writeStorageFileHandleAsync(
    handle: FileHandle,
    content: string,
): Promise<void> {
    await handle.writeFile(content);
}

export function createStorageWriteStream(filePath: string, forcePrivate = false): WriteStream {
    const privateMode = forcePrivate || shouldEnforcePrivateStoragePermissions();
    return createWriteStream(filePath, privateMode ? { mode: 0o600 } : undefined);
}

export async function createStorageFileHandleAsync(
    filePath: string,
    flags: string,
    forcePrivate = false,
) {
    const privateMode = forcePrivate || shouldEnforcePrivateStoragePermissions();
    return openAsync(filePath, flags, privateMode ? 0o600 : undefined);
}

function readStoragePermissionCertificate(marker: string): Stats | undefined {
    const fd = openSync(marker, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const stat = fstatSync(fd);
        // File times can have fractions of a millisecond. Use the precision of Date.now().
        const age = Date.now() - Math.floor(stat.mtimeMs);
        if (
            !stat.isFile() ||
            (stat.mode & 0o7777) !== 0o600 ||
            stat.uid !== process.getuid?.() ||
            stat.size !== STORAGE_PERMISSIONS_MARKER_BYTES.length ||
            age < 0 ||
            age >= STORAGE_PERMISSIONS_MARKER_MAX_AGE_MS
        ) {
            return undefined;
        }
        // Read one more byte in case the file grew after fstat.
        const buffer = Buffer.alloc(STORAGE_PERMISSIONS_MARKER_BYTES.length + 1);
        const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
        if (
            bytesRead === STORAGE_PERMISSIONS_MARKER_BYTES.length &&
            buffer.subarray(0, bytesRead).equals(STORAGE_PERMISSIONS_MARKER_BYTES)
        ) {
            return stat;
        }
    } finally {
        closeSync(fd);
    }
}

type LinkedRootSkip = "filesystem-root" | "home-folder" | "mount-point" | number;

function inspectLinkedStorageRoot(
    root: string,
    rootStat: Stats,
): { skipped: LinkedRootSkip } | { entries: string[] } {
    const parent = dirname(root);
    if (root === parent) return { skipped: "filesystem-root" };
    try {
        if (root === realpathSync(homedir())) return { skipped: "home-folder" };
    } catch (error) {
        // A missing home cannot be the existing target. Other errors prevent the safety check.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (lstatSync(parent).dev !== rootStat.dev) return { skipped: "mount-point" };
    const entries = readdirSync(root);
    const foreignEntries = entries.filter(
        (name) =>
            name !== ".DS_Store" &&
            !MAGIC_CONTEXT_STORAGE_ENTRIES.some((entry) =>
                typeof entry === "string" ? entry === name : entry.test(name),
            ),
    ).length;
    return foreignEntries === 0 ? { entries } : { skipped: foreignEntries };
}

type StoragePermissionCheck = {
    tightened: number;
    failures: number;
    rootLink?:
        | { path: string; target: string; skipped?: LinkedRootSkip }
        | { path: string; failure: string; nonDirectoryTarget?: string };
};

/** Tighten existing entries during startup. Follow a linked storage root, but no links inside it. */
export function tightenStorageTreeSync(
    directory: string,
    dbPath = join(directory, "context.db"),
): StoragePermissionCheck {
    if (process.platform === "win32") {
        return { tightened: 0, failures: 0 };
    }
    const enforce = shouldEnforcePrivateStoragePermissions();
    const startupPath = resolve(directory);
    let root = startupPath;
    let rootStat: Stats | undefined;
    let rootLink: StoragePermissionCheck["rootLink"];
    let linkedEntries: string[] | undefined;
    try {
        rootStat = lstatSync(root);
    } catch {
        if (enforce) return { tightened: 0, failures: 1 };
    }
    if (rootStat?.isSymbolicLink()) {
        try {
            root = realpathSync(startupPath);
            rootStat = lstatSync(root);
            if (rootStat.isDirectory() && enforce) {
                const eligibility = inspectLinkedStorageRoot(root, rootStat);
                if ("skipped" in eligibility) {
                    return {
                        tightened: 0,
                        failures: 0,
                        rootLink: { path: startupPath, target: root, skipped: eligibility.skipped },
                    };
                }
                linkedEntries = eligibility.entries;
            }
        } catch (error) {
            if (!enforce) return { tightened: 0, failures: 0 };
            const failure = (error as NodeJS.ErrnoException).code ?? String(error);
            return { tightened: 0, failures: 1, rootLink: { path: startupPath, failure } };
        }
        if (!rootStat.isDirectory()) {
            if (!enforce) return { tightened: 0, failures: 0 };
            return {
                tightened: 0,
                failures: 1,
                rootLink: {
                    path: startupPath,
                    failure: "not a directory",
                    nonDirectoryTarget: root,
                },
            };
        }
        rootLink = { path: startupPath, target: root };
        // Check the DB and sidecars in the same directory as the walk and marker,
        // even if the configured link is redirected during the check.
        dbPath = join(root, basename(dbPath));
        storagePermissionRoots.add(startupPath);
    }
    const marker = join(root, STORAGE_PERMISSIONS_MARKER);
    let tightened = 0;
    let failures = 0;
    let keptLegacyTemp = false;
    const removeMarker = (): boolean => {
        try {
            rmSync(marker, { force: true });
            return true;
        } catch {
            return false;
        }
    };
    if (!enforce) {
        storagePermissionRoots.add(root);
        if (!removeMarker()) failures++;
        return { tightened, failures, ...(rootLink && { rootLink }) };
    }
    if (!rootStat?.isDirectory()) return { tightened, failures: 1 };
    storagePermissionRoots.add(root);
    let certificate: Stats | undefined;
    let discardMarker = false;
    try {
        certificate = readStoragePermissionCertificate(marker);
        discardMarker = certificate === undefined;
    } catch (error) {
        discardMarker = (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
    // undefined: no loose entry. false: loose entry, marker stays. true: marker removed.
    let markerRemoved: boolean | undefined;
    const fenceDirectory = join(root, "lkg-recovery-fences");
    const visit = (entryPath: string, recursive = true, optional = false, stat?: Stats): void => {
        try {
            stat ??= lstatSync(entryPath);
        } catch (error) {
            if (!optional || (error as NodeJS.ErrnoException).code !== "ENOENT") failures++;
            return;
        }
        if (entryPath === root && !stat.isDirectory()) {
            failures++;
            return;
        }
        if (stat.isSymbolicLink()) return;
        // A mode change must not turn an invalid marker into a certificate.
        if (entryPath === marker && !stat.isDirectory()) return;
        if (!certificate && dirname(entryPath) === fenceDirectory) {
            const name = basename(entryPath);
            const legacyTemp = stat.isFile() && /^.+\.json\..+\.tmp$/.test(name);
            if (legacyTemp) {
                const publisherPid = /^.+\.json\.([1-9]\d*)\.[a-f0-9]{24}\.tmp$/.exec(name)?.[1];
                // The legacy writer puts its PID in the name. Age does not prove that it stopped.
                if (
                    Date.now() - stat.mtimeMs <= LEGACY_FENCE_TEMP_MIN_AGE_MS ||
                    (publisherPid && isPidAlive(Number(publisherPid)) !== "dead")
                ) {
                    // The certificate can prevent a check of these files at the next start.
                    keptLegacyTemp = true;
                } else {
                    try {
                        rmSync(entryPath, { force: true });
                    } catch {
                        failures++;
                    }
                    return;
                }
            }
            if (stat.isDirectory() && name.endsWith(".json.locks")) {
                try {
                    lstatSync(entryPath.slice(0, -".locks".length));
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                        try {
                            // A live ticket prevents removal of its directory.
                            rmdirSync(entryPath);
                            return;
                        } catch (cleanupError) {
                            const code = (cleanupError as NodeJS.ErrnoException).code;
                            if (code === "ENOENT") return;
                            if (code !== "ENOTEMPTY" && code !== "EEXIST") failures++;
                        }
                    } else failures++;
                }
            }
        }
        const mode = stat.isDirectory() ? 0o700 : 0o600;
        if ((stat.mode & 0o077) !== 0 || (stat.mode & 0o777) !== mode) {
            if (certificate) {
                // Invalidate before the mode change so a peer can see that the tree changed.
                markerRemoved ??= removeMarker();
            }
            try {
                chmodSync(entryPath, mode);
                tightened++;
            } catch {
                failures++;
            }
        }
        if (!recursive || !stat.isDirectory()) return;
        let entries: string[];
        try {
            // Do not walk any root entry that was not included in the eligibility check.
            entries = (entryPath === root ? linkedEntries : undefined) ?? readdirSync(entryPath);
        } catch {
            failures++;
            return;
        }
        for (const entry of entries) {
            // The snapshot may still list the certificate this check just removed.
            if (
                entryPath === root &&
                linkedEntries &&
                markerRemoved &&
                entry === STORAGE_PERMISSIONS_MARKER
            )
                continue;
            visit(join(entryPath, entry));
        }
    };
    if (certificate) {
        visit(root, false, false, rootStat);
        visit(dbPath, false, true);
        visit(`${dbPath}-wal`, false, true);
        visit(`${dbPath}-shm`, false, true);
        // Transformers does not set cache entry modes. Keep this subtree checked.
        visit(join(root, "models"), true, true);
        // The Rust logger does not use the storage helpers.
        visit(join(root, "logs"), true, true);
        // A loose entry shows the tree changed after certification. The root's mode does not
        // stop a process with a working directory in the tree. Walk the full tree at this start.
        if (markerRemoved !== undefined) {
            certificate = undefined;
            visit(root);
            if (!markerRemoved && !removeMarker()) failures++;
        } else if (failures > 0) {
            if (!removeMarker()) failures++;
        } else {
            // A peer can remove the certificate during the mode checks.
            let markerChanged: boolean;
            try {
                const current = lstatSync(marker);
                markerChanged =
                    current.dev !== certificate.dev ||
                    current.ino !== certificate.ino ||
                    current.ctimeMs !== certificate.ctimeMs;
            } catch (error) {
                markerChanged = true;
                discardMarker = (error as NodeJS.ErrnoException).code !== "ENOENT";
            }
            if (markerChanged) {
                certificate = undefined;
                visit(root);
                if (discardMarker && !removeMarker()) failures++;
            }
        }
    } else {
        visit(root, true, false, rootStat);
        if (discardMarker && !removeMarker()) failures++;
        if (failures === 0 && !keptLegacyTemp) {
            try {
                writeStorageFileSync(marker, STORAGE_PERMISSIONS_MARKER_BYTES, {
                    flag: "wx",
                });
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") failures++;
            }
        }
    }
    return { tightened, failures, ...(rootLink && { rootLink }) };
}
