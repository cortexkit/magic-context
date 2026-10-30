import { createHash } from "node:crypto";
import { promises as fs, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { getMagicContextStorageDir } from "../../../shared/data-path";
import { log } from "../../../shared/logger";
import { projectDirectoryKey } from "../../../shared/project-directory-key";
import { writeStorageFileAtomicSync } from "../../../shared/storage-permissions";
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
const pinGenerations = new Map<string, number>();

export function projectIdentityPinGeneration(directory: string): number {
    return pinGenerations.get(projectDirectoryKey(directory)) ?? 0;
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
        const key = projectDirectoryKey(directory);
        pinGenerations.set(key, projectIdentityPinGeneration(directory) + 1);
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
    const record = projectPinWriter().lookup(destination) ?? readIdentityRecord(destination);
    return record?.directory === projectDirectoryKey(directory) ? record : undefined;
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
): string | undefined {
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
    const identities = new Set<string>();
    for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const record = readIdentityRecord(path.join(sidecarDir, file));
        if (record && !records.has(record.directory)) records.set(record.directory, record);
    }
    for (const record of records.values()) {
        if (record.gitCommonDir === gitCommonDir && isPinnedProjectIdentity(record.identity))
            identities.add(record.identity);
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
