import type { Database } from "../shared/sqlite";
import { isSessionNotFound } from "./hidden-child-native";

const PREFIX = "hidden_child:";
export const HIDDEN_CHILD_MAX_AGE_MS = 60 * 60 * 1000;
export const HIDDEN_CHILD_SWEEP_INTERVAL_MS = 30 * 60 * 1000;

export interface HiddenChildCleanupRecord {
    id: string;
    directory: string;
    created_at: number;
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

export async function sweepHiddenChildren(
    db: Database,
    remove: (input: { sessionID: string }) => Promise<void>,
    note: (message: string) => void,
    options: { now?: number; maxAgeMs?: number; removalTimeoutMs?: number } = {},
): Promise<void> {
    const cutoff = (options.now ?? Date.now()) - (options.maxAgeMs ?? HIDDEN_CHILD_MAX_AGE_MS);
    const rows = db
        .prepare("SELECT key, value FROM schema_migrations_meta WHERE key GLOB ?")
        .all(`${PREFIX}*`) as Array<{ key: string; value: string }>;
    for (const row of rows) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const child = JSON.parse(row.value) as HiddenChildCleanupRecord;
            if (
                !child ||
                typeof child.id !== "string" ||
                row.key !== `${PREFIX}${child.id}` ||
                typeof child.directory !== "string" ||
                !Number.isFinite(child.created_at)
            )
                throw new Error(`invalid cleanup record ${row.key}`);
            // The one-hour grace is longer than a hidden run's twenty-minute deadline,
            // including when another plugin instance still owns the run.
            if (child.created_at >= cutoff) continue;
            try {
                await Promise.race([
                    remove({ sessionID: child.id }),
                    new Promise<never>((_, reject) => {
                        timer = setTimeout(
                            () => reject(new Error("session.remove timed out")),
                            options.removalTimeoutMs ?? 5000,
                        );
                    }),
                ]);
            } catch (error) {
                if (!isSessionNotFound(error)) throw error;
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
