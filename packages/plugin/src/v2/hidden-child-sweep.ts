import type { Database } from "../shared/sqlite";
import { isSessionNotFound } from "./hidden-child-native";

const PREFIX = "hidden_child:";
export const HIDDEN_CHILD_MAX_AGE_MS = 60 * 60 * 1000;
export const HIDDEN_CHILD_SWEEP_INTERVAL_MS = 30 * 60 * 1000;
export const HIDDEN_CHILD_DEADLINE_GRACE_MS = 10 * 60 * 1000;
const SWEEP_REMOVAL_LIMIT = 50;
const SWEEP_BUDGET_MS = 30_000;

export interface HiddenChildCleanupRecord {
    id: string;
    directory: string;
    created_at: number;
    deadline_at?: number;
    /** Set by the sweep to the wall-clock time of the latest removal attempt that failed. */
    failed_at?: number;
}

/** Root sessions have no parent to clean them up after a crash; keep a durable removal retry. */
export function recordHiddenChild(db: Database, child: HiddenChildCleanupRecord): void {
    db.prepare("INSERT INTO schema_migrations_meta (key, value) VALUES (?, ?)").run(
        `${PREFIX}${child.id}`,
        JSON.stringify(child),
    );
}

export function forgetHiddenChild(db: Database, id: string): void {
    db.prepare("DELETE FROM schema_migrations_meta WHERE key = ?").run(`${PREFIX}${id}`);
}

export function extendHiddenChildDeadline(db: Database, id: string, deadlineAt: number): void {
    db.prepare(
        `UPDATE schema_migrations_meta
         SET value = json_set(value, '$.deadline_at', MAX(COALESCE(json_extract(value, '$.deadline_at'), 0), ?))
         WHERE key = ?`,
    ).run(deadlineAt, `${PREFIX}${id}`);
}

function markHiddenChildRemovalFailed(db: Database, id: string, failedAt: number): void {
    db.prepare(
        "UPDATE schema_migrations_meta SET value = json_set(value, '$.failed_at', ?) WHERE key = ?",
    ).run(failedAt, `${PREFIX}${id}`);
}

interface SweepOptions {
    now?: number;
    maxAgeMs?: number;
    removalTimeoutMs?: number;
    limit?: number;
    budgetMs?: number;
    /** Monotonic clock for the pass budget, independent of the records' wall-clock timestamps. */
    clock?: () => number;
    isLive?: (id: string) => boolean;
    shouldStop?: () => boolean;
}

/** Start passes off the startup path; shutdown drains only the removal already in flight. */
export function createHiddenChildSweeper(
    remove: (input: { sessionID: string }) => Promise<void>,
    log: (message: string, error?: unknown) => void,
    options: SweepOptions = {},
) {
    let stopped = false;
    let running: Promise<void> | undefined;
    return {
        start(db: Database): void {
            if (stopped || running) return;
            running = sweepHiddenChildren(db, remove, log, {
                ...options,
                shouldStop: () => stopped || options.shouldStop?.() === true,
            })
                .catch((error) => log("[magic-context] hidden-child sweep failed", error))
                .finally(() => {
                    running = undefined;
                });
        },
        async dispose(): Promise<void> {
            stopped = true;
            await running;
        },
    };
}

export async function sweepHiddenChildren(
    db: Database,
    remove: (input: { sessionID: string }) => Promise<void>,
    note: (message: string) => void,
    options: SweepOptions = {},
): Promise<void> {
    const now = options.now ?? Date.now();
    const clock = options.clock ?? (() => performance.now());
    const passDeadline = clock() + (options.budgetMs ?? SWEEP_BUDGET_MS);
    let remaining = options.limit ?? SWEEP_REMOVAL_LIMIT;
    // A failed removal keeps its record and still uses up part of the pass's removal limit and
    // time budget. Records never tried come first (oldest first) and failed ones follow (oldest
    // failure first), so records that keep failing are retried without starving the rest.
    // json_valid keeps one malformed value from failing the whole query; the loop reports it.
    const rows = db
        .prepare(
            `SELECT key, value FROM (
                SELECT key, value,
                    CASE WHEN json_valid(value) THEN json_extract(value, '$.failed_at') END AS failed_at,
                    CASE WHEN json_valid(value) THEN json_extract(value, '$.created_at') END AS created_at
                FROM schema_migrations_meta WHERE key GLOB ?
            )
            ORDER BY failed_at IS NOT NULL, COALESCE(failed_at, created_at), created_at, key`,
        )
        .all(`${PREFIX}*`) as Array<{ key: string; value: string }>;
    for (const row of rows) {
        if (remaining <= 0 || clock() >= passDeadline || options.shouldStop?.()) break;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const child = JSON.parse(row.value) as HiddenChildCleanupRecord;
            if (
                !child ||
                typeof child.id !== "string" ||
                row.key !== `${PREFIX}${child.id}` ||
                typeof child.directory !== "string" ||
                !Number.isFinite(child.created_at) ||
                (child.deadline_at !== undefined && !Number.isFinite(child.deadline_at))
            )
                throw new Error(`invalid cleanup record ${row.key}`);
            // Configured runs can last longer than an hour. The durable deadline also
            // protects another process's run; local ownership protects delayed live runs.
            const expiresAt = Math.max(
                child.created_at + (options.maxAgeMs ?? HIDDEN_CHILD_MAX_AGE_MS),
                child.deadline_at === undefined
                    ? 0
                    : child.deadline_at + HIDDEN_CHILD_DEADLINE_GRACE_MS,
            );
            if (now <= expiresAt || options.isLive?.(child.id)) continue;
            remaining--;
            try {
                await Promise.race([
                    remove({ sessionID: child.id }),
                    new Promise<never>((_, reject) => {
                        timer = setTimeout(
                            () => reject(new Error("session.remove timed out")),
                            Math.min(
                                options.removalTimeoutMs ?? 5000,
                                Math.max(1, passDeadline - clock()),
                            ),
                        );
                    }),
                ]);
            } catch (error) {
                if (!isSessionNotFound(error)) {
                    try {
                        markHiddenChildRemovalFailed(db, child.id, now);
                    } catch (markError) {
                        // The mark only orders later passes; report the removal failure below.
                        note(
                            `[magic-context] hidden-child sweep could not mark ${row.key} failed: ${String(markError)}`,
                        );
                    }
                    throw error;
                }
            }
            forgetHiddenChild(db, child.id);
            note(`[magic-context] stale hidden child ${child.id} removed`);
        } catch (error) {
            note(`[magic-context] hidden-child sweep deferred ${row.key}: ${String(error)}`);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }
}
