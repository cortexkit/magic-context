import type { Database } from "../../../shared/sqlite";
import { logSlowWriteTransaction } from "../../../shared/write-transaction-timing";

/**
 * Default candidate decay TTL (30 days). review-user-memories runs daily with a
 * default promotion_threshold of 3, and genuine user traits recur over days-to-
 * weeks, so 30d leaves ample room for a real pattern to accumulate its variants
 * while pruning one-off noise that never recurs. Tune if promotion starves.
 */
export const USER_MEMORY_CANDIDATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface UserMemoryCandidate {
    id: number;
    content: string;
    sessionId: string;
    sourceCompartmentStart: number | null;
    sourceCompartmentEnd: number | null;
    createdAt: number;
}

export interface UserMemorySourceProvenance {
    candidateId: number;
    sessionId: string;
    sourceCompartmentStart: number | null;
    sourceCompartmentEnd: number | null;
}

export interface UserMemory {
    id: number;
    content: string;
    status: "active" | "dismissed";
    promotedAt: number;
    sourceCandidateIds: number[];
    sourceProvenance: UserMemorySourceProvenance[] | null;
    createdAt: number;
    updatedAt: number;
}

// ── Candidates ──────────────────────────────────────────────────────────

export function insertUserMemoryCandidates(
    db: Database,
    candidates: Array<{
        content: string;
        sessionId: string;
        sourceCompartmentStart?: number;
        sourceCompartmentEnd?: number;
    }>,
): void {
    if (candidates.length === 0) return;
    const now = Date.now();
    const stmt = db.prepare(
        "INSERT INTO user_memory_candidates (content, session_id, source_compartment_start, source_compartment_end, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    let transactionStartedAt = 0;
    db.transaction(() => {
        transactionStartedAt = performance.now();
        for (const c of candidates) {
            stmt.run(
                c.content,
                c.sessionId,
                c.sourceCompartmentStart ?? null,
                c.sourceCompartmentEnd ?? null,
                now,
            );
        }
    }).immediate();
    logSlowWriteTransaction("user_memory_candidate_insert", transactionStartedAt);
}

export function getUserMemoryCandidates(db: Database): UserMemoryCandidate[] {
    const rows = db
        .prepare(
            "SELECT id, content, session_id, source_compartment_start, source_compartment_end, created_at FROM user_memory_candidates ORDER BY created_at ASC",
        )
        .all() as Array<{
        id: number;
        content: string;
        session_id: string;
        source_compartment_start: number | null;
        source_compartment_end: number | null;
        created_at: number;
    }>;
    return rows.map((r) => ({
        id: r.id,
        content: r.content,
        sessionId: r.session_id,
        sourceCompartmentStart: r.source_compartment_start,
        sourceCompartmentEnd: r.source_compartment_end,
        createdAt: r.created_at,
    }));
}

export function deleteUserMemoryCandidates(db: Database, ids: number[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(`DELETE FROM user_memory_candidates WHERE id IN (${placeholders})`).run(...ids);
}

/**
 * Time-based decay: drop candidate observations older than the TTL that never
 * accumulated enough corroborating variants to be promoted. Without this, a
 * one-off observation that never recurs sits in the pool forever (review only
 * consumes candidates when the pool reaches the promotion threshold, so an
 * under-threshold trickle of noise accrues indefinitely). The TTL must comfortably
 * exceed promotion_threshold × the typical recurrence interval of a real trait so
 * decay prunes only noise, never a slow-but-genuine pattern mid-accumulation.
 * Returns rows pruned.
 */
export function pruneExpiredUserMemoryCandidates(
    db: Database,
    ttlMs: number,
    now: number = Date.now(),
): number {
    const cutoff = now - ttlMs;
    const result = db
        .prepare("DELETE FROM user_memory_candidates WHERE created_at < ?")
        .run(cutoff);
    return Number(result.changes ?? 0);
}

// ── Stable user memories ────────────────────────────────────────────────

function loadUserMemorySourceProvenance(
    db: Database,
    candidateIds: number[],
): UserMemorySourceProvenance[] {
    const ids = [...new Set(candidateIds)].sort((a, b) => a - b);
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = db
        .prepare(
            `SELECT id, session_id, source_compartment_start, source_compartment_end
               FROM user_memory_candidates
              WHERE id IN (${placeholders})
              ORDER BY id ASC`,
        )
        .all(...ids) as Array<{
        id: number;
        session_id: string;
        source_compartment_start: number | null;
        source_compartment_end: number | null;
    }>;
    return rows.map((row) => ({
        candidateId: row.id,
        sessionId: row.session_id,
        sourceCompartmentStart: row.source_compartment_start,
        sourceCompartmentEnd: row.source_compartment_end,
    }));
}

function serializeUserMemorySourceProvenance(
    provenance: UserMemorySourceProvenance[],
    sourceCandidateIds: number[],
): string | null {
    if (provenance.length === 0 && sourceCandidateIds.length > 0) return null;
    return JSON.stringify(
        provenance.map((source) => ({
            candidate_id: source.candidateId,
            session_id: source.sessionId,
            source_compartment_start: source.sourceCompartmentStart,
            source_compartment_end: source.sourceCompartmentEnd,
        })),
    );
}

export function insertUserMemory(
    db: Database,
    content: string,
    sourceCandidateIds: number[],
): number {
    return db
        .transaction(() => {
            const now = Date.now();
            const sourceProvenance = loadUserMemorySourceProvenance(db, sourceCandidateIds);
            const result = db
                .prepare(
                    `INSERT INTO user_memories
                    (content, status, promoted_at, source_candidate_ids, source_candidate_provenance, created_at, updated_at)
                 VALUES (?, 'active', ?, ?, ?, ?, ?)`,
                )
                .run(
                    content,
                    now,
                    JSON.stringify(sourceCandidateIds),
                    serializeUserMemorySourceProvenance(sourceProvenance, sourceCandidateIds),
                    now,
                    now,
                );
            return Number(result.lastInsertRowid);
        })
        .immediate();
}

export function getActiveUserMemories(db: Database): UserMemory[] {
    const rows = db
        .prepare(
            // id ASC tiebreaker: promoted_at can tie at millisecond granularity;
            // without a stable secondary sort the <user-profile> render order is
            // non-deterministic across passes, drifting m[0]/m[1] bytes.
            "SELECT id, content, status, promoted_at, source_candidate_ids, source_candidate_provenance, created_at, updated_at FROM user_memories WHERE status = 'active' ORDER BY promoted_at ASC, id ASC",
        )
        .all() as Array<{
        id: number;
        content: string;
        status: string;
        promoted_at: number;
        source_candidate_ids: string;
        source_candidate_provenance: string | null;
        created_at: number;
        updated_at: number;
    }>;
    return rows.map(parseUserMemoryRow);
}

export function updateUserMemoryContent(db: Database, id: number, content: string): void {
    db.prepare("UPDATE user_memories SET content = ?, updated_at = ? WHERE id = ?").run(
        content,
        Date.now(),
        id,
    );
}

export function dismissUserMemory(db: Database, id: number): void {
    // Only active-to-dismissed transitions should rewrite the timestamp; repeats leave the profile unchanged.
    db.prepare(
        "UPDATE user_memories SET status = 'dismissed', updated_at = ? WHERE id = ? AND status = 'active'",
    ).run(Date.now(), id);
}

export function restoreUserMemory(db: Database, id: number): void {
    db.prepare(
        "UPDATE user_memories SET status = 'active', updated_at = ? WHERE id = ? AND status = 'dismissed'",
    ).run(Date.now(), id);
}

function parseCandidateIds(raw: string): number[] {
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed)
            ? parsed.filter((id): id is number => typeof id === "number" && Number.isFinite(id))
            : [];
    } catch {
        return [];
    }
}

