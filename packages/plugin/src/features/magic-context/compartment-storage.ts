import { invalidateAutoEmbedSession } from "../../hooks/magic-context/embed-session-state";
import { getHarness } from "../../shared/harness";
import type { Database, Statement as PreparedStatement } from "../../shared/sqlite";
import { logSlowWriteTransaction } from "../../shared/write-transaction-timing";
import { deleteChunkEmbedBackoffForSession } from "./compartment-chunk-embedding";
import { isCompartmentLeaseHeld } from "./compartment-lease";
import { getIncrementDepthStatement } from "./compression-depth-storage";
import { isNoContentCompartment } from "./no-content-compartment";
import { queueM0Mutation } from "./storage-m0-mutation-log";
import { clearCachedM0M1 } from "./storage-meta-shared";
import { getTableColumnNames } from "./storage-schema-helpers";

const insertCompartmentStatements = new WeakMap<Database, PreparedStatement>();
const insertFactStatements = new WeakMap<Database, PreparedStatement>();

function getInsertCompartmentStatement(db: Database): PreparedStatement {
    let stmt = insertCompartmentStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, p1, p2, p3, p4, importance, episode_type, legacy, created_at, harness, start_block_index, end_block_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        insertCompartmentStatements.set(db, stmt);
    }
    return stmt;
}

function getInsertFactStatement(db: Database): PreparedStatement {
    let stmt = insertFactStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "INSERT INTO session_facts (session_id, category, content, created_at, updated_at, harness) VALUES (?, ?, ?, ?, ?, ?)",
        );
        insertFactStatements.set(db, stmt);
    }
    return stmt;
}

export interface Compartment {
    id: number;
    sessionId: string;
    sequence: number;
    startMessage: number;
    endMessage: number;
    startMessageId: string;
    endMessageId: string;
    /** NULL/absent covers a whole message; an indexed end keeps that message raw to preserve later blocks. */
    startBlockIndex?: number | null;
    endBlockIndex?: number | null;
    title: string;
    /** v2: P1 tier text (fullest). Legacy rows: flat v1 content. Always present (NOT NULL). */
    content: string;
    /** v2 paraphrase tiers (model B). NULL for legacy=1 rows. */
    p1: string | null;
    p2: string | null;
    p3: string | null;
    p4: string | null;
    /** Decay-rate signal (1-100). Defaults to 50. */
    importance: number;
    /** Comma-separated activity types (e.g. "design,feature"). NULL for legacy rows. */
    episodeType: string | null;
    /** 1 = pre-v2 flat compartment (no tiers); 0 = v2 tiered. */
    legacy: number;
    createdAt: number;
    /**
     * `unresolved` when the store-projection rebase could not re-derive this
     * compartment's ordinals, because the message its endpoint id names does not
     * exist in the projection the running host serves. Such a row keeps its
     * summary text (readable by id) but is excluded from anything that treats
     * its ordinals as positions: range recovery, injection, and the boundary.
     * Re-evaluated on every later projection change, so an endpoint that comes
     * back returns the row to `ok`.
     */
    rebaseStatus: "ok" | "unresolved";
}

export interface SessionFact {
    id: number;
    sessionId: string;
    category: string;
    content: string;
    createdAt: number;
    updatedAt: number;
}

interface CompartmentRow {
    id: number;
    session_id: string;
    sequence: number;
    start_message: number;
    end_message: number;
    start_message_id: string;
    end_message_id: string;
    start_block_index?: number | null;
    end_block_index?: number | null;
    title: string;
    content: string;
    p1: string | null;
    p2: string | null;
    p3: string | null;
    p4: string | null;
    importance: number | null;
    episode_type: string | null;
    legacy: number | null;
    created_at: number;
    rebase_status?: string | null;
}

interface SessionFactRow {
    id: number;
    session_id: string;
    category: string;
    content: string;
    created_at: number;
    updated_at: number;
}

function isStringOrNullish(v: unknown): v is string | null | undefined {
    return v === null || v === undefined || typeof v === "string";
}

function isNumberOrNullish(v: unknown): v is number | null | undefined {
    return v === null || v === undefined || typeof v === "number";
}

