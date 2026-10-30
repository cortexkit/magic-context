import type { Database } from "../shared/sqlite";
import { isSessionNotFound } from "./hidden-child-native";

const PREFIX = "opencode2_hidden_children:";
const COMPLETE = "opencode2_hidden_children_cleanup_complete";

type LegacyRecord = {
    active?: Record<string, { id: string }>;
    retired_children?: Array<{ id: string }>;
};

/** Drain old bookkeeping through the host, never by editing the host database. */
export async function cleanupLegacyHiddenChildren(
    db: Database,
    remove: (input: { sessionID: string }) => Promise<void>,
    note: (message: string) => void,
    options: { limit?: number; timeoutMs?: number; budgetMs?: number; now?: () => number } = {},
): Promise<void> {
    if (db.prepare("SELECT 1 FROM schema_migrations_meta WHERE key = ?").get(COMPLETE)) return;
    const rows = db
        .prepare(
            "SELECT key, value FROM schema_migrations_meta WHERE key GLOB ? ORDER BY key LIMIT 25",
        )
        .all(`${PREFIX}*`) as Array<{ key: string; value: string }>;
    let remaining = options.limit ?? 25;
    const now = options.now ?? (() => performance.now());
    const deadline = now() + (options.budgetMs ?? 2000);
    for (const row of rows) {
        let record: LegacyRecord;
        try {
            record = JSON.parse(row.value) as LegacyRecord;
            if (
                !record ||
                typeof record !== "object" ||
                (record.active !== undefined &&
                    (!record.active ||
                        typeof record.active !== "object" ||
                        Array.isArray(record.active))) ||
                (record.retired_children !== undefined && !Array.isArray(record.retired_children))
            )
                throw new Error("invalid record");
        } catch {
            note(`[magic-context] legacy hidden-child cleanup cannot read ${row.key}`);
            continue;
        }
        const children = [
            ...Object.values(record.active ?? {}),
            ...(record.retired_children ?? []),
        ];
        for (const child of children) {
            if (remaining-- <= 0 || now() >= deadline) return;
            if (typeof child?.id !== "string") {
                note(
                    `[magic-context] legacy hidden-child cleanup has an invalid child in ${row.key}`,
                );
                continue;
            }
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                try {
                    await Promise.race([
                        remove({ sessionID: child.id }),
                        new Promise<never>((_, reject) => {
                            timer = setTimeout(
                                () => reject(new Error("session.remove timed out")),
                                Math.min(options.timeoutMs ?? 1000, Math.max(1, deadline - now())),
                            );
                        }),
                    ]);
                    note(`[magic-context] legacy hidden child ${child.id} removed`);
                } catch (error) {
                    if (!isSessionNotFound(error)) throw error;
                }
                // Persist after each removal so interruption only retries idempotent host calls.
                record.active = Object.fromEntries(
                    Object.entries(record.active ?? {}).filter(
                        ([, entry]) => entry.id !== child.id,
                    ),
                );
                record.retired_children = (record.retired_children ?? []).filter(
                    (entry) => entry.id !== child.id,
                );
                db.prepare("UPDATE schema_migrations_meta SET value = ? WHERE key = ?").run(
                    JSON.stringify(record),
                    row.key,
                );
            } catch (error) {
                note(
                    `[magic-context] legacy hidden child ${child.id} cleanup deferred: ${String(error)}`,
                );
            } finally {
                if (timer) clearTimeout(timer);
            }
        }
        if (
            Object.keys(record.active ?? {}).length === 0 &&
            (record.retired_children ?? []).length === 0
        )
            db.prepare("DELETE FROM schema_migrations_meta WHERE key = ?").run(row.key);
    }
    if (
        !db
            .prepare("SELECT 1 FROM schema_migrations_meta WHERE key GLOB ? LIMIT 1")
            .get(`${PREFIX}*`)
    )
        db.prepare(
            "INSERT OR IGNORE INTO schema_migrations_meta (key, value) VALUES (?, 'true')",
        ).run(COMPLETE);
}
