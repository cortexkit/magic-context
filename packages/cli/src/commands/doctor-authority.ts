import { loadPluginConfig } from "@magic-context/core/config";
import {
    AUTHORITY_DOMAINS,
    type AuthorityManagedMarker,
    type AuthorityModuleClient,
    checksumAuthoritySeedRows,
    drainAuthority,
    ensureContextStoreUuid,
    getAuthorityManagedMarker,
    getContextStoreUuid,
    listAuthorityManagedMarkers,
} from "@magic-context/core/features/magic-context/context-authority";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import {
    readAllSingleStoreMarkers,
    readSingleStoreMarker,
    SINGLE_STORE_TRIPWIRE,
    type SingleStoreMarkerRow,
} from "@magic-context/core/features/magic-context/single-store-marker";
import { bumpProjectMemoryEpoch } from "@magic-context/core/features/magic-context/storage-project-state";
import {
    getDefaultSubcConnectionFile,
    SubcModuleTransport,
} from "@magic-context/core/hooks/magic-context/module-transport";
import type { Database } from "@magic-context/core/shared/sqlite";

import { openExistingContextDatabaseForMutation } from "../lib/database-access";

export interface AuthorityProjectToVerify {
    /** Human-readable role in a cross-project operation, such as "source" or "target". */
    role: string;
    /** Durable Magic Context project identity stored by the authority marker. */
    projectPath: string;
    /** Filesystem root used to bind the module request to this project. */
    projectRoot: string | null;
}

export interface AuthorityVerificationResult {
    markers: AuthorityManagedMarker[];
}

export function authorityDrainCommand(project: AuthorityProjectToVerify): string {
    return `magic-context doctor drain-authority ${
        project.projectRoot ?? `<${project.role} project root>`
    }`;
}

/**
 * Prove that every requested project is writable by TypeScript before a command
 * mutates shared context.db rows. A durable authority marker is the fence: no
 * marker means TypeScript owns the project, while a marker requires the module
 * to confirm TypeScript ownership for every authority domain.
 */
export async function assertProjectsUseTsAuthority(args: {
    db: Database;
    projects: readonly AuthorityProjectToVerify[];
    module: Pick<AuthorityModuleClient, "authorityStatus">;
}): Promise<AuthorityVerificationResult> {
    const markers = listAuthorityManagedMarkers(args.db);
    const markerByProject = new Map(markers.map((marker) => [marker.project_path, marker]));

    for (const project of args.projects) {
        const marker = markerByProject.get(project.projectPath);
        if (!marker) continue;
        const projectRoot = project.projectRoot;
        if (!projectRoot) {
            throw new Error(
                `Migration refused: durable module authority for ${project.role} project ${project.projectPath} cannot be checked because its project directory is unavailable. ` +
                    `Writes remain fenced. Drain it first: ${authorityDrainCommand(project)}`,
            );
        }

        let statuses: Awaited<ReturnType<AuthorityModuleClient["authorityStatus"]>>[];
        try {
            statuses = await Promise.all(
                AUTHORITY_DOMAINS.map((domain) =>
                    args.module.authorityStatus({
                        context_store_uuid: marker.context_store_uuid,
                        project: project.projectPath,
                        projectRoot,
                        domain,
                    }),
                ),
            );
        } catch (error) {
            throw new Error(
                `Migration refused: module unreachable while checking ${project.role} project ${project.projectPath}; writes remain fenced. ` +
                    `Drain it first: ${authorityDrainCommand(project)}. ` +
                    `Module error: ${error instanceof Error ? error.message : String(error)}`,
            );
        }

        for (const [index, status] of statuses.entries()) {
            const state = status.authority?.state ?? "TS";
            if (state === "TS") continue;
            throw new Error(
                `Migration refused: ${project.role} project ${project.projectPath} has ${AUTHORITY_DOMAINS[index]} authority in ${state} mode; writes remain fenced. ` +
                    `Drain it first: ${authorityDrainCommand(project)}`,
            );
        }
    }

    return { markers };
}

