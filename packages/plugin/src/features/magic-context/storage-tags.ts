import { isMainThread } from "node:worker_threads";
import { resolveToolTier } from "../../hooks/magic-context/emergency-drop";
import { getHarness } from "../../shared/harness";
import {
    type Database,
    getSqliteDatabasePath,
    getTagIdentityWriteGeneration,
    type Statement as PreparedStatement,
} from "../../shared/sqlite";
import {
    contentTagOwnerMessageId,
    PI_FALLBACK_PREFIXES_JSON,
    TEXT_TAG_IDENTITY_MARKER,
} from "../../shared/tag-owner-id";
import { tagOrderConstraintIndex } from "./migration-v95-perf-indexes";
import { queuePendingOp, removePendingOp } from "./storage-ops";
import { tagIdentityRevisionKey } from "./storage-tag-identity-revision";
import type { TagEntry } from "./types";

declare module "./types" {
    interface TagEntry {
        id?: number;
        tokenCount?: number | null;
    }
}

export type { TagEntry } from "./types";

const insertTagStatements = new WeakMap<Database, PreparedStatement>();
const updateTagStatusStatements = new WeakMap<Database, PreparedStatement>();
const updateTagDropModeStatements = new WeakMap<Database, PreparedStatement>();
const updateTagMessageIdStatements = new WeakMap<Database, PreparedStatement>();
const getTagNumbersByMessageIdStatements = new WeakMap<Database, PreparedStatement>();
const deleteTagsByMessageIdStatements = new WeakMap<Database, PreparedStatement>();
const getMaxTagNumberBySessionStatements = new WeakMap<Database, PreparedStatement>();
const getTagNumberByMessageIdStatements = new WeakMap<Database, PreparedStatement>();
const getAssignableTagNumberByMessageIdStatements = new WeakMap<Database, PreparedStatement>();
const hasPiFallbackMessageTagStatements = new WeakMap<Database, PreparedStatement>();

export const WHITESPACE_ASSISTANT_INERT_MESSAGE_PREFIX = "__mc_whitespace_assistant_inert__:";
export const WHITESPACE_ASSISTANT_INERT_FINGERPRINT_PREFIX = "mc:whitespace-assistant:";

function getInsertTagStatement(db: Database): PreparedStatement {
    let stmt = insertTagStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, reasoning_byte_size, tag_number, tool_name, input_byte_size, harness, tool_owner_message_id, entry_fingerprint, token_count, input_token_count, reasoning_token_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        insertTagStatements.set(db, stmt);
    }
    return stmt;
}

function getUpdateTagStatusStatement(db: Database): PreparedStatement {
    let stmt = updateTagStatusStatements.get(db);
    if (!stmt) {
        stmt = db.prepare("UPDATE tags SET status = ? WHERE session_id = ? AND tag_number = ?");
        updateTagStatusStatements.set(db, stmt);
    }
    return stmt;
}

function getUpdateTagDropModeStatement(db: Database): PreparedStatement {
    let stmt = updateTagDropModeStatements.get(db);
    if (!stmt) {
        stmt = db.prepare("UPDATE tags SET drop_mode = ? WHERE session_id = ? AND tag_number = ?");
        updateTagDropModeStatements.set(db, stmt);
    }
    return stmt;
}

const updateTagByteSizeStatements = new WeakMap<Database, PreparedStatement>();
const updateTagInputByteSizeStatements = new WeakMap<Database, PreparedStatement>();

function getUpdateTagByteSizeStatement(db: Database): PreparedStatement {
    let stmt = updateTagByteSizeStatements.get(db);
    if (!stmt) {
        stmt = db.prepare("UPDATE tags SET byte_size = ? WHERE session_id = ? AND tag_number = ?");
        updateTagByteSizeStatements.set(db, stmt);
    }
    return stmt;
}

function getUpdateTagInputByteSizeStatement(db: Database): PreparedStatement {
    let stmt = updateTagInputByteSizeStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "UPDATE tags SET input_byte_size = ? WHERE session_id = ? AND tag_number = ?",
        );
        updateTagInputByteSizeStatements.set(db, stmt);
    }
    return stmt;
}

/**
 * Bump a tag's byte_size when a later occurrence of the same call_id
 * carries a larger payload. Used by `tagTranscript` to record the
 * tool-result payload size after the tool-use invocation already
 * reserved the tag with the args size.
 *
 * No-op if newByteSize is not strictly larger than the stored value
 * (caller should compare in memory and only call when necessary).
 */
export function updateTagByteSize(
    db: Database,
    sessionId: string,
    tagNumber: number,
    newByteSize: number,
): void {
    getUpdateTagByteSizeStatement(db).run(newByteSize, sessionId, tagNumber);
}

/**
 * Per-owning-message token totals for the ACTIVE tags of a session, keyed by
 * the real message id (not the synthetic content id). Both the sidebar
 * breakdown and the protected-tail true-raw measurement index into this by the
 * message ids they already hold (their window / eligible slice), so the result
 * is window-scoped by construction — it never overcounts a still-active tag
 * that has been trimmed out of the live window.
 *
 * Owner derivation:
 *   - tool tags: `tool_owner_message_id` (the assistant message that invoked).
 *   - message/file tags: `message_id` is the content id `${msgId}:pN` /
 *     `${msgId}:fileN`; the real message id is the prefix before the last
 *     `:p`/`:file` segment.
 *
 * Each entry carries the conversation/toolCall split (reasoning always folds
 * into conversation, mirroring the live per-part walk) plus `hasNull`: true
 * when any contributing tag still has a NULL token_count (legacy row written
 * before the column existed), signalling the caller to tokenize+backfill that
 * message this pass instead of trusting the stored sum.
 */
export interface MessageTokenTotal {
    conversation: number;
    toolCall: number;
    /**
     * Tool OUTPUT tokens only (the ctx_reduce-droppable payload), excluding tool
     * input args — this is the "reclaimable" figure the nudge channels gate on,
     * matching the legacy `computeTailToolTokens` semantics (which summed
     * `state.output`). `toolCall` = this + input args, for the sidebar bucket.
     */
    toolOutput: number;
    hasNull: boolean;
}

const RECENT_OWNER_SCAN_PAGE_SIZE = 128;
const recentTagOwnerStatements = new WeakMap<Database, PreparedStatement>();

function ownerMessageIdForTagRow(row: {
    type: string;
    message_id: string;
    tool_owner_message_id: string | null;
}): string {
    if (row.type === "tool") {
        return row.tool_owner_message_id ?? row.message_id;
    }
    return contentTagOwnerMessageId(row.message_id);
}

function getRecentTagOwnerStatement(db: Database): PreparedStatement {
    let statement = recentTagOwnerStatements.get(db);
    if (!statement) {
        statement = db.prepare(
            `SELECT type, message_id, tool_owner_message_id
             FROM tags
             WHERE session_id = ?
             ORDER BY tag_number DESC, id DESC
             LIMIT ? OFFSET ?`,
        );
        recentTagOwnerStatements.set(db, statement);
    }
    return statement;
}

/**
 * Return known message owners in descending persisted tag order. Paging stops
 * as soon as the requested number of distinct owners is found, so the common
 * newest-20 lookup does not materialize a long session's complete tag table.
 * Dropped and compacted rows remain part of the chronology by design.
 */
export function getRecentTagOwnerMessageIds(
    db: Database,
    sessionId: string,
    maxOwners: number,
): Set<string> {
    const recent = new Set<string>();
    if (!Number.isFinite(maxOwners) || maxOwners <= 0) return recent;

    const statement = getRecentTagOwnerStatement(db);
    let offset = 0;
    while (recent.size < maxOwners) {
        const rows = statement.all(sessionId, RECENT_OWNER_SCAN_PAGE_SIZE, offset) as Array<{
            type: unknown;
            message_id: unknown;
            tool_owner_message_id: unknown;
        }>;
        for (const row of rows) {
            if (typeof row.type !== "string" || typeof row.message_id !== "string") continue;
            const ownerId =
                row.type === "tool"
                    ? typeof row.tool_owner_message_id === "string"
                        ? row.tool_owner_message_id
                        : null
                    : contentTagOwnerMessageId(row.message_id);
            // Reclaim selectors withhold legacy tool rows whose owner is unknown.
            // Skip them here too so they do not consume a known-owner slot.
            if (!ownerId || recent.has(ownerId)) continue;
            recent.add(ownerId);
            if (recent.size >= maxOwners) break;
        }
        if (rows.length < RECENT_OWNER_SCAN_PAGE_SIZE) break;
        offset += rows.length;
    }
    return recent;
}

/**
 * Session-level aggregate of ACTIVE tag token counts — the real live-tail
 * weight EXCLUDING injected m[0]/m[1] blocks (which are never tagged). This is
 * the single source for the nudge channels:
 *   - liveTail   = conversation + toolCall  (real user/assistant + tool I/O)
 *   - reclaimable = toolOutput              (non-dropped, ctx_reduce-droppable)
 *   - usable      = executeThresholdTokens − inputTokens + liveTail
 * `nullCount` > 0 means some active tags are legacy/un-backfilled this pass; the
 * caller may fall back to the byte-approx path until they converge.
 */
export interface ActiveTagTokenAggregate {
    conversation: number;
    toolCall: number;
    toolOutput: number;
    nullCount: number;
}

/**
 * `protectedCutoff` is the canonical token-window suffix cutoff. Reclaimable
 * tool output excludes rows at or above it; null applies no threshold.
 * `conversation`/`toolCall` are not narrowed because protected content remains
 * part of the live working range.
 */
export function getActiveTagTokenAggregate(
    db: Database,
    sessionId: string,
    protectedCutoff: number | null = null,
): ActiveTagTokenAggregate {
    const toolOutputExpr =
        protectedCutoff !== null
            ? `COALESCE(SUM(CASE WHEN type = 'tool' AND tag_number < ? THEN COALESCE(token_count, 0) ELSE 0 END), 0)`
            : `COALESCE(SUM(CASE WHEN type = 'tool' THEN COALESCE(token_count, 0) ELSE 0 END), 0)`;
    const sql = `SELECT
                COALESCE(SUM(CASE WHEN type != 'tool' THEN COALESCE(token_count, 0) ELSE 0 END), 0)
                    + COALESCE(SUM(COALESCE(reasoning_token_count, 0)), 0) AS conversation,
                COALESCE(SUM(CASE WHEN type = 'tool' THEN COALESCE(token_count, 0) + COALESCE(input_token_count, 0) ELSE 0 END), 0) AS tool_call,
                ${toolOutputExpr} AS tool_output,
                COALESCE(SUM(CASE WHEN token_count IS NULL THEN 1 ELSE 0 END), 0) AS null_count
             FROM tags
             WHERE session_id = ? AND status = 'active'`;
    const params = protectedCutoff !== null ? [protectedCutoff, sessionId] : [sessionId];
    const row = db.prepare(sql).get(...params) as
        | { conversation: number; tool_call: number; tool_output: number; null_count: number }
        | undefined;
    return {
        conversation: row?.conversation ?? 0,
        toolCall: row?.tool_call ?? 0,
        toolOutput: row?.tool_output ?? 0,
        nullCount: row?.null_count ?? 0,
    };
}

export interface ToolReclaimHintTag {
    tagNumber: number;
    toolName: string | null;
}

export interface AgeReclaimToolTag extends ToolReclaimHintTag {
    /** Cached output + input tokens; null means the legacy row has no size estimate. */
    reclaimableTokens: number | null;
}

/**
 * Oldest active tool tags the agent can actually drop. The supplied set is the
 * exact canonical token-window membership used by ctx_reduce and pending-op
 * application. This reader only renders lightweight hints; it never mutates.
 */
/**
 * Tool results that are useful to coordinate with but are poor suggestions for
 * a context-reduction hint. This only filters guidance; the agent can still
 * explicitly drop any of these tags.
 */
const RECLAIM_HINT_EXCLUDED_TOOLS = new Set([
    "ask",
    "bash_kill",
    "bash_status",
    "board",
    "task",
    "todoread",
    "todowrite",
    "work",
]);

/**
 * A reclaim hint should point at MEANINGFULLY reclaimable output, not a
 * 30-token status line or a tiny control-plane call. Tags whose cached token
 * total is known AND below this are skipped. A tag with NO cached token count
 * is NOT excluded by the floor (we cannot size it, so we never hide a
 * potentially-large output).
 */
export const AGE_RECLAIM_MIN_TOKENS = 250;

function isReclaimHintExcludedTool(toolName: string | null): boolean {
    if (!toolName) return false;
    const normalized = toolName.toLowerCase().replace(/^mcp_/, "");
    return normalized.startsWith("ctx_") || RECLAIM_HINT_EXCLUDED_TOOLS.has(normalized);
}

export function getOldestActiveUnprotectedToolTags(
    db: Database,
    sessionId: string,
    protectedTagNumbers: ReadonlySet<number> = new Set(),
    limit = 4,
): ToolReclaimHintTag[] {
    if (limit <= 0) return [];
    const boundedLimit = Math.max(1, Math.min(10, Math.floor(limit)));
    // Unsized tags (both token columns NULL) pass the floor clause so a
    // not-yet-backfilled large output is never wrongly hidden. Tier selection
    // is applied after the SQL query so it reuses the emergency-drop classifier.
    const valueFloor = `AND (
            (token_count IS NULL AND input_token_count IS NULL)
            OR (COALESCE(token_count, 0) + COALESCE(input_token_count, 0)) >= ?
        )`;
    const params = [sessionId, AGE_RECLAIM_MIN_TOKENS];
    const rows = db
        .prepare(
            `SELECT tag_number, tool_name
             FROM tags
               WHERE session_id = ? AND status = 'active' AND type = 'tool'
                    AND NOT EXISTS (
                        SELECT 1 FROM pending_ops
                        WHERE pending_ops.session_id = tags.session_id
                          AND pending_ops.tag_id = tags.tag_number
                          AND pending_ops.operation = 'drop'
                    )
                     ${valueFloor}
              ORDER BY tag_number ASC, id ASC`,
        )
        .all(...params) as Array<{ tag_number?: unknown; tool_name?: unknown }>;
    return rows
        .filter(
            (row): row is { tag_number: number; tool_name?: unknown } =>
                typeof row.tag_number === "number",
        )
        .map((row) => ({
            tagNumber: row.tag_number,
            toolName: typeof row.tool_name === "string" ? row.tool_name : null,
        }))
        .filter(
            (tag) =>
                !protectedTagNumbers.has(tag.tagNumber) && !isReclaimHintExcludedTool(tag.toolName),
        )
        .sort(
            (left, right) =>
                resolveToolTier(right.toolName) - resolveToolTier(left.toolName) ||
                left.tagNumber - right.tagNumber,
        )
        .slice(0, boundedLimit);
}

const getActiveToolTagsForAgeReclaimStatements = new WeakMap<Database, PreparedStatement>();

/**
 * Return age-reclaim candidates with the same persisted token estimate used by reclaim hints.
 * Protection is applied by the caller using its shared per-selection snapshot.
 * Legacy rows with neither token column populated remain eligible for fail-safe reclaim.
 */
