#!/usr/bin/env bun

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getDataDir, getMagicContextStorageDir } from "../src/shared/data-path";
import { Database } from "../src/shared/sqlite";
import { closeQuietly } from "../src/shared/sqlite-helpers";
import { clearSession } from "../src/features/magic-context/storage-meta-session";
import { SESSION_SCOPED_TABLES } from "../src/features/magic-context/storage-session-tables";
import {
    copySessionStateForClone,
    type CloneCompartmentRow,
    type CloneSessionStateFilter,
} from "../src/features/magic-context/storage-clone";

type SqlRow = Record<string, unknown>;
type IdMap = Map<string, string>;

type ColumnInfo = {
    name: string;
    type: string;
    pk: number;
};

export interface CloneSessionOptions {
    sessionId: string;
    deleteSessionId?: string;
    suffix?: string;
    dryRun?: boolean;
    force?: boolean;
    opencodeDbPath?: string;
    contextDbPath?: string;
}

export interface DeleteClonedSessionOptions {
    sessionId: string;
    force?: boolean;
    opencodeDbPath?: string;
    contextDbPath?: string;
}

export interface DeleteClonedSessionResult {
    sessionId: string;
    opencode: CloneTableCount[];
    magicContext: CloneTableCount[];
}

export interface CloneTableCount {
    table: string;
    rows: number;
}

export interface ClonePlan {
    sourceSessionId: string;
    destinationSessionId: string;
    title: string;
    directory: string;
    projectId: string;
    retainedMessageIds: string[];
    trimmedMessageIds: string[];
    opencode: CloneTableCount[];
    magicContext: CloneTableCount[];
    skippedMagicContext: CloneTableCount[];
    messageIdPolicy: "remint-native-time-ordered";
}

export interface CloneResult {
    plan: ClonePlan;
    dryRun: boolean;
    opencode: CloneTableCount[];
    magicContext: CloneTableCount[];
}

const BUSY_TIMEOUT_MS = 5000;
const CONTENT_ID_SUFFIX = /(:(?:p|file)\d+)$/;
const OPENCODE_EXCLUDED_TABLES = new Set(["session_share", "session_input"]);
const NATIVE_ID_PREFIX_HEX_LENGTH = 12;
const NATIVE_ID_SUFFIX_LENGTH = 14;
const NATIVE_ID_COUNTER_BITS = 12n;
const NATIVE_ID_PREFIX_MASK = (1n << BigInt(NATIVE_ID_PREFIX_HEX_LENGTH * 4)) - 1n;
const BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const CLONE_MARKER_KEY = "cortexkitClone";

// Native OpenCode samples are msg_f75177794001ViIwT8V72U0yhv and
// prt_f751778ae001HUqSOyQYgAuRGh. Their 12-hex prefix is the low 48 bits
// of (epoch milliseconds shifted left 12 bits) plus a sequence value, followed
// by a 14-character base62 suffix. For example, 1784375900052 ms produces
// f75177794000 before sequence 1, so the observed prefix is f75177794001.
const NATIVE_ID_PATTERN = /^(?:msg|prt)_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const MAGIC_CONTEXT_ADDITIONAL_TABLES = [
    "compression_depth",
    "session_facts",
    "session_notes",
    "notes",
    // Notes must land before this association because authority-managed note
    // guards resolve session ownership through session_projects.
    "session_projects",
    "user_memory_candidates",
    "primer_candidates",
    "transform_decisions",
    "synapse_batch_ledger",
];
const MAGIC_CONTEXT_EXCLUDED_REASONS: Record<string, string> = {
    compartment_chunk_embeddings: "embeddings are keyed by the source session; rebuild lazily",
    message_history_index: "message index is rebuilt lazily",
    message_history_fts: "FTS index is rebuilt lazily",
    memories_fts: "FTS index is rebuilt lazily",
    primers_fts: "FTS index is rebuilt lazily",
    git_commits_fts: "FTS index is rebuilt lazily",
    compartment_state_lease: "historian/compartment lease must start fresh",
    tool_owner_backfill_state: "backfill lease/state must start fresh",
    plugin_messages: "queued cross-process messages must not replay in a drive",
    m0_mutation_log: "mutation log references source compartment ids and cached state is cold",
    compartment_events: "historian event log is not durable session input",
    historian_runs: "historian run history must start clean for the drive",
    subagent_invocations: "old subagent runs are not part of the drive seed",
    recomp_compartments: "recomp staging belongs to the source pass",
    recomp_facts: "recomp staging belongs to the source pass",
    recalls: "recall rows reference source tag ids",
};
const RETIRED_META_COLUMNS = new Set(["deferred_execute_state"]);

const RESET_META_COLUMNS = new Set([
    "channel2_nudge_state",
    "channel2_nudge_claimed_at",
    "channel2_nudge_claim_token",
    "emergency_drain_active",
    "historian_drain_failure_at",
    "last_emergency_drop_through_tag",
    "last_emergency_input_sample",
    "needs_emergency_recovery",
    "force_emergency_bypass_window_start",
    "force_emergency_bypass_used",
    "emergency_recovery_origin",
    "compartment_in_progress",
    "wrapup_in_progress_state",
    "last_transform_error",
]);

function quoteIdentifier(identifier: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
        throw new Error(`unsafe SQLite identifier: ${identifier}`);
    }
    return `"${identifier}"`;
}

function setBusyTimeout(db: Database): void {
    db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
}

function runImmediate<T>(db: Database, body: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
        const result = body();
        db.exec("COMMIT");
        committed = true;
        return result;
    } finally {
        if (!committed) {
            try {
                db.exec("ROLLBACK");
            } catch {
                // SQLite may already have rolled back a failed transaction.
            }
        }
    }
}

function tableNames(db: Database): string[] {
    return (db
        .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as Array<{ name?: string }>).flatMap((row) =>
        typeof row.name === "string" ? [row.name] : [],
    );
}

function tableExists(db: Database, table: string): boolean {
    return tableNames(db).includes(table);
}

function columns(db: Database, table: string): ColumnInfo[] {
    return db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as ColumnInfo[];
}

function hasColumn(db: Database, table: string, column: string): boolean {
    return columns(db, table).some((entry) => entry.name === column);
}

function countRows(db: Database, table: string, column: string, value: string): number {
    const row = db
        .prepare(
            `SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} = ?`,
        )
        .get(value) as { count?: number } | undefined;
    return typeof row?.count === "number" ? row.count : 0;
}

function rowsForValue(db: Database, table: string, column: string, value: string): SqlRow[] {
    return db
        .prepare(
            `SELECT * FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} = ?`,
        )
        .all(value) as SqlRow[];
}

function sessionScopedTables(db: Database): string[] {
    return tableNames(db).filter(
        (table) => !OPENCODE_EXCLUDED_TABLES.has(table) && hasColumn(db, table, "session_id"),
    );
}

function eventScopedTables(db: Database): string[] {
    return tableNames(db).filter(
        (table) => hasColumn(db, table, "aggregate_id") && table !== "event_sequence",
    );
}