function authorityClient(
    transport: SubcModuleTransport,
    projectRoot: string,
): AuthorityModuleClient {
    return {
        authorityStatus: (request) => transport.authorityStatus({ ...request, projectRoot }),
        authorityPrepare: (request) => transport.authorityPrepare({ ...request, projectRoot }),
        authorityDrain: (request) => transport.authorityDrain({ ...request, projectRoot }),
        mirrorPull: (request) => transport.mirrorPull({ ...request, projectRoot }),
        markerStatus: (request) => transport.markerStatus({ ...request, projectRoot }),
    };
}

/** The marker cell of one doctor report record. */
export type SingleStoreMarkerCell = "present" | "absent" | "unreadable" | "below_lane";

function markerDetail(row: SingleStoreMarkerRow, fileUuid: string | null): string {
    // A row written in another context.db (a copied or restored file) still marks the
    // project; the flag only makes the provenance visible.
    const mismatch = fileUuid !== null && row.context_store_uuid !== fileUuid;
    return ` marked_at=${row.marked_at} marked_by_version=${row.marked_by_version} context_store_uuid_mismatch=${mismatch}`;
}

function checksumFor(
    db: Database,
    projectPath: string,
    domain: (typeof AUTHORITY_DOMAINS)[number],
): string {
    const table = domain === "memories" ? "memories" : "notes";
    const rows = db
        .prepare(`SELECT * FROM ${table} WHERE project_path = ? ORDER BY id ASC`)
        .all(projectPath)
        .filter((row): row is Record<string, unknown> => row !== null && typeof row === "object");
    return checksumAuthoritySeedRows(rows);
}

/**
 * Report every project that carries an authority or single-store marker.
 *
 * `fail` is how an unreadable single-store marker table reaches the doctor's exit
 * code: at or above the marker lane nothing on the file can be trusted as unmarked.
 * Without `fail` it is reported as a warning.
 */
export async function reportAuthorityMarkers(args: {
    db: Database;
    info(message: string): void;
    warn(message: string): void;
    fail?(message: string): void;
}): Promise<void> {
    const markers = listAuthorityManagedMarkers(args.db);
    const singleStore = readAllSingleStoreMarkers(args.db);
    args.info("Authority:");
    if (singleStore.kind === "unreadable") {
        const message = `  single-store marker table unreadable — every project on this context.db is refused by the drain and mirror: ${
            singleStore.error instanceof Error
                ? singleStore.error.message
                : String(singleStore.error)
        }`;
        (args.fail ?? args.warn)(message);
    }
    const singleStoreRows =
        singleStore.kind === "read"
            ? new Map(singleStore.rows.map((row) => [row.project_path, row]))
            : new Map<string, SingleStoreMarkerRow>();
    // One record per project path, in authority-marker order and then marker-only.
    const projects = [
        ...new Set([...markers.map((marker) => marker.project_path), ...singleStoreRows.keys()]),
    ];
    if (projects.length === 0) {
        args.info("  no authority_managed markers");
        return;
    }
    let fileUuid: string | null = null;
    try {
        fileUuid = getContextStoreUuid(args.db);
    } catch {
        // A file without the meta table cannot compare uuids; the flag stays false.
    }
    for (const project of projects) {
        let cell: SingleStoreMarkerCell;
        let detail = "";
        if (singleStore.kind === "below_lane") cell = "below_lane";
        else if (singleStore.kind === "unreadable") cell = "unreadable";
        else {
            const row = singleStoreRows.get(project);
            cell = row ? "present" : "absent";
            if (row) detail = markerDetail(row, fileUuid);
        }
        args.info(`  ${project}: single_store_marker=${cell}${detail}`);
    }

    let currentIdentity: string | undefined;
    try {
        currentIdentity = resolveProjectIdentity(process.cwd());
    } catch {
        // A doctor run must still report the durable fences when cwd identity fails.
    }
    const loaded = loadPluginConfig(process.cwd());
    const transport = new SubcModuleTransport(
        loaded.subc?.connection_file ?? getDefaultSubcConnectionFile(),
    );
    // Authority state comes from the module and is only reachable for the project the
    // command runs in; the shipped per-marker branches are unchanged.
    for (const marker of markers) {
        if (marker.project_path !== currentIdentity) {
            args.warn(
                `  ${marker.project_path}: module state unavailable outside its project root — writes fenced; run with rust mode or restore subc connectivity`,
            );
            continue;
        }
        try {
            const module = authorityClient(transport, process.cwd());
            const statuses = await Promise.all(
                AUTHORITY_DOMAINS.map((domain) =>
                    module.authorityStatus({
                        context_store_uuid: ensureContextStoreUuid(args.db),
                        project: marker.project_path,
                        domain,
                    }),
                ),
            );
            args.info(
                `  ${marker.project_path}: ${statuses
                    .map(
                        (status, index) =>
                            `${AUTHORITY_DOMAINS[index]}=${status.authority?.state ?? "TS"}`,
                    )
                    .join(", ")}`,
            );
        } catch {
            args.warn(
                `  ${marker.project_path}: module unreachable — writes fenced; run with rust mode or restore subc connectivity`,
            );
        }
    }
}

