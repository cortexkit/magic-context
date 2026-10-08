import type { Database } from "../../shared/sqlite";
import { logSlowWriteTransaction } from "../../shared/write-transaction-timing";
import { ensureColumn } from "./storage-schema-helpers";

/** Shared by fresh installs and migration replay; served bytes are deliberately not stored. */
export function installHostRunnerSchema(db: Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS host_runner_entries (
            session_id TEXT NOT NULL, harness TEXT NOT NULL, lineage_id TEXT NOT NULL,
            ordinal INTEGER NOT NULL CHECK (ordinal >= 0), message_id TEXT NOT NULL,
            ingest_json TEXT NOT NULL, hook_json TEXT NOT NULL, op_version INTEGER NOT NULL,
            ingested INTEGER NOT NULL CHECK (ingested IN (0, 1)),
            race INTEGER NOT NULL DEFAULT 0 CHECK (race IN (0, 1)), created_at INTEGER NOT NULL,
            PRIMARY KEY (session_id, harness, lineage_id, ordinal),
            UNIQUE (session_id, harness, lineage_id, message_id)
        );
        CREATE TABLE IF NOT EXISTS host_runner_ids (
            session_id TEXT NOT NULL, harness TEXT NOT NULL, lineage_id TEXT NOT NULL,
            message_id TEXT NOT NULL, ordinal INTEGER CHECK (ordinal >= 0),
            PRIMARY KEY (session_id, harness, lineage_id, message_id),
            UNIQUE (session_id, harness, lineage_id, ordinal)
        );
        CREATE TABLE IF NOT EXISTS host_runner_views (
            session_id TEXT NOT NULL, harness TEXT NOT NULL, lineage_id TEXT NOT NULL,
            compaction_id TEXT NOT NULL, version INTEGER NOT NULL,
            range_from INTEGER NOT NULL, range_to INTEGER NOT NULL CHECK (range_to >= range_from),
            replacement_json TEXT NOT NULL, coverage_json TEXT,
            state TEXT NOT NULL CHECK (state IN ('applied', 'invalidated')), applied_at INTEGER NOT NULL,
            PRIMARY KEY (session_id, harness, version)
        );
        CREATE TABLE IF NOT EXISTS host_runner_state (
            session_id TEXT NOT NULL, harness TEXT NOT NULL, lineage_id TEXT NOT NULL,
            ancestry_json TEXT NOT NULL, plan_json TEXT, setup_json TEXT,
            next_ordinal INTEGER NOT NULL, cursor INTEGER NOT NULL,
            served_through_ordinal INTEGER NOT NULL,
            issued_request_id TEXT, issued_newest INTEGER, wait_json TEXT,
            bootstrap_cursor INTEGER, bootstrap_refused_json TEXT, last_not_applied_json TEXT,
            unserved_json TEXT NOT NULL, rebuild_generation_seen INTEGER NOT NULL DEFAULT 0,
            ordinal_divergence INTEGER NOT NULL DEFAULT 0, pipeline_exit_json TEXT,
            record_version INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY (session_id, harness)
        );
    `);
    // A lost migration row must not leave an older partial schema missing these fields.
    ensureColumn(db, "host_runner_entries", "race", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "host_runner_state", "ordinal_divergence", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "host_runner_state", "bootstrap_refused_json", "TEXT");
}

export interface HostRunnerKey {
    session_id: string;
    harness: string;
}

/** JSON strings are the already encoded admission/control bytes, not whole-record snapshots. */
export interface HostRunnerState {
    lineage_id: string;
    ancestry_json: string;
    plan_json: string | null;
    setup_json: string | null;
    next_ordinal: number;
    cursor: number;
    served_through_ordinal: number;
    issued_request_id: string | null;
    issued_newest: number | null;
    wait_json: string | null;
    bootstrap_cursor: number | null;
    bootstrap_refused_json: string | null;
    last_not_applied_json: string | null;
    unserved_json: string;
    rebuild_generation_seen: number;
    ordinal_divergence: number;
    pipeline_exit_json: string | null;
    record_version: number;
}

export function createHostRunnerState(lineageId: string, firstOrdinal = 1): HostRunnerState {
    return {
        lineage_id: lineageId,
        ancestry_json: "[]",
        plan_json: null,
        setup_json: null,
        next_ordinal: firstOrdinal,
        cursor: firstOrdinal - 1,
        served_through_ordinal: firstOrdinal - 1,
        issued_request_id: null,
        issued_newest: null,
        wait_json: null,
        bootstrap_cursor: null,
        bootstrap_refused_json: null,
        last_not_applied_json: null,
        unserved_json: "[]",
        rebuild_generation_seen: 0,
        ordinal_divergence: 0,
        pipeline_exit_json: null,
        record_version: 1,
    };
}

export interface HostRunnerEntry {
    ordinal: number;
    message_id: string;
    ingest_json: string;
    hook_json: string;
    op_version: number;
    ingested: 0 | 1;
    race: 0 | 1;
    created_at: number;
}

export interface HostRunnerView {
    lineage_id: string;
    compaction_id: string;
    version: number;
    range_from: number;
    range_to: number;
    replacement_json: string;
    coverage_json: string | null;
    state: "applied" | "invalidated";
    applied_at: number;
}

export interface HostRunnerRecord {
    state: HostRunnerState;
    entries: HostRunnerEntry[];
    ids: Map<string, number>;
    elided: Set<string>;
    /** Newest first, at most two; only views[0] may be served. */
    views: HostRunnerView[];
}

export class HostRunnerDurabilityError extends Error {
    constructor(site: string, cause: unknown) {
        super(`Magic Context runner record ${site} failed; refuse this turn (no raw fallback)`, {
            cause,
        });
        this.name = "HostRunnerDurabilityError";
    }
}

const STATE_COLUMNS = [
    "lineage_id",
    "ancestry_json",
    "plan_json",
    "setup_json",
    "next_ordinal",
    "cursor",
    "served_through_ordinal",
    "issued_request_id",
    "issued_newest",
    "wait_json",
    "bootstrap_cursor",
    "bootstrap_refused_json",
    "last_not_applied_json",
    "unserved_json",
    "rebuild_generation_seen",
    "ordinal_divergence",
    "pipeline_exit_json",
    "record_version",
] as const;

function readState(db: Database, key: HostRunnerKey): HostRunnerState | null {
    const state = db
        .prepare(`SELECT ${STATE_COLUMNS.join(", ")} FROM host_runner_state
        WHERE session_id = ? AND harness = ?`)
        .get(key.session_id, key.harness) as HostRunnerState | null;
    if (state && state.record_version !== 1)
        throw new Error("Unsupported host runner record version");
    return state ?? null;
}

function writeState(db: Database, key: HostRunnerKey, state: HostRunnerState): void {
    if (state.record_version !== 1) throw new Error("Unsupported host runner record version");
    db.prepare(`INSERT INTO host_runner_state (session_id, harness, ${STATE_COLUMNS.join(", ")})
        VALUES (${["session_id", "harness", ...STATE_COLUMNS].map(() => "?").join(", ")})
        ON CONFLICT (session_id, harness) DO UPDATE SET
        ${STATE_COLUMNS.map((column) => `${column} = excluded.${column}`).join(", ")}`).run(
        key.session_id,
        key.harness,
        ...STATE_COLUMNS.map((column) => state[column]),
    );
}

function requiredState(db: Database, key: HostRunnerKey): HostRunnerState {
    const state = readState(db, key);
    if (!state) throw new Error("Missing host runner record");
    return state;
}

function writeTransaction(db: Database, site: string, write: () => void): void {
    // Do not catch a failed write as unavailability: entries must be durable before serving.
    try {
        db.exec("BEGIN IMMEDIATE");
        const startedAt = performance.now();
        let committed = false;
        try {
            write();
            db.exec("COMMIT");
            committed = true;
            logSlowWriteTransaction(`host_runner_${site}`, startedAt);
        } finally {
            if (!committed) db.exec("ROLLBACK");
        }
    } catch (cause) {
        throw new HostRunnerDurabilityError(site, cause);
    }
}

export interface HostRunnerPass {
    state: HostRunnerState;
    /** Only newly admitted entries. Known content is never read or rewritten on this path. */
    entries?: readonly HostRunnerEntry[];
    elided?: readonly string[];
    /** A descent is a cold path: retain the prefix under the new lineage and delete the suffix. */
    truncate_after?: number;
    /** History-gap recovery resends this retained tail from ingest, without re-hooking it. */
    uningested_from?: number;
    /** Exact retired exit observed by an explicit switch; safety exits cannot be replaced. */
    replace_retired_rollback?: string;
}

/** Ordinary pass: exactly one transaction for appended entries, ids and the small state row. */
export function commitHostRunnerPass(db: Database, key: HostRunnerKey, pass: HostRunnerPass): void {
    writeTransaction(db, "pass", () => {
        if (pass.replace_retired_rollback !== undefined) {
            const retired = requiredState(db, key);
            if (
                retired.pipeline_exit_json !== pass.replace_retired_rollback ||
                JSON.parse(pass.replace_retired_rollback).reason !== "rollback"
            ) {
                throw new Error("Only the observed deliberate rollback can be replaced");
            }
            for (const table of [
                "host_runner_entries",
                "host_runner_ids",
                "host_runner_views",
                "host_runner_state",
            ]) {
                db.prepare(`DELETE FROM ${table} WHERE session_id=? AND harness=?`).run(
                    key.session_id,
                    key.harness,
                );
            }
        }
        const previous = readState(db, key);
        const state = pass.state;
        if (
            state.issued_request_id !== (previous?.issued_request_id ?? null) ||
            state.issued_newest !== (previous?.issued_newest ?? null) ||
            state.pipeline_exit_json !== (previous?.pipeline_exit_json ?? null)
        ) {
            throw new Error("Fences and pipeline exits require their own commit boundary");
        }
        if (previous?.pipeline_exit_json) throw new Error("Exited runner record cannot be served");
        if (pass.truncate_after !== undefined) {
            if (!previous || previous.lineage_id === state.lineage_id) {
                throw new Error("Truncation requires a descended lineage");
            }
            const through = pass.truncate_after;
            if (state.served_through_ordinal > through || through >= previous.next_ordinal) {
                throw new Error("Descent must clamp the served frontier to its retained prefix");
            }
            for (const table of ["host_runner_entries", "host_runner_ids"]) {
                db.prepare(
                    `DELETE FROM ${table} WHERE session_id = ? AND harness = ? AND ordinal > ?`,
                ).run(key.session_id, key.harness, through);
                db.prepare(
                    `UPDATE ${table} SET lineage_id = ? WHERE session_id = ? AND harness = ?`,
                ).run(state.lineage_id, key.session_id, key.harness);
            }
            db.prepare(`UPDATE host_runner_views SET state = 'invalidated'
                WHERE session_id = ? AND harness = ? AND range_to > ?`).run(
                key.session_id,
                key.harness,
                through + 1,
            );
        } else if (previous && previous.lineage_id !== state.lineage_id) {
            throw new Error("Lineage change requires an explicit descent");
        }
        const insertEntry = db.prepare(`INSERT INTO host_runner_entries
            (session_id, harness, lineage_id, ordinal, message_id, ingest_json, hook_json,
             op_version, ingested, race, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const insertId = db.prepare(`INSERT INTO host_runner_ids
            (session_id, harness, lineage_id, message_id, ordinal) VALUES (?, ?, ?, ?, ?)`);
        let next =
            pass.truncate_after === undefined
                ? (previous?.next_ordinal ?? state.next_ordinal - (pass.entries?.length ?? 0))
                : pass.truncate_after + 1;
        for (const entry of pass.entries ?? []) {
            if (entry.ordinal !== next++) throw new Error("Appended ordinals must be contiguous");
            insertEntry.run(
                key.session_id,
                key.harness,
                state.lineage_id,
                entry.ordinal,
                entry.message_id,
                entry.ingest_json,
                entry.hook_json,
                entry.op_version,
                entry.ingested,
                entry.race,
                entry.created_at,
            );
            insertId.run(
                key.session_id,
                key.harness,
                state.lineage_id,
                entry.message_id,
                entry.ordinal,
            );
        }
        if (next !== state.next_ordinal)
            throw new Error("Append frontier does not match committed state");
        for (const id of pass.elided ?? []) {
            insertId.run(key.session_id, key.harness, state.lineage_id, id, null);
        }
        if (pass.uningested_from !== undefined) {
            db.prepare(`UPDATE host_runner_entries SET ingested = 0
                WHERE session_id = ? AND harness = ? AND ordinal >= ?`).run(
                key.session_id,
                key.harness,
                pass.uningested_from,
            );
        }
        writeState(db, key, state);
    });
}

