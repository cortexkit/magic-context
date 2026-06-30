import { createHash } from "node:crypto";

import { estimateTokens } from "../../hooks/magic-context/read-session-formatting";
import { getHarness } from "../../shared/harness";
import { log } from "../../shared/logger";
import type { Database, Statement as PreparedStatement } from "../../shared/sqlite";
import { recursiveCharacterSplit } from "./recursive-text-splitter";

export const DEFAULT_COMPARTMENT_CHUNK_MAX_INPUT_TOKENS = 512;

/**
 * Fraction of the configured `max_input_tokens` we actually fill per window.
 *
 * `max_input_tokens` is the provider's HARD context ceiling, but we window using
 * our own `estimateTokens` heuristic, which drifts from the provider's real
 * tokenizer (observed ~1% on Qwen3 — a chunk we sized at 8192 counted 8261 on
 * the server and was silently truncated). Targeting 90% of the ceiling absorbs
 * that cross-tokenizer drift so a window never exceeds the provider limit.
 */
export const CHUNK_WINDOW_SAFETY_RATIO = 0.9;

interface FtsChunkRow {
    messageOrdinal: number | string;
    role: string;
    content: string;
}

interface ExistingChunkHashRow {
    windowIndex: number;
    chunkHash: string;
}

interface StoredModelIdRow {
    modelId: string | null;
}

interface SearchChunkRow {
    compartmentId: number;
    sessionId: string;
    title: string;
    compartmentStart: number;
    compartmentEnd: number;
    windowIndex: number;
    windowStart: number;
    windowEnd: number;
    chunkHash: string;
    modelId: string;
    dims: number;
    vector: Uint8Array | ArrayBuffer;
}

interface BackfillCandidateRow {
    id: number;
    sessionId: string;
    startMessage: number;
    endMessage: number;
    title: string;
}

export interface CompartmentChunkBackfillCandidate {
    id: number;
    sessionId: string;
    startMessage: number;
    endMessage: number;
    title: string;
}

export interface CompartmentChunkWindow {
    windowIndex: number;
    startOrdinal: number;
    endOrdinal: number;
    text: string;
    chunkHash: string;
}

export interface StoredCompartmentChunkEmbedding {
    compartmentId: number;
    sessionId: string;
    title: string;
    startOrdinal: number;
    endOrdinal: number;
    windowIndex: number;
    windowStartOrdinal: number;
    windowEndOrdinal: number;
    chunkHash: string;
    modelId: string;
    dims: number;
    vector: Float32Array;
}

export interface SaveCompartmentChunkEmbeddingInput {
    compartmentId: number;
    sessionId: string;
    projectPath: string;
    window: CompartmentChunkWindow;
    modelId: string;
    vector: Float32Array;
    createdAt?: number;
}

const loadFtsRowsStatements = new WeakMap<Database, PreparedStatement>();
const existingHashStatements = new WeakMap<Database, PreparedStatement>();
const existingHashByProjectStatements = new WeakMap<Database, PreparedStatement>();
const deleteByCompartmentStatements = new WeakMap<Database, PreparedStatement>();
const insertEmbeddingStatements = new WeakMap<Database, PreparedStatement>();
const distinctModelStatements = new WeakMap<Database, PreparedStatement>();
const clearProjectStatements = new WeakMap<Database, PreparedStatement>();
const clearProjectModelStatements = new WeakMap<Database, PreparedStatement>();
const searchRowsStatements = new WeakMap<Database, PreparedStatement>();
const searchRowsByModelStatements = new WeakMap<Database, PreparedStatement>();
const backfillCandidateStatements = new WeakMap<Database, PreparedStatement>();

function getLoadFtsRowsStatement(db: Database): PreparedStatement {
    let stmt = loadFtsRowsStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT message_ordinal AS messageOrdinal, role, content
             FROM message_history_fts
             WHERE session_id = ?
               AND message_ordinal >= ?
               AND message_ordinal <= ?
               AND role IN ('user', 'assistant')
             ORDER BY message_ordinal ASC`,
        );
        loadFtsRowsStatements.set(db, stmt);
    }
    return stmt;
}

function getExistingHashStatement(db: Database, scopedToProject: boolean): PreparedStatement {
    const map = scopedToProject ? existingHashByProjectStatements : existingHashStatements;
    let stmt = map.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT window_index AS windowIndex, chunk_hash AS chunkHash
             FROM compartment_chunk_embeddings
             WHERE compartment_id = ?
               AND model_id = ?
               ${scopedToProject ? "AND project_path = ?" : ""}
             ORDER BY window_index ASC`,
        );
        map.set(db, stmt);
    }
    return stmt;
}