function countTableRows(
    db: Database,
    tables: readonly string[],
    value: string,
    column: string,
): CloneTableCount[] {
    return tables
        .map((table) => ({ table, rows: countRows(db, table, column, value) }))
        .filter((entry) => entry.rows > 0);
}

function sourceSnapshot(
    db: Database,
    sessionTables: readonly string[],
    sourceSessionId: string,
): Map<string, number> {
    const result = new Map<string, number>();
    for (const table of sessionTables) {
        result.set(`session_id:${table}`, countRows(db, table, "session_id", sourceSessionId));
    }
    if (tableExists(db, "event_sequence") && hasColumn(db, "event_sequence", "aggregate_id")) {
        result.set(
            "aggregate_id:event_sequence",
            countRows(db, "event_sequence", "aggregate_id", sourceSessionId),
        );
    }
    for (const table of eventScopedTables(db)) {
        result.set(`aggregate_id:${table}`, countRows(db, table, "aggregate_id", sourceSessionId));
    }
    return result;
}

function assertSnapshotUnchanged(
    label: string,
    before: Map<string, number>,
    after: Map<string, number>,
): void {
    const keys = new Set([...before.keys(), ...after.keys()]);
    const differences: string[] = [];
    for (const key of keys) {
        const oldCount = before.get(key) ?? 0;
        const newCount = after.get(key) ?? 0;
        if (oldCount !== newCount) differences.push(`${key}: ${oldCount} -> ${newCount}`);
    }
    if (differences.length > 0) {
        throw new Error(`${label} source rows changed unexpectedly: ${differences.join(", ")}`);
    }
}

function randomToken(): string {
    // OpenCode's ids use an alphanumeric suffix; base64url's '-' and '_' are
    // not accepted by every OpenCode release.
    return randomBytes(24)
        .toString("base64")
        .replace(/[^A-Za-z0-9]/g, "")
        .slice(0, 28);
}

function randomBase62(length: number): string {
    const bytes = randomBytes(length);
    return Array.from(bytes, (byte) => BASE62_ALPHABET[byte % BASE62_ALPHABET.length]).join("");
}

function compareLexical(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function mintSessionId(db: Database): string {
    for (;;) {
        const id = `ses_${randomToken()}`;
        const exists = db.prepare("SELECT 1 FROM session WHERE id = ?").get(id);
        if (!exists) return id;
    }
}

function mintDestinationSessionId(opencodeDb: Database, contextDb: Database): string {
    for (;;) {
        const id = mintSessionId(opencodeDb);
        const contextTables = sessionScopedTables(contextDb);
        if (!contextTables.some((table) => countRows(contextDb, table, "session_id", id) > 0)) {
            return id;
        }
    }
}

function mintRowId(db: Database, table: string, sourceId: string, used: Set<string>): string {
    const separator = sourceId.indexOf("_");
    const prefix = separator > 0 ? sourceId.slice(0, separator) : table;
    for (;;) {
        const id = `${prefix}_${randomToken()}`;
        if (used.has(id)) continue;
        if (!db.prepare(`SELECT 1 FROM ${quoteIdentifier(table)} WHERE id = ?`).get(id)) {
            used.add(id);
            return id;
        }
    }
}

function nativePrefixForTime(timeCreated: unknown, previousPacked: bigint): { prefix: string; packed: bigint } {
    const milliseconds =
        typeof timeCreated === "number" && Number.isFinite(timeCreated)
            ? BigInt(Math.max(0, Math.floor(timeCreated)))
            : 0n;
    let packed = ((milliseconds << NATIVE_ID_COUNTER_BITS) + 1n) & NATIVE_ID_PREFIX_MASK;
    if (packed <= previousPacked) packed = previousPacked + 1n;
    if (packed > NATIVE_ID_PREFIX_MASK) {
        throw new Error("native OpenCode id prefix exhausted while reminting rows");
    }
    return {
        prefix: packed.toString(16).padStart(NATIVE_ID_PREFIX_HEX_LENGTH, "0"),
        packed,
    };
}

function buildNativeIdMap(
    db: Database,
    table: "message" | "part",
    rows: readonly SqlRow[],
): IdMap {
    const sourcePrefix = table === "message" ? "msg" : "prt";
    const used = new Set<string>();
    const result: IdMap = new Map();
    let previousPacked = 0n;
    for (const row of rows) {
        const next = nativePrefixForTime(row.time_created, previousPacked);
        previousPacked = next.packed;
        let id = "";
        do {
            id = `${sourcePrefix}_${next.prefix}${randomBase62(NATIVE_ID_SUFFIX_LENGTH)}`;
        } while (used.has(id) || db.prepare(`SELECT 1 FROM ${quoteIdentifier(table)} WHERE id = ?`).get(id));
        used.add(id);
        if (!NATIVE_ID_PATTERN.test(id)) throw new Error(`generated invalid native ${table} id: ${id}`);
        result.set(String(row.id), id);
    }
    return result;
}

function mapContentId(id: string, messageIds: IdMap): string {
    const direct = messageIds.get(id);
    if (direct) return direct;
    const suffix = id.match(CONTENT_ID_SUFFIX);
    if (!suffix) return id;
    const rawId = id.slice(0, -suffix[1].length);
    const mapped = messageIds.get(rawId);
    return mapped ? `${mapped}${suffix[1]}` : id;
}

function mapString(
    value: string,
    sourceSessionId: string,
    destinationSessionId: string,
    messageIds: IdMap,
    partIds: IdMap,
    eventIds: IdMap,
    otherIds: readonly IdMap[] = [],
): string {
    if (value === sourceSessionId) return destinationSessionId;
    const mappedMessage = messageIds.get(value);
    if (mappedMessage) return mappedMessage;
    const mappedPart = partIds.get(value);
    if (mappedPart) return mappedPart;
    const mappedEvent = eventIds.get(value);
    if (mappedEvent) return mappedEvent;
    for (const map of otherIds) {
        const mapped = map.get(value);
        if (mapped) return mapped;
    }
    const blockSeparator = value.lastIndexOf("#");
    const blockSuffix = blockSeparator > 0 ? value.slice(blockSeparator) : "";
    if (/^#\d+$/.test(blockSuffix)) {
        const sourceMessageId = value.slice(0, blockSeparator);
        const mappedBlockMessage = messageIds.get(sourceMessageId);
        if (mappedBlockMessage) return `${mappedBlockMessage}${blockSuffix}`;
    }
    return mapContentId(value, messageIds);
}

function rewriteJsonValue(
    value: unknown,
    sourceSessionId: string,
    destinationSessionId: string,
    messageIds: IdMap,
    partIds: IdMap,
    eventIds: IdMap,
    otherIds: readonly IdMap[] = [],
): unknown {
    if (typeof value === "string") {
        return mapString(
            value,
            sourceSessionId,
            destinationSessionId,
            messageIds,
            partIds,
            eventIds,
            otherIds,
        );
    }
    if (Array.isArray(value)) {
        return value.map((item) =>
            rewriteJsonValue(
                item,
                sourceSessionId,
                destinationSessionId,
                messageIds,
                partIds,
                eventIds,
                otherIds,
            ),
        );
    }
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [
                key,
                rewriteJsonValue(
                    item,
                    sourceSessionId,
                    destinationSessionId,
                    messageIds,
                    partIds,
                    eventIds,
                    otherIds,
                ),
            ]),
        );
    }
    return value;
}

