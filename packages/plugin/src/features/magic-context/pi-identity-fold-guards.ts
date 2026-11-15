import type { Database } from "../../shared/sqlite";

/**
 * Pi's once-guards for tag-identity repairs, one per repaired identity.
 *
 * A guard records that an identity (a tool call or a message part that was
 * tagged twice) has had its one repair, so the same identity is never folded
 * or rebuilt a second time. Older builds kept these guards in the session's
 * shared Pi content-decision ledger (`session_meta.merged_reasoning_stripped_ids`),
 * whose 4,096-entry cap they shared with reminder-strip and seam-temporal-strip
 * replay decisions. A session with thousands of duplicated identities filled
 * that ledger and left no room for the strip decisions. New guards live in
 * their own row of the `schema_migrations_meta` key/value table instead, so no
 * schema change is needed; guards already in the shared ledger stay valid and
 * are still read.
 *
 * The value is a JSON array of guard keys (each a JSON-encoded identity key).
 * Session deletion removes the row together with the session's metadata (see
 * storage-session-tables.ts).
 */
export const PI_IDENTITY_FOLD_GUARD_PREFIX = "pi_identity_fold_guards:";

/**
 * Guard keys are about 60 bytes for a tool call and 95 for a message part, so
 * a full row is about 1.5 MB at most. The row is read once and written once per
 * committed adoption chunk, so this bounds each of those writes. A session
 * with more duplicated identities than this leaves the rest unmerged, which
 * serves them as tagging does without a repair.
 */
export const PI_IDENTITY_FOLD_GUARD_LIMIT = 16_384;

export function piIdentityFoldGuardKey(sessionId: string): string {
    return `${PI_IDENTITY_FOLD_GUARD_PREFIX}${sessionId}`;
}

/** The session's fold guards. Throws when the stored row is not a JSON array of strings. */
export function readPiIdentityFoldGuards(db: Database, sessionId: string): Set<string> {
    const row = db
        .prepare("SELECT value FROM schema_migrations_meta WHERE key = ?")
        .get(piIdentityFoldGuardKey(sessionId)) as { value: string } | null | undefined;
    if (!row) return new Set();
    const parsed: unknown = JSON.parse(row.value);
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string"))
        throw new Error("Invalid persisted Pi identity fold guards");
    return new Set(parsed);
}

/**
 * Store `guards` as the session's complete guard set. The caller holds the
 * writer transaction it read the current set under, adds to that set, and
 * keeps it within PI_IDENTITY_FOLD_GUARD_LIMIT.
 */
export function writePiIdentityFoldGuards(
    db: Database,
    sessionId: string,
    guards: ReadonlySet<string>,
): void {
    if (guards.size > PI_IDENTITY_FOLD_GUARD_LIMIT)
        throw new Error("Pi identity fold guards exceed their limit");
    db.prepare(
        `INSERT INTO schema_migrations_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(piIdentityFoldGuardKey(sessionId), JSON.stringify([...guards]));
}