function getDeleteByCompartmentStatement(db: Database): PreparedStatement {
    let stmt = deleteByCompartmentStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "DELETE FROM compartment_chunk_embeddings WHERE compartment_id = ? AND model_id = ?",
        );
        deleteByCompartmentStatements.set(db, stmt);
    }
    return stmt;
}

function getInsertEmbeddingStatement(db: Database): PreparedStatement {
    let stmt = insertEmbeddingStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `INSERT INTO compartment_chunk_embeddings (
                compartment_id, session_id, project_path, harness, window_index,
                start_ordinal, end_ordinal, chunk_hash, model_id, dims, vector, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        insertEmbeddingStatements.set(db, stmt);
    }
    return stmt;
}

function getDistinctModelStatement(db: Database): PreparedStatement {
    let stmt = distinctModelStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT DISTINCT model_id AS modelId
             FROM compartment_chunk_embeddings
             WHERE project_path = ?`,
        );
        distinctModelStatements.set(db, stmt);
    }
    return stmt;
}

function getClearProjectStatement(db: Database): PreparedStatement {
    let stmt = clearProjectStatements.get(db);
    if (!stmt) {
        stmt = db.prepare("DELETE FROM compartment_chunk_embeddings WHERE project_path = ?");
        clearProjectStatements.set(db, stmt);
    }
    return stmt;
}

function getClearProjectModelStatement(db: Database): PreparedStatement {
    let stmt = clearProjectModelStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "DELETE FROM compartment_chunk_embeddings WHERE project_path = ? AND model_id = ?",
        );
        clearProjectModelStatements.set(db, stmt);
    }
    return stmt;
}

function getSearchRowsStatement(db: Database, withModel: boolean): PreparedStatement {
    const map = withModel ? searchRowsByModelStatements : searchRowsStatements;
    let stmt = map.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT e.compartment_id AS compartmentId,
                    e.session_id AS sessionId,
                    c.title AS title,
                    c.start_message AS compartmentStart,
                    c.end_message AS compartmentEnd,
                    e.window_index AS windowIndex,
                    e.start_ordinal AS windowStart,
                    e.end_ordinal AS windowEnd,
                    e.chunk_hash AS chunkHash,
                    e.model_id AS modelId,
                    e.dims AS dims,
                    e.vector AS vector
             FROM compartment_chunk_embeddings e
             JOIN compartments c ON c.id = e.compartment_id
             WHERE e.session_id = ?
               AND e.project_path = ?
               ${withModel ? "AND e.model_id = ?" : ""}
             ORDER BY e.compartment_id ASC, e.window_index ASC`,
        );
        map.set(db, stmt);
    }
    return stmt;
}

function getBackfillCandidateStatement(db: Database): PreparedStatement {
    let stmt = backfillCandidateStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT c.id AS id,
                    c.session_id AS sessionId,
                    c.start_message AS startMessage,
                    c.end_message AS endMessage,
                    c.title AS title
             FROM compartments c
             JOIN session_projects sp
               ON sp.session_id = c.session_id
              AND sp.harness = c.harness
              AND sp.project_path = ?
             WHERE c.start_message IS NOT NULL
               AND c.end_message IS NOT NULL
               AND NOT EXISTS (
                   SELECT 1
                   FROM compartment_chunk_embeddings current
                   WHERE current.compartment_id = c.id
                     AND current.project_path = ?
                     AND current.model_id = ?
               )
             ORDER BY c.created_at DESC, c.id DESC
             LIMIT ?`,
        );
        backfillCandidateStatements.set(db, stmt);
    }
    return stmt;
}

function isFinitePositiveInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function normalizeCompartmentChunkMaxInputTokens(value: unknown): number {
    if (!isFinitePositiveInteger(value)) {
        return DEFAULT_COMPARTMENT_CHUNK_MAX_INPUT_TOKENS;
    }
    return Math.max(1, Math.floor(value));
}

function normalizeContent(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

function formatOrdinalRange(start: number, end: number): string {
    return start === end ? `[${start}]` : `[${start}-${end}]`;
}

function rolePrefix(role: string): "U" | "A" | null {
    if (role === "user") return "U";
    if (role === "assistant") return "A";
    return null;
}

function parseOrdinal(value: number | string | undefined): number | null {
    const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseCanonicalLineRange(line: string): { start: number; end: number } | null {
    const match = /^\[(\d+)(?:-(\d+))?\]\s+[UA]:/.exec(line.trim());
    if (!match) return null;
    const start = Number.parseInt(match[1], 10);
    const end = match[2] ? Number.parseInt(match[2], 10) : start;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    return { start, end };
}

function hashChunkText(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

function vectorBlob(vector: Float32Array): Uint8Array {
    return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

function toFloat32Array(blob: Uint8Array | ArrayBuffer): Float32Array {
    if (blob instanceof Uint8Array) {
        const buffer = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
        return new Float32Array(buffer);
    }
    return new Float32Array(blob.slice(0));
}

export function buildCanonicalChunkTextFromFts(
    db: Database,
    sessionId: string,
    startOrdinal: number,
    endOrdinal: number,
): string {
    if (endOrdinal < startOrdinal) return "";
    const rows = getLoadFtsRowsStatement(db)
        .all(sessionId, startOrdinal, endOrdinal)
        .map((row) => row as FtsChunkRow);
    const lines: string[] = [];
    let current: {
        role: "U" | "A";
        start: number;
        end: number;
        parts: string[];
    } | null = null;

    const flush = (): void => {
        if (!current || current.parts.length === 0) return;
        lines.push(
            `${formatOrdinalRange(current.start, current.end)} ${current.role}: ${current.parts.join(
                " / ",
            )}`,
        );
        current = null;
    };

    for (const row of rows) {
        const ordinal = parseOrdinal(row.messageOrdinal);
        const prefix = rolePrefix(row.role);
        const content = typeof row.content === "string" ? normalizeContent(row.content) : "";
        if (ordinal === null || prefix === null || content.length === 0) continue;

        if (current && current.role === prefix) {
            current.end = ordinal;
            current.parts.push(content);
            continue;
        }

        flush();
        current = { role: prefix, start: ordinal, end: ordinal, parts: [content] };
    }
    flush();
    return lines.join("\n");
}

/**
 * Fallback embeddable text for a compartment whose RAW span has NO indexable
 * content. A thin one-beat compartment — e.g. a host-injected
 * `<system-reminder>` notification (stripped to empty by the indexer) plus an
 * assistant tool-call (no text) — leaves `buildCanonicalChunkTextFromFts`
 * returning "". Such a compartment would never acquire an embedding row, so it
 * stays counted as "remaining" forever and the auto-embed drain re-fires its
 * start/finish notification on every restart (the desktop "Embedding 1 /
 * Embedded 0" loop).
 *
 * The compartment still carries a real summary (title + p1 paraphrase) — the
 * ONLY signal it has — so we embed that instead. This is NOT the redundancy that
 * retired `p1_embedding` (which embedded the summary ALONGSIDE the raw chunk):
 * here there is no raw chunk to embed, so the summary is the sole content.
 * Returns "" only when the compartment has neither a title nor p1/content.
 */
export function buildCompartmentSummaryFallbackText(db: Database, compartmentId: number): string {
    const row = db
        .prepare("SELECT title, p1, content FROM compartments WHERE id = ?")
        .get(compartmentId) as
        | { title?: string | null; p1?: string | null; content?: string | null }
        | undefined;
    if (!row) return "";
    const title = typeof row.title === "string" ? row.title.trim() : "";
    const p1 = typeof row.p1 === "string" ? row.p1.trim() : "";
    // v2 rows mirror p1 into `content`; legacy rows only have `content`.
    const body = p1.length > 0 ? p1 : typeof row.content === "string" ? row.content.trim() : "";
    return [title, body].filter((s) => s.length > 0).join("\n");
}

/**
 * Convert historian input text into the same embeddable subset used by the FTS
 * backfill producer: only U:/A: conversational lines remain, and TC: tool-call
 * summaries are removed because they are better served by exact FTS probes.
 */
export function canonicalizeInMemoryChunkTextForEmbedding(
    chunkText: string,
    startOrdinal?: number,
    endOrdinal?: number,
): string {
    const lines: string[] = [];
    for (const rawLine of chunkText.split(/\r?\n/)) {
        const line = rawLine.trim();
        const match = /^(\[(\d+)(?:-(\d+))?\]\s+[UA]:)\s*(.*)$/.exec(line);
        if (!match) continue;
        const lineStart = Number.parseInt(match[2], 10);
        const lineEnd = match[3] ? Number.parseInt(match[3], 10) : lineStart;
        if (startOrdinal != null && lineEnd < startOrdinal) continue;
        if (endOrdinal != null && lineStart > endOrdinal) continue;

        const rawParts = match[4]
            .split(" / ")
            .map((part) => normalizeContent(part))
            .filter((part) => part.length > 0);
        const ordinalSpan = lineEnd - lineStart + 1;
        const roleLabel = match[1].slice(match[1].indexOf("]") + 2);

        if (ordinalSpan === rawParts.length) {
            const retained = rawParts
                .map((part, index) => ({ ordinal: lineStart + index, part }))
                .filter(({ ordinal, part }) => {
                    if (part.startsWith("TC:")) return false;
                    if (startOrdinal != null && ordinal < startOrdinal) return false;
                    if (endOrdinal != null && ordinal > endOrdinal) return false;
                    return true;
                });
            if (retained.length === 0) continue;
            const retainedStart = retained[0].ordinal;
            const retainedEnd = retained[retained.length - 1].ordinal;
            lines.push(
                `${formatOrdinalRange(retainedStart, retainedEnd)} ${roleLabel} ${retained
                    .map(({ part }) => part)
                    .join(" / ")}`,
            );
            continue;
        }

        const parts = rawParts.filter((part) => !part.startsWith("TC:"));
        if (parts.length === 0) continue;
        lines.push(`${match[1]} ${parts.join(" / ")}`);
    }
    return lines.join("\n");
}

export function chunkCanonicalText(
    canonicalText: string,
    startOrdinal: number,
    endOrdinal: number,
    maxInputTokens: number,
): CompartmentChunkWindow[] {
    const lines = canonicalText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    if (lines.length === 0 || endOrdinal < startOrdinal) return [];

    const normalizedMax = normalizeCompartmentChunkMaxInputTokens(maxInputTokens);
    // Window against a safety-margined budget, not the raw ceiling, so estimator
    // drift can't push a window past the provider's real token limit.
    const effectiveMax = Math.max(1, Math.floor(normalizedMax * CHUNK_WINDOW_SAFETY_RATIO));
    const fullText = lines.join("\n");
    if (estimateTokens(fullText) <= effectiveMax) {
        return [
            {
                windowIndex: 0,
                startOrdinal,
                endOrdinal,
                text: fullText,
                chunkHash: hashChunkText(fullText),
            },
        ];
    }

    const windows: CompartmentChunkWindow[] = [];
    let currentLines: string[] = [];
    let currentStart: number | null = null;
    let currentEnd: number | null = null;
    let currentTokens = 0;

    const flush = (): void => {
        if (currentLines.length === 0 || currentStart === null || currentEnd === null) return;
        const text = currentLines.join("\n");
        windows.push({
            windowIndex: windows.length + 1,
            startOrdinal: currentStart,
            endOrdinal: currentEnd,
            text,
            chunkHash: hashChunkText(text),
        });
        currentLines = [];
        currentStart = null;
        currentEnd = null;
        currentTokens = 0;
    };

    for (const line of lines) {
        const range = parseCanonicalLineRange(line);
        const lineStart = range?.start ?? startOrdinal;
        const lineEnd = range?.end ?? lineStart;
        const lineTokens = estimateTokens(line);

        // A single canonical line (one U:/A: span) can itself exceed the per-window
        // budget — e.g. a span containing a large file dump or paste rendered into
        // one line. Packing only flushes BETWEEN lines, so such a line would be
        // emitted as one oversized window and blow past the provider's hard context
        // window (#206: jina returned 400 exceed_context_size for a 51774-token
        // window against an 8192 ceiling). Split the line down to budget first, and
        // emit each sub-slice as its own window carrying this line's ordinal range.
        if (lineTokens > effectiveMax) {
            flush();
            for (const slice of splitOversizedLine(line, effectiveMax)) {
                windows.push({
                    windowIndex: windows.length + 1,
                    startOrdinal: lineStart,
                    endOrdinal: lineEnd,
                    text: slice,
                    chunkHash: hashChunkText(slice),
                });
            }
            continue;
        }

        if (currentLines.length > 0 && currentTokens + lineTokens > effectiveMax) {
            flush();
        }
        if (currentLines.length === 0) {
            currentStart = lineStart;
        }
        currentLines.push(line);
        currentEnd = lineEnd;
        currentTokens += lineTokens;
    }
    flush();

    // windowIndex is assigned contiguously as 1-based at push time (both the
    // flush path and the oversized-line split use `windows.length + 1`), so it is
    // already gap-free and stable — preserve it (chunk identity = compartmentId +
    // windowIndex + hash; renumbering would orphan every stored chunk row).
    return windows;
}

/**
 * Split a single oversized canonical line into sub-slices each within
 * `effectiveMax` tokens, using a recursive character splitter (best-in-class
 * boundary hierarchy: paragraph → line → sentence → word → char). The
 * `lengthFunction` is our real tokenizer (`estimateTokens`), so slicing is
 * token-accurate against the same heuristic the windower uses — deterministic,
 * no provider call, cache-stable. A hard char-level safety cap guarantees
 * termination even if a single token-dense fragment resists separator splitting.
 */
function splitOversizedLine(line: string, effectiveMax: number): string[] {
    // Recursive split on the best-in-class separator hierarchy (paragraph → line
    // → word → char), measured with our real tokenizer. Fall back to a
    // deterministic char-budget split if the splitter throws or yields nothing
    // (never leave an oversized line un-split).
    let slices: string[] = [];
    try {
        slices = recursiveCharacterSplit(line, {
            chunkSize: effectiveMax,
            lengthFunction: estimateTokens,
        });
    } catch (error) {
        // Surface the regression instead of degrading silently: if the splitter
        // consistently fails for some input shape the char-budget fallback still
        // embeds, but we want a signal.
        log("[magic-context] recursiveCharacterSplit failed; using char-budget fallback:", error);
        slices = [];
    }
    if (slices.length === 0) {
        slices = charBudgetSplit(line, effectiveMax);
    }
    // Final guard: any slice still over budget (token-dense, no separators) is
    // hard-split by character budget. charBudgetSplit is the TERMINAL splitter —
    // it shrinks to a single character, the smallest indivisible unit — so its
    // output is budget-compliant by construction EXCEPT for the degenerate case
    // of a lone character that alone exceeds the budget (only reachable with a
    // tiny effectiveMax; never with real provider budgets). We assert that
    // contract in dev/test rather than re-splitting (which cannot reduce a
    // 1-char slice further and would loop): any escapee is a genuine bug, not
    // something to silently paper over.
    const safe: string[] = [];
    const pushChecked = (slice: string): void => {
        if (estimateTokens(slice) > effectiveMax && slice.length > 1) {
            // Not terminal yet — split further. (Defensive: charBudgetSplit
            // should already guarantee this; only triggers if its contract
            // regresses.)
            safe.push(...charBudgetSplit(slice, effectiveMax));
            return;
        }
        safe.push(slice);
    };
    for (const slice of slices) {
        if (estimateTokens(slice) <= effectiveMax) {
            safe.push(slice);
        } else {
            for (const sub of charBudgetSplit(slice, effectiveMax)) pushChecked(sub);
        }
    }
    return safe.filter((s) => s.length > 0);
}

/**
 * Deterministic character-budget fallback split. Estimates a chars-per-token
 * ratio from the input and slices on that, then trims each slice down until it
 * fits the token budget. Always terminates.
 *
 * Budget guarantee: every emitted slice is within `effectiveMax` tokens EXCEPT
 * the degenerate case where a single character already exceeds the budget (only
 * reachable when `effectiveMax` is tiny — e.g. 1 — and one char tokenizes to
 * multiple tokens). In that case the slice is a single character: it cannot be
 * split further, so emitting it is the only progress-making choice. With real
 * provider budgets (thousands of tokens) this case never arises.
 */
function charBudgetSplit(text: string, effectiveMax: number): string[] {
    const totalTokens = Math.max(1, estimateTokens(text));
    const charsPerToken = Math.max(1, Math.floor(text.length / totalTokens));
    const sliceChars = Math.max(1, effectiveMax * charsPerToken);
    const out: string[] = [];
    let pos = 0;
    while (pos < text.length) {
        let end = Math.min(text.length, pos + sliceChars);
        let slice = text.slice(pos, end);
        // Shrink until the slice fits the token budget (handles dense regions).
        // Floor at one character: a single char is the smallest indivisible unit,
        // so we stop there even if it alone exceeds the budget (degenerate tiny
        // budget) — otherwise the loop could not make progress.
        while (slice.length > 1 && estimateTokens(slice) > effectiveMax) {
            end = pos + Math.max(1, Math.floor((end - pos) / 2));
            slice = text.slice(pos, end);
        }
        out.push(slice);
        pos = end;
    }
    return out;
}

export function getExistingChunkHashes(
    db: Database,
    compartmentId: number,
    modelId: string,
    projectPath?: string,
): Map<number, string> {
    const scoped = typeof projectPath === "string" && projectPath.length > 0;
    const rows = (
        scoped
            ? getExistingHashStatement(db, true).all(compartmentId, modelId, projectPath)
            : getExistingHashStatement(db, false).all(compartmentId, modelId)
    ) as ExistingChunkHashRow[];
    return new Map(
        rows
            .filter(
                (row) => typeof row.windowIndex === "number" && typeof row.chunkHash === "string",
            )
            .map((row) => [row.windowIndex, row.chunkHash]),
    );
}

export function chunkEmbeddingWindowsAreCurrent(
    db: Database,
    compartmentId: number,
    modelId: string,
    windows: readonly CompartmentChunkWindow[],
    projectPath?: string,
): boolean {
    const existing = getExistingChunkHashes(db, compartmentId, modelId, projectPath);
    if (existing.size !== windows.length) return false;
    return windows.every((window) => existing.get(window.windowIndex) === window.chunkHash);
}

export function replaceCompartmentChunkEmbeddings(
    db: Database,
    rows: readonly SaveCompartmentChunkEmbeddingInput[],
): void {
    if (rows.length === 0) return;
    const compartmentId = rows[0].compartmentId;
    const modelId = rows[0].modelId;
    const now = Date.now();
    db.transaction(() => {
        getDeleteByCompartmentStatement(db).run(compartmentId, modelId);
        const insert = getInsertEmbeddingStatement(db);
        for (const row of rows) {
            insert.run(
                row.compartmentId,
                row.sessionId,
                row.projectPath,
                getHarness(),
                row.window.windowIndex,
                row.window.startOrdinal,
                row.window.endOrdinal,
                row.window.chunkHash,
                row.modelId,
                row.vector.length,
                vectorBlob(row.vector),
                row.createdAt ?? now,
            );
        }
    })();
}

export function getDistinctChunkEmbeddingModelIds(
    db: Database,
    projectPath: string,
): Set<string | null> {
    const rows = getDistinctModelStatement(db).all(projectPath) as StoredModelIdRow[];
    return new Set(rows.map((row) => (typeof row.modelId === "string" ? row.modelId : null)));
}

export function clearChunkEmbeddingsForProject(
    db: Database,
    projectPath: string,
    modelId?: string,
): number {
    if (modelId) {
        return getClearProjectModelStatement(db).run(projectPath, modelId).changes;
    }
    return getClearProjectStatement(db).run(projectPath).changes;
}

export function loadCompartmentChunkEmbeddingsForSearch(
    db: Database,
    sessionId: string,
    projectPath: string,
    modelId: string,
): StoredCompartmentChunkEmbedding[] {
    if (!modelId) {
        throw new Error("loadCompartmentChunkEmbeddingsForSearch requires a current model id");
    }
    const rows = getSearchRowsStatement(db, true).all(
        sessionId,
        projectPath,
        modelId,
    ) as SearchChunkRow[];
    return rows
        .filter(
            (row) =>
                typeof row.compartmentId === "number" &&
                typeof row.sessionId === "string" &&
                typeof row.title === "string" &&
                typeof row.compartmentStart === "number" &&
                typeof row.compartmentEnd === "number" &&
                typeof row.windowIndex === "number" &&
                typeof row.windowStart === "number" &&
                typeof row.windowEnd === "number" &&
                typeof row.chunkHash === "string" &&
                typeof row.modelId === "string" &&
                typeof row.dims === "number" &&
                (row.vector instanceof Uint8Array || row.vector instanceof ArrayBuffer),
        )
        .map((row) => ({
            compartmentId: row.compartmentId,
            sessionId: row.sessionId,
            title: row.title,
            startOrdinal: row.compartmentStart,
            endOrdinal: row.compartmentEnd,
            windowIndex: row.windowIndex,
            windowStartOrdinal: row.windowStart,
            windowEndOrdinal: row.windowEnd,
            chunkHash: row.chunkHash,
            modelId: row.modelId,
            dims: row.dims,
            vector: toFloat32Array(row.vector),
        }));
}

export function loadUnembeddedCompartmentChunkCandidates(
    db: Database,
    projectPath: string,
    modelId: string,
    limit: number,
): CompartmentChunkBackfillCandidate[] {
    const rows = getBackfillCandidateStatement(db).all(
        projectPath,
        projectPath,
        modelId,
        Math.max(1, limit),
    ) as unknown[];
    return mapBackfillCandidateRows(rows);
}

function mapBackfillCandidateRows(rows: unknown[]): CompartmentChunkBackfillCandidate[] {
    return rows
        .filter((row): row is BackfillCandidateRow => {
            if (row === null || typeof row !== "object") return false;
            const candidate = row as Record<string, unknown>;
            return (
                typeof candidate.id === "number" &&
                typeof candidate.sessionId === "string" &&
                typeof candidate.startMessage === "number" &&
                typeof candidate.endMessage === "number" &&
                typeof candidate.title === "string"
            );
        })
        .map((row) => ({
            id: row.id,
            sessionId: row.sessionId,
            startMessage: row.startMessage,
            endMessage: row.endMessage,
            title: row.title,
        }));
}

const sessionBackfillCandidateStatements = new WeakMap<Database, PreparedStatement>();

/** Session-scoped variant of {@link loadUnembeddedCompartmentChunkCandidates}.
 *  Used by the on-demand `/ctx-embed-history` command, which backfills ONE
 *  session at a time (oldest-first so the user watches it fill chronologically),
 *  unlike the project-wide passive drain. A compartment is a candidate when it
 *  has no chunk-embedding row for `modelId` yet.
 *
 *  `excludeIds` lets the drain loop advance past compartments that produced no
 *  embeddable work this run (empty canonical text / windows already current) so
 *  one un-embeddable old compartment can't block every newer one — without it
 *  the oldest-first query would re-select the same stuck prefix forever. */
export function loadUnembeddedSessionChunkCandidates(
    db: Database,
    projectPath: string,
    sessionId: string,
    modelId: string,
    limit: number,
    excludeIds?: readonly number[],
): CompartmentChunkBackfillCandidate[] {
    if (excludeIds && excludeIds.length > 0) {
        // Exclusion sets are per-run and unbounded in shape, so this statement
        // is built ad hoc (not cached) with an inline placeholder list.
        const placeholders = excludeIds.map(() => "?").join(", ");
        const stmt = db.prepare(
            `SELECT c.id AS id,
                    c.session_id AS sessionId,
                    c.start_message AS startMessage,
                    c.end_message AS endMessage,
                    c.title AS title
             FROM compartments c
             JOIN session_projects sp
               ON sp.session_id = c.session_id
              AND sp.harness = c.harness
              AND sp.project_path = ?
             WHERE c.session_id = ?
               AND c.start_message IS NOT NULL
               AND c.end_message IS NOT NULL
               AND c.id NOT IN (${placeholders})
               AND NOT EXISTS (
                   SELECT 1
                   FROM compartment_chunk_embeddings current
                   WHERE current.compartment_id = c.id
                     AND current.project_path = ?
                     AND current.model_id = ?
               )
             ORDER BY c.start_message ASC, c.id ASC
             LIMIT ?`,
        );
        const rows = stmt.all(
            projectPath,
            sessionId,
            ...excludeIds,
            projectPath,
            modelId,
            Math.max(1, limit),
        ) as unknown[];
        return mapBackfillCandidateRows(rows);
    }
    let stmt = sessionBackfillCandidateStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT c.id AS id,
                    c.session_id AS sessionId,
                    c.start_message AS startMessage,
                    c.end_message AS endMessage,
                    c.title AS title
             FROM compartments c
             JOIN session_projects sp
               ON sp.session_id = c.session_id
              AND sp.harness = c.harness
              AND sp.project_path = ?
             WHERE c.session_id = ?
               AND c.start_message IS NOT NULL
               AND c.end_message IS NOT NULL
               AND NOT EXISTS (
                   SELECT 1
                   FROM compartment_chunk_embeddings current
                   WHERE current.compartment_id = c.id
                     AND current.project_path = ?
                     AND current.model_id = ?
               )
             ORDER BY c.start_message ASC, c.id ASC
             LIMIT ?`,
        );
        sessionBackfillCandidateStatements.set(db, stmt);
    }
    const rows = stmt.all(
        projectPath,
        sessionId,
        projectPath,
        modelId,
        Math.max(1, limit),
    ) as unknown[];
    return mapBackfillCandidateRows(rows);
}

/** Count compartments in this session that still lack a chunk embedding for
 *  `modelId` — drives the `/ctx-embed-history` progress total. */
export function countUnembeddedSessionCompartments(
    db: Database,
    projectPath: string,
    sessionId: string,
    modelId: string,
): number {
    const row = db
        .prepare(
            `SELECT COUNT(*) AS n
             FROM compartments c
             JOIN session_projects sp
               ON sp.session_id = c.session_id
              AND sp.harness = c.harness
              AND sp.project_path = ?
             WHERE c.session_id = ?
               AND c.start_message IS NOT NULL
               AND c.end_message IS NOT NULL
               AND NOT EXISTS (
                   SELECT 1
                   FROM compartment_chunk_embeddings current
                   WHERE current.compartment_id = c.id
                     AND current.project_path = ?
                     AND current.model_id = ?
               )`,
        )
        .get(projectPath, sessionId, projectPath, modelId) as { n?: number } | undefined;
    return typeof row?.n === "number" ? row.n : 0;
}

/** Total embeddable compartments in this session (have a message range), and how
 *  many are currently embedded under `modelId`. Drives the `/ctx-embed` status
 *  line: `embedded / total`. Counts the project's OWN compartments for the
 *  session (same `session_projects` scoping as the unembedded counter). */
export function countSessionCompartmentEmbedCoverage(
    db: Database,
    projectPath: string,
    sessionId: string,
    modelId: string,
): { embedded: number; total: number } {
    const row = db
        .prepare(
            `SELECT
               COUNT(*) AS total,
               SUM(CASE WHEN EXISTS (
                   SELECT 1 FROM compartment_chunk_embeddings e
                   WHERE e.compartment_id = c.id
                     AND e.project_path = ?
                     AND e.model_id = ?
               ) THEN 1 ELSE 0 END) AS embedded
             FROM compartments c
             JOIN session_projects sp
               ON sp.session_id = c.session_id
              AND sp.harness = c.harness
              AND sp.project_path = ?
             WHERE c.session_id = ?
               AND c.start_message IS NOT NULL
               AND c.end_message IS NOT NULL`,
        )
        .get(projectPath, modelId, projectPath, sessionId) as
        | { total?: number; embedded?: number }
        | undefined;
    return {
        total: typeof row?.total === "number" ? row.total : 0,
        embedded: typeof row?.embedded === "number" ? row.embedded : 0,
    };
}
