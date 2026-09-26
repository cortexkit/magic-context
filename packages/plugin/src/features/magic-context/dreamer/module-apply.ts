import type { Database } from "../../../shared/sqlite";
import { type AuthorityModuleClient, getContextStoreUuid } from "../context-authority";
import type { ClassifyModuleClient } from "./classify";

export class DreamerModuleBusyError extends Error {
    readonly transient = true;

    constructor(readonly state: string) {
        super(
            `Rust memory authority is ${state}; dreamer mutation deferred until authority settles.`,
        );
        this.name = "DreamerModuleBusyError";
    }
}

export class DreamerModuleFailureError extends Error {
    readonly transient = true;
    constructor(operation: string, cause: unknown) {
        super(
            `Rust dreamer ${operation} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        this.name = "DreamerModuleFailureError";
        (this as Error & { cause?: unknown }).cause = cause;
    }
}

export type DreamerModuleClient = ClassifyModuleClient &
    Pick<AuthorityModuleClient, "mirrorPull" | "markerStatus">;

export interface DreamerModuleRoute {
    moduleClient: DreamerModuleClient;
    moduleSessionId: string;
    moduleProjectRoot: string;
    moduleContextStoreUuid: string;
    moduleAuthorityGeneration: number;
    moduleCommandId: string;
}

/** Resolve ownership once for every dreamer applier. A rust transform setting alone is not
 * authority: the module's durable state is the fence that prevents TS fallback writes. */
export async function resolveDreamerModuleRoute(args: {
    db: Database;
    projectIdentity: string;
    projectRoot: string;
    transformMode?: "ts" | "rust";
    moduleClient?: DreamerModuleClient & {
        authorityStatus?: (args: {
            context_store_uuid: string;
            project: string;
            projectRoot?: string;
            domain: "memories" | "notes";
        }) => Promise<{ authority: { state?: string; generation?: number } | null }>;
    };
    commandId: string;
}): Promise<DreamerModuleRoute | undefined> {
    const transport = args.transformMode === "ts" ? undefined : args.moduleClient;
    if (!transport?.authorityStatus) return undefined;
    const contextStoreUuid = getContextStoreUuid(args.db);
    if (!contextStoreUuid) throw new Error("Rust dreamer requires a context store identity");
    const result = await transport.authorityStatus({
        context_store_uuid: contextStoreUuid,
        project: args.projectIdentity,
        projectRoot: args.projectRoot,
        domain: "memories",
    });
    const authority = result.authority;
    if (authority?.state === "DRAINING") throw new DreamerModuleBusyError(authority.state);
    if (authority?.state !== "MODULE") return undefined;
    const generation = authority.generation;
    if (typeof generation !== "number") throw new Error("Rust authority status omitted generation");
    return {
        moduleClient: transport,
        moduleSessionId: args.projectIdentity,
        moduleProjectRoot: args.projectRoot,
        moduleContextStoreUuid: contextStoreUuid,
        moduleAuthorityGeneration: generation,
        moduleCommandId: args.commandId,
    };
}

export interface ModuleMemoryIdentity {
    moduleId: number;
    normalizedHash: string;
}

/** Translate context ids into module ids and use the mirrored hash captured by the host. */
export function getModuleMemoryIdentities(
    db: Database,
    projectIdentity: string,
    contextIds: readonly number[],
): Map<number, ModuleMemoryIdentity> {
    if (contextIds.length === 0) return new Map();
    const placeholders = contextIds.map(() => "?").join(", ");
    const rows = db
        .prepare(
            `SELECT identity.context_row_id, identity.module_row_id, live.normalized_hash
               FROM mirror_identity identity
               LEFT JOIN mirror_live_memory_rows live
                 ON live.module_project = identity.module_project
                AND live.module_row_id = identity.module_row_id
              WHERE identity.domain = 'memories' AND identity.module_project = ?
                AND identity.context_row_id IN (${placeholders})`,
        )
        .all(projectIdentity, ...contextIds) as Array<{
        context_row_id?: number;
        module_row_id?: number;
        normalized_hash?: string | null;
    }>;
    return new Map(
        rows.flatMap((row) =>
            Number.isInteger(row.context_row_id) &&
            Number.isInteger(row.module_row_id) &&
            typeof row.normalized_hash === "string"
                ? [
                      [
                          row.context_row_id as number,
                          {
                              moduleId: row.module_row_id as number,
                              normalizedHash: row.normalized_hash,
                          },
                      ],
                  ]
                : [],
        ),
    );
}
