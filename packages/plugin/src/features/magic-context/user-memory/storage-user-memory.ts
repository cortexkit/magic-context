import type { Database } from "../../../shared/sqlite";

export interface UserMemoryCandidate {
    id: number;
    content: string;
    sessionId: string;
    sourceCompartmentStart: number | null;
    sourceCompartmentEnd: number | null;
    createdAt: number;
}

export interface UserMemory {
    id: number;
    content: string;
    status: "active" | "dismissed";
    promotedAt: number;
    sourceCandidateIds: number[];
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
    db.transaction(() => {
        for (const c of candidates) {
            stmt.run(
                c.content,
                c.sessionId,
                c.sourceCompartmentStart ?? null,
                c.sourceCompartmentEnd ?? null,
                now,
            );
        }
    })();
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

// ── Stable user memories ────────────────────────────────────────────────

export function insertUserMemory(
    db: Database,
    content: string,
    sourceCandidateIds: number[],
): number {
    const now = Date.now();
    const result = db
        .prepare(
            "INSERT INTO user_memories (content, status, promoted_at, source_candidate_ids, created_at, updated_at) VALUES (?, 'active', ?, ?, ?, ?)",
        )
        .run(content, now, JSON.stringify(sourceCandidateIds), now, now);
    return Number(result.lastInsertRowid);
}

export function getActiveUserMemories(db: Database): UserMemory[] {
    const rows = db
        .prepare(
            "SELECT id, content, status, promoted_at, source_candidate_ids, created_at, updated_at FROM user_memories WHERE status = 'active' ORDER BY promoted_at ASC",
        )
        .all() as Array<{
        id: number;
        content: string;
        status: string;
        promoted_at: number;
        source_candidate_ids: string;
        created_at: number;
        updated_at: number;
    }>;
    return rows.map(parseUserMemoryRow);
}

export function getAllUserMemories(db: Database): UserMemory[] {
    const rows = db
        .prepare(
            "SELECT id, content, status, promoted_at, source_candidate_ids, created_at, updated_at FROM user_memories ORDER BY created_at ASC",
        )
        .all() as Array<{
        id: number;
        content: string;
        status: string;
        promoted_at: number;
        source_candidate_ids: string;
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
    db.prepare("UPDATE user_memories SET status = 'dismissed', updated_at = ? WHERE id = ?").run(
        Date.now(),
        id,
    );
}

export function deleteUserMemory(db: Database, id: number): void {
    db.prepare("DELETE FROM user_memories WHERE id = ?").run(id);
}

function parseUserMemoryRow(row: {
    id: number;
    content: string;
    status: string;
    promoted_at: number;
    source_candidate_ids: string;
    created_at: number;
    updated_at: number;
}): UserMemory {
    let candidateIds: number[] = [];
    try {
        candidateIds = JSON.parse(row.source_candidate_ids);
    } catch {
        // Intentional: corrupted JSON shouldn't crash reads
    }
    return {
        id: row.id,
        content: row.content,
        status: row.status === "dismissed" ? "dismissed" : "active",
        promotedAt: row.promoted_at,
        sourceCandidateIds: candidateIds,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
