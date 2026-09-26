import type { Database } from "../../shared/sqlite";

/**
 * The per-project single-store marker.
 *
 * A row in `single_store_projects` says a project's memories and notes live only in
 * `context.db`, so the store.db mirror, drain and reconcile paths must not run for it.
 * No code in this release writes a row; it only reads them and refuses.
 */

/** The marker table's name. The Rust module's `MARKER_TABLE` is the same literal. */
export const MARKER_TABLE = "single_store_projects";

/**
 * The `context.db` migration version that creates the marker table.
 *
 * A file whose persisted migration lane is below this number has not run that
 * migration yet, so its projects are unmarked rather than unreadable. The Rust
 * module carries the same number as `MARKER_LANE_VERSION`.
 */
export const MARKER_LANE_VERSION = 93;

/** The refusal code every entry point reports for a marked or unreadable marker. */
export const SINGLE_STORE_TRIPWIRE = "single_store_tripwire";

/**
 * What `drainAuthority` returns instead of draining a single-store project.
 *
 * It has the same members as the contended drain result so every caller that tests
 * `"code" in result` sees it. `state` is fixed: nothing was observed, and `"MODULE"`
 * is the state under which session start neither prepares nor seeds.
 */
export interface SingleStoreTripwireResult {
    code: typeof SINGLE_STORE_TRIPWIRE;
    retryable: false;
    state: "MODULE";
    attempts: 0;
    authority: null;
}

export function singleStoreTripwireResult(): SingleStoreTripwireResult {
    return {
        code: SINGLE_STORE_TRIPWIRE,
        retryable: false,
        state: "MODULE",
        attempts: 0,
        authority: null,
    };
}

/** The error every non-drain entry point rejects with for a single-store refusal. */
export class SingleStoreTripwireError extends Error {
    readonly code = SINGLE_STORE_TRIPWIRE;
    readonly retryable = false;
    readonly state = "MODULE";

    constructor(message: string, options?: { cause?: unknown }) {
        super(`${SINGLE_STORE_TRIPWIRE}: ${message}`, options);
        this.name = "SingleStoreTripwireError";
    }
}

/**
 * The tripwire error carried anywhere in `error`'s cause chain, re-created as a
 * `SingleStoreTripwireError`, or null when the error is something else.
 *
 * A module refusal can arrive as a transport error whose `code` is the tripwire
 * code; mapping it here gives every caller the same own properties to test.
 */
export function asSingleStoreTripwire(error: unknown): SingleStoreTripwireError | null {
    if (error instanceof SingleStoreTripwireError) return error;
    let current: unknown = error;
    const seen = new Set<unknown>();
    while (current && typeof current === "object" && !seen.has(current)) {
        seen.add(current);
        const record = current as { code?: unknown; message?: unknown; cause?: unknown };
        if (record.code === SINGLE_STORE_TRIPWIRE) {
            const message =
                typeof record.message === "string" ? record.message : "the module refused";
            return new SingleStoreTripwireError(message, { cause: error });
        }
        current = record.cause;
    }
    return null;
}

/** Upstream migration versions at or above this belong to downstream forks. */
const FORK_MIGRATION_VERSION_FLOOR = 10_000;

/**
 * The persisted upstream migration lane, 0 when the file has no `schema_migrations`.
 *
 * The same arithmetic as `getPersistedSchemaVersion` in storage-db, repeated here
 * because storage-db imports the authority module that imports this one.
 */
export function readMarkerLane(db: Database): number {
    const hasMigrationsTable = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
        .get();
    if (!hasMigrationsTable) return 0;
    const row = db
        .prepare(
            "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations WHERE version < ?",
        )
        .get(FORK_MIGRATION_VERSION_FLOOR) as { version: number } | undefined;
    return row?.version ?? 0;
}

export interface SingleStoreMarkerRow {
    project_path: string;
    context_store_uuid: string;
    marked_at: number;
    marked_by_version: string;
}

export type SingleStoreMarkerRead =
    /** The file predates the marker table: every project is unmarked. */
    | { kind: "below_lane"; lane: number }
    | { kind: "unmarked" }
    | { kind: "marked"; row: SingleStoreMarkerRow }
    /** At or above the lane, but the table is missing or the query failed. */
    | { kind: "unreadable"; error: unknown };

/**
 * Read one project's marker. Never throws: a failed read is `unreadable`.
 *
 * `projectPath` is compared byte for byte with the stored identity string, so a raw
 * directory path (the fallback for an unresolved identity) never matches a marker.
 * Nothing is cached; every call reads the table.
 */
export function readSingleStoreMarker(db: Database, projectPath: string): SingleStoreMarkerRead {
    try {
        const lane = readMarkerLane(db);
        if (lane < MARKER_LANE_VERSION) return { kind: "below_lane", lane };
        const row = db
            .prepare(
                `SELECT project_path, context_store_uuid, marked_at, marked_by_version
                   FROM ${MARKER_TABLE} WHERE CAST(project_path AS BLOB) = CAST(? AS BLOB)`,
            )
            .get(projectPath) as SingleStoreMarkerRow | null | undefined;
        return row ? { kind: "marked", row } : { kind: "unmarked" };
    } catch (error) {
        return { kind: "unreadable", error };
    }
}

/** The refusal a local marker read already justifies, or null when it does not. */
export function refusalForMarkerRead(
    projectPath: string,
    read: SingleStoreMarkerRead,
): SingleStoreTripwireError | null {
    if (read.kind === "marked") {
        return new SingleStoreTripwireError(
            `project ${projectPath} is marked single-store (by ${read.row.marked_by_version}); the store.db mirror does not serve it`,
        );
    }
    if (read.kind === "unreadable") {
        return new SingleStoreTripwireError(
            `the ${MARKER_TABLE} table cannot be read, so no project on this context.db is served`,
            { cause: read.error },
        );
    }
    return null;
}

/** The one module route the marker gate uses: a read-only marker and fence answer. */
export interface MarkerStatusModuleClient {
    markerStatus?(args: {
        project: string;
        projectRoot?: string;
    }): Promise<{ ok: boolean; marked?: boolean; below_lane?: boolean }>;
}

/**
 * Decide whether the store.db mirror may run for `projectPath`: null to proceed, or the
 * refusal to report.
 *
 * Below the marker lane nothing is consulted. At or above it the project's own row
 * refuses, an unreadable table refuses, and otherwise the module is asked once through
 * `mirror.marker_status`, because only the module checks the marker table's schema
 * fingerprint. A client without that route refuses rather than guessing. A module
 * failure that is not a single-store refusal (a transport error, a missing file) is
 * rethrown unchanged.
 */
export async function singleStoreGate(args: {
    db: Database;
    projectPath: string;
    module: MarkerStatusModuleClient;
}): Promise<SingleStoreTripwireError | null> {
    const read = readSingleStoreMarker(args.db, args.projectPath);
    if (read.kind === "below_lane") return null;
    const local = refusalForMarkerRead(args.projectPath, read);
    if (local) return local;
    if (!args.module.markerStatus) {
        return new SingleStoreTripwireError(
            "this module client cannot answer mirror.marker_status, so the marker cannot be confirmed",
        );
    }
    try {
        await args.module.markerStatus({ project: args.projectPath });
        return null;
    } catch (error) {
        const tripwire = asSingleStoreTripwire(error);
        if (tripwire) return tripwire;
        throw error;
    }
}