export function getActiveToolTagsForAgeReclaim(
    db: Database,
    sessionId: string,
): AgeReclaimToolTag[] {
    let stmt = getActiveToolTagsForAgeReclaimStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT tag_number, tool_name, token_count, input_token_count
             FROM tags
             WHERE session_id = ? AND status = 'active' AND type = 'tool'
             ORDER BY tag_number ASC, id ASC`,
        );
        getActiveToolTagsForAgeReclaimStatements.set(db, stmt);
    }
    const rows = stmt.all(sessionId) as Array<{
        tag_number?: unknown;
        tool_name?: unknown;
        token_count?: unknown;
        input_token_count?: unknown;
    }>;
    const tags = rows
        .filter((row) => typeof row.tag_number === "number")
        .map((row) => {
            const outputTokens = typeof row.token_count === "number" ? row.token_count : null;
            const inputTokens =
                typeof row.input_token_count === "number" ? row.input_token_count : null;
            return {
                tagNumber: row.tag_number as number,
                toolName: typeof row.tool_name === "string" ? row.tool_name : null,
                reclaimableTokens:
                    outputTokens === null && inputTokens === null
                        ? null
                        : (outputTokens ?? 0) + (inputTokens ?? 0),
            };
        });
    return tags;
}

/**
 * Upper bound on the historian's true-raw ELIGIBLE tokens for the cheap
 * trigger pre-gate. Sums `active` AND `dropped` tags: a ctx_reduce/emergency
 * drop removes a tool output from the wire (and the active set) but its raw
 * content stays in OpenCode's DB and still counts toward the historian's
 * chunk size — an active-only bound undercounts after drops and wrongly
 * suppresses real tail-size triggers. `compacted` tags are excluded: they sit
 * before the last compartment boundary by construction, so they can't be in
 * the eligible window (including them would only make the gate uselessly
 * conservative). nullCount spans the same active+dropped set — the bound is
 * only trustworthy when every contributing row has a cached token count.
 */
export function getTriggerTagTokenUpperBound(
    db: Database,
    sessionId: string,
    floor = 0,
): { bound: number; nullCount: number } {
    // floor > 0 (OpenCode) restricts to the live-wire range (tag_number >= floor).
    // The bound is an UPPER BOUND on the historian's eligible-tail tokens; the
    // eligible tail ⊆ the live wire, so the scoped sum is still a valid (tighter,
    // more accurate) upper bound. Critically it also fixes nullCount: pre-floor
    // legacy tags are never backfilled (the tagger only backfills the scoped
    // tail), so a whole-session nullCount stays ~95k forever and the cheap-skip
    // can NEVER trust the bound — scoping drops nullCount to ~0 so the gate finally
    // works. floor=0 (Pi / no-floor fallback) keeps the full-session scan.
    const sql =
        floor > 0
            ? `SELECT
                COALESCE(SUM(COALESCE(token_count, 0) + COALESCE(input_token_count, 0) + COALESCE(reasoning_token_count, 0)), 0) AS bound,
                COALESCE(SUM(CASE WHEN token_count IS NULL THEN 1 ELSE 0 END), 0) AS null_count
             FROM tags
             WHERE session_id = ? AND status IN ('active', 'dropped') AND tag_number >= ?`
            : `SELECT
                COALESCE(SUM(COALESCE(token_count, 0) + COALESCE(input_token_count, 0) + COALESCE(reasoning_token_count, 0)), 0) AS bound,
                COALESCE(SUM(CASE WHEN token_count IS NULL THEN 1 ELSE 0 END), 0) AS null_count
             FROM tags
             WHERE session_id = ? AND status IN ('active', 'dropped')`;
    const row = (
        floor > 0 ? db.prepare(sql).get(sessionId, floor) : db.prepare(sql).get(sessionId)
    ) as { bound: number; null_count: number } | undefined;
    return { bound: row?.bound ?? 0, nullCount: row?.null_count ?? 0 };
}

const scopedActiveTokenTotalStatements = new WeakMap<Database, PreparedStatement>();

export function getActiveTagTokenTotalsByMessage(
    db: Database,
    sessionId: string,
    messageIds?: readonly string[],
): Map<string, MessageTokenTotal> {
    if (messageIds?.length === 0) return new Map();
    const fields =
        "id, tag_number, type, message_id, tool_owner_message_id, token_count, input_token_count, reasoning_token_count"
            .split(", ")
            .map((field) => `tags.${field}`)
            .join(", ");
    let scoped = scopedActiveTokenTotalStatements.get(db);
    if (messageIds && !scoped) {
        // Seek exact owners through existing indexes. Do not use a tag-number
        // floor: a visible result can belong to an older invocation below it.
        // UNION includes id so overlapping owner ranges cannot double-count a row.
        scoped = db.prepare(`
            SELECT ${fields} FROM json_each(?) AS owners
            CROSS JOIN tags INDEXED BY idx_tags_session_message_id
            WHERE session_id = ? AND tags.type != 'tool' AND +status = 'active'
              AND message_id >= owners.value || ':' AND message_id < owners.value || ';'
            UNION
            SELECT ${fields} FROM tags INDEXED BY idx_tags_session_message_id
            WHERE session_id = ? AND type != 'tool' AND +status = 'active'
              AND message_id IN (SELECT value FROM json_each(?))
            UNION
            SELECT ${fields} FROM tags INDEXED BY idx_tags_pi_fallback_tool_owner
            WHERE session_id = ? AND type = 'tool' AND +status = 'active'
              AND tool_owner_message_id IN (SELECT value FROM json_each(?))
            UNION
            SELECT ${fields} FROM tags INDEXED BY idx_tags_session_message_id
            WHERE session_id = ? AND type = 'tool' AND +status = 'active'
              AND tool_owner_message_id IS NULL AND message_id IN (SELECT value FROM json_each(?))
            ORDER BY tag_number, id`);
        scopedActiveTokenTotalStatements.set(db, scoped);
    }
    const owners = messageIds ? new Set(messageIds) : undefined;
    const encoded = owners ? JSON.stringify([...owners]) : "";
    const rows = (
        messageIds && scoped
            ? scoped.all(
                  encoded,
                  sessionId,
                  sessionId,
                  encoded,
                  sessionId,
                  encoded,
                  sessionId,
                  encoded,
              )
            : db
                  .prepare(
                      `SELECT type, message_id, tool_owner_message_id, token_count, input_token_count, reasoning_token_count
             FROM tags
             WHERE session_id = ? AND status = 'active'`,
                  )
                  .all(sessionId)
    ) as Array<{
        type: string;
        message_id: string;
        tool_owner_message_id: string | null;
        token_count: number | null;
        input_token_count: number | null;
        reasoning_token_count: number | null;
    }>;
    const out = new Map<string, MessageTokenTotal>();
    for (const row of rows) {
        const owner = ownerMessageIdForTagRow(row);
        if (owners && !owners.has(owner)) continue;
        let entry = out.get(owner);
        if (!entry) {
            entry = { conversation: 0, toolCall: 0, toolOutput: 0, hasNull: false };
            out.set(owner, entry);
        }
        const reasoning = row.reasoning_token_count ?? 0;
        if (row.type === "tool") {
            const output = row.token_count ?? 0;
            entry.toolCall += output + (row.input_token_count ?? 0);
            entry.toolOutput += output;
        } else {
            entry.conversation += row.token_count ?? 0;
        }
        // Reasoning always counts as conversation (mirrors the live walk),
        // regardless of which tag type it was stored on.
        entry.conversation += reasoning;
        if (row.token_count === null) entry.hasNull = true;
    }
    return out;
}

/**
 * Bump a tag's input_byte_size when a tool_use occurrence is seen
 * after the result occurrence (rare in practice; supports both
 * orderings).
 */
export function updateTagInputByteSize(
    db: Database,
    sessionId: string,
    tagNumber: number,
    newInputByteSize: number,
): void {
    getUpdateTagInputByteSizeStatement(db).run(newInputByteSize, sessionId, tagNumber);
}

const updateTagTokenCountStatements = new WeakMap<Database, PreparedStatement>();
const updateTagInputTokenCountStatements = new WeakMap<Database, PreparedStatement>();

function getUpdateTagTokenCountStatement(db: Database): PreparedStatement {
    let stmt = updateTagTokenCountStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "UPDATE tags SET token_count = MAX(COALESCE(token_count, 0), ?) WHERE session_id = ? AND tag_number = ?",
        );
        updateTagTokenCountStatements.set(db, stmt);
    }
    return stmt;
}

function getUpdateTagInputTokenCountStatement(db: Database): PreparedStatement {
    let stmt = updateTagInputTokenCountStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "UPDATE tags SET input_token_count = ? WHERE session_id = ? AND tag_number = ?",
        );
        updateTagInputTokenCountStatements.set(db, stmt);
    }
    return stmt;
}

/**
 * Bump a tag's token_count when a later occurrence of the same call_id carries a
 * larger output payload — the token mirror of `updateTagByteSize`, called from
 * the same site so the cached token count tracks the grown tool result.
 */
export function updateTagTokenCount(
    db: Database,
    sessionId: string,
    tagNumber: number,
    newTokenCount: number,
): void {
    getUpdateTagTokenCountStatement(db).run(newTokenCount, sessionId, tagNumber);
}

export interface PersistedToolTagAccounting {
    byteSize: number;
    tokenCount: number | null;
    inputByteSize: number;
    inputTokenCount: number | null;
}

/** Read the authoritative accounting after an exceptional same-pass owner adoption. */
export function getPersistedToolTagAccounting(
    db: Database,
    sessionId: string,
    tagNumber: number,
): PersistedToolTagAccounting | null {
    const row = db
        .prepare(
            `SELECT byte_size AS byteSize,
                    token_count AS tokenCount,
                    input_byte_size AS inputByteSize,
                    input_token_count AS inputTokenCount
             FROM tags
             WHERE session_id = ? AND tag_number = ? AND type = 'tool'`,
        )
        .get(sessionId, tagNumber) as PersistedToolTagAccounting | null | undefined;
    if (
        !row ||
        typeof row.byteSize !== "number" ||
        (row.tokenCount !== null && typeof row.tokenCount !== "number") ||
        typeof row.inputByteSize !== "number" ||
        (row.inputTokenCount !== null && typeof row.inputTokenCount !== "number")
    ) {
        return null;
    }
    return row;
}

/**
 * Flat per-message ORIGINAL token map for the protected-tail boundary, keyed by
 * real message id. Sums every tag's stored token weight (output + input +
 * reasoning) for a message REGARDLESS of drop status, because the boundary
 * measures true-raw tokens — the original content the historian re-reads to
 * compact, which lives in opencode.db even when the wire shows a `[dropped]`
 * sentinel. (An active-only sum would undercount the eligible range whenever a
 * tool output had been ctx_reduce-dropped in the live tail.)
 *
 * A message with ANY tag still carrying a NULL token_count (legacy, not yet
 * backfilled) is reported in `nullMessageIds` and omitted from `totals`, so the
 * boundary live-tokenizes it this pass and converges to the stored path after
 * the tagger backfills. Pre-boundary (`compacted`) messages cancel out of the
 * boundary's prefix-difference math, so including them here is harmless.
 * `summaryRemovedTotals` uses the same owners and row order, but counts only
 * text and tool inputs for the run cap and drain quota. Missing tool-input
 * counts omit that owner's summary weight so callers can tokenize it live.
 */
export function getAllStatusTagTokenTotalsFlat(
    db: Database,
    sessionId: string,
    floor = 0,
    calibration: { proseRatio: number; toolsRatio: number } = { proseRatio: 1, toolsRatio: 1 },
    ownerMessageIds?: readonly string[],
): {
    totals: Map<string, number>;
    summaryRemovedTotals: Map<string, number>;
    nullMessageIds: Set<string>;
} {
    // floor > 0 (OpenCode) loads only the live-wire range (tag_number >= floor):
    // tag_number is monotonic with message order, so every tag below the first
    // wire message is compacted-away history the boundary never indexes. The
    // boundary only looks up totals for messages in the live slice (all >= floor
    // by construction), and any excluded slice message degrades to live
    // tokenization of the same content — byte-identical total. floor=0 (Pi, and
    // the OpenCode no-floor fallback) keeps the full-session scan unchanged.
    const columns =
        "type, message_id, tool_owner_message_id, token_count, input_token_count, reasoning_token_count";
    const owners = ownerMessageIds ? new Set(ownerMessageIds) : undefined;
    let scanOrder = "id";
    if (owners) {
        // Floating-point addition depends on row order. Replay the full query's
        // index order for the selected rows, including after ANALYZE changes its
        // plan, so calibrated totals remain bit-for-bit identical.
        const planStatement = db.prepare(
            `EXPLAIN QUERY PLAN SELECT ${columns} FROM tags WHERE session_id = ?${floor > 0 ? " AND tag_number >= ?" : ""}`,
        );
        let plan: Array<{ detail: string }>;
        try {
            plan = planStatement.all(sessionId, ...(floor > 0 ? [floor] : [])) as Array<{
                detail: string;
            }>;
        } finally {
            // Bun's metadata cursors can retain a read snapshot even in
            // autocommit mode. Release the plan before later context writes.
            (planStatement as unknown as { finalize?: () => void }).finalize?.();
        }
        const index = plan
            .map((row) => /USING (?:COVERING )?INDEX (\S+)/.exec(row.detail)?.[1])
            .find(Boolean);
        if (index) {
            const keyStatement = db.prepare(
                "SELECT name, coll, desc FROM pragma_index_xinfo(?) WHERE key = 1 ORDER BY seqno",
            );
            let keys: Array<{ name: string | null; coll: string; desc: number }>;
            try {
                keys = keyStatement.all(index) as Array<{
                    name: string | null;
                    coll: string;
                    desc: number;
                }>;
            } finally {
                (keyStatement as unknown as { finalize?: () => void }).finalize?.();
            }
            scanOrder = [
                ...keys.map(
                    (key) =>
                        `"${(key.name ?? "id").replaceAll('"', '""')}" COLLATE "${key.coll.replaceAll('"', '""')}"${key.desc ? " DESC" : ""}`,
                ),
                "id",
            ].join(", ");
        }
    }
    const rows = (
        owners
            ? db
                  .prepare(`SELECT ${columns} FROM tags WHERE id IN (
                SELECT t.id FROM json_each(?) o CROSS JOIN tags t INDEXED BY idx_tags_session_message_id
                ON t.session_id = ? AND t.message_id >= o.value AND t.message_id < o.value || ';'
                UNION
                SELECT t.id FROM json_each(?) o CROSS JOIN tags t INDEXED BY idx_tags_pi_fallback_tool_owner
                ON t.session_id = ? AND t.tool_owner_message_id = o.value
                WHERE t.type = 'tool'
              ) AND tag_number >= ? ORDER BY ${scanOrder}`)
                  .all(
                      JSON.stringify([...owners]),
                      sessionId,
                      JSON.stringify([...owners]),
                      sessionId,
                      floor,
                  )
            : floor > 0
              ? db
                    .prepare(
                        `SELECT type, message_id, tool_owner_message_id, token_count, input_token_count, reasoning_token_count
                       FROM tags
                       WHERE session_id = ? AND tag_number >= ?`,
                    )
                    .all(sessionId, floor)
              : db
                    .prepare(
                        `SELECT type, message_id, tool_owner_message_id, token_count, input_token_count, reasoning_token_count
                       FROM tags
                       WHERE session_id = ?`,
                    )
                    .all(sessionId)
    ) as Array<{
        type: string;
        message_id: string;
        tool_owner_message_id: string | null;
        token_count: number | null;
        input_token_count: number | null;
        reasoning_token_count: number | null;
    }>;
    const totals = new Map<string, number>();
    const summaryRemovedTotals = new Map<string, number>();
    const nullMessageIds = new Set<string>();
    const nullSummaryRemovedMessageIds = new Set<string>();
    for (const row of rows) {
        // NULL-owner tool rows (pre-v10 unadopted orphans): `ownerMessageIdForTagRow`
        // would key them under the bare callId, which `storedTotalForMessage`
        // (real message ids) never queries — their tokens would be silently
        // attributed to a key nobody reads, making that MESSAGE's stored total
        // an undercount. Treat the row as unresolvable instead: we can't know
        // which message it belongs to, so we can't mark that message NULL
        // either — skipping is the conservative choice (the affected message's
        // total simply lacks this orphan's contribution until lazy adoption
        // resolves the owner, after which it lands under the real id).
        if (row.type === "tool" && row.tool_owner_message_id === null) continue;
        const owner = ownerMessageIdForTagRow(row);
        if (owners && !owners.has(owner)) continue;
        if (row.token_count === null) {
            nullMessageIds.add(owner);
            totals.delete(owner);
            summaryRemovedTotals.delete(owner);
            continue;
        }
        if (nullMessageIds.has(owner)) continue;
        const ratio = row.type === "tool" ? calibration.toolsRatio : calibration.proseRatio;
        const weight =
            ((row.token_count ?? 0) + (row.input_token_count ?? 0)) * ratio +
            (row.reasoning_token_count ?? 0) * calibration.proseRatio;
        totals.set(owner, (totals.get(owner) ?? 0) + weight);
        // Summaries replace text and calls, not results or reasoning. Keep this
        // independent of tag status, just like the full-size tail weight above.
        if (row.type === "tool" && row.input_token_count === null) {
            nullSummaryRemovedMessageIds.add(owner);
            summaryRemovedTotals.delete(owner);
        }
        if (!nullSummaryRemovedMessageIds.has(owner)) {
            const removedWeight =
                row.type === "tool"
                    ? (row.input_token_count ?? 0) * calibration.toolsRatio
                    : row.type === "message"
                      ? row.token_count * calibration.proseRatio
                      : 0;
            summaryRemovedTotals.set(owner, (summaryRemovedTotals.get(owner) ?? 0) + removedWeight);
        }
    }
    return { totals, summaryRemovedTotals, nullMessageIds };
}

/** Only message tags prove ownership of their own assistant's reasoning group.
 * Tool tags describe the preceding thought, not their tool owner, and parallel
 * tools repeat that estimate. Repeated text tags likewise charge the group once.
 *
 * The returned map belongs to the session's cache: read it, never change it.
 * It stays valid until the next read of this session, which may extend it.
 */
export function getReasoningTokenEstimatesByMessage(
    db: Database,
    sessionId: string,
    proseRatio: number,
): ReadonlyMap<string, number> {
    const summary = readTagOwnerSummary(db, sessionId, proseRatio);
    return summary.reasoningEstimatesByRatio.get(proseRatio) ?? new Map();
}

/** Missing ownership information must defer a new reasoning removal, not price it as zero. */
export function tryGetReasoningTokenEstimatesByMessage(
    db: Database,
    sessionId: string,
    ratio: number,
): ReadonlyMap<string, number> | undefined {
    try {
        return getReasoningTokenEstimatesByMessage(db, sessionId, ratio);
    } catch (error) {
        if (error instanceof TagOwnerSummaryNotReady) return undefined;
        throw error;
    }
}

/**
 * Highest tag number per owning message, as the reasoning budget projection
 * groups tags: a tool tag belongs to its tool owner message (and is skipped
 * without one), any other tag to the message its content id names.
 *
 * The returned map belongs to the session's cache: read it, never change it.
 * It stays valid until the next read of this session, which may extend it.
 */
export function getMaxTagNumberByOwnerMessage(
    db: Database,
    sessionId: string,
): ReadonlyMap<string, number> {
    return readTagOwnerSummary(db, sessionId).maxTagByOwner;
}

interface TagOwnerRow {
    id: number;
    type: string | null;
    message_id: string | null;
    tool_owner_message_id: string | null;
    tag_number: number;
    reasoning_token_count: number | null;
}

/**
 * Cached message ownership and reasoning-token estimates for one session.
 * An owner is the message that a tag belongs to; prose ratios scale its stored
 * reasoning count to the session's calibrated token estimate. The cache is kept
 * per connection and extended with tags appended since the last read.
 *
 * The identity-write generation is a single process-wide counter that moves
 * whenever any session's tag ownership or reasoning data is rewritten in this
 * process. It only says "something may have changed somewhere", so it never
 * invalidates this session's cache by itself: it triggers the cheap revision
 * and shape check described below. Only an actual change to this session's
 * existing ownership/reasoning data, a deletion, or a previously uncached prose
 * ratio requires a worker rebuild. Status, drop-mode and size writes do not
 * affect this digest.
 *
 * A commit by another connection (`data_version` moved) is checked against the
 * session's shape first: the number of its tags and its highest tag id, read
 * from the `(session_id, ...)` index together with the rows above the cached
 * highest id in one statement. When the count grew by exactly the number of
 * new rows, the other connection only appended, and those rows are folded in.
 * A delete, or an insert below the cached highest id (only possible with an
 * explicit id, since `tags.id` is AUTOINCREMENT), leaves the count short of
 * that and rebuilds. A delete and an explicit-id insert below the highest id in
 * the same interval would cancel out; no writer inserts tags with an explicit id.
 *
 * Tool tags written before owners were recorded have no owner and count for
 * no message. Another process can give them one later (the tool-owner backfill
 * that runs when an OpenCode process opens the store), so their ids are kept
 * and re-read by primary key after each such commit; there are none in
 * sessions created since owners were recorded.
 *
 * In-place rewrites of a tag's id, session, message id, number, type, owner or
 * reasoning count are counted in the session's tag identity revision by every
 * Magic Context connection (a connection-local trigger, see
 * storage-tag-identity-revision.ts), read in the same statement as the count;
 * a changed revision rebuilds. Rewrites by a connection that never installed
 * that trigger (a tool editing the file directly) are not seen while the
 * count and highest id still fit an append.
 *
 * Inside an open transaction it is neither used nor stored, since uncommitted
 * rows can still roll back. File-store callers defer cold reads; warm foreign
 * commits use bounded appended rows and index-only shape checks in a read snapshot.
 */
export interface TagOwnerSummary {
    dataVersion: number;
    schemaVersion: number;
    generation: number;
    lastRowId: number;
    globalLastRowId: number;
    /** Tag rows of the session folded into this summary. */
    rowCount: number;
    /** Ids of tool tags folded without an owner; another process may still adopt them. */
    unownedToolRows: Set<number>;
    /** The session's tag identity revision when the summary was built or last checked. */
    identityRevision: string | null;
    maxTagByOwner: Map<string, number>;
    /** Reasoning estimates per prose ratio, folded exactly as a full read would. */
    reasoningEstimatesByRatio: Map<number, Map<string, number>>;
}

const tagOwnerSummaries = new WeakMap<Database, Map<string, TagOwnerSummary>>();
/** The prose ratio comes from session calibration and changes rarely; keep the most recent few. */
const MAX_CACHED_PROSE_RATIOS = 4;
const TAG_OWNER_PAGE_LIMIT = 512;

export class TagOwnerSummaryNotReady extends Error {
    constructor() {
        super("tag owner summary needs off-thread preparation");
    }
}

/** A worker builds the same digest as a synchronous read, inside one snapshot. */
export function scanTagOwnerSummary(
    db: Database,
    sessionId: string,
    ratio: number,
    ratios: number[] = [],
): TagOwnerSummary {
    db.exec("BEGIN");
    try {
        return readTagOwnerSummary(db, sessionId, ratio, ratios);
    } finally {
        db.exec("ROLLBACK");
    }
}

export function cachedTagOwnerRatios(db: Database, sessionId: string): number[] {
    return [...(tagOwnerSummaries.get(db)?.get(sessionId)?.reasoningEstimatesByRatio.keys() ?? [])];
}

export type TagOwnerWarmupState = Pick<
    TagOwnerSummary,
    | "dataVersion"
    | "generation"
    | "schemaVersion"
    | "globalLastRowId"
    | "lastRowId"
    | "rowCount"
    | "identityRevision"
    | "unownedToolRows"
>;
export interface TagOwnerDelta {
    rows: TagOwnerRow[];
    adopted: TagOwnerRow[];
    globalLastRowId: number;
}

export function tagOwnerWarmupState(
    db: Database,
    sessionId: string,
): TagOwnerWarmupState | undefined {
    const cached = tagOwnerSummaries.get(db)?.get(sessionId);
    if (!cached || cached.unownedToolRows.size > TAG_OWNER_PAGE_LIMIT) return undefined;
    return {
        dataVersion: cached.dataVersion,
        generation: cached.generation,
        schemaVersion: cached.schemaVersion,
        globalLastRowId: cached.globalLastRowId,
        lastRowId: cached.lastRowId,
        rowCount: cached.rowCount,
        identityRevision: cached.identityRevision,
        unownedToolRows: new Set(cached.unownedToolRows),
    };
}

/** Foreign-commit shape counts run on the worker too, without transferring the cached maps. */
export function scanTagOwnerDelta(
    db: Database,
    sessionId: string,
    state: TagOwnerWarmupState,
): TagOwnerDelta | null {
    db.exec("BEGIN");
    try {
        const globalLastRowId = (
            db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM tags").get() as { id: number }
        ).id;
        if (globalLastRowId - state.globalLastRowId > TAG_OWNER_PAGE_LIMIT) return null;
        const rows = appendedSinceForeignCommit(db, sessionId, state);
        if (!rows) return null;
        return { rows, adopted: adoptedSinceForeignCommit(db, state), globalLastRowId };
    } finally {
        db.exec("ROLLBACK");
    }
}

export function installTagOwnerDelta(
    db: Database,
    sessionId: string,
    state: TagOwnerWarmupState,
    delta: TagOwnerDelta,
    versions: { dataVersion: number; schemaVersion: number; generation: number },
): boolean {
    const cached = tagOwnerSummaries.get(db)?.get(sessionId);
    if (
        !cached ||
        cached.rowCount !== state.rowCount ||
        cached.globalLastRowId !== state.globalLastRowId ||
        cached.identityRevision !== state.identityRevision ||
        delta.rows.length > TAG_OWNER_PAGE_LIMIT ||
        delta.adopted.length > TAG_OWNER_PAGE_LIMIT
    )
        return false;
    tagOwnerShapeChecks++;
    tagOwnerRowsRead += delta.rows.length + delta.adopted.length;
    for (const row of delta.rows) foldTagOwnerRow(cached, row);
    for (const row of delta.adopted) foldTagOwnerRow(cached, row, false);
    cached.globalLastRowId = delta.globalLastRowId;
    cached.dataVersion = versions.dataVersion;
    cached.schemaVersion = versions.schemaVersion;
    cached.generation = versions.generation;
    return true;
}

/** Use the original dataVersion, schemaVersion and generation validated by the caller. */
export function installTagOwnerSummary(
    db: Database,
    sessionId: string,
    summary: TagOwnerSummary,
    versions: { dataVersion: number; schemaVersion: number; generation: number },
    shapeChecked = false,
): void {
    if (shapeChecked) tagOwnerShapeChecks++;
    summary.dataVersion = versions.dataVersion;
    summary.schemaVersion = versions.schemaVersion;
    summary.generation = versions.generation;
    const sessions = tagOwnerSummaries.get(db) ?? new Map<string, TagOwnerSummary>();
    sessions.set(sessionId, summary);
    tagOwnerSummaries.set(db, sessions);
}

/** Readiness is checked through the ordinary invalidation and append path. */
export function isTagOwnerSummaryReady(db: Database, sessionId: string, ratio: number): boolean {
    try {
        readTagOwnerSummary(db, sessionId, ratio);
        return true;
    } catch (error) {
        if (error instanceof TagOwnerSummaryNotReady) return false;
        throw error;
    }
}
let tagOwnerRowsRead = 0;
let tagOwnerShapeChecks = 0;

/** @internal Tag rows the owner summary has read since the last reset. */
export function getTagOwnerRowsReadForTest(): number {
    return tagOwnerRowsRead;
}

/** @internal Shape checks made after another connection's commit since the last reset. */
export function getTagOwnerShapeChecksForTest(): number {
    return tagOwnerShapeChecks;
}

/** @internal */
export function resetTagOwnerRowsReadForTest(): void {
    tagOwnerRowsRead = 0;
    tagOwnerShapeChecks = 0;
}

function foldTagOwnerRow(summary: TagOwnerSummary, row: TagOwnerRow, newRow = true): void {
    summary.lastRowId = Math.max(summary.lastRowId, row.id);
    if (newRow) summary.rowCount += 1;
    if (row.type === "tool" && typeof row.tool_owner_message_id !== "string")
        summary.unownedToolRows.add(row.id);
    else summary.unownedToolRows.delete(row.id);
    const owner =
        row.type === "tool"
            ? typeof row.tool_owner_message_id === "string"
                ? row.tool_owner_message_id
                : null
            : typeof row.message_id === "string"
              ? contentTagOwnerMessageId(row.message_id)
              : null;
    if (owner) {
        summary.maxTagByOwner.set(
            owner,
            Math.max(summary.maxTagByOwner.get(owner) ?? 0, row.tag_number),
        );
    }
    if (row.type !== "message" || row.reasoning_token_count === null) return;
    const reasoningOwner = ownerMessageIdForTagRow({
        type: row.type,
        message_id: row.message_id as string,
        tool_owner_message_id: row.tool_owner_message_id,
    });
    for (const [ratio, estimates] of summary.reasoningEstimatesByRatio) {
        estimates.set(
            reasoningOwner,
            Math.max(estimates.get(reasoningOwner) ?? 0, row.reasoning_token_count * ratio),
        );
    }
}

const TAG_OWNER_COLUMNS =
    "id, type, message_id, tool_owner_message_id, tag_number, reasoning_token_count";

/**
 * Whether the connection has a transaction open. A handle whose state cannot be
 * read (a wrapping proxy, for instance) is treated as in a transaction. A
 * file-store read then defers rather than caching an uncommitted view.
 */
function connectionInTransaction(db: Database): boolean {
    try {
        const state = db as unknown as { inTransaction?: boolean; isTransaction?: boolean };
        return state.inTransaction !== false && state.isTransaction !== false;
    } catch {
        return true;
    }
}

/**
 * The rows above the cached highest id together with the session's tag count
 * and highest id, from one statement so all three describe the same commit.
 * The count and highest id come from the `(session_id, ...)` index alone.
 */
export const TAG_OWNER_APPENDED_WITH_SHAPE_SQL = `SELECT ${TAG_OWNER_COLUMNS}, 0 AS shape, NULL AS tag_count, NULL AS max_id, NULL AS revision
    FROM tags WHERE id > ? AND +session_id = ?
    UNION ALL
    SELECT NULL, NULL, NULL, NULL, NULL, NULL, 1, COUNT(*), MAX(id), (SELECT value FROM schema_migrations_meta WHERE key = ?)
    FROM tags WHERE session_id = ?`;

function readTagIdentityRevision(db: Database, sessionId: string): string | null {
    const row = db
        .prepare("SELECT value FROM schema_migrations_meta WHERE key = ?")
        .get(tagIdentityRevisionKey(sessionId)) as { value?: unknown } | null;
    return typeof row?.value === "string" ? row.value : null;
}

/** Record the revision created by the first append, not a later owner/reasoning edit. */
function captureInitialTagOwnerRevision(
    db: Database,
    sessionId: string,
    cached: TagOwnerSummary,
    appendedRows: number,
): boolean {
    if (cached.identityRevision !== null || appendedRows === 0) return true;
    const revision = readTagIdentityRevision(db, sessionId);
    // The stamp's count tracks changes to owner IDs or reasoning estimates.
    // A first append creates count zero. If it is already nonzero, the rows
    // selected above may predate an edit; reject instead of marking them current.
    if (revision !== null && !/^[1-9]\d*:0$/.test(revision)) return false;
    cached.identityRevision = revision;
    return true;
}

/**
 * After another connection's commit: the rows it appended to the session, or
 * null when the session changed in a way appends cannot explain.
 */
function appendedSinceForeignCommit(
    db: Database,
    sessionId: string,
    cached: TagOwnerWarmupState,
): TagOwnerRow[] | null {
    tagOwnerShapeChecks += 1;
    const rows = db
        .prepare(TAG_OWNER_APPENDED_WITH_SHAPE_SQL)
        .all(
            cached.globalLastRowId,
            sessionId,
            tagIdentityRevisionKey(sessionId),
            sessionId,
        ) as Array<
        TagOwnerRow & {
            shape: number;
            tag_count: number | null;
            max_id: number | null;
            revision: string | null;
        }
    >;
    const shape = rows.find((row) => row.shape === 1);
    const appended = rows.filter((row) => row.shape === 0);
    const highest = appended.reduce((max, row) => Math.max(max, row.id), cached.lastRowId);
    if (
        !shape ||
        // Another Magic Context connection rewrote a tag's identity or reasoning
        // count in this session; the count and highest id cannot show that.
        (shape.revision ?? null) !== cached.identityRevision ||
        shape.tag_count !== cached.rowCount + appended.length ||
        (shape.max_id ?? 0) !== highest
    )
        return null;
    return appended;
}

/** Ownerless tool tags of the summary that another process has since given an owner. */
function adoptedSinceForeignCommit(db: Database, cached: TagOwnerWarmupState): TagOwnerRow[] {
    if (cached.unownedToolRows.size === 0) return [];
    return db
        .prepare(
            `SELECT ${TAG_OWNER_COLUMNS} FROM tags
             WHERE id IN (SELECT value FROM json_each(?)) AND tool_owner_message_id IS NOT NULL LIMIT ${TAG_OWNER_PAGE_LIMIT + 1}`,
        )
        .all(JSON.stringify([...cached.unownedToolRows])) as TagOwnerRow[];
}

function readTagOwnerSummary(
    db: Database,
    sessionId: string,
    proseRatio?: number,
    extraRatios: number[] = [],
): TagOwnerSummary {
    const inTransaction = connectionInTransaction(db);
    const versions = inTransaction
        ? null
        : (db
              .prepare(
                  "SELECT data_version AS dataVersion, (SELECT schema_version FROM pragma_schema_version) AS schemaVersion FROM pragma_data_version",
              )
              .get() as { dataVersion?: number; schemaVersion?: number } | null);
    const dataVersion = versions?.dataVersion ?? -1;
    const schemaVersion = versions?.schemaVersion ?? -1;
    const generation = getTagIdentityWriteGeneration();
    const offThreadOnly = isMainThread && Boolean(getSqliteDatabasePath(db));
    const sessions = tagOwnerSummaries.get(db) ?? new Map<string, TagOwnerSummary>();
    const cached = inTransaction ? undefined : sessions.get(sessionId);
    if (
        cached &&
        (cached.generation === generation ||
            cached.identityRevision === readTagIdentityRevision(db, sessionId)) &&
        // A rebuilt or altered table can keep the session's count and highest id.
        cached.schemaVersion === schemaVersion &&
        (proseRatio === undefined || cached.reasoningEstimatesByRatio.has(proseRatio))
    ) {
        let rows: TagOwnerRow[] | null;
        let globalLastRowId = (
            db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM tags").get() as { id: number }
        ).id;
        if (
            offThreadOnly &&
            (globalLastRowId - cached.globalLastRowId > TAG_OWNER_PAGE_LIMIT ||
                (cached.dataVersion !== dataVersion &&
                    cached.unownedToolRows.size > TAG_OWNER_PAGE_LIMIT))
        )
            throw new TagOwnerSummaryNotReady();
        if (cached.dataVersion === dataVersion && cached.generation === generation) {
            // Only this connection wrote, and only appends. `+session_id` keeps
            // SQLite on the rowid range, so this reads the rows appended since,
            // in any session.
            const statement = db.prepare(
                `SELECT ${TAG_OWNER_COLUMNS} FROM tags WHERE id > ? AND +session_id = ? ORDER BY id LIMIT ${TAG_OWNER_PAGE_LIMIT + 1}`,
            );
            rows = statement.all(cached.globalLastRowId, sessionId) as TagOwnerRow[];
            // Memory stores cannot delegate to another connection. Drain every
            // page before advancing the high watermark, or later reads lose rows.
            if (!offThreadOnly) {
                let page = rows;
                while (page.length === TAG_OWNER_PAGE_LIMIT + 1) {
                    page = statement.all(page[page.length - 1].id, sessionId) as TagOwnerRow[];
                    rows.push(...page);
                }
            }
            // A first tag INSERT creates the identity revision without changing the
            // process's identity-edit generation. Remember that zero-count seed
            // with these appended rows; otherwise an unrelated peer commit later
            // compares it with cached null and discards this valid owner summary.
            if (!captureInitialTagOwnerRevision(db, sessionId, cached, rows.length)) {
                if (offThreadOnly) throw new TagOwnerSummaryNotReady();
                rows = null;
            }
        } else {
            // The count, revision and appended rows must describe one commit.
            // Unrelated context writes are not owner-digest invalidations.
            if (offThreadOnly) db.exec("BEGIN");
            try {
                globalLastRowId = (
                    db.prepare("SELECT COALESCE(MAX(id),0) AS id FROM tags").get() as { id: number }
                ).id;
                if (
                    offThreadOnly &&
                    globalLastRowId - cached.globalLastRowId > TAG_OWNER_PAGE_LIMIT
                )
                    throw new TagOwnerSummaryNotReady();
                rows = appendedSinceForeignCommit(db, sessionId, cached);
                const adopted = rows ? adoptedSinceForeignCommit(db, cached) : [];
                if (
                    !rows ||
                    rows.length > TAG_OWNER_PAGE_LIMIT ||
                    adopted.length > TAG_OWNER_PAGE_LIMIT
                ) {
                    if (offThreadOnly) throw new TagOwnerSummaryNotReady();
                } else if (offThreadOnly) {
                    tagOwnerRowsRead += rows.length + adopted.length;
                    for (const row of rows) foldTagOwnerRow(cached, row);
                    for (const row of adopted) foldTagOwnerRow(cached, row, false);
                    cached.dataVersion = dataVersion;
                    cached.generation = generation;
                    cached.globalLastRowId = globalLastRowId;
                    return cached;
                }
            } finally {
                if (offThreadOnly) db.exec("ROLLBACK");
            }
        }
        if (rows) {
            const adopted =
                cached.dataVersion === dataVersion ? [] : adoptedSinceForeignCommit(db, cached);
            if (
                isMainThread &&
                getSqliteDatabasePath(db) &&
                (rows.length > TAG_OWNER_PAGE_LIMIT || adopted.length > TAG_OWNER_PAGE_LIMIT)
            )
                throw new TagOwnerSummaryNotReady();
            tagOwnerRowsRead += rows.length + adopted.length;
            for (const row of rows) foldTagOwnerRow(cached, row);
            for (const row of adopted) foldTagOwnerRow(cached, row, false);
            cached.dataVersion = dataVersion;
            cached.generation = generation;
            cached.globalLastRowId = globalLastRowId;
            return cached;
        }
    }
    if (isMainThread && getSqliteDatabasePath(db)) throw new TagOwnerSummaryNotReady();
    const ratios = [
        ...new Set([...(cached?.reasoningEstimatesByRatio.keys() ?? []), ...extraRatios]),
    ];
    if (proseRatio !== undefined && !ratios.includes(proseRatio)) ratios.push(proseRatio);
    const summary: TagOwnerSummary = {
        dataVersion,
        schemaVersion,
        generation,
        lastRowId: 0,
        globalLastRowId: (
            db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM tags").get() as { id: number }
        ).id,
        rowCount: 0,
        unownedToolRows: new Set(),
        // Read the revision before the rows. A rewrite committed between the two
        // reads is already in the rows, and the revision check after the next
        // foreign commit sees the newer revision and rebuilds once more; the
        // other order could store a revision that already includes a rewrite
        // the rows miss.
        identityRevision: readTagIdentityRevision(db, sessionId),
        maxTagByOwner: new Map(),
        reasoningEstimatesByRatio: new Map(
            ratios.slice(-MAX_CACHED_PROSE_RATIOS).map((ratio) => [ratio, new Map()]),
        ),
    };
    const rows = db
        .prepare(`SELECT ${TAG_OWNER_COLUMNS} FROM tags WHERE session_id = ? ORDER BY id`)
        .all(sessionId) as TagOwnerRow[];
    tagOwnerRowsRead += rows.length;
    for (const row of rows) foldTagOwnerRow(summary, row);
    if (!inTransaction) {
        sessions.set(sessionId, summary);
        tagOwnerSummaries.set(db, sessions);
    }
    return summary;
}

/** Bump a tag's input_token_count — the token mirror of `updateTagInputByteSize`. */
export function updateTagInputTokenCount(
    db: Database,
    sessionId: string,
    tagNumber: number,
    newInputTokenCount: number,
): void {
    getUpdateTagInputTokenCountStatement(db).run(newInputTokenCount, sessionId, tagNumber);
}

/**
 * True when a tag row still has a NULL token_count — i.e. it was written before
 * the token columns existed (legacy) and needs a one-time backfill. Used by the
 * tagger's DB-existing (post-restart cold) path to decide whether to invoke the
 * tokenizer thunk; populated rows skip it so a restart never re-tokenizes.
 */
export function tagTokenCountIsNull(db: Database, sessionId: string, tagNumber: number): boolean {
    const row = db
        .prepare("SELECT token_count FROM tags WHERE session_id = ? AND tag_number = ?")
        .get(sessionId, tagNumber) as { token_count: number | null } | undefined | null;
    // `!= null` guards a no-row result (`.get()` yields null, not the JS undefined
    // sentinel) — `row !== undefined` alone would let that null through to
    // `null.token_count` and crash.
    return row != null && row.token_count === null;
}

/**
 * One-time backfill of a legacy tag's token columns. Guarded by
 * `token_count IS NULL` so it is idempotent and a no-op once populated (a later
 * pass / restart cannot clobber a real count). Mirrors the byte columns set at
 * insert time.
 */
export function backfillTagTokenCounts(
    db: Database,
    sessionId: string,
    tagNumber: number,
    counts: TagTokenCounts,
): void {
    db.prepare(
        `UPDATE tags
            SET token_count = CASE WHEN ? IS NOT NULL THEN MAX(COALESCE(token_count, 0), ?) ELSE token_count END,
                input_token_count = ?,
                reasoning_token_count = ?
            WHERE session_id = ? AND tag_number = ? AND token_count IS NULL`,
    ).run(
        counts.tokenCount ?? null,
        counts.tokenCount ?? null,
        counts.inputTokenCount ?? null,
        counts.reasoningTokenCount ?? null,
        sessionId,
        tagNumber,
    );
}

function getUpdateTagMessageIdStatement(db: Database): PreparedStatement {
    let stmt = updateTagMessageIdStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `UPDATE tags SET message_id = ?
             WHERE session_id = ?
               AND tag_number = ?
               AND message_id NOT LIKE '${WHITESPACE_ASSISTANT_INERT_MESSAGE_PREFIX}%'`,
        );
        updateTagMessageIdStatements.set(db, stmt);
    }
    return stmt;
}

function getTagNumbersByMessageIdStatement(db: Database): PreparedStatement {
    let stmt = getTagNumbersByMessageIdStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT tag_number FROM tags WHERE session_id = ? AND (message_id = ? OR message_id LIKE ? ESCAPE '\\' OR message_id LIKE ? ESCAPE '\\' OR message_id LIKE ? ESCAPE '\\') ORDER BY tag_number ASC",
        );
        getTagNumbersByMessageIdStatements.set(db, stmt);
    }
    return stmt;
}

function getDeleteTagsByMessageIdStatement(db: Database): PreparedStatement {
    let stmt = deleteTagsByMessageIdStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "DELETE FROM tags WHERE session_id = ? AND (message_id = ? OR message_id LIKE ? ESCAPE '\\' OR message_id LIKE ? ESCAPE '\\' OR message_id LIKE ? ESCAPE '\\')",
        );
        deleteTagsByMessageIdStatements.set(db, stmt);
    }
    return stmt;
}

function getMaxTagNumberBySessionStatement(db: Database): PreparedStatement {
    let stmt = getMaxTagNumberBySessionStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT COALESCE(MAX(tag_number), 0) AS max_tag_number FROM tags WHERE session_id = ?",
        );
        getMaxTagNumberBySessionStatements.set(db, stmt);
    }
    return stmt;
}

function getTagNumberByMessageIdStatement(db: Database): PreparedStatement {
    let stmt = getTagNumberByMessageIdStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            // Without the owner index SQLite may walk the entire session in tag
            // order to satisfy LIMIT, making repeated whitespace probes quadratic.
            "SELECT tag_number FROM tags INDEXED BY idx_tags_session_message_id WHERE session_id = ? AND message_id = ? ORDER BY tag_number ASC LIMIT 1",
        );
        getTagNumberByMessageIdStatements.set(db, stmt);
    }
    return stmt;
}

function getAssignableTagNumberByMessageIdStatement(db: Database): PreparedStatement {
    let stmt = getAssignableTagNumberByMessageIdStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            // Pin the owner index for the same reason as the statement above: a
            // miss (every newly seen message) otherwise walks the whole session in
            // tag order looking for a first match that does not exist.
            `SELECT tag_number FROM tags INDEXED BY idx_tags_session_message_id
             WHERE session_id = ?
               AND message_id = ?
               AND NOT (
                   status = 'compacted'
                   AND COALESCE(
                       entry_fingerprint LIKE '${WHITESPACE_ASSISTANT_INERT_FINGERPRINT_PREFIX}%',
                       0
                   ) = 1
               )
             ORDER BY tag_number ASC
             LIMIT 1`,
        );
        getAssignableTagNumberByMessageIdStatements.set(db, stmt);
    }
    return stmt;
}

interface TagRow {
    id: number;
    message_id: string;
    type: string;
    status: string;
    drop_mode: string | null;
    tool_name: string | null;
    input_byte_size: number | null;
    byte_size: number;
    reasoning_byte_size: number;
    session_id: string;
    tag_number: number;
    caveman_depth: number | null;
    tool_owner_message_id: string | null;
    token_count?: number | null;
}

interface TagNumberRow {
    tag_number: number;
}

interface MaxTagNumberRow {
    max_tag_number: number;
}

function isTagRow(row: unknown): row is TagRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return (
        typeof r.id === "number" &&
        typeof r.message_id === "string" &&
        typeof r.type === "string" &&
        typeof r.status === "string" &&
        typeof r.byte_size === "number" &&
        typeof r.session_id === "string" &&
        typeof r.tag_number === "number"
    );
    // reasoning_byte_size may be missing on old rows (ensureColumn adds DEFAULT 0)
}

function toTagEntry(row: TagRow): TagEntry {
    const type = row.type === "tool" ? "tool" : row.type === "file" ? "file" : "message";
    const status = row.status === "dropped" || row.status === "compacted" ? row.status : "active";

    return {
        id: row.id,
        tagNumber: row.tag_number,
        messageId: row.message_id,
        type,
        status,
        dropMode:
            row.drop_mode === "truncated"
                ? "truncated"
                : row.drop_mode === "skeleton_real"
                  ? "skeleton_real"
                  : row.drop_mode === "skeleton_stripped"
                    ? "skeleton_stripped"
                    : row.drop_mode === "edit_marker"
                      ? "edit_marker"
                      : row.drop_mode === "edit_marker_stripped"
                        ? "edit_marker_stripped"
                        : "full",
        toolName: row.tool_name ?? null,
        inputByteSize: row.input_byte_size ?? 0,
        byteSize: row.byte_size,
        reasoningByteSize: row.reasoning_byte_size ?? 0,
        sessionId: row.session_id,
        // ensureColumn adds DEFAULT 0 but SQLite leaves NULL on pre-existing
        // rows. Coerce to 0 so downstream callers never see NaN arithmetic.
        cavemanDepth:
            typeof row.caveman_depth === "number" && Number.isFinite(row.caveman_depth)
                ? row.caveman_depth
                : 0,
        // tool_owner_message_id is the third axis of tool-tag identity.
        // NULL is the legitimate value for non-tool tags AND for legacy
        // tool tags written before plugin v0.16.x. Lazy adoption +
        // backfill populate this column at runtime; see plan v3.3.1.
        toolOwnerMessageId:
            typeof row.tool_owner_message_id === "string" ? row.tool_owner_message_id : null,
        tokenCount: typeof row.token_count === "number" ? row.token_count : null,
    };
}

/** Apply the session reader's validation and legacy defaults to one SQL row. */
export function normalizeTagSnapshotRow(row: unknown): TagEntry | null {
    return isTagRow(row) ? toTagEntry(row) : null;
}

function isTagNumberRow(row: unknown): row is TagNumberRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return typeof r.tag_number === "number";
}

function isMaxTagNumberRow(row: unknown): row is MaxTagNumberRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return typeof r.max_tag_number === "number";
}

function escapeLikePattern(value: string): string {
    return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

/**
 * Per-tag token counts (real Claude tokenizer), computed once at insert time.
 * `null` fields mean "not measured" (legacy callers / rows predating the
 * columns); readers treat NULL as a fall-back-per-call signal.
 */
export interface TagTokenCounts {
    tokenCount: number | null;
    inputTokenCount: number | null;
    reasoningTokenCount: number | null;
}

export function insertTag(
    db: Database,
    sessionId: string,
    messageId: string,
    type: TagEntry["type"],
    byteSize: number,
    tagNumber: number,
    reasoningByteSize: number = 0,
    toolName: string | null = null,
    inputByteSize: number = 0,
    toolOwnerMessageId: string | null = null,
    entryFingerprint: string | null = null,
    tokenCounts: TagTokenCounts | null = null,
): number {
    getInsertTagStatement(db).run(
        sessionId,
        messageId,
        type,
        byteSize,
        reasoningByteSize,
        tagNumber,
        toolName,
        inputByteSize,
        getHarness(),
        toolOwnerMessageId,
        entryFingerprint,
        tokenCounts?.tokenCount ?? null,
        tokenCounts?.inputTokenCount ?? null,
        tokenCounts?.reasoningTokenCount ?? null,
    );

    return tagNumber;
}

export function updateTagStatus(
    db: Database,
    sessionId: string,
    tagId: number,
    status: TagEntry["status"],
): void {
    getUpdateTagStatusStatement(db).run(status, sessionId, tagId);
}

const droppedTagStatements = new WeakMap<Database, PreparedStatement>();

/** Persist the complete drop decision with one tag update, before changing wire bytes. */
export function markTagDropped(
    db: Database,
    sessionId: string,
    tagId: number,
    mode?: TagEntry["dropMode"],
): void {
    if (!mode) {
        updateTagStatus(db, sessionId, tagId, "dropped");
        return;
    }
    let statement = droppedTagStatements.get(db);
    if (!statement) {
        statement = db.prepare(
            "UPDATE tags SET status = ?, drop_mode = ? WHERE session_id = ? AND tag_number = ?",
        );
        droppedTagStatements.set(db, statement);
    }
    statement.run("dropped", mode, sessionId, tagId);
}

export interface InertWhitespaceAssistantTag {
    tagNumber: number;
    contentId: string;
}

/**
 * Remove a legacy whitespace-only assistant tag from reclaim accounting while retaining
 * enough identity to replay its pre-deploy prefix without occupying the live part id.
 */
export function markWhitespaceAssistantTagInert(
    db: Database,
    sessionId: string,
    tagNumber: number,
    contentId: string,
): void {
    db.prepare(
        `UPDATE tags
         SET status = 'compacted',
             message_id = ?,
             entry_fingerprint = ?
         WHERE session_id = ? AND tag_number = ? AND type = 'message'`,
    ).run(
        `${WHITESPACE_ASSISTANT_INERT_MESSAGE_PREFIX}${tagNumber}`,
        `${WHITESPACE_ASSISTANT_INERT_FINGERPRINT_PREFIX}${contentId}`,
        sessionId,
        tagNumber,
    );
}

const inertWhitespaceStatements = new WeakMap<Database, PreparedStatement>();

/** Load legacy whitespace tags for cache-stable prefix replay; these rows are never active. */
export function getInertWhitespaceAssistantTags(
    db: Database,
    sessionId: string,
    messageIds?: readonly string[],
): InertWhitespaceAssistantTag[] {
    if (messageIds) {
        // The fingerprint index lets the wire reader seek each visible owner instead
        // of scanning every compacted tag. The unscoped form below reads every
        // retired tag in the session; ctx_reduce uses
        // getInertWhitespaceAssistantTagsByNumbers instead.
        let statement = inertWhitespaceStatements.get(db);
        if (!statement) {
            // CROSS JOIN keeps the small owner list outside the fingerprint index
            // seek, rather than scanning every retired row in a long session.
            statement = db.prepare(
                `SELECT tag_number AS tagNumber, entry_fingerprint AS entryFingerprint
                 FROM json_each(?) AS owners CROSS JOIN tags
                 WHERE tags.session_id = ? AND tags.type = 'message' AND tags.status = 'compacted'
                   AND entry_fingerprint >= ? || owners.value || ':p'
                   AND entry_fingerprint < ? || owners.value || ':q'
                 ORDER BY CAST(owners.key AS INTEGER), entry_fingerprint, tags.id`,
            );
            inertWhitespaceStatements.set(db, statement);
        }
        const rows = statement.all(
            JSON.stringify([...new Set(messageIds)]),
            sessionId,
            WHITESPACE_ASSISTANT_INERT_FINGERPRINT_PREFIX,
            WHITESPACE_ASSISTANT_INERT_FINGERPRINT_PREFIX,
        ) as Array<{
            tagNumber: number;
            entryFingerprint: string;
        }>;
        return rows.map((row) => ({
            tagNumber: row.tagNumber,
            contentId: row.entryFingerprint.slice(
                WHITESPACE_ASSISTANT_INERT_FINGERPRINT_PREFIX.length,
            ),
        }));
    }
    const rows = db
        .prepare(
            `SELECT tag_number AS tagNumber, entry_fingerprint AS entryFingerprint
             FROM tags
             WHERE session_id = ?
               AND type = 'message'
               AND status = 'compacted'
               AND entry_fingerprint LIKE ?`,
        )
        .all(sessionId, `${WHITESPACE_ASSISTANT_INERT_FINGERPRINT_PREFIX}%`) as Array<{
        tagNumber: number;
        entryFingerprint: string;
    }>;
    return rows.flatMap((row) => {
        const contentId = row.entryFingerprint.slice(
            WHITESPACE_ASSISTANT_INERT_FINGERPRINT_PREFIX.length,
        );
        return contentId.length > 0 ? [{ tagNumber: row.tagNumber, contentId }] : [];
    });
}

const inertWhitespaceByNumberStatements = new WeakMap<Database, PreparedStatement>();

/**
 * The inert whitespace tags among `tagNumbers`: the same rows, with the same
 * predicate and content-id rule, as the unscoped
 * {@link getInertWhitespaceAssistantTags}, restricted to the given numbers.
 * Each number is a seek on the UNIQUE(session_id, tag_number) index, so the
 * cost follows the request rather than the session's tag count, which runs to
 * tens of thousands of retired rows on long sessions.
 */
export function getInertWhitespaceAssistantTagsByNumbers(
    db: Database,
    sessionId: string,
    tagNumbers: readonly number[],
): InertWhitespaceAssistantTag[] {
    if (tagNumbers.length === 0) return [];
    let statement = inertWhitespaceByNumberStatements.get(db);
    if (!statement) {
        // CROSS JOIN keeps the requested numbers outside the index seek.
        statement = db.prepare(
            `SELECT tags.tag_number AS tagNumber, tags.entry_fingerprint AS entryFingerprint
             FROM json_each(?) AS wanted CROSS JOIN tags
             WHERE tags.session_id = ?
               AND tags.tag_number = wanted.value
               AND tags.type = 'message'
               AND tags.status = 'compacted'
               AND tags.entry_fingerprint LIKE ?
             ORDER BY tags.tag_number, tags.id`,
        );
        inertWhitespaceByNumberStatements.set(db, statement);
    }
    const rows = statement.all(
        JSON.stringify([...new Set(tagNumbers)]),
        sessionId,
        `${WHITESPACE_ASSISTANT_INERT_FINGERPRINT_PREFIX}%`,
    ) as Array<{ tagNumber: number; entryFingerprint: string }>;
    return rows.flatMap((row) => {
        const contentId = row.entryFingerprint.slice(
            WHITESPACE_ASSISTANT_INERT_FINGERPRINT_PREFIX.length,
        );
        return contentId.length > 0 ? [{ tagNumber: row.tagNumber, contentId }] : [];
    });
}

export function updateTagDropMode(
    db: Database,
    sessionId: string,
    tagNumber: number,
    dropMode: TagEntry["dropMode"],
): void {
    getUpdateTagDropModeStatement(db).run(dropMode, sessionId, tagNumber);
}

/**
 * Set the caveman compression depth for a tag.
 *
 * Only message tags are expected to receive non-zero depth; callers enforce
 * that. Persisted so later transform passes and restarts can resume without
 * re-compressing text that already matches its target age-tier depth.
 */
export function updateCavemanDepth(
    db: Database,
    sessionId: string,
    tagNumber: number,
    depth: number,
): void {
    db.prepare("UPDATE tags SET caveman_depth = ? WHERE session_id = ? AND tag_number = ?").run(
        depth,
        sessionId,
        tagNumber,
    );
}

export function updateTagMessageId(
    db: Database,
    sessionId: string,
    tagId: number,
    messageId: string,
): void {
    getUpdateTagMessageIdStatement(db).run(messageId, sessionId, tagId);
}

/** Return whether this session has any message tag bound to a fallback Pi id. */
export function hasPiFallbackMessageTags(db: Database, sessionId: string): boolean {
    let statement = hasPiFallbackMessageTagStatements.get(db);
    if (!statement) {
        statement = db.prepare(
            `SELECT 1
             FROM tags
             WHERE session_id = ?
               AND type = 'message'
               AND message_id LIKE 'pi-msg-%'
             LIMIT 1`,
        );
        hasPiFallbackMessageTagStatements.set(db, statement);
    }
    return statement.get(sessionId) != null;
}

/**
 * Pi fallback-tag adoption lookup. Find the message-text tag(s) created under a
 * `pi-msg-*` fallback id for a given (session, entry_fingerprint), so the next
 * pass can migrate them onto the message's real SessionEntry id. Returns the
 * candidate rows (tag_number + current message_id) for the caller to apply the
 * per-part uniqueness guard and race-safe migrate. Scoped to `type='message'`
 * and the fallback-id shape so a real-id row is never re-adopted.
 */
export function findAdoptableFallbackTags(
    db: Database,
    sessionId: string,
    entryFingerprint: string,
): Array<{ tagNumber: number; messageId: string }> {
    const rows = db
        .prepare(
            `SELECT tag_number AS tagNumber, message_id AS messageId
             FROM tags
             WHERE session_id = ?
               AND type = 'message'
               AND entry_fingerprint = ?
               AND message_id LIKE 'pi-msg-%'`,
        )
        .all(sessionId, entryFingerprint) as Array<{ tagNumber: number; messageId: string }>;
    return rows;
}

/**
 * Race-safe migrate of a tag's `message_id` from a known old (fallback) value to
 * a new (real) value. The old value in the WHERE clause is the concurrency fence
 * (mirrors `adoptNullOwnerToolTag`'s NULL guard): if a sibling process already
 * migrated or re-keyed the row, `changes === 0` and the caller skips. Trigger
 * writes may increase a positive count, so only zero versus nonzero is meaningful.
 * Returns true iff exactly this migration applied.
 */
export function adoptFallbackTagMessageId(
    db: Database,
    sessionId: string,
    tagNumber: number,
    oldFallbackMessageId: string,
    newRealMessageId: string,
): boolean {
    if (oldFallbackMessageId.startsWith(WHITESPACE_ASSISTANT_INERT_MESSAGE_PREFIX)) return false;
    const result = db
        .prepare(
            `UPDATE tags SET message_id = ?
             WHERE session_id = ? AND tag_number = ? AND message_id = ?`,
        )
        .run(newRealMessageId, sessionId, tagNumber, oldFallbackMessageId);
    return (result.changes ?? 0) > 0;
}

export interface PiFallbackToolOwnerTag {
    tagNumber: number;
    callId: string;
    toolOwnerMessageId: string;
    status: string;
}

export type PiFallbackTagAdoptionResult =
    | { action: "skipped" }
    | { action: "rekeyed"; tagNumber: number }
    | { action: "folded"; tagNumber: number; deletedTagNumbers: number[] };

interface PiFallbackFoldTagRow {
    tagNumber: number;
    messageId: string;
    toolOwnerMessageId: string | null;
    type: string;
    status: string;
    byteSize: number | null;
    reasoningByteSize: number | null;
    inputByteSize: number | null;
    tokenCount: number | null;
    inputTokenCount: number | null;
    reasoningTokenCount: number | null;
}

interface PendingOpIdentityRow {
    id: number;
    operation: string;
}

function isPiFallbackToolOwnerTag(row: unknown): row is PiFallbackToolOwnerTag {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return (
        typeof r.tagNumber === "number" &&
        typeof r.callId === "string" &&
        typeof r.toolOwnerMessageId === "string" &&
        typeof r.status === "string"
    );
}

function isPiFallbackFoldTagRow(row: unknown): row is PiFallbackFoldTagRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return (
        typeof r.tagNumber === "number" &&
        typeof r.messageId === "string" &&
        (typeof r.toolOwnerMessageId === "string" || r.toolOwnerMessageId === null) &&
        typeof r.type === "string" &&
        typeof r.status === "string" &&
        (typeof r.byteSize === "number" || r.byteSize === null) &&
        (typeof r.reasoningByteSize === "number" || r.reasoningByteSize === null) &&
        (typeof r.inputByteSize === "number" || r.inputByteSize === null) &&
        (typeof r.tokenCount === "number" || r.tokenCount === null) &&
        (typeof r.inputTokenCount === "number" || r.inputTokenCount === null) &&
        (typeof r.reasoningTokenCount === "number" || r.reasoningTokenCount === null)
    );
}

function isPendingOpIdentityRow(row: unknown): row is PendingOpIdentityRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return typeof r.id === "number" && typeof r.operation === "string";
}

function maxNullableNumber(a: number | null, b: number | null): number | null {
    if (typeof a === "number" && typeof b === "number") return Math.max(a, b);
    if (typeof a === "number") return a;
    if (typeof b === "number") return b;
    return null;
}

function getPiFallbackFoldTagRowByNumber(
    db: Database,
    sessionId: string,
    tagNumber: number,
): PiFallbackFoldTagRow | null {
    const row = db
        .prepare(
            `SELECT tag_number AS tagNumber,
                    message_id AS messageId,
                    tool_owner_message_id AS toolOwnerMessageId,
                    type,
                    status,
                    byte_size AS byteSize,
                    reasoning_byte_size AS reasoningByteSize,
                    input_byte_size AS inputByteSize,
                    token_count AS tokenCount,
                    input_token_count AS inputTokenCount,
                    reasoning_token_count AS reasoningTokenCount
             FROM tags
             WHERE session_id = ? AND tag_number = ?`,
        )
        .get(sessionId, tagNumber);
    return isPiFallbackFoldTagRow(row) ? row : null;
}

function getPiFallbackToolFoldTagRowByOwner(
    db: Database,
    sessionId: string,
    callId: string,
    ownerMsgId: string,
): PiFallbackFoldTagRow | null {
    const row = db
        .prepare(
            `SELECT tag_number AS tagNumber,
                    message_id AS messageId,
                    tool_owner_message_id AS toolOwnerMessageId,
                    type,
                    status,
                    byte_size AS byteSize,
                    reasoning_byte_size AS reasoningByteSize,
                    input_byte_size AS inputByteSize,
                    token_count AS tokenCount,
                    input_token_count AS inputTokenCount,
                    reasoning_token_count AS reasoningTokenCount
             FROM tags
             WHERE session_id = ?
               AND message_id = ?
               AND type = 'tool'
               AND tool_owner_message_id = ?
             LIMIT 1`,
        )
        .get(sessionId, callId, ownerMsgId);
    return isPiFallbackFoldTagRow(row) ? row : null;
}

function getPiFallbackMessageFoldTagRowsByMessageId(
    db: Database,
    sessionId: string,
    messageId: string,
): PiFallbackFoldTagRow[] {
    return db
        .prepare(
            `SELECT tag_number AS tagNumber,
                    message_id AS messageId,
                    tool_owner_message_id AS toolOwnerMessageId,
                    type,
                    status,
                    byte_size AS byteSize,
                    reasoning_byte_size AS reasoningByteSize,
                    input_byte_size AS inputByteSize,
                    token_count AS tokenCount,
                    input_token_count AS inputTokenCount,
                    reasoning_token_count AS reasoningTokenCount
             FROM tags
             WHERE session_id = ?
               AND message_id = ?
               AND type = 'message'
             ORDER BY tag_number ASC`,
        )
        .all(sessionId, messageId)
        .filter(isPiFallbackFoldTagRow);
}

const foldStatements = new WeakMap<Database, Map<string, PreparedStatement>>();

/**
 * One compiled statement per connection and SQL text. Folding runs once per
 * duplicate tag, and a store conversion can fold thousands of them in one
 * transaction, so compiling the same few statements again for every tag was a
 * measurable share of the work.
 */
function foldStatement(db: Database, sql: string): PreparedStatement {
    let statements = foldStatements.get(db);
    if (!statements) {
        statements = new Map();
        foldStatements.set(db, statements);
    }
    let statement = statements.get(sql);
    if (!statement) {
        statement = db.prepare(sql);
        statements.set(sql, statement);
    }
    return statement;
}

function mergeSizeAndTokenColumnsIntoSurvivor(
    db: Database,
    sessionId: string,
    survivor: PiFallbackFoldTagRow,
    duplicate: PiFallbackFoldTagRow,
): void {
    foldStatement(
        db,
        `UPDATE tags
         SET byte_size = ?,
             reasoning_byte_size = ?,
             input_byte_size = ?,
             token_count = ?,
             input_token_count = ?,
             reasoning_token_count = ?
         WHERE session_id = ? AND tag_number = ?`,
    ).run(
        maxNullableNumber(survivor.byteSize, duplicate.byteSize),
        maxNullableNumber(survivor.reasoningByteSize, duplicate.reasoningByteSize),
        maxNullableNumber(survivor.inputByteSize, duplicate.inputByteSize),
        maxNullableNumber(survivor.tokenCount, duplicate.tokenCount),
        maxNullableNumber(survivor.inputTokenCount, duplicate.inputTokenCount),
        maxNullableNumber(survivor.reasoningTokenCount, duplicate.reasoningTokenCount),
        sessionId,
        survivor.tagNumber,
    );
    survivor.byteSize = maxNullableNumber(survivor.byteSize, duplicate.byteSize);
    survivor.reasoningByteSize = maxNullableNumber(
        survivor.reasoningByteSize,
        duplicate.reasoningByteSize,
    );
    survivor.inputByteSize = maxNullableNumber(survivor.inputByteSize, duplicate.inputByteSize);
    survivor.tokenCount = maxNullableNumber(survivor.tokenCount, duplicate.tokenCount);
    survivor.inputTokenCount = maxNullableNumber(
        survivor.inputTokenCount,
        duplicate.inputTokenCount,
    );
    survivor.reasoningTokenCount = maxNullableNumber(
        survivor.reasoningTokenCount,
        duplicate.reasoningTokenCount,
    );
}

function applyDroppedStatusIfNeeded(
    db: Database,
    sessionId: string,
    survivor: PiFallbackFoldTagRow,
    duplicate: PiFallbackFoldTagRow,
): void {
    if (survivor.status === "dropped") return;
    if (duplicate.status !== "dropped") return;
    foldStatement(
        db,
        "UPDATE tags SET status = 'dropped' WHERE session_id = ? AND tag_number = ?",
    ).run(sessionId, survivor.tagNumber);
    survivor.status = "dropped";
}

function retargetPendingOps(
    db: Database,
    sessionId: string,
    fromTagNumber: number,
    toTagNumber: number,
): void {
    const rows = foldStatement(
        db,
        `SELECT id, operation
         FROM pending_ops
         WHERE session_id = ? AND tag_id = ?
         ORDER BY id ASC`,
    )
        .all(sessionId, fromTagNumber)
        .filter(isPendingOpIdentityRow);
    for (const row of rows) {
        const existing = foldStatement(
            db,
            `SELECT 1
             FROM pending_ops
             WHERE session_id = ? AND tag_id = ? AND operation = ?
             LIMIT 1`,
        ).get(sessionId, toTagNumber, row.operation);
        if (existing) {
            foldStatement(db, "DELETE FROM pending_ops WHERE session_id = ? AND id = ?").run(
                sessionId,
                row.id,
            );
        } else {
            foldStatement(
                db,
                "UPDATE pending_ops SET tag_id = ? WHERE session_id = ? AND id = ?",
            ).run(toTagNumber, sessionId, row.id);
        }
    }
    foldStatement(db, "DELETE FROM pending_ops WHERE session_id = ? AND tag_id = ?").run(
        sessionId,
        fromTagNumber,
    );
}

function deleteFoldedDuplicateTag(db: Database, sessionId: string, tagNumber: number): void {
    foldStatement(db, "DELETE FROM source_contents WHERE session_id = ? AND tag_id = ?").run(
        sessionId,
        tagNumber,
    );
    foldStatement(db, "DELETE FROM tags WHERE session_id = ? AND tag_number = ?").run(
        sessionId,
        tagNumber,
    );
    foldStatement(db, "DELETE FROM pending_ops WHERE session_id = ? AND tag_id = ?").run(
        sessionId,
        tagNumber,
    );
}

function foldDuplicateIntoSurvivor(
    db: Database,
    sessionId: string,
    survivor: PiFallbackFoldTagRow,
    duplicate: PiFallbackFoldTagRow,
    /**
     * False when the caller already knows no queued operation targets the
     * duplicate, which lets a bulk fold skip the per-tag queue lookup.
     */
    duplicateMayHaveQueuedOps = true,
    /**
     * False when the duplicate's content is now only a fragment of the
     * survivor's, so its executed drop must not hide the survivor.
     */
    propagateDroppedStatus = true,
): void {
    mergeSizeAndTokenColumnsIntoSurvivor(db, sessionId, survivor, duplicate);
    if (propagateDroppedStatus) applyDroppedStatusIfNeeded(db, sessionId, survivor, duplicate);
    if (duplicateMayHaveQueuedOps) {
        retargetPendingOps(db, sessionId, duplicate.tagNumber, survivor.tagNumber);
    }
    deleteFoldedDuplicateTag(db, sessionId, duplicate.tagNumber);
}

/** One message whose host projection now exposes fewer parts than it did when its tags were minted. */
export interface ShrunkPartMessage {
    messageId: string;
    /** Number of parts the RUNNING host projection gives this message. */
    partCount: number;
}

export interface MergedPartTagFoldResult {
    /** Tags deleted because their part index no longer exists on the wire. */
    foldedTagNumbers: number[];
    /** Tags whose content id was moved down to `:p0` because no `:p0` tag existed. */
    rekeyedTagNumbers: number[];
    /** Queued `ctx_reduce` drops removed because the fold would have widened their target. */
    discardedDropTagNumbers: number[];
}

interface PartTagRow extends PiFallbackFoldTagRow {
    partIndex: number;
}

/**
 * Every message tag of the session keyed `<messageId>:p<digits>`, grouped by
 * the message id and ordered by part index (tag number within one index).
 *
 * One read for the whole session, instead of one LIKE scan per message: a LIKE
 * with an ESCAPE clause cannot use the (session_id, message_id) index, so the
 * per-message form scanned every tag of the session once per joined message and
 * made a store conversion quadratic in the session size.
 *
 * The split is unambiguous: the digits after the LAST `:p` are the part index
 * and everything before it is the message id, which is exactly the set of rows
 * the per-message `<messageId>:p%` pattern plus the digits-only check selected.
 * Anything that is not a plain part index (`:pfile`) is left alone rather than
 * guessed at.
 */
function readPartTagRowsByMessage(db: Database, sessionId: string): Map<string, PartTagRow[]> {
    const rows = db
        .prepare(
            `SELECT tag_number AS tagNumber,
                    message_id AS messageId,
                    tool_owner_message_id AS toolOwnerMessageId,
                    type,
                    status,
                    byte_size AS byteSize,
                    reasoning_byte_size AS reasoningByteSize,
                    input_byte_size AS inputByteSize,
                    token_count AS tokenCount,
                    input_token_count AS inputTokenCount,
                    reasoning_token_count AS reasoningTokenCount
             FROM tags
             WHERE session_id = ?
               AND type = 'message'
             ORDER BY tag_number ASC`,
        )
        .all(sessionId)
        .filter(isPiFallbackFoldTagRow);
    const byMessage = new Map<string, PartTagRow[]>();
    for (const row of rows) {
        const marker = row.messageId.lastIndexOf(":p");
        if (marker < 0) continue;
        const suffix = row.messageId.slice(marker + 2);
        if (!/^\d+$/.test(suffix)) continue;
        const messageId = row.messageId.slice(0, marker);
        const group = byMessage.get(messageId);
        const entry = { ...row, partIndex: Number.parseInt(suffix, 10) };
        if (group) group.push(entry);
        else byMessage.set(messageId, [entry]);
    }
    // Stable sort: rows sharing a part index stay in tag-number order.
    for (const group of byMessage.values()) group.sort((a, b) => a.partIndex - b.partIndex);
    return byMessage;
}

/** Tag numbers of the session with a queued operation, all of them and drops alone. */
function readQueuedTagNumbers(
    db: Database,
    sessionId: string,
): { any: Set<number>; drop: Set<number> } {
    const rows = db
        .prepare(
            "SELECT tag_id AS tagNumber, operation FROM pending_ops WHERE session_id = ? AND tag_id IS NOT NULL",
        )
        .all(sessionId) as Array<{ tagNumber?: unknown; operation?: unknown }>;
    const any = new Set<number>();
    const drop = new Set<number>();
    for (const row of rows) {
        if (typeof row.tagNumber !== "number") continue;
        any.add(row.tagNumber);
        if (row.operation === "drop") drop.add(row.tagNumber);
    }
    return { any, drop };
}

/**
 * Re-seat message part tags after the host changed how many parts a message has.
 *
 * A message tag is keyed by the content id `<messageId>:p<index>`, where the
 * index is the message's own part position. When the host rewrites a multi-part
 * message into a single joined text part, every tag above the surviving index
 * loses its target: the text it was minted for is now part of the first part's
 * text. Those tags are folded into the first part's tag through the same
 * merge/retarget path a duplicate tag takes, so the §N§ already shown to the
 * model keeps its meaning and nothing is renumbered.
 *
 * A queued `ctx_reduce` drop is NOT carried across the fold unless every part
 * tag of that message carries one. The user authorised removing one fragment;
 * after the merge that same operation would remove the whole joined text, which
 * is a larger deletion than the one they asked for. Those queue entries are
 * removed and reported to the caller instead.
 *
 * An executed drop follows the same rule: a folded tag's `dropped` status is
 * not copied onto the surviving tag, because the survivor now stands for the
 * whole joined text. When every fragment was dropped the survivor is one of
 * them and is already `dropped`, so the joined text stays hidden.
 */
export function foldShrunkPartTags(
    db: Database,
    sessionId: string,
    messages: readonly ShrunkPartMessage[],
): MergedPartTagFoldResult {
    const result: MergedPartTagFoldResult = {
        foldedTagNumbers: [],
        rekeyedTagNumbers: [],
        discardedDropTagNumbers: [],
    };
    if (messages.length === 0) return result;
    // Read once for the whole session. Folding one message only rewrites that
    // message's own tags and the queue entries that target them, so the rows
    // read up front are exactly what a per-message read would have returned
    // at that message's turn.
    const rowsByMessage = readPartTagRowsByMessage(db, sessionId);
    const queuedTags = readQueuedTagNumbers(db, sessionId);
    const discardDrop = foldStatement(
        db,
        "DELETE FROM pending_ops WHERE session_id = ? AND tag_id = ? AND operation = 'drop'",
    );
    const rekey = foldStatement(
        db,
        "UPDATE tags SET message_id = ? WHERE session_id = ? AND tag_number = ? AND type = 'message'",
    );
    for (const { messageId, partCount } of messages) {
        const rows = rowsByMessage.get(messageId) ?? [];
        if (rows.length === 0) continue;
        const orphans = rows.filter((row) => row.partIndex >= partCount);
        if (orphans.length === 0) continue;

        // Ascending, as the earlier per-message `SELECT DISTINCT tag_id` returned them.
        const queued = [
            ...new Set(rows.map((row) => row.tagNumber).filter((tag) => queuedTags.drop.has(tag))),
        ].sort((a, b) => a - b);
        // Every fragment already queued for removal means the merged text is
        // exactly what the user asked to drop; anything less would widen it.
        if (queued.length > 0 && queued.length < rows.length) {
            for (const tagNumber of queued) {
                discardDrop.run(sessionId, tagNumber);
                result.discardedDropTagNumbers.push(tagNumber);
            }
        }

        let survivor = rows.find((row) => row.partIndex < partCount) ?? null;
        if (survivor === null) {
            // Nothing was tagged at a surviving index, so the lowest orphan keeps
            // its tag number and moves down onto the part that remains.
            const lowest = orphans[0];
            if (!lowest) continue;
            rekey.run(`${messageId}:p0`, sessionId, lowest.tagNumber);
            result.rekeyedTagNumbers.push(lowest.tagNumber);
            survivor = { ...lowest, messageId: `${messageId}:p0`, partIndex: 0 };
        }
        for (const orphan of orphans) {
            if (orphan.tagNumber === survivor.tagNumber) continue;
            foldDuplicateIntoSurvivor(
                db,
                sessionId,
                survivor,
                orphan,
                queuedTags.any.has(orphan.tagNumber),
                false,
            );
            result.foldedTagNumbers.push(orphan.tagNumber);
        }
    }
    result.discardedDropTagNumbers.sort((a, b) => a - b);
    result.foldedTagNumbers.sort((a, b) => a - b);
    return result;
}

export function hasPiFallbackToolOwnerTags(db: Database, sessionId: string): boolean {
    const row = db
        .prepare(
            `SELECT 1
             FROM tags
             WHERE session_id = ?
               AND type = 'tool'
               AND tool_owner_message_id LIKE 'pi-msg-%'
             LIMIT 1`,
        )
        .get(sessionId);
    // `.get()` returns NULL for a no-row result (empirically true under bun:sqlite;
    // node:sqlite likewise never returns the JS `undefined` sentinel) — so
    // `row !== undefined` is TRUE for an EMPTY result, which would defeat this cheap
    // pre-gate and run the per-pass tool-owner branch-walk for EVERY session. Use
    // `!= null` to treat both null and undefined as "no row".
    return row != null;
}

export function findPiFallbackToolOwnerTags(
    db: Database,
    sessionId: string,
): PiFallbackToolOwnerTag[] {
    return db
        .prepare(
            `SELECT tag_number AS tagNumber,
                    message_id AS callId,
                    tool_owner_message_id AS toolOwnerMessageId,
                    status
             FROM json_each(?) prefix CROSS JOIN tags
             WHERE session_id = ?
               AND tags.type = 'tool'
                AND tool_owner_message_id >= prefix.value
                AND tool_owner_message_id < substr(prefix.value, 1, 6) || '.'
                AND tool_owner_message_id LIKE 'pi-msg-%'
             ORDER BY tag_number ASC`,
        )
        .all(PI_FALLBACK_PREFIXES_JSON, sessionId)
        .filter(isPiFallbackToolOwnerTag);
}

export class PiTagIdentityConflictError extends Error {
    readonly code = "PI_TAG_IDENTITY_CONFLICT";
    constructor(detail: string, kind: "tool" | "message" = "tool") {
        super(
            `Magic Context ${kind}-tag identity conflict: ${detail}. This turn was refused without sending raw history; resending alone will not repair it`,
        );
        this.name = "PiTagIdentityConflictError";
    }
}

/** Message and tool tags keep the number proven by returned bytes or a sole served receipt, not allocation order. */
function selectPiTagSurvivor<T extends { tagNumber: number; status: string }>(
    rows: readonly T[],
    servedTagNumbers: ReadonlySet<number>,
    cachedSurvivor: number | undefined,
    kind: "tool" | "message",
    rebuildingSurvivor?: number,
): T {
    const served = rows.filter((row) => servedTagNumbers.has(row.tagNumber));
    const cached =
        cachedSurvivor === undefined
            ? undefined
            : rows.find((row) => row.tagNumber === cachedSurvivor);
    const rebuilding = rows.find((row) => row.tagNumber === rebuildingSurvivor);
    if (
        (cachedSurvivor !== undefined && !cached) ||
        (served.length !== 1 && !cached && !rebuilding)
    ) {
        throw new PiTagIdentityConflictError(
            served.length > 1
                ? `Conflicting served Pi ${kind} tag numbers; no byte-safe cached survivor is proven`
                : `duplicate ${kind} tag identities have no proven served-byte survivor`,
            kind,
        );
    }
    const kept = cached ?? rebuilding ?? served[0];
    if (!kept) throw new PiTagIdentityConflictError("no served survivor is proven", kind);
    return kept;
}

function foldPiIdentityDuplicate(
    db: Database,
    sessionId: string,
    kept: PiFallbackFoldTagRow,
    duplicate: PiFallbackFoldTagRow,
): void {
    const owesDrop = kept.status !== "dropped" && duplicate.status === "dropped";
    // Keep the status already shown for this number. A dropped duplicate's
    // removal must not turn the active result into a dropped placeholder now;
    // queue that drop for a later pass permitted to edit managed history.
    foldDuplicateIntoSurvivor(db, sessionId, kept, duplicate, true, false);
    if (owesDrop) queuePendingOp(db, sessionId, kept.tagNumber, "drop");
}

export function getPiMessageTagCandidates(db: Database, sessionId: string, messageId: string) {
    return getPiFallbackMessageFoldTagRowsByMessageId(db, sessionId, messageId);
}

export function findPiTagIdentityConflict(error: unknown): PiTagIdentityConflictError | undefined {
    const seen = new Set<unknown>();
    while (error instanceof Error && !seen.has(error)) {
        if (error instanceof PiTagIdentityConflictError) return error;
        seen.add(error);
        error = error.cause;
    }
}

export function adoptPiFallbackToolOwnerTag(
    db: Database,
    sessionId: string,
    tagNumber: number,
    callId: string,
    oldOwnerMessageId: string,
    newOwnerMessageId: string,
    servedTagNumbers: ReadonlySet<number> = new Set(),
    cachedSurvivor?: number,
    rebuildingSurvivor?: number,
): PiFallbackTagAdoptionResult {
    const survivor = getPiFallbackFoldTagRowByNumber(db, sessionId, tagNumber);
    if (
        survivor === null ||
        survivor.type !== "tool" ||
        survivor.messageId !== callId ||
        survivor.toolOwnerMessageId !== oldOwnerMessageId
    ) {
        return { action: "skipped" };
    }

    const existing = getPiFallbackToolFoldTagRowByOwner(db, sessionId, callId, newOwnerMessageId);
    if (existing === null) {
        const result = db
            .prepare(
                `UPDATE tags
                 SET tool_owner_message_id = ?
                 WHERE session_id = ?
                   AND tag_number = ?
                   AND type = 'tool'
                   AND message_id = ?
                   AND tool_owner_message_id = ?`,
            )
            .run(newOwnerMessageId, sessionId, tagNumber, callId, oldOwnerMessageId);
        // Trigger writes can inflate changes, but zero still means this guard matched no row.
        return (result.changes ?? 0) > 0 ? { action: "rekeyed", tagNumber } : { action: "skipped" };
    }

    if (existing.tagNumber === tagNumber) {
        return { action: "skipped" };
    }

    const kept = selectPiTagSurvivor(
        [survivor, existing],
        servedTagNumbers,
        cachedSurvivor,
        "tool",
        rebuildingSurvivor,
    );
    if (kept.tagNumber === survivor.tagNumber) {
        foldPiIdentityDuplicate(db, sessionId, survivor, existing);
        db.prepare(
            "UPDATE tags SET tool_owner_message_id = ? WHERE session_id = ? AND tag_number = ?",
        ).run(newOwnerMessageId, sessionId, tagNumber);
        return { action: "folded", tagNumber, deletedTagNumbers: [existing.tagNumber] };
    }
    // The existing real-owner row's number was proved by returned bytes or the
    // served-number ledger, so it survives even if the fallback was allocated first.
    foldPiIdentityDuplicate(db, sessionId, existing, survivor);
    return {
        action: "folded",
        tagNumber: existing.tagNumber,
        deletedTagNumbers: [tagNumber],
    };
}

export function adoptPiFallbackMessageTag(
    db: Database,
    sessionId: string,
    tagNumber: number,
    oldFallbackMessageId: string,
    newRealMessageId: string,
    servedTagNumbers: ReadonlySet<number> = new Set(),
    cachedSurvivor?: number,
    rebuildingSurvivor?: number,
): PiFallbackTagAdoptionResult {
    if (oldFallbackMessageId.startsWith(WHITESPACE_ASSISTANT_INERT_MESSAGE_PREFIX)) {
        return { action: "skipped" };
    }
    const survivor = getPiFallbackFoldTagRowByNumber(db, sessionId, tagNumber);
    if (
        survivor === null ||
        survivor.type !== "message" ||
        survivor.messageId !== oldFallbackMessageId
    ) {
        return { action: "skipped" };
    }

    const duplicates = getPiFallbackMessageFoldTagRowsByMessageId(
        db,
        sessionId,
        newRealMessageId,
    ).filter((row) => row.tagNumber !== tagNumber);
    if (duplicates.length === 0) {
        const result = db
            .prepare(
                `UPDATE tags
                 SET message_id = ?
                 WHERE session_id = ?
                   AND tag_number = ?
                   AND type = 'message'
                   AND message_id = ?`,
            )
            .run(newRealMessageId, sessionId, tagNumber, oldFallbackMessageId);
        // Trigger writes can inflate changes, but zero still means this guard matched no row.
        return (result.changes ?? 0) > 0 ? { action: "rekeyed", tagNumber } : { action: "skipped" };
    }

    // An allocated row may never have reached Pi. A real entry-id key alone
    // cannot authorize choosing its number when returned-byte evidence is absent.
    const realSurvivor = selectPiTagSurvivor(
        [survivor, ...duplicates],
        servedTagNumbers,
        cachedSurvivor,
        "message",
        rebuildingSurvivor,
    );
    const deletedTagNumbers: number[] = [];
    for (const duplicate of [survivor, ...duplicates]) {
        if (duplicate.tagNumber === realSurvivor.tagNumber) continue;
        foldPiIdentityDuplicate(db, sessionId, realSurvivor, duplicate);
        deletedTagNumbers.push(duplicate.tagNumber);
    }
    if (realSurvivor.tagNumber === tagNumber) {
        db.prepare("UPDATE tags SET message_id = ? WHERE session_id = ? AND tag_number = ?").run(
            newRealMessageId,
            sessionId,
            tagNumber,
        );
    }
    return {
        action: "folded",
        tagNumber: realSurvivor.tagNumber,
        deletedTagNumbers,
    };
}

export const TRIM_SOURCE_CANDIDATES_SQL = `WITH ids AS MATERIALIZED (
    SELECT value AS source_id, ? AS session_id FROM json_each(?)
)
SELECT t.id, t.tag_number, t.message_id, t.tool_owner_message_id
FROM ids CROSS JOIN tags t INDEXED BY idx_tags_session_message_nocase
WHERE t.session_id = ids.session_id AND t.message_id = ids.source_id COLLATE NOCASE
    AND t.status IN ('active', 'dropped')
UNION
SELECT t.id, t.tag_number, t.message_id, t.tool_owner_message_id
FROM ids CROSS JOIN tags t INDEXED BY idx_tags_session_tool_owner
WHERE t.session_id = ids.session_id AND t.tool_owner_message_id = ids.source_id
    AND t.status IN ('active', 'dropped')
UNION
SELECT t.id, t.tag_number, t.message_id, t.tool_owner_message_id
FROM ids CROSS JOIN tags t INDEXED BY idx_tags_session_message_nocase
WHERE t.session_id = ids.session_id
    AND t.message_id >= (ids.source_id || ':p') COLLATE NOCASE
    AND t.message_id < (ids.source_id || ':q') COLLATE NOCASE
    AND t.status IN ('active', 'dropped')
UNION
SELECT t.id, t.tag_number, t.message_id, t.tool_owner_message_id
FROM ids CROSS JOIN tags t INDEXED BY idx_tags_session_message_nocase
WHERE t.session_id = ids.session_id
    AND t.message_id >= (ids.source_id || ':file') COLLATE NOCASE
    AND t.message_id < (ids.source_id || ':filf') COLLATE NOCASE
    AND t.status IN ('active', 'dropped')
ORDER BY tag_number`;

/**
 * Retire tags minted from rows removed by an in-memory compartment trim. The
 * rows never reach the served tail, so leaving them active would leak into
 * reclaim hints and hygiene accounting. Repeated calls are idempotent.
 */
export function markTagsCompactedByMessageIds(
    db: Database,
    sessionId: string,
    messageIds: Iterable<string>,
    eligibleTagNumbers?: ReadonlySet<number>,
): number {
    const ids = new Set(messageIds);
    if (ids.size === 0 || eligibleTagNumbers?.size === 0) return 0;

    // SQLite's default LIKE folds ASCII only, whereas String.toLowerCase also
    // folds Unicode. Wildcards in the source id were escaped by the old query.
    const asciiLower = (value: string) => value.replace(/[A-Z]/g, (char) => char.toLowerCase());
    const foldedIds = new Set(Array.from(ids, asciiLower));
    const nulPrefixes = new Set(
        Array.from(ids)
            .filter((id) => id.includes("\0"))
            .map((id) => asciiLower(id.split("\0")[0])),
    );
    const matches = (messageId: string | null, owner: string | null): boolean => {
        if (messageId !== null && ids.has(messageId)) return true;
        if (owner !== null && ids.has(owner)) return true;
        if (messageId === null) return false;
        // LIKE treats NUL as the end of both pattern and value; exact equality
        // above does not. Keep that behavior even for malformed source ids.
        const nul = messageId.indexOf("\0");
        const value = nul < 0 ? messageId : messageId.slice(0, nul);
        if (nulPrefixes.size > 0 && nulPrefixes.has(asciiLower(value))) return true;
        // Check EVERY delimiter: ids themselves may contain :p or :file. Do not
        // restrict :p% to numeric parts, or include Pi's :mc-text-v1: identity.
        for (let colon = value.indexOf(":"); colon >= 0; colon = value.indexOf(":", colon + 1)) {
            const suffix = value[colon + 1];
            if (
                (suffix === "p" ||
                    suffix === "P" ||
                    asciiLower(value.slice(colon + 1, colon + 5)) === "file") &&
                foldedIds.has(asciiLower(value.slice(0, colon)))
            )
                return true;
        }
        return false;
    };

    // Discover candidates outside the writer transaction; updates below recheck
    // identity and status by primary key after acquiring the writer lock.
    const params = [
        JSON.stringify(Array.from(ids)),
        sessionId,
        ...(eligibleTagNumbers ? [JSON.stringify([...eligibleTagNumbers])] : []),
        Array.from(ids).some((id) => id.includes(":")) ? 1 : 0,
        nulPrefixes.size > 0 ? 1 : 0,
    ];
    // Each ordinary source ID drives equality and NOCASE prefix-range seeks.
    // NOCASE preserves LIKE's ASCII folding without lower() on every stored row.
    // NUL patterns retain the general matcher because LIKE truncates the pattern
    // before its suffix; protected retirement already has bounded tag-number keys.
    const indexedSources = eligibleTagNumbers === undefined && nulPrefixes.size === 0;
    const rows = db
        .prepare(
            indexedSources
                ? TRIM_SOURCE_CANDIDATES_SQL
                : `WITH ids AS MATERIALIZED (
            SELECT value AS source_id, lower(value) AS folded_id FROM json_each(?)
        )
        SELECT id, tag_number, message_id, tool_owner_message_id FROM tags INDEXED BY ${tagOrderConstraintIndex(db)}
        WHERE session_id = ? ${eligibleTagNumbers ? "AND tag_number IN (SELECT value FROM json_each(?))" : ""}
        AND status IN ('active', 'dropped') AND (
            message_id IN (SELECT source_id FROM ids)
            OR tool_owner_message_id IN (SELECT source_id FROM ids)
            OR (instr(lower(message_id), ':p') > 0 AND
                lower(substr(message_id, 1, instr(lower(message_id), ':p') - 1)) IN (SELECT folded_id FROM ids))
            OR (instr(lower(message_id), ':file') > 0 AND
                lower(substr(message_id, 1, instr(lower(message_id), ':file') - 1)) IN (SELECT folded_id FROM ids))
            OR (? AND instr(message_id, ':') > 0)
            OR ?
        )`,
        )
        .all(...(indexedSources ? [sessionId, params[0]] : params)) as {
        id: number;
        tag_number: number;
        message_id: string | null;
        tool_owner_message_id: string | null;
    }[];
    const candidates = rows.filter(
        (row) =>
            (eligibleTagNumbers === undefined || eligibleTagNumbers.has(row.tag_number)) &&
            matches(row.message_id, row.tool_owner_message_id),
    );
    if (candidates.length === 0) return 0;

    // Recheck identity as well as status: another process can retarget or retire
    // a tag between the read and a batch. RETURNING excludes trigger writes.
    const update = db.prepare(
        `UPDATE tags SET status = 'compacted'
         WHERE id = ? AND session_id = ?
            AND status IN ('active', 'dropped')
            AND message_id IS ? AND tool_owner_message_id IS ?
          RETURNING tag_number`,
    );
    let cursor = 0;
    let changed = 0;
    const batch = db.transaction(() => {
        const start = performance.now();
        let processed = 0;
        do {
            const row = candidates[cursor++];
            const retired = update.get(
                row.id,
                sessionId,
                row.message_id,
                row.tool_owner_message_id,
            ) as { tag_number: number } | null;
            if (retired) {
                // Retiring this source removes it from the request, so delete its queued
                // operation in the same transaction instead of waiting for another drain.
                removePendingOp(db, sessionId, retired.tag_number);
                changed++;
            }
            processed++;
        } while (cursor < candidates.length && processed < 128 && performance.now() - start < 8);
    });
    // A failed later batch leaves only valid compacted rows. Retrying is safe,
    // and never redoes the rows already committed by an earlier batch.
    while (cursor < candidates.length) batch.immediate();
    return changed;
}

/**
 * Delete every tag whose source content lives on `messageId`. This is
 * the `message.removed` event handler's primary cleanup path.
 *
 * What gets deleted:
 *   - Message tags: `messageId == <removed-msg-id>` (text parts).
 *   - File tags: `messageId LIKE <removed-msg-id>:p%` /
 *     `<removed-msg-id>:file%`.
 *   - Content-derived text tags (Pi): `<removed-msg-id>:mc-text-v1:%`.
 *   - Tool tags owned by the removed message:
 *     `tool_owner_message_id == <removed-msg-id>` (v3.3.1 Layer C).
 *
 * Pre-v10 semantics: tool tags used `messageId = callId`, so a removed
 * assistant message would not match any tool tag's `messageId` field
 * (the message id was never written there for tool tags). The fix:
 * include tool tags by composite-owner identity so an assistant
 * message removal correctly cascades to the tool tags it hosted.
 *
 * Returns the tag numbers that were deleted (used by the event handler
 * to re-anchor reasoning watermarks and audit logs).
 */
export function deleteTagsByMessageId(
    db: Database,
    sessionId: string,
    messageId: string,
): number[] {
    const deleteTransaction = db.transaction(() => {
        const escapedMessageId = escapeLikePattern(messageId);
        const textPartPattern = `${escapedMessageId}:p%`;
        const filePartPattern = `${escapedMessageId}:file%`;
        const contentDerivedTextPattern = `${escapedMessageId}${escapeLikePattern(TEXT_TAG_IDENTITY_MARKER)}%`;
        const messageScopedTags = getTagNumbersByMessageIdStatement(db)
            .all(sessionId, messageId, textPartPattern, filePartPattern, contentDerivedTextPattern)
            .filter(isTagNumberRow)
            .map((row) => row.tag_number);

        // Tool tags owned by the removed message — `tool_owner_message_id`
        // can match independent of `messageId` (which is the callId). Pull
        // these tag numbers BEFORE running the delete so the caller sees
        // the union.
        const ownerScopedTagNumbers = getOwnerScopedToolTagNumbers(db, sessionId, messageId);

        if (messageScopedTags.length === 0 && ownerScopedTagNumbers.length === 0) {
            return [];
        }

        if (messageScopedTags.length > 0) {
            getDeleteTagsByMessageIdStatement(db).run(
                sessionId,
                messageId,
                textPartPattern,
                filePartPattern,
                contentDerivedTextPattern,
            );
        }
        if (ownerScopedTagNumbers.length > 0) {
            deleteToolTagsByOwner(db, sessionId, messageId);
        }

        // De-duplicate — a tag could in theory match both predicates.
        const merged = new Set<number>([...messageScopedTags, ...ownerScopedTagNumbers]);
        return Array.from(merged).sort((a, b) => a - b);
    });
    return deleteTransaction.immediate();
}

const getOwnerScopedToolTagNumbersStatements = new WeakMap<Database, PreparedStatement>();
function getOwnerScopedToolTagNumbers(
    db: Database,
    sessionId: string,
    ownerMsgId: string,
): number[] {
    let stmt = getOwnerScopedToolTagNumbersStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT tag_number FROM tags WHERE session_id = ? AND type = 'tool' AND tool_owner_message_id = ? ORDER BY tag_number ASC",
        );
        getOwnerScopedToolTagNumbersStatements.set(db, stmt);
    }
    return stmt
        .all(sessionId, ownerMsgId)
        .filter(isTagNumberRow)
        .map((row) => row.tag_number);
}

export function getMaxTagNumberBySession(db: Database, sessionId: string): number {
    const row = getMaxTagNumberBySessionStatement(db).get(sessionId);
    return isMaxTagNumberRow(row) ? row.max_tag_number : 0;
}

/**
 * Look up the tag_number assigned to a specific (session_id, message_id).
 *
 * Used by the tagger's recovery path to bind an existing DB-assigned tag back
 * into the in-memory assignment map without bumping the counter past the DB's
 * actual max. Returns null when no tag exists for that message yet.
 */
export function getTagNumberByMessageId(
    db: Database,
    sessionId: string,
    messageId: string,
): number | null {
    const row = getTagNumberByMessageIdStatement(db).get(sessionId, messageId);
    return isTagNumberRow(row) ? row.tag_number : null;
}

/** Look up a live tag assignment without reviving a retired whitespace framing row. */
export function getAssignableTagNumberByMessageId(
    db: Database,
    sessionId: string,
    messageId: string,
): number | null {
    const row = getAssignableTagNumberByMessageIdStatement(db).get(sessionId, messageId);
    return isTagNumberRow(row) ? row.tag_number : null;
}

const getMinMessageTagNumberForRawIdStatements = new WeakMap<Database, PreparedStatement>();
interface MinTagNumberRow {
    m: number | null;
}
function isMinTagNumberRow(row: unknown): row is MinTagNumberRow {
    return row !== null && typeof row === "object" && "m" in row;
}
/**
 * Lowest `tag_number` among the message/file content-ids of a single raw
 * message id, used to derive the tagger load-scoping floor from the first
 * message(s) in the live wire.
 *
 * message/file tags key on the synthetic content-id `${rawId}:p${n}` /
 * `${rawId}:file${n}`. The half-open range `[rawId+':', rawId+';')` captures
 * exactly one rawId's content-ids: ':' (0x3A) is the field separator and ';'
 * (0x3B) is its immediate successor, so a different rawId (even a prefix like
 * `msg_abc` vs `msg_abcd`) diverges before the ':' and sorts outside the
 * range. This is a sargable index range scan on idx_tags_session_message_id
 * (no LIKE, no wildcard escaping). Tool tags are NOT matched (their message_id
 * is the callId, not `${rawId}:…`) — intentional: the floor bounds message/file
 * tags; tool straddle is handled separately.
 *
 * Returns null when the rawId has no message/file tag yet (untagged synthetic
 * leader) or, defensively, when the rawId itself contains ':' (which would
 * break the delimiter proof — never true for OpenCode `msg_*` ids).
 */
export function getMinMessageTagNumberForRawId(
    db: Database,
    sessionId: string,
    rawId: string,
): number | null {
    if (rawId.includes(":")) return null;
    let stmt = getMinMessageTagNumberForRawIdStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT MIN(tag_number) AS m FROM tags WHERE session_id = ? AND message_id >= ? AND message_id < ?",
        );
        getMinMessageTagNumberForRawIdStatements.set(db, stmt);
    }
    const row = stmt.get(sessionId, `${rawId}:`, `${rawId};`);
    return isMinTagNumberRow(row) && typeof row.m === "number" ? row.m : null;
}

// Floor derivation tunables. A LOWER floor only ever loads MORE tags (strictly
// safe — it can never exclude an in-wire tag); the margin absorbs a tagged
// leading compaction-summary, near-boundary tool straddles, and reordering at
// the wire head.
//   SCAN_HITS    — stop once this many leading messages RESOLVE to a real tag
//                  (we MIN across them to absorb head reordering).
//   MAX_PROBES   — hard cap on probes so a fully-ghost/tool-only head can't make
//                  us scan the whole wire; exhausting it → floor 0 (full scan).
//   SAFETY_MARGIN     — base margin subtracted from the resolved min.
//   PER_SKIP_MARGIN   — extra margin per LEADER SKIPPED before the first hit.
export const TAGGER_FLOOR_SCAN_MESSAGES = 8; // SCAN_HITS
export const TAGGER_FLOOR_MAX_PROBES = 64;
export const TAGGER_FLOOR_SAFETY_MARGIN = 256;
export const TAGGER_FLOOR_PER_SKIP_MARGIN = 64;

/**
 * Derive the tagger/scan load-scoping floor from the leading wire message ids:
 * roughly the minimum message/file tag number across the leading messages,
 * minus a safety margin (clamped to 0). Shared by the tagger's `initFromDb` and
 * the compartment trigger's tag scans so both scope to the same live-wire range.
 * Returns 0 when nothing resolves → callers fall back to the full-session scan.
 *
 * `getMinMessageTagNumberForRawId` matches ONLY a message's `:p`/`:file` tags,
 * never its tool tags (those key on the callId). So the wire head — which after
 * a compaction marker is frequently a run of tool-only assistant turns and/or
 * tagless ghost/synthetic leaders — returns all-NULL. The old code capped at the
 * first 8 ID-BEARING probes and took their MIN, so such a head exhausted the
 * budget on NULLs → Infinity → floor 0 → the full ~100k-tag scan we are trying
 * to avoid (the live ~66ms compartmentTrigger oscillation).
 *
 * Fix: keep probing PAST NULL leaders until SCAN_HITS messages resolve (bounded
 * by MAX_PROBES). A skipped tool-only leader's tool tags sit just BELOW the
 * first `:p` tag we land on, so we widen the margin by PER_SKIP_MARGIN for every
 * leader skipped before the first hit — the floor still only ever errs LOWER
 * (loads a few extra tags), never higher (never drops a live-wire tag).
 */
export function deriveTagLoadFloor(
    db: Database,
    sessionId: string,
    rawIds: Iterable<string | null | undefined>,
): number {
    let min = Number.POSITIVE_INFINITY;
    let probes = 0;
    let hits = 0;
    let skippedBeforeFirstHit = 0;
    for (const rawId of rawIds) {
        if (typeof rawId !== "string" || rawId.length === 0) continue;
        if (probes >= TAGGER_FLOOR_MAX_PROBES) break;
        probes++;
        const m = getMinMessageTagNumberForRawId(db, sessionId, rawId);
        if (m === null) {
            if (hits === 0) skippedBeforeFirstHit++;
            continue;
        }
        if (m < min) min = m;
        if (++hits >= TAGGER_FLOOR_SCAN_MESSAGES) break;
    }
    if (!Number.isFinite(min)) return 0;
    const margin =
        TAGGER_FLOOR_SAFETY_MARGIN + skippedBeforeFirstHit * TAGGER_FLOOR_PER_SKIP_MARGIN;
    return Math.max(0, min - margin);
}

// Single source-of-truth column list for SELECTs that produce TagEntry.
// Centralizing this avoids subtle drift when columns are added (e.g.
// migration v10's tool_owner_message_id) — every TagEntry-producing
// reader must include the new column or downstream callers will see
// undefined where they expect a typed field.
export const TAG_SELECT_COLUMNS =
    "id, message_id, type, status, drop_mode, tool_name, input_byte_size, byte_size, reasoning_byte_size, session_id, tag_number, caveman_depth, tool_owner_message_id, token_count";

export function getTagsBySession(db: Database, sessionId: string): TagEntry[] {
    const rows = db
        .prepare(
            `SELECT ${TAG_SELECT_COLUMNS} FROM tags WHERE session_id = ? ORDER BY tag_number ASC, id ASC`,
        )
        .all(sessionId)
        .filter(isTagRow);

    return rows.map(toTagEntry);
}

// ─── Targeted helpers for the hot transform path ──────────────────────────
//
// `getTagsBySession` loads every tag for a session (often 10k–50k rows on
// long-lived sessions) on every transform pass. Most consumers only need a
// small slice — the active tags, or the rows whose tag_number is in the
// current `targets` map, or just the watermark of dropped tag_numbers.
//
// These helpers replace the single full-table load with three targeted
// queries that, combined with the partial indexes added in migration v8
// (`idx_tags_active_session_tag_number` WHERE status='active' and
// `idx_tags_dropped_session_tag_number` WHERE status='dropped'), produce
// index-only scans over the small slice each call site actually cares
// about. Benchmarked at ~110× speedup on a 49k-tag session (67ms → 0.6ms).
//
// We do NOT remove `getTagsBySession`. It remains the right call for the
// few non-hot-path consumers (compartment-trigger, ctx-reduce tool, etc.)
// where the full list is genuinely needed. Hot-path consumers (transform,
// apply-operations, heuristic-cleanup, nudger) should switch to these.

const getActiveTagsBySessionStatements = new WeakMap<Database, PreparedStatement>();
const getNullOwnerToolTagsBySessionStatements = new WeakMap<Database, PreparedStatement>();
const getDroppedTagsBySessionStatements = new WeakMap<Database, PreparedStatement>();
const getMaxDroppedTagNumberStatements = new WeakMap<Database, PreparedStatement>();

function getActiveTagsBySessionStatement(db: Database): PreparedStatement {
    let stmt = getActiveTagsBySessionStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT ${TAG_SELECT_COLUMNS} FROM tags WHERE session_id = ? AND status = 'active' ORDER BY tag_number ASC, id ASC`,
        );
        getActiveTagsBySessionStatements.set(db, stmt);
    }
    return stmt;
}