function isCompartmentRow(row: unknown): row is CompartmentRow {
    if (row === null || typeof row !== "object") return false;
    const candidate = row as Record<string, unknown>;
    return (
        typeof candidate.id === "number" &&
        typeof candidate.session_id === "string" &&
        typeof candidate.sequence === "number" &&
        typeof candidate.start_message === "number" &&
        typeof candidate.end_message === "number" &&
        typeof candidate.start_message_id === "string" &&
        typeof candidate.end_message_id === "string" &&
        typeof candidate.title === "string" &&
        typeof candidate.content === "string" &&
        // v2 tier columns are nullable (legacy rows store NULL). Tolerate absence
        // so a row is never rejected just for missing/null tier metadata.
        isStringOrNullish(candidate.p1) &&
        isStringOrNullish(candidate.p2) &&
        isStringOrNullish(candidate.p3) &&
        isStringOrNullish(candidate.p4) &&
        isNumberOrNullish(candidate.importance) &&
        isStringOrNullish(candidate.episode_type) &&
        isNumberOrNullish(candidate.legacy) &&
        typeof candidate.created_at === "number"
    );
}

function isSessionFactRow(row: unknown): row is SessionFactRow {
    if (row === null || typeof row !== "object") return false;
    const candidate = row as Record<string, unknown>;
    return (
        typeof candidate.id === "number" &&
        typeof candidate.session_id === "string" &&
        typeof candidate.category === "string" &&
        typeof candidate.content === "string" &&
        typeof candidate.created_at === "number" &&
        typeof candidate.updated_at === "number"
    );
}

export interface CompartmentInput {
    sequence: number;
    startMessage: number;
    endMessage: number;
    startMessageId: string;
    endMessageId: string;
    /** NULL/absent covers a whole message; an indexed end keeps that message raw to preserve later blocks. */
    startBlockIndex?: number | null;
    endBlockIndex?: number | null;
    title: string;
    /** v2: P1 tier text. Legacy/compressor inserts: flat content. */
    content: string;
    /** v2 paraphrase tiers (model B). Omitted/null for legacy or compressor inserts → stored NULL. */
    p1?: string | null;
    p2?: string | null;
    p3?: string | null;
    p4?: string | null;
    /** Decay-rate signal (1-100). Omitted → stored 50. */
    importance?: number | null;
    /** Comma-separated activity types. Omitted/null → stored NULL. */
    episodeType?: string | null;
}

function insertCompartmentRows(
    db: Database,
    sessionId: string,
    compartments: CompartmentInput[],
    now: number,
): void {
    const stmt = getInsertCompartmentStatement(db);
    for (const compartment of compartments) {
        // A compartment is v2 (legacy=0) iff it carries at least the P1 tier.
        // Compressor/legacy inserts pass no tiers → stored NULL + legacy=1.
        const hasTiers = typeof compartment.p1 === "string" && compartment.p1.length > 0;
        stmt.run(
            sessionId,
            compartment.sequence,
            compartment.startMessage,
            compartment.endMessage,
            compartment.startMessageId,
            compartment.endMessageId,
            compartment.title,
            compartment.content,
            compartment.p1 ?? null,
            compartment.p2 ?? null,
            compartment.p3 ?? null,
            compartment.p4 ?? null,
            typeof compartment.importance === "number" ? compartment.importance : 50,
            compartment.episodeType ?? null,
            hasTiers || isNoContentCompartment(compartment) ? 0 : 1,
            now,
            getHarness(),
            compartment.startBlockIndex ?? null,
            compartment.endBlockIndex ?? null,
        );
    }
    if (compartments.length > 0) invalidateAutoEmbedSession(sessionId);
}

function insertFactRows(
    db: Database,
    sessionId: string,
    facts: Array<{ category: string; content: string }>,
    now: number,
): void {
    const stmt = getInsertFactStatement(db);
    for (const fact of facts) {
        stmt.run(sessionId, fact.category, fact.content, now, now, getHarness());
    }
}

