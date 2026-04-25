import { sessionLog } from "../../../shared/logger";
import type { Database } from "../../../shared/sqlite";

export interface KeyFileEntry {
    filePath: string;
    /** Approximate token count when last pinned */
    tokens: number;
}

/**
 * Get the pinned key files for a session from session_meta.
 * Returns empty array if not set or parse fails.
 */
export function getKeyFiles(db: Database, sessionId: string): KeyFileEntry[] {
    try {
        const row = db
            .prepare("SELECT key_files FROM session_meta WHERE session_id = ?")
            .get(sessionId) as { key_files?: string | null } | null;

        if (!row?.key_files) return [];

        const parsed = JSON.parse(row.key_files);
        if (!Array.isArray(parsed)) return [];

        return parsed.filter(
            (e: unknown): e is KeyFileEntry =>
                typeof e === "object" &&
                e !== null &&
                typeof (e as KeyFileEntry).filePath === "string" &&
                typeof (e as KeyFileEntry).tokens === "number",
        );
    } catch {
        return [];
    }
}

/**
 * Set the pinned key files for a session.
 */
export function setKeyFiles(db: Database, sessionId: string, files: KeyFileEntry[]): void {
    try {
        // Ensure session_meta row exists before UPDATE — dreamer may process
        // sessions that haven't had getOrCreateSessionMeta called yet
        db.prepare("INSERT OR IGNORE INTO session_meta (session_id) VALUES (?)").run(sessionId);
        db.prepare("UPDATE session_meta SET key_files = ? WHERE session_id = ?").run(
            JSON.stringify(files),
            sessionId,
        );
    } catch (error) {
        sessionLog(sessionId, "failed to persist key files:", error);
    }
}

/**
 * Greedy-fit files into a token budget.
 * Takes files sorted by priority (dreamer's ranking) and greedily adds
 * them until the budget is exhausted. Returns the selected files.
 */
export function greedyFitFiles(
    rankedFiles: Array<{ filePath: string; tokens: number }>,
    tokenBudget: number,
): KeyFileEntry[] {
    const selected: KeyFileEntry[] = [];
    let remainingBudget = tokenBudget;

    for (const file of rankedFiles) {
        if (file.tokens <= 0) continue;
        if (file.tokens > remainingBudget) continue;

        selected.push({ filePath: file.filePath, tokens: file.tokens });
        remainingBudget -= file.tokens;

        if (remainingBudget <= 0) break;
    }

    return selected;
}
