import { applyMirroredNoteCompileFields } from "../features/magic-context/context-authority";
import { getNoteByIdInScope } from "../features/magic-context/storage-notes";
import type { Database } from "../shared/sqlite";
import type { RustNoteToolRequest } from "./rust-tool-backends";

/** The one module route the note backend needs: a ctx_note facade call. */
export interface RustNoteModuleCaller {
    call(args: {
        sessionId: string;
        projectRoot: string;
        method: "ctx_note";
        body: { name: "ctx_note"; arguments: Record<string, unknown> };
    }): Promise<unknown>;
}

/**
 * The module renders a note it created before the host mirror assigned it an id
 * with this placeholder (crates/mc-module `NOTE_ID_PENDING`).
 */
export const NOTE_ID_PENDING = "(id pending)";

/** Appended to a write reply whose host id is still unknown after the mirror pull. */
export const NOTE_WRITE_ID_PENDING_ADVICE =
    ' Its id appears in ctx_note(action="read") once the mirror catches up.';

/** The module row id a legacy ctx_note write reply names ("Saved session note #N", "Created smart note #N"). */
export function moduleNoteRowId(response: unknown, depth = 0): number | null {
    if (depth > 4 || response === null || response === undefined) return null;
    if (typeof response === "string") {
        const match = response.match(/\b(?:smart\s+)?note\s+#(\d+)/i);
        return match ? Number(match[1]) : null;
    }
    if (Array.isArray(response)) {
        for (const item of response) {
            const id = moduleNoteRowId(item, depth + 1);
            if (id !== null) return id;
        }
        return null;
    }
    if (typeof response !== "object") return null;
    const record = response as Record<string, unknown>;
    return (
        moduleNoteRowId(record.result, depth + 1) ??
        moduleNoteRowId(record.content, depth + 1) ??
        moduleNoteRowId(record.text, depth + 1)
    );
}

export function moduleNoteResponseIsError(response: unknown, depth = 0): boolean {
    if (depth > 4 || response === null || typeof response !== "object") return false;
    if (Array.isArray(response)) {
        return response.some((item) => moduleNoteResponseIsError(item, depth + 1));
    }
    const record = response as Record<string, unknown>;
    if (record.isError === true || record.ok === false || record.error !== undefined) return true;
    return moduleNoteResponseIsError(record.result, depth + 1);
}

/** The module row a write created, from the reply's structured `note_operation`. */
function writtenModuleNoteId(response: unknown, depth = 0): number | null {
    if (depth > 4 || response === null || typeof response !== "object") return null;
    const record = response as Record<string, unknown>;
    const operation = record.note_operation as Record<string, unknown> | undefined;
    if (
        operation &&
        operation.action === "write" &&
        typeof operation.module_id === "number" &&
        Number.isSafeInteger(operation.module_id)
    ) {
        return operation.module_id;
    }
    return writtenModuleNoteId(record.result, depth + 1);
}

/**
 * How one agent-typed note id reaches the module while it holds note authority.
 *
 * The agent is shown context.db (host) ids by the deferred-notes reminder and by
 * every ctx_note reply, but the module stores its own row ids. The two key
 * spaces overlap, so an id is only ever sent to the module through a mirror
 * identity of THIS project; a raw host id reinterpreted as a module id can name
 * an unrelated note, including one in the same project.
 */
export type NoteIdRoute =
    /** Mirrored row of this project: the module can address it. */
    | { kind: "module"; hostId: number; moduleId: number }
    /** The caller's own note whose mirror identity has not arrived yet: retrying helps. */
    | { kind: "pending"; hostId: number }
    /** No row, or one the caller may not see. One outcome for both, so neither can be probed. */
    | { kind: "unknown"; hostId: number };

function moduleNoteIdForHostId(db: Database, project: string, hostId: number): number | null {
    const row = db
        .prepare(
            `SELECT module_row_id FROM mirror_identity
              WHERE domain = 'notes' AND module_project = ? AND context_row_id = ?`,
        )
        .get(project, hostId) as { module_row_id: number } | undefined;
    return row?.module_row_id ?? null;
}

function hostNoteIdForModuleId(db: Database, project: string, moduleId: number): number | null {
    const row = db
        .prepare(
            `SELECT context_row_id FROM mirror_identity
              WHERE domain = 'notes' AND module_project = ? AND module_row_id = ?`,
        )
        .get(project, moduleId) as { context_row_id: number } | undefined;
    return row?.context_row_id ?? null;
}

/** Every host↔module note pair of one project, for rendering a glance in host ids. */
function projectNoteIdentityPairs(db: Database, project: string): Array<[number, number]> {
    const rows = db
        .prepare(
            `SELECT context_row_id, module_row_id FROM mirror_identity
              WHERE domain = 'notes' AND module_project = ?
              ORDER BY context_row_id`,
        )
        .all(project) as Array<{ context_row_id: number; module_row_id: number }>;
    return rows.map((row) => [row.context_row_id, row.module_row_id]);
}

export function routeHostNoteIds(args: {
    db: Database;
    projectIdentity: string;
    sessionId: string;
    hostIds: readonly number[];
}): NoteIdRoute[] {
    return args.hostIds.map((hostId): NoteIdRoute => {
        const moduleId = moduleNoteIdForHostId(args.db, args.projectIdentity, hostId);
        if (moduleId !== null) return { kind: "module", hostId, moduleId };
        const hostNote = getNoteByIdInScope(args.db, hostId, {
            projectPath: args.projectIdentity,
            sessionId: args.sessionId,
        });
        return hostNote ? { kind: "pending", hostId } : { kind: "unknown", hostId };
    });
}

/**
 * Fill the host id into a write reply the module rendered with the pending
 * placeholder. The placeholder sits in the fixed reply prefix, before any note
 * content, so only its first occurrence is replaced.
 */
function withWrittenHostId(response: unknown, hostId: number | null): unknown {
    if (response === null || typeof response !== "object") return response;
    const record = response as Record<string, unknown>;
    if ("result" in record && record.result !== null && typeof record.result === "object") {
        return { ...record, result: withWrittenHostId(record.result, hostId) };
    }
    if (!Array.isArray(record.content)) return response;
    const content = record.content.map((item, index) => {
        if (index !== 0 || item === null || typeof item !== "object") return item;
        const text = (item as { text?: unknown }).text;
        if (typeof text !== "string" || !text.includes(NOTE_ID_PENDING)) return item;
        return {
            ...item,
            text:
                hostId === null
                    ? `${text}${NOTE_WRITE_ID_PENDING_ADVICE}`
                    : text.replace(NOTE_ID_PENDING, `#${hostId}`),
        };
    });
    return { ...record, content };
}

/**
 * Which module row an authoring call changed, for mirroring its compile metadata
 * onto the host copy.
 *
 * A write learns the new row from the module's reply. An update changed the row
 * whose id went on the wire to the module — never the id the agent typed, because
 * the agent addresses notes by host ids, and those are not module row ids.
 * Deriving the target from what the module was actually asked to change keeps
 * the metadata on the note that was really updated.
 */
export function compiledNoteModuleRowId(args: {
    action: RustNoteToolRequest["action"];
    response: unknown;
    moduleNoteIds: readonly number[] | undefined;
}): number | null {
    if (args.action === "write") {
        return writtenModuleNoteId(args.response) ?? moduleNoteRowId(args.response);
    }
    return args.moduleNoteIds?.[0] ?? null;
}

/**
 * The ctx_note backend used while the module holds notes authority: translate
 * the agent's host ids at the boundary, forward the call to the module facade on
 * its host id lane, refresh the host read model, and mirror compile metadata the
 * module does not own.
 */
export function createRustNoteBackend(deps: {
    db: Database;
    module: RustNoteModuleCaller;
    /** Pull pending note changefeed pages into context.db for a project identity. */
    syncNotes: (projectPath: string) => Promise<void>;
}): (request: RustNoteToolRequest) => Promise<unknown> {
    return async ({
        commandId,
        sessionId,
        projectRoot,
        memoryProject,
        action,
        content,
        surfaceCondition,
        compiledProvider,
        compiledConfig,
        compiledAt,
        compileStatus,
        filter,
        limit,
        offset,
        noteIds,
    }) => {
        // Pull first so identities for notes written moments ago are known and
        // the ids the module renders match what the reminder shows.
        await deps.syncNotes(memoryProject);
        const routes = routeHostNoteIds({
            db: deps.db,
            projectIdentity: memoryProject,
            sessionId,
            hostIds: noteIds ?? [],
        });
        const pairs = new Map<number, number>();
        for (const route of routes) {
            if (route.kind === "module") pairs.set(route.hostId, route.moduleId);
        }
        if (action === "read" && noteIds === undefined) {
            for (const [hostId, moduleId] of projectNoteIdentityPairs(deps.db, memoryProject)) {
                pairs.set(hostId, moduleId);
            }
        }
        // The module rows this call addresses, in request order.
        const moduleNoteIds = routes.flatMap((route) =>
            route.kind === "module" ? [route.moduleId] : [],
        );
        const response = await deps.module.call({
            sessionId,
            projectRoot,
            method: "ctx_note",
            body: {
                name: "ctx_note",
                arguments: {
                    ...(commandId ? { command_id: commandId } : {}),
                    action,
                    content,
                    memory_project: memoryProject,
                    surface_condition: surfaceCondition,
                    compiled_provider: compiledProvider,
                    compiled_config: compiledConfig,
                    compiled_at: compiledAt,
                    compile_status: compileStatus,
                    filter,
                    limit,
                    offset,
                    note_ids: noteIds,
                    note_id_lane: "host",
                    note_id_map: [...pairs],
                    pending_note_ids: routes.flatMap((route) =>
                        route.kind === "pending" ? [route.hostId] : [],
                    ),
                },
            },
        });
        // The module is authoritative, but context.db remains the local
        // read model for note nudges and dashboard/RPC consumers.
        await deps.syncNotes(memoryProject);
        const failed = moduleNoteResponseIsError(response);
        if (compileStatus && !failed) {
            const moduleRowId = compiledNoteModuleRowId({ action, response, moduleNoteIds });
            if (
                moduleRowId === null ||
                !applyMirroredNoteCompileFields({
                    db: deps.db,
                    moduleProject: memoryProject,
                    moduleRowId,
                    fields: {
                        compiledProvider: compiledProvider ?? null,
                        compiledConfig: compiledConfig ?? null,
                        compiledAt: compiledAt ?? null,
                        compileStatus,
                    },
                })
            ) {
                throw new Error(
                    "Rust note was written but its host compilation metadata could not be mirrored",
                );
            }
        }
        if (action === "write" && !failed) {
            const moduleId = writtenModuleNoteId(response);
            return withWrittenHostId(
                response,
                moduleId === null ? null : hostNoteIdForModuleId(deps.db, memoryProject, moduleId),
            );
        }
        return response;
    };
}