function toCompartment(row: CompartmentRow): Compartment {
    return {
        id: row.id,
        sessionId: row.session_id,
        sequence: row.sequence,
        startMessage: row.start_message,
        endMessage: row.end_message,
        startMessageId: row.start_message_id,
        endMessageId: row.end_message_id,
        ...(row.start_block_index != null ? { startBlockIndex: row.start_block_index } : {}),
        ...(row.end_block_index != null ? { endBlockIndex: row.end_block_index } : {}),
        title: row.title,
        content: row.content,
        p1: row.p1 ?? null,
        p2: row.p2 ?? null,
        p3: row.p3 ?? null,
        p4: row.p4 ?? null,
        importance: typeof row.importance === "number" ? row.importance : 50,
        episodeType: row.episode_type ?? null,
        legacy: typeof row.legacy === "number" ? row.legacy : 0,
        createdAt: row.created_at,
        rebaseStatus: row.rebase_status === "unresolved" ? "unresolved" : "ok",
    };
}

function toSessionFact(row: SessionFactRow): SessionFact {
    return {
        id: row.id,
        sessionId: row.session_id,
        category: row.category,
        content: row.content,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function getCompartments(db: Database, sessionId: string): Compartment[] {
    const presentColumns = getTableColumnNames(db, "compartments");
    const columns = [
        "id",
        "session_id",
        "sequence",
        "start_message",
        "end_message",
        "start_message_id",
        "end_message_id",
        "start_block_index",
        "end_block_index",
        "title",
        "content",
        "p1",
        "p2",
        "p3",
        "p4",
        "importance",
        "episode_type",
        "legacy",
        "created_at",
        "rebase_status",
    ].filter((column) => presentColumns.has(column));
    const rows = db
        // Retired embeddings can be several KiB per row. Only transfer the
        // fields used by validation and rendering, preserving their order.
        .prepare(`SELECT ${columns.length ? columns.join(", ") : "NULL AS id"}
            FROM compartments WHERE session_id = ? ORDER BY sequence ASC`)
        .all(sessionId)
        .filter(isCompartmentRow);
    return rows.map(toCompartment);
}

/**
 * Highest message ordinal any compartment covers — the line between compacted
 * history and the live tail.
 *
 * Rows the projection rebase could not re-derive are excluded: their stored
 * ordinals are positions in a message list the running host no longer serves,
 * so using one as the boundary would clamp recovery ranges and the protected
 * tail against an arbitrary message. Excluding them moves the boundary back to
 * the newest compartment that still resolves, which is recoverable, instead of
 * pointing confidently at the wrong place.
 */
export function getLastCompartmentEndMessage(db: Database, sessionId: string): number {
    const row = db
        .prepare(
            "SELECT MAX(end_message) as max_end FROM compartments WHERE session_id = ? AND rebase_status != 'unresolved'",
        )
        .get(sessionId) as { max_end: number | null } | null;
    return row?.max_end ?? -1;
}

/**
 * The OpenCode message id at the boundary of the highest-sequence compartment —
 * i.e. the last raw message the compartment history (m[0]+m[1]) covers. A newer
 * compartment with no stored end id (a legacy row, or one carried into a forked
 * session) cannot be placed, so the boundary is the newest compartment that has
 * one: everything up to it is covered, and the rows after it stay raw. Returns
 * null when no compartment has an end id. Used to persist the m[1]-coverage boundary so a cold post-
 * restart pass trims the live tail to what the cached summary actually covers,
 * not to the latest compartment (which may be newer than the cached m[1]).
 */
export function getLastCompartmentEndMessageId(db: Database, sessionId: string): string | null {
    const row = db
        .prepare(
            "SELECT end_message_id FROM compartments WHERE session_id = ? AND rebase_status != 'unresolved' AND end_message_id IS NOT NULL AND end_message_id != '' ORDER BY sequence DESC LIMIT 1",
        )
        .get(sessionId) as { end_message_id: string | null } | undefined;
    const id = row?.end_message_id;
    return id && id.length > 0 ? id : null;
}

/**
 * Look up compartments whose stored `end_message_id` matches the given
 * OpenCode message id. Returns an ARRAY — schema only enforces
 * `UNIQUE(session_id, sequence)`, NOT `(session_id, end_message_id)`, so
 * a future bug could in principle leave two rows sharing a boundary. The
 * marker drain's `validatePendingTarget` treats `length > 1` as a schema
 * invariant violation and bails to stale-skip (plan v6 section 5).
 *
 * Normal path: exactly one match → caller treats it as the target row.
 */
export function getCompartmentsByEndMessageId(
    db: Database,
    sessionId: string,
    endMessageId: string,
): Compartment[] {
    const rows = db
        .prepare(
            "SELECT * FROM compartments WHERE session_id = ? AND end_message_id = ? ORDER BY sequence ASC",
        )
        .all(sessionId, endMessageId)
        .filter(isCompartmentRow);
    return rows.map(toCompartment);
}

export function replaceAllCompartments(
    db: Database,
    sessionId: string,
    compartments: CompartmentInput[],
): void {
    const now = Date.now();
    db.transaction(() => {
        deleteChunkEmbedBackoffForSession(db, sessionId);
        const deleted = db.prepare("DELETE FROM compartments WHERE session_id = ?").run(sessionId);
        if (deleted.changes > 0) {
            queueM0Mutation(db, {
                sessionId,
                mutationType: "recomp_boundary_change",
                queuedAt: now,
            });
        }
        invalidateAutoEmbedSession(sessionId);
        insertCompartmentRows(db, sessionId, compartments, now);
    }).immediate();
}

/**
 * Append new compartments without deleting existing ones.
 * Used by the incremental runner where existing compartments are preserved
 * and only new compartments for the latest chunk are added.
 */
export function appendCompartments(
    db: Database,
    sessionId: string,
    compartments: CompartmentInput[],
): void {
    if (compartments.length === 0) return;
    const now = Date.now();
    db.transaction(() => {
        insertCompartmentRows(db, sessionId, compartments, now);
    }).immediate();
}

/**
 * Replace session facts without touching compartments.
 * Facts are fully re-normalized by the historian on each pass,
 * so they always need a full replacement.
 */
export function replaceSessionFacts(
    db: Database,
    sessionId: string,
    facts: Array<{ category: string; content: string }>,
): void {
    const now = Date.now();
    db.transaction(() => {
        db.prepare("DELETE FROM session_facts WHERE session_id = ?").run(sessionId);
        insertFactRows(db, sessionId, facts, now);
        clearCachedM0M1(db, sessionId);
    }).immediate();
}

export function getSessionFacts(db: Database, sessionId: string): SessionFact[] {
    const rows = db
        .prepare("SELECT * FROM session_facts WHERE session_id = ? ORDER BY category ASC, id ASC")
        .all(sessionId)
        .filter(isSessionFactRow);
    return rows.map(toSessionFact);
}

export function replaceAllCompartmentState(
    db: Database,
    sessionId: string,
    compartments: CompartmentInput[],
    facts: Array<{ category: string; content: string }>,
): void {
    const now = Date.now();
    db.transaction(() => {
        deleteChunkEmbedBackoffForSession(db, sessionId);
        const deleted = db.prepare("DELETE FROM compartments WHERE session_id = ?").run(sessionId);
        if (deleted.changes > 0) {
            queueM0Mutation(db, {
                sessionId,
                mutationType: "recomp_boundary_change",
                queuedAt: now,
            });
        }
        invalidateAutoEmbedSession(sessionId);
        db.prepare("DELETE FROM session_facts WHERE session_id = ?").run(sessionId);

        insertCompartmentRows(db, sessionId, compartments, now);
        insertFactRows(db, sessionId, facts, now);

        clearCachedM0M1(db, sessionId);
    }).immediate();
}

export function replaceAllCompartmentStateAndBumpDepth(
    db: Database,
    holderId: string,
    sessionId: string,
    compartments: CompartmentInput[],
    facts: Array<{ category: string; content: string }>,
    depthStartOrdinal: number,
    depthEndOrdinal: number,
): boolean {
    const now = Date.now();
    db.exec("BEGIN IMMEDIATE");
    const transactionStartedAt = performance.now();
    let finished = false;
    try {
        if (!isCompartmentLeaseHeld(db, sessionId, holderId)) {
            db.exec("ROLLBACK");
            finished = true;
            return false;
        }

        deleteChunkEmbedBackoffForSession(db, sessionId);
        const deleted = db.prepare("DELETE FROM compartments WHERE session_id = ?").run(sessionId);
        if (deleted.changes > 0) {
            queueM0Mutation(db, {
                sessionId,
                mutationType: "recomp_boundary_change",
                queuedAt: now,
            });
        }
        invalidateAutoEmbedSession(sessionId);
        db.prepare("DELETE FROM session_facts WHERE session_id = ?").run(sessionId);

        insertCompartmentRows(db, sessionId, compartments, now);
        insertFactRows(db, sessionId, facts, now);

        clearCachedM0M1(db, sessionId);

        if (depthEndOrdinal >= depthStartOrdinal) {
            const stmt = getIncrementDepthStatement(db);
            for (let ordinal = depthStartOrdinal; ordinal <= depthEndOrdinal; ordinal += 1) {
                stmt.run(sessionId, ordinal, getHarness());
            }
        }

        db.exec("COMMIT");
        finished = true;
        logSlowWriteTransaction("compartment_state_replace", transactionStartedAt);
        return true;
    } finally {
        if (!finished) {
            try {
                db.exec("ROLLBACK");
            } catch {
                // Transaction may already be closed by SQLite after an error.
            }
        }
    }
}

export interface CompartmentDateRanges {
    /** Map compartment id → `{ start: "YYYY-MM-DD", end: "YYYY-MM-DD" }` */
    byId: Map<number, { start: string; end: string }>;
}

export function buildCompartmentBlock(
    compartments: Compartment[],
    facts: SessionFact[],
    memoryBlock?: string,
    dateRanges?: CompartmentDateRanges,
): string {
    const lines: string[] = [];

    if (memoryBlock) {
        lines.push(memoryBlock);
        lines.push("");
    }

    for (const c of compartments) {
        if (isNoContentCompartment(c)) continue;
        const dates = dateRanges?.byId.get(c.id);
        const dateAttr = dates ? ` start-date="${dates.start}" end-date="${dates.end}"` : "";
        lines.push(
            `<compartment start="${c.startMessage}" end="${c.endMessage}"${dateAttr} title="${escapeXmlAttr(c.title)}">`,
        );
        lines.push(escapeXmlContent(c.content));
        lines.push("</compartment>");
        lines.push("");
    }

    const factsByCategory = new Map<string, string[]>();
    for (const f of facts) {
        const existing = factsByCategory.get(f.category) ?? [];
        existing.push(f.content);
        factsByCategory.set(f.category, existing);
    }

    for (const [category, items] of factsByCategory) {
        lines.push(`${category}:`);
        for (const item of items) {
            lines.push(`* ${escapeXmlContent(item)}`);
        }
        lines.push("");
    }

    return lines.join("\n").trimEnd();
}

// ── Recomp staging ──────────────────────────────────────────────────────────

export interface RecompStaging {
    compartments: CompartmentInput[];
    facts: Array<{ category: string; content: string }>;
    passCount: number;
    lastEndMessage: number;
}

/** Append one pass's results to the staging tables. */
export function saveRecompStagingPass(
    db: Database,
    sessionId: string,
    passNumber: number,
    compartments: CompartmentInput[],
    facts: Array<{ category: string; content: string }>,
): void {
    const now = Date.now();
    db.transaction(() => {
        // Facts are replaced wholesale each pass (historian rewrites full fact list)
        db.prepare("DELETE FROM recomp_facts WHERE session_id = ?").run(sessionId);

        const compartmentStmt = db.prepare(
            "INSERT OR REPLACE INTO recomp_compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, p1, p2, p3, p4, importance, episode_type, pass_number, created_at, harness, start_block_index, end_block_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        for (const c of compartments) {
            compartmentStmt.run(
                sessionId,
                c.sequence,
                c.startMessage,
                c.endMessage,
                c.startMessageId,
                c.endMessageId,
                c.title,
                c.content,
                c.p1 ?? null,
                c.p2 ?? null,
                c.p3 ?? null,
                c.p4 ?? null,
                typeof c.importance === "number" ? c.importance : 50,
                c.episodeType ?? null,
                passNumber,
                now,
                getHarness(),
                c.startBlockIndex ?? null,
                c.endBlockIndex ?? null,
            );
        }

        const factStmt = db.prepare(
            "INSERT INTO recomp_facts (session_id, category, content, pass_number, created_at, harness) VALUES (?, ?, ?, ?, ?, ?)",
        );
        for (const f of facts) {
            factStmt.run(sessionId, f.category, f.content, passNumber, now, getHarness());
        }
    }).immediate();
}

/** Read existing staging data for resume. Returns null if no staging exists. */
export function getRecompStaging(db: Database, sessionId: string): RecompStaging | null {
    const compartmentRows = db
        .prepare("SELECT * FROM recomp_compartments WHERE session_id = ? ORDER BY sequence ASC")
        .all(sessionId)
        .filter(isRecompCompartmentRow);

    if (compartmentRows.length === 0) return null;

    const compartments: CompartmentInput[] = compartmentRows.map((row) => ({
        sequence: row.sequence,
        startMessage: row.start_message,
        endMessage: row.end_message,
        startMessageId: row.start_message_id,
        endMessageId: row.end_message_id,
        ...(row.start_block_index != null ? { startBlockIndex: row.start_block_index } : {}),
        ...(row.end_block_index != null ? { endBlockIndex: row.end_block_index } : {}),
        title: row.title,
        content: row.content,
        p1: row.p1 ?? null,
        p2: row.p2 ?? null,
        p3: row.p3 ?? null,
        p4: row.p4 ?? null,
        importance: typeof row.importance === "number" ? row.importance : 50,
        episodeType: row.episode_type ?? null,
    }));

    const factRows = db
        .prepare("SELECT category, content FROM recomp_facts WHERE session_id = ?")
        .all(sessionId)
        .filter(isRecompFactRow);

    const maxPass = compartmentRows.reduce((m, r) => Math.max(m, r.pass_number), 0);
    const lastEnd = compartmentRows[compartmentRows.length - 1]?.end_message ?? 0;

    return {
        compartments,
        facts: factRows,
        passCount: maxPass,
        lastEndMessage: lastEnd,
    };
}

/** Atomically promote staging → real tables, then clear staging. */
export function promoteRecompStaging(
    db: Database,
    sessionId: string,
    holderId?: string,
): {
    compartments: CompartmentInput[];
    facts: Array<{ category: string; content: string }>;
} | null {
    const now = Date.now();
    if (!holderId) {
        return db
            .transaction(() => {
                const staging = getRecompStaging(db, sessionId);
                if (!staging || staging.compartments.length === 0) return null;

                deleteChunkEmbedBackoffForSession(db, sessionId);
                const deleted = db
                    .prepare("DELETE FROM compartments WHERE session_id = ?")
                    .run(sessionId);
                if (deleted.changes > 0) {
                    queueM0Mutation(db, {
                        sessionId,
                        mutationType: "recomp_boundary_change",
                        queuedAt: now,
                    });
                }
                invalidateAutoEmbedSession(sessionId);
                db.prepare("DELETE FROM session_facts WHERE session_id = ?").run(sessionId);
                insertCompartmentRows(db, sessionId, staging.compartments, now);
                insertFactRows(db, sessionId, staging.facts, now);
                db.prepare("DELETE FROM recomp_compartments WHERE session_id = ?").run(sessionId);
                db.prepare("DELETE FROM recomp_facts WHERE session_id = ?").run(sessionId);
                clearCachedM0M1(db, sessionId);
                return { compartments: staging.compartments, facts: staging.facts };
            })
            .immediate();
    }

    db.exec("BEGIN IMMEDIATE");
    const transactionStartedAt = performance.now();
    let finished = false;
    try {
        if (!isCompartmentLeaseHeld(db, sessionId, holderId)) {
            db.exec("ROLLBACK");
            finished = true;
            return null;
        }

        const staging = getRecompStaging(db, sessionId);
        if (!staging || staging.compartments.length === 0) {
            db.exec("ROLLBACK");
            finished = true;
            return null;
        }
        // Replace real tables
        deleteChunkEmbedBackoffForSession(db, sessionId);
        const deleted = db.prepare("DELETE FROM compartments WHERE session_id = ?").run(sessionId);
        if (deleted.changes > 0) {
            queueM0Mutation(db, {
                sessionId,
                mutationType: "recomp_boundary_change",
                queuedAt: now,
            });
        }
        invalidateAutoEmbedSession(sessionId);
        db.prepare("DELETE FROM session_facts WHERE session_id = ?").run(sessionId);

        insertCompartmentRows(db, sessionId, staging.compartments, now);
        insertFactRows(db, sessionId, staging.facts, now);

        // Clear staging
        db.prepare("DELETE FROM recomp_compartments WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM recomp_facts WHERE session_id = ?").run(sessionId);

        clearCachedM0M1(db, sessionId);

        db.exec("COMMIT");
        finished = true;
        logSlowWriteTransaction("recomp_staging_promote", transactionStartedAt);
        return { compartments: staging.compartments, facts: staging.facts };
    } finally {
        if (!finished) {
            try {
                db.exec("ROLLBACK");
            } catch {
                // Transaction may already be closed by SQLite after an error.
            }
        }
    }
}

/** Clear staging tables for a session (on cancel/abandon or after successful promote). */
export function clearRecompStaging(db: Database, sessionId: string): void {
    db.transaction(() => {
        db.prepare("DELETE FROM recomp_compartments WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM recomp_facts WHERE session_id = ?").run(sessionId);
        // Clear the partial-range marker so a future full recomp doesn't
        // resume under a partial range. Best-effort — column may not exist
        // in very old test DBs.
        try {
            db.prepare(
                "UPDATE session_meta SET recomp_partial_range_start = 0, recomp_partial_range_end = 0 WHERE session_id = ?",
            ).run(sessionId);
        } catch {
            // column missing in very old schemas — ignore
        }
    }).immediate();
}

// ── Partial recomp range marker ─────────────────────────────────────────────

/**
 * Returns the stored partial recomp range for this session, or null when the
 * active staging (if any) is for a full recomp.
 *
 * A zero-valued row means "no partial range recorded" — either no staging or
 * full-recomp staging.
 */
export function getRecompPartialRange(
    db: Database,
    sessionId: string,
): { start: number; end: number } | null {
    try {
        const row = db
            .prepare(
                "SELECT recomp_partial_range_start AS start, recomp_partial_range_end AS end FROM session_meta WHERE session_id = ?",
            )
            .get(sessionId) as { start?: number; end?: number } | null;
        const start = typeof row?.start === "number" ? row.start : 0;
        const end = typeof row?.end === "number" ? row.end : 0;
        if (start <= 0 || end <= 0) return null;
        return { start, end };
    } catch {
        return null;
    }
}

/**
 * Record the active partial recomp range. Must be called inside or alongside
 * saveRecompStagingPass so staging and range marker stay in sync.
 */
export function setRecompPartialRange(
    db: Database,
    sessionId: string,
    range: { start: number; end: number } | null,
): void {
    const start = range ? range.start : 0;
    const end = range ? range.end : 0;
    // Ensure the session_meta row exists so UPDATE takes effect. Mirrors the
    // pattern used elsewhere in this module.
    db.prepare("INSERT OR IGNORE INTO session_meta (session_id) VALUES (?)").run(sessionId);
    db.prepare(
        "UPDATE session_meta SET recomp_partial_range_start = ?, recomp_partial_range_end = ? WHERE session_id = ?",
    ).run(start, end, sessionId);
}

interface RecompCompartmentRow {
    id: number;
    session_id: string;
    sequence: number;
    start_message: number;
    end_message: number;
    start_message_id: string;
    end_message_id: string;
    start_block_index?: number | null;
    end_block_index?: number | null;
    title: string;
    content: string;
    p1: string | null;
    p2: string | null;
    p3: string | null;
    p4: string | null;
    importance: number | null;
    episode_type: string | null;
    pass_number: number;
    created_at: number;
}

function isRecompCompartmentRow(row: unknown): row is RecompCompartmentRow {
    if (row === null || typeof row !== "object") return false;
    const candidate = row as Record<string, unknown>;
    return (
        typeof candidate.id === "number" &&
        typeof candidate.session_id === "string" &&
        typeof candidate.sequence === "number" &&
        typeof candidate.start_message === "number" &&
        typeof candidate.end_message === "number" &&
        typeof candidate.start_message_id === "string" &&
        typeof candidate.end_message_id === "string" &&
        typeof candidate.title === "string" &&
        typeof candidate.content === "string" &&
        isStringOrNullish(candidate.p1) &&
        isStringOrNullish(candidate.p2) &&
        isStringOrNullish(candidate.p3) &&
        isStringOrNullish(candidate.p4) &&
        isNumberOrNullish(candidate.importance) &&
        isStringOrNullish(candidate.episode_type) &&
        typeof candidate.pass_number === "number" &&
        typeof candidate.created_at === "number"
    );
}

function isRecompFactRow(row: unknown): row is { category: string; content: string } {
    if (row === null || typeof row !== "object") return false;
    const candidate = row as Record<string, unknown>;
    return typeof candidate.category === "string" && typeof candidate.content === "string";
}

export function escapeXmlAttr(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

export function escapeXmlContent(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Return the earliest indexed end, a summary that may stop partway through a
 * message, whose remaining content is not covered by the next summary.
 * Keep that message raw unless the next summary starts on it at a later block
 * or at the next message ordinal. Historian indices mark the last covered block
 * ("last-block anchors"), not the first block of the range. Continuation need not
 * start at block 0 or end_block_index + 1; missing or unknown coverage is unsafe.
 */
export function getUncoveredCompartmentEndThrough(
    db: Database,
    sessionId: string,
    endOrdinal = Number.MAX_SAFE_INTEGER,
): { endMessageId: string; endMessage: number } | null {
    const end = getUncoveredCompartmentEndsThrough(db, sessionId, endOrdinal)[0];
    return end ? { endMessageId: end.endMessageId, endMessage: end.endMessage } : null;
}

/**
 * List summary ends that may still have unsummarized message parts. Callers use
 * these to stop history trimming, or check raw messages between summaries to
 * prove that none would be read by the historian.
 */
export function getUncoveredCompartmentEndsThrough(
    db: Database,
    sessionId: string,
    endOrdinal = Number.MAX_SAFE_INTEGER,
    afterOrdinal = -1,
): Array<{
    endMessageId: string;
    endMessage: number;
    successorStartMessageId: string | null;
    successorStartMessage: number | null;
}> {
    const rows = db
        .prepare(
            `SELECT k.end_message_id, k.end_message,
                n.start_message_id AS successor_id, n.start_message AS successor_start FROM compartments k
         LEFT JOIN compartments n ON n.session_id = k.session_id AND n.sequence = k.sequence + 1
         WHERE k.session_id = ? AND k.end_message <= ? AND k.end_message > ? AND k.end_block_index IS NOT NULL
           AND NOT COALESCE(n.sequence IS NOT NULL AND (
               (n.start_message_id = k.end_message_id AND n.start_block_index > k.end_block_index)
               OR n.start_message = k.end_message + 1), 0)
         ORDER BY k.sequence`,
        )
        .all(sessionId, endOrdinal, afterOrdinal) as Array<{
        end_message_id: string;
        end_message: number;
        successor_id: string | null;
        successor_start: number | null;
    }>;
    return rows.map((row) => ({
        endMessageId: row.end_message_id,
        endMessage: row.end_message,
        successorStartMessageId: row.successor_id,
        successorStartMessage: row.successor_start,
    }));
}

export function isPartialCompartmentEnd(
    db: Database,
    sessionId: string,
    messageId: string,
): boolean {
    return Boolean(
        db
            .prepare(
                "SELECT 1 FROM compartments WHERE session_id=? AND end_message_id=? AND end_block_index IS NOT NULL LIMIT 1",
            )
            .get(sessionId, messageId),
    );
}