/** Commit before sending a step, including each bootstrap page. No entries or view change here. */
export function commitHostRunnerFence(
    db: Database,
    key: HostRunnerKey,
    requestId: string,
    newest: number,
): void {
    writeTransaction(db, "fence", () => {
        const state = requiredState(db, key);
        if (state.pipeline_exit_json || !requestId || requestId === state.issued_request_id) {
            throw new Error("A step requires a fresh request id on an active record");
        }
        if (newest !== state.next_ordinal - 1)
            throw new Error("Fence newest must be durably admitted");
        db.prepare(`UPDATE host_runner_state SET issued_request_id = ?, issued_newest = ?
            WHERE session_id = ? AND harness = ?`).run(
            requestId,
            newest,
            key.session_id,
            key.harness,
        );
    });
}

export interface HostRunnerAnswer {
    request_id: string;
    issued_newest: number;
    state: HostRunnerState;
    /** Status pages acknowledged by this answer may mark a retained frozen-raw tail ingested. */
    ingested_through?: number;
    /** Omit on noop/wait/refusal; bootstrap progress is stored in state.bootstrap_cursor. */
    view?: HostRunnerView;
    /** Accepted HARD m0 materialization only, committed with the view, never on SOFT. */
    hard_materialized_at?: number;
}

/** The caller validates provider structure; storage also rejects answers to an uncommitted fence. */
export function commitHostRunnerAnswer(
    db: Database,
    key: HostRunnerKey,
    answer: HostRunnerAnswer,
): void {
    writeTransaction(db, "answer", () => {
        const held = requiredState(db, key);
        const state = answer.state;
        if (
            held.pipeline_exit_json ||
            held.issued_request_id !== answer.request_id ||
            held.issued_newest !== answer.issued_newest ||
            state.lineage_id !== held.lineage_id ||
            state.issued_request_id !== held.issued_request_id ||
            state.issued_newest !== held.issued_newest ||
            state.next_ordinal !== held.next_ordinal ||
            state.pipeline_exit_json !== held.pipeline_exit_json
        ) {
            throw new Error("Answer does not match the committed fence and lineage");
        }
        const view = answer.view;
        if (answer.ingested_through !== undefined) {
            if (answer.ingested_through > answer.issued_newest) {
                throw new Error("Acknowledged status is outside the committed fence");
            }
            db.prepare(`UPDATE host_runner_entries SET ingested = 1
                WHERE session_id = ? AND harness = ? AND ordinal <= ? AND ingested = 0`).run(
                key.session_id,
                key.harness,
                answer.ingested_through,
            );
        }
        if (view) {
            const latest = db
                .prepare(`SELECT MAX(version) AS version FROM host_runner_views
                WHERE session_id = ? AND harness = ?`)
                .get(key.session_id, key.harness) as { version: number | null };
            if (
                view.lineage_id !== held.lineage_id ||
                view.state !== "applied" ||
                view.range_to > answer.issued_newest + 1 ||
                (latest.version !== null && view.version <= latest.version)
            ) {
                throw new Error("View is outside the committed fence or version high-water");
            }
            db.prepare(`INSERT INTO host_runner_views (session_id, harness, lineage_id,
                compaction_id, version, range_from, range_to, replacement_json, coverage_json, state, applied_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
                key.session_id,
                key.harness,
                view.lineage_id,
                view.compaction_id,
                view.version,
                view.range_from,
                view.range_to,
                view.replacement_json,
                view.coverage_json,
                view.state,
                view.applied_at,
            );
            db.prepare(
                `DELETE FROM host_runner_entries WHERE session_id = ? AND harness = ? AND ordinal < ?`,
            ).run(key.session_id, key.harness, view.range_to);
            // IDs outlive pruned entries so a fully compacted session can still detect a revert.
            db.prepare(`DELETE FROM host_runner_views WHERE session_id = ? AND harness = ? AND version NOT IN
                (SELECT version FROM host_runner_views WHERE session_id = ? AND harness = ? ORDER BY version DESC LIMIT 2)`).run(
                key.session_id,
                key.harness,
                key.session_id,
                key.harness,
            );
        }
        if (answer.hard_materialized_at !== undefined) {
            if (
                !view ||
                !Number.isSafeInteger(answer.hard_materialized_at) ||
                answer.hard_materialized_at < 0
            ) {
                throw new Error("A HARD materialization clock requires an accepted view");
            }
            const updated = db
                .prepare("UPDATE session_meta SET cached_m0_materialized_at=? WHERE session_id=?")
                .run(answer.hard_materialized_at, key.session_id);
            if (updated.changes !== 1) throw new Error("HARD materialization session is missing");
        }
        writeState(db, key, state);
    });
}

/** Must return successfully before the caller serves an exit pass through full_request. */
export function commitHostRunnerExit(db: Database, key: HostRunnerKey, exitJson: string): void {
    writeTransaction(db, "exit", () => {
        const state = requiredState(db, key);
        if (state.pipeline_exit_json !== null && state.pipeline_exit_json !== exitJson) {
            throw new Error("Pipeline exit is already recorded");
        }
        db.prepare(
            `UPDATE host_runner_state SET pipeline_exit_json = ? WHERE session_id = ? AND harness = ?`,
        ).run(exitJson, key.session_id, key.harness);
    });
}

/** Cold-path coherent snapshot. An absent record is distinct from an unreadable one (which throws). */
export function loadHostRunnerRecord(db: Database, key: HostRunnerKey): HostRunnerRecord | null {
    return db
        .transaction(() => {
            const state = readState(db, key);
            if (!state) return null;
            const entries = db
                .prepare(`SELECT ordinal, message_id, ingest_json, hook_json, op_version,
            ingested, race, created_at FROM host_runner_entries WHERE session_id = ? AND harness = ?
            AND lineage_id = ? ORDER BY ordinal`)
                .all(key.session_id, key.harness, state.lineage_id) as HostRunnerEntry[];
            const rows = db
                .prepare(`SELECT message_id, ordinal FROM host_runner_ids
            WHERE session_id = ? AND harness = ? AND lineage_id = ?`)
                .all(key.session_id, key.harness, state.lineage_id) as {
                message_id: string;
                ordinal: number | null;
            }[];
            const ids = new Map<string, number>();
            const elided = new Set<string>();
            for (const row of rows) {
                if (row.ordinal === null) elided.add(row.message_id);
                else ids.set(row.message_id, row.ordinal);
            }
            const views = db
                .prepare(`SELECT lineage_id, compaction_id, version, range_from, range_to,
            replacement_json, coverage_json, state, applied_at FROM host_runner_views
            WHERE session_id = ? AND harness = ? ORDER BY version DESC LIMIT 2`)
                .all(key.session_id, key.harness) as HostRunnerView[];
            return { state, entries, ids, elided, views };
        })
        .deferred();
}

/** The adapter supplies its kept, versioned pure op functions; storage never uses the current ops implicitly. */
export function hydrateHostRunnerRecord<T>(
    db: Database,
    key: HostRunnerKey,
    render: (entry: HostRunnerEntry) => T,
): (Omit<HostRunnerRecord, "entries"> & { entries: (HostRunnerEntry & { served: T })[] }) | null {
    const record = loadHostRunnerRecord(db, key);
    if (!record) return null;
    return {
        ...record,
        entries: record.entries.map((entry) => ({ ...entry, served: render(entry) })),
    };
}
