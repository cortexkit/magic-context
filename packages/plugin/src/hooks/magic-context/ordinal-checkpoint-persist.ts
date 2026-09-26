import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { MODULE_ORDINAL_PAGE_SIZE, type OrdinalMemoCheckpoint } from "./module-wire";

/**
 * Durable page checkpoints of the Rust adapter's ordinal walk.
 *
 * The adapter maps OpenCode message ids to absolute ordinals by walking the host store
 * in (time_created, id) order. The mapping lives in memory, so a fresh process used to
 * re-read every stored row of the session on its first pass (tens of seconds on a
 * six-figure-row session). Persisting a sparse set of the walk's page checkpoints lets
 * the first pass start from the newest one and read only the rows after it.
 *
 * Checkpoints are stored in the host store's own numbering, without the continuation
 * base a converted session adds: a fresh process learns that base from the module only
 * after its first pass, exactly as it does after a cold full read. Nothing here is
 * trusted on load; `restoreOrdinalMemoFromCheckpoints` validates against the store.
 */

const FORMAT_VERSION = 1;
/** Newest checkpoints kept; an older wire start falls back to reading from the first row. */
export const MAX_PERSISTED_ORDINAL_CHECKPOINTS = 1024;

/**
 * Keep one checkpoint per `spacing` stored rows, plus the newest, capped to the newest
 * `max`. The in-memory list gains a checkpoint for every page any pass reads (often one
 * row), so persisting it unthinned would grow with the number of passes.
 */
export function thinOrdinalCheckpoints(
    checkpoints: readonly OrdinalMemoCheckpoint[],
    spacing: number = MODULE_ORDINAL_PAGE_SIZE,
    max: number = MAX_PERSISTED_ORDINAL_CHECKPOINTS,
): OrdinalMemoCheckpoint[] {
    const ordered = [...checkpoints].sort((left, right) => left.storedCount - right.storedCount);
    const kept: OrdinalMemoCheckpoint[] = [];
    for (let index = 0; index < ordered.length; index += 1) {
        const checkpoint = ordered[index];
        const previous = kept.at(-1);
        const isNewest = index === ordered.length - 1;
        if (previous !== undefined && checkpoint.storedCount <= previous.storedCount) continue;
        if (
            isNewest ||
            previous === undefined ||
            checkpoint.storedCount - previous.storedCount >= spacing
        ) {
            kept.push(checkpoint);
        }
    }
    return kept.slice(-max);
}

function parseCheckpoints(value: unknown): OrdinalMemoCheckpoint[] | null {
    if (typeof value !== "string") return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as { version?: unknown; checkpoints?: unknown };
    if (record.version !== FORMAT_VERSION || !Array.isArray(record.checkpoints)) return null;
    const result: OrdinalMemoCheckpoint[] = [];
    for (const entry of record.checkpoints) {
        if (!Array.isArray(entry) || entry.length !== 4) return null;
        const [timeCreated, id, storedCount, canonicalCount] = entry as unknown[];
        if (
            typeof timeCreated !== "number" ||
            !Number.isFinite(timeCreated) ||
            typeof id !== "string" ||
            id.length === 0 ||
            typeof storedCount !== "number" ||
            !Number.isSafeInteger(storedCount) ||
            storedCount < 1 ||
            typeof canonicalCount !== "number" ||
            !Number.isSafeInteger(canonicalCount) ||
            canonicalCount < 0
        ) {
            return null;
        }
        result.push({ anchor: { timeCreated, id }, storedCount, canonicalCount });
    }
    return result;
}

/** Persisted checkpoints for the session, oldest first; empty when absent or unreadable. */
export function loadPersistedOrdinalCheckpoints(
    db: Database,
    sessionId: string,
): OrdinalMemoCheckpoint[] {
    let row: { checkpoints_json?: unknown } | null;
    try {
        row = db
            .prepare("SELECT checkpoints_json FROM rust_ordinal_checkpoints WHERE session_id = ?")
            .get(sessionId) as { checkpoints_json?: unknown } | null;
    } catch (error) {
        sessionLog(sessionId, "rust ordinal checkpoint load failed (full read instead):", error);
        return [];
    }
    if (!row) return [];
    const checkpoints = parseCheckpoints(row.checkpoints_json);
    if (checkpoints === null) {
        sessionLog(sessionId, "rust ordinal checkpoints unreadable; discarding the stored row");
        clearPersistedOrdinalCheckpoints(db, sessionId);
        return [];
    }
    return checkpoints;
}

/** Replace the session's persisted checkpoints. Best-effort: a failure only costs a later full read. */
export function savePersistedOrdinalCheckpoints(
    db: Database,
    sessionId: string,
    checkpoints: readonly OrdinalMemoCheckpoint[],
    nowMs: number = Date.now(),
): boolean {
    const json = JSON.stringify({
        version: FORMAT_VERSION,
        checkpoints: checkpoints.map((checkpoint) => [
            checkpoint.anchor.timeCreated,
            checkpoint.anchor.id,
            checkpoint.storedCount,
            checkpoint.canonicalCount,
        ]),
    });
    try {
        db.prepare(
            `INSERT INTO rust_ordinal_checkpoints (session_id, checkpoints_json, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(session_id) DO UPDATE SET
                 checkpoints_json = excluded.checkpoints_json,
                 updated_at = excluded.updated_at`,
        ).run(sessionId, json, nowMs);
        return true;
    } catch (error) {
        sessionLog(sessionId, "rust ordinal checkpoint persistence failed (ignored):", error);
        return false;
    }
}

export function clearPersistedOrdinalCheckpoints(db: Database, sessionId: string): void {
    try {
        db.prepare("DELETE FROM rust_ordinal_checkpoints WHERE session_id = ?").run(sessionId);
    } catch (error) {
        sessionLog(sessionId, "rust ordinal checkpoint clear failed:", error);
    }
}

/**
 * Persist the adapter's in-memory checkpoints when they have moved on enough to matter:
 * a page of new rows since the last write, a shrunken store, or `rebuilt` (the pass
 * primed or rewound, so the persisted set may name checkpoints that no longer hold).
 * Returns the stored-row count now persisted through, or `persistedThrough` unchanged.
 */
export function persistOrdinalCheckpointsIfDue(args: {
    db: Database;
    sessionId: string;
    checkpoints: readonly OrdinalMemoCheckpoint[];
    /** Continuation base already folded into `checkpoints`, removed before storing. */
    continuationBase: number | null;
    persistedThrough: number | null;
    rebuilt: boolean;
}): number | null {
    const newest = args.checkpoints.at(-1);
    if (!newest) return args.persistedThrough;
    const through = args.persistedThrough;
    if (
        !args.rebuilt &&
        through !== null &&
        newest.storedCount >= through &&
        newest.storedCount - through < MODULE_ORDINAL_PAGE_SIZE
    ) {
        return through;
    }
    const offset = args.continuationBase ?? 0;
    const raw = thinOrdinalCheckpoints(args.checkpoints).map((checkpoint) => ({
        anchor: checkpoint.anchor,
        storedCount: checkpoint.storedCount,
        canonicalCount: checkpoint.canonicalCount - offset,
    }));
    if (raw.some((checkpoint) => checkpoint.canonicalCount < 0)) return through;
    return savePersistedOrdinalCheckpoints(args.db, args.sessionId, raw)
        ? newest.storedCount
        : through;
}