function getDroppedTagsBySessionStatement(db: Database): PreparedStatement {
    let stmt = getDroppedTagsBySessionStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT ${TAG_SELECT_COLUMNS} FROM tags WHERE session_id = ? AND status = 'dropped' ORDER BY tag_number ASC, id ASC`,
        );
        getDroppedTagsBySessionStatements.set(db, stmt);
    }
    return stmt;
}

function getMaxDroppedTagNumberStatement(db: Database): PreparedStatement {
    let stmt = getMaxDroppedTagNumberStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT COALESCE(MAX(tag_number), 0) AS max_tag_number FROM tags WHERE session_id = ? AND status = 'dropped'",
        );
        getMaxDroppedTagNumberStatements.set(db, stmt);
    }
    return stmt;
}

/**
 * Return only the tags whose status is 'active' for this session.
 *
 * Backed by the partial index `idx_tags_active_session_tag_number` so the
 * scan touches only active rows instead of every tag in the session.
 *
 * Use this in: heuristic cleanup, nudger, caveman replay scope, anywhere
 * that filters `tags.filter(t => t.status === "active")` on the result of
 * `getTagsBySession`.
 *
 * The returned shape matches `TagEntry` exactly so callers can swap with
 * no behavior change beyond seeing fewer (active-only) rows.
 */
export function getActiveTagsBySession(db: Database, sessionId: string): TagEntry[] {
    const rows = getActiveTagsBySessionStatement(db).all(sessionId).filter(isTagRow);
    return rows.map(toTagEntry);
}

/**
 * Attribution rows for final rendered-tail accounting. Active, non-protected
 * rows identify reclaimable token mass (U). Legacy tool rows with no owner are
 * included regardless of status so duplicate call IDs remain visible and the
 * orphan resolver can reject ambiguous matches.
 */
export function getTailHygieneTags(db: Database, sessionId: string): TagEntry[] {
    const active = getActiveTagsBySession(db, sessionId);
    let orphanStatement = getNullOwnerToolTagsBySessionStatements.get(db);
    if (!orphanStatement) {
        orphanStatement = db.prepare(
            `SELECT ${TAG_SELECT_COLUMNS} FROM tags
             WHERE session_id = ? AND type = 'tool' AND tool_owner_message_id IS NULL
             ORDER BY tag_number ASC, id ASC`,
        );
        getNullOwnerToolTagsBySessionStatements.set(db, orphanStatement);
    }
    const seen = new Set(active.map((tag) => `${tag.tagNumber}\0${tag.messageId}\0${tag.type}`));
    for (const row of orphanStatement.all(sessionId).filter(isTagRow)) {
        const orphan = toTagEntry(row);
        const key = `${orphan.tagNumber}\0${orphan.messageId}\0${orphan.type}`;
        if (!seen.has(key)) active.push(orphan);
    }
    return active;
}

/**
 * Return only dropped tags for a session. The partial dropped-tag index avoids
 * loading active and compacted history when a force seed only needs drop state.
 */
export function getDroppedTagsBySession(
    db: Database,
    sessionId: string,
    scope?: { ownerIds: readonly string[]; messageAddresses: readonly string[] },
): TagEntry[] {
    // Query owner and message addresses separately so their indexes bound both
    // scans to the visible tail. Unary + keeps the status filter but prevents
    // choosing the session-wide dropped-tag index for these scoped lookups.
    const rows = (
        scope
            ? db
                  .prepare(`SELECT ${TAG_SELECT_COLUMNS} FROM tags INDEXED BY idx_tags_pi_fallback_tool_owner
        WHERE session_id = ? AND type = 'tool' AND +status = 'dropped'
          AND tool_owner_message_id IN (SELECT value FROM json_each(?))
        UNION ALL
        SELECT ${TAG_SELECT_COLUMNS} FROM tags INDEXED BY idx_tags_session_message_id
        WHERE session_id = ? AND type != 'tool' AND +status = 'dropped'
          AND message_id IN (SELECT value FROM json_each(?))
        ORDER BY tag_number ASC, id ASC`)
                  .all(
                      sessionId,
                      JSON.stringify(scope.ownerIds),
                      sessionId,
                      JSON.stringify(scope.messageAddresses),
                  )
            : getDroppedTagsBySessionStatement(db).all(sessionId)
    ).filter(isTagRow);
    return rows.map(toTagEntry);
}

/**
 * Return the tags whose tag_number is in `tagNumbers` for this session.
 *
 * Used by `applyFlushedStatuses` (and similar replay loops) to fetch the
 * subset of tags that match the current pass's visible target set rather
 * than scanning every tag in the session.
 *
 * The IN-list is built dynamically because SQLite caches prepared
 * statements per query string, but we still get prepared-statement reuse
 * for any given list size that happens twice in a row (which is the
 * common case during long sessions).
 *
 * Returns an empty array when `tagNumbers` is empty (avoids generating
 * `IN ()` which is an SQL syntax error).
 */
export function getTagsForPendingOperations(
    db: Database,
    sessionId: string,
    pendingTagNumbers: readonly number[],
    protectedCount: number,
    recentToolWindow: number,
): TagEntry[] {
    const byNumber = new Map<number, TagEntry>();
    for (const tag of getTagsByNumbers(db, sessionId, pendingTagNumbers)) {
        byNumber.set(tag.tagNumber, tag);
    }
    const addRows = (sql: string, limit: number): void => {
        if (limit <= 0) return;
        const rows = db.prepare(sql).all(sessionId, limit).filter(isTagRow);
        for (const row of rows) {
            const tag = toTagEntry(row);
            byNumber.set(tag.tagNumber, tag);
        }
    };
    addRows(
        `SELECT ${TAG_SELECT_COLUMNS} FROM tags
         WHERE session_id = ? AND status = 'active'
         ORDER BY tag_number DESC, id DESC LIMIT ?`,
        protectedCount,
    );
    addRows(
        `SELECT ${TAG_SELECT_COLUMNS} FROM tags
         WHERE session_id = ? AND type = 'tool'
         ORDER BY tag_number DESC, id DESC LIMIT ?`,
        recentToolWindow,
    );
    return [...byNumber.values()].sort((left, right) => left.tagNumber - right.tagNumber);
}

export function getTagsByNumbers(
    db: Database,
    sessionId: string,
    tagNumbers: readonly number[],
): TagEntry[] {
    if (tagNumbers.length === 0) return [];

    // SQLite parameter limit is 999 by default; chunk just in case very
    // large target sets ever appear (the common case is ~500-1000).
    if (tagNumbers.length > 900) {
        const all: TagEntry[] = [];
        for (let i = 0; i < tagNumbers.length; i += 900) {
            all.push(...getTagsByNumbers(db, sessionId, tagNumbers.slice(i, i + 900)));
        }
        return all;
    }

    const placeholders = tagNumbers.map(() => "?").join(",");
    const rows = db
        .prepare(
            `SELECT ${TAG_SELECT_COLUMNS} FROM tags WHERE session_id = ? AND tag_number IN (${placeholders}) ORDER BY tag_number ASC, id ASC`,
        )
        .all(sessionId, ...tagNumbers)
        .filter(isTagRow);

    return rows.map(toTagEntry);
}

const newestToolTagNumberStatements = new WeakMap<Database, PreparedStatement>();

/**
 * Tag numbers of the session's newest `limit` tool tags, any status, newest
 * first. Equals filtering a full `getTagsBySession` load to tool tags and
 * keeping the highest numbers: the row checks mirror `isTagRow`, so a malformed
 * row is skipped here exactly as that load skips it. The walk runs backwards on
 * the UNIQUE(session_id, tag_number) index and stops after `limit` rows.
 */
export function getNewestToolTagNumbers(db: Database, sessionId: string, limit: number): number[] {
    if (limit <= 0) return [];
    let statement = newestToolTagNumberStatements.get(db);
    if (!statement) {
        // A type-first index makes SQLite sort every historical tool row before
        // LIMIT. Disqualify that predicate from index selection so the ordered
        // (session_id, tag_number) walk can stop as soon as the window is full.
        statement = db.prepare(
            `SELECT tag_number FROM tags
              WHERE session_id = ? AND +type = 'tool'
                AND typeof(message_id) = 'text'
                AND typeof(status) = 'text'
                AND typeof(byte_size) IN ('integer', 'real')
                AND typeof(tag_number) IN ('integer', 'real')
              ORDER BY tag_number DESC
              LIMIT ?`,
        );
        newestToolTagNumberStatements.set(db, statement);
    }
    return (statement.all(sessionId, limit) as Array<{ tag_number: number }>).map(
        (row) => row.tag_number,
    );
}

const droppedNumberStatements = new WeakMap<Database, PreparedStatement>();

/** Return only dropped tags whose numbers are visible replay targets. */
export function getDroppedTagsByNumbers(
    db: Database,
    sessionId: string,
    tagNumbers: readonly number[],
): TagEntry[] {
    if (tagNumbers.length === 0) return [];

    if (tagNumbers.length > 900) {
        const all: TagEntry[] = [];
        for (let i = 0; i < tagNumbers.length; i += 900) {
            all.push(...getDroppedTagsByNumbers(db, sessionId, tagNumbers.slice(i, i + 900)));
        }
        return all;
    }

    let statement = droppedNumberStatements.get(db);
    if (!statement) {
        statement = db.prepare(
            `SELECT ${TAG_SELECT_COLUMNS} FROM tags WHERE session_id = ? AND status = 'dropped' AND tag_number IN (SELECT value FROM json_each(?)) ORDER BY tag_number ASC, id ASC`,
        );
        droppedNumberStatements.set(db, statement);
    }
    const rows = statement.all(sessionId, JSON.stringify(tagNumbers)).filter(isTagRow);

    return rows.map(toTagEntry);
}

/**
 * Return the maximum tag_number among tags whose status is 'dropped' for
 * this session, or 0 if no dropped tags exist.
 *
 * Replaces the full-array iteration `for (tag of tags) if (dropped &&
 * tag_number > max) max = tag_number` with a single SQL aggregate.
 * Backed by the partial index `idx_tags_dropped_session_tag_number` so
 * SQLite resolves the MAX with a backward index seek (O(log N)).
 */
export function getMaxDroppedTagNumber(db: Database, sessionId: string): number {
    const row = getMaxDroppedTagNumberStatement(db).get(sessionId);
    return isMaxTagNumberRow(row) ? row.max_tag_number : 0;
}

const tagByIdStatements = new WeakMap<Database, PreparedStatement>();

export function getTagById(db: Database, sessionId: string, tagId: number): TagEntry | null {
    let statement = tagByIdStatements.get(db);
    if (!statement) {
        statement = db.prepare(
            `SELECT ${TAG_SELECT_COLUMNS} FROM tags WHERE session_id = ? AND tag_number = ?`,
        );
        tagByIdStatements.set(db, statement);
    }
    const result = statement.get(sessionId, tagId);

    if (!isTagRow(result)) {
        return null;
    }

    return toTagEntry(result);
}

export function getTopNBySize(db: Database, sessionId: string, n: number): TagEntry[] {
    if (n <= 0) {
        return [];
    }

    const rows = db
        .prepare(
            `SELECT ${TAG_SELECT_COLUMNS} FROM tags WHERE session_id = ? AND status = 'active' ORDER BY byte_size DESC, tag_number ASC LIMIT ?`,
        )
        .all(sessionId, n)
        .filter(isTagRow);

    return rows.map(toTagEntry);
}

// ─── Tool-owner composite identity helpers (migration v10) ──────────────────
//
// Pre-v10 tool tags were keyed by (session_id, callID); collisions on
// OpenCode's per-turn callID counter could replay drop status onto fresh
// content. Post-v10 the persistent identity is the triple
// (session_id, callID, tool_owner_message_id).
//
// These helpers form the DB-side surface the runtime tagger uses for the
// composite-key fast path, the lazy-adoption fallback, and the
// nearest-prior owner search for result-only windows.
//
// See plan v3.3.1 in `.alfonso/plans/tag-owner-fix-plan.md`.

const getToolTagNumberByOwnerStatements = new WeakMap<Database, PreparedStatement>();
const getNullOwnerToolTagStatements = new WeakMap<Database, PreparedStatement>();
const adoptNullOwnerToolTagStatements = new WeakMap<Database, PreparedStatement>();
const getToolOwnerByTagIdStatements = new WeakMap<Database, PreparedStatement>();
const deleteToolTagsByOwnerStatements = new WeakMap<Database, PreparedStatement>();

function getGetToolTagNumberByOwnerStatement(db: Database): PreparedStatement {
    let stmt = getToolTagNumberByOwnerStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT tag_number FROM tags
             WHERE session_id = ? AND message_id = ?
               AND type = 'tool' AND tool_owner_message_id = ?
             LIMIT 1`,
        );
        getToolTagNumberByOwnerStatements.set(db, stmt);
    }
    return stmt;
}

