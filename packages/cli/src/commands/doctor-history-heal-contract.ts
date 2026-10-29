import type { Database } from "@magic-context/core/shared/sqlite";
import {
    canonical,
    type HealSession,
    quote,
    type Rewrite,
    type Row,
} from "./doctor-history-heal-plan";

const CONTEXT_KEYS: Record<string, string[]> = {
    compartments: ["id"],
    notes: ["id"],
    compartment_chunk_embeddings: ["id"],
    primer_candidates: ["id"],
    compression_depth: ["session_id", "message_ordinal"],
    message_history_source: ["session_id", "message_id"],
    message_history_fts: ["rowid"],
    message_fts_rowid_map: ["session_id", "fts_rowid"],
    message_history_index: ["session_id"],
    message_time_backfill_state: ["id"],
};
const UPDATE_COLUMNS: Record<string, string[]> = {
    compartments: [
        "start_message",
        "end_message",
        "start_message_id",
        "end_message_id",
        "start_block_index",
        "end_block_index",
    ],
    notes: ["anchor_ordinal"],
    compartment_chunk_embeddings: ["start_ordinal", "end_ordinal"],
    primer_candidates: ["source_compartment_start", "source_compartment_end"],
    message_history_source: ["message_ordinal"],
    message_history_fts: ["message_ordinal"],
    message_fts_rowid_map: ["session_id", "message_ordinal", "fts_rowid", "message_time_ms"],
    message_history_index: ["last_indexed_ordinal", "dirty_floor_ordinal"],
    message_time_backfill_state: ["cursor_ordinal"],
};
const DELETABLE = new Set([
    "compression_depth",
    "compartment_chunk_embeddings",
    "message_fts_rowid_map",
]);
const MESSAGE_COLUMNS = ["id", "session_id", "time_created", "time_updated", "data"];
const PART_COLUMNS = [...MESSAGE_COLUMNS, "message_id"];