export async function runDoctorDrainAuthority(
    projectRoot: string,
    dbPath: string,
): Promise<number> {
    const db = openExistingContextDatabaseForMutation(dbPath);
    if (!db) {
        console.error("No Magic Context database found.");
        return 1;
    }
    try {
        const projectPath = resolveProjectIdentity(projectRoot);
        if (!getAuthorityManagedMarker(db, projectPath)) {
            console.log(`No authority_managed marker exists for ${projectPath}.`);
            return 0;
        }
        const loaded = loadPluginConfig(projectRoot);
        const module = authorityClient(
            new SubcModuleTransport(loaded.subc?.connection_file ?? getDefaultSubcConnectionFile()),
            projectRoot,
        );
        let drainedAny = false;
        for (const domain of AUTHORITY_DOMAINS) {
            const status = await module.authorityStatus({
                context_store_uuid: ensureContextStoreUuid(db),
                project: projectPath,
                domain,
            });
            if (!status.authority || status.authority.state === "TS") continue;
            if (status.authority.state !== "MODULE" && status.authority.state !== "DRAINING") {
                console.error(
                    `Authority ${domain} is ${status.authority.state}; retry after it settles.`,
                );
                return 1;
            }
            // Only a domain that is about to be drained is checked. The check reports
            // what it found; it does not replace the drain's own refusal.
            const marker = readSingleStoreMarker(db, projectPath);
            if (marker.kind === "marked") {
                console.error(
                    `Single-store marker for ${projectPath}: marked_at=${marker.row.marked_at} marked_by_version=${marker.row.marked_by_version}`,
                );
            }
            let result: Awaited<ReturnType<typeof drainAuthority>> | undefined;
            for (let attempt = 0; attempt < 2; attempt += 1) {
                result = await drainAuthority({
                    db,
                    projectPath,
                    domain,
                    module,
                    checksum: () => checksumFor(db, projectPath, domain),
                });
                // A non-retryable refusal will not change on a second attempt.
                if (!("code" in result) || result.retryable === false) break;
            }
            if (result && "code" in result && result.code === SINGLE_STORE_TRIPWIRE) {
                console.error(
                    `Authority drain refused (${SINGLE_STORE_TRIPWIRE}): ${projectPath}'s ${domain} live only in context.db, so there is nothing to drain back from store.db.`,
                );
                return 1;
            }
            if (!result || "code" in result) {
                console.error(
                    "Authority drain is contended and remains retryable; try again shortly.",
                );
                return 1;
            }
            drainedAny = true;
        }
        if (drainedAny && !getAuthorityManagedMarker(db, projectPath)) {
            bumpProjectMemoryEpoch(db, projectPath);
            console.log(`Authority drained back to TypeScript for ${projectPath}.`);
            return 0;
        }
        console.error("Module did not confirm a complete authority drain; writes remain fenced.");
        return 1;
    } catch (error) {
        console.error(
            `Module unreachable — writes fenced; run with rust mode or restore subc connectivity: ${error instanceof Error ? error.message : String(error)}`,
        );
        return 1;
    } finally {
        db.close();
    }
}