function parseUserMemorySourceProvenance(raw: string | null): UserMemorySourceProvenance[] | null {
    if (raw === null) return null;
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return null;
        const provenance: UserMemorySourceProvenance[] = [];
        for (const value of parsed) {
            if (!value || typeof value !== "object") return null;
            const source = value as Record<string, unknown>;
            if (
                typeof source.candidate_id !== "number" ||
                !Number.isFinite(source.candidate_id) ||
                typeof source.session_id !== "string" ||
                (source.source_compartment_start !== null &&
                    typeof source.source_compartment_start !== "number") ||
                (source.source_compartment_end !== null &&
                    typeof source.source_compartment_end !== "number")
            ) {
                return null;
            }
            provenance.push({
                candidateId: source.candidate_id,
                sessionId: source.session_id,
                sourceCompartmentStart: source.source_compartment_start as number | null,
                sourceCompartmentEnd: source.source_compartment_end as number | null,
            });
        }
        return provenance;
    } catch {
        return null;
    }
}

function parseUserMemoryRow(row: {
    id: number;
    content: string;
    status: string;
    promoted_at: number;
    source_candidate_ids: string;
    source_candidate_provenance: string | null;
    created_at: number;
    updated_at: number;
}): UserMemory {
    return {
        id: row.id,
        content: row.content,
        status: row.status === "dismissed" ? "dismissed" : "active",
        promotedAt: row.promoted_at,
        sourceCandidateIds: parseCandidateIds(row.source_candidate_ids),
        sourceProvenance: parseUserMemorySourceProvenance(row.source_candidate_provenance),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