function refuse(code: string, message: string): never {
    throw new Error(`${code}: ${message}`);
}
function record(value: unknown): value is Row {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function sameKeys(value: Row, keys: string[]): boolean {
    return canonical(Object.keys(value).sort()) === canonical([...keys].sort());
}
function matches(actual: Row, expected: Row): boolean {
    return (
        canonical(Object.fromEntries(Object.keys(expected).map((k) => [k, actual[k]]))) ===
        canonical(expected)
    );
}
function lookup(db: Database, r: Rewrite): Row | undefined {
    return db
        .prepare(
            `SELECT * FROM ${quote(r.table)} WHERE ${Object.keys(r.key)
                .map((k) => `${quote(k)} IS ?`)
                .join(" AND ")}`,
        )
        .get(...Object.values(r.key)) as Row | undefined;
}
function info(row: Row): Row {
    if (typeof row.data !== "string") refuse("rewrite_contract", "Host row data must be JSON text");
    try {
        const value: unknown = JSON.parse(row.data);
        if (record(value)) return value;
    } catch {
        /* Rejected below. */
    }
    return refuse("rewrite_contract", "Host row data must be a JSON object");
}
function ownedSummary(row: Row): boolean {
    const data = info(row);
    return (
        data.role === "assistant" &&
        (data.summary === true || data.summary === 1) &&
        data.finish === "stop" &&
        data.modelID === "magic-context" &&
        data.providerID === "magic-context"
    );
}
function validateHostRow(row: Row, table: string, sessionId: string): void {
    if (
        !sameKeys(row, table === "message" ? MESSAGE_COLUMNS : PART_COLUMNS) ||
        typeof row.id !== "string" ||
        row.session_id !== sessionId ||
        !Number.isSafeInteger(row.time_created) ||
        !Number.isSafeInteger(row.time_updated)
    )
        refuse("rewrite_contract", "Host rewrite is not a complete session-owned marker row");
    if (table === "message" && !ownedSummary(row))
        refuse("rewrite_contract", "Only Magic Context summary messages may be changed");
    if (table === "part") {
        const data = info(row);
        if (
            typeof row.message_id !== "string" ||
            !["compaction", "text", "step-start", "step-finish"].includes(data.type)
        )
            refuse("rewrite_contract", "Only marker parts may be changed");
        if (data.type === "compaction" && (data.auto !== true || !sameKeys(data, ["type", "auto"])))
            refuse(
                "rewrite_contract",
                "Only canonical Magic Context compaction parts may be changed",
            );
    }
}

/** Check the SQL surface and ownership independently of the editable plan's fingerprints. */
export function assertHealWriteContract(
    context: Database,
    host: Database,
    session: HealSession,
    done: { context: boolean; host: boolean },
): void {
    if (!Array.isArray(session.rewrites)) refuse("rewrite_contract", "Missing rewrite list");
    if (
        session.rewrites.some(
            (r) =>
                !record(r) ||
                typeof r.table !== "string" ||
                typeof r.reason !== "string" ||
                !record(r.key) ||
                (!record(r.before) && r.before !== null) ||
                (!record(r.after) && r.after !== null),
        )
    )
        refuse("rewrite_contract", "Invalid rewrite entry");
    const hostChanges = session.rewrites.filter((r) => r.store === "host");
    const summaries = new Map<string, Row>();
    for (const r of hostChanges) {
        if (
            !["message", "part"].includes(r.table) ||
            !record(r.key) ||
            !sameKeys(r.key, ["id"]) ||
            typeof r.key.id !== "string"
        )
            refuse("rewrite_contract", "Unknown host table or key");
        if ((r.before === null) === (r.after === null))
            refuse("rewrite_contract", "Host rewrites must be marker insertions or deletions");
        const row = r.after ?? r.before;
        if (!record(row)) refuse("rewrite_contract", "Missing host row image");
        validateHostRow(row, r.table, session.id);
        if (row.id !== r.key.id) refuse("rewrite_contract", "Host key differs from its row image");
        if (r.table === "message") summaries.set(row.id, row);
    }
    const finalHostRows = new Map<string, { rewrite: Rewrite; image: Row | null }>();
    for (const r of hostChanges.filter((r) => r.after === null))
        finalHostRows.set(`${r.table}:${r.key.id}`, { rewrite: r, image: null });
    for (const r of hostChanges.filter((r) => r.after !== null))
        finalHostRows.set(`${r.table}:${r.key.id}`, { rewrite: r, image: r.after });
    for (const r of session.rewrites) {
        if (r.store !== "context" && r.store !== "host")
            refuse("rewrite_contract", "Unknown rewrite store");
        if (
            !record(r.key) ||
            (!record(r.before) && r.before !== null) ||
            (!record(r.after) && r.after !== null)
        )
            refuse("rewrite_contract", "Invalid row image or key");
        if (r.store === "context") {
            if (!Object.hasOwn(CONTEXT_KEYS, r.table))
                refuse("rewrite_contract", "Unknown context table");
            const keys = CONTEXT_KEYS[r.table];
            if (!keys || !sameKeys(r.key, keys))
                refuse("rewrite_contract", "Unknown context table or key");
            if (r.before === null)
                refuse("rewrite_contract", "Context row insertion is not permitted");
            for (const [key, value] of Object.entries(r.key)) {
                if (key === "session_id" || key === "message_id") {
                    if (typeof value !== "string" || !value)
                        refuse("rewrite_contract", "Invalid text key");
                } else if (!Number.isSafeInteger(value) || value < 0) {
                    refuse("rewrite_contract", "Invalid integer key");
                }
            }
            const owner =
                r.table === "message_time_backfill_state" ? "cursor_session_id" : "session_id";
            if (
                ("session_id" in r.key && r.key.session_id !== session.id) ||
                (owner in r.before && r.before[owner] !== session.id)
            )
                refuse("rewrite_scope", `Rewrite leaves session ${session.id}`);
            const actual = lookup(context, r);
            if (actual && actual[owner] !== session.id)
                refuse("rewrite_scope", `Row belongs to another session, not ${session.id}`);
            if (r.after === null) {
                if (!DELETABLE.has(r.table) || r.before[owner] !== session.id)
                    refuse("rewrite_contract", "Context deletion is not permitted");
                const columns = (
                    context.prepare(`PRAGMA table_info(${quote(r.table)})`).all() as {
                        name: string;
                    }[]
                ).map((c) => c.name);
                if (Object.keys(r.before).some((k) => !columns.includes(k)))
                    refuse("rewrite_contract", "Unknown deleted-row column");
            } else {
                const columns = UPDATE_COLUMNS[r.table];
                if (
                    !columns ||
                    !Object.keys(r.after).length ||
                    Object.keys(r.after).some((k) => !columns.includes(k)) ||
                    !sameKeys(r.before, Object.keys(r.after))
                )
                    refuse("rewrite_contract", "Unknown update column or mismatched patch");
                if (
                    r.table === "message_fts_rowid_map" &&
                    (r.after.session_id !== session.id ||
                        r.after.fts_rowid !== r.key.fts_rowid ||
                        r.after.message_time_ms !== r.before.message_time_ms)
                )
                    refuse("rewrite_scope", "FTS map identity must not change");
                for (const [key, value] of Object.entries(r.after)) {
                    if (key === "session_id" || key === "message_time_ms") continue;
                    if (key.endsWith("_message_id")) {
                        if (typeof value !== "string" || !value)
                            refuse("rewrite_contract", "Missing endpoint identity");
                    } else if (key.endsWith("_block_index")) {
                        if (value !== null)
                            refuse("rewrite_contract", "Block indexes may only be cleared");
                    } else if (
                        !(value === null && key === "anchor_ordinal") &&
                        (!Number.isSafeInteger(value) || value < 0)
                    )
                        refuse("rewrite_contract", "Ordinal updates must be nonnegative integers");
                }
            }
            const expected = done.context ? r.after : r.before;
            if (expected === null ? Boolean(actual) : !actual || !matches(actual, expected))
                refuse(
                    "rewrite_contract",
                    "Context row does not match the declared transaction state",
                );
        } else {
            const actual = lookup(host, r);
            if (actual && actual.session_id !== session.id)
                refuse("rewrite_scope", `Host row belongs to another session, not ${session.id}`);
            if (!done.host && r.before !== null && (!actual || !matches(actual, r.before)))
                refuse("rewrite_contract", "Host before-image differs from the actual row");
            const row = r.after ?? r.before;
            if (!row) refuse("rewrite_contract", "Missing host row image");
            if (r.table === "part") {
                const data = info(row);
                const parent = host
                    .prepare("SELECT * FROM message WHERE id=? AND session_id=?")
                    .get(row.message_id, session.id) as Row | undefined;
                if (data.type === "compaction") {
                    if (!parent || info(parent).role !== "user")
                        refuse("rewrite_scope", "Compaction carrier is not a user in this session");
                } else if (!(summaries.has(row.message_id) || (parent && ownedSummary(parent))))
                    refuse(
                        "rewrite_scope",
                        "Summary part does not belong to a verified Magic Context summary",
                    );
            }
        }
    }
    if (done.host)
        for (const { rewrite, image } of finalHostRows.values()) {
            const actual = lookup(host, rewrite);
            if (image === null ? Boolean(actual) : !actual || !matches(actual, image))
                refuse(
                    "rewrite_contract",
                    "Committed host rows do not match the recorded after-images",
                );
        }
}
