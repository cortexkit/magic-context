import type { Database } from "../../../shared/sqlite";
import { drainMirrorPages } from "../context-authority";
import { archiveMemory } from "../memory";
import { queueMemoryMutation } from "../storage-memory-mutation-log";
import { type LeaseAcquisition, leaseOwnershipMatches, runLeaseGuardedWrite } from "./lease";
import {
    DreamerModuleFailureError,
    type DreamerModuleRoute,
    getModuleMemoryIdentities,
} from "./module-apply";

const MODULE_ARCHIVE_BATCH_SIZE = 100;
const EXPIRED_ARCHIVE_REASON = "expired";

export function getExpiredActiveMemoryIds(
    db: Database,
    projectIdentity: string,
    now: number = Date.now(),
): number[] {
    const rows = db
        .prepare<[string, number], { id: number }>(
            `SELECT id
               FROM memories
              WHERE project_path = ?
                AND status = 'active'
                AND expires_at IS NOT NULL
                AND expires_at <= ?
              ORDER BY id`,
        )
        .all(projectIdentity, now);
    return rows.map((row) => row.id);
}

function assertSuccessfulModuleArchive(response: unknown): void {
    const result =
        response && typeof response === "object" && "result" in response
            ? (response as { result?: unknown }).result
            : response;
    if (result && typeof result === "object") {
        const record = result as { ok?: unknown; error?: unknown };
        if (record.ok === false || record.error) {
            throw new Error("module rejected expired-memory archive");
        }
    }
}

async function archiveExpiredThroughModule(args: {
    db: Database;
    projectIdentity: string;
    holderId: string;
    leaseKey: string;
    leaseAcquisition: LeaseAcquisition;
    expiredContextIds: readonly number[];
    moduleRoute: DreamerModuleRoute;
}): Promise<number> {
    if (!args.moduleRoute.moduleClient.mirrorPull) {
        throw new DreamerModuleFailureError(
            "mirror.pull expired archive",
            new Error("Rust dreamer client omitted the memory mirror route"),
        );
    }

    for (
        let offset = 0;
        offset < args.expiredContextIds.length;
        offset += MODULE_ARCHIVE_BATCH_SIZE
    ) {
        if (
            !leaseOwnershipMatches(
                args.db,
                args.holderId,
                args.leaseAcquisition.generation,
                args.leaseKey,
            )
        ) {
            throw new Error("Dream lease lost before expired-memory archive");
        }
        const contextBatch = args.expiredContextIds.slice(
            offset,
            offset + MODULE_ARCHIVE_BATCH_SIZE,
        );
        const identities = getModuleMemoryIdentities(args.db, args.projectIdentity, contextBatch);
        if (identities.size !== contextBatch.length) {
            throw new DreamerModuleFailureError(
                "ctx_memory expired archive",
                new Error("expired memory is missing its module mirror identity"),
            );
        }
        const moduleBatch = contextBatch.map((id) => {
            const identity = identities.get(id);
            if (!identity) throw new Error(`missing module identity for expired memory ${id}`);
            return identity.moduleId;
        });
        try {
            const response = await args.moduleRoute.moduleClient.call({
                sessionId: args.moduleRoute.moduleSessionId,
                projectRoot: args.moduleRoute.moduleProjectRoot,
                method: "ctx_memory",
                body: {
                    name: "ctx_memory",
                    arguments: {
                        action: "archive",
                        memory_project: args.projectIdentity,
                        ids: moduleBatch,
                        reason: EXPIRED_ARCHIVE_REASON,
                        command_id: `${args.moduleRoute.moduleCommandId}:expire:${offset / MODULE_ARCHIVE_BATCH_SIZE}`,
                    },
                },
            });
            assertSuccessfulModuleArchive(response);
        } catch (error) {
            throw new DreamerModuleFailureError("ctx_memory expired archive", error);
        }
    }

    const mirrorPull = args.moduleRoute.moduleClient.mirrorPull;
    const markerStatus = args.moduleRoute.moduleClient.markerStatus;
    const drained = await drainMirrorPages({
        db: args.db,
        module: {
            mirrorPull: (request) =>
                mirrorPull({ ...request, projectRoot: args.moduleRoute.moduleProjectRoot }),
            markerStatus: markerStatus
                ? (request) =>
                      markerStatus({
                          ...request,
                          projectRoot: args.moduleRoute.moduleProjectRoot,
                      })
                : undefined,
        },
        domain: "memories",
        projectPath: args.projectIdentity,
        limit: 1_000,
    });
    if (!drained.complete) {
        throw new DreamerModuleFailureError(
            "mirror.pull expired archive",
            new Error("memory mirror did not reach the module cursor"),
        );
    }
    if (
        !leaseOwnershipMatches(
            args.db,
            args.holderId,
            args.leaseAcquisition.generation,
            args.leaseKey,
        )
    ) {
        throw new Error("Dream lease lost during expired-memory archive");
    }
    return args.expiredContextIds.length;
}

/** Archive TTL-expired active rows through the current memory authority's archive path. */
export async function archiveExpiredMemories(args: {
    db: Database;
    projectIdentity: string;
    holderId: string;
    leaseKey: string;
    leaseAcquisition: LeaseAcquisition;
    now?: number;
    moduleRoute?: DreamerModuleRoute;
}): Promise<number> {
    const expiredContextIds = getExpiredActiveMemoryIds(args.db, args.projectIdentity, args.now);
    if (expiredContextIds.length === 0) {
        if (
            !leaseOwnershipMatches(
                args.db,
                args.holderId,
                args.leaseAcquisition.generation,
                args.leaseKey,
            )
        ) {
            throw new Error("Dream lease lost before expired-memory probe");
        }
        return 0;
    }
    if (args.moduleRoute) {
        return archiveExpiredThroughModule({
            ...args,
            expiredContextIds,
            moduleRoute: args.moduleRoute,
        });
    }

    const selectedIds = new Set(expiredContextIds);
    return runLeaseGuardedWrite(args.db, args.holderId, args.leaseKey, () => {
        const stillExpired = getExpiredActiveMemoryIds(
            args.db,
            args.projectIdentity,
            args.now,
        ).filter((id) => selectedIds.has(id));
        for (const id of stillExpired) {
            archiveMemory(args.db, id, EXPIRED_ARCHIVE_REASON);
            queueMemoryMutation(args.db, {
                projectPath: args.projectIdentity,
                mutationType: "archive",
                targetMemoryId: id,
                queuedAt: args.now,
            });
        }
        return stillExpired.length;
    });
}