function rewriteJsonBlob(
    raw: string,
    context: string,
    sourceSessionId: string,
    destinationSessionId: string,
    messageIds: IdMap,
    partIds: IdMap,
    eventIds: IdMap,
    otherIds: readonly IdMap[] = [],
): string {
    try {
        return JSON.stringify(
            rewriteJsonValue(
                JSON.parse(raw),
                sourceSessionId,
                destinationSessionId,
                messageIds,
                partIds,
                eventIds,
                otherIds,
            ),
        );
    } catch (error) {
        throw new Error(`cannot rewrite JSON in ${context}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function buildIdMap(db: Database, table: string, ids: readonly string[]): IdMap {
    const used = new Set<string>(ids);
    const result: IdMap = new Map();
    for (const sourceId of ids) {
        result.set(sourceId, mintRowId(db, table, sourceId, used));
    }
    return result;
}

function chunk<T>(values: readonly T[], size: number): T[][] {
    const result: T[][] = [];
    for (let index = 0; index < values.length; index += size) {
        result.push(values.slice(index, index + size));
    }
    return result;
}

function rowsByIds(db: Database, table: string, ids: readonly string[]): SqlRow[] {
    const result: SqlRow[] = [];
    for (const group of chunk(ids, 400)) {
        if (group.length === 0) continue;
        const placeholders = group.map(() => "?").join(", ");
        result.push(
            ...(db
                .prepare(
                    `SELECT * FROM ${quoteIdentifier(table)} WHERE id IN (${placeholders})`,
                )
                .all(...group) as SqlRow[]),
        );
    }
    return result;
}

function insertRow(db: Database, table: string, row: SqlRow, override: (column: string, value: unknown) => unknown): void {
    const names = Object.keys(row);
    const values = names.map((name) => override(name, row[name]));
    const quotedNames = names.map(quoteIdentifier).join(", ");
    const placeholders = names.map(() => "?").join(", ");
    db.prepare(
        `INSERT INTO ${quoteIdentifier(table)} (${quotedNames}) VALUES (${placeholders})`,
    ).run(...values);
}

function makeOpenCodeRowRewriter(
    table: string,
    sourceSessionId: string,
    destinationSessionId: string,
    messageIds: IdMap,
    partIds: IdMap,
    eventIds: IdMap,
    otherIds: readonly IdMap[],
    idMap?: IdMap,
): (column: string, value: unknown) => unknown {
    return (column, value) => {
        if (column === "session_id" || column === "aggregate_id") return destinationSessionId;
        if (column === "message_id" && typeof value === "string") {
            return mapString(value, sourceSessionId, destinationSessionId, messageIds, partIds, eventIds, otherIds);
        }
        if (column === "parent_id" && typeof value === "string" && value === sourceSessionId) {
            return destinationSessionId;
        }
        if (column === "owner_id" && typeof value === "string") {
            return mapString(value, sourceSessionId, destinationSessionId, messageIds, partIds, eventIds, otherIds);
        }
        if (column === "id" && typeof value === "string" && idMap) {
            return idMap.get(value) ?? value;
        }
        if (
            ["data", "metadata", "baseline", "snapshot", "revert", "permission"].includes(column) &&
            typeof value === "string"
        ) {
            return rewriteJsonBlob(
                value,
                `${table}.${column}`,
                sourceSessionId,
                destinationSessionId,
                messageIds,
                partIds,
                eventIds,
                otherIds,
            );
        }
        return value;
    };
}

type MessageCandidate = {
    id: string;
    time_created: number;
    data: string;
};

function parseJsonObject(raw: unknown): Record<string, unknown> | null {
    if (typeof raw !== "string" || raw.length === 0) return null;
    try {
        const value = JSON.parse(raw);
        return value !== null && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

function messageRowsForSession(db: Database, sessionId: string): MessageCandidate[] {
    return db
        .prepare(
            "SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC",
        )
        .all(sessionId) as MessageCandidate[];
}

function messageRole(row: MessageCandidate): string | null {
    return parseJsonObject(row.data)?.role as string | null | undefined ?? null;
}

function hasUnresolvedLocalTool(db: Database, messageId: string): boolean {
    const parts = db
        .prepare("SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC, id ASC")
        .all(messageId) as Array<{ data?: unknown }> ;
    return parts.some((row) => {
        const part = parseJsonObject(row.data);
        if (!part || part.type !== "tool" || part.providerExecuted === true) return false;
        const status =
            typeof part.status === "string"
                ? part.status
                : part.state !== null && typeof part.state === "object"
                  ? (part.state as Record<string, unknown>).status
                  : null;
        return status !== "completed" && status !== "error";
    });
}

function terminalMessageReason(db: Database, row: MessageCandidate): string | null {
    if (messageRole(row) !== "assistant") return "final visible message is not an assistant";
    const data = parseJsonObject(row.data);
    if (data?.finish === "tool-calls") return 'assistant finish is "tool-calls"';
    if (hasUnresolvedLocalTool(db, row.id)) return "assistant has an unresolved local tool";
    return null;
}

function selectTerminalMessages(
    db: Database,
    sourceSessionId: string,
): { retainedMessageIds: string[]; trimmedMessageIds: string[] } {
    const rows = messageRowsForSession(db, sourceSessionId);
    const trimmedMessageIds: string[] = [];
    const trimmedMessageIdSet = new Set<string>();
    const recordTrimmed = (id: string): void => {
        if (trimmedMessageIdSet.has(id)) return;
        trimmedMessageIdSet.add(id);
        trimmedMessageIds.push(id);
        console.log(`terminal guard: trimmed trailing message ${id}`);
    };
    let end = rows.length;
    while (end > 0) {
        let candidateIndex = -1;
        for (let index = end - 1; index >= 0; index -= 1) {
            if (messageRole(rows[index]) === "user" || messageRole(rows[index]) === "assistant") {
                candidateIndex = index;
                break;
            }
        }
        if (candidateIndex < 0) break;
        const reason = terminalMessageReason(db, rows[candidateIndex]);
        if (reason === null) {
            for (let index = candidateIndex + 1; index < rows.length; index += 1) {
                recordTrimmed(rows[index].id);
            }
            const retainedMessageIds = rows.slice(0, candidateIndex + 1).map((row) => row.id);
            if (trimmedMessageIds.length > 0) {
                console.log(
                    `terminal guard: retained ${retainedMessageIds.length} messages after trimming ${trimmedMessageIds.length}`,
                );
            }
            return { retainedMessageIds, trimmedMessageIds };
        }
        console.log(`terminal guard: trimming ${rows[candidateIndex].id}: ${reason}`);
        for (let index = candidateIndex; index < end; index += 1) {
            recordTrimmed(rows[index].id);
        }
        end = candidateIndex;
    }
    throw new Error(`source session ${sourceSessionId} has no terminal assistant message suitable for cloning`);
}

function partRowsForMessages(db: Database, sessionId: string, messageIds: readonly string[]): SqlRow[] {
    const result: SqlRow[] = [];
    for (const group of chunk(messageIds, 400)) {
        if (group.length === 0) continue;
        const placeholders = group.map(() => "?").join(", ");
        result.push(
            ...(db
                .prepare(
                    `SELECT * FROM part WHERE session_id = ? AND message_id IN (${placeholders})`,
                )
                .all(sessionId, ...group) as SqlRow[]),
        );
    }
    return result.sort((left, right) => {
        const leftTime = typeof left.time_created === "number" ? left.time_created : 0;
        const rightTime = typeof right.time_created === "number" ? right.time_created : 0;
        return leftTime - rightTime || compareLexical(String(left.id), String(right.id));
    });
}

function sourceUnmappedReferenceIds(
    db: Database,
    sourceSessionId: string,
    retainedMessageIds: readonly string[],
): Set<string> {
    const retainedMessages = new Set(retainedMessageIds);
    const unmapped = new Set(
        messageRowsForSession(db, sourceSessionId)
            .map((row) => row.id)
            .filter((id) => !retainedMessages.has(id)),
    );
    for (const row of rowsForValue(db, "part", "session_id", sourceSessionId)) {
        if (!retainedMessages.has(String(row.message_id)) && typeof row.id === "string") {
            unmapped.add(row.id);
        }
    }
    return unmapped;
}

function jsonContainsAnyReference(value: unknown, ids: ReadonlySet<string>): boolean {
    if (typeof value === "string") {
        for (const id of ids) {
            if (value === id || value.startsWith(`${id}:`)) return true;
        }
        return false;
    }
    if (Array.isArray(value)) return value.some((item) => jsonContainsAnyReference(item, ids));
    if (value !== null && typeof value === "object") {
        return Object.values(value).some((item) => jsonContainsAnyReference(item, ids));
    }
    return false;
}

function eventRowsForClone(
    db: Database,
    sourceSessionId: string,
    unmappedReferences: ReadonlySet<string>,
): SqlRow[] {
    if (!tableExists(db, "event")) return [];
    return rowsForValue(db, "event", "aggregate_id", sourceSessionId).filter((row) => {
        if (unmappedReferences.size === 0 || typeof row.data !== "string") return true;
        try {
            return !jsonContainsAnyReference(JSON.parse(row.data), unmappedReferences);
        } catch {
            return true;
        }
    });
}

function copyOpenCodeRows(
    db: Database,
    sourceSessionId: string,
    destinationSessionId: string,
    cloneTitle: string,
    retainedMessageIds: readonly string[],
): {
    counts: CloneTableCount[];
    messageIds: IdMap;
    partIds: IdMap;
    messageOrdinals: Map<string, number>;
} {
    const allSessionTables = sessionScopedTables(db);
    const sourceMessageRows = rowsByIds(db, "message", retainedMessageIds).sort((left, right) => {
        const leftTime = typeof left.time_created === "number" ? left.time_created : 0;
        const rightTime = typeof right.time_created === "number" ? right.time_created : 0;
        return leftTime - rightTime || compareLexical(String(left.id), String(right.id));
    });
    const sourceMessageIds = sourceMessageRows.map((row) => String(row.id));
    if (sourceMessageIds.length !== retainedMessageIds.length) {
        throw new Error("terminal message selection referenced rows that disappeared before copy");
    }
    const messageIds = buildNativeIdMap(db, "message", sourceMessageRows);
    const messageOrdinals = new Map(sourceMessageIds.map((id, index) => [id, index + 1]));
    const sourcePartRows = partRowsForMessages(db, sourceSessionId, sourceMessageIds);
    const messageOrder = new Map(sourceMessageIds.map((id, index) => [id, index]));
    sourcePartRows.sort((left, right) => {
        const leftOrder = messageOrder.get(String(left.message_id)) ?? Number.MAX_SAFE_INTEGER;
        const rightOrder = messageOrder.get(String(right.message_id)) ?? Number.MAX_SAFE_INTEGER;
        const leftTime = typeof left.time_created === "number" ? left.time_created : 0;
        const rightTime = typeof right.time_created === "number" ? right.time_created : 0;
        return (leftOrder - rightOrder) || leftTime - rightTime || compareLexical(String(left.id), String(right.id));
    });
    const partIds = buildNativeIdMap(db, "part", sourcePartRows);
    const unmappedReferences = sourceUnmappedReferenceIds(db, sourceSessionId, sourceMessageIds);
    const eventRows = eventRowsForClone(db, sourceSessionId, unmappedReferences);
    const eventIds = buildIdMap(
        db,
        "event",
        eventRows.flatMap((row) => (typeof row.id === "string" ? [row.id] : [])),
    );
    const otherIds: IdMap[] = [];
    const rowsByTable = new Map<string, SqlRow[]>();
    const idMapsByTable = new Map<string, IdMap>();

    for (const table of allSessionTables) {
        if (table === "message" || table === "part") continue;
        const rows = rowsForValue(db, table, "session_id", sourceSessionId);
        rowsByTable.set(table, rows);
        const idColumn = columns(db, table).find((column) => column.name === "id");
        if (idColumn && !/INT/i.test(idColumn.type)) {
            const ids = rows.flatMap((row) => (typeof row.id === "string" ? [row.id] : []));
            const idMap = buildIdMap(db, table, ids);
            idMapsByTable.set(table, idMap);
            otherIds.push(idMap);
        }
    }

    const sessionRows = rowsForValue(db, "session", "id", sourceSessionId);
    if (sessionRows.length !== 1) throw new Error(`source session ${sourceSessionId} disappeared before copy`);
    const sessionRow = sessionRows[0];
    const now = Date.now();
    insertRow(db, "session", sessionRow, (column, value) => {
        if (column === "id") return destinationSessionId;
        if (column === "parent_id") return null;
        if (column === "title") return cloneTitle;
        if (column === "slug" && typeof value === "string") return `${value}-rust-drive-clone`;
        if (column === "time_created" || column === "time_updated") return now;
        if (
            column === "share_url" ||
            column === "revert" ||
            column.startsWith("summary_") ||
            column === "time_archived" ||
            column === "time_compacting"
        ) {
            return null;
        }
        if (column === "cost" || column.startsWith("tokens_")) return 0;
        if (column === "metadata") {
            return JSON.stringify({
                [CLONE_MARKER_KEY]: {
                    version: 1,
                    sourceSessionId,
                    createdAt: now,
                },
            });
        }
        if (column === "agent" || column === "model" || column === "permission") return value;
        return value;
    });

    const messageRows = sourceMessageRows;
    for (const row of messageRows) {
        insertRow(
            db,
            "message",
            row,
            makeOpenCodeRowRewriter(
                "message",
                sourceSessionId,
                destinationSessionId,
                messageIds,
                partIds,
                eventIds,
                otherIds,
                messageIds,
            ),
        );
    }

    const partRows = sourcePartRows;
    for (const row of partRows) {
        insertRow(
            db,
            "part",
            row,
            makeOpenCodeRowRewriter(
                "part",
                sourceSessionId,
                destinationSessionId,
                messageIds,
                partIds,
                eventIds,
                otherIds,
                partIds,
            ),
        );
    }

    const counts: CloneTableCount[] = [{ table: "session", rows: 1 }];
    if (messageRows.length > 0) counts.push({ table: "message", rows: messageRows.length });
    if (partRows.length > 0) counts.push({ table: "part", rows: partRows.length });

    for (const table of allSessionTables) {
        if (table === "message" || table === "part" || OPENCODE_EXCLUDED_TABLES.has(table)) continue;
        const rows = rowsByTable.get(table) ?? [];
        for (const row of rows) {
            insertRow(
                db,
                table,
                row,
                makeOpenCodeRowRewriter(
                    table,
                    sourceSessionId,
                    destinationSessionId,
                    messageIds,
                    partIds,
                    eventIds,
                    otherIds,
                    idMapsByTable.get(table),
                ),
            );
        }
        if (rows.length > 0) counts.push({ table, rows: rows.length });
    }

    if (tableExists(db, "event_sequence")) {
        const rows = rowsForValue(db, "event_sequence", "aggregate_id", sourceSessionId);
        for (const row of rows) {
            insertRow(db, "event_sequence", row, (column, value) => {
                if (column === "aggregate_id") return destinationSessionId;
                if (typeof value === "string") {
                    return mapString(
                        value,
                        sourceSessionId,
                        destinationSessionId,
                        messageIds,
                        partIds,
                        eventIds,
                        otherIds,
                    );
                }
                return value;
            });
        }
        if (rows.length > 0) counts.push({ table: "event_sequence", rows: rows.length });
    }

    if (tableExists(db, "event")) {
        const rows = eventRows;
        for (const row of rows) {
            insertRow(
                db,
                "event",
                row,
                makeOpenCodeRowRewriter(
                    "event",
                    sourceSessionId,
                    destinationSessionId,
                    messageIds,
                    partIds,
                    eventIds,
                    otherIds,
                    eventIds,
                ),
            );
        }
        if (rows.length > 0) counts.push({ table: "event", rows: rows.length });
    }

    // Validate the copied session while the write lock is still held.
    const copiedSession = db
        .prepare("SELECT id, title, directory, version, project_id, metadata FROM session WHERE id = ?")
        .get(destinationSessionId) as SqlRow | undefined;
    if (
        !copiedSession ||
        typeof copiedSession.title !== "string" ||
        copiedSession.title !== cloneTitle ||
        typeof copiedSession.directory !== "string" ||
        copiedSession.directory.length === 0 ||
        typeof copiedSession.version !== "string" ||
        copiedSession.version.length === 0
    ) {
        throw new Error(`destination session ${destinationSessionId} failed OpenCode validity checks`);
    }
    if (typeof copiedSession.metadata === "string" && copiedSession.metadata.length > 0) {
        JSON.parse(copiedSession.metadata);
    }
    const orphanMessages = db
        .prepare(
            `SELECT COUNT(*) AS count FROM message m WHERE m.session_id = ? AND NOT EXISTS (SELECT 1 FROM session s WHERE s.id = m.session_id)`,
        )
        .get(destinationSessionId) as { count?: number };
    if ((orphanMessages.count ?? 0) !== 0) throw new Error("destination has orphaned OpenCode messages");
    const orphanParts = db
        .prepare(
            `SELECT COUNT(*) AS count FROM part p WHERE p.session_id = ? AND NOT EXISTS (SELECT 1 FROM message m WHERE m.id = p.message_id)`,
        )
        .get(destinationSessionId) as { count?: number };
    if ((orphanParts.count ?? 0) !== 0) throw new Error("destination has orphaned OpenCode parts");
    assertRemintedMessageInvariants(db, destinationSessionId);

    return { counts, messageIds, partIds, messageOrdinals };
}

function assertRemintedMessageInvariants(db: Database, destinationSessionId: string): void {
    const rows = messageRowsForSession(db, destinationSessionId);
    for (const row of rows) {
        if (!NATIVE_ID_PATTERN.test(row.id) || !row.id.startsWith("msg_")) {
            throw new Error(`destination message id is not native-shaped: ${row.id}`);
        }
    }
    const partRows = db
        .prepare("SELECT id FROM part WHERE session_id = ? ORDER BY time_created ASC, id ASC")
        .all(destinationSessionId) as Array<{ id?: unknown }> ;
    for (const row of partRows) {
        if (typeof row.id !== "string" || !NATIVE_ID_PATTERN.test(row.id) || !row.id.startsWith("prt_")) {
            throw new Error(`destination part id is not native-shaped: ${String(row.id)}`);
        }
    }
    const userIds = rows.filter((row) => messageRole(row) === "user").map((row) => row.id);
    const assistantIds = rows.filter((row) => messageRole(row) === "assistant").map((row) => row.id);
    const maxUserId = userIds.sort().at(-1);
    const maxAssistantId = assistantIds.sort().at(-1);
    if (!maxUserId || !maxAssistantId || maxUserId >= maxAssistantId) {
        throw new Error(
            `destination message order violates terminal guard: max user ${maxUserId ?? "<none>"}, max assistant ${maxAssistantId ?? "<none>"}`,
        );
    }
    const visibleRows = rows.filter((row) => messageRole(row) === "user" || messageRole(row) === "assistant");
    const finalVisible = visibleRows.at(-1);
    if (!finalVisible) throw new Error("destination has no visible messages");
    const reason = terminalMessageReason(db, finalVisible);
    if (reason !== null) throw new Error(`destination terminal assistant assertion failed: ${reason}`);
}

function contextMessageMapper(
    sourceSessionId: string,
    destinationSessionId: string,
    messageIds: IdMap,
    partIds: IdMap,
): (value: string) => string {
    return (value) => mapString(value, sourceSessionId, destinationSessionId, messageIds, partIds, new Map());
}

function rewriteContextValue(
    column: string,
    value: unknown,
    sourceSessionId: string,
    destinationSessionId: string,
    messageIds: IdMap,
    partIds: IdMap,
): unknown {
    if (typeof value !== "string") return value;
    const mapped = contextMessageMapper(sourceSessionId, destinationSessionId, messageIds, partIds)(value);
    if (mapped !== value) return mapped;
    if (
        value.trimStart().startsWith("{") ||
        value.trimStart().startsWith("[") ||
        column.endsWith("_json") ||
        column.endsWith("_ids") ||
        column.endsWith("_state")
    ) {
        try {
            return JSON.stringify(
                rewriteJsonValue(
                    JSON.parse(value),
                    sourceSessionId,
                    destinationSessionId,
                    messageIds,
                    partIds,
                    new Map(),
                ),
            );
        } catch {
            return value;
        }
    }
    return value;
}

function contextMetaReset(column: ColumnInfo): unknown {
    if (column.name === "served_prefix" || column.name === "held_release") return null;
    if (column.name.startsWith("cached_m0_") || column.name === "cached_m1_bytes") return null;
    if (!RESET_META_COLUMNS.has(column.name)) return undefined;
    return /INT|REAL/i.test(column.type) ? 0 : "";
}

function copyContextMeta(
    db: Database,
    sourceSessionId: string,
    destinationSessionId: string,
    messageIds: IdMap,
    partIds: IdMap,
): void {
    if (!tableExists(db, "session_meta")) return;
    // The core clone already owns the filtered/replayed document.
    const metaColumns = columns(db, "session_meta").filter(
        (column) =>
            column.name !== "session_id" &&
            column.name !== "trailing_blank_decisions" &&
            !RETIRED_META_COLUMNS.has(column.name),
    );
    const selectedColumns = ["session_id", ...metaColumns.map((column) => column.name)]
        .map(quoteIdentifier)
        .join(", ");
    const source = db
        .prepare(`SELECT ${selectedColumns} FROM session_meta WHERE session_id = ?`)
        .get(sourceSessionId) as SqlRow | undefined;
    if (!source) return;
    const assignments = metaColumns.map((column) => `${quoteIdentifier(column.name)} = ?`).join(", ");
    const values = metaColumns.map((column) => {
        const reset = contextMetaReset(column);
        if (reset !== undefined) return reset;
        return rewriteContextValue(
            column.name,
            source[column.name],
            sourceSessionId,
            destinationSessionId,
            messageIds,
            partIds,
        );
    });
    db.prepare(`UPDATE session_meta SET ${assignments} WHERE session_id = ?`).run(
        ...values,
        destinationSessionId,
    );
}

function copyContextAdditionalTables(
    db: Database,
    sourceSessionId: string,
    destinationSessionId: string,
    messageIds: IdMap,
    partIds: IdMap,
): CloneTableCount[] {
    const counts: CloneTableCount[] = [];
    for (const table of MAGIC_CONTEXT_ADDITIONAL_TABLES) {
        if (!tableExists(db, table) || !hasColumn(db, table, "session_id")) continue;
        const sourceRows = rowsForValue(db, table, "session_id", sourceSessionId);
        if (sourceRows.length === 0) continue;
        const tableColumns = columns(db, table);
        const idColumn = tableColumns.find((column) => column.name === "id");
        for (const sourceRow of sourceRows) {
            const row = { ...sourceRow };
            row.session_id = destinationSessionId;
            for (const column of tableColumns) {
                row[column.name] = rewriteContextValue(
                    column.name,
                    row[column.name],
                    sourceSessionId,
                    destinationSessionId,
                    messageIds,
                    partIds,
                );
            }
            if (idColumn && /INT/i.test(idColumn.type)) {
                delete row.id;
            } else if (idColumn && typeof row.id === "string") {
                row.id = `${table}_${randomToken()}`;
            }
            insertRow(db, table, row, (_column, value) => value);
        }
        counts.push({ table, rows: sourceRows.length });
    }
    return counts;
}

function sourceUsesGlobalTagIds(db: Database, sourceSessionId: string): boolean {
    if (!tableExists(db, "source_contents")) return true;
    const byTagId = db
        .prepare(
            `SELECT COUNT(*) AS count
               FROM source_contents sc
               JOIN tags t ON t.session_id = sc.session_id AND t.id = sc.tag_id
              WHERE sc.session_id = ?`,
        )
        .get(sourceSessionId) as { count?: number };
    const byTagNumber = db
        .prepare(
            `SELECT COUNT(*) AS count
               FROM source_contents sc
               JOIN tags t ON t.session_id = sc.session_id AND t.tag_number = sc.tag_id
              WHERE sc.session_id = ?`,
        )
        .get(sourceSessionId) as { count?: number };
    return (byTagId.count ?? 0) >= (byTagNumber.count ?? 0);
}

function copyMagicContext(
    db: Database,
    sourceSessionId: string,
    destinationSessionId: string,
    messageIds: IdMap,
    partIds: IdMap,
    messageOrdinals: ReadonlyMap<string, number>,
): CloneTableCount[] {
    const filter: CloneSessionStateFilter = {
        resolveBoundaryOrdinal: (messageId) => messageOrdinals.get(messageId),
        includeMessageId: (messageId) => messageIds.has(messageId),
        mapMessageId: contextMessageMapper(sourceSessionId, destinationSessionId, messageIds, partIds),
        includeTag: (tag) => {
            if (tag.type === "tool") return tag.toolOwnerMessageId !== null && messageIds.has(tag.toolOwnerMessageId);
            const rawId = tag.messageId.replace(CONTENT_ID_SUFFIX, "");
            return messageIds.has(rawId);
        },
        selectPendingPiMarker: (rawState, copiedCompartments) => {
            if (!rawState) return null;
            try {
                const parsed = JSON.parse(rawState) as { endMessageId?: unknown };
                const mappedEndMessageId =
                    typeof parsed.endMessageId === "string"
                        ? contextMessageMapper(sourceSessionId, destinationSessionId, messageIds, partIds)(
                              parsed.endMessageId,
                          )
                        : null;
                if (
                    mappedEndMessageId === null ||
                    !copiedCompartments.some(
                        (compartment) => compartment.endMessageId === mappedEndMessageId,
                    )
                ) {
                    return null;
                }
                return JSON.stringify(
                    rewriteJsonValue(
                        parsed,
                        sourceSessionId,
                        destinationSessionId,
                        messageIds,
                        partIds,
                        new Map(),
                    ),
                );
            } catch {
                return null;
            }
        },
    };
    if (sourceUsesGlobalTagIds(db, sourceSessionId)) {
        filter.mapTagId = (_sourceTagId, destinationTagId) => destinationTagId;
    }

    const result = copySessionStateForClone(db, sourceSessionId, destinationSessionId, filter);
    if (result.kind === "destination-not-empty") {
        throw new Error(`Magic Context destination ${destinationSessionId} is not empty`);
    }
    const counts: CloneTableCount[] = [
        { table: "compartments", rows: result.compartmentsCopied },
        { table: "tags", rows: result.tagsCopied },
        { table: "pending_ops", rows: result.pendingOpsCopied },
    ].filter((entry) => entry.rows > 0);
    if (tableExists(db, "source_contents")) {
        const count = countRows(db, "source_contents", "session_id", destinationSessionId);
        if (count > 0) counts.push({ table: "source_contents", rows: count });
    }
    if (tableExists(db, "session_meta") && countRows(db, "session_meta", "session_id", sourceSessionId) > 0) {
        counts.push({ table: "session_meta", rows: 1 });
    }

    runImmediate(db, () => {
        copyContextMeta(db, sourceSessionId, destinationSessionId, messageIds, partIds);
        counts.push(...copyContextAdditionalTables(db, sourceSessionId, destinationSessionId, messageIds, partIds));
    });
    return counts;
}

function buildPlan(
    opencodeDb: Database,
    contextDb: Database,
    sourceSessionId: string,
    destinationSessionId: string,
    suffix?: string,
): ClonePlan {
    const sourceSession = opencodeDb
        .prepare("SELECT title, directory, project_id FROM session WHERE id = ?")
        .get(sourceSessionId) as { title?: string; directory?: string; project_id?: string } | undefined;
    if (!sourceSession) throw new Error(`OpenCode session not found: ${sourceSessionId}`);
    const terminalSelection = selectTerminalMessages(opencodeDb, sourceSessionId);
    const sessionTables = sessionScopedTables(opencodeDb);
    const opencode: CloneTableCount[] = [{ table: "session", rows: 1 }];
    for (const entry of countTableRows(opencodeDb, sessionTables, sourceSessionId, "session_id")) {
        if (entry.table === "message" || entry.table === "part") continue;
        opencode.push(entry);
    }
    if (terminalSelection.retainedMessageIds.length > 0) {
        opencode.push({ table: "message", rows: terminalSelection.retainedMessageIds.length });
    }
    const retainedPartCount = partRowsForMessages(
        opencodeDb,
        sourceSessionId,
        terminalSelection.retainedMessageIds,
    ).length;
    if (retainedPartCount > 0) opencode.push({ table: "part", rows: retainedPartCount });
    if (tableExists(opencodeDb, "event_sequence")) {
        const count = countRows(opencodeDb, "event_sequence", "aggregate_id", sourceSessionId);
        if (count > 0) opencode.push({ table: "event_sequence", rows: count });
    }
    if (tableExists(opencodeDb, "event")) {
        const count = eventRowsForClone(
            opencodeDb,
            sourceSessionId,
            sourceUnmappedReferenceIds(opencodeDb, sourceSessionId, terminalSelection.retainedMessageIds),
        ).length;
        if (count > 0) opencode.push({ table: "event", rows: count });
    }

    const contextTables = sessionScopedTables(contextDb);
    const copiedContext = new Set(
        ["compartments", "tags", "source_contents", "pending_ops", "session_meta", ...MAGIC_CONTEXT_ADDITIONAL_TABLES].filter(
            (table) => tableExists(contextDb, table) && hasColumn(contextDb, table, "session_id"),
        ),
    );
    const magicContext = countTableRows(contextDb, [...copiedContext], sourceSessionId, "session_id");
    const skippedMagicContext = contextTables
        .filter((table) => !copiedContext.has(table))
        .map((table) => ({ table, rows: countRows(contextDb, table, "session_id", sourceSessionId) }))
        .filter((entry) => entry.rows > 0);
    if (tableExists(contextDb, "session_meta") && !magicContext.some((entry) => entry.table === "session_meta")) {
        const count = countRows(contextDb, "session_meta", "session_id", sourceSessionId);
        if (count > 0) magicContext.push({ table: "session_meta", rows: count });
    }
    return {
        sourceSessionId,
        destinationSessionId,
        title: `${sourceSession.title ?? ""} (rust-drive clone${suffix ? `: ${suffix}` : ""})`,
        directory: sourceSession.directory ?? "",
        projectId: sourceSession.project_id ?? "",
        retainedMessageIds: terminalSelection.retainedMessageIds,
        trimmedMessageIds: terminalSelection.trimmedMessageIds,
        opencode,
        magicContext: magicContext.filter((entry) => entry.rows > 0),
        skippedMagicContext,
        messageIdPolicy: "remint-native-time-ordered",
    };
}

function openDatabase(path: string, readonly: boolean): Database {
    if (!existsSync(path)) throw new Error(`database not found: ${path}`);
    const db = new Database(path, readonly ? { readonly: true } : undefined);
    setBusyTimeout(db);
    return db;
}

function closeDatabases(...databases: Array<Database | null>): void {
    for (const db of databases) {
        if (db) closeQuietly(db);
    }
}

function printPlan(plan: ClonePlan, dryRun: boolean): void {
    console.log(`source session: ${plan.sourceSessionId}`);
    console.log(`new session id: ${plan.destinationSessionId}`);
    console.log(`directory: ${plan.directory}`);
    console.log(`project id: ${plan.projectId}`);
    console.log(`message ids: reminted because message.id is a global PRIMARY KEY (part ids are reminted too)`);
    console.log("OpenCode rows:");
    for (const entry of plan.opencode) console.log(`  ${entry.table}: ${entry.rows}`);
    console.log("Magic Context rows:");
    for (const entry of plan.magicContext) console.log(`  ${entry.table}: ${entry.rows}`);
    if (plan.skippedMagicContext.length > 0) {
        console.log("Magic Context rows deliberately skipped:");
        for (const entry of plan.skippedMagicContext) {
            console.log(
                `  ${entry.table}: ${entry.rows} (${MAGIC_CONTEXT_EXCLUDED_REASONS[entry.table] ?? "not part of the drive seed"})`,
            );
        }
    }
    console.log("Also skipped: channel2 claims, emergency latches, all FTS/message-index rows, and embeddings.");
    console.log("OpenCode share_url/session_share rows are not copied so the clone cannot inherit a share credential.");
    if (dryRun) console.log("dry-run: no database writes performed");
}

function deleteContextDestination(db: Database, sessionId: string): void {
    if (SESSION_SCOPED_TABLES.every(({ table }) => tableExists(db, table))) {
        clearSession(db, sessionId);
    }
    const tables = sessionScopedTables(db).reverse();
    runImmediate(db, () => {
        for (const table of tables) {
            db.prepare(`DELETE FROM ${quoteIdentifier(table)} WHERE session_id = ?`).run(sessionId);
        }
    });
}

function deleteOpenCodeDestination(db: Database, sessionId: string): void {
    const allSessionTables = tableNames(db).filter((table) => hasColumn(db, table, "session_id"));
    runImmediate(db, () => {
        if (tableExists(db, "event")) db.prepare("DELETE FROM event WHERE aggregate_id = ?").run(sessionId);
        if (tableExists(db, "event_sequence")) db.prepare("DELETE FROM event_sequence WHERE aggregate_id = ?").run(sessionId);
        for (const table of allSessionTables.reverse()) {
            db.prepare(`DELETE FROM ${quoteIdentifier(table)} WHERE session_id = ?`).run(sessionId);
        }
        db.prepare("DELETE FROM session WHERE id = ?").run(sessionId);
    });
}

function isCloneMarker(metadata: unknown): boolean {
    const parsed = parseJsonObject(metadata);
    const marker = parsed?.[CLONE_MARKER_KEY];
    return marker !== null && typeof marker === "object" && !Array.isArray(marker) &&
        (marker as Record<string, unknown>).version === 1;
}

export function deleteClonedSession(options: DeleteClonedSessionOptions): DeleteClonedSessionResult {
    if (!options.sessionId) throw new Error("--delete requires a session id");
    const opencodeDbPath = options.opencodeDbPath ?? join(getDataDir(), "opencode", "opencode.db");
    const contextDbPath = options.contextDbPath ?? join(getMagicContextStorageDir(), "context.db");
    let opencode: Database | null = null;
    let context: Database | null = null;
    try {
        opencode = openDatabase(opencodeDbPath, false);
        context = openDatabase(contextDbPath, false);
        const session = opencode
            .prepare("SELECT metadata FROM session WHERE id = ?")
            .get(options.sessionId) as { metadata?: unknown } | undefined;
        if (!session) throw new Error(`OpenCode session not found: ${options.sessionId}`);
        if (!options.force && !isCloneMarker(session.metadata)) {
            throw new Error(
                `refusing to delete ${options.sessionId}: it is not marked as a clone created by this script; use --force to override`,
            );
        }
        const opencodeCounts = countTableRows(
            opencode,
            sessionScopedTables(opencode),
            options.sessionId,
            "session_id",
        );
        const contextCounts = countTableRows(
            context,
            sessionScopedTables(context),
            options.sessionId,
            "session_id",
        );
        deleteContextDestination(context, options.sessionId);
        deleteOpenCodeDestination(opencode, options.sessionId);
        console.log(`deleted clone session: ${options.sessionId}`);
        return { sessionId: options.sessionId, opencode: opencodeCounts, magicContext: contextCounts };
    } finally {
        closeDatabases(opencode, context);
    }
}

export function cloneSession(options: CloneSessionOptions): CloneResult {
    if (!options.sessionId) throw new Error("--session is required");
    const opencodeDbPath = options.opencodeDbPath ?? join(getDataDir(), "opencode", "opencode.db");
    const contextDbPath = options.contextDbPath ?? join(getMagicContextStorageDir(), "context.db");
    let readOpenCode: Database | null = null;
    let readContext: Database | null = null;
    let writeOpenCode: Database | null = null;
    let writeContext: Database | null = null;
    let destinationSessionId = "";
    try {
        readOpenCode = openDatabase(opencodeDbPath, true);
        readContext = openDatabase(contextDbPath, true);
        destinationSessionId = mintDestinationSessionId(readOpenCode, readContext);
        const plan = buildPlan(readOpenCode, readContext, options.sessionId, destinationSessionId, options.suffix);
        if (options.dryRun) {
            printPlan(plan, true);
            return { plan, dryRun: true, opencode: plan.opencode, magicContext: plan.magicContext };
        }
        closeDatabases(readOpenCode, readContext);
        readOpenCode = null;
        readContext = null;

        if (!options.force) {
            console.log("lock probe: acquiring an immediate OpenCode write lock; use --force to bypass the preflight warning");
            const probe = openDatabase(opencodeDbPath, false);
            try {
                runImmediate(probe, () => undefined);
            } finally {
                closeQuietly(probe);
            }
        }
        writeOpenCode = openDatabase(opencodeDbPath, false);
        writeContext = openDatabase(contextDbPath, false);
        const openCodeSnapshotBefore = sourceSnapshot(writeOpenCode, sessionScopedTables(writeOpenCode), options.sessionId);
        const copiedOpenCode = runImmediate(writeOpenCode, () =>
            copyOpenCodeRows(
                writeOpenCode as Database,
                options.sessionId,
                destinationSessionId,
                plan.title,
                plan.retainedMessageIds,
            ),
        );
        const openCodeSnapshotAfter = sourceSnapshot(writeOpenCode, sessionScopedTables(writeOpenCode), options.sessionId);
        assertSnapshotUnchanged("OpenCode", openCodeSnapshotBefore, openCodeSnapshotAfter);

        const contextSessionTables = sessionScopedTables(writeContext);
        const contextSnapshotBefore = sourceSnapshot(writeContext, contextSessionTables, options.sessionId);
        const copiedContext = copyMagicContext(
            writeContext,
            options.sessionId,
            destinationSessionId,
            copiedOpenCode.messageIds,
            copiedOpenCode.partIds,
            copiedOpenCode.messageOrdinals,
        );
        const contextSnapshotAfter = sourceSnapshot(writeContext, contextSessionTables, options.sessionId);
        assertSnapshotUnchanged("Magic Context", contextSnapshotBefore, contextSnapshotAfter);

        const result: CloneResult = {
            plan,
            dryRun: false,
            opencode: copiedOpenCode.counts,
            magicContext: copiedContext,
        };
        printPlan(
            {
                ...plan,
                opencode: copiedOpenCode.counts,
                magicContext: copiedContext,
            },
            false,
        );
        console.log("clone committed");
        return result;
    } catch (error) {
        if (destinationSessionId && writeContext) {
            try {
                deleteContextDestination(writeContext, destinationSessionId);
            } catch {
                // Preserve the original error; cleanup is best-effort for a new id.
            }
        }
        if (destinationSessionId && writeOpenCode) {
            try {
                deleteOpenCodeDestination(writeOpenCode, destinationSessionId);
            } catch {
                // Preserve the original error; cleanup is best-effort for a new id.
            }
        }
        throw error;
    } finally {
        closeDatabases(readOpenCode, readContext, writeOpenCode, writeContext);
    }
}

function parseArgs(argv: readonly string[]): CloneSessionOptions {
    let sessionId = "";
    let deleteSessionId: string | undefined;
    let suffix: string | undefined;
    let dryRun = false;
    let force = false;
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--session") {
            sessionId = argv[++index] ?? "";
        } else if (arg === "--delete") {
            deleteSessionId = argv[++index] ?? "";
        } else if (arg === "--suffix") {
            suffix = argv[++index];
        } else if (arg === "--dry-run") {
            dryRun = true;
        } else if (arg === "--force") {
            force = true;
        } else if (arg === "--help" || arg === "-h") {
            console.log("Usage: bun packages/plugin/scripts/clone-session.ts --session <ses_id> [--suffix <label>] [--dry-run] [--force]");
            console.log("       bun packages/plugin/scripts/clone-session.ts --delete <ses_id> [--force]");
            process.exit(0);
        } else {
            throw new Error(`unknown argument: ${arg}`);
        }
    }
    if (deleteSessionId && sessionId) throw new Error("--delete cannot be combined with --session");
    return { sessionId, deleteSessionId, suffix, dryRun, force };
}

if (import.meta.main) {
    try {
        const options = parseArgs(process.argv.slice(2));
        if (options.deleteSessionId) {
            deleteClonedSession({
                sessionId: options.deleteSessionId,
                force: options.force,
                opencodeDbPath: options.opencodeDbPath,
                contextDbPath: options.contextDbPath,
            });
        } else {
            cloneSession(options);
        }
    } catch (error) {
        console.error(`clone-session failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}