/**
 * Look up the tag_number for a specific composite tool identity.
 *
 * Returns null when no tag exists for `(sessionId, callId, ownerMsgId)`.
 * This is the fast path for the runtime tagger after a tagger restart
 * or cache eviction.
 */
export function getToolTagNumberByOwner(
    db: Database,
    sessionId: string,
    callId: string,
    ownerMsgId: string,
): number | null {
    const row = getGetToolTagNumberByOwnerStatement(db).get(sessionId, callId, ownerMsgId);
    return isTagNumberRow(row) ? row.tag_number : null;
}

interface NullOwnerToolTagRow {
    id: number;
    tag_number: number;
}

function isNullOwnerToolTagRow(row: unknown): row is NullOwnerToolTagRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return typeof r.id === "number" && typeof r.tag_number === "number";
}

function getGetNullOwnerToolTagStatement(db: Database): PreparedStatement {
    let stmt = getNullOwnerToolTagStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT id, tag_number FROM tags
             WHERE session_id = ? AND message_id = ?
               AND type = 'tool' AND tool_owner_message_id IS NULL
             ORDER BY tag_number ASC
             LIMIT 1`,
        );
        getNullOwnerToolTagStatements.set(db, stmt);
    }
    return stmt;
}

/**
 * Find a NULL-owner tool tag row for `(sessionId, callId)`.
 *
 * Used by the lazy-adoption fast path: when the runtime tagger sees a
 * tool with composite key `(ownerMsgId, callId)` that has no
 * corresponding row in `assignments`, but the underlying callId already
 * exists in DB with NULL owner (legacy pre-v10 row), we want to adopt
 * the orphan rather than allocate a fresh tag. This preserves
 * cache-stable tag numbers across the v9 → v10 upgrade.
 *
 * Returns the lowest-numbered NULL-owner row deterministically. The
 * caller is expected to follow up with `adoptNullOwnerToolTag` to
 * atomically claim ownership; if that returns false, another writer
 * adopted first and the caller must re-check the composite-key fast
 * path or allocate a fresh tag.
 */
export function getNullOwnerToolTag(
    db: Database,
    sessionId: string,
    callId: string,
): { id: number; tagNumber: number } | null {
    const row = getGetNullOwnerToolTagStatement(db).get(sessionId, callId);
    if (!isNullOwnerToolTagRow(row)) return null;
    return { id: row.id, tagNumber: row.tag_number };
}

function getAdoptNullOwnerToolTagStatement(db: Database): PreparedStatement {
    let stmt = adoptNullOwnerToolTagStatements.get(db);
    if (!stmt) {
        // NULL-guarded UPDATE: matches zero rows if another writer
        // (backfill or a concurrent runtime adoption) already populated
        // owner.
        stmt = db.prepare(
            `UPDATE tags
             SET tool_owner_message_id = ?
             WHERE id = ? AND tool_owner_message_id IS NULL`,
        );
        adoptNullOwnerToolTagStatements.set(db, stmt);
    }
    return stmt;
}

function getToolOwnerByTagIdStatement(db: Database): PreparedStatement {
    let stmt = getToolOwnerByTagIdStatements.get(db);
    if (!stmt) {
        stmt = db.prepare("SELECT tool_owner_message_id FROM tags WHERE id = ?");
        getToolOwnerByTagIdStatements.set(db, stmt);
    }
    return stmt;
}

/**
 * Atomically adopt a NULL-owner tool tag row by setting
 * `tool_owner_message_id = ownerMsgId`. Returns true if exactly one
 * row was updated (we won the race), false if zero (someone else
 * adopted between our SELECT and UPDATE).
 *
 * The NULL guard makes this concurrent-safe with both the backfill
 * pass and concurrent runtime adoptions in other plugin processes. The
 * transaction verifies the owner value directly because trigger writes make
 * the statement's numeric change count unsuitable as a claim result.
 */
export function adoptNullOwnerToolTag(db: Database, rowId: number, ownerMsgId: string): boolean {
    return db
        .transaction(() => {
            const before = getToolOwnerByTagIdStatement(db).get(rowId) as
                | { tool_owner_message_id: string | null }
                | undefined;
            if (!before || before.tool_owner_message_id !== null) return false;

            getAdoptNullOwnerToolTagStatement(db).run(ownerMsgId, rowId);
            const after = getToolOwnerByTagIdStatement(db).get(rowId) as
                | { tool_owner_message_id: string | null }
                | undefined;
            return after?.tool_owner_message_id === ownerMsgId;
        })
        .immediate();
}

/**
 * Returns the candidate tool-tag owner ids for `(sessionId, callId)` —
 * every tag with a non-NULL owner. Used by the result-only-window
 * fallback in `tag-messages.ts`: the caller resolves wall-clock times
 * for every candidate against the OpenCode DB (via
 * `getMessageTimesFromOpenCodeDb`) and picks the most recent one whose
 * `time_created` precedes the current result message.
 *
 * The picking logic lives in the caller because resolving message times
 * requires the OpenCode read-only DB handle, which lives in the hooks
 * tree. Keeping that import one-way (hooks → features) avoids what
 * would otherwise be a cycle through the storage barrel.
 *
 * Returns an empty array when no candidates exist; the caller falls back
 * to `messageId` (the result's own id) in that case so the runtime
 * still allocates a stable composite key.
 */
export function getCandidateToolOwners(db: Database, sessionId: string, callId: string): string[] {
    const rows = db
        .prepare(
            `SELECT DISTINCT tool_owner_message_id
             FROM tags
             WHERE session_id = ?
               AND message_id = ?
               AND type = 'tool'
               AND tool_owner_message_id IS NOT NULL`,
        )
        .all(sessionId, callId) as Array<{ tool_owner_message_id: string }>;
    return rows.map((r) => r.tool_owner_message_id);
}

/**
 * Pick the most recent (by OpenCode `time_created`) candidate owner
 * whose message strictly precedes `currentMessageId`. Tie-break on
 * lexicographic id, matching the legacy single-statement ordering
 * (`ORDER BY time_created DESC, id DESC` limited to rows where
 * `time_created < currentTime`).
 *
 * Returns null when:
 *   - The candidate list is empty
 *   - `currentMessageId` is not present in `times`
 *   - No candidate predates `currentMessageId` in OC time
 *
 * This helper is independent of any DB handle — the caller resolves the
 * `times` map (typically via `getMessageTimesFromOpenCodeDb`) and passes
 * it in. Splitting the lookup from the picking keeps `storage-tags.ts`
 * free of any OpenCode-DB import.
 */
export function pickNearestPriorOwner(
    candidates: readonly string[],
    currentMessageId: string,
    times: ReadonlyMap<string, number>,
): string | null {
    const currentTime = times.get(currentMessageId);
    if (typeof currentTime !== "number") return null;

    let best: { id: string; time: number } | null = null;
    for (const id of candidates) {
        const t = times.get(id);
        if (typeof t !== "number") continue;
        if (t > currentTime) continue;
        if (t === currentTime && id >= currentMessageId) continue;
        if (best === null || t > best.time || (t === best.time && id > best.id)) {
            best = { id, time: t };
        }
    }
    return best?.id ?? null;
}

/**
 * Legacy alias kept for the rare runtime call site that hasn't been
 * migrated to the split lookup-then-pick form. Always returns null
 * (no message-time data available without a DB handle the function
 * itself can't reach). New call sites should use `getCandidateToolOwners`
 * + `getMessageTimesFromOpenCodeDb` + `pickNearestPriorOwner` directly.
 *
 * Why we keep this name: the v3.3.1 plan documents this as the public
 * entry point for the result-only-window fallback. Removing it would
 * require touching `.alfonso/plans/tag-owner-fix-plan.md` and migrating
 * the test fixtures that exercise it. Leaving the symbol present with
 * a noop body keeps existing test scaffolds working while the actual
 * pick happens in the hooks-tree caller.
 */
export function getPersistedToolOwnerNearestPrior(
    _db: Database,
    _sessionId: string,
    _callId: string,
    _currentMessageId: string,
): string | null {
    return null;
}

function getDeleteToolTagsByOwnerStatement(db: Database): PreparedStatement {
    let stmt = deleteToolTagsByOwnerStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `DELETE FROM tags
             WHERE session_id = ?
               AND type = 'tool'
               AND tool_owner_message_id = ?
             RETURNING id`,
        );
        deleteToolTagsByOwnerStatements.set(db, stmt);
    }
    return stmt;
}

/**
 * Delete every tool tag owned by `ownerMsgId` in the session. Used by
 * `message.removed` cleanup to scope the deletion correctly: pre-v10
 * a removed assistant message would `deleteTagsByMessageId(messageId)`
 * which only matched `message_id = messageId` (the contentId for text
 * parts), missing tool tags whose `message_id` is the callID. Post-v10
 * the owner column gives us the right scope.
 *
 * Returns the number of rows deleted. NULL-owner legacy rows are not
 * matched by this helper — they remain reachable via `message_id`-only
 * deletion paths until adopted or backfilled.
 */
export function deleteToolTagsByOwner(db: Database, sessionId: string, ownerMsgId: string): number {
    // RETURNING contains only rows deleted by this statement, not writes made by triggers.
    return getDeleteToolTagsByOwnerStatement(db).all(sessionId, ownerMsgId).length;
}
