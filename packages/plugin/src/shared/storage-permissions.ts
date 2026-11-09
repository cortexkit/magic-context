/**
 * Process-wide storage permission policy resolved from trusted user config.
 *
 * Storage is shared by OpenCode and Pi, so all writers consult one setting before
 * applying POSIX modes. The default preserves the historical owner-only policy.
 */
import { randomBytes } from "node:crypto";
import type { WriteStream } from "node:fs";
import {
    chmodSync,
    closeSync,
    createWriteStream,
    fsyncSync,
    lstatSync,
    mkdirSync,
    openSync,
    readdirSync,
    readlinkSync,
    readSync,
    renameSync,
    rmdirSync,
    rmSync,
    symlinkSync,
    writeFileSync,
    writeSync,
} from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { open as openAsync, writeFile as writeFileAsync } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

let enforcePrivateStoragePermissions = true;
const STORAGE_PERMISSIONS_POLICY_VERSION = 1;
const STORAGE_PERMISSIONS_MARKER = `.storage-permissions-v${STORAGE_PERMISSIONS_POLICY_VERSION}`;

function invalidateStoragePermissionMarkers(directory: string): void {
    for (let current = directory; ; current = dirname(current)) {
        rmSync(join(current, STORAGE_PERMISSIONS_MARKER), { force: true });
        if (dirname(current) === current) return;
    }
}

export function setStoragePrivatePermissionEnforcement(enforce: boolean): void {
    enforcePrivateStoragePermissions = enforce;
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

/** Tighten existing entries during storage startup; symlinks are never followed. */
export function tightenStorageTreeSync(
    root: string,
    dbPath = join(root, "context.db"),
): { tightened: number; failures: number } {
    if (process.platform === "win32") {
        return { tightened: 0, failures: 0 };
    }
    const marker = join(root, STORAGE_PERMISSIONS_MARKER);
    let tightened = 0;
    let failures = 0;
    const removeMarker = (): void => {
        try {
            rmSync(marker, { force: true });
        } catch {
            failures++;
        }
    };
    if (!shouldEnforcePrivateStoragePermissions()) {
        removeMarker();
        return { tightened, failures };
    }
    let certified = false;
    try {
        const stat = lstatSync(marker);
        certified = stat.isFile() && (stat.mode & 0o7777) === 0o600;
        if (!certified) removeMarker();
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") failures++;
    }
    const fenceDirectory = join(root, "lkg-recovery-fences");
    const visit = (entryPath: string, recursive = true, optional = false): void => {
        let stat: ReturnType<typeof lstatSync>;
        try {
            stat = lstatSync(entryPath);
        } catch (error) {
            if (!optional || (error as NodeJS.ErrnoException).code !== "ENOENT") failures++;
            return;
        }
        if (stat.isSymbolicLink()) return;
        if (!certified && dirname(entryPath) === fenceDirectory) {
            const name = basename(entryPath);
            if (stat.isFile() && /^.+\.json\..+\.tmp$/.test(name)) {
                try {
                    rmSync(entryPath, { force: true });
                } catch {
                    failures++;
                }
                return;
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
            entries = readdirSync(entryPath);
        } catch {
            failures++;
            return;
        }
        for (const entry of entries) visit(join(entryPath, entry));
    };
    if (certified) {
        visit(root, false);
        visit(dbPath, false, true);
        visit(`${dbPath}-wal`, false, true);
        visit(`${dbPath}-shm`, false, true);
        // Transformers does not set cache entry modes. Keep this subtree checked.
        visit(join(root, "models"), true, true);
        // The Rust logger does not use the storage helpers.
        visit(join(root, "logs"), true, true);
        if (tightened > 0 || failures > 0) removeMarker();
    } else {
        visit(root);
        if (failures === 0) {
            try {
                writeStorageFileSync(marker, `${STORAGE_PERMISSIONS_POLICY_VERSION}\n`, {
                    flag: "wx",
                });
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") failures++;
            }
        }
    }
    return { tightened, failures };
}
