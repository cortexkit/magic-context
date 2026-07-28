import { getPersistedSchemaVersion } from "@magic-context/core/features/magic-context/storage-db";
import {
    doctorRekeyV22DirIdentity,
    doctorRetryV22Backfill,
    getV22BackfillStatus,
} from "@magic-context/core/features/magic-context/v22-deferred-backfill";
import type { Database } from "@magic-context/core/shared/sqlite";

export interface V22BackfillCommandArgs {
    checkV22Backfill?: boolean;
    retryV22Backfill?: boolean;
    rekeyV22DirIdentity?: string | null;
}

export interface V22BackfillCommandHarness {
    name: string;
    openDatabase(readonly?: boolean): Database | null;
    closeDatabase?(): void;
    log: {
        info(message: string): void;
        success(message: string): void;
        warn(message: string): void;
        error(message: string): void;
    };
}

export interface V22BackfillCommandResult {
    handled: boolean;
    exitCode: number;
}

export function hasV22Command(args: V22BackfillCommandArgs): boolean {
    return (
        args.checkV22Backfill === true ||
        args.retryV22Backfill === true ||
        args.rekeyV22DirIdentity !== undefined
    );
}

export async function runV22BackfillCommands(
    harness: V22BackfillCommandHarness,
    args: V22BackfillCommandArgs,
): Promise<V22BackfillCommandResult> {
    if (!hasV22Command(args)) {
        return { handled: false, exitCode: 0 };
    }

    let db: Database | null = null;
    try {
        // Status checks are read-only; repairs modify the database and must reject
        // older schemas so they do not upgrade a database beyond the schema version
        // that a running harness can support.
        const readonly = !args.retryV22Backfill && args.rekeyV22DirIdentity === undefined;
        db = harness.openDatabase(readonly);
        if (!db) {
            harness.log.error(`Could not open the ${harness.name} Magic Context database.`);
            return { handled: true, exitCode: 1 };
        }
        const schemaVersionBefore = getPersistedSchemaVersion(db);

        if (args.checkV22Backfill) {
            const status = getV22BackfillStatus(db);
            harness.log.info(
                `v22 backfill status: ${status.status}; failures=${status.failureCount}; cursor=${status.cursor}; max_legacy_memory_id=${status.maxLegacyMemoryId}`,
            );
            if (status.failureCount > 0) {
                harness.log.warn(
                    `Run doctor --retry-v22-backfill after fixing filesystem/git issues. Large retries yield every 5 rows (batch size 25) to keep the CLI responsive.`,
                );
            }
        }

        if (args.retryV22Backfill) {
            const result = await doctorRetryV22Backfill(db);
            if (result.attempted === 0) {
                harness.log.info("No v22 backfill failures to retry.");
            } else if (result.failed > 0) {
                harness.log.warn(
                    `Retry complete: ${result.succeeded} succeeded, ${result.failed} still failing, ${result.skipped} skipped; status=${result.status}.`,
                );
            } else {
                harness.log.success(
                    `Retry complete: ${result.succeeded} succeeded, ${result.skipped} skipped; status=${result.status}.`,
                );
            }
        }

        if (args.rekeyV22DirIdentity !== undefined) {
            const rawProjectPath = args.rekeyV22DirIdentity?.trim() ?? "";
            if (rawProjectPath.length === 0) {
                harness.log.error("--rekey-v22-dir-identity requires a project path.");
                return { handled: true, exitCode: 1 };
            }
            const result = await doctorRekeyV22DirIdentity(db, rawProjectPath);
            harness.log.success(
                `Re-keyed ${result.changedRows} row(s): ${result.oldIdentity} → ${result.newIdentity}.`,
            );
        }

        const schemaVersionAfter = getPersistedSchemaVersion(db);
        harness.log.info(`Magic Context schema: v${schemaVersionBefore} → v${schemaVersionAfter}`);
        if (!readonly) {
            harness.log.warn(
                "If OpenCode, Pi, or OMP is running, restart it before creating new sessions so every process reloads the same schema fence.",
            );
        }
        return { handled: true, exitCode: 0 };
    } catch (error) {
        harness.log.error(error instanceof Error ? error.message : String(error));
        return { handled: true, exitCode: 1 };
    } finally {
        try {
            harness.closeDatabase?.();
        } catch {
            // Best effort: doctor output is already complete.
        }
    }
}
