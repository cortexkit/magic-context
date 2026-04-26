import { getHarness } from "../../shared/harness";
import type { Database, Statement as PreparedStatement } from "../../shared/sqlite";

const insertCompartmentStatements = new WeakMap<Database, PreparedStatement>();
const insertFactStatements = new WeakMap<Database, PreparedStatement>();

function getInsertCompartmentStatement(db: Database): PreparedStatement {
    let stmt = insertCompartmentStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, created_at, harness) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
    title: string;
    content: string;
    createdAt: number;
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
    title: string;
    content: string;
    created_at: number;
}

interface SessionFactRow {
    id: number;
    session_id: string;
    category: string;
    content: string;
    created_at: number;
    updated_at: number;
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
    title: string;
    content: string;
}

function insertCompartmentRows(
    db: Database,
    sessionId: string,
    compartments: CompartmentInput[],
    now: number,
): void {
    const stmt = getInsertCompartmentStatement(db);
    for (const compartment of compartments) {
        stmt.run(
            sessionId,
            compartment.sequence,
            compartment.startMessage,
            compartment.endMessage,
            compartment.startMessageId,
            compartment.endMessageId,
            compartment.title,
            compartment.content,
            now,
            getHarness(),
        );
    }
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
        title: row.title,
        content: row.content,
        createdAt: row.created_at,
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
    const rows = db
        // Audit note: SELECT * is intentional — compartments table is owned by this plugin, columns are
        // validated by isCompartmentRow(), and all columns are needed for rendering and validation.
        .prepare("SELECT * FROM compartments WHERE session_id = ? ORDER BY sequence ASC")
        .all(sessionId)
        .filter(isCompartmentRow);
    return rows.map(toCompartment);
}

export function getLastCompartmentEndMessage(db: Database, sessionId: string): number {
    const row = db
        .prepare("SELECT MAX(end_message) as max_end FROM compartments WHERE session_id = ?")
        .get(sessionId) as { max_end: number | null } | null;
    return row?.max_end ?? -1;
}

export function replaceAllCompartments(
    db: Database,
    sessionId: string,
    compartments: CompartmentInput[],
): void {
    const now = Date.now();
    db.transaction(() => {
        db.prepare("DELETE FROM compartments WHERE session_id = ?").run(sessionId);
        insertCompartmentRows(db, sessionId, compartments, now);
    })();
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
    })();
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
        // Clear cached injection block so next pass renders fresh — preserve memory_block_count
        // because memories didn't change (only facts), and the dashboard reads count between busts.
        // Clear memory_block_ids alongside so ctx_search's visible-memory filter doesn't use stale IDs
        // during the short window between invalidation and the next render.
        db.prepare(
            "UPDATE session_meta SET memory_block_cache = '', memory_block_ids = '' WHERE session_id = ?",
        ).run(sessionId);
    })();
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
        db.prepare("DELETE FROM compartments WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM session_facts WHERE session_id = ?").run(sessionId);

        insertCompartmentRows(db, sessionId, compartments, now);
        insertFactRows(db, sessionId, facts, now);

        // Clear cached injection block so next pass renders fresh — preserve memory_block_count
        // because memories didn't change (only compartments/facts), and the dashboard reads count between busts.
        // Clear memory_block_ids alongside so the visible-memory filter doesn't use stale IDs.
        db.prepare(
            "UPDATE session_meta SET memory_block_cache = '', memory_block_ids = '' WHERE session_id = ?",
        ).run(sessionId);
    })();
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
            "INSERT OR REPLACE INTO recomp_compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, pass_number, created_at, harness) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
                passNumber,
                now,
                getHarness(),
            );
        }

        const factStmt = db.prepare(
            "INSERT INTO recomp_facts (session_id, category, content, pass_number, created_at, harness) VALUES (?, ?, ?, ?, ?, ?)",
        );
        for (const f of facts) {
            factStmt.run(sessionId, f.category, f.content, passNumber, now, getHarness());
        }
    })();
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
        title: row.title,
        content: row.content,
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
): {
    compartments: CompartmentInput[];
    facts: Array<{ category: string; content: string }>;
} | null {
    const now = Date.now();
    return db.transaction(() => {
        const staging = getRecompStaging(db, sessionId);
        if (!staging || staging.compartments.length === 0) return null;
        // Replace real tables
        db.prepare("DELETE FROM compartments WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM session_facts WHERE session_id = ?").run(sessionId);

        insertCompartmentRows(db, sessionId, staging.compartments, now);
        insertFactRows(db, sessionId, staging.facts, now);

        // Clear staging
        db.prepare("DELETE FROM recomp_compartments WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM recomp_facts WHERE session_id = ?").run(sessionId);

        // Clear cached injection block — preserve memory_block_count (memories didn't change)
        db.prepare("UPDATE session_meta SET memory_block_cache = '' WHERE session_id = ?").run(
            sessionId,
        );

        return { compartments: staging.compartments, facts: staging.facts };
    })();
}

/**
 * Clear memory_block_cache for ALL sessions so every active session
 * re-renders its memory block on the next cache-busting pass.
 * Called after ctx_memory write/delete mutations.
 */
export function invalidateAllMemoryBlockCaches(db: Database): void {
    try {
        // Clear both memory_block_cache and memory_block_ids so ctx_search's
        // visible-memory filter can't use stale IDs either.
        db.prepare(
            "UPDATE session_meta SET memory_block_cache = '', memory_block_ids = '' WHERE memory_block_cache != '' OR memory_block_ids != ''",
        ).run();
    } catch {
        // Best-effort — session_meta may not exist in test environments
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
    })();
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
    title: string;
    content: string;
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
